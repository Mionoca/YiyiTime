'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, loadPage, instantiate } = require('./helpers/client-page');
const timeUtil = require('../miniprogram/utils/time');

// 固定服务端时间：东八区 2026-11-16 14:30，避免用例随本机时间漂移
const NOW = '2026-11-16T06:30:00.000Z';
const config = loadPage('miniprogram/pages/home/index.js');

function baseHome(overrides) {
  const home = {
    serverNow: NOW,
    todayKey: '2026-11-16',
    phase: 'day',
    user: { openid: 'oA', nickname: '小怡', avatarFileID: 'cloud://env/avatars/a.png' },
    bind: { state: 'bound', pending: null },
    couple: {
      coupleId: 'c_1',
      startDate: '2024-05-20',
      daysTogether: 911,
      anniversary: { date: '2027-05-20', daysLeft: 185 },
    },
    partner: { openid: 'oB', nickname: '阿安', avatarFileID: 'cloud://env/avatars/b.png' },
    mood: {
      mine: { mood: 'sunny', note: '今天很好', updatedAt: NOW },
      partner: { mood: 'rainy', note: '有点累', updatedAt: NOW },
    },
    hug: { incoming: null, outgoing: null },
    safety: { mineToday: true, partnerToday: true, partnerLastAt: NOW },
    diary: { mineWritten: true, partnerWritten: true, partnerUnlocked: false, unlockAt: '' },
    wish: { total: 3, done: 1, previewTitle: '去看海' },
  };
  return Object.assign(home, overrides);
}

test('derive: 已绑定首页聚合出天数、纪念日、双方资料与四块场景状态', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome());
  assert.strictEqual(patch.daysText, '第 911 天');
  assert.strictEqual(patch.startDateText, '2024年5月20日');
  assert.strictEqual(patch.anniversaryText, '2027年5月20日 · 还有 185 天');
  assert.strictEqual(patch.startDateSelect, '2024-05-20');
  assert.strictEqual(patch.maxStartDate, '2026-11-16');
  assert.strictEqual(patch.myName, '小怡');
  assert.strictEqual(patch.myAvatar, 'cloud://env/avatars/a.png');
  assert.strictEqual(patch.partnerName, '阿安');
  // 头像气泡直接吃 user/partner 对象（wxml 的 myUser/partnerUser），映射也要断言
  assert.deepStrictEqual(patch.myUser, baseHome().user);
  assert.deepStrictEqual(patch.partnerUser, baseHome().partner);
  assert.deepStrictEqual(patch.moodMine, { mood: 'sunny', note: '今天很好', updatedAt: NOW });
  assert.strictEqual(patch.moodPartner.mood, 'rainy');
  assert.strictEqual(patch.bindHint, '');
  // 门：对方今天报过平安 → 灯暖 + 「TA 到家了」
  assert.strictEqual(patch.doorLit, true);
  assert.strictEqual(patch.safetyLabel, 'TA 到家了');
  // 台灯：我写了今天 → 灯亮；TA 写了但没解锁 → 小光点
  assert.strictEqual(patch.lampDim, false);
  assert.strictEqual(patch.lampDot, true);
  // 冰箱贴纸与桌子便签
  assert.strictEqual(patch.wishTotal, 3);
  assert.strictEqual(patch.wishDone, 1);
  assert.strictEqual(patch.wishPreviewTitle, '去看海');
  assert.strictEqual(patch.shareCode, '');
});

test('derive: 把 hug.incoming/outgoing 映射进页面 data 并接到 9.4 抱抱状态', () => {
  const page = instantiate(config);
  const incoming = { hugId: 'h2', status: 'pending', createdAt: NOW };
  const outgoing = { hugId: 'h1', status: 'hugged', respondedAt: NOW };
  const patch = page.derive(baseHome({ hug: { incoming, outgoing } }));
  // 页面横幅/按钮直接读这两个字段（wxml 的 hugIncoming/hugOutgoing），必须原样透出
  assert.deepStrictEqual(patch.hugIncoming, incoming);
  assert.deepStrictEqual(patch.hugOutgoing, outgoing);
  assert.strictEqual(patch.hugButtonText, '抱抱 TA');
  assert.strictEqual(patch.hugButtonDisabled, false);
  assert.strictEqual(patch.hugHint, 'TA 现在需要抱抱');

  const waiting = page.derive(baseHome({
    hug: { incoming: null, outgoing: Object.assign({}, outgoing, { status: 'pending', respondedAt: null }) },
  }));
  assert.strictEqual(waiting.hugIncoming, null);
  assert.strictEqual(waiting.hugButtonText, '等 TA 抱抱');
  assert.strictEqual(waiting.hugButtonDisabled, true);

  // 10.3：hug 整块查询失败降级为 null 时按「没有抱抱」渲染，不能抛错
  const degraded = page.derive(baseHome({ hug: null }));
  assert.strictEqual(degraded.hugIncoming, null);
  assert.strictEqual(degraded.hugOutgoing, null);
  assert.strictEqual(degraded.hugButtonText, '我需要抱抱');
});

