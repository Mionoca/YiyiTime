'use strict';

const test = require('node:test');
const assert = require('node:assert');

const wish = require('../cloudfunctions/api/handlers/wish');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z');
const WISH_ID_RE = /^w_[0-9a-f]{16}$/;

function wishDoc(overrides) {
  return Object.assign({
    coupleId: 'c_1',
    title: '去看海',
    note: '',
    createdBy: 'oA',
    done: false,
    doneBy: null,
    doneAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }, overrides);
}

function makeCtx({ openid = 'oA', bound = true, data = {} } = {}) {
  const fake = makeFakeDb(data);
  const partnerOpenid = openid === 'oA' ? 'oB' : 'oA';
  return {
    fake,
    ctx: {
      openid,
      user: { _id: openid, nickname: '', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      partner: { _id: partnerOpenid },
      db: fake.db,
      now: NOW,
      requireBound() {
        if (!bound) {
          const err = new Error('还没有绑定');
          err.code = 'NOT_BOUND';
          throw err;
        }
      },
    },
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.strictEqual(err.code, code);
    return true;
  });
}

test('wish.add: 新增愿望返回约定字段与实时统计', async () => {
  const { ctx, fake } = makeCtx();
  const res = await wish.add({ title: '  去看海  ', note: '  带上相机  ' }, ctx);

  assert.match(res.wish.wishId, WISH_ID_RE);
  assert.deepStrictEqual(res.wish, {
    wishId: res.wish.wishId,
    title: '去看海',
    note: '带上相机',
    createdBy: 'oA',
    done: false,
    doneBy: null,
    doneAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });
  assert.deepStrictEqual(res.stats, { total: 1, done: 0 });

  const doc = fake.get('wishes', res.wish.wishId);
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(doc.title, '去看海');
  assert.strictEqual(doc.done, false);
});

test('wish.add: 标题/备注参数校验', async () => {
  const { ctx } = makeCtx();
  await expectCode(wish.add({}, ctx), 'INVALID_INPUT');
  await expectCode(wish.add({ title: '   ' }, ctx), 'INVALID_INPUT');
  await expectCode(wish.add({ title: 'x'.repeat(31) }, ctx), 'TEXT_TOO_LONG');
  await expectCode(wish.add({ title: 'ok', note: 'x'.repeat(101) }, ctx), 'TEXT_TOO_LONG');
  await expectCode(wish.add({ title: 123 }, ctx), 'INVALID_INPUT');
});

test('wish.add: 每对最多 100 条，达到上限报 WISH_LIMIT_REACHED', async () => {
  const docs = [];
  for (let i = 1; i <= 100; i += 1) {
    docs.push(Object.assign({ _id: 'w_' + String(i).padStart(16, '0') }, wishDoc({ title: '愿望' + i })));
  }
  const { ctx, fake } = makeCtx({ data: { wishes: docs } });
  await expectCode(wish.add({ title: '第 101 条' }, ctx), 'WISH_LIMIT_REACHED');
  assert.strictEqual(fake.all('wishes').length, 100);
});

test('wish.update: 双方都能改，只写传入字段', async () => {
  const { ctx, fake } = makeCtx({
    openid: 'oB',
    data: { wishes: [Object.assign({ _id: 'w_1' }, wishDoc({ title: '旧标题', note: '旧备注' }))] },
  });
  const res = await wish.update({ wishId: 'w_1', title: '新标题' }, ctx);
  assert.strictEqual(res.wish.title, '新标题');
  assert.strictEqual(res.wish.note, '旧备注');
  assert.strictEqual(res.wish.updatedAt, NOW.toISOString());

  const doc = fake.get('wishes', 'w_1');
  assert.strictEqual(doc.title, '新标题');
  assert.strictEqual(doc.note, '旧备注');
});

test('wish.update: 至少改一个字段 / 不存在 / 越权 / 校验', async () => {
  const { ctx } = makeCtx({
    data: {
      wishes: [
        Object.assign({ _id: 'w_1' }, wishDoc({})),
        Object.assign({ _id: 'w_other' }, wishDoc({ coupleId: 'c_2' })),
      ],
    },
  });
  await expectCode(wish.update({ wishId: 'w_1' }, ctx), 'INVALID_INPUT');
  await expectCode(wish.update({ wishId: 'w_missing', title: 'x' }, ctx), 'WISH_NOT_FOUND');
  await expectCode(wish.update({ wishId: 'w_other', title: 'x' }, ctx), 'FORBIDDEN');
  await expectCode(wish.update({ wishId: 'w_1', title: '  ' }, ctx), 'INVALID_INPUT');
  await expectCode(wish.update({ wishId: 'w_1', note: 'x'.repeat(101) }, ctx), 'TEXT_TOO_LONG');
});

test('wish.setDone: 完成写 doneBy/doneAt，取消后清空，统计实时更新', async () => {
  const { ctx, fake } = makeCtx({
    data: { wishes: [Object.assign({ _id: 'w_1' }, wishDoc({}))] },
  });

  const done = await wish.setDone({ wishId: 'w_1', done: true }, ctx);
  assert.strictEqual(done.wish.done, true);
  assert.strictEqual(done.wish.doneBy, 'oA');
  assert.strictEqual(done.wish.doneAt, NOW.toISOString());
  assert.deepStrictEqual(done.stats, { total: 1, done: 1 });
  assert.strictEqual(fake.get('wishes', 'w_1').doneBy, 'oA');

  const undone = await wish.setDone({ wishId: 'w_1', done: false }, ctx);
  assert.strictEqual(undone.wish.done, false);
  assert.strictEqual(undone.wish.doneBy, null);
  assert.strictEqual(undone.wish.doneAt, null);
  assert.deepStrictEqual(undone.stats, { total: 1, done: 0 });
});

