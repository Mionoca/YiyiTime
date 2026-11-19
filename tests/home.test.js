'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  loadMood, loadAnniversary, loadSafety, loadDiary, loadWish, optionalBlock,
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

test('loadAnniversary: 只取本对情侣的记录，按剩余天数排序并现算 daysLeft（不落库）', async () => {
  const { ctx } = makeCtx({
    anniversaries: [
      // 干扰项：别的 couple 的记录
      { _id: 'a_other', coupleId: 'c_2', title: '别人的', date: '2020-01-01', createdAt: NOW },
      { _id: 'a_late', coupleId: 'c_1', title: '冬至', date: '2020-12-22', createdAt: NOW },
      { _id: 'a_near', coupleId: 'c_1', title: '第一次见面', date: '2023-11-20', createdAt: NOW },
    ],
  });
  const res = await loadAnniversary(ctx, 'c_1', TODAY);

  assert.deepStrictEqual(res.items.map((item) => item.title), ['第一次见面', '冬至']);
  assert.strictEqual(res.items[0].nextDate, '2026-11-20');
  assert.strictEqual(res.items[0].daysLeft, 4);
  assert.strictEqual(res.items[0].years, 3);
});

test('loadAnniversary: 一个都没加时返回空数组（不是 null，页面只剩「在一起」一张卡）', async () => {
  const { ctx } = makeCtx();
  const res = await loadAnniversary(ctx, 'c_1', TODAY);
  assert.deepStrictEqual(res, { items: [] });
});

