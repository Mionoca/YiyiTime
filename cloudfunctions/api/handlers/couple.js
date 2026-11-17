'use strict';

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');

/**
 * 修改在一起日期：双方都可改，不限制修改次数。
 * 客户端必须在调用前二次确认（文案明确「双方都会看到新天数」）。
 */
async function updateStartDate(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  // 文档 7.5 只约定 START_DATE_INVALID 一个错误码：非字符串、长度不对、非法日期都归到这里，
  // 不走 validate.string（否则会漏出 INVALID_INPUT / TEXT_TOO_LONG）。
  const startDate = p.startDate;
  const todayKey = time.dateKeyOf(ctx.now);
  if (typeof startDate !== 'string' || startDate.length !== 10 || !time.isValidStartDate(startDate, todayKey)) {
    throw new AppError('START_DATE_INVALID', '选一个合适的开始日期');
  }

  const coupleId = ctx.couple._id || ctx.user.coupleId;
  await ctx.db.collection('couples').doc(coupleId).update({
    data: {
      startDate,
      startDateUpdatedBy: ctx.openid,
      updatedAt: ctx.now,
    },
  });

  const fresh = await ctx.db.collection('couples').doc(coupleId).get().catch(() => null);
  const updatedAt = time.toMillis(fresh && fresh.data && fresh.data.updatedAt);
  return {
    startDate,
    daysTogether: time.daysTogether(startDate, todayKey),
    updatedAt: Number.isFinite(updatedAt) ? new Date(updatedAt).toISOString() : ctx.now.toISOString(),
  };
}

/**
 * 发起解绑（文档 7.14）：双方确认才生效。
 * - 事务内重读 couple：并发两次 request 只会写一次；对方已经发起时直接返回 requestedByMe:false，
 *   客户端据此显示「去确认」而不是报错（两个人先后点「解绑」不应该看到两个不同的错误）。
 */
async function requestUnbind(payload, ctx) {
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);

  return ctx.db.runTransaction(async (transaction) => {
    const fresh = (await transaction.collection('couples').doc(coupleId).get()).data;
    if (!fresh || fresh.status !== 'active' || !(fresh.memberOpenids || []).includes(ctx.openid)) {
      throw new AppError('NOT_BOUND', '先邀请 TA 住进来吧');
    }
    if (fresh.unbindStatus === 'pending') {
      return { unbind: relation.unbindView(fresh, ctx.openid) };
    }
    const data = {
      unbindStatus: 'pending',
      unbindRequestedBy: ctx.openid,
      unbindRequestedAt: ctx.now,
      updatedAt: ctx.now,
    };
    await transaction.collection('couples').doc(coupleId).update({ data });
    return { unbind: relation.unbindView(Object.assign({}, fresh, data), ctx.openid) };
  });
}

/**
 * 撤回 / 拒绝解绑：任一方都能点（发起者撤回、被申请方拒绝，效果相同）。
 * 没有待确认的解绑时返回 UNBIND_NOT_PENDING，避免「悄悄成功」让用户以为已经处理。
 */
async function cancelUnbind(payload, ctx) {
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);

  return ctx.db.runTransaction(async (transaction) => {
    const fresh = (await transaction.collection('couples').doc(coupleId).get()).data;
    // 事务内重读后必须仍然是「我在这段关系里」，否则不能动这行文档
    if (!fresh || fresh.status !== 'active' || !(fresh.memberOpenids || []).includes(ctx.openid)) {
      throw new AppError('NOT_BOUND', '先邀请 TA 住进来吧');
    }
    if (fresh.unbindStatus !== 'pending') {
      throw new AppError('UNBIND_NOT_PENDING', '现在没有待确认的解绑');
    }
    const data = {
      unbindStatus: 'none',
      unbindRequestedBy: null,
      unbindRequestedAt: null,
      updatedAt: ctx.now,
    };
    await transaction.collection('couples').doc(coupleId).update({ data });
    return { unbind: relation.unbindView(Object.assign({}, fresh, data), ctx.openid) };
  });
}

/**
 * 确认解绑：只有「被申请方」能确认（发起者自己确认返回 UNBIND_WAIT_PARTNER）。
 * 事务内一次性写 couple + 双方 users.coupleId，避免出现「关系关了但一方还挂着 coupleId」。
 * 业务数据一条都不删：历史留在原 coupleId 下，双方不再能读到（requireBound 会拦住 status !== active）。
 */
async function confirmUnbind(payload, ctx) {
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);

  await ctx.db.runTransaction(async (transaction) => {
    const fresh = (await transaction.collection('couples').doc(coupleId).get()).data;
    if (!fresh || fresh.status !== 'active' || !(fresh.memberOpenids || []).includes(ctx.openid)) {
      throw new AppError('NOT_BOUND', '先邀请 TA 住进来吧');
    }
    if (fresh.unbindStatus !== 'pending') {
      throw new AppError('UNBIND_NOT_PENDING', '现在没有待确认的解绑');
    }
    // 「双方确认」的硬约束：发起者必须是这段关系里的另一个人。
    // 数据被手工改坏（unbindStatus=pending 但 requestedBy 空/是别人）时一律不认，避免单方就能解绑。
    const members = fresh.memberOpenids || [];
    const requester = fresh.unbindRequestedBy;
    if (!requester || !members.includes(requester) || requester === ctx.openid) {
      throw new AppError('UNBIND_WAIT_PARTNER', '解绑要 TA 确认');
    }

    await transaction.collection('couples').doc(coupleId).update({
      data: {
        status: 'closed',
        unbindStatus: 'done',
        unbindConfirmedBy: ctx.openid,
        unboundAt: ctx.now,
        updatedAt: ctx.now,
      },
    });
    for (const openid of members) {
      const res = await transaction.collection('users').doc(openid).update({
        // 订阅提醒是「给 TA 报平安」的闹钟，解绑后没有可执行的动作，顺手关掉，
        // 否则会留下「开关是开的、但永远不会发」的静默状态（下次绑定后也不会自动恢复）
        data: { coupleId: null, reminderEnabled: false, updatedAt: ctx.now },
      });
      // 少清一个人就会留下「关系已关但用户还挂着 coupleId」的脏状态，直接整体回滚
      if (!res || !res.stats || res.stats.updated !== 1) {
        throw new AppError('INTERNAL_ERROR', '解绑没处理完，稍后再试');
      }
    }
  });

  return { status: 'unbound' };
}

module.exports = { updateStartDate, requestUnbind, cancelUnbind, confirmUnbind };
