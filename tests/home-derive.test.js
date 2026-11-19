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
    anniversary: {
      items: [
        // 服务端已按剩余天数升序：近的在前
        { anniversaryId: 'a_1', title: '第一次见面', date: '2023-06-01', nextDate: '2027-06-01', daysLeft: 197, years: 4 },
        { anniversaryId: 'a_2', title: '她的生日', date: '2019-11-16', nextDate: '2026-11-16', daysLeft: 0, years: 7 },
      ],
    },
    diary: { mineWritten: true, partnerWritten: true, partnerUnlocked: false, unlockAt: '' },
    wish: { total: 3, done: 1, previewTitle: '去看海' },
  };
  return Object.assign(home, overrides);
}

test('derive: 已绑定首页聚合出日子卡与双方资料（文档 9.2 / 9.10）', () => {
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
  assert.strictEqual(patch.shareCode, '');
});

test('derive: 心情卡只给「一个字 + 备注」，没打卡是「还没说」（文档 9.5）', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome());
  assert.deepStrictEqual(patch.moodMine, { mood: 'sunny', note: '今天很好', updatedAt: NOW });
  assert.strictEqual(patch.moodPartner.mood, 'rainy');
  assert.strictEqual(patch.moodMineText, '晴 · 今天很好');
  assert.strictEqual(patch.moodPartnerText, '雨 · 有点累');

  // 没备注时不留「 · 」尾巴
  const noNote = page.derive(baseHome({ mood: { mine: { mood: 'cloudy', note: '' }, partner: null } }));
  assert.strictEqual(noNote.moodMineText, '阴');
  assert.strictEqual(noNote.moodPartnerText, '还没说');

  // 脏数据（未知 mood）按没打卡处理，不能把 key 原样吐到界面上
  const dirty = page.derive(baseHome({ mood: { mine: { mood: 'typhoon', note: 'x' }, partner: {} } }));
  assert.strictEqual(dirty.moodMineText, '还没说');
  assert.strictEqual(dirty.moodPartnerText, '还没说');
});

test('derive: 入口的状态摘要（日记 / 愿望，M14 起报平安下线）', () => {
  const page = instantiate(config);

  const both = page.derive(baseHome());
  assert.strictEqual(both.diarySub, '你写了，TA 的还没解锁');
  assert.strictEqual(both.wishSub, '1/3 完成');

  const unlocked = page.derive(baseHome({
    diary: { mineWritten: true, partnerWritten: true, partnerUnlocked: true },
  }));
  assert.strictEqual(unlocked.diarySub, '你们都写了今天');

  const mineOnly = page.derive(baseHome({
    diary: { mineWritten: true, partnerWritten: false, partnerUnlocked: false },
  }));
  assert.strictEqual(mineOnly.diarySub, '你写了，等 TA');

  const partnerOnly = page.derive(baseHome({
    diary: { mineWritten: false, partnerWritten: true, partnerUnlocked: false },
  }));
  assert.strictEqual(partnerOnly.diarySub, 'TA 写了，到时间就能看');

  const partnerUnlocked = page.derive(baseHome({
    diary: { mineWritten: false, partnerWritten: true, partnerUnlocked: true },
  }));
  assert.strictEqual(partnerUnlocked.diarySub, 'TA 写了，去看看');

  const neither = page.derive(baseHome({
    diary: { mineWritten: false, partnerWritten: false, partnerUnlocked: false },
    wish: { total: 0, done: 0 },
  }));
  assert.strictEqual(neither.diarySub, '今天还没写');
  assert.strictEqual(neither.wishSub, '还没有愿望');
});

test('derive: 聚合块查询失败降级为 null 时不白屏（10.3）', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({ diary: null, wish: null }));
  assert.strictEqual(patch.diarySub, '今天还没写');
  assert.strictEqual(patch.wishSub, '还没有愿望');
  assert.strictEqual(patch.moodMineText, '晴 · 今天很好', '心情区块不受影响');
});

