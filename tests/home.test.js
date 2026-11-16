'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { loadMood, loadHug, optionalBlock } = require('../cloudfunctions/api/lib/home-blocks');
const homeHandler = require('../cloudfunctions/api/handlers/home');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z');
const TODAY = '2026-11-16';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function makeCtx(initial) {
  const fake = makeFakeDb(initial);
  return {
    ctx: {
      openid: 'oA',
      user: { _id: 'oA', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      db: fake.db,
      now: NOW,
    },
    fake,
  };
}

test('loadMood: 两人都打卡时返回各自心情与 ISO 时间（剔除别的 couple 与昨天的记录）', async () => {
  const { ctx } = makeCtx({
    // 干扰项排在前面：别的 couple 今天的、本 couple 昨天的；limit(2) 下若漏过滤会取错
    moods: [
      { _id: 'oA_2026-11-15', coupleId: 'c_1', openid: 'oA', date: '2026-11-15', mood: 'cloudy', note: '昨天' },
      { _id: 'oA_' + TODAY, coupleId: 'c_2', openid: 'oA', date: TODAY, mood: 'thunder', note: '别人家的' },
      { _id: 'oA_' + TODAY + '_real', coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny', note: '', updatedAt: new Date('2026-11-16T01:20:00.000Z') },
      { _id: 'oB_' + TODAY, coupleId: 'c_1', openid: 'oB', date: TODAY, mood: 'rainy', note: '今天有点累', updatedAt: new Date('2026-11-16T02:10:00.000Z') },
    ],
  });
  const res = await loadMood(ctx, 'c_1', TODAY, 'oB');

  assert.deepStrictEqual(res, {
    mine: { mood: 'sunny', note: '', updatedAt: '2026-11-16T01:20:00.000Z' },
    partner: { mood: 'rainy', note: '今天有点累', updatedAt: '2026-11-16T02:10:00.000Z' },
  });
});

test('loadMood: 没打卡的一方为 null（跨天回到未打卡）', async () => {
  const { ctx } = makeCtx({
    moods: [
      { _id: 'oB_' + TODAY, coupleId: 'c_1', openid: 'oB', date: TODAY, mood: 'cloudy', note: '', updatedAt: NOW },
    ],
  });
  const res = await loadMood(ctx, 'c_1', TODAY, 'oB');
  assert.strictEqual(res.mine, null);
  assert.strictEqual(res.partner.mood, 'cloudy');
});

test('loadMood: 两人都没打卡时都返回 null', async () => {
  const { ctx } = makeCtx();
  const res = await loadMood(ctx, 'c_1', TODAY, 'oB');
  assert.deepStrictEqual(res, { mine: null, partner: null });
});

test('loadHug: 有效 incoming 与最近 outgoing（pending），只在发给我的 pending 里选', async () => {
  const { ctx } = makeCtx({
    hugs: [
      // 干扰项：更新但不是发给我的 / 是发给我的但属于别的 couple
      {
        _id: 'h_other_to', coupleId: 'c_1', fromOpenid: 'oB', toOpenid: 'oC', status: 'pending',
        createdAt: new Date(NOW.getTime() - 60 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
      {
        _id: 'h_other_couple', coupleId: 'c_2', fromOpenid: 'oX', toOpenid: 'oA', status: 'pending',
        createdAt: new Date(NOW.getTime() - 30 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
      {
        _id: 'h_in', coupleId: 'c_1', fromOpenid: 'oB', toOpenid: 'oA', status: 'pending',
        createdAt: new Date(NOW.getTime() - 3600 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
      {
        _id: 'h_out', coupleId: 'c_1', fromOpenid: 'oA', toOpenid: 'oB', status: 'pending',
        createdAt: new Date(NOW.getTime() - 7200 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
    ],
  });
  const res = await loadHug(ctx, 'c_1');
  assert.deepStrictEqual(res.incoming, {
    hugId: 'h_in',
    createdAt: new Date(NOW.getTime() - 3600 * 1000).toISOString(),
    expiresAt: new Date(NOW.getTime() + WEEK_MS).toISOString(),
  });
  assert.deepStrictEqual(res.outgoing, {
    hugId: 'h_out',
    status: 'pending',
    createdAt: new Date(NOW.getTime() - 7200 * 1000).toISOString(),
    respondedAt: null,
    expiresAt: new Date(NOW.getTime() + WEEK_MS).toISOString(),
  });
});

test('loadHug: 过期 incoming 不返回并惰性置 expired', async () => {
  const { ctx, fake } = makeCtx({
    hugs: [
      {
        _id: 'h_old', coupleId: 'c_1', fromOpenid: 'oB', toOpenid: 'oA', status: 'pending',
        createdAt: new Date(NOW.getTime() - 9 * 24 * 3600 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000),
      },
    ],
  });
  const res = await loadHug(ctx, 'c_1');
  assert.strictEqual(res.incoming, null);
  assert.strictEqual(fake.get('hugs', 'h_old').status, 'expired');
});

test('loadHug: outgoing 取最近一条（已回应 hugged），respondedAt 为 ISO', async () => {
  const respondedAt = new Date('2026-11-16T03:00:00.000Z');
  const { ctx } = makeCtx({
    hugs: [
      {
        _id: 'h_old', coupleId: 'c_1', fromOpenid: 'oA', toOpenid: 'oB', status: 'hugged',
        createdAt: new Date(NOW.getTime() - 10 * 3600 * 1000), respondedAt,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
      {
        _id: 'h_new', coupleId: 'c_1', fromOpenid: 'oA', toOpenid: 'oB', status: 'hugged',
        createdAt: new Date(NOW.getTime() - 3600 * 1000), respondedAt,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
    ],
  });
  const res = await loadHug(ctx, 'c_1');
  assert.strictEqual(res.outgoing.hugId, 'h_new');
  assert.strictEqual(res.outgoing.status, 'hugged');
  assert.strictEqual(res.outgoing.respondedAt, respondedAt.toISOString());
});

test('loadHug: outgoing 过期 pending 在响应里是 expired 并写回库', async () => {
  const { ctx, fake } = makeCtx({
    hugs: [
      {
        _id: 'h_stale', coupleId: 'c_1', fromOpenid: 'oA', toOpenid: 'oB', status: 'pending',
        createdAt: new Date(NOW.getTime() - 9 * 24 * 3600 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() - 2 * 24 * 3600 * 1000),
      },
    ],
  });
  const res = await loadHug(ctx, 'c_1');
  assert.strictEqual(res.outgoing.status, 'expired');
  assert.strictEqual(fake.get('hugs', 'h_stale').status, 'expired');
});

test('loadHug: 没有记录时两块都是 null', async () => {
  const { ctx } = makeCtx();
  const res = await loadHug(ctx, 'c_1');
  assert.deepStrictEqual(res, { incoming: null, outgoing: null });
});

test('optionalBlock: 查询失败时返回 null 而不是抛错', async () => {
  const { ctx } = makeCtx();
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await optionalBlock(ctx, 'mood', async () => {
      throw new Error('mock db down');
    });
    assert.strictEqual(res, null);
  } finally {
    console.error = originalError;
  }
});

test('home.get: 已绑定返回 mood/hug 真实聚合，safety/diary/wish 仍为 null', async () => {
  const { ctx } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }, { _id: 'oB', nickname: '小怡' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    moods: [
      { _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny', note: '', updatedAt: NOW },
      { _id: 'oB_' + TODAY, coupleId: 'c_1', openid: 'oB', date: TODAY, mood: 'cloudy', note: '想抱抱', updatedAt: NOW },
    ],
    hugs: [
      {
        _id: 'h_in', coupleId: 'c_1', fromOpenid: 'oB', toOpenid: 'oA', status: 'pending',
        createdAt: new Date(NOW.getTime() - 3600 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
    ],
  });
  ctx.user = { _id: 'oA', coupleId: 'c_1' };
  ctx.couple = { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' };
  ctx.partner = { _id: 'oB', nickname: '小怡' };

  const res = await homeHandler.get({}, ctx);

  assert.strictEqual(res.todayKey, TODAY);
  assert.strictEqual(res.user.openid, 'oA');
  assert.strictEqual(res.partner.openid, 'oB');
  assert.strictEqual(res.partner.nickname, '小怡');
  assert.strictEqual(res.bind.state, 'bound');
  assert.strictEqual(res.couple.coupleId, 'c_1');
  assert.ok(res.couple.daysTogether > 0);
  assert.deepStrictEqual(res.mood, {
    mine: { mood: 'sunny', note: '', updatedAt: NOW.toISOString() },
    partner: { mood: 'cloudy', note: '想抱抱', updatedAt: NOW.toISOString() },
  });
  assert.strictEqual(res.hug.incoming.hugId, 'h_in');
  assert.strictEqual(res.hug.outgoing, null);
  assert.strictEqual(res.safety, null);
  assert.strictEqual(res.diary, null);
  assert.strictEqual(res.wish, null);
});

test('home.get: 心情区块查询失败只让 mood 为 null，抱抱照常返回（文档 10.3）', async () => {
  const { ctx, fake } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    hugs: [
      {
        _id: 'h_in', coupleId: 'c_1', fromOpenid: 'oB', toOpenid: 'oA', status: 'pending',
        createdAt: new Date(NOW.getTime() - 3600 * 1000), respondedAt: null,
        expiresAt: new Date(NOW.getTime() + WEEK_MS),
      },
    ],
  });
  const realDb = fake.db;
  ctx.db = {
    collection(name) {
      if (name === 'moods') throw new Error('mock moods down');
      return realDb.collection(name);
    },
  };
  ctx.user = { _id: 'oA', coupleId: 'c_1' };
  ctx.couple = { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' };
  ctx.partner = { _id: 'oB' };

  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await homeHandler.get({}, ctx);
    assert.strictEqual(res.mood, null);
    assert.strictEqual(res.hug.incoming.hugId, 'h_in');
    assert.strictEqual(res.couple.coupleId, 'c_1');
  } finally {
    console.error = originalError;
  }
});

test('home.get: 未绑定返回 3 个区块 null，并按 bind 状态机返回', async () => {
  const { ctx } = makeCtx({
    users: [{ _id: 'oA', coupleId: null }],
  });
  ctx.user = { _id: 'oA', coupleId: null };
  ctx.couple = null;
  ctx.partner = null;

  const res = await homeHandler.get({}, ctx);
  assert.strictEqual(res.couple, null);
  assert.strictEqual(res.partner, null);
  assert.strictEqual(res.mood, null);
  assert.strictEqual(res.hug, null);
  assert.strictEqual(res.bind.state, 'unbound');
});
