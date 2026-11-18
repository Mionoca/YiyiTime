'use strict';

/**
 * 一起变好（文档 F14 / 7.18 / 5.3.11 / 5.5）。
 *
 * 一句话说明它是什么：**两个人一起做一件小事的任务池**。起草 → 对方认领才成立 →
 * 分工「我的 / TA 的」→ 完成后各写一段收获 → 双写自动归档成成长日志；任意阶段可以
 * 复盘收尾（不扣分、不追问、不需要对方同意）。
 *
 * 三条设计红线（文档 2.4 / 7.18）：
 * 1. **视角留在服务端**：存储用 `creator*` / `partner*`（以起草者为锚点），出参永远只有
 *    `myPart` / `partnerPart`。客户端不需要知道谁是 createdBy，也就不会把两个人的分工搞反；
 * 2. **不评分不排名**：没有分数、没有完成率、没有对比，日志里只有两段文字和一个 chip；
 * 3. **写完才看得到对方的**：收获 / 复盘都遵循「自己写了才解锁对方那段」，
 *    避免「等对方先写」的博弈。
 *
 * 订阅提醒（文档 7.18 末节）只在 `add` / `done` 落库成功后触发，且**绝不打断业务**：
 * 发送结果不影响出参，失败只留 `[growth-sub]` 日志（见 lib/growth-sub.js）。
 */

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const security = require('../lib/security');
const time = require('../lib/time');
const relation = require('../lib/relation');
const dbUtil = require('../lib/db-util');
const growthSub = require('../lib/growth-sub');

/** 五个分类：客户端常量 GROWTH_CATEGORIES 与这里双向一致（同 LEDGER_CATEGORIES 模式） */
const CATEGORIES = ['learn', 'sport', 'money', 'habit', 'other'];
/** 在档状态：这三态占「10 件」名额，archived 不占 */
const IN_FLIGHT = ['confirming', 'active', 'harvesting'];
const TITLE_MAX = 30;
const PART_MAX = 50;
const NOTE_MAX = 100;
/** 收获 / 复盘共用 100 字 */
const TEXT_MAX = 100;
/** 在档上限：10 件，够了才做得完 */
const IN_FLIGHT_MAX = 10;
const LOG_LIMIT_DEFAULT = 10;
const LOG_LIMIT_MAX = 20;
const TASK_ID_MAX = 64;
const CURSOR_SEP = '|';

function newTaskId() {
  return 'g_' + crypto.randomBytes(8).toString('hex');
}

function taskIdOf(p) {
  const id = typeof p.taskId === 'string' ? p.taskId.trim() : '';
  if (!id || id.length > TASK_ID_MAX) {
    throw new AppError('GROWTH_NOT_FOUND', '这件事找不到了');
  }
  return id;
}

async function add(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);

  // 空标题单独给 GROWTH_TITLE_REQUIRED（文案是产品定的「给这件事起个名字」），
  // 校验工具默认会报 INVALID_INPUT，所以先自己判一次空再交给 validate
  if (p.title === undefined || p.title === null || (typeof p.title === 'string' && !p.title.trim())) {
    throw new AppError('GROWTH_TITLE_REQUIRED', '给这件事起个名字');
  }
  const title = validate.string(p.title, { field: '这件事', max: TITLE_MAX });
  const category = validate.oneOf(p.category, CATEGORIES, '分类');
  const myPart = validate.string(p.myPart, { field: '我的部分', max: PART_MAX });
  const partnerPart = validate.string(p.partnerPart, { field: 'TA 的部分', max: PART_MAX });
  const note = validate.string(p.note, { field: '备注', max: NOTE_MAX });

  await security.assertText(ctx, title, 'forum');
  await security.assertText(ctx, myPart, 'social');
  await security.assertText(ctx, partnerPart, 'social');
  await security.assertText(ctx, note, 'social');

  const coupleId = relation.coupleIdOf(ctx);
  const cnt = await ctx.db.collection('growth_tasks')
    .where({ coupleId, status: ctx.db.command.in(IN_FLIGHT) })
    .count();
  if (cnt && cnt.total >= IN_FLIGHT_MAX) {
    throw new AppError('GROWTH_LIMIT_REACHED', '先把眼前的几件事做完吧');
  }

  const doc = {
    _id: newTaskId(),
    coupleId,
    createdBy: ctx.openid,
    title,
    category,
    // 起草者视角的 myPart 就是 creatorPart；落库后所有视角都由 viewOf 现算
    creatorPart: myPart,
    partnerPart,
    note,
    status: 'confirming',
    archivedType: null,
    creatorHarvest: null,
    partnerHarvest: null,
    creatorReview: null,
    partnerReview: null,
    createdAt: ctx.now,
    confirmedAt: null,
    doneAt: null,
    archivedAt: null,
    updatedAt: ctx.now,
  };
  const { _id, ...data } = doc;
  await ctx.db.collection('growth_tasks').add({ data: Object.assign({ _id }, data) });

  // 落库成功才提醒对方来认领（失败只记日志，不影响本次出参）
  await growthSub.notify(ctx, { kind: 'draft', toOpenid: relation.partnerOpenidOf(ctx) });

  return { task: viewOf(doc, ctx) };
}