test('derive: 未绑定只给邀请卡文案，不泄漏对方字段（文档 9.12）', () => {
  const page = instantiate(config);
  const patch = page.derive({
    serverNow: NOW,
    todayKey: '2026-11-16',
    user: { openid: 'oA', nickname: '', avatarFileID: '' },
    bind: { state: 'unbound', pending: null },
    couple: null,
    partner: null,
    mood: null,
    anniversary: null,
    diary: null,
    wish: null,
  });
  assert.strictEqual(patch.daysText, '');
  assert.strictEqual(patch.startDateText, '');
  assert.strictEqual(patch.anniversaryText, '');
  assert.strictEqual(patch.diarySub, '等 TA 住进来');
  assert.strictEqual(patch.myName, '我');
  assert.strictEqual(patch.myAvatar, '/images/avatars/default.png');
  assert.strictEqual(patch.partnerName, 'TA');
  assert.strictEqual(patch.myUser.openid, 'oA');
  assert.strictEqual(patch.partnerUser, null);
  assert.strictEqual(patch.moodMine, null);
  assert.strictEqual(patch.moodPartner, null);
  assert.strictEqual(patch.bindTitle, '屋里还缺一个人');
  assert.strictEqual(patch.bindSub, '邀请 TA 一起住进来，日子从你们选的那天算起');
  assert.strictEqual(patch.bindActionText, '邀请 TA 住进来');
});

test('derive: 邀请中三种状态的标题与按钮（文档 9.12）', () => {
  const page = instantiate(config);
  const cases = [
    ['code_created', '邀请码已经备好啦', '去看看'],
    ['applied_by_me', '等 TA 确认', '去看看'],
    ['applied_by_partner', '有人在等你', '去看看'],
  ];
  for (const [state, title, action] of cases) {
    const patch = page.derive(baseHome({ couple: null, partner: null, bind: { state, pending: { code: '123456' } } }));
    assert.strictEqual(patch.bindTitle, title, state + ' 的标题不对');
    assert.strictEqual(patch.bindActionText, action, state + ' 的按钮不对');
    assert.ok(patch.bindSub.length > 0, state + ' 缺副文案');
  }
});

test('derive: 只有自己刚创建的邀请码才进分享路径，applied 阶段的码不外传（11.5）', () => {
  const page = instantiate(config);
  const codeCreated = page.derive(baseHome({
    bind: { state: 'code_created', pending: { code: '123456' } },
    couple: null,
    partner: null,
  }));
  assert.strictEqual(codeCreated.shareCode, '123456');

  const appliedByMe = page.derive(baseHome({
    bind: { state: 'applied_by_me', pending: { code: '123456' } },
    couple: null,
    partner: null,
  }));
  assert.strictEqual(appliedByMe.shareCode, '');

  const appliedByPartner = page.derive(baseHome({
    bind: { state: 'applied_by_partner', pending: { code: '123456' } },
    couple: null,
    partner: null,
  }));
  assert.strictEqual(appliedByPartner.shareCode, '');
});

test('derive: 拼出纪念日堆叠卡，卡 0 永远是「在一起」（文档 9.4）', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome());

  assert.strictEqual(patch.cards.length, 3);
  assert.deepStrictEqual(patch.cards[0], {
    key: 'together',
    kind: 'together',
    label: '我们的日子',
    mainText: '第 911 天',
    subText: '开始于 2024年5月20日',
    metaText: '周年 · 还有 185 天',
  });
  // 自定义纪念日：主文案是剩余天数，副文案是「下一次」的月-日
  assert.strictEqual(patch.cards[1].label, '第一次见面');
  assert.strictEqual(patch.cards[1].mainText, '还有 197 天');
  assert.strictEqual(patch.cards[1].subText, '6月1日');
  assert.strictEqual(patch.cards[1].metaText, '第 4 个');
  // daysLeft 为 0 写「就是今天」，不写「还有 0 天」
  assert.strictEqual(patch.cards[2].mainText, '就是今天');
  assert.strictEqual(patch.cardCount, 3);
  assert.strictEqual(patch.cardIndex, 0);
});

test('derive: 纪念日区块降级为 null / 空数组时只剩「在一起」一张卡（10.3）', () => {
  const page = instantiate(config);
  for (const value of [null, { items: [] }, undefined]) {
    const patch = page.derive(baseHome({ anniversary: value }));
    assert.strictEqual(patch.cards.length, 1, 'anniversary=' + JSON.stringify(value));
    assert.strictEqual(patch.cards[0].kind, 'together');
    assert.strictEqual(patch.cardIndex, 0);
  }
});

