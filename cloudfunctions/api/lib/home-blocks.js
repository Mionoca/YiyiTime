'use strict';

const time = require('./time');

function iso(value) {
  const ms = time.toMillis(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** 今日两个人的心情（一次查询；coupleId + date 索引） */
async function loadMood(ctx, coupleId, todayKey, partnerOpenid) {
  const res = await ctx.db.collection('moods')
    .where({ coupleId, date: todayKey })
    .limit(2)
    .get();
  const docs = (res && res.data) || [];
  const pick = (openid) => {
    const doc = docs.find((item) => item.openid === openid);
    return doc
      ? { mood: doc.mood, note: doc.note || '', updatedAt: iso(doc.updatedAt) }
      : null;
  };
  return {
    mine: pick(ctx.openid),
    partner: partnerOpenid ? pick(partnerOpenid) : null,
  };
}

/**
 * 抱抱聚合：incoming 只返回未过期 pending；outgoing 返回最近一条（任意状态），
 * 过期 pending 在响应里状态为 expired（惰性写回，不做批量更新）。
 */
async function loadHug(ctx, coupleId) {
  const nowMs = ctx.now.getTime();

  let incoming = null;
  const incomingRes = await ctx.db.collection('hugs')
    .where({ coupleId, toOpenid: ctx.openid, status: 'pending' })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const incomingDoc = incomingRes && incomingRes.data && incomingRes.data[0];
  if (incomingDoc) {
    const expiresMs = time.toMillis(incomingDoc.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs > nowMs) {
      incoming = {
        hugId: incomingDoc._id,
        createdAt: iso(incomingDoc.createdAt),
        expiresAt: iso(incomingDoc.expiresAt),
      };
    } else {
      await ctx.db.collection('hugs').doc(incomingDoc._id).update({
        data: { status: 'expired' },
      }).catch(() => {});
    }
  }

  let outgoing = null;
  const outgoingRes = await ctx.db.collection('hugs')
    .where({ coupleId, fromOpenid: ctx.openid })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const outgoingDoc = outgoingRes && outgoingRes.data && outgoingRes.data[0];
  if (outgoingDoc) {
    let status = outgoingDoc.status;
    const expiresMs = time.toMillis(outgoingDoc.expiresAt);
    if (status === 'pending' && (!Number.isFinite(expiresMs) || expiresMs <= nowMs)) {
      status = 'expired';
      await ctx.db.collection('hugs').doc(outgoingDoc._id).update({
        data: { status: 'expired' },
      }).catch(() => {});
    }
    outgoing = {
      hugId: outgoingDoc._id,
      status,
      createdAt: iso(outgoingDoc.createdAt),
      respondedAt: outgoingDoc.respondedAt ? iso(outgoingDoc.respondedAt) : null,
      expiresAt: iso(outgoingDoc.expiresAt),
    };
  }

  return { incoming, outgoing };
}

/** 可选区块单块失败：记日志并按 null 返回，不影响整页（文档 10.3） */
async function optionalBlock(ctx, name, task) {
  try {
    return await task();
  } catch (err) {
    console.error('[home.get] optional block failed', JSON.stringify({
      block: name,
      message: err && err.message,
      openidTail: String(ctx.openid).slice(-6),
    }));
    return null;
  }
}

module.exports = { loadMood, loadHug, optionalBlock, iso };
