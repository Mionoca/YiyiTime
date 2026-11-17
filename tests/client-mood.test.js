'use strict';

/**
 * 心情记录页（文档 8.3.7）：只读时间线。
 * 关注点：日期文案只认服务端 todayKey（1.5 / 10.9）、两人合并成一天、
 * 翻页去重与错误降级（12.9）、下拉刷新、未绑定兜底、「我的」入口。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');
const constants = require('../miniprogram/utils/constants');

const ROOT = path.resolve(__dirname, '..');
const MOOD = 'miniprogram/pages/mood/index.js';
const PROFILE = 'miniprogram/pages/profile/index.js';
const LIST_ERROR_TEXT = '加载失败，点重试';

function tomorrowKey() {
  return timeUtil.dateKeyOf(Date.now() + 86400000);
}

function waitFor(predicate, timeoutMs) {
  const limit = timeoutMs || 1000;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > limit) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const stopped = [];
  let backs = 0;
  installWx(
    Object.assign(
      {
        showToast: (opts) => { toasts.push(opts); },
        navigateBack: () => { backs += 1; },
        stopPullDownRefresh: () => { stopped.push(1); },
      },
      wxExtra || {}
    )
  );
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (handlers[action]) return handlers[action](payload, calls.length);
    throw new Error('unexpected action: ' + action);
  };
  api.showError = (err) => { errors.push(err); };
  const page = instantiate(loadPage(MOOD));
  return {
    page, toasts, errors, calls, stopped,
    backs: () => backs,
  };
}

function listRes(patch) {
  return Object.assign({ days: [], nextBeforeDate: '', todayKey: tomorrowKey() }, patch);
}

test('mood 页: 用服务端 todayKey 打「今天 / 昨天」标签，不用设备时钟', async () => {
  const serverToday = tomorrowKey();
  const yesterday = timeUtil.shiftDateKey(serverToday, -1);
  const { page } = setup({
    'mood.list': () => listRes({
      todayKey: serverToday,
      days: [
        { date: serverToday, mine: { mood: 'rainy', note: '今天有点累', updatedAt: serverToday + 'T03:00:00.000Z' }, partner: null },
        { date: yesterday, mine: null, partner: { mood: 'sunny', note: '', updatedAt: yesterday + 'T02:00:00.000Z' } },
        { date: '2026-01-02', mine: null, partner: null },
      ],
    }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.todayKey, serverToday);
    // 设备上的今天与服务端不同：证明没有回退本地时钟
    assert.notStrictEqual(serverToday, timeUtil.todayKey());
    assert.deepStrictEqual(page.data.days.map((day) => day.label), ['今天', '昨天', '1月2日']);
    assert.deepStrictEqual(page.data.days.map((day) => day.dateText), [
      timeUtil.formatMonthDay(serverToday),
      timeUtil.formatMonthDay(yesterday),
      '1月2日',
    ]);
  } finally {
    restoreWx();
  }
});

test('mood 页: 两人合并成一天，备注与时刻只在该行展示', async () => {
  const today = tomorrowKey();
  const { page } = setup({
    'mood.list': () => listRes({
      todayKey: today,
      days: [{
        date: today,
        mine: { mood: 'rainy', note: '今天有点累', updatedAt: today + 'T03:00:00.000Z' },
        partner: { mood: 'sunny', note: '', updatedAt: today + 'T02:30:00.000Z' },
      }],
    }),
  });
  try {
    await page.load();
    const day = page.data.days[0];
    assert.deepStrictEqual(day.rows.map((row) => row.who), ['我', 'TA']);
    assert.deepStrictEqual(day.rows[0].mood, {
      emoji: '🌧️', label: '雨', note: '今天有点累', time: '11:00',
    });
    assert.deepStrictEqual(day.rows[1].mood, {
      emoji: '☀️', label: '晴', note: '', time: '10:30',
    });
    assert.match(day.a11y, /^今天，我 雨 今天有点累，TA 晴$/);
  } finally {
    restoreWx();
  }
});

test('mood 页: 当天没打卡渲染「没说」而不是空行', async () => {
  const today = tomorrowKey();
  const { page } = setup({
    'mood.list': () => listRes({
      todayKey: today,
      days: [{ date: today, mine: null, partner: { mood: 'cloudy', note: '', updatedAt: today + 'T01:00:00.000Z' } }],
    }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.days[0].rows[0].mood, null);
    assert.strictEqual(page.data.days[0].rows[1].mood.label, '阴');
    assert.match(page.data.days[0].a11y, /我 没说/);
  } finally {
    restoreWx();
  }
});

test('mood 页: 没有记录时是空态，且不显示「没有更多啦」', async () => {
  const { page } = setup({ 'mood.list': () => listRes({}) });
  try {
    await page.load();
    assert.deepStrictEqual(page.data.days, []);
    assert.strictEqual(page.data.hasMore, false);
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
  } finally {
    restoreWx();
  }
});

test('mood 页: 首屏失败给整页错误和重试，不渲染空列表', async () => {
  const boom = new Error('network down');
  const { page } = setup({
    'mood.list': () => { throw boom; },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.error, '心情记录本打不开，再试一次');
    assert.deepStrictEqual(page.data.days, []);
  } finally {
    restoreWx();
  }
});

test('mood 页: 静默刷新失败保留已加载内容，底部提示可点重试', async () => {
  const today = tomorrowKey();
  let fail = false;
  const { page, errors } = setup({
    'mood.list': () => {
      if (fail) throw new Error('network down');
      return listRes({
        todayKey: today,
        days: [{ date: today, mine: { mood: 'sunny', note: '', updatedAt: today + 'T01:00:00.000Z' }, partner: null }],
      });
    },
  });
  try {
    await page.load();
    fail = true;
    await page.load(true);
    assert.strictEqual(page.data.days.length, 1, '静默刷新失败不能清空列表');
    assert.strictEqual(page.data.listError, LIST_ERROR_TEXT);
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(errors.length, 1);
  } finally {
    restoreWx();
  }
});

test('mood 页: 翻页失败保留列表，重试从同一游标继续', async () => {
  const today = tomorrowKey();
  const base = [today, timeUtil.shiftDateKey(today, -1), timeUtil.shiftDateKey(today, -2)];
  let fail = true;
  const { page, calls } = setup({
    'mood.list': (payload) => {
      if (!payload.beforeDate) {
        return listRes({
          todayKey: today,
          nextBeforeDate: base[1],
          days: [{ date: base[0], mine: { mood: 'sunny', note: '', updatedAt: today + 'T01:00:00.000Z' }, partner: null }],
        });
      }
      if (fail) throw new Error('network down');
      return listRes({
        todayKey: today,
        nextBeforeDate: '',
        days: [{ date: base[1], mine: null, partner: { mood: 'rainy', note: '', updatedAt: today + 'T02:00:00.000Z' } }],
      });
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.hasMore, true);
    await page.loadMore();
    assert.strictEqual(page.data.listError, LIST_ERROR_TEXT);
    assert.strictEqual(page.data.days.length, 1, '翻页失败不能丢掉已加载的一天');

    fail = false;
    await page.onRetryList();
    assert.deepStrictEqual(calls.map((call) => call.payload.beforeDate || null), [null, base[1], base[1]]);
    assert.strictEqual(page.data.days.length, 2);
    assert.strictEqual(page.data.listError, '');
    assert.strictEqual(page.data.hasMore, false);
  } finally {
    restoreWx();
  }
});

test('mood 页: 翻页按 date 去重，边界不会插重复的一天', async () => {
  const today = tomorrowKey();
  const yesterday = timeUtil.shiftDateKey(today, -1);
  const day = (date) => ({ date, mine: { mood: 'sunny', note: '', updatedAt: date + 'T01:00:00.000Z' }, partner: null });
  const { page } = setup({
    'mood.list': (payload) => {
      if (!payload.beforeDate) {
        return listRes({ todayKey: today, nextBeforeDate: yesterday, days: [day(today)] });
      }
      // 服务端多返回了本页最后一天：客户端要按 date 去重
      return listRes({ todayKey: today, nextBeforeDate: '', days: [day(today), day(yesterday)] });
    },
  });
  try {
    await page.load();
    await page.loadMore();
    assert.deepStrictEqual(page.data.days.map((item) => item.date), [today, yesterday]);
  } finally {
    restoreWx();
  }
});

test('mood 页: 下拉刷新只发一次请求、收起转圈一次', async () => {
  const { page, calls, stopped } = setup({ 'mood.list': () => listRes({}) });
  try {
    await page.load();
    const before = calls.length;
    page.onPullDownRefresh();
    await waitFor(() => stopped.length === 1);
    assert.strictEqual(calls.length - before, 1);
    assert.strictEqual(stopped.length, 1);
  } finally {
    restoreWx();
  }
});

test('mood 页: 未绑定（NOT_BOUND）提示后返回上一页，不渲染空列表', async () => {
  const { page, errors, backs } = setup({
    'mood.list': () => {
      const err = new Error('先邀请 TA 住进来吧');
      err.code = 'NOT_BOUND';
      throw err;
    },
  });
  try {
    await page.load();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(backs(), 1);
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '', '返回上一页时不该同时渲染整页错误');
    assert.strictEqual(page.data.listError, '');
  } finally {
    restoreWx();
  }
});

test('mood 页: 模板绑定与组件注册齐全（静态）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mood/index.wxml'), 'utf8');
  assert.ok(wxml.indexOf('bindtap="onRetryList"') >= 0, '底部重试必须绑 onRetryList');
  assert.ok(wxml.indexOf('aria-label="重新加载心情记录"') >= 0, '底部重试要有可读标签');
  assert.ok(wxml.indexOf('aria-role="button"') >= 0, '底部重试要有 button 角色（8.9）');
  assert.ok(wxml.indexOf('bind:action="onRetry"') >= 0, '整页重试必须绑 onRetry');
  assert.ok(wxml.indexOf('aria-label="{{item.a11y}}"') >= 0, '一天一张卡要有读屏文案');
  assert.ok(wxml.indexOf('aria-role="listitem"') >= 0, '一天一张卡要有列表项角色（8.9）');

  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/mood/index.json'), 'utf8'));
  assert.strictEqual(json.enablePullDownRefresh, true, '子页要支持下拉刷新（文档 L637）');
  assert.ok(json.usingComponents && json.usingComponents['empty-state'], 'empty-state 必须在页面 json 注册');

  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.indexOf('pages/mood/index') >= 0, '新页面必须在 app.json 注册');
  assert.strictEqual(constants.ROUTES.mood, '/pages/mood/index');
});

test('mood 页: 客户端日期工具跨月/跨年正确（「昨天」不会算错）', () => {
  assert.strictEqual(timeUtil.shiftDateKey('2026-03-01', -1), '2026-02-28');
  assert.strictEqual(timeUtil.shiftDateKey('2026-01-01', -1), '2025-12-31');
  assert.strictEqual(timeUtil.shiftDateKey('2024-03-01', -1), '2024-02-29');
  assert.strictEqual(timeUtil.shiftDateKey('bad', -1), '');
  assert.strictEqual(timeUtil.formatHM('2026-11-16T16:05:00.000Z'), '00:05');
  assert.strictEqual(timeUtil.formatHM(''), '');
  assert.strictEqual(timeUtil.formatHM('not-a-date'), '');
});

test('profile: 已绑定点「心情记录」走 navigateTo，未绑定只提示不跳转', async () => {
  const nav = [];
  const toasts = [];
  installWx({
    // 心情记录是普通页（文档 8.2），走 navigateTo；switchTab 只该给「今天 / 我的」两个 tab 用
    switchTab: (opts) => { nav.push('switchTab:' + opts.url); },
    navigateTo: (opts) => { nav.push(opts.url); },
    showToast: (opts) => { toasts.push(opts); },
  });
  try {
    api.call = async () => ({
      user: { nickname: '小怡', avatarFileID: '' },
      couple: { startDate: '2024-05-20', daysTogether: 911, anniversary: null },
      bind: { state: 'bound' },
      todayKey: tomorrowKey(),
    });
    const page = instantiate(loadPage(PROFILE));
    await page.load();
    page.onOpenMood();
    assert.deepStrictEqual(nav, [constants.ROUTES.mood]);

    // 未绑定：只 toast，不跳转
    api.call = async () => ({
      user: { nickname: '小怡', avatarFileID: '' },
      couple: null,
      bind: { state: 'unbound' },
      todayKey: tomorrowKey(),
    });
    const unboundPage = instantiate(loadPage(PROFILE));
    await unboundPage.load();
    unboundPage.onOpenMood();
    assert.deepStrictEqual(nav, [constants.ROUTES.mood], '未绑定不应再跳转');
    assert.match(toasts[toasts.length - 1].title, /先邀请 TA 住进来吧/);
  } finally {
    restoreWx();
  }
});

test('mood 页: onShow 静默刷新第一页，不闪 loading、不清已加载内容', async () => {
  const today = tomorrowKey();
  let version = 1;
  const { page, calls } = setup({
    'mood.list': () => listRes({
      todayKey: today,
      days: [{
        date: today,
        mine: { mood: 'sunny', note: version === 1 ? '第一次' : '刷新后', updatedAt: today + 'T01:00:00.000Z' },
        partner: null,
      }],
    }),
  });
  try {
    page.onLoad(); // 真实生命周期：onLoad 拉第一页，紧随其后的 onShow 不能重复请求
    await waitFor(() => page.data.days.length === 1);
    assert.strictEqual(page.data.days[0].rows[0].mood.note, '第一次');
    assert.strictEqual(calls.length, 1);

    page.onShow();
    assert.strictEqual(calls.length, 1, '首屏已经拉过，首次 onShow 不该重复请求');

    version = 2;
    page.onShow();
    await waitFor(() => page.data.days[0] && page.data.days[0].rows[0].mood.note === '刷新后');
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(page.data.loading, false, '静默刷新不能闪整页 loading');
  } finally {
    restoreWx();
  }
});

test('mood 页: 空列表时静默刷新失败退回整页错误（不挂底部重试）', async () => {
  let fail = false;
  const { page } = setup({
    'mood.list': () => {
      if (fail) throw new Error('network down');
      return listRes({ days: [] });
    },
  });
  try {
    await page.load();
    fail = true;
    await page.load(true);
    assert.strictEqual(page.data.error, '心情记录本打不开，再试一次');
    assert.strictEqual(page.data.listError, '', '没有已加载内容时不该只给底部提示');
  } finally {
    restoreWx();
  }
});

test('mood 页: 连点底部重试复用同一个请求', async () => {
  const today = tomorrowKey();
  let fail = true;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { page, calls } = setup({
    'mood.list': (payload) => {
      if (!payload.beforeDate) {
        return listRes({
          todayKey: today,
          nextBeforeDate: today,
          days: [{ date: today, mine: { mood: 'sunny', note: '', updatedAt: today + 'T01:00:00.000Z' }, partner: null }],
        });
      }
      if (fail) throw new Error('network down');
      return gate.then(() => listRes({ todayKey: today, days: [] }));
    },
  });
  try {
    await page.load();
    await page.loadMore();
    assert.strictEqual(page.data.listError, LIST_ERROR_TEXT);
    fail = false;

    const first = page.onRetryList();
    const second = page.onRetryList();
    assert.strictEqual(first, second, '连点必须复用同一个在途请求');
    release();
    await first;
    const retryCalls = calls.filter((call) => call.payload.beforeDate);
    assert.strictEqual(retryCalls.length, 2, '失败一次 + 重试一次，不应有第三次');
  } finally {
    restoreWx();
  }
});

test('mood 页: 刷新在途时旧翻页响应作废，不会拼出缺页的列表', async () => {
  const today = tomorrowKey();
  const yesterday = timeUtil.shiftDateKey(today, -1);
  const older = timeUtil.shiftDateKey(today, -2);
  let releaseMore;
  const gateMore = new Promise((resolve) => { releaseMore = resolve; });
  let refreshDone = false;
  const day = (date, note) => ({ date, mine: { mood: 'sunny', note, updatedAt: date + 'T01:00:00.000Z' }, partner: null });

  const { page } = setup({
    'mood.list': (payload) => {
      if (!payload.beforeDate) {
        refreshDone = false;
        return listRes({
          todayKey: today,
          nextBeforeDate: yesterday,
          days: [day(today, refreshDone ? '刷新后' : '第一页')],
        });
      }
      // 翻页请求挂在 gate 上，等静默刷新完成后再返回（旧游标 + 旧数据）
      return gateMore.then(() => listRes({ todayKey: today, days: [day(older, '旧翻页')] }));
    },
  });
  try {
    await page.load();
    const morePromise = page.loadMore(); // 在途
    await page.load(true);               // 静默刷新：令牌递增
    releaseMore();
    await morePromise;

    assert.deepStrictEqual(page.data.days.map((item) => item.date), [today],
      '作废的翻页响应不能追加到刷新后的列表');
    assert.strictEqual(page.data.loadingMore, false, '作废响应也要收起转圈');
  } finally {
    restoreWx();
  }
});

test('mood 页: 卸载后不再 setData', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { page } = setup({
    'mood.list': () => gate.then(() => listRes({ days: [] })),
  });
  try {
    const pending = page.load();
    page.onUnload();
    release();
    await pending;
    assert.deepStrictEqual(page.data.days, []);
    assert.strictEqual(page.data.loading, true, '卸载后不该再改页面状态');
  } finally {
    restoreWx();
  }
});

test('mood 页: 未绑定且返回失败时退回整页提示（navigateBack fail 兜底）', async () => {
  const toasts = [];
  installWx({
    showToast: (opts) => { toasts.push(opts); },
    navigateBack: (opts) => {
      if (opts && typeof opts.fail === 'function') opts.fail(new Error('no page'));
    },
  });
  try {
    api.call = async () => {
      const err = new Error('先邀请 TA 住进来吧');
      err.code = 'NOT_BOUND';
      throw err;
    };
    api.showError = () => {};
    const page = instantiate(loadPage(MOOD));
    await page.load();
    assert.strictEqual(page.data.error, '先邀请 TA 住进来吧');
    assert.strictEqual(page.data.loading, false);
  } finally {
    restoreWx();
  }
});
