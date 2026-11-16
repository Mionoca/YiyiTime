'use strict';

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');
const { isDocumentMissing } = require('../lib/db-util');

const CONTENT_MAX = 200;
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 30;

function publicDiary(doc) {
  return {
    date: doc.date,
    content: doc.content || '',
    unlockAt: relation.iso(doc.unlockAt),
    createdAt: relation.iso(doc.createdAt),
    updatedAt: relation.iso(doc.updatedAt),
  };
}

/**
 * 写今天这行日记：_id = openid_date 做 upsert；解锁时间是服务端按 todayKey 算的次日 00:00。
 * 已过解锁时刻的旧日记不允许再改（DIARY_LOCKED）。
 */
async function save(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const content = validate.string(p.content, {
    field: 'content', min: 1, max: CONTENT_MAX, required: true, emptyCode: 'DIARY_EMPTY',
  });
  const coupleId = relation.coupleIdOf(ctx);
  const date = time.dateKeyOf(ctx.now);
  const unlockAt = time.nextUnlockAt(date);
  const id = ctx.openid + '_' + date;

  let existing = null;
  try {
    const res = await ctx.db.collection('diaries').doc(id).get();
    existing = res && res.data;
  } catch (err) {
    // 只有「文档不存在」按新建处理；读超时等故障必须上抛，避免覆盖已有日记
    if (!isDocumentMissing(err)) throw err;
    existing = null;
  }
  if (existing) {
    const unlockMs = time.toMillis(existing.unlockAt);
    if (Number.isFinite(unlockMs) && ctx.now.getTime() >= unlockMs) {
      throw new AppError('DIARY_LOCKED', '今天的日记已经解锁，不能再改了');
    }
    await ctx.db.collection('diaries').doc(id).update({
      data: { coupleId, content, unlockAt, updatedAt: ctx.now },
    });
    return {
      diary: {
        date,
        content,
        unlockAt: relation.iso(unlockAt),
        createdAt: relation.iso(existing.createdAt),
        updatedAt: ctx.now.toISOString(),
      },
    };
  }

  await ctx.db.collection('diaries').doc(id).set({
    data: {
      coupleId,
      authorOpenid: ctx.openid,
      date,
      content,
      unlockAt,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
  });

  return {
    diary: {
      date,
      content,
      unlockAt: relation.iso(unlockAt),
      createdAt: ctx.now.toISOString(),
      updatedAt: ctx.now.toISOString(),
    },
  };
}

/**
 * 日记列表：按天合并两人的记录，倒序取 limit 天。
 * 对方未到解锁时刻只给 partnerWritten/partnerUnlocked，正文置 null。
 */
async function list(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const limit = validate.integer(p.limit, {
    field: 'limit', min: 1, max: LIMIT_MAX, defaultValue: LIMIT_DEFAULT,
  });
  const todayKey = time.dateKeyOf(ctx.now);
  let beforeDate = time.addDays(todayKey, 1);
  if (p.beforeDate !== undefined && p.beforeDate !== null && p.beforeDate !== '') {
    if (!time.isValidDateKey(p.beforeDate)) {
      throw new AppError('INVALID_INPUT', '日期格式不对');
    }
    beforeDate = p.beforeDate;
  }

  const res = await ctx.db.collection('diaries')
    .where({
      coupleId: relation.coupleIdOf(ctx),
      // date 是 'YYYY-MM-DD' 字符串，字典序即时间序
      date: ctx.db.command.lt(beforeDate),
    })
    .orderBy('date', 'desc')
    .limit(limit * 2)
    .get();
  const docs = (res && res.data) || [];

  const partnerOpenid = relation.partnerOpenidOf(ctx);
  const byDate = new Map();
  docs.forEach((doc) => {
    if (!byDate.has(doc.date)) byDate.set(doc.date, []);
    byDate.get(doc.date).push(doc);
  });

  const items = [];
  for (const date of Array.from(byDate.keys())) {
    if (items.length >= limit) break;
    const dayDocs = byDate.get(date);
    const mineDoc = dayDocs.find((doc) => doc.authorOpenid === ctx.openid) || null;
    const partnerDoc = partnerOpenid
      ? dayDocs.find((doc) => doc.authorOpenid === partnerOpenid) || null
      : null;
    const unlockAt = mineDoc ? mineDoc.unlockAt : (partnerDoc ? partnerDoc.unlockAt : null);
    const unlocked = (() => {
      const ms = time.toMillis(unlockAt);
      return Number.isFinite(ms) ? ctx.now.getTime() >= ms : false;
    })();
    items.push({
      date,
      unlockAt: relation.iso(unlockAt),
      mine: mineDoc ? { content: mineDoc.content || '', updatedAt: relation.iso(mineDoc.updatedAt) } : null,
      partnerWritten: !!partnerDoc,
      // 只有对方写过且已解锁才算解锁（与 home-blocks.loadDiary 语义一致）
      partnerUnlocked: !!partnerDoc && unlocked,
      partner: partnerDoc && unlocked
        ? { content: partnerDoc.content || '', updatedAt: relation.iso(partnerDoc.updatedAt) }
        : null,
    });
  }

  const nextBeforeDate = items.length === limit ? items[items.length - 1].date : null;
  return { items, nextBeforeDate };
}

module.exports = { save, list, CONTENT_MAX };