async function confirm(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const taskId = taskIdOf(p);
  const coupleId = relation.coupleIdOf(ctx);

  let result = null;
  // 事务内重读：两人同时点「一起认领」时只会有一次真的把状态推过去
  await ctx.db.runTransaction(async (transaction) => {
    const doc = await txTask(transaction, taskId);
    if (!doc) throw new AppError('GROWTH_NOT_FOUND', '这件事找不到了');
    if (doc.coupleId !== coupleId) throw new AppError('FORBIDDEN', '这件事不属于你们');
    if (doc.createdBy === ctx.openid) {
      throw new AppError('GROWTH_STATE_INVALID', '这件事是你起草的，等 TA 认领');
    }
    if (doc.status !== 'confirming') {
      throw new AppError('GROWTH_STATE_INVALID', '这件事已经认领过了');
    }
    const next = { status: 'active', confirmedAt: ctx.now, updatedAt: ctx.now };
    await transaction.collection('growth_tasks').doc(taskId).update({ data: next });
    result = Object.assign({}, doc, next);
  });

  return { task: viewOf(result, ctx) };
}

async function update(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const taskId = taskIdOf(p);
  const doc = await loadOwned(ctx, taskId);

  if (doc.status !== 'confirming' && doc.status !== 'active') {
    throw new AppError('GROWTH_STATE_INVALID', '这件事现在改不了');
  }
  const mine = doc.createdBy === ctx.openid;
  const data = { updatedAt: ctx.now };
  let touched = false;

  if (p.title !== undefined && p.title !== null) {
    if (typeof p.title === 'string' && !p.title.trim()) {
      throw new AppError('GROWTH_TITLE_REQUIRED', '给这件事起个名字');
    }
    const title = validate.string(p.title, { field: '这件事', max: TITLE_MAX });
    await security.assertText(ctx, title, 'forum');
    data.title = title;
    touched = true;
  }
  if (p.category !== undefined && p.category !== null) {
    data.category = validate.oneOf(p.category, CATEGORIES, '分类');
    touched = true;
  }
  // 入参是「调用者视角」的 myPart / partnerPart，落库时按是不是起草者换成 creator* / partner*
  if (p.myPart !== undefined && p.myPart !== null) {
    const value = validate.string(p.myPart, { field: '我的部分', max: PART_MAX });
    await security.assertText(ctx, value, 'social');
    data[mine ? 'creatorPart' : 'partnerPart'] = value;
    touched = true;
  }
  if (p.partnerPart !== undefined && p.partnerPart !== null) {
    const value = validate.string(p.partnerPart, { field: 'TA 的部分', max: PART_MAX });
    await security.assertText(ctx, value, 'social');
    data[mine ? 'partnerPart' : 'creatorPart'] = value;
    touched = true;
  }
  if (p.note !== undefined && p.note !== null) {
    const value = validate.string(p.note, { field: '备注', max: NOTE_MAX });
    await security.assertText(ctx, value, 'social');
    data.note = value;
    touched = true;
  }
  if (!touched) throw new AppError('INVALID_INPUT', '至少改一个字段');

  await ctx.db.collection('growth_tasks').doc(taskId).update({ data });
  return { task: viewOf(Object.assign({}, doc, data, { _id: taskId }), ctx) };
}

async function remove(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const coupleId = relation.coupleIdOf(ctx);
  const raw = typeof p.taskId === 'string' ? p.taskId.trim() : '';
  // 删除是幂等操作：id 为空 / 超长同样按「不存在」返回，不报错
  if (!raw || raw.length > TASK_ID_MAX) return { removed: false };

  const doc = await readTaskDoc(ctx, raw);
  if (!doc) return { removed: false };
  if (doc.coupleId !== coupleId) throw new AppError('FORBIDDEN', '这件事不属于你们');
  if (doc.status === 'archived') {
    throw new AppError('GROWTH_STATE_INVALID', '成长日志是写完的历史，不删');
  }

  await ctx.db.collection('growth_tasks').doc(raw).remove();
  return { removed: true };
}

