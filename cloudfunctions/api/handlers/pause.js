'use strict';

/**
 * 先停一下（文档 F13 / 7.17 / 5.3.10）。
 *
 * 一句话说明它是什么：**吵架时的关系刹车**。任一方按 10 / 30 / 60 分钟暂停，
 * 双方首页置顶一张便签，到点翻面成和好卡（先选者定），选完消失。
 *
 * 产品红线（文档 2.3 / 5.3.10）：**不存原因、不存次数、不做历史列表、不做统计**。
 * 没有字段就没有翻旧账——本文件不存在任何「查询历史暂停」的入口，closed 文档
 * 永久保留但任何接口都读不到它。
 *
 * 暂停只静音「每日提醒」（runTimer，见 reminder.js 的 isOngoing 调用），
 * 抱抱 / 日记 / 报平安等记录类操作照常。
 */

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');

/** 三档时长（分钟）；不做成「任意分钟」是为了让「30 分钟」成为一个可以随口说出的承诺 */
const DURATIONS = [10, 30, 60];
/** 和好卡三选一：文案中性，先选者定；`hug` 只是选项、不触发任何接口（抱一抱已下线） */
const CHOICES = ['hurry', 'later', 'hug'];

async function start(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const durationMin = p.durationMin;
  if (typeof durationMin !== 'number' || !isFinite(durationMin) || Math.floor(durationMin) !== durationMin) {
    throw new AppError('INVALID_INPUT', '暂停时长必须是整数');
  }
  if (DURATIONS.indexOf(durationMin) === -1) {
    throw new AppError('PAUSE_DURATION_INVALID', '选 10、30 或 60 分钟');
  }

  // 同一对同时只有一条未 closed 的记录：无论谁按的，都幂等返回现状，不新建
  const existing = await currentPause(ctx.db, ctx.couple._id, ctx.now);
  if (existing) {
    return { pause: viewOf(existing, ctx), existing: true };
  }

  const now = ctx.now;
  const doc = {
    _id: newPauseId(),
    coupleId: ctx.couple._id,
    byOpenid: ctx.openid,
    durationMin,
    status: 'active',
    startedAt: now,
    endsAt: new Date(now.getTime() + durationMin * 60 * 1000),
    endedAt: null,
    endChoice: null,
    endChoiceBy: null,
    createdAt: now,
    updatedAt: now,
  };
  const { _id, ...data } = doc;
  await ctx.db.collection('pauses').add({ data: Object.assign({ _id }, data) });
  return { pause: viewOf(doc, ctx), existing: false };
}

async function status(payload, ctx) {
  ctx.requireBound();
  const doc = await currentPause(ctx.db, ctx.couple._id, ctx.now);
  return { pause: viewOf(doc, ctx) };
}

async function end(payload, ctx) {
  ctx.requireBound();
  const doc = await currentPause(ctx.db, ctx.couple._id, ctx.now);
  if (!doc) throw new AppError('PAUSE_NOT_FOUND', '现在不需要暂停');
  if (doc.byOpenid !== ctx.openid) {
    throw new AppError('PAUSE_NOT_OWNER', '这个暂停是 TA 按的，等 TA 回来');
  }
  if (doc.status === 'active') {
    const next = { status: 'ended', endedAt: ctx.now, updatedAt: ctx.now };
    await ctx.db.collection('pauses').doc(doc._id).update({ data: next });
    return { pause: viewOf(Object.assign({}, doc, next), ctx) };
  }
  return { pause: viewOf(doc, ctx) }; // 已结束：幂等返回
}

