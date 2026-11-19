'use strict';

/**
 * 手帐日记（M13，文档 5.3.7 / 7.10）：
 * - 字段：内容（1–500）+ 心情分值（1–5 可空）+ 配图（≤3，fileID）+ 可见性 + 三档延迟解锁；
 * - 可见性默认私密（服务端写死默认值，客户端不传即 private）；私密日记对伴侣完全不可见；
 * - `diary.calendar`：月度心情日历，只统计自己的分值（隐私红线：不做互相观察）；
 * - `diary.archive`：年度归档数据（客户端拼长图；PDF 为 P1 预留）。
 */
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const security = require('../lib/security');
const time = require('../lib/time');
const relation = require('../lib/relation');
const { isDocumentMissing } = require('../lib/db-util');

const CONTENT_MAX = 500;
const IMAGES_MAX = 3;
const IMAGE_ID_MIN = 12;
const IMAGE_ID_MAX = 512;
const MOOD_MIN = 1;
const MOOD_MAX = 5;
const LIMIT_DEFAULT = 10;
const LIMIT_MAX = 30;
/** 一个月最多 31 天：日历一次查询取回自己的当月记录 */
const CALENDAR_MAX = 31;
/** 归档分页：每页 100 条（云函数单次 get 上限），最多 4 页 = 400 > 366 */
const ARCHIVE_PAGE = 100;
const ARCHIVE_PAGES = 4;
const YEAR_MIN = 2000;

const VISIBILITIES = ['private', 'partner'];
const UNLOCK_MODES = ['immediate', 'day', 'week'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 日记列表里「我」的一段：可见性与分值只有自己能看到 */
function mineView(doc) {
  return {
    content: doc.content || '',
    moodScore: typeof doc.moodScore === 'number' ? doc.moodScore : null,
    images: Array.isArray(doc.images) ? doc.images.slice() : [],
    visibility: doc.visibility === 'partner' ? 'partner' : 'private',
    unlockMode: UNLOCK_MODES.indexOf(doc.unlockMode) >= 0 ? doc.unlockMode : 'day',
    updatedAt: relation.iso(doc.updatedAt),
  };
}

/** 日记列表里「TA」的一段：只有已分享且已解锁才给正文（分值与配图一并给） */
function partnerView(doc) {
  return {
    content: doc.content || '',
    moodScore: typeof doc.moodScore === 'number' ? doc.moodScore : null,
    images: Array.isArray(doc.images) ? doc.images.slice() : [],
    updatedAt: relation.iso(doc.updatedAt),
  };
}

/** 存量 / 脏数据按私密读（fail-closed）：M12 以前的文档没有 visibility 字段 */
function isShared(doc) {
  return !!doc && doc.visibility === 'partner';
}

function isUnlocked(doc, now) {
  const ms = time.toMillis(doc && doc.unlockAt);
  return Number.isFinite(ms) && now.getTime() >= ms;
}

/** 心情分值：1–5 整数，可空（不传 / null → null，写库字段恒存在） */
function moodScoreOf(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < MOOD_MIN || value > MOOD_MAX) {
    throw new AppError('INVALID_INPUT', '心情分值不对');
  }
  return value;
}

/** 配图：≤3 张 cloud:// fileID；去重后仍按原顺序存 */
function imagesOf(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppError('DIARY_IMAGE_INVALID', '图片地址不对');
  }
  if (value.length > IMAGES_MAX) {
    throw new AppError('DIARY_IMAGE_LIMIT', '配图最多 3 张');
  }
  const out = [];
  value.forEach((item) => {
    if (typeof item !== 'string'
      || item.indexOf('cloud://') !== 0
      || item.length < IMAGE_ID_MIN
      || item.length > IMAGE_ID_MAX) {
      throw new AppError('DIARY_IMAGE_INVALID', '图片地址不对');
    }
    if (out.indexOf(item) === -1) out.push(item);
  });
  return out;
}

