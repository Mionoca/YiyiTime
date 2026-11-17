'use strict';

const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const constants = require('../miniprogram/utils/constants');
const haptics = require('../miniprogram/utils/haptics');

/**
 * 首页交互：抱抱按钮状态机（文档 9.4）、心情打卡、改开始日期、房间入口。
 * 派生逻辑（derive）已由 home-derive.test.js 覆盖，这里测页面动作与接口接线。
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
      hug: { incoming: null, outgoing: null },
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
  const daysAt = wxml.indexOf('class="dk-card days-card');
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
        hug: { incoming: null, outgoing: null },
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

test('home: 四个入口按 tab / 非 tab 分别用 switchTab 与 navigateTo（文档 8.2）', async () => {
  const { page, navs } = setup({ 'home.get': () => baseHome() });
  try {
    await page.load();
    page.onTapDiary();
    page.onTapWish();
    page.onTapMoodHistory();
    page.onTapSafety();
    assert.deepStrictEqual(navs, [
      { kind: 'switchTab', url: constants.ROUTES.diary },
      { kind: 'switchTab', url: constants.ROUTES.wish },
      { kind: 'switchTab', url: constants.ROUTES.mood },
      { kind: 'navigateTo', url: constants.ROUTES.safety },
    ]);
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

test('home: 发抱抱成功后切到等待态并刷新', async () => {
  const sent = { hugId: 'h1', status: 'pending', createdAt: '2026-11-16T06:00:00.000Z' };
  let homeHug = { incoming: null, outgoing: null };
  const { page, toasts, calls, vibrates } = setup({
    'home.get': () => baseHome({ hug: homeHug }),
    'hug.send': () => {
      homeHug = { incoming: null, outgoing: sent };
      return { hug: sent, existing: false };
    },
  });
  try {
    await page.load();
    await page.sendHug();
    assert.strictEqual(page.data.hugSending, false);
    assert.deepStrictEqual(page.data.hugOutgoing, sent);
    assert.strictEqual(page.data.hugButtonText, '等 TA 抱抱');
    assert.strictEqual(page.data.hugButtonDisabled, true);
    assert.ok(toasts.some((t) => t.title === '抱抱送出去啦'));
    // 文档 8.9：抱抱成功给一次轻振动
    assert.deepStrictEqual(vibrates.map((v) => v.type), ['light']);
    assert.ok(calls.filter((c) => c.action === 'home.get').length >= 2);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 发抱抱成功后静默刷新失败，也要停在「等 TA 抱抱」乐观态', async () => {
  const sent = { hugId: 'h1', status: 'pending', createdAt: '2026-11-16T06:00:00.000Z' };
  let first = true;
  const { page, toasts, errors } = setup({
    'home.get': () => {
      if (first) {
        first = false;
        return baseHome();
      }
      throw new Error('刷新挂了');
    },
    'hug.send': () => ({ hug: sent, existing: false }),
  });
  try {
    await page.load();
    await page.sendHug();
    assert.strictEqual(page.data.hugSending, false);
    // 刷新失败不能把刚发出去的等待态冲掉（否则用户以为没发出去又会点一次）
    assert.deepStrictEqual(page.data.hugOutgoing, sent);
    assert.strictEqual(page.data.hugButtonText, '等 TA 抱抱');
    assert.strictEqual(page.data.hugButtonDisabled, true);
    assert.ok(toasts.some((t) => t.title === '抱抱送出去啦'));
    assert.strictEqual(errors.length, 0);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 已有 pending 抱抱时不重复发送', async () => {
  const sent = { hugId: 'h1', status: 'pending' };
  const { page, toasts, calls } = setup({
    'home.get': () => baseHome({ hug: { incoming: null, outgoing: sent } }),
    'hug.send': () => {
      throw new Error('should not send');
    },
  });
  try {
    await page.load();
    page.setData({ hugOutgoing: sent });
    await page.sendHug();
    assert.ok(toasts.some((t) => t.title === '抱抱已经发出去了，等 TA 回应'));
    assert.strictEqual(calls.filter((c) => c.action === 'hug.send').length, 0);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: hug.send 返回 existing 时只提示不重复振动', async () => {
  const sent = { hugId: 'h1', status: 'pending' };
  let first = true;
  const { page, toasts, vibrates } = setup({
    // 首次加载时服务端还没这条抱抱（页面状态偏旧），发送接口返回 existing
    'home.get': () => {
      if (first) {
        first = false;
        return baseHome({ hug: { incoming: null, outgoing: null } });
      }
      return baseHome({ hug: { incoming: null, outgoing: sent } });
    },
    'hug.send': () => ({ hug: sent, existing: true }),
  });
  try {
    await page.load();
    await page.sendHug();
    assert.strictEqual(page.data.hugButtonText, '等 TA 抱抱');
    assert.ok(toasts.some((t) => t.title === '抱抱已经发出去了，等 TA 回应'));
    assert.deepStrictEqual(vibrates, [], '复用已有 pending 不算一次新的成功');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 关闭振动反馈后发抱抱成功不再振动', async () => {
  const sent = { hugId: 'h1', status: 'pending', createdAt: '2026-11-16T06:00:00.000Z' };
  let homeHug = { incoming: null, outgoing: null };
  const { page, calls, vibrates } = setup({
    'home.get': () => baseHome({ hug: homeHug }),
    'hug.send': () => {
      homeHug = { incoming: null, outgoing: sent };
      return { hug: sent, existing: false };
    },
  });
  try {
    // 文档 8.9：振动可关闭，关闭后业务照常（home 没有开关 UI，每次 light 现读 storage）
    wx.setStorageSync(haptics.STORAGE_KEY, false);
    await page.load();
    await page.sendHug();
    assert.strictEqual(page.data.hugButtonText, '等 TA 抱抱');
    assert.deepStrictEqual(vibrates, []);
    assert.ok(calls.some((c) => c.action === 'hug.send'));
    wx.setStorageSync(haptics.STORAGE_KEY, true);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 发抱抱失败不振动', async () => {
  const { page, errors, vibrates } = setup({
    'home.get': () => baseHome(),
    'hug.send': () => {
      throw new Error('down');
    },
  });
  try {
    await page.load();
    await page.sendHug();
    assert.strictEqual(page.data.hugSending, false);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(vibrates, [], '失败不应振动');
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 对方来抱抱时按钮变成「抱抱 TA」，点击走 hug.respond 并切走横幅', async () => {
  const incoming = { hugId: 'h9', fromOpenid: 'oB' };
  let homeHug = { incoming, outgoing: null };
  const { page, toasts, calls, vibrates } = setup({
    'home.get': () => baseHome({ hug: homeHug }),
    'hug.respond': (payload) => {
      assert.deepStrictEqual(payload, { hugId: 'h9' });
      homeHug = { incoming: null, outgoing: null };
      return { hugId: 'h9', status: 'hugged', respondedAt: '2026-11-16T06:10:00.000Z', already: false };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.hugButtonText, '抱抱 TA');
    page.onTapHug();
    await new Promise((r) => setTimeout(r, 25));
    assert.strictEqual(page.data.hugIncoming, null);
    assert.strictEqual(page.data.hugButtonText, '我需要抱抱');
    assert.ok(toasts.some((t) => t.title === '抱到啦'));
    assert.deepStrictEqual(vibrates.map((v) => v.type), ['light']);
    assert.ok(calls.some((c) => c.action === 'hug.respond'));
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 回应返回 already 时只提示不振动', async () => {
  const incoming = { hugId: 'h9', fromOpenid: 'oB' };
  let homeHug = { incoming, outgoing: null };
  const { page, toasts, vibrates } = setup({
    'home.get': () => baseHome({ hug: homeHug }),
    'hug.respond': () => {
      homeHug = { incoming: null, outgoing: null };
      return { hugId: 'h9', status: 'hugged', respondedAt: '2026-11-16T06:10:00.000Z', already: true };
    },
  });
  try {
    await page.load();
    await page.respondHug('h9');
    assert.deepStrictEqual(vibrates, [], 'already 不是新回应，不振动');
    assert.ok(toasts.some((t) => t.title === '你们已经抱过啦'));
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 回应成功后静默刷新失败，也要先切走「TA 需要抱抱」横幅', async () => {
  const incoming = { hugId: 'h9', fromOpenid: 'oB' };
  let first = true;
  const { page, toasts, errors } = setup({
    'home.get': () => {
      if (first) {
        first = false;
        return baseHome({ hug: { incoming, outgoing: null } });
      }
      throw new Error('刷新挂了');
    },
    'hug.respond': () => ({ hugId: 'h9', status: 'hugged', respondedAt: '2026-11-16T06:10:00.000Z', already: false }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.hugButtonText, '抱抱 TA');
    await page.respondHug('h9');
    assert.strictEqual(page.data.hugIncoming, null);
    assert.strictEqual(page.data.hugButtonText, '我需要抱抱');
    assert.strictEqual(page.data.hugHint, '抱抱送到啦');
    assert.ok(toasts.some((t) => t.title === '抱到啦'));
    assert.strictEqual(errors.length, 0);
  } finally {
    teardown(page);
    restoreWx();
  }
});

test('home: 回应时抱抱已过期会报错并刷新真实状态', async () => {
  const incoming = { hugId: 'h9', fromOpenid: 'oB' };
  const { page, errors, calls, vibrates } = setup({
    'home.get': () => baseHome({ hug: { incoming, outgoing: null } }),
    'hug.respond': () => {
      const err = new Error('抱抱过期了');
      err.code = 'HUG_EXPIRED';
      throw err;
    },
  });
  try {
    await page.load();
    await page.respondHug('h9');
    assert.strictEqual(page.data.hugSending, false);
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(vibrates, [], '失败不应振动');
    assert.ok(calls.filter((c) => c.action === 'home.get').length >= 2);
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

test('home: 新的抱抱回应只在首次出现时播心形动画，并写入本地已看列表', async () => {
  const { page, storeSet } = setup({
    'home.get': () =>
      baseHome({ hug: { incoming: null, outgoing: { hugId: 'h1', status: 'hugged', respondedAt: 't' } } }),
  });
  try {
    await page.load();
    const seen = storeSet.filter((s) => s.key === 'hug_seen_ids');
    assert.strictEqual(seen.length, 1);
    assert.deepStrictEqual(seen[0].value, ['h1']);
    await new Promise((r) => setTimeout(r, 50));
    assert.strictEqual(page.data.hugCelebrate, true);

    // 同一个 hugId 再刷新一次不能重播心形动画（文档 9.4：一次动画）
    let replays = 0;
    page.playHugCelebrate = () => {
      replays += 1;
    };
    page.maybeCelebrate(
      baseHome({
        hug: { incoming: null, outgoing: { hugId: 'h1', status: 'hugged', respondedAt: 't' } },
      })
    );
    assert.strictEqual(replays, 0, '同一个 hugId 已播过就不能再播');
    assert.strictEqual(storeSet.filter((s) => s.key === 'hug_seen_ids').length, 1);
  } finally {
    teardown(page);
    restoreWx();
  }
});
