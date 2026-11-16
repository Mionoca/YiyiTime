'use strict';

const time = require('./time');
const relation = require('./relation');

const iso = relation.iso;

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

/**
 * 报平安聚合（文档 7.8）：今天两人是否已报 + 伴侣最近一次报平安时间。
 * 两次查询：今日两人（coupleId+date 索引）、伴侣最近一条（coupleId+createdAt 索引）。
 */
async function loadSafety(ctx, coupleId, todayKey, partnerOpenid) {
  // 5.3.6 允许一天多条：不能用 limit(2) 假设两人各一条，
  // 无排序的 limit 返回哪两条未定义，会把某一人的今日记录截掉
  const todayRes = await ctx.db.collection('safety_checkins')
    .where({ coupleId, date: todayKey })
    .get();
  const todayDocs = (todayRes && todayRes.data) || [];
  const mineToday = todayDocs.some((doc) => doc.openid === ctx.openid);
  const partnerToday = partnerOpenid
    ? todayDocs.some((doc) => doc.openid === partnerOpenid)
    : false;

  let partnerLastAt = null;
  if (partnerOpenid) {
    const lastRes = await ctx.db.collection('safety_checkins')
      .where({ coupleId, openid: partnerOpenid })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const lastDoc = lastRes && lastRes.data && lastRes.data[0];
    partnerLastAt = lastDoc ? iso(lastDoc.createdAt) : null;
  }

  return { mineToday, partnerToday, partnerLastAt };
}

/**
 * 日记聚合（文档 7.8）：今天两人是否已写 + 解锁时刻。
 * 今天写的日记要到次日 00:00 才解锁，所以 partnerUnlocked 今天恒为 false。
 */
async function loadDiary(ctx, coupleId, todayKey, partnerOpenid) {
  const res = await ctx.db.collection('diaries')
    .where({ coupleId, date: todayKey })
    .limit(2)
    .get();
  const docs = (res && res.data) || [];
  const mineWritten = docs.some((doc) => doc.authorOpenid === ctx.openid);
  const partnerWritten = partnerOpenid
    ? docs.some((doc) => doc.authorOpenid === partnerOpenid)
    : false;
  const unlockAt = time.nextUnlockAt(todayKey);
  const unlockMs = time.toMillis(unlockAt);
  // 跨天刷新后 todayKey 变化时这里自然变成 true（当天写入的日记当天永远看不到）
  const partnerUnlocked = partnerWritten
    && Number.isFinite(unlockMs)
    && ctx.now.getTime() >= unlockMs;

  return {
    mineWritten,
    partnerWritten,
    partnerUnlocked,
    unlockAt: iso(unlockAt),
  };
}

/**
 * 愿望聚合（文档 7.8）：一次读全量（≤100）本地算统计，避免 3 次 count；
 * previewTitle 取第一条未完成（createdAt 升序）的标题。
 */
async function loadWish(ctx, coupleId) {
  const res = await ctx.db.collection('wishes')
    .where({ coupleId })
    .limit(100)
    .get();
  const docs = (res && res.data) || [];
  const undone = docs.filter((doc) => !doc.done)
    .sort((a, b) => time.toMillis(a.createdAt) - time.toMillis(b.createdAt));
  return {
    total: docs.length,
    done: docs.filter((doc) => doc.done).length,
    previewTitle: undone.length ? (undone[0].title || '') : null,
  };
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

module.exports = {
  loadMood, loadHug, loadSafety, loadDiary, loadWish, optionalBlock, iso,
};
