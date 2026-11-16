'use strict';

const { db } = require('./db');
const { AppError } = require('./errors');
const dbUtil = require('./db-util');

/**
 * 把 openid 变成业务上下文：用户文档缺失时自动建档。
 * ctx.now 是本次请求统一时间，handler 内不要再 new Date()。
 */
async function buildContext({ openid }) {
  const now = new Date();
  let user = null;

  // 只有「文档确实不存在」才建档；超时/网络/权限等读故障必须继续抛，
  // 否则会把读故障当新建，用空白用户覆盖掉 coupleId 等已有资料。
  try {
    const userRes = await db.collection('users').doc(openid).get();
    user = userRes && userRes.data;
  } catch (err) {
    if (!dbUtil.isDocumentMissing(err)) throw err;
  }

  if (!user) {
    user = {
      _id: openid,
      openid,
      nickname: '',
      avatarFileID: '',
      coupleId: null,
      profileComplete: false,
      lastActiveAt: now,
      bindFailCount: 0,
      bindFailResetAt: null,
      createdAt: now,
      updatedAt: now,
    };
    const { _id, ...userData } = user;
    await db.collection('users').doc(openid).set({ data: userData });
  }

  let couple = null;
  let partner = null;

  if (user.coupleId) {
    // 同上：读故障必须抛，不能被当成「couples 文档不存在」，
    // 否则 home/bind 会按数据异常把 user.coupleId 重置成 null。
    try {
      const coupleRes = await db.collection('couples').doc(user.coupleId).get();
      couple = coupleRes && coupleRes.data;
    } catch (err) {
      if (!dbUtil.isDocumentMissing(err)) throw err;
    }

    if (couple) {
      const partnerOpenid = (couple.memberOpenids || []).find((id) => id !== openid);
      if (partnerOpenid) {
        const partnerRes = await db.collection('users').doc(partnerOpenid).get().catch(() => null);
        partner = partnerRes && partnerRes.data;
      }
    }
  }

  const ctx = { openid, user, couple, partner, db, now };
  // 双人接口统一用 ctx.requireBound() 做前置校验（绑定关系 + 成员身份）
  ctx.requireBound = () => requireBound(ctx);
  return ctx;
}

function requireBound(ctx) {
  if (!ctx.user.coupleId || !ctx.couple || ctx.couple.status !== 'active') {
    throw new AppError('NOT_BOUND', '先邀请 TA 住进来吧');
  }
  if (!(ctx.couple.memberOpenids || []).includes(ctx.openid)) {
    throw new AppError('FORBIDDEN', '你们还没有绑定');
  }
}

module.exports = { buildContext, requireBound };
