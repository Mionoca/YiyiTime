'use strict';

const test = require('node:test');
const assert = require('node:assert');

const diary = require('../cloudfunctions/api/handlers/diary');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 2026-11-16 12:00
const TODAY = '2026-11-16';
const UNLOCK_TODAY = '2026-11-16T16:00:00.000Z'; // 东八区 2026-11-17 00:00

function dayDoc({ id, author, date, content, unlockAt }) {
  return {
    _id: id,
    coupleId: 'c_1',
    authorOpenid: author,
    date,
    content,
    unlockAt: new Date(unlockAt),
    createdAt: new Date(unlockAt),
    updatedAt: new Date(unlockAt),
  };
}

function makeCtx({ bound = true, data = {} } = {}) {
  const fake = makeFakeDb(data);
  return {
    fake,
    ctx: {
      openid: 'oA',
      user: { _id: 'oA', nickname: '阿怡', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      partner: { _id: 'oB', nickname: '小怡' },
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

test('diary.save: 首次写日记按 openid_date 建档，unlockAt 为次日 00:00', async () => {
  const { ctx, fake } = makeCtx();
  const res = await diary.save({ content: '  今天也想你  ' }, ctx);

  assert.deepStrictEqual(res, {
    diary: {
      date: TODAY,
      content: '今天也想你',
      unlockAt: UNLOCK_TODAY,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  });
  const doc = fake.get('diaries', 'oA_' + TODAY);
  assert.ok(doc, '应按 _id=openid_date 建档');
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(doc.authorOpenid, 'oA');
  assert.strictEqual(doc.content, '今天也想你');
  assert.strictEqual(doc.unlockAt.toISOString(), UNLOCK_TODAY);
});

test('diary.save: 同一天再写是更新，createdAt 不变', async () => {
  const createdAt = new Date('2026-11-16T01:00:00.000Z');
  const { ctx, fake } = makeCtx({
    data: {
      diaries: [{
        _id: 'oA_' + TODAY,
        coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: '草稿',
        unlockAt: new Date(UNLOCK_TODAY), createdAt, updatedAt: createdAt,
      }],
    },
  });
  const res = await diary.save({ content: '改好了' }, ctx);
  assert.strictEqual(res.diary.content, '改好了');
  assert.strictEqual(res.diary.createdAt, createdAt.toISOString());
  assert.strictEqual(res.diary.updatedAt, NOW.toISOString());

  const rows = fake.all('diaries');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, '改好了');
  assert.strictEqual(rows[0].updatedAt.getTime(), NOW.getTime());
});

test('diary.save: 已过解锁时刻不允许再改（DIARY_LOCKED）', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [{
        _id: 'oA_' + TODAY,
        coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: '昨天的',
        unlockAt: new Date(NOW.getTime() - 1000),
        createdAt: new Date(NOW.getTime() - 1000),
        updatedAt: new Date(NOW.getTime() - 1000),
      }],
    },
  });
  await expectCode(diary.save({ content: '想改' }, ctx), 'DIARY_LOCKED');
});

test('diary.save: 读库故障必须上抛，不能当成文档不存在覆盖旧日记', async () => {
  const { ctx, fake } = makeCtx();
  const realDb = fake.db;
  ctx.db = {
    collection(name) {
      const real = realDb.collection(name);
      if (name !== 'diaries') return real;
      return {
        doc(id) {
          const target = real.doc(id);
          return {
            // 模拟网络超时：没有 errCode=-1、文案也不含 not exist
            async get() { throw new Error('database request timeout'); },
            async set(args) { return target.set(args); },
            async update(args) { return target.update(args); },
          };
        },
      };
    },
    command: realDb.command,
  };

  await assert.rejects(diary.save({ content: '今天也想你' }, ctx), /timeout/);
  assert.strictEqual(fake.all('diaries').length, 0, '读失败时不应写入新文档');
});

test('diary.save: 内容校验（空/全空格/超长/非字符串）与未绑定', async () => {
  const { ctx } = makeCtx();
  await expectCode(diary.save({ content: '' }, ctx), 'DIARY_EMPTY');
  await expectCode(diary.save({ content: '   ' }, ctx), 'DIARY_EMPTY');
  await expectCode(diary.save({}, ctx), 'DIARY_EMPTY');
  await expectCode(diary.save({ content: 'x'.repeat(201) }, ctx), 'TEXT_TOO_LONG');
  await expectCode(diary.save({ content: 123 }, ctx), 'INVALID_INPUT');

  const unbound = makeCtx({ bound: false }).ctx;
  await expectCode(diary.save({ content: '你好' }, unbound), 'NOT_BOUND');
});

