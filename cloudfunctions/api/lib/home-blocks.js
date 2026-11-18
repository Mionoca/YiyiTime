'use strict';

const time = require('./time');
const relation = require('./relation');
const anniversaryHandler = require('../handlers/anniversary');

const iso = relation.iso;
/** 自定义纪念日上限（文档 5.3.5）：与 handlers/anniversary.js 同源，避免两处常量漂移 */
const ANNIVERSARY_MAX = anniversaryHandler.MAX_COUNT;

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
 * 纪念日聚合（文档 7.8 / 9.4）：一次查询取回全部自定义纪念日（≤8 条），
 * 剩余天数与周年在这里按服务端 todayKey 现算，客户端不递减、不自己算日期。
 * 「在一起」不在这个区块里 —— 它由 couple.startDate 推导，页面自己拼第一张卡。
 */
async function loadAnniversary(ctx, coupleId, todayKey) {
  const res = await ctx.db.collection('anniversaries')
    .where({ coupleId })
    .limit(ANNIVERSARY_MAX)
    .get();
  const docs = (res && res.data) || [];
  return { items: anniversaryHandler.toItems(docs, todayKey) };
}

/**
 * 报平安聚合（文档 7.8）：今天两人是否已报 + 伴侣最近一次报平安时间。
 * 两次查询：我的今日记录（coupleId+date 索引）、伴侣最近一条（coupleId+createdAt 索引）。
 * 5.3.6 允许一天多条，云函数单次 get 上限 100 条：不能整取今日全部记录再按 openid 找，
 * 极端连点超过 100 条时另一个人的记录会被截掉、门灯漏亮，所以每人都按 openid 精确查询。
 */
async function loadSafety(ctx, coupleId, todayKey, partnerOpenid) {
  const mineRes = await ctx.db.collection('safety_checkins')
    .where({ coupleId, date: todayKey, openid: ctx.openid })
    .limit(1)
    .get();
  const mineToday = !!(mineRes && mineRes.data && mineRes.data.length);

  let partnerToday = false;
  let partnerLastAt = null;
  if (partnerOpenid) {
    // 伴侣最近一条即最新：同一条记录同时给出「今天是否已报」和门牌时间，不额外读库。
    // 这里依赖 date 与 createdAt 由服务端同一次写入（handlers/safety.js 写入时 date=服务端 todayKey、
    // createdAt=ctx.now），所以「最新一条 createdAt 记录的 date 是否等于 todayKey」等价于
    // 「今天有没有伴侣的记录」；手工改库/导入导致两者错位时按最新一条为准。
    const lastRes = await ctx.db.collection('safety_checkins')
      .where({ coupleId, openid: partnerOpenid })
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const lastDoc = lastRes && lastRes.data && lastRes.data[0];
    if (lastDoc) {
      partnerLastAt = iso(lastDoc.createdAt);
      partnerToday = lastDoc.date === todayKey;
    }
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
  loadMood, loadAnniversary, loadSafety, loadDiary, loadWish, optionalBlock, iso,
};