test('wish.setDone: 重复完成幂等，保留第一次的 doneBy/doneAt', async () => {
  const firstDoneAt = new Date('2026-11-15T02:00:00.000Z');
  const { ctx } = makeCtx({
    data: {
      wishes: [Object.assign({ _id: 'w_1' }, wishDoc({
        done: true, doneBy: 'oB', doneAt: firstDoneAt,
      }))],
    },
  });
  const res = await wish.setDone({ wishId: 'w_1', done: true }, ctx);
  assert.strictEqual(res.wish.doneBy, 'oB');
  assert.strictEqual(res.wish.doneAt, firstDoneAt.toISOString());
});

test('wish.setDone: 参数与归属校验', async () => {
  const { ctx } = makeCtx({
    data: {
      wishes: [
        Object.assign({ _id: 'w_1' }, wishDoc({})),
        Object.assign({ _id: 'w_other' }, wishDoc({ coupleId: 'c_2' })),
      ],
    },
  });
  await expectCode(wish.setDone({ wishId: 'w_1' }, ctx), 'INVALID_INPUT');
  await expectCode(wish.setDone({ wishId: 'w_missing', done: true }, ctx), 'WISH_NOT_FOUND');
  await expectCode(wish.setDone({ wishId: 'w_other', done: true }, ctx), 'FORBIDDEN');
});

test('wish.remove: 物理删除并返回最新统计', async () => {
  const { ctx, fake } = makeCtx({
    data: {
      wishes: [
        Object.assign({ _id: 'w_1' }, wishDoc({})),
        Object.assign({ _id: 'w_2' }, wishDoc({ done: true, doneBy: 'oA', doneAt: NOW })),
      ],
    },
  });
  const res = await wish.remove({ wishId: 'w_1' }, ctx);
  assert.deepStrictEqual(res, { removed: true, stats: { total: 1, done: 1 } });
  assert.strictEqual(fake.get('wishes', 'w_1'), undefined);
});

test('wish.remove: 不存在/空 id 幂等返回 removed:false，别的情侣 FORBIDDEN', async () => {
  const { ctx } = makeCtx({
    data: {
      wishes: [Object.assign({ _id: 'w_other' }, wishDoc({ coupleId: 'c_2' }))],
    },
  });
  const missing = await wish.remove({ wishId: 'w_missing' }, ctx);
  assert.strictEqual(missing.removed, false);
  assert.deepStrictEqual(missing.stats, { total: 0, done: 0 });

  const empty = await wish.remove({}, ctx);
  assert.strictEqual(empty.removed, false);

  await expectCode(wish.remove({ wishId: 'w_other' }, ctx), 'FORBIDDEN');
});

test('wish.list: 未完成在前（createdAt 升序），完成在后（doneAt 降序），只含本 couple', async () => {
  const early = new Date('2026-11-10T01:00:00.000Z');
  const late = new Date('2026-11-12T01:00:00.000Z');
  const { ctx } = makeCtx({
    data: {
      wishes: [
        Object.assign({ _id: 'w_done_old' }, wishDoc({
          title: '完成早', done: true, doneBy: 'oA', doneAt: new Date('2026-11-11T01:00:00.000Z'),
        })),
        Object.assign({ _id: 'w_undone_late' }, wishDoc({ title: '未完成晚', createdAt: late })),
        Object.assign({ _id: 'w_done_new' }, wishDoc({
          title: '完成晚', done: true, doneBy: 'oA', doneAt: new Date('2026-11-14T01:00:00.000Z'),
        })),
        Object.assign({ _id: 'w_undone_early' }, wishDoc({ title: '未完成早', createdAt: early })),
        Object.assign({ _id: 'w_other' }, wishDoc({ coupleId: 'c_2', title: '别人家的' })),
      ],
    },
  });
  const res = await wish.list({}, ctx);
  assert.deepStrictEqual(
    res.items.map((item) => item.title),
    ['未完成早', '未完成晚', '完成晚', '完成早'],
  );
  assert.deepStrictEqual(res.stats, { total: 4, done: 2 });
});

test('wish: 读库故障必须上抛，不能当愿望不存在（避免误删/误判）', async () => {
  const { ctx, fake } = makeCtx({
    data: { wishes: [Object.assign({ _id: 'w_1' }, wishDoc())] },
  });
  const realCollection = fake.db.collection.bind(fake.db);
  ctx.db = Object.assign({}, fake.db, {
    collection(name) {
      const col = realCollection(name);
      if (name !== 'wishes') return col;
      return Object.assign({}, col, {
        doc(id) {
          const target = col.doc(id);
          return Object.assign({}, target, {
            get() {
              return Promise.reject(new Error('database request timeout'));
            },
          });
        },
      });
    },
  });

  // 原样上抛给入口层（入口统一包成 INTERNAL_ERROR，见 cloudfunctions/api/index.js）
  await assert.rejects(wish.update({ wishId: 'w_1', title: '改个名字' }, ctx), /database request timeout/);
  await assert.rejects(wish.remove({ wishId: 'w_1' }, ctx), /database request timeout/);

  // 故障不能导致数据被删：愿望仍在列表里
  const res = await wish.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.title), ['去看海']);
});

test('wish: 未绑定报 NOT_BOUND', async () => {
  const { ctx } = makeCtx({ bound: false });
  await expectCode(wish.add({ title: 'x' }, ctx), 'NOT_BOUND');
  await expectCode(wish.list({}, ctx), 'NOT_BOUND');
  await expectCode(wish.remove({ wishId: 'w_1' }, ctx), 'NOT_BOUND');
});