function visibilityOf(value) {
  if (value === undefined || value === null || value === '') return 'private';
  return validate.oneOf(value, VISIBILITIES, '可见性');
}

function unlockModeOf(value) {
  if (value === undefined || value === null || value === '') return 'day';
  return validate.oneOf(value, UNLOCK_MODES, '解锁方式');
}

/** 月份：缺省当前月；2000-01 至当前月（日历不允许看未来月） */
function monthOf(value, todayKey) {
  const current = todayKey.slice(0, 7);
  if (value === undefined || value === null || value === '') return current;
  if (typeof value !== 'string' || !MONTH_RE.test(value) || value < '2000-01' || value > current) {
    throw new AppError('INVALID_INPUT', '月份不对');
  }
  return value;
}

/** 年份：2000 至服务端当前年 */
function yearOf(value, todayKey) {
  const current = Number(todayKey.slice(0, 4));
  if (typeof value !== 'number' || !Number.isInteger(value) || value < YEAR_MIN || value > current) {
    throw new AppError('INVALID_INPUT', '年份不对');
  }
  return value;
}

/** 出参组装：save 的新建 / 更新两条路径共用，避免两份字段列表漂移 */
function saveResult(date, fields, createdAtIso, updatedAtIso) {
  return {
    diary: {
      date,
      content: fields.content,
      moodScore: fields.moodScore,
      images: fields.images.slice(),
      visibility: fields.visibility,
      unlockMode: fields.unlockMode,
      unlockAt: relation.iso(fields.unlockAt),
      sharedAt: fields.sharedAt ? relation.iso(fields.sharedAt) : null,
      createdAt: createdAtIso,
      updatedAt: updatedAtIso,
    },
  };
}

/**
 * 写今天这页手帐：_id = openid_date 做 upsert。
 * unlockAt 由服务端按 unlockMode 算；visibility 缺省 private（全局固定默认值）。
 * 已过解锁时刻的旧日记不允许再改（DIARY_LOCKED）——含切换可见性，避免「TA 看过又撤回」。
 */
