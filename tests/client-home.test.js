'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const constants = require('../miniprogram/utils/constants');

/**
 * 首页交互：纪念日堆叠切换与入口（文档 9.4）、心情打卡、改开始日期、四个入口。
 * 派生逻辑（derive / buildCards）已由 home-derive.test.js 覆盖，这里测页面动作与接口接线。
 */
const HOME = 'miniprogram/pages/home/index.js';

function baseHome(patch) {
  return Object.assign(
    {
      serverNow: '2026-11-16T06:30:00.000Z',
      todayKey: '2026-11-16',
      phase: 'day',
      user: { openid: 'oA', nickname: '小怡', avatarFileID: '', profileComplete: true },
      bind: { state: 'bound', pending: null },
      couple: {
        coupleId: 'c_1',
        startDate: '2024-05-20',
        daysTogether: 911,
        anniversary: { date: '2027-05-20', daysLeft: 185 },
      },
      partner: { nickname: 'TA', avatarFileID: '', profileComplete: true },
      mood: { mine: null, partner: null },
      anniversary: { items: [] },
      safety: { mineToday: false, partnerToday: false, partnerLastAt: null },
      diary: { mineWritten: false, partnerWritten: false, partnerUnlocked: false },
      wish: { total: 0, done: 0, previewTitle: '' },
    },
    patch || {}
  );
}

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const navs = [];
  const storage = {};
  const storeSet = [];
  const vibrates = [];
  installWx(
    Object.assign(
      {
        showToast: (opts) => toasts.push(opts),
        navigateTo: (opts) => navs.push({ kind: 'navigateTo', url: opts.url }),
        switchTab: (opts) => navs.push({ kind: 'switchTab', url: opts.url }),
        showModal: (opts) => {
          const next = setup.modal && setup.modal(opts);
          if (next) opts.success && opts.success(next);
        },
        getStorageSync: (key) => storage[key],
        vibrateShort: (opts) => vibrates.push(opts),
        setStorageSync: (key, value) => {
          storage[key] = value;
          storeSet.push({ key, value });
        },
      },
      wxExtra || {}
    )
  );
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (handlers[action]) return handlers[action](payload, calls.length);
    throw new Error('unexpected action: ' + action);
  };
  api.showError = (err) => errors.push(err);
  const page = instantiate(loadPage(HOME));
  return { page, toasts, errors, calls, navs, storage, storeSet, vibrates };
}

function teardown(page) {
  page.onUnload();
}

