'use strict';

/**
 * 查询预算回归测试（文档 7.8「查询预算：约 9 次读」、13.11 性能 DoD）。
 *
 * 做法：利用 tests/helpers/fake-db.js 的操作钩子 setOperationHook（doc.get /
 * doc.update / where.get / where.count / add ... 每次真实读写前触发一次），
 * 统计一次请求实际发生的库操作次数。数的是「操作」而不是「collection() 句柄获取」：
 * 复用同一个 collection 句柄连续 get 会被逐次计数，所以按文档条数逐条 doc().get()
 * 退化成 N+1 的写法会被抓到；一次 get 拿 100 条仍然只算 1 次。
 *
 * 日期用 time.dateKeyOf(new Date()) 动态取（不能写字面量，否则第二天全量测试必红）。
 * 精确的逐集合次数表是「当前实现的快照」：任何聚合逻辑多查一次或换查询方式都会让它红，
 * 同时每条用例也用 total() 锁总量，避免只盯单集合漏掉总量漂移。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness } = require('./helpers/cloud-entry');
const time = require('../cloudfunctions/api/lib/time');

const A = 'oQB_A_000000000001';
const B = 'oQB_B_000000000002';
const COUPLE = 'c_abcdef0123456789';
/**
 * 每次取当前时刻：种子里的相对时间戳（lastActiveAt、纪念日等）在用例执行时求值；
 * 不能写成模块加载时的固定值，否则「模块加载 → 用例执行」间隔一旦超过 lastActiveAt
 * 的 5 分钟节流阈值，节流会被判成需要回写，精确次数表就会假红（与日期/午夜无关）。
 */
function now() {
  return new Date();
}

/** 服务端「今天」；每次取新值，避免跨午夜后种子数据与 ctx.now 不一致 */
function todayKey() {
  return time.dateKeyOf(new Date());
}

function userDoc(id, extra) {
  return Object.assign({
    _id: id, openid: id, nickname: id === A ? '小怡' : '小安', avatarFileID: '',
    coupleId: COUPLE, profileComplete: true, bindFailCount: 0,
    lastActiveAt: now(), createdAt: now(), updatedAt: now(),
  }, extra || {});
}

function coupleDoc(members) {
  return {
    _id: COUPLE, memberOpenids: members || [A, B], startDate: '2024-05-20',
    startDateUpdatedBy: A, status: 'active', createdAt: now(), updatedAt: now(),
  };
}

function seedBound(today, extra) {
  return Object.assign({
    users: [userDoc(A), userDoc(B)],
    couples: [coupleDoc()],
    moods: [
      { _id: A + '_' + today, coupleId: COUPLE, openid: A, date: today, mood: 'sunny', note: '开心', createdAt: now(), updatedAt: now() },
      { _id: B + '_' + today, coupleId: COUPLE, openid: B, date: today, mood: 'cloudy', note: '', createdAt: now(), updatedAt: now() },
    ],
    anniversaries: [
      { _id: 'a_first', coupleId: COUPLE, title: '第一次见面', date: '2023-06-01', createdBy: A, createdAt: now(), updatedAt: now() },
    ],
    safety_checkins: [
      { _id: 's_mine', coupleId: COUPLE, openid: A, note: '', date: today, createdAt: now() },
      { _id: 's_partner', coupleId: COUPLE, openid: B, note: '', date: '2024-05-19', createdAt: new Date(now().getTime() - 86400000) },
    ],
    diaries: [
      { _id: A + '_' + today, coupleId: COUPLE, authorOpenid: A, date: today, content: '我的', unlockAt: new Date(now().getTime() + 86400000), createdAt: now(), updatedAt: now() },
      { _id: B + '_' + today, coupleId: COUPLE, authorOpenid: B, date: today, content: '你的', unlockAt: new Date(now().getTime() + 86400000), createdAt: now(), updatedAt: now() },
    ],
    wishes: [
      { _id: 'w_a', coupleId: COUPLE, title: '去看海', createdBy: A, done: false, createdAt: now(), updatedAt: now() },
      { _id: 'w_b', coupleId: COUPLE, title: '去看雪', createdBy: B, done: true, doneBy: B, doneAt: now(), createdAt: new Date(now().getTime() - 1000), updatedAt: now() },
    ],
  }, extra || {});
}

/**
 * 给当前假库装操作钩子（reset 会换新假库，因此每次 reset 后都要重新 instrument）。
 * 返回 { counts, ops, total(), reset() }；counts 按集合计数，ops 按「集合:操作」计数。
 */
