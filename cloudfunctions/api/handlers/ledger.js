'use strict';

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const security = require('../lib/security');
const time = require('../lib/time');
const relation = require('../lib/relation');
const dbUtil = require('../lib/db-util');

/** 文档 5.3.9 / 7.13：分类固定 6 种，客户端与文档必须与此一致 */
const CATEGORIES = ['food', 'transport', 'shopping', 'fun', 'daily', 'other'];
const NOTE_MAX = 30;
/** 每人每月最多 60 笔：单页一次就能放下，summary 可以按返回结果精确计算，不需要分页 */
const MONTH_LIMIT = 60;
const AMOUNT_MIN = 1;
const AMOUNT_MAX = 1000000; // 10,000 元
const LIST_MAX = 100;
const ENTRY_ID_MAX = 64;

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function newEntryId() {
  return 'le_' + crypto.randomBytes(8).toString('hex');
}

function publicEntry(doc) {
  return {
    entryId: doc._id,
    amount: doc.amount,
    category: doc.category,
    note: doc.note || '',
    date: doc.date,
    createdAt: relation.iso(doc.createdAt),
    updatedAt: relation.iso(doc.updatedAt),
  };
}

/** 金额：整数分，禁止浮点与字符串（文档 1.5「金额以分存储」） */
function amountOf(value) {
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
    throw new AppError('INVALID_INPUT', '金额不对');
  }
  if (value < AMOUNT_MIN || value > AMOUNT_MAX) {
    throw new AppError('INVALID_INPUT', '金额不对');
  }
  return value;
}

/** 消费日期：缺省今天；严格 YYYY-MM-DD，2000-01-01 至服务端今天（同 6.7 日期规则） */
function dateOf(value, todayKey) {
  if (value === undefined || value === null || value === '') return todayKey;
  if (typeof value !== 'string' || !time.isValidStartDate(value, todayKey)) {
    throw new AppError('INVALID_INPUT', '日期不对');
  }
  return value;
}

/** 月份：缺省当前月；不允许未来月份（客户端不该能记未来的账） */
function monthOf(value, todayKey) {
  const current = todayKey.slice(0, 7);
  if (value === undefined || value === null || value === '') return current;
  if (typeof value !== 'string' || !MONTH_RE.test(value) || value < '2000-01' || value > current) {
    throw new AppError('INVALID_INPUT', '月份不对');
  }
  return value;
}

function entryIdOf(payload) {
  const id = typeof payload.entryId === 'string' ? payload.entryId.trim() : '';
  if (!id || id.length > ENTRY_ID_MAX) {
    throw new AppError('LEDGER_NOT_FOUND', '这笔账找不到了');
  }
  return id;
}