test('diary.list: 只有我写过的旧日记 partnerUnlocked 仍为 false（未写不算解锁）', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        dayDoc({ id: 'oA_2026-11-14', author: 'oA', date: '2026-11-14', content: '那天的我', unlockAt: '2026-11-15T16:00:00.000Z' }),
      ],
    },
  });
  const res = await diary.list({}, ctx);
  assert.strictEqual(res.items[0].partnerWritten, false);
  assert.strictEqual(res.items[0].partnerUnlocked, false);
  assert.strictEqual(res.items[0].partner, null);
});

test('diary.list: 按天合并倒序，当天对方的正文被裁剪，只给 partnerWritten/partnerUnlocked', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        // 干扰项：别的 couple 同一天
        {
          _id: 'oC_' + TODAY, coupleId: 'c_2', authorOpenid: 'oC', date: TODAY, content: '别人',
          unlockAt: new Date(UNLOCK_TODAY), createdAt: NOW, updatedAt: NOW,
        },
        dayDoc({
          id: 'oA_' + TODAY, author: 'oA', date: TODAY, content: '今天我的',
          unlockAt: UNLOCK_TODAY,
        }),
        dayDoc({
          id: 'oB_' + TODAY, author: 'oB', date: TODAY, content: '今天 TA 的',
          unlockAt: UNLOCK_TODAY,
        }),
        dayDoc({
          id: 'oA_2026-11-15', author: 'oA', date: '2026-11-15', content: '昨天我的',
          unlockAt: '2026-11-15T16:00:00.000Z',
        }),
        dayDoc({
          id: 'oB_2026-11-15', author: 'oB', date: '2026-11-15', content: '昨天 TA 的',
          unlockAt: '2026-11-15T16:00:00.000Z',
        }),
        dayDoc({
          id: 'oB_2026-11-14', author: 'oB', date: '2026-11-14', content: '前天 TA 的',
          unlockAt: '2026-11-14T16:00:00.000Z',
        }),
      ],
    },
  });
  const res = await diary.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.date), [TODAY, '2026-11-15', '2026-11-14']);
  assert.deepStrictEqual(res.items[0], {
    date: TODAY,
    unlockAt: UNLOCK_TODAY,
    mine: { content: '今天我的', updatedAt: UNLOCK_TODAY },
    partnerWritten: true,
    partnerUnlocked: false,
    partner: null,
  });
  assert.deepStrictEqual(res.items[1], {
    date: '2026-11-15',
    unlockAt: '2026-11-15T16:00:00.000Z',
    mine: { content: '昨天我的', updatedAt: '2026-11-15T16:00:00.000Z' },
    partnerWritten: true,
    partnerUnlocked: true,
    partner: { content: '昨天 TA 的', updatedAt: '2026-11-15T16:00:00.000Z' },
  });
  // 只有对方写了的那天：mine 为 null，对方已解锁可见
  assert.strictEqual(res.items[2].mine, null);
  assert.strictEqual(res.items[2].partner.content, '前天 TA 的');
  assert.strictEqual(res.nextBeforeDate, null);
});

test('diary.list: 分页按天，beforeDate 不重复不丢', async () => {
  const rows = [];
  ['2026-11-16', '2026-11-15', '2026-11-14'].forEach((date) => {
    const unlockAt = date === TODAY ? UNLOCK_TODAY : date + 'T16:00:00.000Z';
    rows.push(dayDoc({ id: 'oA_' + date, author: 'oA', date, content: date, unlockAt }));
  });
  const { ctx } = makeCtx({ data: { diaries: rows } });

  const first = await diary.list({ limit: 2 }, ctx);
  assert.deepStrictEqual(first.items.map((item) => item.date), ['2026-11-16', '2026-11-15']);
  assert.strictEqual(first.nextBeforeDate, '2026-11-15');

  const second = await diary.list({ limit: 2, beforeDate: first.nextBeforeDate }, ctx);
  assert.deepStrictEqual(second.items.map((item) => item.date), ['2026-11-14']);
  assert.strictEqual(second.nextBeforeDate, null);
});

test('diary.list: beforeDate 过滤与参数校验', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        dayDoc({ id: 'oA_2026-11-15', author: 'oA', date: '2026-11-15', content: 'a', unlockAt: '2026-11-15T16:00:00.000Z' }),
        dayDoc({ id: 'oA_2026-11-14', author: 'oA', date: '2026-11-14', content: 'b', unlockAt: '2026-11-14T16:00:00.000Z' }),
      ],
    },
  });
  const res = await diary.list({ beforeDate: '2026-11-15' }, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.date), ['2026-11-14']);
  await expectCode(diary.list({ beforeDate: '2026-13-01' }, ctx), 'INVALID_INPUT');
  await expectCode(diary.list({ limit: 0 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.list({ limit: 31 }, ctx), 'INVALID_INPUT');
});

test('diary.list: 未绑定报 NOT_BOUND', async () => {
  const { ctx } = makeCtx({ bound: false });
  await expectCode(diary.list({}, ctx), 'NOT_BOUND');
});
