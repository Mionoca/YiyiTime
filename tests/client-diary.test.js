'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

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

test('diary: 保存成功后把今天卡片写回列表，私密保存提示「只有你看过」', async () => {
  const today = tomorrowKey();
  const { page, toasts, calls } = setup({
    'diary.list': () => listRes({ todayKey: today, items: [] }),
    'diary.save': (payload) => {
      assert.strictEqual(payload.content, '晚安');
      assert.strictEqual(payload.visibility, 'private', '默认必须发私密（服务端仍会兜底）');
      assert.strictEqual(payload.moodScore, undefined, '没选心情就不传，服务端存 null');
      return {
        diary: {
          date: today, content: '晚安', moodScore: null, images: [], visibility: 'private',
          unlockMode: 'day', unlockAt: today + 'T16:00:00.000Z', updatedAt: 'u2',
        },
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
    assert.ok(toasts.some((t) => t.title === '收好了，只有你看过'));
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

test('diary: 首屏失败进错误态，静默刷新失败保留列表并给底部重试', async () => {
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
    // 已有数据后静默刷新失败：保留旧列表，整页错误态已退掉，只走 showError
    page.data.items = [{ date: '2026-11-01', mine: { content: '旧' } }];
    page.data.error = '';
    fail = true;
    await page.load(true);
    assert.strictEqual(page.data.items.length, 1);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(page.data.listError, '加载失败，点重试', '底部给重试入口（文档 12.9）');
    assert.strictEqual(page.data.error, '', '不退回整页错误态');
  } finally {
    restoreWx();
  }
});

test('diary: 加载更多失败保留列表并在底部给重试，点重试从游标继续', async () => {
  const today = tomorrowKey();
  const first = { date: today, mine: { content: '今天' }, partner: null };
  const older = { date: '2026-11-01', mine: { content: '旧的' }, partner: null };
  let failMore = true;
  const { page, calls, errors } = setup({
    'diary.list': (payload) => {
      if (!payload || !payload.beforeDate) {
        return listRes({ todayKey: today, items: [first], nextBeforeDate: '2026-11-02' });
      }
      assert.strictEqual(payload.beforeDate, '2026-11-02');
      if (failMore) throw new Error('down');
      return { items: [older], nextBeforeDate: '', todayKey: today };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.listError, '');
    await page.loadMore();
    assert.strictEqual(page.data.listError, '加载失败，点重试');
    assert.strictEqual(page.data.items.length, 1, '翻页失败保留已加载内容（文档 12.9）');
    assert.strictEqual(page.data.loadingMore, false);
    assert.strictEqual(errors.length, 1);
    failMore = false;
    await page.onRetryList();
    assert.strictEqual(page.data.items.length, 2, '点重试从同一个游标继续翻页');
    assert.strictEqual(page.data.items[1].date, '2026-11-01');
    assert.strictEqual(calls.filter((c) => c.action === 'diary.list').length, 3);
  } finally {
    restoreWx();
  }
});

test('diary: 静默刷新失败后点底部重试重拉第一页并清掉提示', async () => {
  const today = tomorrowKey();
  let fail = false;
  let lists = 0;
  const { page } = setup({
    'diary.list': () => {
      lists += 1;
      if (fail) throw new Error('down');
      return listRes({ todayKey: today, items: [{ date: today, unlockAt: 'x', mine: { content: '今天' }, partner: null }] });
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.items.length, 1);
    fail = true;
    await page.load(true);
    assert.strictEqual(page.data.listError, '加载失败，点重试');
    assert.strictEqual(page.data.items.length, 1);
    fail = false;
    const retry = page.onRetryList();
    // 文档 12.9：刷新失败后的重试也要静默，不能用整页 loading 盖掉已加载列表
    assert.strictEqual(page.data.loading, false, '重试不进入整页骨架');
    assert.strictEqual(page.data.items.length, 1, '重试过程中保留已加载列表');
    const retryAgain = page.onRetryList();
    assert.strictEqual(retry, retryAgain, '连点复用同一个在途请求');
    await retry;
    assert.strictEqual(lists, 3, '点重试重拉第一页而不是继续翻页；连点只发一次请求');
    assert.strictEqual(page.data.listError, '');
    assert.strictEqual(page.data.items.length, 1);
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

test('diary: 翻页失败后又刷新失败，点底部重试重拉第一页而不是续翻（错误类型不串味）', async () => {
  const today = tomorrowKey();
  const first = { date: today, mine: { content: '今天' }, partner: null };
  const older = { date: '2026-11-01', mine: { content: '旧的' }, partner: null };
  let failMore = true;
  let failList = false;
  const payloads = [];
  const { page } = setup({
    'diary.list': (payload) => {
      payloads.push(payload);
      if (!payload || !payload.beforeDate) {
        if (failList) throw new Error('down');
        return listRes({ todayKey: today, items: [first], nextBeforeDate: '2026-11-02' });
      }
      if (failMore) throw new Error('down');
      return { items: [older], nextBeforeDate: '', todayKey: today };
    },
  });
  try {
    await page.load();
    await page.loadMore();
    assert.strictEqual(page.data.listError, '加载失败，点重试');
    // 翻页失败后紧接着下拉静默刷新也失败：重试类型必须重置为 refresh
    failMore = false;
    failList = true;
    await page.load(true);
    assert.strictEqual(page.data.listError, '加载失败，点重试');
    failList = false;
    await page.onRetryList();
    assert.strictEqual(payloads.length, 4);
    assert.strictEqual(payloads[3].beforeDate, undefined, '刷新失败后的重试要从第一页开始，不能拿旧游标续翻');
    assert.strictEqual(page.data.listError, '');
    assert.strictEqual(page.data.items.length, 1);
  } finally {
    restoreWx();
  }
});

test('diary: 模板里的底部重试入口真实绑定且排在翻页提示之后（文档 12.9）', () => {
  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/diary/index.wxml'), 'utf8');
  assert.ok(wxml.includes('bindtap="onRetryList"'), '底部提示要绑 onRetryList');
  assert.ok(wxml.includes('wx:elif="{{listError}}"'), '用 wx:elif 接在翻页提示之后，避免与整页错误态/没有更多同时出现');
  assert.ok(wxml.includes('aria-role="button"'), '可点提示要有无障碍角色');
  assert.ok(wxml.includes('{{listError}}'), '提示文案来自 data.listError');
  const loadingMoreAt = wxml.indexOf('wx:if="{{loadingMore}}"');
  const listErrorAt = wxml.indexOf('wx:elif="{{listError}}"');
  assert.ok(loadingMoreAt >= 0, '翻页提示视图还在');
  assert.ok(listErrorAt > loadingMoreAt, '重试入口排在翻页提示之后');
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/diary/index.wxss'), 'utf8');
  assert.ok(/\.hint--error\s*\{[^}]*var\(--accent-(ink|strong)/.test(wxss), '重试文案用深色 token 保证对比度');
});

// 文档 5.3.7：已解锁的日记当天不能再改。immediate 档保存即解锁，
// 编辑器要提前说明，而不是让用户写完一屏再被 DIARY_LOCKED 拒掉
test('diary: immediate 档当天已解锁 → 编辑器只读，onSave 不发请求', async () => {
  const today = tomorrowKey();
  const { page, calls, toasts } = setup({
    'diary.list': () =>
      listRes({
        todayKey: today,
        items: [{
          date: today,
          unlockAt: 'x',
          mine: { content: '已经给 TA 看了', unlockMode: 'immediate', visibility: 'partner' },
          partner: null,
        }],
      }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.lockedToday, true);
    assert.strictEqual(page.data.shared, true, '已分享的开关状态仍要正确回填');
    const before = calls.length;
    await page.onSave();
    assert.strictEqual(calls.length, before, '只读时不能发 diary.save');
    assert.strictEqual(toasts[toasts.length - 1].title, '这篇已经给 TA 看过了，改不了');
  } finally {
    restoreWx();
  }
});

test('diary: day / week 档当天仍可编辑（只有 immediate 会当天解锁）', async () => {
  for (const unlockMode of ['day', 'week']) {
    const today = tomorrowKey();
    const { page } = setup({
      'diary.list': () =>
        listRes({
          todayKey: today,
          items: [{
            date: today,
            unlockAt: 'x',
            mine: { content: '还没解锁', unlockMode, visibility: 'partner' },
            partner: null,
          }],
        }),
    });
    try {
      await page.load();
      assert.strictEqual(page.data.lockedToday, false, unlockMode + ' 档不该锁编辑器');
    } finally {
      restoreWx();
    }
  }
});