test('loadDiary: 只有已分享的日记才算「TA 写了」+ 解锁时刻（当天 partnerUnlocked 恒为 false）', async () => {
  const { ctx } = makeCtx({
    diaries: [
      {
        _id: 'oA_' + TODAY, coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: 'x',
        visibility: 'private', unlockAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
      },
      {
        // 对方这篇显式分享了，才算出「写了」
        _id: 'oB_' + TODAY, coupleId: 'c_1', authorOpenid: 'oB', date: TODAY, content: 'y',
        visibility: 'partner', unlockAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
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

test('loadDiary: 对方的私密日记按不存在处理（partnerWritten=false，不泄露 unlockAt）', async () => {
  const { ctx } = makeCtx({
    diaries: [
      {
        _id: 'oB_' + TODAY, coupleId: 'c_1', authorOpenid: 'oB', date: TODAY, content: 'y',
        visibility: 'private', unlockAt: new Date('2099-01-01T00:00:00.000Z'), createdAt: NOW, updatedAt: NOW,
      },
    ],
  });
  const res = await loadDiary(ctx, 'c_1', TODAY, 'oB');
  assert.strictEqual(res.partnerWritten, false);
  assert.strictEqual(res.unlockAt, '2026-11-16T16:00:00.000Z', '默认次日 00:00，不跟着私密文档走');
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

test('home.get: 已绑定返回 mood/anniversary/diary/wish 真实聚合', async () => {
  const { ctx } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }, { _id: 'oB', nickname: '小怡' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    moods: [
      { _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny', note: '', updatedAt: NOW },
      { _id: 'oB_' + TODAY, coupleId: 'c_1', openid: 'oB', date: TODAY, mood: 'cloudy', note: '想抱抱', updatedAt: NOW },
    ],
    anniversaries: [
      { _id: 'a_one', coupleId: 'c_1', title: '第一次见面', date: '2023-11-20', createdAt: NOW },
      { _id: 'a_other', coupleId: 'c_2', title: '别人的', date: '2020-01-01', createdAt: NOW },
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
  assert.deepStrictEqual(res.anniversary, {
    items: [{
      anniversaryId: 'a_one',
      title: '第一次见面',
      date: '2023-11-20',
      nextDate: '2026-11-20',
      daysLeft: 4,
      years: 3,
      createdAt: NOW.toISOString(),
    }],
  });
  assert.deepStrictEqual(res.diary, {
    mineWritten: true,
    partnerWritten: false,
    partnerUnlocked: false,
    unlockAt: '2026-11-16T16:00:00.000Z',
  });
  assert.deepStrictEqual(res.wish, { total: 3, done: 1, previewTitle: '去看海' });
});

test('home.get: 心情区块查询失败只让 mood 为 null，纪念日照常返回（文档 10.3）', async () => {
  const { ctx, fake } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    anniversaries: [
      { _id: 'a_one', coupleId: 'c_1', title: '第一次见面', date: '2023-11-20', createdAt: NOW },
      { _id: 'a_other', coupleId: 'c_2', title: '别人的', date: '2020-01-01', createdAt: NOW },
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
    assert.strictEqual(res.anniversary.items[0].title, '第一次见面');
    assert.strictEqual(res.couple.coupleId, 'c_1');
  } finally {
    console.error = originalError;
  }
});

test('home.get: 未绑定返回各业务区块 null，并按 bind 状态机返回', async () => {
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
  assert.strictEqual(res.anniversary, null);
  assert.strictEqual(res.diary, null);
  assert.strictEqual(res.wish, null);
  assert.strictEqual(res.bind.state, 'unbound');
});

test('home.get: 纪念日/日记/愿望区块各自失败只让对应块为 null（文档 10.3）', async () => {
  const { ctx, fake } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    moods: [
      { _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny', note: '', updatedAt: NOW },
    ],
  });
  const realDb = fake.db;
  const down = ['anniversaries', 'diaries', 'wishes'];
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
    assert.strictEqual(res.anniversary, null);
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

// 文档 7.8 / 5.8：一条脏 startDate 不能把双方首页永久打成 INTERNAL_ERROR
test('home.get: couple.startDate 缺失或非法时降级为 null，不整页失败也不渲染 NaN', async () => {
  const ME = 'oABCDEF123456';
  // 后两个（未来日期 / 2000 年前）格式合法但范围非法，必须一起降级（审查 P3-7）
  for (const dirty of [undefined, '', 12345, 'garbage', '2099-01-01', '1999-12-31']) {
    const { ctx } = makeCtx({
      users: [{ _id: ME, coupleId: 'c_1' }],
      couples: [{ _id: 'c_1', status: 'active', memberOpenids: [ME, 'oB'], startDate: dirty }],
    });
    ctx.openid = ME;
    ctx.user = { _id: ME, coupleId: 'c_1' };
    ctx.couple = { _id: 'c_1', status: 'active', memberOpenids: [ME, 'oB'], startDate: dirty };
    ctx.partner = { _id: 'oB' };

    const logs = [];
    const originalError = console.error;
    console.error = (...args) => { logs.push(args); };
    let res;
    try {
      res = await homeHandler.get({}, ctx);
    } finally {
      console.error = originalError;
    }
    assert.strictEqual(res.bind.state, 'bound', '绑定关系本身有效，只是日期脏');
    assert.strictEqual(res.couple.coupleId, 'c_1');
    assert.strictEqual(res.couple.startDate, null);
    assert.strictEqual(res.couple.daysTogether, null);
    assert.strictEqual(res.couple.anniversary, null);
    assert.strictEqual(res.partner.openid, 'oB', '其他区块照常返回');

    // 只记日志：类型可以记，完整 openid / 具体日期值不落日志
    assert.strictEqual(logs.length, 1);
    assert.strictEqual(logs[0][0], '[home.get] couple.startDate invalid');
    const logged = JSON.parse(logs[0][1]);
    assert.strictEqual(logged.startDateType, typeof dirty);
    assert.strictEqual(logged.openidTail, '123456');
    assert.strictEqual(JSON.stringify(logged).includes(ME), false);
    if (typeof dirty === 'string' && dirty !== '') {
      assert.strictEqual(JSON.stringify(logged).includes(dirty), false, '完整脏日期值不落日志');
    }
  }
});

test('home.get: growth 区块聚合在档数与待认领红点（M11.3）', async () => {
  const { ctx } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    growth_tasks: [
      {
        _id: 'g_a', coupleId: 'c_1', createdBy: 'oA', title: '一起背单词', category: 'learn',
        status: 'active', createdAt: new Date(NOW.getTime() - 3000), archivedAt: null,
      },
      {
        _id: 'g_b', coupleId: 'c_1', createdBy: 'oB', title: '一起跑步', category: 'sport',
        status: 'confirming', createdAt: new Date(NOW.getTime() - 2000), archivedAt: null,
      },
      {
        _id: 'g_c', coupleId: 'c_1', createdBy: 'oA', title: '旧的', category: 'other',
        status: 'archived', archivedType: 'done', createdAt: NOW,
        archivedAt: new Date(NOW.getTime() - 1000),
      },
      // 别的情侣的干扰项
      { _id: 'g_x', coupleId: 'c_2', createdBy: 'oX', title: '别人家', category: 'other', status: 'active', createdAt: NOW },
    ],
  });
  ctx.user = { _id: 'oA', coupleId: 'c_1' };
  ctx.couple = { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' };
  ctx.partner = { _id: 'oB', nickname: '小安' };

  const res = await homeHandler.get({}, ctx);
  assert.strictEqual(res.growth.inFlight, 2, '在档两件');
  assert.strictEqual(res.growth.awaitingConfirm, true, '有 confirming 就要红点');
  assert.strictEqual(res.growth.firstActiveTitle, '一起背单词');
  assert.strictEqual(res.growth.archivedCount, 1, '归档数量单独 count');
});

test('home.get: 没有进行中的任务时 firstActiveTitle 为 null；未绑定整块为 null', async () => {
  const { ctx } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    growth_tasks: [
      { _id: 'g_b', coupleId: 'c_1', createdBy: 'oA', title: '在等人认领', category: 'other', status: 'confirming', createdAt: NOW },
    ],
  });
  ctx.user = { _id: 'oA', coupleId: 'c_1' };
  ctx.couple = { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' };
  ctx.partner = { _id: 'oB' };

  const res = await homeHandler.get({}, ctx);
  assert.strictEqual(res.growth.firstActiveTitle, null, '只有待认领的，没有进行中的');
  assert.strictEqual(res.growth.awaitingConfirm, true);

  // 未绑定：整块 null（不用查库）
  const { ctx: unbound } = makeCtx({ users: [{ _id: 'oA', coupleId: null }] });
  unbound.user = { _id: 'oA', coupleId: null };
  unbound.couple = null;
  const empty = await homeHandler.get({}, unbound);
  assert.strictEqual(empty.growth, null);
});

test('home.get: growth 区块读库失败只降级自己（文档 10.3）', async () => {
  const { ctx, fake } = makeCtx({
    users: [{ _id: 'oA', coupleId: 'c_1' }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2026-11-10' }],
    moods: [
      { _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny', note: '', updatedAt: NOW },
    ],
  });
  const realDb = fake.db;
  ctx.db = {
    collection(name) {
      if (name === 'growth_tasks') throw new Error('mock growth down');
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
    assert.strictEqual(res.growth, null, 'growth 块失败降级 null');
    assert.strictEqual(res.mood.mine.mood, 'sunny', '心情块不受影响');
  } finally {
    console.error = originalError;
  }
});
