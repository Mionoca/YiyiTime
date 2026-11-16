'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  loadMood, loadHug, loadSafety, loadDiary, loadWish, optionalBlock,
} = require('../cloudfunctions/api/lib/home-blocks');
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

test('loadSafety: 今日两人是否报平安 + 伴侣最近一次时间，剔除别的 couple', async () => {
  const yesterday = new Date('2026-11-15T10:00:00.000Z');
  const { ctx } = makeCtx({
    safety_checkins: [
      {
        _id: 'sc_a', coupleId: 'c_1', openid: 'oA', note: '', date: TODAY, createdAt: new Date(NOW.getTime() - 3600 * 1000),
      },
      {
        _id: 'sc_b_old', coupleId: 'c_1', openid: 'oB', note: '', date: '2026-11-15', createdAt: yesterday,
      },
      {
        _id: 'sc_x', coupleId: 'c_2', openid: 'oB', note: '', date: TODAY, createdAt: NOW,
      },
    ],
  });
  const res = await loadSafety(ctx, 'c_1', TODAY, 'oB');
  assert.deepStrictEqual(res, {
    mineToday: true,
    partnerToday: false,
    partnerLastAt: yesterday.toISOString(),
  });
});

test('loadSafety: 一天多条时按 openid 判断，不会因为条数被截断（B1 回归）', async () => {
  const { ctx } = makeCtx({
    safety_checkins: [
      // 故意把 oA 的两条排在前面：旧实现 limit(2) 会截掉后面 oB 的记录
      { _id: 'a1', coupleId: 'c_1', openid: 'oA', note: '', date: TODAY, createdAt: new Date(NOW.getTime() - 3 * 3600 * 1000) },
      { _id: 'a2', coupleId: 'c_1', openid: 'oA', note: '', date: TODAY, createdAt: new Date(NOW.getTime() - 2 * 3600 * 1000) },
      { _id: 'b1', coupleId: 'c_1', openid: 'oB', note: '', date: TODAY, createdAt: new Date(NOW.getTime() - 3600 * 1000) },
    ],
  });
  const res = await loadSafety(ctx, 'c_1', TODAY, 'oB');
  assert.deepStrictEqual(res, {
    mineToday: true,
    partnerToday: true,
    partnerLastAt: new Date(NOW.getTime() - 3600 * 1000).toISOString(),
  });
});

test('loadSafety: 伴侣从没报过平安时 partnerLastAt 为 null', async () => {
  const { ctx } = makeCtx();
  const res = await loadSafety(ctx, 'c_1', TODAY, 'oB');
  assert.deepStrictEqual(res, { mineToday: false, partnerToday: false, partnerLastAt: null });
});

test('loadDiary: 今天写了是否已写 + 解锁时刻（当天 partnerUnlocked 恒为 false）', async () => {
  const { ctx } = makeCtx({
    diaries: [
      {
        _id: 'oA_' + TODAY, coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: 'x', unlockAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
      },
      {
        _id: 'oB_' + TODAY, coupleId: 'c_1', authorOpenid: 'oB', date: TODAY, content: 'y', unlockAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
      },
    ],
  });
  const res = await loadDiary(ctx, 'c_1', TODAY, 'oB');
  assert.deepStrictEqual(res, {
    mineWritten: true,
    partnerWritten: true,
    partnerUnlocked: false,
    unlockAt: '2026-11-16T16:00:00.000Z',
  });
});

test('loadDiary: 两人都没写时都为 false', async () => {
  const { ctx } = makeCtx();
  const res = await loadDiary(ctx, 'c_1', TODAY, 'oB');
  assert.deepStrictEqual(res, {
    mineWritten: false,
    partnerWritten: false,
    partnerUnlocked: false,
    unlockAt: '2026-11-16T16:00:00.000Z',
  });
});

test('loadWish: 统计 total/done 与第一条未完成的标题（已完成的旧愿望不算 preview）', async () => {
  const { ctx } = makeCtx({
    wishes: [
      {
        _id: 'w_done', coupleId: 'c_1', title: '早完成', done: true, doneAt: NOW, createdAt: new Date('2026-11-01T00:00:00.000Z'),
      },
      {
        _id: 'w_late', coupleId: 'c_1', title: '晚一点', done: false, createdAt: new Date('2026-11-12T00:00:00.000Z'),
      },
      {
        _id: 'w_early', coupleId: 'c_1', title: '最早未完成', done: false, createdAt: new Date('2026-11-11T00:00:00.000Z'),
      },
      {
        _id: 'w_other', coupleId: 'c_2', title: '别人的', done: false, createdAt: new Date('2026-11-10T00:00:00.000Z'),
      },
    ],
  });
  const res = await loadWish(ctx, 'c_1');
  assert.deepStrictEqual(res, { total: 3, done: 1, previewTitle: '最早未完成' });
});

