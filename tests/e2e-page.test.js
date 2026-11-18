'use strict';

/**
 * 跨层集成测试：小程序页面 ↔ 真实云函数入口 / handler。
 *
 * 与既有测试的分工：
 * - tests/client-*.test.js 用 mock 的 api.call 测页面逻辑，不验证 payload / 出参字段；
 * - tests/acceptance.test.js / tests/e2e-flow.test.js 只测云函数侧契约；
 * - 本文件不 mock api.call：页面的 wx.cloud.callFunction 被接到真实云函数入口
 *   （tests/helpers/cloud-entry.js 的 createHarness），所以「页面发的字段名」和
 *   「handler 返回的字段名」必须真的对得上，否则页面白屏或状态错位会当场失败。
 *
 * 不覆盖（仍需真机）：WXML 渲染、真实网络与超时、微信渲染层组件、动画观感、四档机型布局。
 * 页面按需只实例化 JS 层（tests/helpers/client-page.js），不跑 WXML。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness } = require('./helpers/cloud-entry');
const clientPage = require('./helpers/client-page');
const meUtil = require('../miniprogram/utils/me');
const constants = require('../miniprogram/utils/constants');
const cloudTime = require('../cloudfunctions/api/lib/time');

const h = createHarness();

const A = 'oE2E_A_00000000001';
const B = 'oE2E_B_00000000002';
const START = '2024-05-20';

const HOME = 'miniprogram/pages/home/index.js';
const BIND = 'miniprogram/pages/bind/index.js';
const SAFETY = 'miniprogram/pages/safety/index.js';
const DIARY = 'miniprogram/pages/diary/index.js';
const WISH = 'miniprogram/pages/wish/index.js';
const MOOD = 'miniprogram/pages/mood/index.js';

let currentOpenid = A;
let toasts = [];
let navs = [];
let modals = [];
let storage = new Map();
let vibrated = 0;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label, timeout) {
  const limit = Date.now() + (timeout || 2000);
  while (Date.now() < limit) {
    if (predicate()) return;
    await wait(5);
  }
  throw new Error(
    '等待超时：' + label
      + '；toasts=' + JSON.stringify(toasts)
      + '；navs=' + JSON.stringify(navs)
      + '；modals=' + JSON.stringify(modals)
  );
}

function makeWx() {
  return {
    cloud: {
      callFunction(opts) {
        assert.ok(opts && opts.name === 'api', '只能调用 api 云函数，实际：' + JSON.stringify(opts && opts.name));
        const data = opts.data || {};
        // 真实链路：页面 → api.call → 云函数入口 → handler → 假库
        return Promise.resolve(h.callAs(currentOpenid, data.action, data.payload || {}))
          .then((result) => ({ result }));
      },
    },
    showToast(opts) { toasts.push((opts && opts.title) || ''); },
    showModal(opts) {
      modals.push((opts && opts.content) || '');
      if (opts && opts.success) opts.success({ confirm: true, cancel: false });
    },
    navigateTo(opts) { navs.push(opts && opts.url); },
    switchTab(opts) { navs.push(opts && opts.url); },
    reLaunch(opts) { navs.push(opts && opts.url); },
    setClipboardData(opts) { if (opts && opts.success) opts.success(); },
    showShareMenu() {},
    getWindowInfo() { return { statusBarHeight: 20 }; },
    getSystemInfoSync() { return { statusBarHeight: 20 }; },
    nextTick(fn) { fn(); },
    getStorageSync(key) { return storage.has(key) ? storage.get(key) : ''; },
    setStorageSync(key, value) { storage.set(key, value); },
    vibrateShort() { vibrated += 1; },
  };
}

function setup() {
  h.reset({}, A);
  currentOpenid = A;
  toasts = [];
  navs = [];
  modals = [];
  storage = new Map();
  vibrated = 0;
  meUtil.clearMe();
  clientPage.installWx(makeWx());
}

test.after(() => clientPage.restoreWx());

async function ok(openid, action, payload) {
  currentOpenid = openid;
  const res = await h.callAs(openid, action, payload);
  assert.strictEqual(res.ok, true, action + ' 应成功，实际：' + JSON.stringify({ code: res.code, message: res.message }));
  return res.data;
}

function openPage(rel) {
  return clientPage.instantiate(clientPage.loadPage(rel));
}

async function openHome(openid) {
  currentOpenid = openid;
  const page = openPage(HOME);
  page.onLoad();
  page.onShow();
  await waitFor(() => !page.data.loading, '首页加载完成（' + openid + '）');
  return page;
}

async function seedBound() {
  await ok(A, 'user.updateProfile', { nickname: '小怡', avatarFileID: 'cloud://test-env/avatars/a.png' });
  await ok(B, 'user.updateProfile', { nickname: '阿安', avatarFileID: 'cloud://test-env/avatars/b.png' });
  const invite = await ok(A, 'bind.create', { startDate: START });
  await ok(B, 'bind.preview', { code: invite.code });
  await ok(B, 'bind.apply', { code: invite.code });
  await ok(A, 'bind.confirm', { code: invite.code });
  return invite.code;
}

test('绑定页 ↔ 云函数：A 生成邀请码、B 预览并申请、A 确认后双方进首页', async () => {
  setup();
  await ok(A, 'user.updateProfile', { nickname: '小怡' });
  await ok(B, 'user.updateProfile', { nickname: '阿安' });

  // 先取一次 bind.status，确认页面 picker 的上限与默认值真的来自服务端 todayKey
  const statusA = await ok(A, 'bind.status');
  currentOpenid = A;
  const pageA = openPage(BIND);
  pageA.onLoad({});
  await waitFor(() => pageA.data.step === 'invite', 'A 进入邀请步骤');
  assert.strictEqual(pageA.data.step, 'invite');
  assert.strictEqual(pageA.data.todayKey, statusA.todayKey);
  assert.strictEqual(pageA.data.maxDate, statusA.todayKey, 'picker 上限必须是服务端今天');
  assert.strictEqual(pageA.data.startDate, statusA.todayKey, '开始日期默认应取服务端今天（文档 1.5 / 10.9）');

  await pageA.onTapCreate();
  await waitFor(() => pageA.data.step === 'code', 'A 拿到邀请码');
  const code = String(pageA.data.code || '');
  assert.strictEqual(code.length, 6, '邀请码应为 6 位，实际：' + JSON.stringify(pageA.data.code));
  assert.ok(pageA.data.pending && pageA.data.pending.code === code);
  assert.strictEqual(toasts[toasts.length - 1], '邀请码已生成', '实际 toasts：' + JSON.stringify(toasts));

  // 云函数侧确实落了一条 open 状态的邀请，且 creator 是 A
  const inviteDoc = h.fake().get('bind_invites', code);
  assert.ok(inviteDoc, '邀请应落库');
  assert.strictEqual(inviteDoc.creatorOpenid, A);
  assert.strictEqual(inviteDoc.status, 'open');
  // 页面拿到的开始日期就是提交给云函数的那个
  assert.strictEqual(inviteDoc.startDate, pageA.data.startDate);

  currentOpenid = B;
  const pageB = openPage(BIND);
  pageB.onLoad({ code });
  await waitFor(() => pageB.data.step === 'preview', 'B 进入预览步骤');
  assert.strictEqual(pageB.data.step, 'preview');
  assert.strictEqual(pageB.data.preview.creator.nickname, '小怡');

  await pageB.onTapApply();
  await waitFor(() => pageB.data.step === 'waiting', 'B 进入等待确认');
  assert.strictEqual(pageB.data.bindState, 'applied_by_me');
  assert.strictEqual(pageB.data.pending.other.nickname, '小怡');
  assert.strictEqual(h.fake().get('bind_invites', code).status, 'applied');

  currentOpenid = A;
  pageA.onShow();
  await waitFor(() => pageA.data.step === 'confirm', 'A 收到申请进入确认');
  assert.strictEqual(pageA.data.bindState, 'applied_by_partner');

  await pageA.onTapConfirm();
  await waitFor(() => navs.indexOf(constants.ROUTES.home) >= 0, '确认后回首页', 3000);
  assert.deepStrictEqual(navs, [constants.ROUTES.home]);

  const userA = h.fake().get('users', A);
  const userB = h.fake().get('users', B);
  assert.ok(userA.coupleId, 'A 应写入 coupleId');
  assert.strictEqual(userA.coupleId, userB.coupleId, '双方 coupleId 必须一致');
  const couple = h.fake().get('couples', userA.coupleId);
  assert.deepStrictEqual(couple.memberOpenids, [A, B]);
  assert.strictEqual(couple.startDate, pageA.data.startDate);
  assert.strictEqual(vibrated, 0, '绑定流程不应触发振动（文档 8.9 只用于抱抱/报平安）');

  pageA.onUnload();
  pageB.onUnload();
});

test('首页 ↔ 云函数：绑定后展示服务端聚合的天数、纪念日与门灯', async () => {
  setup();
  await seedBound();
  const page = await openHome(A);
  const server = await ok(A, 'home.get');

  assert.strictEqual(page.data.error, '');
  assert.strictEqual(page.data.home.bind.state, 'bound');
  assert.strictEqual(page.data.myName, '小怡');
  assert.strictEqual(page.data.partnerName, '阿安');
  assert.strictEqual(page.data.myUser.avatarFileID, 'cloud://test-env/avatars/a.png');
  assert.strictEqual(page.data.partnerUser.avatarFileID, 'cloud://test-env/avatars/b.png');
  // 天数/开始日期必须来自 home.get，而不是页面自己算
  assert.strictEqual(page.data.daysText, '第 ' + server.couple.daysTogether + ' 天');
  assert.strictEqual(page.data.startDateText, '2024年5月20日');
  assert.strictEqual(server.todayKey, page.data.maxStartDate);
  assert.ok(server.couple.anniversary, '绑定后应有纪念日');
  // 独立格式化（不复用页面同一个 util），确保页面确实用了服务端下发的日期与天数
  const annParts = server.couple.anniversary.date.split('-');
  const expectedAnniversary = annParts[0] + '年' + Number(annParts[1]) + '月' + Number(annParts[2]) + '日'
    + ' · 还有 ' + server.couple.anniversary.daysLeft + ' 天';
  assert.strictEqual(page.data.anniversaryText, expectedAnniversary);
  // 其它区块：还没人打卡/进房间
  assert.strictEqual(page.data.safetySub, '还没报平安');
  assert.strictEqual(page.data.diarySub, '今天还没写');
  assert.strictEqual(page.data.wishSub, '还没有愿望');
  assert.strictEqual(page.data.moodMine, null);
  assert.strictEqual(page.data.moodPartner, null);
  // 还没加自定义纪念日时只剩「在一起」一张卡
  assert.strictEqual(page.data.cards.length, 1);
  assert.strictEqual(page.data.cards[0].kind, 'together');
  assert.strictEqual(page.data.cards[0].mainText, '第 ' + server.couple.daysTogether + ' 天');
  assert.strictEqual(page.data.shareCode, '');

  page.onUnload();
});

test('心情：A 在首页打卡后，B 的首页看到对方心情', async () => {
  setup();
  await seedBound();

  const pageA = await openHome(A);
  // 冻结静默刷新：确认页面用的是 mood.set 的出参，而不是刷新后的旧数据或本地猜测
  const realLoadMood = pageA.load;
  pageA.load = () => Promise.resolve();
  try {
    await pageA.onMoodSelect({ detail: { mood: 'sunny', note: '今天很开心' } });
  } finally {
    pageA.load = realLoadMood;
  }
  assert.strictEqual(pageA.data.moodSaving, false);
  assert.strictEqual(pageA.data.moodPickerShow, false);
  assert.strictEqual(pageA.data.moodMine.mood, 'sunny');
  assert.strictEqual(pageA.data.moodMine.note, '今天很开心');
  assert.strictEqual(toasts[toasts.length - 1], '今天的心情记下啦', '实际 toasts：' + JSON.stringify(toasts));

  // 服务端确实按服务端今天存了（不是客户端日期）
  const serverHome = await ok(A, 'home.get');
  assert.strictEqual(serverHome.mood.mine.mood, 'sunny');
  assert.strictEqual(serverHome.mood.partner, null, 'A 视角不应有对方心情');

  const pageB = await openHome(B);
  assert.strictEqual(pageB.data.moodMine, null);
  assert.strictEqual(pageB.data.moodPartner.mood, 'sunny');
  assert.strictEqual(pageB.data.moodPartner.note, '今天很开心');

  // 回到 A：先清掉本地状态再重新拉服务端聚合，证明心情确实来自刷新而不是陈旧数据
  currentOpenid = A;
  pageA.setData({ moodMine: null, moodPartner: null });
  await pageA.load(true, true);
  assert.strictEqual(pageA.data.moodMine.mood, 'sunny');
  assert.strictEqual(pageA.data.moodPartner, null);

  pageA.onUnload();
  pageB.onUnload();
});

test('心情记录：A/B 各自打卡后，心情页按天合并双方（页面 ↔ 真实 handler 字段对齐）', async () => {
  setup();
  await seedBound();
  const todayKey = (await ok(A, 'home.get')).todayKey;
  await ok(A, 'mood.set', { mood: 'rainy', note: '今天有点累' });
  await ok(B, 'mood.set', { mood: 'sunny', note: '想你了' });

  currentOpenid = B;
  const page = openPage(MOOD);
  page.onLoad();
  await waitFor(() => !page.data.loading, '心情记录加载完成');
  assert.strictEqual(page.data.todayKey, todayKey, '日期标签要用服务端 todayKey');
  assert.strictEqual(page.data.days.length, 1, '同一天两人合并成一张卡');
  const day = page.data.days[0];
  assert.strictEqual(day.label, '今天');
  assert.deepStrictEqual(day.rows.map((row) => row.who), ['我', 'TA']);
  assert.strictEqual(day.rows[0].mood.label, '晴');
  assert.strictEqual(day.rows[0].mood.note, '想你了');
  assert.strictEqual(day.rows[1].mood.label, '雨');
  assert.strictEqual(day.rows[1].mood.note, '今天有点累');
  assert.strictEqual(page.data.hasMore, false);
});

test('纪念日：A 在管理页添加后，双方首页堆叠多一张卡', async () => {
  setup();
  await seedBound();

  // A 在管理页添加
  currentOpenid = A;
  const managePage = openPage('miniprogram/pages/anniversary/index.js');
  managePage.onLoad();
  await waitFor(() => !managePage.data.loading, '管理页加载');
  assert.deepStrictEqual(managePage.data.items, []);

  managePage.onAdd();
  assert.strictEqual(managePage.data.formOpen, true);
  assert.strictEqual(managePage.data.form.date, cloudTime.dateKeyOf(new Date()), '日期默认服务端今天');
  managePage.onTitleInput({ detail: { value: '第一次见面' } });
  managePage.onDateChange({ detail: { value: '2023-06-01' } });
  await managePage.onSave();
  assert.strictEqual(managePage.data.formOpen, false);
  assert.strictEqual(managePage.data.saving, false);
  assert.strictEqual(managePage.data.items.length, 1);
  assert.strictEqual(managePage.data.items[0].title, '第一次见面');
  assert.ok(managePage.data.items[0].daysText.indexOf('还有') === 0 || managePage.data.items[0].daysText === '就是今天',
    '列表要给出剩余天数：' + managePage.data.items[0].daysText);
  managePage.onUnload();

  // 双方首页都能看到这张卡（同一条数据，剩余天数由服务端算）
  const pageA = await openHome(A);
  assert.strictEqual(pageA.data.cards.length, 2);
  assert.strictEqual(pageA.data.cards[1].label, '第一次见面');
  assert.strictEqual(pageA.data.cards[1].kind, 'custom');
  pageA.onCardChange({ detail: { index: 1 } });
  assert.strictEqual(pageA.data.cardIndex, 1);

  const pageB = await openHome(B);
  assert.strictEqual(pageB.data.cards.length, 2);
  assert.strictEqual(pageB.data.cards[1].label, '第一次见面');

  // B 的管理页也能看到（纪念日是两个人都能改的）
  currentOpenid = B;
  const manageB = openPage('miniprogram/pages/anniversary/index.js');
  manageB.onLoad();
  await waitFor(() => !manageB.data.loading, 'B 管理页加载');
  assert.strictEqual(manageB.data.items.length, 1);

  pageA.onUnload();
  pageB.onUnload();
  manageB.onUnload();
});

test('报平安：A 报平安后 B 的首页门灯亮、门牌显示 TA 到家了', async () => {
  setup();
  await seedBound();
  const pageA = await openHome(A);

  currentOpenid = A;
  const safety = openPage(SAFETY);
  safety.onLoad();
  await waitFor(() => !safety.data.loading && safety.data.todayKey, '报平安页加载完成');
  const serverHome = await ok(A, 'home.get');
  assert.strictEqual(safety.data.todayKey, serverHome.todayKey, '页面日期必须是服务端今天');

  safety.onNoteInput({ detail: { value: '  刚到家  ' } });
  await safety.onCheckin();
  assert.strictEqual(safety.data.checking, false);
  assert.strictEqual(safety.data.note, '', '成功后应清空备注');
  assert.strictEqual(toasts[toasts.length - 1], '我到家了', '实际 toasts：' + JSON.stringify(toasts));
  assert.strictEqual(vibrated, 1, '报平安应轻振动一次');
  assert.strictEqual(safety.data.items.length, 1);
  assert.strictEqual(safety.data.items[0].note, '刚到家');
  assert.ok(safety.data.items[0].checkinId);

  const pageB = await openHome(B);
  assert.strictEqual(pageB.data.safetySub, 'TA 到家了');

  // B 的报平安页能看到 A 的记录（时间线走真实 safety.list）
  currentOpenid = B;
  meUtil.clearMe(); // 同一进程模拟两个账号，清掉单账号会话缓存
  const safetyB = openPage(SAFETY);
  safetyB.onLoad();
  await waitFor(() => !safetyB.data.loading && safetyB.data.items.length === 1, 'B 看到 A 的报平安');
  assert.strictEqual(safetyB.data.items[0].openid, A);
  assert.strictEqual(safetyB.data.items[0].note, '刚到家');

  pageA.onUnload();
  pageB.onUnload();
});

test('日记：A 写完当天日记后，B 的首页只看到「写了」，正文不可读', async () => {
  setup();
  await seedBound();
  const pageA = await openHome(A);

  currentOpenid = A;
  const diaryA = openPage(DIARY);
  diaryA.onLoad();
  await waitFor(() => !diaryA.data.loading && diaryA.data.todayKey, '日记页加载完成');
  const serverHome = await ok(A, 'home.get');
  assert.strictEqual(diaryA.data.todayKey, serverHome.todayKey);
  assert.strictEqual(diaryA.data.content, '');

  diaryA.onContentInput({ detail: { value: '今天很开心' } });
  assert.strictEqual(diaryA.data.canSave, true);
  await diaryA.onSave();
  assert.strictEqual(diaryA.data.saving, false);
  assert.strictEqual(toasts[toasts.length - 1], '明天 TA 才能看到', '实际 toasts：' + JSON.stringify(toasts));
  assert.strictEqual(diaryA.data.items.length, 1);
  assert.strictEqual(diaryA.data.items[0].mine.content, '今天很开心');
  assert.strictEqual(diaryA.data.items[0].date, diaryA.data.todayKey);

  // 云函数侧按「服务端今天 + _id」落库，幂等覆盖同一天
  const listA = await ok(A, 'diary.list', { limit: 10 });
  assert.strictEqual(listA.items[0].mine.content, '今天很开心');
  assert.strictEqual(listA.todayKey, diaryA.data.todayKey);

  const pageB = await openHome(B);
  assert.strictEqual(pageB.data.diarySub, 'TA 写了，明天就能看', 'B 没写、A 写了未解锁，摘要要说清');
  const homeB = await ok(B, 'home.get');
  assert.strictEqual(homeB.diary.mineWritten, false);
  assert.strictEqual(homeB.diary.partnerWritten, true);
  assert.strictEqual(homeB.diary.partnerUnlocked, false);

  currentOpenid = B;
  const diaryB = openPage(DIARY);
  diaryB.onLoad();
  await waitFor(() => !diaryB.data.loading && diaryB.data.items.length === 1, 'B 的日记页加载当天卡片');
  assert.strictEqual(diaryB.data.items[0].partnerWritten, true);
  assert.strictEqual(diaryB.data.items[0].partnerUnlocked, false);
  assert.strictEqual(diaryB.data.items[0].partner, null, '未解锁不能下发对方正文');
  assert.strictEqual(diaryB.data.content, '', 'B 的编辑器不能带出 A 的内容');

  // 昨天那条已过解锁时刻：B 重新加载时能看到 A 的正文（跨天解锁走真实 diary.list）
  const todayKey = homeB.todayKey;
  const yesterdayKey = cloudTime.addDays(todayKey, -1);
  const unlockAt = new Date(Date.parse(yesterdayKey + 'T00:00:00+08:00')).toISOString();
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  await h.fake().db.collection('diaries').doc(A + '_' + yesterdayKey).set({
    data: {
      coupleId: h.fake().get('users', A).coupleId,
      authorOpenid: A,
      date: yesterdayKey,
      content: '昨天的秘密',
      unlockAt,
      createdAt: yesterday,
      updatedAt: yesterday,
    },
  });

  const diaryB2 = openPage(DIARY);
  diaryB2.onLoad();
  await waitFor(() => !diaryB2.data.loading && diaryB2.data.items.length === 2, 'B 看到昨天已解锁的日记');
  const yesterdayItem = diaryB2.data.items.find((item) => item.date === yesterdayKey);
  assert.ok(yesterdayItem, '昨天卡片应存在');
  assert.strictEqual(yesterdayItem.partnerUnlocked, true);
  assert.strictEqual(yesterdayItem.partner.content, '昨天的秘密', '已解锁的日记 B 应能读到正文');
  assert.strictEqual(yesterdayItem.mine, null);

  pageA.onUnload();
  pageB.onUnload();
});

test('愿望：A 新增愿望后，B 的首页统计与愿望页都能看到，打勾后双方同步', async () => {
  setup();
  await seedBound();
  const pageA = await openHome(A);

  currentOpenid = A;
  const wishA = openPage(WISH);
  wishA.onLoad();
  await waitFor(() => !wishA.data.loading, '愿望页加载完成');
  assert.strictEqual(wishA.data.progressText, '0/0');

  wishA.onAdd();
  assert.strictEqual(wishA.data.showEditor, true);
  wishA.onTitleInput({ detail: { value: '  去看海  ' } });
  wishA.onNoteInput({ detail: { value: '夏天' } });
  // setData 路径键：真机支持 'form.title'，夹具也要能写到嵌套字段
  assert.strictEqual(wishA.data.form.title, '  去看海  ');
  await wishA.onSaveWish();
  assert.strictEqual(wishA.data.showEditor, false);
  assert.strictEqual(wishA.data.items.length, 1);
  assert.strictEqual(wishA.data.items[0].title, '去看海');
  assert.strictEqual(wishA.data.progressText, '0/1');
  const wishId = wishA.data.items[0].wishId;
  assert.ok(wishId, '愿望应带 wishId');

  const pageB = await openHome(B);
  assert.strictEqual(pageB.data.wishSub, '0/1 完成');

  currentOpenid = B;
  const wishB = openPage(WISH);
  wishB.onLoad();
  await waitFor(() => wishB.data.items.length === 1, 'B 看到 A 的愿望');
  assert.strictEqual(wishB.data.items[0].wishId, wishId);
  assert.strictEqual(wishB.data.items[0].title, '去看海');

  await wishB.onToggle({ detail: { wishId, done: true } });
  assert.strictEqual(wishB.data.items[0].done, true);
  assert.strictEqual(wishB.data.progressText, '1/1');

  // A 回首页：统计同步，全部完成后便签预览为空
  currentOpenid = A;
  pageA.onShow();
  await waitFor(() => pageA.data.wishSub === '1/1 完成', 'A 首页统计同步');
  assert.strictEqual(pageA.data.wishSub, '1/1 完成');

  pageA.onUnload();
  pageB.onUnload();
});
test('报平安：10 分钟内重复点击走 deduped 分支，不新增记录也不重复振动', async () => {
  setup();
  await seedBound();
  currentOpenid = A;
  const page = openPage(SAFETY);
  page.onLoad();
  await waitFor(() => !page.data.loading && page.data.todayKey, '报平安页加载完成');

  page.onNoteInput({ detail: { value: '第一次' } });
  await page.onCheckin();
  assert.strictEqual(page.data.items.length, 1);
  const firstId = page.data.items[0].checkinId;
  const vibratedOnce = vibrated;

  page.onNoteInput({ detail: { value: '第二次' } });
  await page.onCheckin();
  assert.strictEqual(toasts[toasts.length - 1], '刚刚已经报过平安', '实际 toasts：' + JSON.stringify(toasts));
  assert.strictEqual(page.data.note, '', '去重也要清空备注');
  assert.strictEqual(page.data.items.length, 1, '去重不能新增记录');
  assert.strictEqual(page.data.items[0].checkinId, firstId);
  assert.strictEqual(vibrated, vibratedOnce, '去重不应再振动');

  const list = await ok(A, 'safety.list', { limit: 10 });
  assert.strictEqual(list.items.length, 1, '云函数侧也只应有一条');
  assert.strictEqual(list.items[0].note, '第一次', '重复点击不能覆盖原备注');
});

test('纪念日：B 删掉 A 正在看的那张后，A 刷新时堆叠回到第一张', async () => {
  setup();
  await seedBound();

  const first = await ok(A, 'anniversary.add', { title: '第一次见面', date: '2023-06-01' });
  const second = await ok(A, 'anniversary.add', { title: '她的生日', date: '2019-11-16' });
  assert.strictEqual(second.items.length, 2);

  const pageA = await openHome(A);
  assert.strictEqual(pageA.data.cards.length, 3);
  pageA.onCardChange({ detail: { index: 2 } });
  assert.strictEqual(pageA.data.cardIndex, 2);

  // B 把 A 正在看的那张删了（另一台设备）
  currentOpenid = B;
  await ok(B, 'anniversary.remove', { anniversaryId: second.items[1].anniversaryId });
  await ok(B, 'anniversary.remove', { anniversaryId: first.item.anniversaryId });

  // A 回到前台静默刷新：只剩「在一起」，下标夹回 0
  currentOpenid = A;
  await pageA.load(true, true);
  assert.strictEqual(pageA.data.cards.length, 1);
  assert.strictEqual(pageA.data.cardIndex, 0);

  pageA.onUnload();
});

test('记账本：A 记一笔后 B 切到 TA 的账本能看到，B 改不了别人的账', async () => {
  setup();
  await seedBound();
  const todayKey = cloudTime.dateKeyOf(new Date());

  currentOpenid = A;
  const page = openPage('miniprogram/pages/ledger/index.js');
  page.onLoad();
  await waitFor(() => !page.data.loading, 'A 记账本加载');
  assert.strictEqual(page.data.month, todayKey.slice(0, 7), '默认月份必须与服务端 todayKey 一致');
  assert.strictEqual(page.data.maxDate, todayKey, '日期选择上限是服务端今天');

  page.onOpenForm();
  page.onAmountInput({ detail: { value: '23.5' } });
  page.onPickCategory({ currentTarget: { dataset: { key: 'food' } } });
  page.onNoteInput({ detail: { value: '牛肉面' } });
  await page.onSaveEntry();
  await waitFor(() => page.data.groups.length === 1, '记完一笔后列表出现记录');
  assert.strictEqual(page.data.summaryText, '¥23.50');
  assert.strictEqual(page.data.summaryCount, 1);
  assert.strictEqual(page.data.groups[0].totalText, '¥23.50');
  const entryId = page.data.groups[0].items[0].entryId;
  assert.strictEqual(h.fake().get('ledger_entries', entryId).amount, 2350, '落库金额必须是整数分');

  currentOpenid = B;
  const pageB = openPage('miniprogram/pages/ledger/index.js');
  pageB.onLoad();
  await waitFor(() => !pageB.data.loading, 'B 记账本加载');
  assert.deepStrictEqual(pageB.data.groups, [], 'B 自己的账本应为空');

  pageB.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
  await waitFor(() => pageB.data.groups.length === 1, 'B 切到 TA 的账本看到记录');
  assert.strictEqual(pageB.data.groups[0].items[0].note, '牛肉面');
  assert.strictEqual(pageB.data.groups[0].items[0].amountText, '¥23.50');
  assert.strictEqual(pageB.data.summaryLabel, '小怡这个月花了', '看对方账本时用对方昵称');

  pageB.onTapEntry({ currentTarget: { dataset: { id: entryId } } });
  assert.strictEqual(pageB.data.formOpen, false, 'TA 的账不打开编辑表单');
  assert.strictEqual(toasts[toasts.length - 1], 'TA 的账本只能看');

  // 绕过页面直接调接口也会被服务端拒绝
  currentOpenid = B;
  const res = await h.callAs(B, 'ledger.update', { entryId, amount: 1 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'FORBIDDEN');
  assert.strictEqual(h.fake().get('ledger_entries', entryId).amount, 2350);

  page.onUnload();
  pageB.onUnload();
});

test('解绑：A 在我的页申请，B 首页出现提示，B 确认后双方回到未绑定', async () => {
  setup();
  await seedBound();

  currentOpenid = A;
  const profileA = openPage('miniprogram/pages/profile/index.js');
  profileA.onShow();
  await waitFor(() => !profileA.data.loading, 'A 资料页加载');
  assert.strictEqual(profileA.data.unbindStatus, 'none');
  assert.strictEqual(profileA.data.unbindText, '解绑');

  profileA.onTapUnbind(); // showModal 桩自动确认
  await waitFor(() => profileA.data.unbindStatus === 'pending_me', 'A 发起解绑后进入等待');
  assert.strictEqual(profileA.data.unbindText, '等 TA 确认解绑（点击撤回）');

  const homeB = await openHome(B);
  assert.strictEqual(homeB.data.unbindNotice, true, 'B 首页要出现解绑提示条');
  assert.match(homeB.data.unbindNoticeText, /TA 申请了解绑/);
  homeB.onTapUnbindNotice();
  assert.strictEqual(navs[navs.length - 1], constants.ROUTES.profile, '提示条点了去「我的」');
  homeB.onUnload();

  currentOpenid = B;
  const profileB = openPage('miniprogram/pages/profile/index.js');
  profileB.onShow();
  await waitFor(() => !profileB.data.loading, 'B 资料页加载');
  assert.strictEqual(profileB.data.unbindStatus, 'pending_partner');
  assert.strictEqual(profileB.data.unbindText, 'TA 申请解绑（点击确认）');

  profileB.onTapUnbind();
  await waitFor(() => navs.indexOf(constants.ROUTES.home) >= 0, '确认解绑后回首页', 3000);
  assert.strictEqual(h.fake().get('users', A).coupleId, null);
  assert.strictEqual(h.fake().get('users', B).coupleId, null);
  assert.strictEqual(h.fake().all('couples')[0].status, 'closed');

  // 回到首页是未绑定视图，且没有解绑提示残留
  const homeA = await openHome(A);
  assert.strictEqual(homeA.data.home.couple, null);
  assert.strictEqual(homeA.data.unbindNotice, false);
  homeA.onUnload();

  profileA.onUnload();
  profileB.onUnload();
});
