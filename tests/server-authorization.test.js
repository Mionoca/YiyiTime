'use strict';

/**
 * 服务端越权矩阵测试（文档 11.1 数据分级 / 11.2 身份与成员校验）。
 *
 * 用云函数入口 + 假库跑「两对情侣 + 一个单身用户」：
 * - 别家的人不能读/改本对的抱抱、愿望、日记、报平安、开始日期；
 * - 客户端在 payload 里塞 openid / coupleId / date / unlockAt 一律被忽略；
 * - 未绑定、couple 非 active、成员不匹配三种情况都按 11.2 的 requireBound 拒绝。
 *
 * 这些规则决定「绕过客户端直接调云函数」的攻击面，用测试锁住，改坏即红。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');
const time = require('../cloudfunctions/api/lib/time');

const h = createHarness();

const A = 'oAUTH_A_0000000001';
const B = 'oAUTH_B_0000000002';
const C = 'oAUTH_C_0000000003';
const D = 'oAUTH_D_0000000004';
const E = 'oAUTH_E_0000000005';
const F = 'oAUTH_F_0000000006';
const G = 'oAUTH_G_0000000007';
const H = 'oAUTH_H_0000000008';

const START = '2024-05-20';
const COUPLE_AB = 'c_aaaaaaaaaaaaaaaa';
const COUPLE_CD = 'c_cccccccccccccccc';
const COUPLE_FG = 'c_ffffffffffffffff';

function today() {
  return time.dateKeyOf(new Date());
}

function userDoc(openid, nickname, coupleId) {
  const now = new Date();
  return {
    _id: openid,
    openid,
    nickname,
    avatarFileID: 'cloud://' + openid + '.png',
    coupleId: coupleId || null,
    profileComplete: true,
    bindFailCount: 0,
    bindFailResetAt: null,
    lastActiveAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function coupleDoc(coupleId, members, extra) {
  const now = new Date();
  return Object.assign({
    _id: coupleId,
    memberOpenids: members.slice(),
    startDate: START,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }, extra || {});
}

/** A、B 一对；C、D 另一对；E 未绑定 */
function seedTwoCouples() {
  h.reset({
    users: [
      userDoc(A, '小怡', COUPLE_AB),
      userDoc(B, '阿安', COUPLE_AB),
      userDoc(C, '别人', COUPLE_CD),
      userDoc(D, '别人家', COUPLE_CD),
      userDoc(E, '单身', null),
    ],
    couples: [
      coupleDoc(COUPLE_AB, [A, B]),
      coupleDoc(COUPLE_CD, [C, D]),
    ],
  });
}

async function ok(openid, action, payload) {
  const res = await h.callAs(openid, action, payload);
  assert.strictEqual(
    res.ok,
    true,
    action + ' 应成功，实际：' + JSON.stringify({ code: res.code, message: res.message }),
  );
  return res.data;
}

async function fail(openid, action, payload, expectedCode) {
  const res = await h.callAs(openid, action, payload);
  assert.strictEqual(res.ok, false, action + ' 应失败但成功了：' + JSON.stringify(res.data));
  assert.strictEqual(
    res.code,
    expectedCode,
    action + ' 错误码应为 ' + expectedCode + '，实际 ' + res.code,
  );
  return res;
}

test('抱抱：别家的人回应返回 HUG_NOT_FOUND，发送者本人返回 HUG_NOT_RECIPIENT', async () => {
  seedTwoCouples();
  const sent = await ok(A, 'hug.send', {});
  const hugId = sent.hug.hugId;
  assert.strictEqual(sent.existing, false);

  // 别的情侣成员拿到 hugId 也不能回应：先按 coupleId 判归属
  await fail(C, 'hug.respond', { hugId }, 'HUG_NOT_FOUND');
  await fail(D, 'hug.respond', { hugId }, 'HUG_NOT_FOUND');

  // 同对但自己是发送者：抱抱不是给 TA 的
  await fail(A, 'hug.respond', { hugId }, 'HUG_NOT_RECIPIENT');

  // 接收者才能回应，且重复回应幂等
  const hugged = await ok(B, 'hug.respond', { hugId });
  assert.strictEqual(hugged.status, 'hugged');
  assert.strictEqual(hugged.already, false);
  const again = await ok(B, 'hug.respond', { hugId });
  assert.strictEqual(again.already, true);

  const stored = h.fake().get('hugs', hugId);
  assert.strictEqual(stored.coupleId, COUPLE_AB);
  assert.strictEqual(stored.fromOpenid, A);
  assert.strictEqual(stored.toOpenid, B);
});

