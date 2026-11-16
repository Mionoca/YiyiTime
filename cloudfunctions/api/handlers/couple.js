'use strict';

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');

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
    throw new AppError('START_DATE_INVALID', '开始日期要选 2000 年以后、今天之前');
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

module.exports = { updateStartDate };