test('loadWish: 没有愿望时 previewTitle 为 null', async () => {
  const { ctx } = makeCtx();
  const res = await loadWish(ctx, 'c_1');
  assert.deepStrictEqual(res, { total: 0, done: 0, previewTitle: null });
});

test('home.get: 已绑定返回 mood/hug/safety/diary/wish 真实聚合', async () => {
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
    safety_checkins: [
      {
        _id: 'sc_a', coupleId: 'c_1', openid: 'oA', note: '', date: TODAY, createdAt: new Date(NOW.getTime() - 1200 * 1000),
      },
      {
        _id: 'sc_b', coupleId: 'c_1', openid: 'oB', note: '午饭吃过了', date: '2026-11-15', createdAt: new Date(NOW.getTime() - 26 * 3600 * 1000),
      },
      {
        _id: 'sc_b_today', coupleId: 'c_1', openid: 'oB', note: '到公司了', date: TODAY, createdAt: new Date(NOW.getTime() - 1800 * 1000),
      },
    ],
    diaries: [
      {
        _id: 'oA_' + TODAY, coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: '今天想说的话',
        unlockAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
      },
    ],
    wishes: [
      {
        _id: 'w_2', coupleId: 'c_1', title: '晚一点', done: false, createdAt: new Date('2026-11-12T00:00:00.000Z'),
      },
      {
        _id: 'w_1', coupleId: 'c_1', title: '去看海', done: false, createdAt: new Date('2026-11-11T00:00:00.000Z'),
      },
      {
        _id: 'w_0', coupleId: 'c_1', title: '早完成', done: true, doneAt: NOW, createdAt: new Date('2026-11-01T00:00:00.000Z'),
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
  assert.deepStrictEqual(res.safety, {
    mineToday: true,
    partnerToday: true,
    partnerLastAt: new Date(NOW.getTime() - 1800 * 1000).toISOString(),
  });
  assert.deepStrictEqual(res.diary, {
    mineWritten: true,
    partnerWritten: false,
    partnerUnlocked: false,
    unlockAt: '2026-11-16T16:00:00.000Z',
  });
  assert.deepStrictEqual(res.wish, { total: 3, done: 1, previewTitle: '去看海' });
});

test('home.get: 报平安区块查询失败只让 safety 为 null，日记/愿望照常返回（文档 10.3）', async () => {
  const { ctx, fake } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    diaries: [
      {
        _id: 'oA_' + TODAY, coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: 'x',
        unlockAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
      },
    ],
    wishes: [
      { _id: 'w_1', coupleId: 'c_1', title: '去看海', done: false, createdAt: NOW },
    ],
  });
  const realDb = fake.db;
  ctx.db = {
    collection(name) {
      if (name === 'safety_checkins') throw new Error('mock safety down');
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
    assert.strictEqual(res.safety, null);
    assert.strictEqual(res.diary.mineWritten, true);
    assert.strictEqual(res.wish.total, 1);
  } finally {
    console.error = originalError;
  }
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
  assert.strictEqual(res.safety, null);
  assert.strictEqual(res.diary, null);
  assert.strictEqual(res.wish, null);
  assert.strictEqual(res.bind.state, 'unbound');
});

test('home.get: 抱抱/日记/愿望区块各自失败只让对应块为 null（文档 10.3）', async () => {
  const { ctx, fake } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    moods: [
      { _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny', note: '', updatedAt: NOW },
    ],
  });
  const realDb = fake.db;
  const down = ['hugs', 'diaries', 'wishes'];
  ctx.db = {
    collection(name) {
      if (down.indexOf(name) !== -1) throw new Error('mock ' + name + ' down');
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
    assert.strictEqual(res.hug, null);
    assert.strictEqual(res.diary, null);
    assert.strictEqual(res.wish, null);
    assert.strictEqual(res.mood.mine.mood, 'sunny');
    assert.strictEqual(res.couple.coupleId, 'c_1');
  } finally {
    console.error = originalError;
  }
});

/**
 * 包一层 users 集合，统计 update 调用次数（用于断言「写/不写」而不是只看库值）。
 * withFailure 为 true 时让 update 抛错，模拟写库故障。
 */
function countUserUpdates(ctx, fake, withFailure) {
  const calls = [];
  const realDb = fake.db;
  ctx.db = {
    command: realDb.command,
    runTransaction: realDb.runTransaction,
    collection(name) {
      if (name !== 'users') return realDb.collection(name);
      return Object.assign({}, realDb.collection('users'), {
        doc(id) {
          const real = realDb.collection('users').doc(id);
          return Object.assign({}, real, {
            async update(arg) {
              calls.push(arg);
              if (withFailure) throw new Error('users update down');
              return real.update(arg);
            },
          });
        },
      });
    },
  };
  return calls;
}

function unboundCtx(users) {
  const { ctx, fake } = makeCtx({ users });
  const last = users[0].lastActiveAt;
  ctx.user = { _id: 'oA', coupleId: null, lastActiveAt: last };
  ctx.couple = null;
  ctx.partner = null;
  return { ctx, fake };
}

test('home.get: 距上次 lastActiveAt 超过 5 分钟才写库（文档 7.8）', async () => {
  const last = new Date(NOW.getTime() - 6 * 60 * 1000);
  const { ctx, fake } = unboundCtx([{ _id: 'oA', coupleId: null, lastActiveAt: last }]);
  const calls = countUserUpdates(ctx, fake);

  const res = await homeHandler.get({}, ctx);
  assert.strictEqual(calls.length, 1, '超过 5 分钟应写一次');
  assert.deepStrictEqual(fake.get('users', 'oA').lastActiveAt, NOW);
  // 7.8：首页返回的 user 只有 4 个公开字段
  assert.deepStrictEqual(Object.keys(res.user).sort(),
    ['avatarFileID', 'nickname', 'openid', 'profileComplete']);
});

test('home.get: 5 分钟内不写 lastActiveAt（文档 7.8 / 1515）', async () => {
  const last = new Date(NOW.getTime() - 4 * 60 * 1000);
  const { ctx, fake } = unboundCtx([{ _id: 'oA', coupleId: null, lastActiveAt: last }]);
  const calls = countUserUpdates(ctx, fake);

  await homeHandler.get({}, ctx);
  assert.strictEqual(calls.length, 0, '4 分钟内不应写库');
  assert.deepStrictEqual(fake.get('users', 'oA').lastActiveAt, last);
});

test('home.get: 恰好 5 分钟不写、多 1ms 才写（实现与文档都是严格大于）', async () => {
  for (const [delta, expected] of [[5 * 60 * 1000, 0], [5 * 60 * 1000 + 1, 1]]) {
    const last = new Date(NOW.getTime() - delta);
    const { ctx, fake } = unboundCtx([{ _id: 'oA', coupleId: null, lastActiveAt: last }]);
    const calls = countUserUpdates(ctx, fake);

    await homeHandler.get({}, ctx);
    assert.strictEqual(calls.length, expected, 'delta=' + delta);
  }
});

test('home.get: lastActiveAt 缺失时补写', async () => {
  const { ctx, fake } = makeCtx({ users: [{ _id: 'oA', coupleId: null }] });
  ctx.user = { _id: 'oA', coupleId: null };
  ctx.couple = null;
  ctx.partner = null;
  const calls = countUserUpdates(ctx, fake);

  await homeHandler.get({}, ctx);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(fake.get('users', 'oA').lastActiveAt, NOW);
});

test('home.get: lastActiveAt 写库失败被吞掉，首页仍正常返回', async () => {
  const last = new Date(NOW.getTime() - 6 * 60 * 1000);
  const { ctx, fake } = unboundCtx([{ _id: 'oA', coupleId: null, lastActiveAt: last }]);
  const calls = countUserUpdates(ctx, fake, true);

  const res = await homeHandler.get({}, ctx);
  assert.strictEqual(calls.length, 1, '仍应尝试写一次（不是悄悄跳过）');
  assert.strictEqual(res.todayKey, TODAY);
  assert.strictEqual(res.user.openid, 'oA');
  assert.strictEqual(res.bind.state, 'unbound');
  assert.deepStrictEqual(fake.get('users', 'oA').lastActiveAt, last, '写失败保持原值');
});
