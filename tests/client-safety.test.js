'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');

/**
 * 报平安页：日期展示用服务端 todayKey（文档 1.5）；
 * 成功与去重命中都要清空备注并刷新第一页（文档 8.3.5）。
 */
const SAFETY = 'miniprogram/pages/safety/index.js';

function tomorrowKey() {
  return timeUtil.dateKeyOf(Date.now() + 86400000);
}

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const vibrates = [];
  installWx(
    Object.assign(
      {
        showToast: (opts) => toasts.push(opts),
        vibrateShort: (opts) => vibrates.push(opts),
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
  const page = instantiate(loadPage(SAFETY));
  return { page, toasts, errors, calls, vibrates };
}

function entry(id, patch) {
  return Object.assign(
    { checkinId: id, openid: 'oB', date: tomorrowKey(), note: '', createdAt: '2026-11-17T02:00:00.000Z' },
    patch
  );
}

test('safety: 首屏用服务端 todayKey，时间线展示日期不依赖设备', async () => {
  const serverToday = tomorrowKey();
  const { page } = setup({
    'safety.list': () => ({ items: [entry('k1')], nextCursor: null, todayKey: serverToday }),
  });
  try {
    await page.load(true);
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.todayKey, serverToday);
    assert.notStrictEqual(page.data.todayKey, timeUtil.todayKey());
    assert.strictEqual(page.data.items.length, 1);
  } finally {
    restoreWx();
  }
});

test('safety: 检查成功清空备注、先把新记录插到顶部并刷新，并给一次轻振动', async () => {
  const { page, toasts, calls, vibrates } = setup({
    'safety.checkin': () => ({ entry: entry('k2'), deduped: false }),
    'safety.list': () => ({ items: [entry('k2'), entry('k1')], nextCursor: null, todayKey: tomorrowKey() }),
  });
  try {
    page.data.note = '到家啦';
    await page.onCheckin();
    assert.strictEqual(page.data.note, '');
    assert.strictEqual(page.data.checking, false);
    assert.strictEqual(page.data.items[0].checkinId, 'k2');
    assert.ok(toasts.some((t) => t.title === '我到家了'));
    // 文档 8.9：报平安成功给一次轻振动
    assert.deepStrictEqual(vibrates.map((v) => v.type), ['light']);
    assert.deepStrictEqual(
      calls.map((c) => c.action),
      ['safety.checkin', 'safety.list']
    );
  } finally {
    restoreWx();
  }
});

test('safety: 传备注时只传 note，空备注不传', async () => {
  let payloads = [];
  const { page } = setup({
    'safety.checkin': (payload) => {
      payloads.push(payload);
      return { entry: entry('k1'), deduped: false };
    },
    'safety.list': () => ({ items: [entry('k1')], nextCursor: null, todayKey: tomorrowKey() }),
  });
  try {
    page.data.note = '  有点晚  ';
    await page.onCheckin();
    page.data.note = '   ';
    await page.onCheckin();
    assert.deepStrictEqual(payloads[0], { note: '有点晚' });
    assert.deepStrictEqual(payloads[1], {});
  } finally {
    restoreWx();
  }
});

test('safety: 去重命中也要清空备注、提示并刷新第一页，且不重复振动', async () => {
  const { page, toasts, calls, vibrates } = setup({
    'safety.checkin': () => ({ entry: entry('k1'), deduped: true }),
    'safety.list': () => ({ items: [entry('k1')], nextCursor: null, todayKey: tomorrowKey() }),
  });
  try {
    page.data.note = '再报一次';
    await page.onCheckin();
    assert.strictEqual(page.data.note, '');
    assert.ok(toasts.some((t) => t.title === '刚刚已经报过平安'));
    assert.deepStrictEqual(vibrates, [], '去重命中不是新的成功，不振动');
    assert.ok(calls.some((c) => c.action === 'safety.list'));
  } finally {
    restoreWx();
  }
});

test('safety: 报平安失败保留备注并报错，且不振动', async () => {
  const { page, errors, vibrates } = setup({
    'safety.checkin': () => {
      throw new Error('down');
    },
  });
  try {
    page.data.note = '别丢';
    await page.onCheckin();
    assert.strictEqual(page.data.checking, false);
    assert.strictEqual(page.data.note, '别丢');
    assert.strictEqual(errors.length, 1);
    assert.deepStrictEqual(vibrates, [], '失败不应振动');
  } finally {
    restoreWx();
  }
});

test('safety: 加载更多用 cursor 并按 checkinId 去重合并', async () => {
  const first = entry('k1');
  const second = entry('k2');
  const { page } = setup({
    'safety.list': (payload) => {
      if (!payload.cursor) {
        return { items: [first], nextCursor: 'c1', todayKey: tomorrowKey() };
      }
      assert.strictEqual(payload.cursor, 'c1');
      // 游标边界重复返回 k1：必须去重，不能出现两条
      return { items: [first, second], nextCursor: null, todayKey: tomorrowKey() };
    },
  });
  try {
    await page.load(true);
    await page.loadMore();
    assert.deepStrictEqual(page.data.items.map((i) => i.checkinId), ['k1', 'k2']);
    assert.strictEqual(page.data.nextCursor, null);
    assert.strictEqual(page.data.loadingMore, false);
  } finally {
    restoreWx();
  }
});

test('safety: mergeItems 跳过空项与无 checkinId 的脏数据', () => {
  const { page } = setup({});
  try {
    const merged = page.mergeItems([entry('k1'), null, { note: 'no id' }], [entry('k1'), entry('k2')]);
    assert.deepStrictEqual(merged.map((i) => i.checkinId), ['k1', 'k2']);
  } finally {
    restoreWx();
  }
});

test('safety: 首屏失败进错误态；静默刷新失败保留列表只 toast', async () => {
  let fail = true;
  const { page, errors } = setup({
    'safety.list': () => {
      if (fail) throw new Error('down');
      return { items: [entry('k1')], nextCursor: null, todayKey: tomorrowKey() };
    },
  });
  try {
    await page.load(true);
    assert.strictEqual(page.data.error, '门口有点吵，再试一次');
    page.data.items = [entry('k1')];
    fail = true;
    await page.load(true, true);
    assert.strictEqual(page.data.items.length, 1);
    assert.strictEqual(errors.length, 1);
  } finally {
    restoreWx();
  }
});

test('safety: onLoad 拉第一页与我的资料，onShow 首次不重复请求、之后静默刷新', async () => {
  const meUtil = require('../miniprogram/utils/me');
  let lists = 0;
  const { page } = setup({
    'user.get': () => ({ user: { openid: 'oA', nickname: '小怡', profileComplete: true } }),
    'safety.list': () => {
      lists += 1;
      return { items: [entry('k1')], nextCursor: null, todayKey: tomorrowKey() };
    },
  });
  try {
    meUtil.clearMe();
    page.onLoad();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 1);
    assert.strictEqual(page.data.myOpenid, 'oA');
    page.onShow();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(lists, 1);
    page.onShow();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 2);
  } finally {
    meUtil.clearMe();
    restoreWx();
  }
});

test('safety: 下拉刷新静默重拉第一页并收起转圈', async () => {
  let lists = 0;
  let stops = 0;
  const { page } = setup(
    {
      'safety.list': () => {
        lists += 1;
        return { items: [entry('k1')], nextCursor: null, todayKey: tomorrowKey() };
      },
    },
    { stopPullDownRefresh: () => { stops += 1; } }
  );
  try {
    await page.load(true);
    assert.strictEqual(lists, 1);
    page.onPullDownRefresh();
    assert.strictEqual(page.data.loading, false, '下拉刷新是静默的，不应闪「正在看门口的灯」');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 2);
    assert.strictEqual(stops, 1);
    assert.strictEqual(page.data.items.length, 1, '静默刷新保留列表');
  } finally {
    restoreWx();
  }
});