test('愿望：别家改/完成/删除都返回 FORBIDDEN，且数据保持不变', async () => {
  seedTwoCouples();
  const added = await ok(A, 'wish.add', { title: '去看海', note: '等天气好' });
  const wishId = added.wish.wishId;

  await fail(C, 'wish.update', { wishId, title: '被别家改了' }, 'FORBIDDEN');
  await fail(C, 'wish.setDone', { wishId, done: true }, 'FORBIDDEN');
  await fail(C, 'wish.remove', { wishId }, 'FORBIDDEN');

  const stored = h.fake().get('wishes', wishId);
  assert.strictEqual(stored.coupleId, COUPLE_AB);
  assert.strictEqual(stored.title, '去看海');
  assert.strictEqual(stored.done, false);

  // 本对的人可以正常改
  const updated = await ok(B, 'wish.update', { wishId, title: '去看海（周末）' });
  assert.strictEqual(updated.wish.title, '去看海（周末）');
  const listA = await ok(A, 'wish.list', {});
  assert.strictEqual(listA.items.length, 1);
  assert.strictEqual(listA.items[0].wishId, wishId);

  // 别家也有愿望时列表仍只返回本对：C 建一条后 A 的列表不多不少，C 的列表也不含 A 的标题
  await ok(C, 'wish.add', { title: 'C 的愿望' });
  const listA2 = await ok(A, 'wish.list', {});
  assert.deepStrictEqual(listA2.items.map((wish) => wish.title), ['去看海（周末）']);
  const listC = await ok(C, 'wish.list', {});
  assert.deepStrictEqual(listC.items.map((wish) => wish.title), ['C 的愿望']);
});

test('日记：正文不跨对泄漏，读取只按自己的 coupleId 过滤', async () => {
  seedTwoCouples();
  const diaryA = await ok(A, 'diary.save', { content: 'A 只给 B 看的内容' });
  const diaryC = await ok(C, 'diary.save', { content: 'C 只给 D 看的内容' });

  // 给 C 再种一条「昨天」的日记：A 的列表按 coupleId 过滤后不应多出这一天。
  // 只种同一天的话，别家记录会被按天合并逻辑静默丢掉，测不出过滤缺失。
  const yesterday = time.addDays(today(), -1);
  const now = new Date();
  await h.fake().db.collection('diaries').doc(C + '_' + yesterday).set({
    data: {
      coupleId: COUPLE_CD,
      authorOpenid: C,
      date: yesterday,
      content: 'C 昨天的内容',
      unlockAt: time.nextUnlockAt(yesterday),
      createdAt: now,
      updatedAt: now,
    },
  });

  const listA = await ok(A, 'diary.list', {});
  const textA = JSON.stringify(listA);
  assert.strictEqual(textA.indexOf('C 只给 D 看的内容'), -1, 'A 的日记列表不能出现 C 的正文');
  assert.strictEqual(textA.indexOf('C 昨天的内容'), -1, 'A 的日记列表不能出现 C 的正文');
  assert.strictEqual(listA.items.length, 1, 'A 的列表只应有自己那一天，不能混入 C 昨天的记录');
  assert.deepStrictEqual(listA.items.map((item) => item.date), [diaryA.diary.date], 'A 的日期集合只能是自己的那一天');
  assert.strictEqual(listA.items[0].mine.content, 'A 只给 B 看的内容');

  const listC = await ok(C, 'diary.list', {});
  const textC = JSON.stringify(listC);
  assert.strictEqual(textC.indexOf('A 只给 B 看的内容'), -1, 'C 的日记列表不能出现 A 的正文');
  // C 自己今天 + 昨天各一条（昨天那条是测试种进去的），按日期倒序
  assert.strictEqual(listC.items.length, 2);
  assert.strictEqual(listC.items[0].mine.content, 'C 只给 D 看的内容');
  assert.strictEqual(listC.items[1].date, yesterday);

  // 库内 coupleId 各归各的，date 用服务端今天
  const store = h.fake();
  assert.strictEqual(store.get('diaries', A + '_' + diaryA.diary.date).coupleId, COUPLE_AB);
  assert.strictEqual(store.get('diaries', C + '_' + diaryC.diary.date).coupleId, COUPLE_CD);
});