test('derive: 服务端没给纪念日时兜底为「开始那天就是纪念日」', () => {
  const page = instantiate(config);
  const home = baseHome();
  home.couple = Object.assign({}, home.couple, { anniversary: null });
  const patch = page.derive(home);
  assert.strictEqual(patch.anniversaryText, '开始那天就是纪念日');
});

test('derive: 对方今天没报平安时门牌回退到最近一次（昨天/更早），灯不亮', () => {
  const page = instantiate(config);
  const yesterday = new Date(Date.parse(NOW) - 26 * 3600 * 1000).toISOString();
  let patch = page.derive(baseHome({ safety: { mineToday: true, partnerToday: false, partnerLastAt: yesterday } }));
  assert.strictEqual(patch.doorLit, false);
  assert.strictEqual(patch.safetyLabel, 'TA 昨天');

  const older = new Date(Date.parse(NOW) - 4 * 86400 * 1000).toISOString();
  patch = page.derive(baseHome({ safety: { mineToday: true, partnerToday: false, partnerLastAt: older } }));
  assert.strictEqual(patch.safetyLabel, 'TA 11月12日');

  // 伴侣从没报过平安
  patch = page.derive(baseHome({ safety: { mineToday: true, partnerToday: false, partnerLastAt: null } }));
  assert.strictEqual(patch.safetyLabel, '还没报平安');

  // 必须用服务端 serverNow 而不是本机 Date.now：把服务端时间拨后两天，同一条记录应显示具体日期。
  // 若忽略 serverNow，运行当天恰好等于 NOW 时会得到「14 小时前」，换个日子又变成别的值（脆弱）。
  const twoDaysLater = new Date(Date.parse(NOW) + 2 * 86400 * 1000).toISOString();
  patch = page.derive(baseHome({
    serverNow: twoDaysLater,
    safety: { mineToday: false, partnerToday: false, partnerLastAt: NOW },
  }));
  assert.strictEqual(patch.safetyLabel, 'TA 11月16日');
});

test('derive: 未绑定显示空日历、门牌留白、台灯暗，不泄漏对方字段', () => {
  const page = instantiate(config);
  const patch = page.derive({
    serverNow: NOW,
    todayKey: '2026-11-16',
    phase: 'night',
    user: { openid: 'oA', nickname: '', avatarFileID: '' },
    bind: { state: 'unbound', pending: null },
    couple: null,
    partner: null,
    mood: null,
    hug: null,
    safety: null,
    diary: null,
    wish: null,
  });
  assert.strictEqual(patch.daysText, '');
  assert.strictEqual(patch.startDateText, '');
  assert.strictEqual(patch.anniversaryText, '');
  assert.strictEqual(patch.safetyLabel, '');
  assert.strictEqual(patch.doorLit, false);
  assert.strictEqual(patch.lampDim, true);
  assert.strictEqual(patch.lampDot, false);
  assert.strictEqual(patch.myName, '我');
  assert.strictEqual(patch.myAvatar, '/images/avatars/default.png');
  assert.strictEqual(patch.partnerName, 'TA');
  assert.strictEqual(patch.phase, 'night');
  assert.strictEqual(patch.wishTotal, 0);
  assert.strictEqual(patch.wishPreviewTitle, '');
  // 未绑定/无数据时头像气泡与心情不能渲染出别人的数据
  assert.strictEqual(patch.myUser.openid, 'oA');
  assert.strictEqual(patch.partnerUser, null);
  assert.strictEqual(patch.moodMine, null);
  assert.strictEqual(patch.moodPartner, null);
});

test('derive: phase 缺省按 day，todayKey 缺省时 maxStartDate 退回本机日期', () => {
  const page = instantiate(config);
  const home = baseHome();
  delete home.phase;
  delete home.todayKey;
  const patch = page.derive(home);
  assert.strictEqual(patch.phase, 'day');
  // 正常路径服务端一定给 todayKey；取不到时才退回本机（东八区）日期。
  // 这里读真实时钟，跨东八区 00:00 的毫秒级窗口理论上会偶发红，可接受。
  assert.strictEqual(patch.maxStartDate, timeUtil.todayKey());
});