function instrument(h) {
  const fake = h.fake();
  assert.strictEqual(typeof fake.setOperationHook, 'function',
    '假库缺少 setOperationHook，查询预算统计会静默失效');
  const counts = {};
  const ops = {};
  fake.setOperationHook((name, op) => {
    counts[name] = (counts[name] || 0) + 1;
    const key = name + ':' + op;
    ops[key] = (ops[key] || 0) + 1;
  });
  const api = {
    counts,
    ops,
    total() {
      return Object.keys(counts).reduce((sum, key) => sum + counts[key], 0);
    },
    reset() {
      Object.keys(counts).forEach((key) => { delete counts[key]; });
      Object.keys(ops).forEach((key) => { delete ops[key]; });
    },
  };
  return api;
}

function assertNoN1(q, maxPerCollection) {
  Object.keys(q.counts).forEach((name) => {
    assert.ok(q.counts[name] <= maxPerCollection,
      name + ' 被访问了 ' + q.counts[name] + ' 次，超过单页聚合允许的 ' + maxPerCollection + ' 次');
  });
}

test('查询预算：已绑定首页一次 home.get 约 12 次库操作（文档 7.8：9 次读 + pause 1 + growth 2）', async () => {
  const h = createHarness();
  const today = todayKey();
  h.reset(seedBound(today), A);
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  assert.strictEqual(res.ok, true, 'home.get 应成功');
  assert.strictEqual(res.data.mood.mine.mood, 'sunny');
  assert.strictEqual(res.data.mood.partner.mood, 'cloudy');
  assert.strictEqual(res.data.anniversary.items[0].title, '第一次见面');
  assert.strictEqual(res.data.safety.mineToday, true);
  assert.strictEqual(res.data.wish.total, 2);

  // 精确锁住每个集合的库操作次数：改动聚合导致多查一次就会红
  assert.deepStrictEqual(q.counts, {
    users: 2,             // 本人 + 伴侣
    couples: 1,           // 关系
    moods: 1,             // 今日两人一次查
    anniversaries: 1,     // 一次读全部自定义纪念日（≤8 条）
    safety_checkins: 2,   // 我今日 + 伴侣最近
    diaries: 1,           // 今日两人一次查
    wishes: 1,            // 一次读全量本地统计
    pauses: 1,            // M11：当前未 closed 的一条（coupleId+status+startedAt 索引）
    growth_tasks: 2,      // M11.3：在档列表一次 + 已归档 count 一次
  });
  assert.strictEqual(q.total(), 12, '一次首页聚合应约 12 次库操作（文档 7.8 的 12–13）');
  assertNoN1(q, 2);
});

test('查询预算：lastActiveAt 超过 5 分钟才多一次写，其余不变', async () => {
  const h = createHarness();
  const today = todayKey();
  h.reset(seedBound(today, {
    users: [userDoc(A, { lastActiveAt: new Date(now().getTime() - 6 * 60 * 1000) }), userDoc(B)],
  }), A);
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(q.counts.users, 3, '本人 + 伴侣 + 更新 lastActiveAt 一次');
  assert.deepStrictEqual(q.ops['users:doc.update'], 1, '只有一次回写');
  assert.strictEqual(q.total(), 13);
  assertNoN1(q, 3);
});

test('查询预算：未绑定首页不碰双人集合，只读邀请（空屋不扫全库）', async () => {
  const h = createHarness();
  h.reset({
    users: [userDoc(A, { coupleId: null })],
    // 未绑定但库里可能有别人家的数据，首页不能读
    moods: seedBound(todayKey()).moods,
    wishes: seedBound(todayKey()).wishes,
  }, A);
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.bind.state, 'unbound');

  assert.strictEqual(q.counts.couples, undefined, '未绑定不应读 couples');
  assert.strictEqual(q.counts.moods, undefined);
  assert.strictEqual(q.counts.anniversaries, undefined);
  assert.strictEqual(q.counts.safety_checkins, undefined);
  assert.strictEqual(q.counts.diaries, undefined);
  assert.strictEqual(q.counts.wishes, undefined);
  // users: 本人 doc.get（首屏 lastActiveAt 是新的，不触发回写）；
  // bind_invites: 计算绑定状态时读自己/对方的进行中邀请
  assert.deepStrictEqual(q.counts, { users: 1, bind_invites: 2 });
  assert.strictEqual(q.total(), 3);
});

test('查询预算：纪念日多也不多查（8 条仍是一次 where.get，排序在内存里做）', async () => {
  const h = createHarness();
  const today = todayKey();
  const items = [];
  for (let i = 0; i < 8; i += 1) {
    items.push({
      _id: 'a_' + i, coupleId: COUPLE, title: '纪念日 ' + i, date: '2020-0' + ((i % 9) + 1) + '-01',
      createdBy: A, createdAt: now(), updatedAt: now(),
    });
  }
  h.reset(seedBound(today, { anniversaries: items }), A);
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.anniversary.items.length, 8);
  // 1 次读，无写；排序 / 剩余天数都在内存里算
  assert.strictEqual(q.counts.anniversaries, 1);
  assert.strictEqual(q.ops['anniversaries:doc.update'], undefined);
  assert.strictEqual(q.total(), 12);
});