test('derive: 未绑定时没有堆叠卡（只渲染邀请卡）', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({ couple: null, partner: null }));
  assert.deepStrictEqual(patch.cards, []);
  assert.strictEqual(patch.cardCount, 0);
  assert.strictEqual(patch.cardIndex, 0);
});

test('derive: 对方删掉你正在看的那张后，cardIndex 夹回合法范围（不留空白卡）', () => {
  const page = instantiate(config);
  page.setData({ cardIndex: 2 });
  const shrunk = page.derive(baseHome({
    anniversary: { items: [{ anniversaryId: 'a_1', title: '第一次见面', date: '2023-06-01', nextDate: '2027-06-01', daysLeft: 197, years: 4 }] },
  }));
  assert.strictEqual(shrunk.cardCount, 2);
  assert.strictEqual(shrunk.cardIndex, 1, '下标不能超过最后一张');

  const empty = page.derive(baseHome({ anniversary: null }));
  assert.strictEqual(empty.cardIndex, 0);
});

test('derive: 8 个自定义纪念日已满时仍拼出 9 张卡（添加上限由管理页拦，管理入口不消失）', () => {
  const page = instantiate(config);
  const items = [];
  for (let i = 0; i < 8; i += 1) {
    items.push({ anniversaryId: 'a_' + i, title: '纪念日 ' + i, date: '2020-01-01', nextDate: '2027-01-01', daysLeft: 46, years: 7 });
  }
  const patch = page.derive(baseHome({ anniversary: { items } }));
  assert.strictEqual(patch.cardCount, 9);
});

test('onCardChange: 只接受合法下标，越界/重复/非法值都不改（文档 9.4）', () => {
  const page = instantiate(config);
  page.setData(page.derive(baseHome()));
  const calls = [];
  const original = page.setData.bind(page);
  page.setData = (patch) => { calls.push(patch); original(patch); };

  page.onCardChange({ detail: { index: 2 } });
  assert.strictEqual(page.data.cardIndex, 2);

  page.onCardChange({ detail: { index: 2 } }); // 同一个下标不重复 setData
  page.onCardChange({ detail: { index: 9 } }); // 越界
  page.onCardChange({ detail: { index: -1 } });
  page.onCardChange({ detail: {} });
  page.onCardChange({});
  assert.strictEqual(page.data.cardIndex, 2);
  assert.strictEqual(calls.length, 1);
});

test('onCardEdit: 只有「在一起」那张卡的「改日子」会打开浮层', () => {
  const page = instantiate(config);
  const home = baseHome();
  page.setData(Object.assign({ home }, page.derive(home)));
  page.onCardEdit({ detail: { kind: 'custom' } });
  assert.strictEqual(page.data.showDaysSheet, false);
  page.onCardEdit({ detail: { kind: 'together' } });
  assert.strictEqual(page.data.showDaysSheet, true);
});

test('derive: 服务端没给纪念日时兜底为「开始那天就是纪念日」', () => {
  const page = instantiate(config);
  const home = baseHome();
  home.couple = Object.assign({}, home.couple, { anniversary: null });
  const patch = page.derive(home);
  assert.strictEqual(patch.anniversaryText, '开始那天就是纪念日');
});

test('derive: todayKey 缺省时 maxStartDate 退回本机日期（13.5）', () => {
  const page = instantiate(config);
  const home = baseHome();
  delete home.todayKey;
  const patch = page.derive(home);
  // 正常路径服务端一定给 todayKey；取不到时才退回本机（东八区）日期。
  // 这里读真实时钟，跨东八区 00:00 的毫秒级窗口理论上会偶发红，可接受。
  assert.strictEqual(patch.maxStartDate, timeUtil.todayKey());
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
  assert.strictEqual(patch.daysText, '从今天开始');
  assert.strictEqual(patch.startDateText, '');
  assert.strictEqual(patch.anniversaryText, '');
  // startDate 为 null 时选择器回显也是 null（wxml 的 picker value 接受 null/空）
  assert.strictEqual(patch.startDateSelect, null);
  assert.strictEqual(String(patch.daysText || '').includes('null'), false);
  assert.strictEqual(String(patch.cards[0].metaText || '').includes('null'), false);
});

