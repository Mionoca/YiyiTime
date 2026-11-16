'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');

/**
 * 日记页：日期判断只认服务端下发的 todayKey（文档 1.5 / 10.9），
 * 设备本地时钟不能参与「今天写的是哪篇」与跨天判断（否则会覆盖昨天的日记）。
 */
const DIARY = 'miniprogram/pages/diary/index.js';

function tomorrowKey() {
  return timeUtil.dateKeyOf(Date.now() + 86400000);
}

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  installWx(
    Object.assign(
      {
        showToast: (opts) => {
          toasts.push(opts);
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
  api.showError = (err) => {
    errors.push(err);
  };
  const page = instantiate(loadPage(DIARY));
  return { page, toasts, errors, calls };
}

function listRes(patch) {
  return Object.assign({ items: [], nextBeforeDate: '', todayKey: tomorrowKey() }, patch);
}

test('diary: 首屏用服务端 todayKey 找今天的日记，不用设备时钟', async () => {
  const serverToday = tomorrowKey();
  const { page } = setup({
    'diary.list': () =>
      listRes({
        todayKey: serverToday,
        items: [
          { date: serverToday, unlockAt: 'x', mine: { content: '今天的日记', updatedAt: 't' }, partner: null },
        ],
      }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.todayKey, serverToday);
    // 设备上的今天与服务端今天不同：证明没有回退本地时钟
    assert.notStrictEqual(page.data.todayKey, timeUtil.todayKey());
    assert.strictEqual(page.data.content, '今天的日记');
    assert.strictEqual(page.data.canSave, true);
  } finally {
    restoreWx();
  }
});

test('diary: 服务端没下发 todayKey 时才回退设备时钟', async () => {
  const { page } = setup({
    'diary.list': () => ({ items: [], nextBeforeDate: '' }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.todayKey, timeUtil.todayKey());
  } finally {
    restoreWx();
  }
});

test('diary: 跨天静默刷新时重初始化编辑器并提示昨晚草稿没保存', async () => {
  let day = '2026-11-16';
  const { page, toasts } = setup({
    'diary.list': () =>
      listRes({
        todayKey: day,
        items: day === '2026-11-16' ? [] : [{ date: day, mine: { content: '新的一天' }, partner: null }],
      }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.content, '');
    page.setData({ content: '昨晚写了一半' });
    day = '2026-11-17';
    await page.load(true);
    assert.strictEqual(page.data.todayKey, '2026-11-17');
    assert.strictEqual(page.data.content, '新的一天');
    const toast = toasts.filter((t) => t.title === '新的一天了，昨晚的草稿没保存');
    assert.strictEqual(toast.length, 1);
  } finally {
    restoreWx();
  }
});

test('diary: 同一天静默刷新不覆盖正在输入的草稿', async () => {
  const today = tomorrowKey();
  const { page } = setup({
    'diary.list': () => listRes({ todayKey: today, items: [{ date: today, mine: { content: '已保存的' }, partner: null }] }),
  });
  try {
    await page.load();
    page.setData({ content: '写到一半' });
    await page.load(true);
    assert.strictEqual(page.data.content, '写到一半');
    assert.strictEqual(page.data.todayKey, today);
  } finally {
    restoreWx();
  }
});

test('diary: 保存成功后把今天卡片写回列表并提示明天可见', async () => {
  const today = tomorrowKey();
  const { page, toasts, calls } = setup({
    'diary.list': () => listRes({ todayKey: today, items: [] }),
    'diary.save': (payload) => {
      assert.strictEqual(payload.content, '晚安');
      return {
        diary: { date: today, content: '晚安', unlockAt: today + 'T16:00:00.000Z', updatedAt: 'u2' },
      };
    },
  });
  try {
    await page.load();
    page.setData({ content: '晚安' });
    await page.onSave();
    assert.strictEqual(page.data.saving, false);
    assert.strictEqual(page.data.items.length, 1);
    assert.strictEqual(page.data.items[0].date, today);
    assert.strictEqual(page.data.items[0].mine.content, '晚安');
    assert.ok(toasts.some((t) => t.title === '明天 TA 才能看到'));
    assert.ok(calls.some((c) => c.action === 'diary.save'));
  } finally {
    restoreWx();
  }
});

test('diary: 保存失败保留草稿并报错', async () => {
  const today = tomorrowKey();
  const errors = [];
  const { page } = setup({
    'diary.list': () => listRes({ todayKey: today, items: [] }),
    'diary.save': () => {
      throw new Error('network down');
    },
  });
  try {
    page.data.content = '别丢了我';
    await page.onSave();
    assert.strictEqual(page.data.saving, false);
    assert.strictEqual(page.data.content, '别丢了我');
  } finally {
    restoreWx();
  }
});

test('diary: 加载更多用 beforeDate 游标追加，不重复首屏', async () => {
  const today = tomorrowKey();
  const first = { date: today, mine: { content: '今天' }, partner: null };
  const older = { date: '2026-11-01', mine: { content: '旧的' }, partner: null };
  const { page, calls } = setup({
    'diary.list': (payload) => {
      if (!payload || !payload.beforeDate) {
        return listRes({ todayKey: today, items: [first], nextBeforeDate: '2026-11-02' });
      }
      assert.strictEqual(payload.beforeDate, '2026-11-02');
      return { items: [older], nextBeforeDate: '', todayKey: today };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.hasMore, true);
    await page.loadMore();
    assert.strictEqual(page.data.items.length, 2);
    assert.strictEqual(page.data.items[1].date, '2026-11-01');
    assert.strictEqual(page.data.hasMore, false);
    assert.strictEqual(page.data.loadingMore, false);
    assert.strictEqual(calls.filter((c) => c.action === 'diary.list').length, 2);
  } finally {
    restoreWx();
  }
});

test('diary: 首屏失败进错误态，静默刷新失败只 toast 不清空列表', async () => {
  let fail = true;
  const { page, errors } = setup({
    'diary.list': () => {
      if (fail) throw new Error('down');
      return listRes({ items: [], todayKey: tomorrowKey() });
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.error, '台灯好像没插好，再试一次');
    assert.strictEqual(page.data.loading, false);
    // 已有数据后静默刷新失败：保留旧列表，只走 showError
    page.data.items = [{ date: '2026-11-01', mine: { content: '旧' } }];
    fail = true;
    await page.load(true);
    assert.strictEqual(page.data.items.length, 1);
    assert.strictEqual(errors.length, 1);
  } finally {
    restoreWx();
  }
});

test('diary: onShow 首次不重复请求，之后回到页面静默刷新', async () => {
  const { page, calls } = setup({
    'diary.list': () => listRes({ items: [], todayKey: tomorrowKey() }),
  });
  try {
    page._firstShow = true;
    page.onShow();
    assert.strictEqual(calls.length, 0);
    page._loaded = true;
    page.onShow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls.filter((c) => c.action === 'diary.list').length, 1);
  } finally {
    restoreWx();
  }
});

test('diary: onLoad 拉第一页，onShow 首次不重复请求、之后静默刷新', async () => {
  let lists = 0;
  const { page } = setup({
    'diary.list': () => {
      lists += 1;
      return listRes();
    },
  });
  try {
    page.onLoad();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 1);
    page.onShow();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(lists, 1);
    page.onShow();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 2);
  } finally {
    restoreWx();
  }
});

test('diary: 下拉刷新静默重拉第一页并收起转圈（失败也收起）', async () => {
  let lists = 0;
  let stops = 0;
  let fail = false;
  const { page, errors } = setup(
    {
      'diary.list': () => {
        lists += 1;
        if (fail) throw new Error('down');
        return listRes({ items: [{ date: tomorrowKey(), unlockAt: 'x', mine: null, partner: null }] });
      },
    },
    { stopPullDownRefresh: () => { stops += 1; } }
  );
  try {
    await page.load();
    assert.strictEqual(lists, 1);
    page.onPullDownRefresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 2, '下拉刷新重新拉第一页');
    assert.strictEqual(stops, 1, '成功要收起转圈');
    assert.strictEqual(page.data.items.length, 1);
    fail = true;
    page.onPullDownRefresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 3);
    assert.strictEqual(stops, 2, '失败也要收起转圈');
    assert.strictEqual(errors.length, 1, '静默刷新失败只 toast');
    assert.strictEqual(page.data.items.length, 1, '失败保留旧列表');
    assert.strictEqual(page.data.loading, false);
  } finally {
    restoreWx();
  }
});