test('报平安与首页聚合只在本对可见：别家的记录不出现在我的时间线和首页', async () => {
  seedTwoCouples();
  const checkinA = await ok(A, 'safety.checkin', { note: '我到家啦' });
  const wishA = await ok(A, 'wish.add', { title: 'A 的愿望' });

  const listC = await ok(C, 'safety.list', {});
  assert.deepStrictEqual(listC.items, [], 'C 不该看到 A 的报平安');

  const listA = await ok(A, 'safety.list', {});
  assert.strictEqual(listA.items.length, 1);
  assert.strictEqual(listA.items[0].checkinId, checkinA.entry.checkinId);
  assert.strictEqual(listA.items[0].openid, A);

  // B（A 的伴侣）首页门灯亮；C（别家）首页完全看不到 A 的记录
  const homeB = await ok(B, 'home.get', {});
  assert.strictEqual(homeB.safety.partnerToday, true);
  const homeC = await ok(C, 'home.get', {});
  assert.strictEqual(homeC.safety.partnerToday, false);
  assert.strictEqual(homeC.safety.mineToday, false);
  assert.strictEqual(homeC.safety.partnerLastAt, null);
  assert.strictEqual(homeC.partner.nickname, '别人家', 'C 的伴侣只能是 D');
  assert.strictEqual(homeC.couple.coupleId, COUPLE_CD);
  assert.strictEqual(homeB.couple.coupleId, COUPLE_AB);
  // 心情 / 日记 / 愿望三个区块也不能把 A 那对的数据带出来（C 自己没有记录 → 空聚合）
  assert.deepStrictEqual(homeC.mood, { mine: null, partner: null });
  assert.strictEqual(homeC.diary.mineWritten, false);
  assert.strictEqual(homeC.diary.partnerWritten, false);
  // 愿望区块也按 coupleId 过滤：A 有一条愿望时只有 B 的首页统计到，C 的是 0
  assert.strictEqual(homeB.wish.total, 1);
  assert.strictEqual(wishA.wish.wishId.length > 0, true);
  assert.strictEqual(homeC.wish.total, 0);
  assert.strictEqual(homeC.wish.previewTitle, null);
});

test('改开始日期只影响自己那一对', async () => {
  seedTwoCouples();
  const updated = await ok(C, 'couple.updateStartDate', { startDate: '2023-01-01' });
  assert.strictEqual(updated.startDate, '2023-01-01');

  const store = h.fake();
  assert.strictEqual(store.get('couples', COUPLE_CD).startDate, '2023-01-01');
  assert.strictEqual(store.get('couples', COUPLE_AB).startDate, START, '别家的开始日期不能被改');

  const homeA = await ok(A, 'home.get', {});
  assert.strictEqual(homeA.couple.startDate, START);
});

test('客户端传的 openid / coupleId / date / unlockAt 一律被忽略，只用服务端身份与时间', async () => {
  seedTwoCouples();
  const store = h.fake();
  const injected = { openid: C, coupleId: COUPLE_CD, date: '2000-01-01' };

  // 心情：日期只认服务端 todayKey
  const mood = await ok(A, 'mood.set', Object.assign({ mood: 'sunny', note: '开心' }, injected));
  assert.notStrictEqual(mood.mood.date, '2000-01-01');
  assert.strictEqual(mood.mood.date.length, 10);
  const moodDoc = store.get('moods', A + '_' + mood.mood.date);
  assert.strictEqual(moodDoc.coupleId, COUPLE_AB);
  assert.strictEqual(moodDoc.openid, A);

  // 抱抱：接收者只能是本对伴侣
  const hug = await ok(A, 'hug.send', Object.assign({ toOpenid: C }, injected));
  const hugDoc = store.get('hugs', hug.hug.hugId);
  assert.strictEqual(hugDoc.coupleId, COUPLE_AB);
  assert.strictEqual(hugDoc.fromOpenid, A);
  assert.strictEqual(hugDoc.toOpenid, B);

  // 报平安：记录归属和日期都由服务端定
  const checkin = await ok(A, 'safety.checkin', Object.assign({ note: '到家' }, injected));
  assert.strictEqual(checkin.entry.openid, A);
  const safetyDoc = store.get('safety_checkins', checkin.entry.checkinId);
  assert.strictEqual(safetyDoc.coupleId, COUPLE_AB);
  assert.strictEqual(safetyDoc.openid, A, '记录归属只认服务端 OPENID');
  assert.strictEqual(safetyDoc.note, '到家');
  assert.notStrictEqual(safetyDoc.date, '2000-01-01');

  // 日记：authorOpenid / coupleId / date / unlockAt 都忽略
  const diary = await ok(A, 'diary.save', Object.assign({
    content: '今天很好',
    authorOpenid: C,
    unlockAt: '2000-01-02T00:00:00.000Z',
  }, injected));
  const diaryDoc = store.get('diaries', A + '_' + diary.diary.date);
  assert.strictEqual(diaryDoc.coupleId, COUPLE_AB);
  assert.strictEqual(diaryDoc.authorOpenid, A);
  assert.notStrictEqual(diaryDoc.date, '2000-01-01');
  assert.strictEqual(diaryDoc.unlockAt.toISOString(), diary.diary.unlockAt);

  // 愿望：creator 与 coupleId 由服务端定
  const wish = await ok(A, 'wish.add', Object.assign({ title: '去看海' }, injected));
  const wishDoc = store.get('wishes', wish.wish.wishId);
  assert.strictEqual(wishDoc.coupleId, COUPLE_AB);
  assert.strictEqual(wishDoc.createdBy, A);

  // 被注入的 C 那一对库内没有任何新数据
  assert.deepStrictEqual(store.all('moods').filter((doc) => doc.openid === C), []);
  assert.deepStrictEqual(store.all('wishes').filter((doc) => doc.coupleId === COUPLE_CD), []);
});

