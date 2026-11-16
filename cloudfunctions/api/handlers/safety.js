'use strict';

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');

const NOTE_MAX = 50;
const DEDUPE_MS = 10 * 60 * 1000; // 10 分钟内重复报平安返回最近一条
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 50;

function publicEntry(doc) {
  return {
    checkinId: doc._id,
    openid: doc.openid,
    date: doc.date || '',
    note: doc.note || '',
    createdAt: relation.iso(doc.createdAt),
  };
}

/**
 * 报平安：同一个人 10 分钟内只留一条，重复调用返回最近一条并置 deduped=true。
 */
async function checkin(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const note = validate.string(p.note, { field: 'note', max: NOTE_MAX });
  const coupleId = relation.coupleIdOf(ctx);
  const todayKey = time.dateKeyOf(ctx.now);
  const nowMs = ctx.now.getTime();

  const lastRes = await ctx.db.collection('safety_checkins')
    .where({ coupleId, openid: ctx.openid })
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  const last = lastRes && lastRes.data && lastRes.data[0];
  if (last) {
    const lastMs = time.toMillis(last.createdAt);
    // 只有同一天才去重：23:58 报过、次日 00:02 再点应当算新的一天（跨天边界）
    if (last.date === todayKey && Number.isFinite(lastMs) && nowMs - lastMs < DEDUPE_MS) {
      return { entry: publicEntry(last), deduped: true };
    }
  }

  const date = todayKey;
  const addRes = await ctx.db.collection('safety_checkins').add({
    data: {
      coupleId,
      openid: ctx.openid,
      note,
      date,
      createdAt: ctx.now,
    },
  });

  return {
    entry: {
      checkinId: addRes._id,
      openid: ctx.openid,
      date,
      note,
      createdAt: ctx.now.toISOString(),
    },
    deduped: false,
  };
}

const CURSOR_SEP = '|';

/**
 * 游标格式：第一页由服务端生成 "createdAtISO|_id"，客户端只负责原样回传。
 * 纯 ISO 的旧游标仍能解析（只按毫秒 lt 翻页，边界同毫秒的记录会漏；新客户端只用复合游标）。
 */
function parseCursor(raw) {
  const text = String(raw);
  const sep = text.lastIndexOf(CURSOR_SEP);
  const isoText = sep > 0 ? text.slice(0, sep) : text;
  const id = sep > 0 ? text.slice(sep + 1) : '';
  const ms = time.toMillis(isoText);
  if (!Number.isFinite(ms)) {
    throw new AppError('INVALID_INPUT', '分页游标格式不对');
  }
  return { ms, id };
}

/**
 * 时间线：双方混排，createdAt 倒序，游标分页。
 * 7.9 写的游标是上一页最后一条 createdAt ISO；同一毫秒可能有多条（两人同时报平安），
 * 只用 ISO 做 lt 会永久丢记录、做 lte 又会在整页同毫秒时原地打转，
 * 所以游标扩展为 (createdAt, _id) 复合键，并对边界那一毫秒补一次等值查询。
 */
async function list(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const limit = validate.integer(p.limit, {
    field: 'limit', min: 1, max: LIMIT_MAX, defaultValue: LIMIT_DEFAULT,
  });

  const coupleId = relation.coupleIdOf(ctx);
  let cursor = null;
  if (p.cursor !== undefined && p.cursor !== null && p.cursor !== '') {
    cursor = parseCursor(p.cursor);
  }

  const where = { coupleId };
  if (cursor) where.createdAt = ctx.db.command.lt(new Date(cursor.ms));

  // 同毫秒按 _id 倒序：保证复合游标翻页时第一页内同毫秒记录的顺序确定，
  // 下一页再补「同一毫秒且 _id 更小」的记录（否则云库同毫秒顺序未定义，可能漏记录）
  const res = await ctx.db.collection('safety_checkins')
    .where(where)
    .orderBy('createdAt', 'desc')
    .orderBy('_id', 'desc')
    .limit(limit)
    .get();
  let docs = (res && res.data) || [];

  // 边界同毫秒且 _id 排在游标之后的记录还没返回过，补一次等值查询拼到页首。
  // 这些记录比本页其余记录更新，必须放在前面（可能把本页挤出一部分到下一页）
  if (cursor && cursor.id) {
    const tieRes = await ctx.db.collection('safety_checkins')
      .where({ coupleId, createdAt: new Date(cursor.ms) })
      .orderBy('_id', 'desc')
      .limit(LIMIT_MAX)
      .get();
    const ties = ((tieRes && tieRes.data) || [])
      .filter((doc) => String(doc._id) < cursor.id);
    if (ties.length) docs = ties.concat(docs).slice(0, limit);
  }

  const partnerOpenid = relation.partnerOpenidOf(ctx);
  const briefs = {
    [ctx.openid]: relation.publicUserBrief(ctx.user, ctx.openid),
  };
  if (partnerOpenid) {
    briefs[partnerOpenid] = relation.publicUserBrief(ctx.partner, partnerOpenid);
  }

  const items = docs.map((doc) => {
    const brief = briefs[doc.openid] || relation.publicUserBrief(null, doc.openid);
    return {
      checkinId: doc._id,
      openid: doc.openid,
      nickname: brief.nickname,
      avatarFileID: brief.avatarFileID,
      createdAt: relation.iso(doc.createdAt),
      date: doc.date || '',
      note: doc.note || '',
    };
  });

  // 满页才可能有下一页，避免多发一次空请求；游标带 _id 做同毫秒 tiebreaker
  const last = docs.length === limit ? docs[docs.length - 1] : null;
  const nextCursor = last
    ? relation.iso(last.createdAt) + CURSOR_SEP + last._id
    : null;

  return { items, nextCursor };
}

module.exports = { checkin, list, NOTE_MAX, DEDUPE_MS, CURSOR_SEP };