test('查询预算：列表接口每页只多一次数据读（分页不 N+1）', async () => {
  const h = createHarness();
  const today = todayKey();
  const wishes = [];
  for (let i = 0; i < 100; i += 1) {
    wishes.push({
      _id: 'w_' + i, coupleId: COUPLE, title: '愿望 ' + i, createdBy: A, done: false,
      createdAt: new Date(now().getTime() - i * 1000), updatedAt: now(),
    });
  }
  h.reset(seedBound(today, { wishes }), A);
  const q = instrument(h);

  const cases = [
    ['diary.list', 'diaries'],
    ['safety.list', 'safety_checkins'],
    ['wish.list', 'wishes'],
    ['mood.list', 'moods'],
    ['ledger.list', 'ledger_entries'],
  ];
  for (const [action, collection] of cases) {
    q.reset();
    const res = await h.callAs(A, action, {});
    assert.strictEqual(res.ok, true, action + ' 应成功');
    // users 两次 = 本人 + 伴侣昵称；couples 一次 = 关系；数据集合一次 = 本页查询
    assert.deepStrictEqual(q.counts, { users: 2, couples: 1, [collection]: 1 },
      action + ' 的库操作次数应为 4（实际 ' + q.total() + '）');
    assert.strictEqual(q.total(), 4);
  }
  // 100 条愿望也是 1 次查询（wish.list 一次拿全量，有 100 上限）
  q.reset();
  const wishRes = await h.callAs(A, 'wish.list', {});
  assert.strictEqual(wishRes.data.items.length, 100);
  assert.strictEqual(q.counts.wishes, 1);
});

test('查询预算：关系里没有伴侣时少读伴侣相关项（users/safety 各少一次）', async () => {
  const h = createHarness();
  const today = todayKey();
  h.reset({
    users: [userDoc(A)],
    couples: [coupleDoc([A])],
    moods: seedBound(today).moods.filter((doc) => doc.openid === A),
    safety_checkins: seedBound(today).safety_checkins.filter((doc) => doc.openid === A),
    diaries: seedBound(today).diaries.filter((doc) => doc.authorOpenid === A),
    wishes: [],
  }, A);
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.partner, null);
  assert.deepStrictEqual(q.counts, {
    users: 1, couples: 1, moods: 1, anniversaries: 1,
    safety_checkins: 1, diaries: 1, wishes: 1, pauses: 1, growth_tasks: 2,
  });
  assert.strictEqual(q.total(), 10);
});

test('查询预算：couple 文档丢失自愈只多两次用户读写，不继续查双人集合', async () => {
  const h = createHarness();
  const today = todayKey();
  const dirty = seedBound(today);
  dirty.users = [userDoc(A, { coupleId: 'c_missing' }), userDoc(B, { coupleId: 'c_missing' })];
  dirty.couples = [];
  h.reset(dirty, A);
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.bind.state, 'unbound');
  // users: 本人 doc.get + 把 coupleId 清空的一次 doc.update（伴侣没有 coupleId 可读，少一次）
  // couples: 读丢失的 couple 一次；bind_invites: 未绑定状态下计算绑定状态
  assert.deepStrictEqual(q.counts, { users: 2, couples: 1, bind_invites: 2 });
  assert.strictEqual(q.total(), 5);
  assert.strictEqual(h.fake().get('users', A).coupleId, null, '自愈应把 coupleId 清空');
});

test('查询预算：可选区块降级不重试、不额外扫库（mood 失败仍返回整页）', async () => {
  const h = createHarness();
  const today = todayKey();
  h.reset(seedBound(today), A);
  // 让 moods 的 where().get() 抛错，模拟可选区块读故障
  const fake = h.fake();
  const original = fake.db.collection;
  fake.db.collection = function collection(name) {
    const col = original.call(fake.db, name);
    if (name !== 'moods') return col;
    return Object.assign({}, col, {
      where() {
        return {
          limit() { return this; },
          async get() { throw new Error('moods boom'); },
        };
      },
    });
  };
  const q = instrument(h);

  const res = await h.callAs(A, 'home.get', {});
  fake.db.collection = original;

  assert.strictEqual(res.ok, true, '单区块失败不影响整页');
  assert.strictEqual(res.data.mood, null, '降级区块按 null 返回');
  assert.strictEqual(res.data.safety.mineToday, true, '其它区块正常');
  // 降级路径少一次 moods 读、且不因失败重试：9 次操作（含 M11 的 pause 1 次）
  assert.deepStrictEqual(q.counts, {
    users: 2, couples: 1, anniversaries: 1, safety_checkins: 2, diaries: 1, wishes: 1, pauses: 1,
    growth_tasks: 2,
  });
  assert.strictEqual(q.counts.moods, undefined);
  assert.strictEqual(q.total(), 11);
});