test('derive: 三个聚合块查询失败降级为 null 时不白屏', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({ safety: null, diary: null, wish: null }));
  assert.strictEqual(patch.doorLit, false);
  assert.strictEqual(patch.safetyLabel, '还没报平安');
  // diary 缺失时按「今天没写」处理，台灯暗
  assert.strictEqual(patch.lampDim, true);
  assert.strictEqual(patch.lampDot, false);
  assert.strictEqual(patch.wishTotal, 0);
  assert.strictEqual(patch.wishDone, 0);
  assert.strictEqual(patch.wishPreviewTitle, '');
});

test('derive: 只有自己刚创建的邀请码才进分享路径，applied 阶段的码不外传', () => {
  const page = instantiate(config);
  const codeCreated = page.derive(baseHome({
    bind: { state: 'code_created', pending: { code: '123456' } },
    couple: null,
    partner: null,
  }));
  assert.strictEqual(codeCreated.shareCode, '123456');
  assert.strictEqual(codeCreated.bindHint, '等 TA 输入邀请码');

  const appliedByMe = page.derive(baseHome({
    bind: { state: 'applied_by_me', pending: { code: '123456' } },
    couple: null,
    partner: null,
  }));
  assert.strictEqual(appliedByMe.shareCode, '');
  assert.strictEqual(appliedByMe.bindHint, '等 TA 确认 · 点这里看看');

  const appliedByPartner = page.derive(baseHome({
    bind: { state: 'applied_by_partner', pending: { code: '123456' } },
    couple: null,
    partner: null,
  }));
  assert.strictEqual(appliedByPartner.shareCode, '');
  assert.strictEqual(appliedByPartner.bindHint, '有人在等你 · 点这里去确认');
});

test('deriveHugState: 按文档 9.4 的抱抱状态矩阵给按钮文案与提示', () => {
  const page = instantiate(config);
  const base = { hugIncoming: null, hugOutgoing: null, daysText: '第 911 天' };
  assert.deepStrictEqual(page.deriveHugState(base), {
    hugButtonText: '我需要抱抱',
    hugButtonDisabled: false,
    hugHint: '第 911 天 · 一起的日子还在继续',
  });
  assert.deepStrictEqual(page.deriveHugState(Object.assign({}, base, {
    hugOutgoing: { hugId: 'h1', status: 'pending' },
  })), {
    hugButtonText: '等 TA 抱抱',
    hugButtonDisabled: true,
    hugHint: '抱抱已经送出去啦，等 TA 回应',
  });
  assert.deepStrictEqual(page.deriveHugState(Object.assign({}, base, {
    hugOutgoing: { hugId: 'h1', status: 'hugged' },
  })), {
    hugButtonText: '再抱一次',
    hugButtonDisabled: false,
    hugHint: '第 911 天 · TA 抱了你',
  });
  assert.deepStrictEqual(page.deriveHugState(Object.assign({}, base, {
    hugOutgoing: { hugId: 'h1', status: 'expired' },
  })), {
    hugButtonText: '我需要抱抱',
    hugButtonDisabled: false,
    hugHint: '上次抱抱过期了，再抱一次吧',
  });
  // 对方需要抱抱时优先展示「抱抱 TA」，即使我这边还有一个 pending
  assert.deepStrictEqual(page.deriveHugState(Object.assign({}, base, {
    hugIncoming: { hugId: 'h2', status: 'pending' },
    hugOutgoing: { hugId: 'h1', status: 'pending' },
  })), {
    hugButtonText: '抱抱 TA',
    hugButtonDisabled: false,
    hugHint: 'TA 现在需要抱抱',
  });
  // 未知状态按「可以再发」处理
  assert.strictEqual(page.deriveHugState(Object.assign({}, base, {
    hugOutgoing: { hugId: 'h1', status: 'cancelled' },
  })).hugButtonText, '我需要抱抱');
  // 未绑定时没有天数，提示不拼「第 N 天」
  assert.strictEqual(page.deriveHugState({ hugIncoming: null, hugOutgoing: null, daysText: '' }).hugHint, '一起的日子还在继续');
});

test('maybeCelebrate: 同一个 hugId 只播一次心形，换 hugId 才再播', () => {
  const store = {};
  installWx({
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value; },
  });
  const page = instantiate(config);
  let plays = 0;
  page.playHugCelebrate = () => { plays += 1; };
  const home = { hug: { outgoing: { hugId: 'h_abc', status: 'hugged' } } };
  page.maybeCelebrate(home);
  assert.strictEqual(plays, 1);
  page.maybeCelebrate(home);
  assert.strictEqual(plays, 1);

  // 新的页面实例也能从 storage 知道已经播过
  const page2 = instantiate(config);
  page2.playHugCelebrate = () => { plays += 1; };
  page2.maybeCelebrate(home);
  assert.strictEqual(plays, 1);

  page2.maybeCelebrate({ hug: { outgoing: { hugId: 'h_new', status: 'hugged' } } });
  assert.strictEqual(plays, 2);
});

