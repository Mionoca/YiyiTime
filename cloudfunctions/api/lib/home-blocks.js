'use strict';

const time = require('./time');
const relation = require('./relation');
const anniversaryHandler = require('../handlers/anniversary');
const growthHandler = require('../handlers/growth');
const ledgerAccess = require('../handlers/ledger-access');

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
 * 日记聚合（文档 7.8 / 5.3.7 M13）：今天两人是否已写 + 解锁时刻。
 * 隐私红线：对方的记录只有 visibility=partner 才算「写过」；私密日记按不存在处理，
 * 它的 unlockAt 也不能泄露（拿不到已分享记录时退回默认次日 00:00）。
 */
async function loadDiary(ctx, coupleId, todayKey, partnerOpenid) {
  const res = await ctx.db.collection('diaries')
    .where({ coupleId, date: todayKey })
    .limit(2)
    .get();
  const docs = (res && res.data) || [];
  const mineDoc = docs.find((doc) => doc.authorOpenid === ctx.openid) || null;
  const partnerDoc = partnerOpenid
    ? docs.find((doc) => doc.authorOpenid === partnerOpenid && doc.visibility === 'partner') || null
    : null;
  const mineWritten = !!mineDoc;
  const partnerWritten = !!partnerDoc;
  // 解锁时刻：优先自己那篇（自己永远知道自己的），否则用已分享的那篇；都没有 → 默认次日 00:00
  const unlockAt = (mineDoc && mineDoc.unlockAt)
    || (partnerDoc && partnerDoc.unlockAt)
    || time.nextUnlockAt(todayKey);
  const unlockMs = time.toMillis(unlockAt);
  // immediate 当天即可见；day 模式当天写入的日记当天永远看不到（跨天刷新后 todayKey 变化，这里自然变 true）
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
 * 账本授权摘要（文档 7.8 / 7.19 M13）：一次查询算三个数（待我处理 / 我已授权 / 我能不能看）。
 * 首页只渲染 pendingIncoming > 0 的提示条，其余字段给记账本 tab 的角标 / 文案备用。
 */
async function loadLedgerAccess(ctx) {
  return ledgerAccess.homeAccess(ctx);
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

/**
 * 成长卡聚合（文档 7.8 / 7.18）：在档列表（≤10 条）一次取回，本地算三个数；
 * 已归档数量单独 count（归档可以很多，不能整取）。未绑定时整块为 null。
 */
async function loadGrowth(ctx, coupleId) {
  const statuses = growthHandler.IN_FLIGHT;
  const [res, archivedRes] = await Promise.all([
    ctx.db.collection('growth_tasks')
      .where({ coupleId, status: ctx.db.command.in(statuses) })
      .limit(growthHandler.IN_FLIGHT_MAX)
      .get(),
    ctx.db.collection('growth_tasks')
      .where({ coupleId, status: 'archived' })
      .count(),
  ]);
  const docs = (res && res.data) || [];
  const active = docs
    .filter((doc) => doc.status === 'active')
    .sort((a, b) => time.toMillis(a.createdAt) - time.toMillis(b.createdAt));
  return {
    inFlight: docs.length,
    firstActiveTitle: active.length ? (active[0].title || '') : null,
    awaitingConfirm: docs.some((doc) => doc.status === 'confirming'),
    archivedCount: (archivedRes && archivedRes.total) || 0,
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
  loadMood, loadAnniversary, loadDiary, loadWish, loadGrowth,
  loadLedgerAccess, optionalBlock, iso,
};