/** 只有「文档确实不存在」算 null，读故障必须上抛（同 wish / diary） */
async function readEntryDoc(ctx, entryId) {
  try {
    const res = await ctx.db.collection('ledger_entries').doc(entryId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (dbUtil.isDocumentMissing(err)) return null;
    throw err;
  }
}

/** 读一条账目并校验「是自己的」：别人（含伴侣）的账只读，不能改不能删 */
async function loadOwnEntry(ctx, entryId) {
  const doc = await readEntryDoc(ctx, entryId);
  if (!doc) throw new AppError('LEDGER_NOT_FOUND', '这笔账找不到了');
  if (doc.openid !== ctx.openid) {
    throw new AppError('FORBIDDEN', '只能看 TA 的账本，不能动');
  }
  return doc;
}

async function countMonth(ctx, openid, month) {
  const res = await ctx.db.collection('ledger_entries')
    .where({ openid, month })
    .count();
  return (res && res.total) || 0;
}

async function assertMonthRoom(ctx, openid, month) {
  const used = await countMonth(ctx, openid, month);
  if (used >= MONTH_LIMIT) {
    throw new AppError('LEDGER_LIMIT_REACHED', '这个月记得太多啦，下个月再记');
  }
}

/**
 * 记账本是个人数据（文档 5.3.9）：归属只看 openid，所以未绑定也能记。
 * coupleId 只是「这段关系」的快照，未绑定时写 null——伴侣视角按 coupleId 过滤，
 * 永远不会把「我单身时记的账」算进某段关系里。
 */
async function add(payload, ctx) {
  const p = validate.asObject(payload);

  const todayKey = time.dateKeyOf(ctx.now);
  const amount = amountOf(p.amount);
  const category = validate.oneOf(p.category, CATEGORIES, '分类');
  const note = validate.string(p.note, { field: '备注', max: NOTE_MAX });
  await security.assertText(ctx, note, 'social');
  const date = dateOf(p.date, todayKey);
  const month = date.slice(0, 7);
  const coupleId = relation.coupleIdOf(ctx) || null;

  await assertMonthRoom(ctx, ctx.openid, month);

  const entryId = newEntryId();
  const doc = {
    openid: ctx.openid,
    coupleId,
    amount,
    category,
    note,
    date,
    month,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await ctx.db.collection('ledger_entries').doc(entryId).set({ data: doc });

  return { entry: publicEntry(Object.assign({ _id: entryId }, doc)) };
}

async function update(payload, ctx) {
  const p = validate.asObject(payload);
  const entryId = entryIdOf(p);
  const doc = await loadOwnEntry(ctx, entryId);

  const has = (key) => p[key] !== undefined && p[key] !== null;
  if (!has('amount') && !has('category') && !has('note') && !has('date')) {
    throw new AppError('INVALID_INPUT', '至少改一个字段');
  }

  const data = { updatedAt: ctx.now };
  if (has('amount')) data.amount = amountOf(p.amount);
  if (has('category')) data.category = validate.oneOf(p.category, CATEGORIES, '分类');
  if (has('note')) {
    data.note = validate.string(p.note, { field: '备注', max: NOTE_MAX });
    await security.assertText(ctx, data.note, 'social');
  }
  if (has('date')) {
    const date = dateOf(p.date, time.dateKeyOf(ctx.now));
    data.date = date;
    data.month = date.slice(0, 7);
  }

  // 改到别的月份：那个月也要受 60 笔上限约束，否则可以靠改日期绕过上限
  if (data.month && data.month !== doc.month) {
    await assertMonthRoom(ctx, ctx.openid, data.month);
  }

  const res = await ctx.db.collection('ledger_entries').doc(entryId).update({ data });
  // 读完之后被另一台设备删掉了：不能返回「改成功」，否则客户端会显示一笔并不存在的账
  const updated = (res && res.stats && res.stats.updated) || 0;
  if (!updated) throw new AppError('LEDGER_NOT_FOUND', '这笔账找不到了');
  return { entry: publicEntry(Object.assign({}, doc, data, { _id: entryId })) };
}

async function remove(payload, ctx) {
  const p = validate.asObject(payload);

  // 删除是幂等操作：id 为空 / 超长同样按「不存在」返回，不报错
  const entryId = typeof p.entryId === 'string' ? p.entryId.trim() : '';
  if (!entryId || entryId.length > ENTRY_ID_MAX) return { removed: false };

  const doc = await readEntryDoc(ctx, entryId);
  if (!doc) return { removed: false };
  if (doc.openid !== ctx.openid) {
    throw new AppError('FORBIDDEN', '只能看 TA 的账本，不能动');
  }

  await ctx.db.collection('ledger_entries').doc(entryId).remove();
  return { removed: true };
}

/**
 * 按月列账：month 冗余在文档上，所以查询是等值条件（不用范围查询，客户端 / 云开发索引都简单）。
 * - 自己的账本按 openid + month 查，解绑 / 换绑后仍能看到自己的全部记录；
 * - 伴侣的账本额外加 coupleId，换绑后新伴侣看不到上一段关系期间的账（文档 5.3.9）。
 */
async function list(payload, ctx) {
  const p = validate.asObject(payload);

  // 看 TA 的账本要先有 TA；看自己的账本不需要绑定（文档 5.3.9：自己的记录永远属于自己）。
  // 绑定检查放在月分 / 枚举校验之前（文档 11.4：鉴权先于入参校验）
  if (p.who === 'partner') ctx.requireBound();

  const todayKey = time.dateKeyOf(ctx.now);
  const who = p.who === undefined || p.who === null
    ? 'me'
    : validate.oneOf(p.who, ['me', 'partner'], '账本');
  const month = monthOf(p.month, todayKey);
  const coupleId = who === 'partner' ? relation.coupleIdOf(ctx) : null;
  // 未绑定时 ctx.couple 为空，partnerOpenidOf 返回 null，所以这里不会读到「上一任」的账本
  const partnerOpenid = relation.partnerOpenidOf(ctx);
  const bound = !!(ctx.couple && ctx.couple._id);
  const partner = partnerOpenid
    ? { nickname: (ctx.partner && ctx.partner.nickname) || '' }
    : null;

  const targetOpenid = who === 'partner' ? partnerOpenid : ctx.openid;
  const empty = {
    who, month, todayKey, bound, partner, items: [], summary: { total: 0, count: 0 },
  };
  if (!targetOpenid) return empty;

  const where = who === 'partner'
    ? { openid: targetOpenid, coupleId, month }
    : { openid: targetOpenid, month };
  const res = await ctx.db.collection('ledger_entries')
    .where(where)
    .orderBy('date', 'desc')
    .orderBy('createdAt', 'desc')
    .limit(LIST_MAX)
    .get();
  const docs = (res && res.data) || [];

  return {
    who,
    month,
    todayKey,
    bound,
    partner,
    items: docs.map(publicEntry),
    summary: {
      total: docs.reduce((sum, doc) => sum + (typeof doc.amount === 'number' ? doc.amount : 0), 0),
      count: docs.length,
    },
  };
}

module.exports = {
  add, update, remove, list,
  CATEGORIES, NOTE_MAX, MONTH_LIMIT, AMOUNT_MIN, AMOUNT_MAX,
};
