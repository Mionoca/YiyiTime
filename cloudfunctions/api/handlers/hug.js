'use strict';

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');

const HUG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天有效
const HUG_ID_MAX = 64;

const iso = relation.iso;

function newHugId() {
  return 'h_' + crypto.randomBytes(8).toString('hex');
}

function publicHug(hug) {
  return {
    hugId: hug._id,
    status: hug.status,
    createdAt: iso(hug.createdAt),
    respondedAt: hug.respondedAt ? iso(hug.respondedAt) : null,
    expiresAt: iso(hug.expiresAt),
  };
}

/**
 * 发送抱抱：已有 pending 时返回原记录（existing=true），否则创建新记录，接收者为伴侣。
 * 读取时发现已过期的 pending 会惰性置为 expired，再视为「没有 pending」创建新记录。
 */
async function send(payload, ctx) {
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);
  const toOpenid = relation.partnerOpenidOf(ctx);
  if (!toOpenid) {
    throw new AppError('NOT_BOUND', '先邀请 TA 住进来吧');
  }

  const res = await ctx.db.collection('hugs')
    .where({ coupleId, fromOpenid: ctx.openid, status: 'pending' })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const pending = res && res.data && res.data[0];
  if (pending) {
    const expiresMs = time.toMillis(pending.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs > ctx.now.getTime()) {
      return { hug: publicHug(pending), existing: true };
    }
    // 过期不批量更新，只在被读到时置为 expired
    await ctx.db.collection('hugs').doc(pending._id).update({
      data: { status: 'expired' },
    }).catch(() => {});
  }

  const hugId = newHugId();
  const expiresAt = new Date(ctx.now.getTime() + HUG_TTL_MS);
  await ctx.db.collection('hugs').doc(hugId).set({
    data: {
      coupleId,
      fromOpenid: ctx.openid,
      toOpenid,
      status: 'pending',
      createdAt: ctx.now,
      respondedAt: null,
      expiresAt,
    },
  });

  return {
    hug: {
      hugId,
      status: 'pending',
      createdAt: ctx.now.toISOString(),
      respondedAt: null,
      expiresAt: expiresAt.toISOString(),
    },
    existing: false,
  };
}

/**
 * 回应抱抱：只有接收者能回应；pending → hugged；已 hugged 幂等返回 already=true；
 * 过期（含过期但仍是 pending 的脏数据）返回 HUG_EXPIRED。
 */
async function respond(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const hugId = typeof p.hugId === 'string' ? p.hugId.trim() : '';
  if (!hugId || hugId.length > HUG_ID_MAX) {
    throw new AppError('HUG_NOT_FOUND', '这次抱抱找不到了');
  }

  const res = await ctx.db.collection('hugs').doc(hugId).get().catch(() => null);
  const hug = res && res.data;
  if (!hug || hug.coupleId !== relation.coupleIdOf(ctx)) {
    throw new AppError('HUG_NOT_FOUND', '这次抱抱找不到了');
  }
  if (hug.toOpenid !== ctx.openid) {
    throw new AppError('HUG_NOT_RECIPIENT', '这个抱抱不是给你的');
  }
  if (hug.status === 'hugged') {
    return {
      hugId,
      status: 'hugged',
      respondedAt: iso(hug.respondedAt) || ctx.now.toISOString(),
      already: true,
    };
  }
  if (hug.status === 'expired') {
    throw new AppError('HUG_EXPIRED', '这次抱抱已经过期了');
  }

  const expiresMs = time.toMillis(hug.expiresAt);
  if (!Number.isFinite(expiresMs) || ctx.now.getTime() >= expiresMs) {
    await ctx.db.collection('hugs').doc(hugId).update({
      data: { status: 'expired' },
    }).catch(() => {});
    throw new AppError('HUG_EXPIRED', '这次抱抱已经过期了');
  }

  await ctx.db.collection('hugs').doc(hugId).update({
    data: { status: 'hugged', respondedAt: ctx.now },
  });

  return {
    hugId,
    status: 'hugged',
    respondedAt: ctx.now.toISOString(),
    already: false,
  };
}

module.exports = { send, respond, HUG_TTL_MS };
