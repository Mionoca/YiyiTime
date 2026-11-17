'use strict';

const time = require('./time');

/** 当前情侣关系 id（couple 文档缺失时回退用户上的 coupleId） */
function coupleIdOf(ctx) {
  return (ctx.couple && ctx.couple._id) || ctx.user.coupleId;
}

/** 伴侣 openid（关系异常时返回 null） */
function partnerOpenidOf(ctx) {
  return ((ctx.couple && ctx.couple.memberOpenids) || []).find((id) => id !== ctx.openid) || null;
}

/** 各种时间字段统一序列化为 ISO 字符串，非法值返回 null */
function iso(value) {
  const ms = time.toMillis(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 用户对外公开的三个字段（不含 openid 以外的内部字段） */
function publicUserBrief(user, openid) {
  return {
    openid: openid || '',
    nickname: (user && user.nickname) || '',
    avatarFileID: (user && user.avatarFileID) || '',
  };
}

/**
 * 解绑状态视图（文档 7.14）：home.get / couple.*Unbind 共用同一份形状，
 * 客户端只按 status + requestedByMe 决定文案，不自己推断谁是发起者。
 */
function unbindView(couple, openid) {
  const pending = !!(couple && couple.unbindStatus === 'pending');
  return {
    status: pending ? 'pending' : 'none',
    requestedByMe: pending && couple.unbindRequestedBy === openid,
    requestedAt: pending ? iso(couple.unbindRequestedAt) : null,
  };
}

module.exports = { coupleIdOf, partnerOpenidOf, iso, publicUserBrief, unbindView };
