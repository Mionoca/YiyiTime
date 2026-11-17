'use strict';

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');
const { isDocumentMissing } = require('../lib/db-util');

/** 文档 7.6：四种心情，客户端不接受日期（日期一律服务端 todayKey） */
const MOODS = ['sunny', 'cloudy', 'rainy', 'thunder'];
const NOTE_MAX = 50;
const LIMIT_DEFAULT = 10;
// 30 × 2 + 1 = 61 < 云库单次 get 上限 100；把上限调到 ≥50 前必须先改取数策略
const LIMIT_MAX = 30;

/**
 * 心情打卡：按 _id = openid_date upsert，同一天重复调用是更新。
 * 返回 updatedAt 用本次请求时间（与写入值一致，避免再读一次）。
 */
async function set(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const mood = validate.oneOf(p.mood, MOODS, '心情');
  const note = validate.string(p.note, { field: '备注', max: NOTE_MAX });
  const coupleId = ctx.couple._id || ctx.user.coupleId;
  const date = time.dateKeyOf(ctx.now);
  const id = `${ctx.openid}_${date}`;

  let existing = null;
  try {
    existing = await ctx.db.collection('moods').doc(id).get();
  } catch (err) {
    if (!isDocumentMissing(err)) throw err;
  }
  if (existing && existing.data) {
    await ctx.db.collection('moods').doc(id).update({
      // coupleId 一并写：万一中途重新绑定，次日不会把旧关系的心情算到新关系头上
      data: { coupleId, mood, note, updatedAt: ctx.now },
    });
  } else {
    await ctx.db.collection('moods').doc(id).set({
      data: {
        coupleId,
        openid: ctx.openid,
        date,
        mood,
        note,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      },
    });
  }

  return {
    mood: {
      mood,
      note,
      date,
      updatedAt: ctx.now.toISOString(),
    },
  };
}

/** 心情记录里的一条：只给展示要用的三个字段，不带 openid / coupleId（11.2） */
function publicMood(doc) {
  return {
    mood: doc.mood,
    // 契约是 string：脏值（数字 / 对象）不往下传，客户端不用再兜
    note: typeof doc.note === 'string' ? doc.note : '',
    updatedAt: relation.iso(doc.updatedAt),
  };
}

/**
 * 心情记录时间线（文档 7.6）：按天倒序，把两人当天的心情合并成一条。
 * 每人每天最多一条，所以一次取「limit × 2 + 1」条就足以判断还有没有更早的一天，
 * 不需要按天逐条查（13.11 禁止 N+1）。
 */
async function list(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const limit = validate.integer(p.limit, {
    field: '分页条数', min: 1, max: LIMIT_MAX, defaultValue: LIMIT_DEFAULT,
  });
  const todayKey = time.dateKeyOf(ctx.now);
  // 缺省上界是「明天」：包含今天，且不会把未来的脏数据带出来
  let beforeDate = time.addDays(todayKey, 1);
  if (p.beforeDate !== undefined && p.beforeDate !== null && p.beforeDate !== '') {
    if (!time.isValidDateKey(p.beforeDate)) {
      throw new AppError('INVALID_INPUT', '日期格式不对');
    }
    // 客户端可以翻到任意更早的一天，但不能越过今天（否则会把未来日期的脏数据当历史）
    beforeDate = p.beforeDate < beforeDate ? p.beforeDate : beforeDate;
  }

  // 成员不是恰好两人（控制台手工换绑后可能残留 3 个）时无法判断谁是现任，
  // 只返回自己的记录，避免把旧伴侣的心情当现任（5.6 / 11.2）。
  const members = (ctx.couple && ctx.couple.memberOpenids) || [];
  const partnerOpenid = members.length === 2 ? relation.partnerOpenidOf(ctx) : null;
  // 精确限定到这两位：即便同一 coupleId 下留有旧伴侣的记录，也不会被读出来，
  // 同时保证「每人每天最多一条」→ 每天最多两条，下面的 limit × 2 + 1 才成立。
  const openids = partnerOpenid ? [ctx.openid, partnerOpenid] : [ctx.openid];

  const res = await ctx.db.collection('moods')
    .where({
      coupleId: relation.coupleIdOf(ctx),
      openid: ctx.db.command.in(openids),
      // date 是 'YYYY-MM-DD' 字符串，字典序即时间序
      date: ctx.db.command.lt(beforeDate),
    })
    .orderBy('date', 'desc')
    .limit(limit * 2 + 1)
    .get();
  const docs = (res && res.data) || [];

  // Map 保留 orderBy 的倒序；同一天最多两条（我一条、TA 一条）
  const byDate = new Map();
  docs.forEach((doc) => {
    if (!byDate.has(doc.date)) byDate.set(doc.date, []);
    byDate.get(doc.date).push(doc);
  });

  const dates = Array.from(byDate.keys());
  const hasMore = dates.length > limit;
  const picked = hasMore ? dates.slice(0, limit) : dates;

  const days = picked.map((date) => {
    const dayDocs = byDate.get(date);
    const mineDoc = dayDocs.find((doc) => doc.openid === ctx.openid) || null;
    const partnerDoc = partnerOpenid
      ? dayDocs.find((doc) => doc.openid === partnerOpenid) || null
      : null;
    return {
      date,
      mine: mineDoc ? publicMood(mineDoc) : null,
      partner: partnerDoc ? publicMood(partnerDoc) : null,
    };
  });

  return {
    days,
    // 不含上界：客户端下次用这个日期翻页，不会和本页最后一天重复
    nextBeforeDate: hasMore ? picked[picked.length - 1] : null,
    todayKey,
  };
}

module.exports = { set, list, MOODS, NOTE_MAX, LIMIT_MAX, LIMIT_DEFAULT };
