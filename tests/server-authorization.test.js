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

test('纪念日：别家改/删都返回 FORBIDDEN，列表互不干扰，本对双方都能改', async () => {
  seedTwoCouples();
  const added = await ok(A, 'anniversary.add', { title: '第一次见面', date: '2023-06-01' });
  const anniversaryId = added.item.anniversaryId;

  // 别的情侣成员拿到 id 也不能改 / 删：先按 coupleId 判归属
  await fail(C, 'anniversary.update', { anniversaryId, title: '改不动' }, 'FORBIDDEN');
  await fail(C, 'anniversary.remove', { anniversaryId }, 'FORBIDDEN');

  // 列表按 coupleId 隔离：别的对看不到
  const listC = await ok(C, 'anniversary.list', {});
  assert.deepStrictEqual(listC.items, []);
  const listA = await ok(A, 'anniversary.list', {});
  assert.strictEqual(listA.items.length, 1);

  // 本对另一个人可以改（纪念日是两个人共同的）
  const updated = await ok(B, 'anniversary.update', { anniversaryId, title: '初见' });
  assert.strictEqual(updated.item.title, '初见');

  const stored = h.fake().get('anniversaries', anniversaryId);
  assert.strictEqual(stored.coupleId, COUPLE_AB);
  assert.strictEqual(stored.createdBy, A);
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

  // 纪念日：coupleId / createdBy 由服务端定
  const ann = await ok(A, 'anniversary.add', {
    title: '初见', date: '2023-06-01', openid: C, coupleId: COUPLE_CD, createdBy: C,
  });
  const annDoc = store.get('anniversaries', ann.item.anniversaryId);
  assert.strictEqual(annDoc.coupleId, COUPLE_AB, '归属只认当前关系');
  assert.strictEqual(annDoc.createdBy, A, 'createdBy 只认服务端身份');

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
    ['anniversary.add', { title: '初见', date: '2023-06-01' }],
    ['anniversary.list', {}],
    ['anniversary.update', { anniversaryId: 'a_not_mine', title: '改不动' }],
    ['anniversary.remove', { anniversaryId: 'a_not_mine' }],
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
  assert.strictEqual(home.anniversary, null);
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

test('记账本：伴侣账本只读、别家改删一律拒绝、未绑定不读库', async () => {
  seedTwoCouples();
  const mine = await ok(A, 'ledger.add', { amount: 1200, category: 'food', note: '午饭' });
  const entryId = mine.entry.entryId;
  const partnerEntry = await ok(B, 'ledger.add', { amount: 800, category: 'daily' });

  // M13：伴侣账本默认不可见，必须先申请、由主人批准
  const lockedView = await ok(A, 'ledger.list', { who: 'partner' });
  assert.deepStrictEqual(lockedView.items, [], '无授权时看不到任何账目');
  assert.strictEqual(lockedView.permission, null);
  const asked = await ok(A, 'ledger.requestView', { scope: 'permanent' });
  assert.strictEqual(asked.request.status, 'pending');
  const requestId = asked.request.requestId;
  // 申请人不能自己批，也不能撤回别人的申请；第三方的决定一律拒绝
  await fail(A, 'ledger.decideView', { requestId, approve: true }, 'FORBIDDEN');
  await fail(B, 'ledger.cancelView', { requestId }, 'FORBIDDEN');
  // 第三方连记录都不该看见：按「找不到」返回，不泄露别家申请
  await fail(C, 'ledger.decideView', { requestId, approve: true }, 'LEDGER_ACCESS_NOT_FOUND');
  await ok(B, 'ledger.decideView', { requestId, approve: true });

  // 授权后只读：能看，但不能改 / 删
  const viewed = await ok(A, 'ledger.list', { who: 'partner' });
  assert.deepStrictEqual(viewed.items.map((item) => item.entryId), [partnerEntry.entry.entryId]);
  assert.strictEqual(viewed.permission.status, 'approved');
  await fail(A, 'ledger.update', { entryId: partnerEntry.entry.entryId, amount: 1 }, 'FORBIDDEN');
  await fail(A, 'ledger.remove', { entryId: partnerEntry.entry.entryId }, 'FORBIDDEN');
  // 主人收回后立刻变回锁
  await ok(B, 'ledger.revokeView', { requestId });
  const revokedView = await ok(A, 'ledger.list', { who: 'partner' });
  assert.deepStrictEqual(revokedView.items, []);
  assert.strictEqual(revokedView.permission.status, 'none', '收回后申请人侧折叠成 none，可重新申请');

  // 别家的人拿着 entryId 也不能改 / 删
  await fail(C, 'ledger.update', { entryId, amount: 1 }, 'FORBIDDEN');
  await fail(C, 'ledger.remove', { entryId }, 'FORBIDDEN');
  assert.strictEqual(h.fake().get('ledger_entries', entryId).amount, 1200, '别家不能改掉金额');

  // 别家的账本里看不到我的账
  const otherView = await ok(C, 'ledger.list', { who: 'partner' });
  assert.deepStrictEqual(otherView.items, []);

  // 未绑定用户：自己的账本是空的（只有本人文档，读不到别家），伴侣视角一律 NOT_BOUND
  const emptyMine = await ok(E, 'ledger.list', {});
  assert.deepStrictEqual(emptyMine.items, [], '未绑定用户看不到任何人的账');
  assert.strictEqual(emptyMine.bound, false);
  await fail(E, 'ledger.list', { who: 'partner' }, 'NOT_BOUND');
  // 个人账本允许未绑定记账，但记的那笔属于自己、不挂任何关系
  const own = await ok(E, 'ledger.add', { amount: 100, category: 'food' });
  assert.strictEqual(h.fake().get('ledger_entries', own.entry.entryId).coupleId, null);
});

test('解绑：别家不能替别人确认，跨对的解绑状态互不干扰', async () => {
  seedTwoCouples();

  const requested = await ok(A, 'couple.requestUnbind', {});
  assert.strictEqual(requested.unbind.status, 'pending');

  // C 已经绑定在 CD 上：他调用确认只会看自己那一对，AB 的申请跟他无关
  await fail(C, 'couple.confirmUnbind', {}, 'UNBIND_NOT_PENDING');
  await fail(C, 'couple.cancelUnbind', {}, 'UNBIND_NOT_PENDING');
  assert.strictEqual(h.fake().get('couples', COUPLE_AB).unbindStatus, 'pending');

  // CD 的申请也不能被 A 确认
  await ok(C, 'couple.requestUnbind', {});
  await fail(A, 'couple.confirmUnbind', {}, 'UNBIND_WAIT_PARTNER', 'A 自己发起了 AB 的解绑，只能等 B 确认');
  assert.strictEqual(h.fake().get('couples', COUPLE_CD).unbindStatus, 'pending');

  // 各自由对方确认
  await ok(D, 'couple.confirmUnbind', {});
  await ok(B, 'couple.confirmUnbind', {});
  assert.strictEqual(h.fake().get('couples', COUPLE_AB).status, 'closed');
  assert.strictEqual(h.fake().get('couples', COUPLE_CD).status, 'closed');
  // 解绑后：自己的账本还能看（个人数据），但看不到「TA 的」
  const mineAfter = await ok(A, 'ledger.list', {});
  assert.strictEqual(mineAfter.bound, false);
  await fail(A, 'ledger.list', { who: 'partner' }, 'NOT_BOUND');
});

// M13 / 文档 5.5、7.19：同意与拒绝都要幂等——两台设备同时点、或返回后再点，不该变成报错
test('账本授权：同意 / 拒绝幂等，处理过之后不能改判', async () => {
  seedTwoCouples();
  const asked = await ok(A, 'ledger.requestView', { scope: 'temp' });
  const requestId = asked.request.requestId;

  const first = await ok(B, 'ledger.decideView', { requestId, approve: true });
  assert.strictEqual(first.request.status, 'approved');
  assert.ok(first.request.expiresAt, '临时授权必须带到期时间');
  const again = await ok(B, 'ledger.decideView', { requestId, approve: true });
  assert.strictEqual(again.request.requestId, requestId, '重复同意返回同一条记录');
  await fail(B, 'ledger.decideView', { requestId, approve: false }, 'LEDGER_ACCESS_STATE');

  // 拒绝同样幂等，且拒绝后申请人可以重新申请
  await ok(B, 'ledger.revokeView', { requestId });
  const second = await ok(A, 'ledger.requestView', { scope: 'permanent' });
  const secondId = second.request.requestId;
  assert.notStrictEqual(secondId, requestId, '重新申请是一条新记录，历史保留');
  const rejected = await ok(B, 'ledger.decideView', { requestId: secondId, approve: false });
  assert.strictEqual(rejected.request.status, 'rejected');
  const rejectedAgain = await ok(B, 'ledger.decideView', { requestId: secondId, approve: false });
  assert.strictEqual(rejectedAgain.request.status, 'rejected');

  const third = await ok(A, 'ledger.requestView', { scope: 'permanent' });
  assert.strictEqual(third.request.status, 'pending', '被拒绝后还能再问一次');
});