async function choose(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const choice = validate.oneOf(p.choice, CHOICES, '和好话');

  const doc = await currentPause(ctx.db, ctx.couple._id, ctx.now);
  if (!doc) throw new AppError('PAUSE_NOT_FOUND', '现在不需要暂停');
  if (doc.status === 'active') {
    throw new AppError('PAUSE_STATE_INVALID', '暂停还没结束，先等一等');
  }

  // 两人同时选只有一个成功：事务内重读，后到者看到 closed 按幂等返回（先选者定，不报错）
  let out = null;
  await ctx.db.runTransaction(async (transaction) => {
    const fresh = (await transaction.collection('pauses').doc(doc._id).get()).data;
    if (!fresh) throw new AppError('PAUSE_NOT_FOUND', '现在不需要暂停');
    if (fresh.status === 'closed') {
      out = fresh;
      return;
    }
    if (fresh.status !== 'ended') {
      throw new AppError('PAUSE_STATE_INVALID', '暂停还没结束，先等一等');
    }
    const next = {
      status: 'closed',
      endChoice: choice,
      endChoiceBy: ctx.openid,
      endedAt: fresh.endedAt || ctx.now,
      updatedAt: ctx.now,
    };
    await transaction.collection('pauses').doc(doc._id).update({ data: next });
    out = Object.assign({}, fresh, next);
  });
  return { pause: viewOf(out, ctx) };
}

function newPauseId() {
  return 'p_' + crypto.randomBytes(8).toString('hex');
}

/**
 * 当前未 closed 的一条（active / ended 里 startedAt 最新的一条），没有则 null。
 * 到点是惰性判断：now >= endsAt 时视为 ended 并写回（写失败不阻塞返回，
 * 与日记解锁 / 纪念日剩余天数的现算思路一致，不依赖定时任务）。
 */
async function currentPause(db, coupleId, now) {
  const res = await db.collection('pauses')
    .where({ coupleId, status: db.command.in(['active', 'ended']) })
    .orderBy('startedAt', 'desc')
    .limit(1)
    .get();
  let doc = res && res.data && res.data[0];
  if (!doc) return null;
  if (doc.status === 'active' && now.getTime() >= time.toMillis(doc.endsAt)) {
    const next = { status: 'ended', endedAt: now, updatedAt: now };
    try {
      await db.collection('pauses').doc(doc._id).update({ data: next });
    } catch (err) {
      // 只影响「下一次谁读到它还要不要再写一次」，不影响本次返回的语义
      console.error('[pause]', JSON.stringify({
        reason: 'lazy-end-failed',
        code: String((err && (err.errCode || err.code)) || ''),
        message: err && err.message,
      }));
    }
    doc = Object.assign({}, doc, next);
  }
  return doc;
}

/**
 * 「暂停进行中」：active 且还没到点。给 runTimer 静音用——
 * 到点（哪怕还没选和好卡）或提前结束后就不再静音，每日提醒次日自然恢复（F13 验收第 3 条）。
 * 只查 active 不写库：到点未写回的记录在这里自动视为「不再进行中」。
 */
async function isOngoing(db, coupleId, now) {
  const res = await db.collection('pauses')
    .where({ coupleId, status: 'active' })
    .orderBy('startedAt', 'desc')
    .limit(1)
    .get();
  const doc = res && res.data && res.data[0];
  return !!(doc && now.getTime() < time.toMillis(doc.endsAt));
}

/** 存储文档 → 出参视图：`byMe` 供客户端直接渲染视角，`byName` 是昵称（不返回 openid，同 home.get 脱敏） */
function viewOf(doc, ctx) {
  if (!doc) return null;
  const byMe = doc.byOpenid === ctx.openid;
  let byName = '';
  if (byMe) {
    byName = (ctx.user && ctx.user.nickname) || '';
  } else if (ctx.partner) {
    byName = ctx.partner.nickname || '';
  }
  return {
    pauseId: doc._id,
    byMe,
    byName,
    durationMin: doc.durationMin,
    status: doc.status,
    startedAt: relation.iso(doc.startedAt),
    endsAt: relation.iso(doc.endsAt),
    endChoice: doc.endChoice || null,
  };
}

module.exports = { start, status, end, choose, currentPause, isOngoing, viewOf, DURATIONS, CHOICES };