test('derive: 只有 startDate 没有纪念日时仍提示「开始那天就是纪念日」', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({
    couple: { coupleId: 'c_1', startDate: '2026-11-16', daysTogether: 1, anniversary: null },
  }));
  assert.strictEqual(patch.daysText, '第 1 天');
  assert.strictEqual(patch.anniversaryText, '开始那天就是纪念日');
});

test('derive: 成长卡优先显示进行中标题，待认领单独标记', () => {
  const page = instantiate(config);
  const patch = page.derive(baseHome({
    growth: { inFlight: 2, firstActiveTitle: '一起背完六级词汇', awaitingConfirm: true, archivedCount: 5 },
  }));
  assert.strictEqual(patch.growthTitle, '一起背完六级词汇');
  assert.strictEqual(patch.growthAwaiting, true);
  assert.strictEqual(patch.growthSub, '有事等你认领 · 2 件在档 · 日志 5 件');
});

test('derive: 没有进行中但有认领中、完全空、未绑定三种情况', () => {
  const page = instantiate(config);

  const onlyConfirm = page.derive(baseHome({
    growth: { inFlight: 1, firstActiveTitle: null, awaitingConfirm: true, archivedCount: 0 },
  }));
  assert.strictEqual(onlyConfirm.growthTitle, '有件事在等你认领');
  assert.strictEqual(onlyConfirm.growthSub, '有事等你认领 · 1 件在档');

  const empty = page.derive(baseHome({
    growth: { inFlight: 0, firstActiveTitle: null, awaitingConfirm: false, archivedCount: 3 },
  }));
  assert.strictEqual(empty.growthTitle, '还没有一起在做的事');
  assert.strictEqual(empty.growthSub, '日志 3 件');

  // 单块读失败降级 null：整张卡不渲染（growthTitle 为空即 wx:if 不成立）
  const broken = page.derive(baseHome({ growth: null }));
  assert.strictEqual(broken.growthTitle, '');
  assert.strictEqual(broken.growthSub, '');

  // 未绑定：即使服务端误带 growth 也不显示
  const unbound = page.derive(baseHome({
    couple: null,
    growth: { inFlight: 1, firstActiveTitle: '不应该出现', awaitingConfirm: false, archivedCount: 0 },
  }));
  assert.strictEqual(unbound.growthTitle, '');
});

// M13 / 文档 9.2 第 0.6 位 + 7.19：首页只在「TA 申请看我的账本且待处理」时出现一条可点提示
test('derive: 账本申请提示条只认 pendingIncoming', () => {
  const page = instantiate(config);

  const one = page.derive(baseHome({
    ledgerAccess: { pendingIncoming: 1, approvedIncoming: 0, canViewPartner: false },
  }));
  assert.strictEqual(one.ledgerNotice, true);
  assert.strictEqual(one.ledgerNoticeText, 'TA 想看看你的账本');

  // 多条待处理时把条数说出来，用户知道不是同一件事反复弹
  const many = page.derive(baseHome({
    ledgerAccess: { pendingIncoming: 3, approvedIncoming: 1, canViewPartner: true },
  }));
  assert.strictEqual(many.ledgerNotice, true);
  assert.match(many.ledgerNoticeText, /3 条待处理/);

  // 只有「我已授权」「我能看 TA」都不该在首页提醒：那是既成事实，不是待办
  const granted = page.derive(baseHome({
    ledgerAccess: { pendingIncoming: 0, approvedIncoming: 2, canViewPartner: true },
  }));
  assert.strictEqual(granted.ledgerNotice, false);
  assert.strictEqual(granted.ledgerNoticeText, '');
});

test('derive: 账本提示条在降级与未绑定时不渲染', () => {
  const page = instantiate(config);

  // 单块读失败降级 null：宁可少提一次，也不要让用户点进去扑空
  assert.strictEqual(page.derive(baseHome({ ledgerAccess: null })).ledgerNotice, false);
  // 老版本服务端没有这个字段
  assert.strictEqual(page.derive(baseHome()).ledgerNotice, false);
  // 未绑定：即使服务端误带也不显示
  const unbound = page.derive(baseHome({
    couple: null,
    ledgerAccess: { pendingIncoming: 1, approvedIncoming: 0, canViewPartner: false },
  }));
  assert.strictEqual(unbound.ledgerNotice, false);
  assert.strictEqual(unbound.ledgerNoticeText, '');
});