test('home: 首屏加载成功后落数据并清 loading；失败进错误态，重试可恢复', async () => {
  let fail = true;
  const { page } = setup({
    'home.get': () => {
      if (fail) throw new Error('down');
      return baseHome();
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '小屋的门卡住了');
    fail = false;
    page.onRetry();
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(page.data.error, '');
    assert.ok(page.data.home);
    assert.strictEqual(page.data.myName, '小怡');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 已有数据时静默刷新失败保留旧数据，toast 与底部浮层同时在', async () => {
  let fail = false;
  const { page, toasts } = setup({
    'home.get': () => {
      if (fail) throw new Error('刷新挂了');
      return baseHome();
    },
  });
  try {
    await page.load();
    fail = true;
    await page.load(true);
    assert.ok(page.data.home, '失败也要保留上次场景');
    assert.strictEqual(page.data.error, '', '不能进整页错误态');
    // 文档 9.12：底部浮层「小屋的门卡住了」+「再试一次」
    assert.strictEqual(page.data.refreshError, '小屋的门卡住了');
    assert.ok(toasts.some((t) => t.title === '刷新挂了'), '原有的 toast 不打断仍保留');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 点底部浮层「再试一次」成功后清提示并更新场景，连点复用同一请求', async () => {
  let mode = 'ok';
  let pending = null;
  const updated = baseHome({ couple: Object.assign({}, baseHome().couple, { daysTogether: 912 }) });
  const { page } = setup({
    'home.get': () => {
      if (mode === 'fail') throw new Error('刷新挂了');
      if (mode === 'pending') {
        return new Promise((resolve) => {
          pending = { resolve };
        });
      }
      return mode === 'updated' ? updated : baseHome();
    },
  });
  try {
    await page.load();
    mode = 'fail';
    await page.load(true);
    assert.strictEqual(page.data.refreshError, '小屋的门卡住了');

    mode = 'pending';
    const first = page.onRetryRefresh();
    const second = page.onRetryRefresh();
    assert.strictEqual(first, second, '连点必须复用同一在途请求');
    assert.ok(pending, '重试应真的发出 home.get');

    mode = 'updated';
    pending.resolve(updated);
    await first;
    // 竞态检查：等微任务都落完，确认没有第二个请求把状态覆盖回去
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(page.data.refreshError, '');
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.home.couple.daysTogether, 912, '重试成功后场景要更新');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 再试一次仍失败保留浮层提示，不整页报错也不丢场景，且能反复重试', async () => {
  let fail = false;
  let gets = 0;
  const { page, toasts } = setup({
    'home.get': () => {
      gets += 1;
      if (fail) throw new Error('还是失败');
      return baseHome();
    },
  });
  try {
    await page.load();
    fail = true;
    await page.load(true);
    const before = toasts.length;
    await page.onRetryRefresh();
    assert.strictEqual(gets, 3, '重试要重新请求，不能只复用失败结果');
    assert.strictEqual(page.data.refreshError, '小屋的门卡住了');
    assert.strictEqual(page.data.error, '');
    assert.ok(page.data.home);
    assert.strictEqual(page.data.loading, false, '静默重试不整页 loading');
    assert.ok(toasts.length > before, '重试失败仍然 toast');
    // 失败一次后 _retryingRefresh 必须已清空，否则浮层会永久点不动
    await page.onRetryRefresh();
    assert.strictEqual(gets, 4, '连续失败后仍然要能再发一次请求');
    assert.strictEqual(page.data.refreshError, '小屋的门卡住了');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 静默刷新失败的横幅接上 onRetryRefresh，并在卡片之前吸顶', () => {
  const path = require('node:path');
  const wxml = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/pages/home/index.wxml'), 'utf8');
  const wxss = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/pages/home/index.wxss'), 'utf8');
  assert.ok(wxml.includes('wx:if="{{home && refreshError}}"'), '横幅要按 home && refreshError 条件渲染');
  assert.ok(wxml.includes('bindtap="onRetryRefresh"'), '横幅按钮必须接上重试方法');
  assert.ok(wxml.includes('aria-role="button"'), '横幅按钮要声明无障碍角色');
  assert.ok(wxml.includes('aria-label="重试加载首页"'), '横幅按钮要有区分于可见文字的 aria-label');
  assert.ok(!wxml.includes('小屋的门卡住了'), '文案只放在 data.refreshError，模板不再硬编码一份');
  const barAt = wxml.indexOf('refresh-bar');
  const daysAt = wxml.indexOf('class="stack-slot card-gap"');
  assert.ok(barAt > 0, '模板里应有 refresh-bar');
  assert.ok(daysAt > 0 && barAt < daysAt, '横幅要排在卡片之前，吸顶后不遮挡内容');
  const btnRule = wxss.slice(wxss.indexOf('.refresh-bar__btn {'), wxss.indexOf('}', wxss.indexOf('.refresh-bar__btn {')));
  assert.ok(btnRule.includes('min-height: 88rpx'), '失败态唯一恢复入口要满足 88rpx 热区（文档 8.9）');
  const barRule = wxss.slice(wxss.indexOf('.refresh-bar {'), wxss.indexOf('}', wxss.indexOf('.refresh-bar {')));
  assert.ok(barRule.includes('position: sticky'), '横幅要吸顶，滚到下面也能重试（文档 9.12）');
});

test('home: 心情打卡成功后先更新气泡、关弹层、提示并静默刷新', async () => {
  let mood = null;
  const { page, toasts, calls } = setup({
    'home.get': () => baseHome({ mood: { mine: mood, partner: null } }),
    'mood.set': (payload) => {
      assert.deepStrictEqual(payload, { mood: 'sunny', note: '今天很好' });
      mood = { mood: 'sunny', note: '今天很好', updatedAt: '2026-11-16T06:00:00.000Z' };
      return { mood };
    },
  });
  try {
    await page.load();
    page.setData({ moodPickerShow: true });
    await page.onMoodSelect({ detail: { mood: 'sunny', note: '今天很好' } });
    assert.strictEqual(page.data.moodSaving, false);
    assert.strictEqual(page.data.moodPickerShow, false);
    assert.deepStrictEqual(page.data.moodMine, mood);
    assert.ok(toasts.some((t) => t.title === '今天的心情记下啦'));
    assert.ok(calls.filter((c) => c.action === 'home.get').length >= 2);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 心情打卡失败复位 moodSaving 并报错，弹层保留', async () => {
  const { page, errors } = setup({
    'home.get': () => baseHome(),
    'mood.set': () => {
      throw new Error('down');
    },
  });
  try {
    await page.load();
    page.setData({ moodPickerShow: true });
    await page.onMoodSelect({ detail: { mood: 'rainy' } });
    assert.strictEqual(page.data.moodSaving, false);
    assert.strictEqual(page.data.moodPickerShow, true);
    assert.strictEqual(errors.length, 1);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 点对方头像打开只读心情详情，备注只在那里出现', async () => {
  const { page, toasts } = setup({
    'home.get': () =>
      baseHome({
        mood: { mine: null, partner: { mood: 'cloudy', note: '有点累', updatedAt: '2026-11-16T05:00:00.000Z' } },
      }),
  });
  try {
    await page.load();
    page.onTapPartnerAvatar();
    assert.strictEqual(page.data.partnerMoodSheet, true);
    assert.strictEqual(page.data.partnerMood.mood, 'cloudy');
    assert.strictEqual(page.data.partnerMood.label, '阴');
    assert.strictEqual(page.data.partnerMood.emoji, '☁️');
    assert.strictEqual(page.data.partnerMood.note, '有点累');
    assert.strictEqual(page.data.partnerMood.timeText, '今天 13:00');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 未绑定时点对方头像与四个入口只提示，不跳转', async () => {
  const { page, toasts, navs } = setup({
    'home.get': () =>
      baseHome({
        bind: { state: 'unbound', pending: null },
        couple: null,
        partner: null,
        mood: { mine: null, partner: null },
        anniversary: { items: [] },
      }),
  });
  try {
    await page.load();
    page.onTapPartnerAvatar();
    assert.ok(toasts.some((t) => t.title === '等 TA 住进来吧'));
    page.onTapDiary();
    page.onTapWish();
    page.onTapSafety();
    page.onTapMoodHistory();
    assert.ok(toasts.some((t) => t.title === '等 TA 住进来，这里就开门啦'));
    assert.strictEqual(navs.length, 0, '未绑定不该跳进空页面');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 四个入口都走 navigateTo（它们都是普通页，文档 8.2）', async () => {
  const { page, navs } = setup({ 'home.get': () => baseHome() });
  try {
    await page.load();
    page.onTapDiary();
    page.onTapWish();
    page.onTapMoodHistory();
    page.onTapSafety();
    assert.deepStrictEqual(navs, [
      { kind: 'navigateTo', url: constants.ROUTES.diary },
      { kind: 'navigateTo', url: constants.ROUTES.wish },
      { kind: 'navigateTo', url: constants.ROUTES.mood },
      { kind: 'navigateTo', url: constants.ROUTES.safety },
    ]);
    // 只有 2 个 tab，跳这四个入口时不该出现 switchTab
    assert.strictEqual(
      navs.some((n) => n.kind === 'switchTab'),
      false,
      '日记/愿望/心情都不是 tab 页，用 switchTab 会 fail'
    );
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: onShow 首次拉数据，回到页面静默刷新且失败不打断', async () => {
  let n = 0;
  const { page, toasts, errors } = setup({
    'home.get': () => {
      n += 1;
      if (n === 1) return baseHome();
      if (n === 2) {
        return baseHome({
          user: { openid: 'oA', nickname: '新的小怡', avatarFileID: '', profileComplete: true },
        });
      }
      throw new Error('刷新挂了');
    },
  });
  try {
    page.onLoad();
    page.onShow();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(n, 1);
    assert.strictEqual(page.data.myName, '小怡');

    page.onShow();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(n, 2);
    assert.strictEqual(page.data.myName, '新的小怡');

    // 文档 10.3：静默刷新失败保留旧数据，只 toast 不打断
    page.onShow();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(n, 3);
    assert.strictEqual(page.data.myName, '新的小怡');
    assert.ok(toasts.some((t) => t.title === '刷新挂了'));
    assert.strictEqual(errors.length, 0);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 堆叠切换只改下标，不额外请求服务端（文档 9.4）', async () => {
  const { page, calls } = setup({
    'home.get': () => baseHome({
      anniversary: {
        items: [
          { anniversaryId: 'a_1', title: '第一次见面', date: '2023-06-01', nextDate: '2027-06-01', daysLeft: 197, years: 4 },
          { anniversaryId: 'a_2', title: '她的生日', date: '2019-11-16', nextDate: '2026-11-16', daysLeft: 0, years: 7 },
        ],
      },
    }),
  });
  try {
    await page.load();
    const before = calls.length;
    assert.strictEqual(page.data.cardCount, 3);

    page.onCardChange({ detail: { index: 1 } });
    assert.strictEqual(page.data.cardIndex, 1);
    page.onCardChange({ detail: { index: 2 } });
    assert.strictEqual(page.data.cardIndex, 2);

    // 切换是纯前端行为：不额外打接口（剩余天数由服务端在刷新时给）
    assert.strictEqual(calls.length, before);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 「管理 ›」进纪念日管理页；未绑定时只提示不跳转', async () => {
  const bound = setup({
    'home.get': () => baseHome(),
  });
  try {
    await bound.page.load();
    bound.page.onManageAnniversary();
    assert.deepStrictEqual(bound.navs, [{ kind: 'navigateTo', url: constants.ROUTES.anniversary }]);
  } finally {
    teardown(bound.page);
    restoreWx();
  }

  const unbound = setup({
    'home.get': () => baseHome({ couple: null, partner: null, bind: { state: 'unbound', pending: null } }),
  });
  try {
    await unbound.page.load();
    unbound.page.onManageAnniversary();
    assert.strictEqual(unbound.navs.length, 0, '未绑定不该跳进管理页');
    assert.ok(unbound.toasts.some((t) => t.title === '等 TA 住进来再一起记日子'));
  } finally {
    teardown(unbound.page);
    restoreWx();
  }
});

test('home: 改开始日期后堆叠第一张卡的天数与开始日期同步更新（文档 9.4）', async () => {
  let startDate = '2024-05-20';
  let days = 911;
  const { page } = setup({
    'home.get': () => baseHome({
      couple: {
        coupleId: 'c_1',
        startDate,
        daysTogether: days,
        anniversary: { date: '2027-05-20', daysLeft: 185 },
      },
    }),
    'couple.updateStartDate': () => {
      startDate = '2024-05-21';
      days = 910;
      return { startDate, daysTogether: days, updatedAt: '2026-11-16T06:30:00.000Z' };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.cards[0].mainText, '第 911 天');
    await page.saveStartDate('2024-05-21');
    assert.strictEqual(page.data.cards[0].mainText, '第 910 天');
    assert.strictEqual(page.data.cards[0].subText, '开始于 2024年5月21日');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 改开始日期先二次确认，确认后按返回值更新天数并提示', async () => {
  setup.modal = () => ({ confirm: true });
  let updated = false;
  // 真实服务端保存后 home.get 会返回新日期，这里同步维护，避免刷新把刚更新的值盖回旧值
  let startDate = '2024-05-20';
  let daysTogether = 911;
  const { page, toasts, calls } = setup({
    'home.get': () =>
      baseHome({
        couple: {
          coupleId: 'c_1',
          startDate,
          daysTogether,
          anniversary: { date: '2027-05-21', daysLeft: 186 },
        },
      }),
    'couple.updateStartDate': (payload) => {
      assert.deepStrictEqual(payload, { startDate: '2024-05-21' });
      startDate = '2024-05-21';
      daysTogether = 910;
      updated = true;
      return { startDate: '2024-05-21', daysTogether: 910, anniversary: { date: '2027-05-21', daysLeft: 186 } };
    },
  });
  try {
    await page.load();
    page.onStartDateChange({ detail: { value: '2024-05-21' } });
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(page.data.startDateSaving, false);
    assert.strictEqual(page.data.startDateText, '2024年5月21日');
    assert.strictEqual(page.data.daysText, '第 910 天');
    assert.strictEqual(updated, true);
    assert.ok(toasts.some((t) => t.title === '日子重新算好啦'));
    assert.ok(calls.filter((c) => c.action === 'home.get').length >= 2);
  } finally {
    setup.modal = null;
    teardown(page);
    restoreWx();
  }
});

test('home: 改开始日期的弹窗取消或选择未变化时不发请求', async () => {
  setup.modal = () => ({ confirm: false });
  const { page, calls } = setup({ 'home.get': () => baseHome() });
  try {
    await page.load();
    page.onStartDateChange({ detail: { value: '2024-05-20' } });
    page.onStartDateChange({ detail: { value: '2024-05-21' } });
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(calls.filter((c) => c.action === 'couple.updateStartDate').length, 0);
  } finally {
    setup.modal = null;
    teardown(page);
    restoreWx();
  }
});

test('home: 改开始日期失败复位 startDateSaving 并报错', async () => {
  setup.modal = () => ({ confirm: true });
  const { page, errors } = setup({
    'home.get': () => baseHome(),
    'couple.updateStartDate': () => {
      throw new Error('down');
    },
  });
  try {
    await page.load();
    page.onStartDateChange({ detail: { value: '2024-05-21' } });
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(page.data.startDateSaving, false);
    assert.strictEqual(errors.length, 1);
  } finally {
    setup.modal = null;
    teardown(page);
    restoreWx();
  }
});

test('home: 分享卡片已绑定分享首页，未绑定只分享自己的邀请码，朋友圈不带码', async () => {
  const bound = setup({ 'home.get': () => baseHome() });
  try {
    await bound.page.load();
    const share = bound.page.onShareAppMessage();
    assert.strictEqual(share.path, constants.ROUTES.home);
    assert.strictEqual(bound.page.onShareTimeline().path, undefined);
  } finally {
    teardown(bound.page);
    restoreWx();
  }

  const unbound = setup({
    'home.get': () =>
      baseHome({
        bind: { state: 'code_created', pending: { code: '654321' } },
        couple: null,
        partner: null,
      }),
  });
  try {
    await unbound.page.load();
    assert.strictEqual(unbound.page.data.shareCode, '654321');
    const share = unbound.page.onShareAppMessage();
    assert.strictEqual(share.path, constants.ROUTES.bind + '?code=654321');
    assert.strictEqual(unbound.page.onShareTimeline().path, undefined);
  } finally {
    teardown(unbound.page);
    restoreWx();
  }

  // applied_* 阶段的 code 已失效或属于对方（文档 11.5）：分享不能再带码
  const applied = setup({
    'home.get': () =>
      baseHome({
        bind: { state: 'applied_by_me', pending: { code: '654321' } },
        couple: null,
        partner: null,
      }),
  });
  try {
    await applied.page.load();
    assert.strictEqual(applied.page.data.shareCode, '');
    const share = applied.page.onShareAppMessage();
    assert.strictEqual(share.path, constants.ROUTES.bind);
    assert.strictEqual(share.path.indexOf('?code='), -1);
  } finally {
    teardown(applied.page);
    restoreWx();
  }
});

/* M9 解绑提示条（文档 9.2）：只有「对方发起」才在首页提示，点了 switchTab 去「我的」 */
test('home: 对方申请解绑时首屏出现提示条，点了去「我的」', async () => {
  const { page, navs } = setup(
    {
      'home.get': () => baseHome({
        unbind: { status: 'pending', requestedByMe: false, requestedAt: '2026-11-16T04:00:00.000Z' },
      }),
    },
    { nextTick: (fn) => fn() }
  );
  try {
    page.onShow();
    await page.loadingPromise;
    assert.strictEqual(page.data.unbindNotice, true);
    assert.match(page.data.unbindNoticeText, /TA 申请了解绑/);
    page.onTapUnbindNotice();
    assert.deepStrictEqual(navs, [{ kind: 'switchTab', url: constants.ROUTES.profile }]);
    // 等首屏入场定时器（16ms）跑完再拆 wx，否则回调里摸 wx 会报错
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    restoreWx();
  }
});

test('home: 自己发起 / 没有申请时不出现提示条', async () => {
  const cases = [
    { status: 'pending', requestedByMe: true, requestedAt: '2026-11-16T04:00:00.000Z' },
    { status: 'none', requestedByMe: false, requestedAt: null },
  ];
  for (const unbind of cases) {
    const { page } = setup(
      {
        'home.get': () => baseHome({ unbind }),
      },
      { nextTick: (fn) => fn() }
    );
    try {
      page.onShow();
      await page.loadingPromise;
      assert.strictEqual(page.data.unbindNotice, false, JSON.stringify(unbind));
      assert.strictEqual(page.data.unbindNoticeText, '');
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      restoreWx();
    }
  }
});

// ── 先停一下（M11 / 文档 9.2 第 0.5 位、9.3、7.17）────────────────────────

const ACTIVE_PAUSE = {
  pauseId: 'p_1', byMe: false, byName: 'TA', durationMin: 30, status: 'active',
  startedAt: '2026-11-16T06:10:00.000Z', endsAt: '2026-11-16T06:40:00.000Z', endChoice: null,
};

test('首页：先停一下入口 → ActionSheet 三档 → pause.start，便签随刷新出现', async () => {
  let mode = 'before';
  const sheets = [];
  const { page, calls, toasts } = setup({
    'home.get': () => (mode === 'before' ? baseHome() : baseHome({ pause: ACTIVE_PAUSE })),
    'pause.start': () => {
      mode = 'after';
      return { pause: ACTIVE_PAUSE, existing: false };
    },
  }, {
    showActionSheet: (opts) => {
      sheets.push(opts.itemList);
      opts.success({ tapIndex: 1 });
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.pauseState, '', '没有暂停时不渲染便签');
    page.onTapPauseStart();
    await new Promise((r) => setTimeout(r, 30));

    assert.deepStrictEqual(sheets[0], ['10 分钟', '30 分钟', '60 分钟']);
    const start = calls.find((c) => c.action === 'pause.start');
    assert.deepStrictEqual(start.payload, { durationMin: 30 });
    assert.strictEqual(page.data.pauseState, 'active');
    assert.strictEqual(page.data.pauseByName, 'TA');
    assert.strictEqual(page.data.pauseRemainText, '还有 10 分钟');
    assert.ok(toasts.some((t) => t.title.indexOf('先停 30 分钟') !== -1));
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：ActionSheet 取消不发请求', async () => {
  const { page, calls } = setup({ 'home.get': () => baseHome() }, {
    showActionSheet: (opts) => opts.fail && opts.fail({ errMsg: 'cancel' }),
  });
  try {
    await page.load();
    page.onTapPauseStart();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(calls.filter((c) => c.action === 'pause.start').length, 0);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：已经在暂停里再点入口只提示，不重复发起', async () => {
  const { page, calls, toasts } = setup({ 'home.get': () => baseHome({ pause: ACTIVE_PAUSE }) }, {
    showActionSheet: () => { throw new Error('暂停中不该再弹 ActionSheet'); },
  });
  try {
    await page.load();
    page.onTapPauseStart();
    assert.strictEqual(calls.filter((c) => c.action === 'pause.start').length, 0);
    assert.ok(toasts.length >= 1);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：未绑定点「先停一下」只提示不发请求', async () => {
  const { page, calls, toasts } = setup({
    'home.get': () => baseHome({ couple: null, bind: { state: 'unbound', pending: null } }),
  });
  try {
    await page.load();
    page.onTapPauseStart();
    assert.strictEqual(calls.filter((c) => c.action === 'pause.start').length, 0);
    assert.ok(toasts.some((t) => t.title.indexOf('等 TA 住进来') !== -1));
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：发起方点「我缓好了」→ pause.end，便签翻面成和好卡', async () => {
  const mine = Object.assign({}, ACTIVE_PAUSE, { byMe: true, byName: '小怡' });
  const ended = Object.assign({}, mine, { status: 'ended' });
  let endedNow = false;
  const { page, calls } = setup({
    'home.get': () => baseHome({ pause: endedNow ? ended : mine }),
    'pause.end': () => {
      endedNow = true;
      return { pause: ended };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.pauseByMe, true, '发起方才有「我缓好了」');
    await page.onTapPauseEnd();
    assert.deepStrictEqual(calls.find((c) => c.action === 'pause.end').payload, undefined);
    assert.strictEqual(page.data.pauseState, 'ended');
    assert.strictEqual(page.data.pauseRemainText, '', '翻面后不再倒计时');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：和好卡三选一 → pause.choose，选完便签收起（closed 等于不存在）', async () => {
  const ended = Object.assign({}, ACTIVE_PAUSE, { status: 'ended' });
  let mode = 'ended';
  const { page, calls, toasts } = setup({
    'home.get': () => (mode === 'ended' ? baseHome({ pause: ended }) : baseHome()),
    'pause.choose': (payload) => {
      mode = 'closed';
      return { pause: Object.assign({}, ended, { status: 'closed', endChoice: payload.choice }) };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.pauseState, 'ended');
    await page.onTapPauseChoose({ currentTarget: { dataset: { choice: 'later' } } });
    assert.deepStrictEqual(calls.find((c) => c.action === 'pause.choose').payload, { choice: 'later' });
    assert.strictEqual(page.data.pauseState, '');
    assert.ok(toasts.some((t) => t.title === '记下了'));
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：和好卡点在没有 choice 的元素上不发请求', async () => {
  const ended = Object.assign({}, ACTIVE_PAUSE, { status: 'ended' });
  const { page, calls } = setup({ 'home.get': () => baseHome({ pause: ended }) });
  try {
    await page.load();
    await page.onTapPauseChoose({ currentTarget: { dataset: {} } });
    assert.strictEqual(calls.filter((c) => c.action === 'pause.choose').length, 0);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页：暂停写失败只提示，不炸整页且可再点', async () => {
  const { page, errors } = setup({
    'home.get': () => baseHome(),
    'pause.start': () => { throw new Error('down'); },
  }, {
    showActionSheet: (opts) => opts.success({ tapIndex: 0 }),
  });
  try {
    await page.load();
    page.onTapPauseStart();
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(page.data.pauseSaving, false, '失败后按钮要能再点');
    assert.ok(page.data.home, '首页数据保留，不整页报错');
    assert.strictEqual(page.data.pauseState, '');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('首页 wxml：便签卡与入口接线（M11 / 文档 9.3）', () => {
  const path = require('node:path');
  const wxml = fs.readFileSync(path.join(__dirname, '../miniprogram/pages/home/index.wxml'), 'utf8');
  assert.ok(wxml.includes('bindtap="onTapPauseStart"'), '入口要接 onTapPauseStart');
  assert.ok(wxml.includes('bindtap="onTapPauseEnd"'), '「我缓好了」要接 onTapPauseEnd');
  assert.ok(wxml.includes('bindtap="onTapPauseChoose"'), '和好卡要接 onTapPauseChoose');
  ['hurry', 'later', 'hug'].forEach((choice) => {
    assert.ok(wxml.includes('data-choice="' + choice + '"'), '缺 choice: ' + choice);
  });
  assert.ok(/wx:if="\{\{home\.couple && pauseState\}\}"/.test(wxml), '便签必须是条件卡');
  assert.ok(/wx:if="\{\{home\.couple && !pauseState\}\}"/.test(wxml), '暂停中不重复显示入口');
  assert.ok(wxml.includes('我缓好了'));
  assert.ok(wxml.includes('先停一下 · 给彼此一点时间'));
  assert.ok(wxml.includes('aria-role="alert"'), '便签变化要有可读提示');
});
