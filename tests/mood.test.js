'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { set } = require('../cloudfunctions/api/handlers/mood');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 12:00
const TODAY = '2026-11-16';

function makeCtx({ bound = true, moods = [] } = {}) {
  const fake = makeFakeDb({ moods });
  return {
    ctx: {
      openid: 'oA',
      user: { _id: 'oA', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      partner: { _id: 'oB' },
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
    fake,
  };
}

test('mood.set: 首次打卡按 openid_date 建档并返回约定字段', async () => {
  const { ctx, fake } = makeCtx();
  const res = await set({ mood: 'rainy', note: '今天有点累' }, ctx);

  assert.deepStrictEqual(res, {
    mood: {
      mood: 'rainy',
      note: '今天有点累',
      date: TODAY,
      updatedAt: NOW.toISOString(),
    },
  });
  const doc = fake.get('moods', 'oA_' + TODAY);
  assert.ok(doc, '应按 _id=openid_date 建档');
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(doc.openid, 'oA');
  assert.strictEqual(doc.mood, 'rainy');
  assert.strictEqual(doc.note, '今天有点累');
  assert.ok(doc.createdAt instanceof Date);
  assert.ok(doc.updatedAt instanceof Date);
});

test('mood.set: 同一天重复打卡是更新，不新增', async () => {
  const { ctx, fake } = makeCtx({
    moods: [{
      _id: 'oA_' + TODAY,
      coupleId: 'c_1',
      openid: 'oA',
      date: TODAY,
      mood: 'sunny',
      note: '早',
      createdAt: new Date('2026-11-16T01:00:00.000Z'),
      updatedAt: new Date('2026-11-16T01:00:00.000Z'),
    }],
  });
  await set({ mood: 'thunder', note: '后来打雷了' }, ctx);

  assert.strictEqual(fake.all('moods').length, 1);
  const doc = fake.get('moods', 'oA_' + TODAY);
  assert.strictEqual(doc.mood, 'thunder');
  assert.strictEqual(doc.note, '后来打雷了');
  assert.strictEqual(doc.createdAt.toISOString(), '2026-11-16T01:00:00.000Z');
  assert.strictEqual(doc.updatedAt.toISOString(), NOW.toISOString());
});

test('mood.set: note 可省略 / 空白，统一存空串', async () => {
  const { ctx, fake } = makeCtx();
  await set({ mood: 'sunny' }, ctx);
  assert.strictEqual(fake.get('moods', 'oA_' + TODAY).note, '');

  const { ctx: ctx2, fake: fake2 } = makeCtx();
  await set({ mood: 'sunny', note: '   ' }, ctx2);
  assert.strictEqual(fake2.get('moods', 'oA_' + TODAY).note, '');
});

test('mood.set: 备注超过 50 字返回 TEXT_TOO_LONG', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(
    () => set({ mood: 'sunny', note: '字'.repeat(51) }, ctx),
    (err) => err.code === 'TEXT_TOO_LONG',
  );
});

test('mood.set: 非法心情返回 INVALID_INPUT', async () => {
  for (const mood of [undefined, '', 'happy', null, 1]) {
    const { ctx } = makeCtx();
    await assert.rejects(
      () => set({ mood }, ctx),
      (err) => err.code === 'INVALID_INPUT',
      'mood=' + String(mood),
    );
  }
});

test('mood.set: 未绑定返回 NOT_BOUND 且不写库', async () => {
  const { ctx, fake } = makeCtx({ bound: false });
  await assert.rejects(
    () => set({ mood: 'sunny' }, ctx),
    (err) => err.code === 'NOT_BOUND',
  );
  assert.strictEqual(fake.all('moods').length, 0);
});

test('mood.set: 数据库读失败向上抛，不当成没打过卡覆盖新建（createdAt 不丢）', async () => {
  const { ctx } = makeCtx();
  ctx.db = {
    collection: () => ({
      doc: () => ({
        get: async () => {
          const err = new Error('network down');
          err.errCode = -501001;
          throw err;
        },
      }),
    }),
  };
  await assert.rejects(() => set({ mood: 'sunny' }, ctx), /network down/);
});

test('mood.set: 更新分支同步刷新 coupleId（解绑再换绑的极端场景）', async () => {
  const { ctx, fake } = makeCtx({
    moods: [{
      _id: 'oA_' + TODAY,
      coupleId: 'c_old',
      openid: 'oA',
      date: TODAY,
      mood: 'sunny',
      note: '',
      createdAt: new Date('2026-11-16T01:00:00.000Z'),
      updatedAt: new Date('2026-11-16T01:00:00.000Z'),
    }],
  });
  await set({ mood: 'cloudy' }, ctx);
  assert.strictEqual(fake.get('moods', 'oA_' + TODAY).coupleId, 'c_1');
});

test('mood.set: 忽略客户端传的 date，日期一律用服务端 todayKey', async () => {
  const { ctx, fake } = makeCtx();
  const res = await set({ mood: 'cloudy', date: '1999-01-01' }, ctx);
  assert.strictEqual(res.mood.date, TODAY);
  assert.ok(fake.get('moods', 'oA_' + TODAY));
});
