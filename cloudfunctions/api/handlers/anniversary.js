'use strict';

/**
 * 自定义纪念日（文档 M12 / 5.3.5 / 7.7）。
 *
 * 「在一起」不在这里：它由 couples.startDate 推导，随 home.get 的 couple 字段返回。
 * 本 handler 只管用户自己加的那些（第一次见面、生日、计划中的婚礼……）。
 *
 * 几条硬规则：
 * - 每对最多 8 条（加「在一起」正好 9 张卡，堆叠翻页不至于太长）；
 * - nextDate / daysLeft 每天都会变，一律现算，不落库；
 * - 日期允许未来（计划中的日子也要能记），范围 2000-01-01 ~ 2099-12-31；
 * - 标题是用户自由文本，写库前必须送审（7.16）。
 */

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const security = require('../lib/security');
const time = require('../lib/time');
const relation = require('../lib/relation');
const dbUtil = require('../lib/db-util');

const TITLE_MAX = 12;
const MAX_COUNT = 8;
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2099-12-31';
const ID_MAX = 64;

function newAnniversaryId() {
  return 'a_' + crypto.randomBytes(8).toString('hex');
}

/** 排序：先按下一次发生的日期，再看原始月-日，最后按创建时间（保证两台设备顺序一致） */
function compareItems(a, b) {
  if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
  const mdA = a.date.slice(5);
  const mdB = b.date.slice(5);
  if (mdA !== mdB) return mdA < mdB ? -1 : 1;
  return time.toMillis(a.createdAt) - time.toMillis(b.createdAt);
}

function publicItem(doc, todayKey) {
  const next = time.yearlyOccurrence(doc.date, todayKey);
  return {
    anniversaryId: doc._id,
    title: doc.title || '',
    date: doc.date,
    nextDate: next ? next.date : null,
    daysLeft: next ? next.daysLeft : null,
    years: next ? next.years : null,
    createdAt: relation.iso(doc.createdAt),
  };
}

/** 所有列表出参都走同一条路径：现算 → 排序 → 去掉内部字段 */
function toItems(docs, todayKey) {
  return docs
    .map((doc) => publicItem(doc, todayKey))
    .sort(compareItems);
}

async function loadAll(ctx, coupleId) {
  const res = await ctx.db.collection('anniversaries')
    .where({ coupleId })
    .limit(MAX_COUNT + 4) // 上限加一点余量：并发多写一两条时也能读全，便于展示与删改
    .get();
  return (res && res.data) || [];
}

/** 日期校验：真实存在 + 在允许区间；统一报 INVALID_INPUT（文案「日期不对」） */
function dateKeyOf(value) {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!time.isValidDateKey(key) || key < MIN_DATE || key > MAX_DATE) {
    throw new AppError('INVALID_INPUT', '日期不对');
  }
  return key;
}

function anniversaryIdOf(payload) {
  const id = typeof payload.anniversaryId === 'string' ? payload.anniversaryId.trim() : '';
  if (!id || id.length > ID_MAX) {
    throw new AppError('ANNIVERSARY_NOT_FOUND', '这个纪念日找不到了');
  }
  return id;
}

/** 读一条；只有「文档不存在」算 null，数据库故障必须上抛（与 wish / diary 一致） */
async function readDoc(ctx, anniversaryId) {
  try {
    const res = await ctx.db.collection('anniversaries').doc(anniversaryId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (dbUtil.isDocumentMissing(err)) return null;
    throw err;
  }
}

async function loadOwned(ctx, anniversaryId) {
  const coupleId = relation.coupleIdOf(ctx);
  const doc = await readDoc(ctx, anniversaryId);
  if (!doc) {
    throw new AppError('ANNIVERSARY_NOT_FOUND', '这个纪念日找不到了');
  }
  if (doc.coupleId !== coupleId) {
    throw new AppError('FORBIDDEN', '这个纪念日不属于你们');
  }
  return doc;
}

async function add(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const title = validate.string(p.title, {
    field: '纪念日', min: 1, max: TITLE_MAX, required: true,
  });
  const date = dateKeyOf(p.date);
  await security.assertText(ctx, title, 'social');

  const coupleId = relation.coupleIdOf(ctx);
  const docs = await loadAll(ctx, coupleId);
  if (docs.length >= MAX_COUNT) {
    throw new AppError('ANNIVERSARY_LIMIT_REACHED', '纪念日最多记 8 个，先删一个吧');
  }

  const anniversaryId = newAnniversaryId();
  const now = ctx.now;
  const doc = {
    coupleId,
    title,
    date,
    createdBy: ctx.openid,
    createdAt: now,
    updatedAt: now,
  };
  await ctx.db.collection('anniversaries').doc(anniversaryId).set({ data: doc });

  const items = toItems(
    docs.concat([Object.assign({ _id: anniversaryId }, doc)]),
    time.dateKeyOf(now)
  );
  return {
    item: publicItem(Object.assign({ _id: anniversaryId }, doc), time.dateKeyOf(now)),
    items,
  };
}

async function update(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();
  const anniversaryId = anniversaryIdOf(p);

  const hasTitle = p.title !== undefined && p.title !== null;
  const hasDate = p.date !== undefined && p.date !== null;
  if (!hasTitle && !hasDate) {
    throw new AppError('INVALID_INPUT', '至少改一个字段');
  }

  const doc = await loadOwned(ctx, anniversaryId);
  const data = { updatedAt: ctx.now };
  if (hasTitle) {
    data.title = validate.string(p.title, {
      field: '纪念日', min: 1, max: TITLE_MAX, required: true,
    });
    await security.assertText(ctx, data.title, 'social');
  }
  if (hasDate) data.date = dateKeyOf(p.date);

  await ctx.db.collection('anniversaries').doc(anniversaryId).update({ data });

  const todayKey = time.dateKeyOf(ctx.now);
  const merged = Object.assign({}, doc, data, { _id: anniversaryId });
  const docs = (await loadAll(ctx, relation.coupleIdOf(ctx)))
    .map((item) => (item._id === anniversaryId ? merged : item));
  return { item: publicItem(merged, todayKey), items: toItems(docs, todayKey) };
}

async function remove(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);
  const todayKey = time.dateKeyOf(ctx.now);
  const anniversaryId = typeof p.anniversaryId === 'string' ? p.anniversaryId.trim() : '';

  // 删除是幂等操作：空 id / 超长 / 不存在都返回 removed:false，不报错
  if (!anniversaryId || anniversaryId.length > ID_MAX) {
    return { removed: false, items: toItems(await loadAll(ctx, coupleId), todayKey) };
  }

  const doc = await readDoc(ctx, anniversaryId);
  if (!doc) {
    return { removed: false, items: toItems(await loadAll(ctx, coupleId), todayKey) };
  }
  if (doc.coupleId !== coupleId) {
    throw new AppError('FORBIDDEN', '这个纪念日不属于你们');
  }

  await ctx.db.collection('anniversaries').doc(anniversaryId).remove();
  return { removed: true, items: toItems(await loadAll(ctx, coupleId), todayKey) };
}

async function list(payload, ctx) {
  ctx.requireBound();
  const todayKey = time.dateKeyOf(ctx.now);
  const docs = await loadAll(ctx, relation.coupleIdOf(ctx));
  return { todayKey, items: toItems(docs, todayKey) };
}

module.exports = {
  add, update, remove, list, TITLE_MAX, MAX_COUNT, MIN_DATE, MAX_DATE, toItems, compareItems,
};
