'use strict';

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const dbUtil = require('../lib/db-util');

const INVITE_TTL_MS = 24 * 60 * 60 * 1000; // 邀请码 24 小时有效
const BIND_FAIL_LIMIT = 5; // 连续失败 5 次触发限流
const BIND_FAIL_WINDOW_MS = 60 * 60 * 1000; // 限流窗口 1 小时

const msOf = time.toMillis;

function iso(value) {
  const ms = msOf(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function publicProfile(user) {
  return {
    nickname: (user && user.nickname) || '',
    avatarFileID: (user && user.avatarFileID) || '',
  };
}

/** 6 位数字码；用 crypto 保证均匀分布，保留前导 0 */
function newInviteCode() {
  return String(crypto.randomBytes(4).readUInt32BE(0) % 1000000).padStart(6, '0');
}

async function getUserDoc(db, openid) {
  if (!openid) return null;
  // 仅用于展示（返回对方昵称/头像）：读故障降级成 null，不阻断主流程。
  // 需要据此做业务判断的地方必须用 getUserDocStrict。
  const res = await db.collection('users').doc(openid).get().catch(() => null);
  return (res && res.data) || null;
}

async function getUserDocStrict(db, openid) {
  if (!openid) return null;
  // 业务判断用：只有文档确实不存在才当 null，读故障继续抛，
  // 否则申请时会把「读被邀请人资料失败」误判成邀请码已用过并记一次失败。
  try {
    const res = await db.collection('users').doc(openid).get();
    return (res && res.data) || null;
  } catch (err) {
    if (!dbUtil.isDocumentMissing(err)) throw err;
    return null;
  }
}

async function getInviteDocStrict(db, code) {
  // 业务判断用：邀请文档读故障不能当成「码不存在」，否则会被误报成
  // INVITE_NOT_FOUND 并累计一次绑定失败。
  try {
    const res = await db.collection('bind_invites').doc(code).get();
    return (res && res.data) || null;
  } catch (err) {
    if (!dbUtil.isDocumentMissing(err)) throw err;
    return null;
  }
}

async function getCoupleDoc(db, coupleId) {
  if (!coupleId) return null;
  // 只有文档确实不存在才当 null（触发状态自愈）；读故障继续抛，
  // 否则瞬时报错会被当成「关系不存在」并清掉 user.coupleId。
  try {
    const res = await db.collection('couples').doc(coupleId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (!dbUtil.isDocumentMissing(err)) throw err;
    return null;
  }
}

function inviteIdOf(invite) {
  return invite._id || invite.code;
}

async function expireInvite(db, invite, now) {
  // 只有进行中的邀请才需要惰性过期；cancelled / confirmed 不能被覆写
  if (invite.status !== 'open' && invite.status !== 'applied') return;
  await db.collection('bind_invites').doc(inviteIdOf(invite)).update({
    data: { status: 'expired', updatedAt: now },
  }).catch(() => {});
}

/** 我是 creator 的活跃邀请（同一用户同时最多一个） */
async function findCreatorInvite(ctx) {
  const res = await ctx.db.collection('bind_invites')
    .where({ creatorOpenid: ctx.openid, status: ctx.db.command.in(['open', 'applied']) })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

/** 我是 applicant 的进行中申请 */
async function findApplicantInvite(ctx) {
  const res = await ctx.db.collection('bind_invites')
    .where({ applicantOpenid: ctx.openid, status: 'applied' })
    .limit(1)
    .get();
  return (res.data && res.data[0]) || null;
}

function windowActive(user, now) {
  const resetAt = msOf(user.bindFailResetAt);
  return Number.isFinite(resetAt) && now.getTime() - resetAt < BIND_FAIL_WINDOW_MS;
}

/**
 * 读最新失败计数：ctx.user 是请求开始时的快照，并发/连续请求会读到旧值，
 * 直接拿它做限流判断会被绕过（文档 6.9 / 11.5）。
 * 读库失败时退回快照（可用性优先，不因为计数读失败把绑定入口打挂）。
 */
async function readFailureState(ctx) {
  try {
    const res = await ctx.db.collection('users').doc(ctx.openid).get();
    return res && res.data ? res.data : ctx.user;
  } catch (err) {
    // 文档缺失或读故障都退回快照：限流是防滥用，不因为一次读失败把绑定入口打挂
    return ctx.user;
  }
}

async function assertNotRateLimited(ctx) {
  const user = await readFailureState(ctx);
  // 同步回 ctx.user，供 recordFailure 判断窗口是否有效
  ctx.user = Object.assign({}, ctx.user, {
    bindFailCount: user.bindFailCount,
    bindFailResetAt: user.bindFailResetAt,
  });
  if ((user.bindFailCount || 0) >= BIND_FAIL_LIMIT && windowActive(user, ctx.now)) {
    throw new AppError('BIND_RATE_LIMITED', '试太多次了，1 小时后再试');
  }
}

/**
 * 记录一次失败（窗口内累加，窗口过期重新计数）。
 * 窗口内用 db.command.inc(1) 原子自增，避免并发「读-改-写」互相覆盖丢计数；
 * 窗口刚过期时写 1（这一步并发下仍可能被覆盖，只影响计数精度，不影响鉴权与主流程）。
 */
async function recordFailure(ctx) {
  const active = windowActive(ctx.user, ctx.now);
  if (active) {
    await ctx.db.collection('users').doc(ctx.openid).update({
      data: { bindFailCount: ctx.db.command.inc(1), updatedAt: ctx.now },
    }).catch(() => {});
    ctx.user.bindFailCount = (ctx.user.bindFailCount || 0) + 1;
  } else {
    await ctx.db.collection('users').doc(ctx.openid).update({
      data: { bindFailCount: 1, bindFailResetAt: ctx.now, updatedAt: ctx.now },
    }).catch(() => {});
    ctx.user.bindFailCount = 1;
    ctx.user.bindFailResetAt = ctx.now;
  }
}

async function clearFailures(db, openid, now) {
  await db.collection('users').doc(openid).update({
    data: { bindFailCount: 0, bindFailResetAt: null, updatedAt: now },
  }).catch(() => {});
}

/** 失败计数 + 抛业务错误 */
async function failWith(ctx, code, message) {
  await recordFailure(ctx);
  throw new AppError(code, message);
}

/**
 * 读取「可加入」的邀请：存在、未过期、仍 open、不是自己、creator 未绑定。
 * 校验失败会累计限流计数。
 */
async function loadJoinableInvite(ctx, code) {
  const invite = await getInviteDocStrict(ctx.db, code);
  if (!invite) {
    await failWith(ctx, 'INVITE_NOT_FOUND', '没有找到这个邀请码');
  }
  if (invite.creatorOpenid === ctx.openid) {
    await failWith(ctx, 'INVITE_SELF', '不能和自己绑定哦');
  }
  // 已确认 / 已取消优先：文档 14.3 要求「已确认码预览 → INVITE_USED」，
  // 否则确认成功超过 24h 后，第三方点旧码会被误导成「邀请码过期了」。
  if (invite.status === 'confirmed' || invite.status === 'cancelled') {
    await failWith(ctx, 'INVITE_USED', '这个邀请码已经用过了');
  }
  // 再判过期：已被惰性置 expired 的码也要给 INVITE_EXPIRED，
  // 否则同一个「过期」语义会因为「是否被 status 读过」返回 INVITE_USED（文档 14.3）。
  if (invite.status === 'expired'
    || !Number.isFinite(msOf(invite.expiresAt))
    || msOf(invite.expiresAt) <= ctx.now.getTime()) {
    await expireInvite(ctx.db, invite, ctx.now);
    await failWith(ctx, 'INVITE_EXPIRED', '邀请码过期了，让 TA 重新生成');
  }
  if (invite.status !== 'open') {
    await failWith(ctx, 'INVITE_USED', '这个邀请码已经用过了');
  }
  const creator = await getUserDocStrict(ctx.db, invite.creatorOpenid);
  if (!creator) {
    await failWith(ctx, 'INVITE_USED', '这个邀请码已经用过了');
  }
  if (creator.coupleId) {
    await failWith(ctx, 'INVITE_USED', '这个邀请码已经用过了');
  }
  return { invite, creator };
}

async function create(payload, ctx) {
  const p = validate.asObject(payload);
  const regenerate = p.regenerate === undefined
    ? false
    : validate.boolean(p.regenerate, '重新生成');

  if (!ctx.user.nickname) {
    throw new AppError('PROFILE_REQUIRED', '先给自己起个名字吧');
  }
  if (ctx.user.coupleId) {
    throw new AppError('ALREADY_BOUND', '你们已经绑定啦');
  }

  // 文档 7.4 只约定 START_DATE_INVALID：非字符串、长度不对、非法日期都归到这里，
  // 不走 validate.string（否则非字符串会漏出 INVALID_INPUT、超长会漏出 TEXT_TOO_LONG）。
  // 日期字段按 11.4 之外的严格 YYYY-MM-DD 处理：不 trim，首尾空格视为非法。
  const startDate = p.startDate;
  const todayKey = time.dateKeyOf(ctx.now);
  if (typeof startDate !== 'string' || startDate.length !== 10 || !time.isValidStartDate(startDate, todayKey)) {
    throw new AppError('START_DATE_INVALID', '选一个合适的开始日期');
  }

  const existing = await findCreatorInvite(ctx);
  if (existing) {
    if (msOf(existing.expiresAt) <= ctx.now.getTime()) {
      await expireInvite(ctx.db, existing, ctx.now);
    } else if (!regenerate) {
      // 已有活跃邀请，直接复用（同一用户同时只有一个活跃邀请）
      return {
        code: existing.code,
        startDate: existing.startDate,
        expiresAt: iso(existing.expiresAt),
        state: existing.status === 'applied' ? 'applied_by_partner' : 'code_created',
      };
    } else {
      await ctx.db.collection('bind_invites').doc(inviteIdOf(existing)).update({
        data: { status: 'cancelled', updatedAt: ctx.now },
      });
    }
  }

  const now = ctx.now;
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);

  // 码空间 100 万，重复概率低；靠 _id 唯一性兜底，冲突时重试
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = newInviteCode();
    try {
      await ctx.db.collection('bind_invites').add({
        data: {
          _id: code,
          code,
          creatorOpenid: ctx.openid,
          applicantOpenid: null,
          status: 'open',
          startDate,
          expiresAt,
          appliedAt: null,
          confirmedAt: null,
          coupleId: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      return { code, startDate, expiresAt: expiresAt.toISOString(), state: 'code_created' };
    } catch (err) {
      // 只记录失败次数与错误类型，不打印错误消息（可能带出 _id，也就是完整邀请码）
      console.error('[bind.create] invite write failed', JSON.stringify({
        attempt: attempt + 1,
        errCode: err && (err.errCode || err.code),
      }));
    }
  }

  throw new AppError('INTERNAL_ERROR', '服务开小差了，稍后再试');
}

async function preview(payload, ctx) {
  const code = validate.code(payload.code);
  await assertNotRateLimited(ctx);
  if (ctx.user.coupleId) {
    throw new AppError('ALREADY_BOUND', '你们已经绑定啦');
  }
  const { invite, creator } = await loadJoinableInvite(ctx, code);
  return {
    code: invite.code,
    creator: publicProfile(creator),
    startDate: invite.startDate,
    expiresAt: iso(invite.expiresAt),
    status: 'open',
  };
}

async function apply(payload, ctx) {
  const code = validate.code(payload.code);
  await assertNotRateLimited(ctx);
  if (ctx.user.coupleId) {
    throw new AppError('ALREADY_BOUND', '你们已经绑定啦');
  }
  const existingApply = await findApplicantInvite(ctx);
  if (existingApply) {
    if (msOf(existingApply.expiresAt) <= ctx.now.getTime()) {
      // 旧申请已过期：先惰性置 expired，再允许申请新码
      await expireInvite(ctx.db, existingApply, ctx.now);
    } else {
      throw new AppError('BIND_ALREADY_APPLIED', '你已经申请过啦，先取消');
    }
  }

  const { invite, creator } = await loadJoinableInvite(ctx, code);

  try {
    await ctx.db.runTransaction(async (transaction) => {
      // 事务内重读，避免两个人同时确认同一个码
      const inviteNow = (await transaction.collection('bind_invites').doc(code).get()).data;
      if (!inviteNow || inviteNow.status !== 'open') {
        throw new AppError('INVITE_USED', '这个邀请码已经用过了');
      }
      if (msOf(inviteNow.expiresAt) <= ctx.now.getTime()) {
        throw new AppError('INVITE_EXPIRED', '邀请码过期了，让 TA 重新生成');
      }
      const me = (await transaction.collection('users').doc(ctx.openid).get()).data;
      if (!me || me.coupleId) {
        throw new AppError('ALREADY_BOUND', '你们已经绑定啦');
      }
      const creatorNow = (await transaction.collection('users').doc(inviteNow.creatorOpenid).get()).data;
      if (!creatorNow || creatorNow.coupleId) {
        throw new AppError('INVITE_USED', '这个邀请码已经用过了');
      }
      await transaction.collection('bind_invites').doc(code).update({
        data: { status: 'applied', applicantOpenid: ctx.openid, appliedAt: ctx.now, updatedAt: ctx.now },
      });
    });
  } catch (err) {
    // 文档 6.9：被他人抢先（事务内发现码已不可用）也要计一次失败，防并发枚举
    if (err instanceof AppError && err.code === 'INVITE_USED') {
      await recordFailure(ctx);
    }
    throw err;
  }

  await clearFailures(ctx.db, ctx.openid, ctx.now);

  return {
    state: 'applied_by_me',
    code,
    creator: publicProfile(creator),
    startDate: invite.startDate,
    expiresAt: iso(invite.expiresAt),
  };
}

async function confirm(payload, ctx) {
  const code = validate.code(payload.code);
  const invite = await getInviteDocStrict(ctx.db, code);
  if (!invite) {
    throw new AppError('INVITE_NOT_FOUND', '没有找到这个邀请码');
  }
  if (invite.creatorOpenid !== ctx.openid) {
    throw new AppError('INVITE_NOT_CREATOR', '这个邀请不是你生成的');
  }

  if (invite.status === 'confirmed') {
    // 幂等：已确认且本人是成员，直接返回已有关系
    const couple = await getCoupleDoc(ctx.db, invite.coupleId);
    if (!couple || !(couple.memberOpenids || []).includes(ctx.openid)) {
      throw new AppError('INVITE_USED', '这个邀请码已经用过了');
    }
    const partnerOpenid = couple.memberOpenids.find((id) => id !== ctx.openid);
    const partner = await getUserDoc(ctx.db, partnerOpenid);
    const todayKey = time.dateKeyOf(ctx.now);
    return {
      coupleId: invite.coupleId,
      startDate: couple.startDate,
      daysTogether: time.daysTogether(couple.startDate, todayKey),
      partner: partner ? publicProfile(partner) : null,
    };
  }

  // 已取消的码不属于「待确认」，先按 INVITE_NOT_APPLIED 返回，不因过期与否改变语义
  if (invite.status === 'cancelled') {
    throw new AppError('INVITE_NOT_APPLIED', 'TA 还没有申请');
  }
  // 先判过期：被惰性置 expired、或 status 还是 applied 但已过期的码，都按 INVITE_EXPIRED 返回
  if (invite.status === 'expired'
    || !Number.isFinite(msOf(invite.expiresAt))
    || msOf(invite.expiresAt) <= ctx.now.getTime()) {
    await expireInvite(ctx.db, invite, ctx.now);
    throw new AppError('INVITE_EXPIRED', '邀请码过期了，让 TA 重新生成');
  }
  if (invite.status !== 'applied') {
    throw new AppError('INVITE_NOT_APPLIED', 'TA 还没有申请');
  }

  // coupleId 在事务外生成，避免事务内随机数冲突
  const coupleId = `c_${crypto.randomBytes(8).toString('hex')}`;

  const result = await ctx.db.runTransaction(async (transaction) => {
    // 事务内先读后写，全部成功才提交
    const inviteNow = (await transaction.collection('bind_invites').doc(code).get()).data;
    if (!inviteNow || inviteNow.status !== 'applied') {
      throw new AppError('INVITE_USED', '这个邀请码已经用过了');
    }
    if (msOf(inviteNow.expiresAt) <= ctx.now.getTime()) {
      throw new AppError('INVITE_EXPIRED', '邀请码过期了，让 TA 重新生成');
    }

    const creator = (await transaction.collection('users').doc(ctx.openid).get()).data;
    const applicant = (await transaction.collection('users').doc(inviteNow.applicantOpenid).get()).data;

    if (!creator || creator.coupleId) {
      throw new AppError('ALREADY_BOUND', '你们已经绑定啦');
    }
    if (!applicant || applicant.coupleId) {
      throw new AppError('APPLICANT_ALREADY_BOUND', 'TA 已经和别人绑定了');
    }

    const now = ctx.now;
    await transaction.collection('couples').doc(coupleId).set({
      data: {
        memberOpenids: [ctx.openid, inviteNow.applicantOpenid],
        startDate: inviteNow.startDate,
        startDateUpdatedBy: ctx.openid,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    await transaction.collection('users').doc(ctx.openid).update({
      data: { coupleId, updatedAt: now },
    });
    await transaction.collection('users').doc(inviteNow.applicantOpenid).update({
      data: { coupleId, updatedAt: now },
    });
    await transaction.collection('bind_invites').doc(code).update({
      data: { status: 'confirmed', coupleId, confirmedAt: now, updatedAt: now },
    });

    return { coupleId, applicantOpenid: inviteNow.applicantOpenid, startDate: inviteNow.startDate };
  });

  // 成功后重置双方失败计数（失败不影响主流程）
  await Promise.all([
    clearFailures(ctx.db, ctx.openid, ctx.now),
    clearFailures(ctx.db, result.applicantOpenid, ctx.now),
  ]);

  const applicant = await getUserDoc(ctx.db, result.applicantOpenid);
  return {
    coupleId: result.coupleId,
    startDate: result.startDate,
    daysTogether: time.daysTogether(result.startDate, time.dateKeyOf(ctx.now)),
    partner: applicant ? publicProfile(applicant) : null,
  };
}

async function cancel(payload, ctx) {
  const code = validate.code(payload.code);
  const invite = await getInviteDocStrict(ctx.db, code);
  if (!invite) {
    throw new AppError('INVITE_NOT_FOUND', '没有找到这个邀请码');
  }
  if (ctx.user.coupleId || invite.status === 'confirmed') {
    throw new AppError('ALREADY_BOUND', '你们已经绑定啦');
  }

  const isCreator = invite.creatorOpenid === ctx.openid;
  const isApplicant = invite.applicantOpenid === ctx.openid;
  if (!isCreator && !isApplicant) {
    throw new AppError('FORBIDDEN', '这个邀请不属于你');
  }
  if (isApplicant && invite.status !== 'applied') {
    throw new AppError('FORBIDDEN', '你还没有申请这个邀请');
  }
  if (invite.status !== 'open' && invite.status !== 'applied') {
    throw new AppError('INVITE_USED', '这个邀请码已经用过了');
  }

  await ctx.db.collection('bind_invites').doc(code).update({
    data: { status: 'cancelled', updatedAt: ctx.now },
  });
  return { state: 'unbound' };
}

/**
 * 绑定状态机：unbound / code_created / applied_by_partner / applied_by_me / bound。
 * 过期邀请在读取时惰性置 expired。
 */
async function computeStatus(ctx) {
  const db = ctx.db;
  const now = ctx.now;

  if (ctx.user.coupleId) {
    const couple = await getCoupleDoc(db, ctx.user.coupleId);
    if (couple && couple.status === 'active' && (couple.memberOpenids || []).includes(ctx.openid)) {
      return { state: 'bound', pending: null };
    }
    // 数据异常：couples 文档缺失，重置为未绑定，避免永久白屏
    console.error('[bind] couple missing or invalid', JSON.stringify({
      openidTail: String(ctx.openid).slice(-6),
      coupleIdTail: String(ctx.user.coupleId || '').slice(-6),
    }));
    await db.collection('users').doc(ctx.openid).update({
      data: { coupleId: null, reminderEnabled: false, updatedAt: now },
    }).catch(() => {});
    ctx.user.coupleId = null;
    ctx.couple = null;
  }

  const own = await findCreatorInvite(ctx);
  if (own) {
    if (msOf(own.expiresAt) <= now.getTime()) {
      await expireInvite(db, own, now);
    } else {
      const applicant = own.status === 'applied' ? await getUserDoc(db, own.applicantOpenid) : null;
      return {
        state: own.status === 'applied' ? 'applied_by_partner' : 'code_created',
        pending: {
          code: own.code,
          role: 'creator',
          status: own.status,
          startDate: own.startDate,
          expiresAt: iso(own.expiresAt),
          other: applicant ? publicProfile(applicant) : null,
        },
      };
    }
  }

  const applied = await findApplicantInvite(ctx);
  if (applied) {
    if (msOf(applied.expiresAt) <= now.getTime()) {
      await expireInvite(db, applied, now);
    } else {
      const creator = await getUserDoc(db, applied.creatorOpenid);
      return {
        state: 'applied_by_me',
        pending: {
          code: applied.code,
          role: 'applicant',
          status: applied.status,
          startDate: applied.startDate,
          expiresAt: iso(applied.expiresAt),
          other: creator ? publicProfile(creator) : null,
        },
      };
    }
  }

  return { state: 'unbound', pending: null };
}

async function status(payload, ctx) {
  const res = await computeStatus(ctx);
  // 文档 1.5 / 10.9：picker 上限用服务端 todayKey，设备时钟超前也不能选到未来
  res.todayKey = time.dateKeyOf(ctx.now);
  return res;
}

module.exports = { create, preview, apply, confirm, cancel, status, computeStatus };