async function done(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const taskId = taskIdOf(p);
  const coupleId = relation.coupleIdOf(ctx);

  let result = null;
  let shouldNotify = false;
  // 事务内重读：两个人几乎同时点「完成了」时，只有第一次真的推进状态
  await ctx.db.runTransaction(async (transaction) => {
    const doc = await txTask(transaction, taskId);
    if (!doc) throw new AppError('GROWTH_NOT_FOUND', '这件事找不到了');
    if (doc.coupleId !== coupleId) throw new AppError('FORBIDDEN', '这件事不属于你们');
    if (doc.status === 'harvesting') {
      result = doc;                    // 幂等：已经在写收获了
      shouldNotify = false;            // 事务重试进来时也别把提醒再发一次
      return;
    }
    if (doc.status !== 'active') {
      throw new AppError('GROWTH_STATE_INVALID',
        doc.status === 'confirming' ? '这件事还没一起认领' : '这件事已经收进成长日志了');
    }
    const next = { status: 'harvesting', doneAt: ctx.now, updatedAt: ctx.now };
    await transaction.collection('growth_tasks').doc(taskId).update({ data: next });
    result = Object.assign({}, doc, next);
    shouldNotify = true;
  });

  // 只在真的从 active 推进到 harvesting 时提醒（幂等重复点不重复发）
  if (shouldNotify) {
    await growthSub.notify(ctx, { kind: 'done', toOpenid: relation.partnerOpenidOf(ctx) });
  }
  return { task: viewOf(result, ctx) };
}

async function harvest(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const taskId = taskIdOf(p);
  const text = validate.string(p.text, { field: '收获', max: TEXT_MAX });
  if (!text) throw new AppError('GROWTH_HARVEST_EMPTY', '写一句你们做到了什么');
  await security.assertText(ctx, text, 'social');
  const coupleId = relation.coupleIdOf(ctx);

  let result = null;
  let archived = false;
  // 事务内重读：双方几乎同时写最后两段时，后到者看到 archived(done) 按补写处理，不报错
  await ctx.db.runTransaction(async (transaction) => {
    const doc = await txTask(transaction, taskId);
    if (!doc) throw new AppError('GROWTH_NOT_FOUND', '这件事找不到了');
    if (doc.coupleId !== coupleId) throw new AppError('FORBIDDEN', '这件事不属于你们');

    const alreadyArchived = doc.status === 'archived' && doc.archivedType === 'done';
    if (doc.status !== 'harvesting' && !alreadyArchived) {
      throw new AppError('GROWTH_STATE_INVALID',
        doc.status === 'archived' ? '这件事是复盘收尾的，不能再补收获' : '这件事现在还不能写收获');
    }

    const mine = doc.createdBy === ctx.openid;
    const next = { updatedAt: ctx.now };
    next[mine ? 'creatorHarvest' : 'partnerHarvest'] = text;
    const merged = Object.assign({}, doc, next);

    // 双方都写了 → 自动归档（只在 harvesting 触发；已归档的走纯补写）
    if (doc.status === 'harvesting' && merged.creatorHarvest && merged.partnerHarvest) {
      next.status = 'archived';
      next.archivedType = 'done';
      next.archivedAt = ctx.now;
    }

    await transaction.collection('growth_tasks').doc(taskId).update({ data: next });
    result = Object.assign({}, merged, next);
    archived = result.status === 'archived';
  });

  return { task: viewOf(result, ctx), archived };
}

