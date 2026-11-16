'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');

/**
 * 愿望页：统计以服务端 stats 为准（文档 7.11），
 * 打勾/删除用 pendingId 防重复点，失败要复位。
 */
const WISH = 'miniprogram/pages/wish/index.js';

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  installWx(
    Object.assign(
      {
        showToast: (opts) => toasts.push(opts),
        showModal: (opts) => {
          const next = setup.modal && setup.modal(opts);
          if (next) opts.success && opts.success(next);
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
  const page = instantiate(loadPage(WISH));
  return { page, toasts, errors, calls };
}

function loadRes(items, stats) {
  return { items: items || [], stats: stats || { total: 0, done: 0 } };
}

test('wish: 首屏用服务端 stats 计算进度，未满时可新增', async () => {
  const { page } = setup({
    'wish.list': () => loadRes([{ wishId: 'w1', done: true }], { total: 3, done: 1 }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.progressText, '1/3');
    assert.strictEqual(page.data.percent, 33);
    assert.strictEqual(page.data.canAdd, true);
    assert.strictEqual(page.data.error, '');
  } finally {
    restoreWx();
  }
});

test('wish: 达到上限时不能新增，点新增只提示不打开编辑器', async () => {
  const { page, toasts } = setup({
    'wish.list': () => loadRes([], { total: 100, done: 0 }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.canAdd, false);
    page.onAdd();
    assert.strictEqual(page.data.showEditor, false);
    assert.ok(toasts.some((t) => t.title === '愿望最多存 100 条'));
  } finally {
    restoreWx();
  }
});

test('wish: 打勾成功按服务端返回替换并按完成状态重排', async () => {
  const w1 = { wishId: 'w1', done: false, createdAt: '2026-11-01T00:00:00.000Z' };
  const w2 = { wishId: 'w2', done: false, createdAt: '2026-11-02T00:00:00.000Z' };
  const { page, calls } = setup({
    'wish.list': () => loadRes([w1, w2], { total: 2, done: 0 }),
    'wish.setDone': (payload) => {
      assert.deepStrictEqual(payload, { wishId: 'w2', done: true });
      return {
        wish: { wishId: 'w2', done: true, doneAt: '2026-11-17T00:00:00.000Z', createdAt: w2.createdAt },
        stats: { total: 2, done: 1 },
      };
    },
  });
  try {
    await page.load();
    await page.onToggle({ detail: { wishId: 'w2', done: true } });
    assert.deepStrictEqual(page.data.items.map((i) => i.wishId), ['w1', 'w2']);
    assert.strictEqual(page.data.items[1].done, true);
    assert.strictEqual(page.data.pendingId, '');
    assert.strictEqual(page.data.progressText, '1/2');
    assert.strictEqual(calls.filter((c) => c.action === 'wish.setDone').length, 1);
  } finally {
    restoreWx();
  }
});

test('wish: 打勾请求未返回时不接受第二次点击', async () => {
  let release;
  let setDoneCalls = 0;
  const { page, calls } = setup({
    'wish.list': () => loadRes([], { total: 2, done: 0 }),
    'wish.setDone': () => {
      setDoneCalls += 1;
      if (setDoneCalls > 1) {
        // 守卫失效时第二次调用会走到这里：立即返回，让断言能发现多发了一次
        return Promise.resolve({ wish: { wishId: 'w2', done: true }, stats: { total: 2, done: 2 } });
      }
      return new Promise((resolve) => {
        release = () =>
          resolve({ wish: { wishId: 'w1', done: true }, stats: { total: 2, done: 1 } });
      });
    },
  });
  try {
    await page.load();
    const first = page.onToggle({ detail: { wishId: 'w1', done: true } });
    await page.onToggle({ detail: { wishId: 'w2', done: true } });
    assert.strictEqual(page.data.pendingId, 'w1', '第二次点击不能改写正在提交的 wishId');
    release();
    await first;
    assert.strictEqual(page.data.pendingId, '');
    // 第二次点击必须被 pendingId 守卫拦下，只发一次 setDone
    const setDone = calls.filter((c) => c.action === 'wish.setDone');
    assert.strictEqual(setDone.length, 1);
    assert.deepStrictEqual(setDone[0].payload, { wishId: 'w1', done: true });
  } finally {
    restoreWx();
  }
});

test('wish: 打勾失败复位 pendingId 并报错', async () => {
  const { page, errors } = setup({
    'wish.list': () => loadRes([], { total: 1, done: 0 }),
    'wish.setDone': () => {
      throw new Error('down');
    },
  });
  try {
    await page.load();
    await page.onToggle({ detail: { wishId: 'w1', done: true } });
    assert.strictEqual(page.data.pendingId, '');
    assert.strictEqual(errors.length, 1);
  } finally {
    restoreWx();
  }
});

test('wish: 新增愿望提交 trim 后的标题与备注，成功后关编辑器并刷新', async () => {
  const { page, toasts, calls } = setup({
    'wish.list': () => loadRes([], { total: 0, done: 0 }),
    'wish.add': (payload) => {
      assert.deepStrictEqual(payload, { title: '去看海', note: '夏天' });
      return { wish: { wishId: 'w9' }, stats: { total: 1, done: 0 } };
    },
  });
  try {
    await page.load();
    page.setData({ showEditor: true, form: { title: ' 去看海 ', note: ' 夏天 ' } });
    await page.onSaveWish();
    assert.strictEqual(page.data.showEditor, false);
    assert.strictEqual(page.data.saving, false);
    assert.deepStrictEqual(page.data.form, { title: '', note: '' });
    assert.ok(toasts.some((t) => t.title === '记下啦'));
    assert.ok(calls.filter((c) => c.action === 'wish.list').length >= 2, '提交后应刷新列表');
  } finally {
    restoreWx();
  }
});

test('wish: 编辑已有愿望走 wish.update，不新增', async () => {
  const { page, toasts, calls } = setup({
    'wish.list': () => loadRes([{ wishId: 'w9', title: '旧', done: false }], { total: 1, done: 0 }),
    'wish.update': (payload) => {
      assert.deepStrictEqual(payload, { wishId: 'w9', title: '新的', note: '' });
      return { wish: { wishId: 'w9', title: '新的' } };
    },
  });
  try {
    await page.load();
    page.setData({
      showEditor: true,
      editing: { wishId: 'w9', title: '旧' },
      form: { title: '新的', note: '' },
    });
    await page.onSaveWish();
    assert.ok(toasts.some((t) => t.title === '改好啦'));
    assert.strictEqual(calls.filter((c) => c.action === 'wish.update').length, 1);
    assert.strictEqual(calls.filter((c) => c.action === 'wish.add').length, 0);
  } finally {
    restoreWx();
  }
});

test('wish: 标题为空时不提交', async () => {
  const { page, toasts, calls } = setup({
    'wish.list': () => loadRes([], { total: 0, done: 0 }),
  });
  try {
    await page.load();
    page.setData({ showEditor: true, form: { title: '   ', note: '' } });
    await page.onSaveWish();
    assert.strictEqual(page.data.showEditor, true);
    assert.strictEqual(calls.filter((c) => c.action === 'wish.add').length, 0);
    assert.ok(toasts.some((t) => t.title === '先写下想做的事'));
  } finally {
    restoreWx();
  }
});

test('wish: 删除确认后调用 wish.remove 并从列表移除', async () => {
  const { page, calls } = setup(
    {
      'wish.list': () => loadRes([{ wishId: 'w1' }, { wishId: 'w2' }], { total: 2, done: 0 }),
      'wish.remove': (payload) => {
        assert.deepStrictEqual(payload, { wishId: 'w1' });
        return { removed: true, stats: { total: 1, done: 0 } };
      },
    },
    {}
  );
  setup.modal = () => ({ confirm: true });
  try {
    await page.load();
    page.onRemove({ detail: { wishId: 'w1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepStrictEqual(page.data.items.map((i) => i.wishId), ['w2']);
    assert.strictEqual(page.data.pendingId, '');
    assert.strictEqual(page.data.progressText, '0/1');
    assert.ok(calls.some((c) => c.action === 'wish.remove'));
  } finally {
    setup.modal = null;
    restoreWx();
  }
});

test('wish: 删除弹窗取消则不请求', async () => {
  const { page, calls } = setup({
    'wish.list': () => loadRes([{ wishId: 'w1' }], { total: 1, done: 0 }),
  });
  setup.modal = () => ({ confirm: false });
  try {
    await page.load();
    page.onRemove({ detail: { wishId: 'w1' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.strictEqual(calls.filter((c) => c.action === 'wish.remove').length, 0);
    assert.strictEqual(page.data.items.length, 1);
  } finally {
    setup.modal = null;
    restoreWx();
  }
});

test('wish: sortWishes 未完成按创建升序在前，已完成按完成时间降序在后', () => {
  const { page } = setup({});
  try {
    const items = [
      { wishId: 'done-late', done: true, doneAt: '2026-11-10T00:00:00.000Z' },
      { wishId: 'b', done: false, createdAt: '2026-11-02T00:00:00.000Z' },
      { wishId: 'done-early', done: true, doneAt: '2026-11-01T00:00:00.000Z' },
      { wishId: 'a', done: false, createdAt: '2026-11-01T00:00:00.000Z' },
    ];
    items.sort(page.sortWishes);
    assert.deepStrictEqual(items.map((i) => i.wishId), ['a', 'b', 'done-late', 'done-early']);
  } finally {
    restoreWx();
  }
});

test('wish: 下拉刷新静默重拉并收起转圈', async () => {
  let lists = 0;
  let stops = 0;
  const { page } = setup(
    {
      'wish.list': () => {
        lists += 1;
        return loadRes([{ wishId: 'w1', done: false }], { total: 1, done: 0 });
      },
    },
    { stopPullDownRefresh: () => { stops += 1; } }
  );
  try {
    await page.load();
    assert.strictEqual(lists, 1);
    page.onPullDownRefresh();
    assert.strictEqual(page.data.loading, false, '下拉刷新是静默的，不应闪 loading');
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lists, 2);
    assert.strictEqual(stops, 1);
    assert.strictEqual(page.data.items.length, 1);
    assert.strictEqual(page.data.loading, false);
  } finally {
    restoreWx();
  }
});