async function save(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const content = validate.string(p.content, {
    field: '内容', min: 1, max: CONTENT_MAX, required: true, emptyCode: 'DIARY_EMPTY',
  });
  const moodScore = moodScoreOf(p.moodScore);
  const images = imagesOf(p.images);
  const visibility = visibilityOf(p.visibility);
  const unlockMode = unlockModeOf(p.unlockMode);

  await security.assertText(ctx, content, 'social');
  await security.assertImages(ctx, images);

  const coupleId = relation.coupleIdOf(ctx);
  const date = time.dateKeyOf(ctx.now);
  const unlockAt = time.unlockAtFor(unlockMode, date, ctx.now);
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

  // sharedAt 只记首次开启分享的时刻：之后改回私密也不清（「曾经分享过」是客观事实，
  // 但私密态下伴侣侧永远读不到这个字段，它只出现在自己的出参里）
  const sharedAt = isShared(existing) && existing.sharedAt
    ? existing.sharedAt
    : (visibility === 'partner' ? ctx.now : null);

  if (existing) {
    const unlockMs = time.toMillis(existing.unlockAt);
    if (Number.isFinite(unlockMs) && ctx.now.getTime() >= unlockMs) {
      throw new AppError('DIARY_LOCKED', '这篇日记已经解锁，不能再改了');
    }
    await ctx.db.collection('diaries').doc(id).update({
      data: { coupleId, content, moodScore, images, visibility, unlockMode, unlockAt, sharedAt, updatedAt: ctx.now },
    });
    return saveResult(date, { content, moodScore, images, visibility, unlockMode, unlockAt, sharedAt },
      relation.iso(existing.createdAt), ctx.now.toISOString());
  }

  const doc = {
    coupleId,
    authorOpenid: ctx.openid,
    date,
    content,
    moodScore,
    images,
    visibility,
    unlockMode,
    unlockAt,
    sharedAt,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  await ctx.db.collection('diaries').doc(id).set({ data: doc });

  return saveResult(date, { content, moodScore, images, visibility, unlockMode, unlockAt, sharedAt },
    ctx.now.toISOString(), ctx.now.toISOString());
}

/**
 * 手帐列表：按天合并两人的记录，倒序取 limit 天。
 * 隐私规则（7.10 红线）：
 * - 自己的内容始终返回；
 * - 对方的记录只有 visibility=partner 才算「写过」；私密日记按不存在处理；
 * - 已分享但未到解锁时刻：只给 partnerWritten / partnerUnlocked，正文、分值、配图都不给；
 * - 一天里既没有我的记录、也没有「对方已分享」的记录时，这一天整个不出现
 *   （否则空卡片会泄露「那天发生过什么」）。
 */
async function list(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const limit = validate.integer(p.limit, {
    field: '分页条数', min: 1, max: LIMIT_MAX, defaultValue: LIMIT_DEFAULT,
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
  // 按天分组：date 倒序，同一天两人的记录必然相邻
  const groups = [];
  docs.forEach((doc) => {
    const last = groups[groups.length - 1];
    if (last && last.date === doc.date) last.docs.push(doc);
    else groups.push({ date: doc.date, docs: [doc] });
  });

  // 取满一页时，末尾那天的记录可能刚好被 limit*2 截断（同一天另一个人的没取到）。
  // 这一条不能用来判断「TA 那天没写」，整天留给下一页；只有一条记录且已经取满才算可疑
  const pageFull = docs.length === limit * 2;
  let usable = groups;
  if (pageFull && groups.length > 1 && groups[groups.length - 1].docs.length < 2) {
    usable = groups.slice(0, -1);
  }

  const items = [];
  // 游标必须按「扫过的天」推进，不能只看产出的条目：
  // 否则对方连续几天只写私密日记时，这些天一条条目都不产出，历史会永远翻不到（M13 隐私默认值的副作用）
  let cursor = '';
  for (const group of usable) {
    if (items.length >= limit) break;
    const mineDoc = group.docs.find((doc) => doc.authorOpenid === ctx.openid) || null;
    // 对方的记录按「已分享」过滤：私密 = 不存在
    const partnerDoc = partnerOpenid
      ? group.docs.find((doc) => doc.authorOpenid === partnerOpenid && isShared(doc)) || null
      : null;
    cursor = group.date;
    if (!mineDoc && !partnerDoc) continue;

    const partnerUnlocked = !!(partnerDoc && isUnlocked(partnerDoc, ctx.now));
    // 这一天对外的解锁时刻：优先我的（自己永远知道自己的），否则用已分享的那篇；
    // 「只有对方私密记录」的日子上面已经 continue，不会把私密 unlockAt 泄露出去
    const unlockAt = mineDoc ? mineDoc.unlockAt : partnerDoc.unlockAt;
    items.push({
      date: group.date,
      unlockAt: relation.iso(unlockAt),
      mine: mineDoc ? mineView(mineDoc) : null,
      partnerWritten: !!partnerDoc,
      partnerUnlocked,
      partner: partnerDoc && partnerUnlocked ? partnerView(partnerDoc) : null,
    });
  }

  // 还有更早的记录没读到 → 给游标：取满一页（items 到上限）或整页都被读满时都算「还有」
  const hasMore = items.length >= limit || (pageFull && !!cursor);
  const nextBeforeDate = hasMore ? cursor : null;
  // 文档 1.5 / 10.9：客户端不自己算「今天」，服务端把 todayKey 一起下发
  return { items, nextBeforeDate, todayKey };
}

/**
 * 月度心情日历（7.10）：只读自己的日记，按天给分值。
 * 查询带 authorOpenid + date <= 当月最后一天，倒序取 31 条后在内存里按当月过滤
 * （当月记录最多 31 条，倒序保证先取到当月的，历史月份最多多读几条就被丢弃）。
 */
async function calendar(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const todayKey = time.dateKeyOf(ctx.now);
  const month = monthOf(p.month, todayKey);
  const monthStart = month + '-01';
  const monthEnd = time.monthEndKey(month);

  const res = await ctx.db.collection('diaries')
    .where({
      authorOpenid: ctx.openid,
      date: ctx.db.command.lte(monthEnd),
    })
    .orderBy('date', 'desc')
    .limit(CALENDAR_MAX)
    .get();
  const docs = ((res && res.data) || []).filter((doc) => doc.date >= monthStart);

  const byDate = new Map();
  docs.forEach((doc) => byDate.set(doc.date, doc));

  const [year, monthNum] = month.split('-').map(Number);
  const totalDays = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const days = [];
  const scored = [];
  for (let day = 1; day <= totalDays; day += 1) {
    const date = `${month}-${String(day).padStart(2, '0')}`;
    const doc = byDate.get(date) || null;
    const score = doc && typeof doc.moodScore === 'number' ? doc.moodScore : null;
    if (score !== null) scored.push({ date, score });
    days.push({
      date,
      day,
      score,
      hasDiary: !!doc,
      shared: isShared(doc),
    });
  }

  // 同分取较近的一天：scored 已按日期升序，从后往前扫让后来的覆盖前面的
  const pickExtreme = (compare) => {
    let out = null;
    scored.forEach((item) => {
      if (!out || compare(item.score, out.score) >= 0) out = item;
    });
    return out ? { date: out.date, score: out.score } : null;
  };
  const best = pickExtreme((a, b) => a - b);
  const lowest = pickExtreme((a, b) => b - a);
  const average = scored.length
    ? Math.round((scored.reduce((sum, item) => sum + item.score, 0) / scored.length) * 10) / 10
    : 0;

  return {
    month,
    todayKey,
    days,
    stats: { recorded: scored.length, average, best, lowest },
  };
}

/**
 * 年度归档（7.10）：自己的全年日记，按日期升序返回，供客户端拼年度长图。
 * 分页：date 倒序、每页 100 条、最多 4 页；只查 authorOpenid，不带 coupleId
 * （自己的记录永远属于自己，与 5.3.9 个人账本同一口径）。
 */
async function archive(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const todayKey = time.dateKeyOf(ctx.now);
  const year = yearOf(p.year, todayKey);
  const yearStart = `${year}-01-01`;
  const collected = [];
  let truncated = false;

  // 第一页游标从「下一年 1 月 1 日」开始（date < 该值即全年及更早）
  let cursor = `${year + 1}-01-01`;
  for (let page = 0; page < ARCHIVE_PAGES; page += 1) {
    const res = await ctx.db.collection('diaries')
      .where({
        authorOpenid: ctx.openid,
        date: ctx.db.command.lt(cursor),
      })
      .orderBy('date', 'desc')
      .limit(ARCHIVE_PAGE)
      .get();
    const docs = (res && res.data) || [];
    if (!docs.length) break;
    docs.forEach((doc) => {
      if (doc.date >= yearStart) collected.push(doc);
    });
    const oldest = docs[docs.length - 1].date;
    if (oldest < yearStart) break;
    if (docs.length < ARCHIVE_PAGE) break;
    cursor = oldest;
    if (page === ARCHIVE_PAGES - 1) truncated = true;
  }

  collected.sort((a, b) => (a.date < b.date ? -1 : 1));
  const items = collected.map((doc) => ({
    date: doc.date,
    content: doc.content || '',
    moodScore: typeof doc.moodScore === 'number' ? doc.moodScore : null,
    images: Array.isArray(doc.images) ? doc.images.slice() : [],
    visibility: doc.visibility === 'partner' ? 'partner' : 'private',
    updatedAt: relation.iso(doc.updatedAt),
  }));
  return { year, count: items.length, items, truncated };
}

module.exports = {
  save, list, calendar, archive,
  CONTENT_MAX, IMAGES_MAX, MOOD_MIN, MOOD_MAX, LIMIT_DEFAULT, LIMIT_MAX,
};