async function review(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const taskId = taskIdOf(p);
  const text = validate.string(p.text, { field: '复盘', max: TEXT_MAX });
  if (!text) throw new AppError('GROWTH_HARVEST_EMPTY', '写一句你想说的');
  await security.assertText(ctx, text, 'social');
  const coupleId = relation.coupleIdOf(ctx);

  let result = null;
  await ctx.db.runTransaction(async (transaction) => {
    const doc = await txTask(transaction, taskId);
    if (!doc) throw new AppError('GROWTH_NOT_FOUND', '这件事找不到了');
    if (doc.coupleId !== coupleId) throw new AppError('FORBIDDEN', '这件事不属于你们');
    if (doc.status === 'archived' && doc.archivedType === 'done') {
      throw new AppError('GROWTH_STATE_INVALID', '这件事是「一起完成」收尾的，不能再写复盘');
    }

    const mine = doc.createdBy === ctx.openid;
    const next = { updatedAt: ctx.now };
    next[mine ? 'creatorReview' : 'partnerReview'] = text;
    if (doc.status !== 'archived') {
      // 复盘不需要对方同意，也不写问题记录：写一句就算体面收尾
      next.status = 'archived';
      next.archivedType = 'reviewed';
      next.archivedAt = ctx.now;
    }
    await transaction.collection('growth_tasks').doc(taskId).update({ data: next });
    result = Object.assign({}, doc, next);
  });

  return { task: viewOf(result, ctx), archived: true };
}

async function list(payload, ctx) {
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);

  // 两个查询互不依赖：在档列表（≤10 条）+ 已归档计数
  const [res, archivedRes] = await Promise.all([
    ctx.db.collection('growth_tasks')
      .where({ coupleId, status: ctx.db.command.in(IN_FLIGHT) })
      .limit(IN_FLIGHT_MAX)
      .get(),
    ctx.db.collection('growth_tasks')
      .where({ coupleId, status: 'archived' })
      .count(),
  ]);
  const docs = (res && res.data) || [];

  // 等人的事最要紧：confirming 排前面，其余按起草时间升序
  const sorted = docs.slice().sort((a, b) => {
    const rank = (doc) => (doc.status === 'confirming' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return time.toMillis(a.createdAt) - time.toMillis(b.createdAt);
  });

  return {
    items: sorted.map((doc) => viewOf(doc, ctx)),
    stats: {
      inFlight: docs.length,
      awaitingConfirm: docs.filter((doc) => doc.status === 'confirming').length,
      archivedCount: (archivedRes && archivedRes.total) || 0,
    },
    // 订阅授权时机由客户端决定（文档 8.3.10）：额度低于 2 才弹，所以这里带上自己的额度。
    // templateId 不是秘密（requestSubscribeMessage 本来就要传），客户端不必再存一份
    subConfigured: growthSub.configured(),
    subQuota: growthSub.quotaOf(ctx.user),
    subQuotaMax: growthSub.QUOTA_MAX,
    subTemplateId: growthSub.templateId(),
  };
}

async function log(payload, ctx) {
  ctx.requireBound();
  const p = validate.asObject(payload);
  const limit = validate.integer(p.limit, {
    field: '分页条数', min: 1, max: LOG_LIMIT_MAX, defaultValue: LOG_LIMIT_DEFAULT,
  });
  const coupleId = relation.coupleIdOf(ctx);

  let cursor = null;
  if (p.cursor !== undefined && p.cursor !== null && p.cursor !== '') {
    cursor = parseCursor(p.cursor);
  }

  const where = { coupleId, status: 'archived' };
  if (cursor) where.archivedAt = ctx.db.command.lt(new Date(cursor.ms));

  // 同毫秒按 _id 倒序，保证复合游标翻页时顺序确定（同 safety.list 先例）
  const res = await ctx.db.collection('growth_tasks')
    .where(where)
    .orderBy('archivedAt', 'desc')
    .orderBy('_id', 'desc')
    .limit(limit)
    .get();
  let docs = (res && res.data) || [];

  // 边界同毫秒且 _id 更小的记录还没返回过，补一次等值查询拼到页首
  if (cursor && cursor.id) {
    const tieRes = await ctx.db.collection('growth_tasks')
      .where({ coupleId, status: 'archived', archivedAt: new Date(cursor.ms) })
      .orderBy('_id', 'desc')
      .limit(LOG_LIMIT_MAX)
      .get();
    const ties = ((tieRes && tieRes.data) || []).filter((doc) => String(doc._id) < cursor.id);
    if (ties.length) docs = ties.concat(docs).slice(0, limit);
  }

  const last = docs[docs.length - 1];
  const nextCursor = docs.length === limit && last
    ? relation.iso(last.archivedAt) + CURSOR_SEP + last._id
    : null;

  return { items: docs.map((doc) => logViewOf(doc, ctx)), nextCursor };
}

