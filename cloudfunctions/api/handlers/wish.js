'use strict';

const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');
const relation = require('../lib/relation');
const dbUtil = require('../lib/db-util');

const TITLE_MAX = 30;
const NOTE_MAX = 100;
const WISH_MAX = 100;
const WISH_ID_MAX = 64;

function newWishId() {
  return 'w_' + crypto.randomBytes(8).toString('hex');
}

function publicWish(doc) {
  return {
    wishId: doc._id,
    title: doc.title || '',
    note: doc.note || '',
    createdBy: doc.createdBy,
    done: !!doc.done,
    doneBy: doc.doneBy || null,
    doneAt: doc.doneAt ? relation.iso(doc.doneAt) : null,
    createdAt: relation.iso(doc.createdAt),
    updatedAt: relation.iso(doc.updatedAt),
  };
}

/** 一次读全量（上限 100），统计实时算；未完成在前（createdAt 升序），完成在后（doneAt 降序） */
async function loadAll(ctx, coupleId) {
  const res = await ctx.db.collection('wishes')
    .where({ coupleId })
    .limit(WISH_MAX)
    .get();
  return (res && res.data) || [];
}

function sortWishes(docs) {
  const undone = docs.filter((doc) => !doc.done)
    .sort((a, b) => time.toMillis(a.createdAt) - time.toMillis(b.createdAt));
  const done = docs.filter((doc) => doc.done)
    .sort((a, b) => time.toMillis(b.doneAt || b.createdAt) - time.toMillis(a.doneAt || a.createdAt));
  return undone.concat(done);
}

function statsOf(docs) {
  return { total: docs.length, done: docs.filter((doc) => doc.done).length };
}

function wishIdOf(payload) {
  const id = typeof payload.wishId === 'string' ? payload.wishId.trim() : '';
  if (!id || id.length > WISH_ID_MAX) {
    throw new AppError('WISH_NOT_FOUND', '这个愿望找不到了');
  }
  return id;
}

/** 读一条愿望；只有「文档不存在」算 null，超时/权限等故障必须上抛（同 diary.save） */
async function readWishDoc(ctx, wishId) {
  try {
    const res = await ctx.db.collection('wishes').doc(wishId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (dbUtil.isDocumentMissing(err)) return null;
    throw err;
  }
}

/** 读愿望并校验归属：不存在就 WISH_NOT_FOUND，属于别的情侣 FORBIDDEN */
async function loadOwned(ctx, wishId) {
  const coupleId = relation.coupleIdOf(ctx);
  const doc = await readWishDoc(ctx, wishId);
  if (!doc) {
    throw new AppError('WISH_NOT_FOUND', '这个愿望找不到了');
  }
  if (doc.coupleId !== coupleId) {
    throw new AppError('FORBIDDEN', '这个愿望不属于你们');
  }
  return doc;
}

async function add(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const title = validate.string(p.title, {
    field: '愿望', min: 1, max: TITLE_MAX, required: true,
  });
  const note = validate.string(p.note, { field: '备注', max: NOTE_MAX });
  const coupleId = relation.coupleIdOf(ctx);

  const docs = await loadAll(ctx, coupleId);
  if (docs.length >= WISH_MAX) {
    throw new AppError('WISH_LIMIT_REACHED', '愿望太多啦，先完成几个吧');
  }

  const wishId = newWishId();
  await ctx.db.collection('wishes').doc(wishId).set({
    data: {
      coupleId,
      title,
      note,
      createdBy: ctx.openid,
      done: false,
      doneBy: null,
      doneAt: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    },
  });

  return {
    wish: publicWish({
      _id: wishId,
      title,
      note,
      createdBy: ctx.openid,
      done: false,
      doneBy: null,
      doneAt: null,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    }),
    stats: { total: docs.length + 1, done: docs.filter((doc) => doc.done).length },
  };
}

async function update(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();
  const wishId = wishIdOf(p);
  const doc = await loadOwned(ctx, wishId);

  const hasTitle = p.title !== undefined && p.title !== null;
  const hasNote = p.note !== undefined && p.note !== null;
  if (!hasTitle && !hasNote) {
    throw new AppError('INVALID_INPUT', '至少改一个字段');
  }
  const data = { updatedAt: ctx.now };
  if (hasTitle) {
    data.title = validate.string(p.title, {
      field: '愿望', min: 1, max: TITLE_MAX, required: true,
    });
  }
  if (hasNote) {
    data.note = validate.string(p.note, { field: '备注', max: NOTE_MAX });
  }

  await ctx.db.collection('wishes').doc(wishId).update({ data });
  return {
    wish: publicWish(Object.assign({}, doc, data, { _id: wishId })),
  };
}

async function setDone(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();
  const wishId = wishIdOf(p);
  const done = validate.boolean(p.done, '已完成');
  const doc = await loadOwned(ctx, wishId);

  const data = { done, updatedAt: ctx.now };
  if (done) {
    data.doneBy = doc.done && doc.doneBy ? doc.doneBy : ctx.openid;
    data.doneAt = doc.done && doc.doneAt ? doc.doneAt : ctx.now;
  } else {
    data.doneBy = null;
    data.doneAt = null;
  }
  await ctx.db.collection('wishes').doc(wishId).update({ data });

  const docs = await loadAll(ctx, relation.coupleIdOf(ctx));
  const fresh = docs.find((item) => item._id === wishId);
  return {
    wish: publicWish(fresh || Object.assign({}, doc, data, { _id: wishId })),
    stats: statsOf(docs),
  };
}

async function remove(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();
  const coupleId = relation.coupleIdOf(ctx);
  const wishId = typeof p.wishId === 'string' ? p.wishId.trim() : '';
  // 删除是幂等操作：id 为空/超长同样按「不存在」返回，不报错
  if (!wishId || wishId.length > WISH_ID_MAX) {
    return { removed: false, stats: statsOf(await loadAll(ctx, coupleId)) };
  }

  const doc = await readWishDoc(ctx, wishId);
  if (!doc) {
    return { removed: false, stats: statsOf(await loadAll(ctx, coupleId)) };
  }
  if (doc.coupleId !== coupleId) {
    throw new AppError('FORBIDDEN', '这个愿望不属于你们');
  }

  await ctx.db.collection('wishes').doc(wishId).remove();
  const docs = await loadAll(ctx, coupleId);
  return { removed: true, stats: statsOf(docs) };
}

async function list(payload, ctx) {
  ctx.requireBound();
  const docs = await loadAll(ctx, relation.coupleIdOf(ctx));
  return {
    items: sortWishes(docs).map(publicWish),
    stats: statsOf(docs),
  };
}

module.exports = { add, update, setDone, remove, list, TITLE_MAX, NOTE_MAX, WISH_MAX, sortWishes, statsOf };