test('未绑定用户调用双人接口统一 NOT_BOUND，首页仍返回未绑定视图', async () => {
  h.reset({ users: [userDoc(E, '单身', null)] });
  const dualActions = [
    ['mood.set', { mood: 'sunny' }],
    ['hug.send', {}],
    ['hug.respond', { hugId: 'h_not_mine' }],
    ['safety.checkin', { note: '' }],
    ['safety.list', {}],
    ['diary.save', { content: '今天很好' }],
    ['diary.list', {}],
    ['wish.add', { title: '去看海' }],
    ['wish.list', {}],
    ['wish.update', { wishId: 'w_not_mine', title: '改不动' }],
    ['wish.setDone', { wishId: 'w_not_mine', done: true }],
    ['wish.remove', { wishId: 'w_not_mine' }],
    ['couple.updateStartDate', { startDate: START }],
  ];
  for (const [action, payload] of dualActions) {
    await fail(E, action, payload, 'NOT_BOUND');
  }

  const home = await ok(E, 'home.get', {});
  assert.strictEqual(home.bind.state, 'unbound');
  assert.strictEqual(home.couple, null);
  assert.strictEqual(home.partner, null);
  assert.strictEqual(home.mood, null);
  assert.strictEqual(home.hug, null);
  assert.strictEqual(home.safety, null);
  assert.strictEqual(home.diary, null);
  assert.strictEqual(home.wish, null);
});

test('couple 状态不是 active 时按未绑定拒绝，首页自愈清掉 coupleId', async (t) => {
  const errors = captureConsoleError(t);
  h.reset({
    users: [userDoc(F, 'F', COUPLE_FG), userDoc(G, 'G', COUPLE_FG)],
    couples: [coupleDoc(COUPLE_FG, [F, G], { status: 'dissolved' })],
  });
  await fail(F, 'mood.set', { mood: 'sunny' }, 'NOT_BOUND');

  const home = await ok(F, 'home.get', {});
  assert.strictEqual(home.bind.state, 'unbound');
  assert.strictEqual(home.couple, null);
  assert.strictEqual(h.fake().get('users', F).coupleId, null, '数据异常时首页应自愈重置 coupleId');
  // 除了首页这一条，入口还会把 mood.set 的业务错误记一条 [api] 日志，所以按前缀过滤
  const homeLogs = errors.filter((args) => args[0] === '[home.get] couple missing or invalid');
  assert.strictEqual(homeLogs.length, 1);
  assert.deepStrictEqual(JSON.parse(homeLogs[0][1]).openidTail, F.slice(-6));
});

test('couple 成员列表不含当前用户时按 FORBIDDEN 拒绝，首页同样自愈', async (t) => {
  const errors = captureConsoleError(t);
  h.reset({
    users: [
      userDoc(A, '小怡', COUPLE_AB),
      userDoc(B, '阿安', COUPLE_AB),
      userDoc(H, '外人', COUPLE_AB),
    ],
    couples: [coupleDoc(COUPLE_AB, [A, B])],
  });
  await fail(H, 'mood.set', { mood: 'sunny' }, 'FORBIDDEN');

  const home = await ok(H, 'home.get', {});
  assert.strictEqual(home.bind.state, 'unbound');
  assert.strictEqual(h.fake().get('users', H).coupleId, null);
  const homeLogs = errors.filter((args) => args[0] === '[home.get] couple missing or invalid');
  assert.strictEqual(homeLogs.length, 1);
});