/** 读一条任务；只有「文档不存在」算 null，超时/权限等故障必须上抛（同 wish.readWishDoc） */
async function readTaskDoc(ctx, taskId) {
  try {
    const res = await ctx.db.collection('growth_tasks').doc(taskId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (dbUtil.isDocumentMissing(err)) return null;
    throw err;
  }
}

/** 事务内读同一份逻辑：不存在返回 null（不能把 -1 抛出去当业务错误） */
async function txTask(transaction, taskId) {
  try {
    const res = await transaction.collection('growth_tasks').doc(taskId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (dbUtil.isDocumentMissing(err)) return null;
    throw err;
  }
}

/** 读任务并校验归属：不存在 GROWTH_NOT_FOUND，属于别的情侣 FORBIDDEN */
async function loadOwned(ctx, taskId) {
  const doc = await readTaskDoc(ctx, taskId);
  if (!doc) throw new AppError('GROWTH_NOT_FOUND', '这件事找不到了');
  if (doc.coupleId !== relation.coupleIdOf(ctx)) {
    throw new AppError('FORBIDDEN', '这件事不属于你们');
  }
  return doc;
}

/** 游标格式：服务端生成 "archivedAtISO|_id"，客户端原样回传（同 safety.list） */
function parseCursor(raw) {
  const text = String(raw);
  const sep = text.lastIndexOf(CURSOR_SEP);
  const isoText = sep > 0 ? text.slice(0, sep) : text;
  const id = sep > 0 ? text.slice(sep + 1) : '';
  const ms = time.toMillis(isoText);
  if (!Number.isFinite(ms)) throw new AppError('INVALID_INPUT', '分页游标格式不对');
  return { ms, id };
}

/** 存储 → 出参的字段视角映射（文档 7.18 的表），客户端永远只认「我的 / TA 的」 */
function partsOf(doc, mine) {
  return {
    myPart: (mine ? doc.creatorPart : doc.partnerPart) || '',
    partnerPart: (mine ? doc.partnerPart : doc.creatorPart) || '',
  };
}

function harvestOf(doc, mine) {
  return (mine ? doc.creatorHarvest : doc.partnerHarvest) || '';
}

function reviewOf(doc, mine) {
  return (mine ? doc.creatorReview : doc.partnerReview) || '';
}

/** 任务池条目：只给「写没写」布尔位，不给正文（正文只在日志里出现） */
function viewOf(doc, ctx) {
  const mine = doc.createdBy === ctx.openid;
  const parts = partsOf(doc, mine);
  return {
    taskId: doc._id,
    title: doc.title || '',
    category: doc.category || 'other',
    myPart: parts.myPart,
    partnerPart: parts.partnerPart,
    note: doc.note || '',
    status: doc.status,
    archivedType: doc.archivedType || null,
    createdByMe: mine,
    createdAt: relation.iso(doc.createdAt),
    confirmedAt: relation.iso(doc.confirmedAt),
    doneAt: relation.iso(doc.doneAt),
    archivedAt: relation.iso(doc.archivedAt),
    myHarvestWritten: !!harvestOf(doc, mine),
    partnerHarvestWritten: !!harvestOf(doc, !mine),
    myReviewWritten: !!reviewOf(doc, mine),
    partnerReviewWritten: !!reviewOf(doc, !mine),
  };
}

/**
 * 成长日志条目：自己那段永远返回；对方那段只有自己写过才解锁正文，
 * 否则 `partnerText` 为 null 但 `partnerWritten` 为 true（客户端显示「TA 写了，你写完就能看」）。
 */
function logViewOf(doc, ctx) {
  const mine = doc.createdBy === ctx.openid;
  const done = doc.archivedType !== 'reviewed';
  const myText = done ? harvestOf(doc, mine) : reviewOf(doc, mine);
  const partnerText = done ? harvestOf(doc, !mine) : reviewOf(doc, !mine);
  const unlocked = !!myText;
  const parts = partsOf(doc, mine);
  return {
    taskId: doc._id,
    title: doc.title || '',
    category: doc.category || 'other',
    archivedType: done ? 'done' : 'reviewed',
    myPart: parts.myPart,
    partnerPart: parts.partnerPart,
    archivedAt: relation.iso(doc.archivedAt),
    myText: myText || null,
    partnerText: unlocked ? (partnerText || null) : null,
    partnerWritten: !!partnerText,
    partnerHarvestUnlocked: unlocked,
  };
}

module.exports = {
  add, confirm, update, remove, done, harvest, review, list, log,
  CATEGORIES, IN_FLIGHT, IN_FLIGHT_MAX, TITLE_MAX, PART_MAX, NOTE_MAX, TEXT_MAX,
  LOG_LIMIT_DEFAULT, LOG_LIMIT_MAX, viewOf, logViewOf,
};