test('maybeCelebrate: 对方没回应 / 没有 hugId 时不播', () => {
  installWx({ getStorageSync: () => [], setStorageSync: () => {} });
  const page = instantiate(config);
  let plays = 0;
  page.playHugCelebrate = () => { plays += 1; };
  page.maybeCelebrate(null);
  page.maybeCelebrate({});
  page.maybeCelebrate({ hug: { outgoing: { hugId: 'h1', status: 'pending' } } });
  page.maybeCelebrate({ hug: { outgoing: { status: 'hugged' } } });
  assert.strictEqual(plays, 0);
});

test('markHugSeen: storage 只保留最近 20 个 hugId', () => {
  const store = {};
  installWx({
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value; },
  });
  const page = instantiate(config);
  for (let i = 1; i <= 25; i += 1) page.markHugSeen('h' + i);
  const seen = store.hug_seen_ids;
  assert.strictEqual(seen.length, 20);
  assert.strictEqual(seen[0], 'h6');
  assert.strictEqual(seen[19], 'h25');
  assert.strictEqual(page.hasSeenHug('h25'), true);
});

test('hasSeenHug: storage 不可用时用内存兜底，不会每次刷新重播', () => {
  installWx({
    getStorageSync() { throw new Error('storage unavailable'); },
    setStorageSync() { throw new Error('storage unavailable'); },
  });
  const page = instantiate(config);
  assert.strictEqual(page.hasSeenHug('h1'), false);
  page.markHugSeen('h1');
  assert.strictEqual(page.hasSeenHug('h1'), true);
});

test('分享：已绑定分享小屋，未绑定分享邀请（带码时直达绑定页），朋友圈不带路径', () => {
  const page = instantiate(config);
  page.data.home = baseHome();
  const bound = page.onShareAppMessage();
  assert.deepStrictEqual(bound, { title: '我的小屋，今天也在等你', path: '/pages/home/index' });
  // 已绑定的朋友圈分享走 bound 分支，且固定分享当前页（不带 path/query）
  const boundTimeline = page.onShareTimeline();
  assert.deepStrictEqual(boundTimeline, { title: '我的小屋，今天也在等你' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(boundTimeline, 'path'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(boundTimeline, 'query'), false);

  page.data.home = baseHome({ couple: null, partner: null, bind: { state: 'code_created', pending: { code: '654321' } } });
  page.data.shareCode = '654321';
  assert.deepStrictEqual(page.onShareAppMessage(), {
    title: '来和我一起住进小怡怡安',
    path: '/pages/bind/index?code=654321',
  });

  // 搜索发现：邀请码只走聊天卡片；朋友圈即使 data 里有码也不带路径/query（文档 11.5 不公开贴码）
  const codeTimeline = page.onShareTimeline();
  assert.deepStrictEqual(codeTimeline, { title: '来和我一起住进小怡怡安' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(codeTimeline, 'path'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(codeTimeline, 'query'), false);

  page.data.shareCode = '';
  assert.deepStrictEqual(page.onShareAppMessage(), {
    title: '来和我一起住进小怡怡安',
    path: '/pages/bind/index',
  });
});

test('derive: 服务端把脏 startDate 降级为 null 时，天数/开始日/纪念日都不渲染（不出现「第 null 天」）', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({
    couple: { coupleId: 'c_1', startDate: null, daysTogether: null, anniversary: null },
  }));
  assert.strictEqual(patch.daysText, '');
  assert.strictEqual(patch.startDateText, '');
  assert.strictEqual(patch.anniversaryText, '');
  // startDate 为 null 时选择器回显也是 null（wxml 的 picker value 接受 null/空）
  assert.strictEqual(patch.startDateSelect, null);
  assert.strictEqual(String(patch.hugHint || '').includes('null'), false);
  assert.strictEqual(String(patch.calendarSub || '').includes('null'), false);
});

test('derive: 只有 startDate 没有纪念日时仍提示「开始那天就是纪念日」', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({
    couple: { coupleId: 'c_1', startDate: '2026-11-16', daysTogether: 1, anniversary: null },
  }));
  assert.strictEqual(patch.daysText, '第 1 天');
  assert.strictEqual(patch.anniversaryText, '开始那天就是纪念日');
});
