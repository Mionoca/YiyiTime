'use strict';

const { db } = require('./db');
const { AppError } = require('./errors');

/**
 * 把 openid 变成业务上下文：用户文档缺失时自动建档。
 * ctx.now 是本次请求统一时间，handler 内不要再 new Date()。
 */
async function buildContext({ openid }) {
  const now = new Date();
  let user = null;

  const userRes = await db.collection('users').doc(openid).get().catch(() => null);
  user = userRes && userRes.data;

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
    const coupleRes = await db.collection('couples').doc(user.coupleId).get().catch(() => null);
    couple = coupleRes && coupleRes.data;

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
    throw new AppError('NOT_BOUND', '还没有绑定');
  }
  if (!(ctx.couple.memberOpenids || []).includes(ctx.openid)) {
    throw new AppError('FORBIDDEN', '你们还没有绑定');
  }
}

module.exports = { buildContext, requireBound };
