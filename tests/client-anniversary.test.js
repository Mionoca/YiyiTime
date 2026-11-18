'use strict';

// 纪念日管理页（文档 8.3.9 / 7.7）：只做增删改，展示与切换在首页堆叠里（9.4）。
// 这里锁页面动作与接口接线：列表映射、新增默认日期、编辑回填原始 date、删除二次确认、失败保留。
const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const constants = require('../miniprogram/utils/constants');

const PAGE = 'miniprogram/pages/anniversary/index.js';

function item(overrides) {
  return Object.assign({
    anniversaryId: 'a_1111111111111111',
    title: '第一次见面',
    date: '2023-06-01',
    nextDate: '2027-06-01',
    daysLeft: 197,
    years: 4,
    createdAt: '2026-01-01T00:00:00.000Z',
  }, overrides);
}

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const navs = [];
  installWx(Object.assign({
    showToast: (opts) => toasts.push(opts.title),
    showModal: (opts) => {
      const next = setup.modal ? setup.modal(opts) : { confirm: true };
      if (next) opts.success && opts.success(next);
    },
    navigateTo: (opts) => navs.push(opts.url),
  }, wxExtra || {}));
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (handlers[action]) return handlers[action](payload, calls.length);
    throw new Error('unexpected action: ' + action);
  };
  api.showError = (err) => errors.push(err);
  const page = instantiate(loadPage(PAGE));
  return { page, toasts, errors, calls, navs };
}

function teardown(page) {
  page.onUnload();
  restoreWx();
}

test('anniversary 页: 列表把服务端 items 映射成「标题 / 下一次日期 / 剩余天数 / 第几个」', async () => {
  const { page } = setup({
    'anniversary.list': () => ({
      todayKey: '2026-11-16',
      items: [
        item({ anniversaryId: 'a_1', title: '她的生日', date: '2019-11-16', nextDate: '2026-11-16', daysLeft: 0, years: 7 }),
        item({ anniversaryId: 'a_2', title: '婚礼', date: '2099-12-31', nextDate: '2099-12-31', daysLeft: 26600, years: 0 }),
      ],
    }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.todayKey, '2026-11-16');
    assert.strictEqual(page.data.items.length, 2);

    const [birthday, wedding] = page.data.items;
    assert.strictEqual(birthday.title, '她的生日');
    assert.strictEqual(birthday.daysText, '就是今天');
    assert.strictEqual(birthday.metaText, '第 7 个');
    assert.strictEqual(birthday.dateText, '2026年11月16日');
    // years 为 0（未来日期第一次还没到）时不显示「第 0 个」
    assert.strictEqual(wedding.metaText, '');
    assert.strictEqual(page.data.canAdd, true);
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 满 8 条时 canAdd 为 false，添加只提示不打开弹层', async () => {
  const items = [];
  for (let i = 0; i < constants.LIMITS.anniversaryCount; i += 1) {
    items.push(item({ anniversaryId: 'a_' + i, title: '纪念日' + i }));
  }
  const { page, toasts, calls } = setup({
    'anniversary.list': () => ({ todayKey: '2026-11-16', items }),
  });
  try {
    await page.load();
    assert.strictEqual(page.data.items.length, constants.LIMITS.anniversaryCount);
    assert.strictEqual(page.data.canAdd, false);
    page.onAdd();
    assert.strictEqual(page.data.formOpen, false);
    assert.ok(toasts.indexOf('纪念日最多记 ' + constants.LIMITS.anniversaryCount + ' 个') >= 0);
    assert.strictEqual(calls.length, 1, '只调了 list');
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 新增默认日期取服务端 todayKey，成功后用返回的 items 整体替换列表', async () => {
  let stored = [];
  const { page, toasts, calls } = setup({
    'anniversary.list': () => ({ todayKey: '2026-11-16', items: stored }),
    'anniversary.add': (payload) => {
      stored = [item({ anniversaryId: 'a_new', title: payload.title, date: payload.date, nextDate: payload.date, daysLeft: 0, years: 0 })];
      return { item: stored[0], items: stored };
    },
  });
  try {
    await page.load();
    page.onAdd();
    assert.strictEqual(page.data.formOpen, true);
    assert.strictEqual(page.data.editing, false);
    assert.strictEqual(page.data.form.date, '2026-11-16', '默认日期用服务端 todayKey，不用设备时钟');
    assert.strictEqual(page.data.titleMax, constants.LIMITS.anniversaryTitle);

    page.onTitleInput({ detail: { value: '  第一次见面  ' } });
    page.onDateChange({ detail: { value: '2023-06-01' } });
    await page.onSave();

    const addCall = calls.find((c) => c.action === 'anniversary.add');
    assert.deepStrictEqual(addCall.payload, { title: '第一次见面', date: '2023-06-01' }, '标题要去首尾空格');
    assert.strictEqual(page.data.formOpen, false);
    assert.strictEqual(page.data.saving, false);
    assert.strictEqual(page.data.items.length, 1);
    assert.strictEqual(page.data.items[0].title, '第一次见面');
    assert.strictEqual(toasts[toasts.length - 1], '记下啦');
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 空标题 / 空日期本地拦住，不发请求也不关弹层', async () => {
  const { page, toasts, calls } = setup({
    'anniversary.list': () => ({ todayKey: '2026-11-16', items: [] }),
  });
  try {
    await page.load();
    page.onAdd();
    page.onTitleInput({ detail: { value: '   ' } });
    await page.onSave();
    assert.ok(toasts.indexOf('给它起个名字吧') >= 0);
    assert.strictEqual(page.data.formOpen, true);

    page.onTitleInput({ detail: { value: '旅行' } });
    page.onDateChange({ detail: { value: '' } });
    page.setData({ 'form.date': '' });
    await page.onSave();
    assert.ok(toasts.indexOf('选一个日子吧') >= 0);

    assert.strictEqual(calls.filter((c) => c.action === 'anniversary.add').length, 0);
    assert.strictEqual(page.data.formOpen, true, '校验失败要保留弹层与输入');
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 编辑回填的是原始 date，不是列表里的「下一次」日期', async () => {
  const { page } = setup({
    'anniversary.list': () => ({
      todayKey: '2026-11-16',
      items: [item({ anniversaryId: 'a_1', date: '2023-06-01', nextDate: '2027-06-01' })],
    }),
  });
  try {
    await page.load();
    page.onEdit({ currentTarget: { dataset: { id: 'a_1' } } });
    assert.strictEqual(page.data.formOpen, true);
    assert.strictEqual(page.data.editing, true);
    assert.strictEqual(page.data.form.title, '第一次见面');
    // 拿 nextDate 回填会把「第一次见面 2023-06-01」悄悄改成 2027-06-01
    assert.strictEqual(page.data.form.date, '2023-06-01');
    assert.strictEqual(page.data.form.anniversaryId, 'a_1');
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 编辑保存走 update，成功后回列表并提示「改好啦」', async () => {
  const { page, toasts, calls } = setup({
    'anniversary.list': () => ({ todayKey: '2026-11-16', items: [item()] }),
    'anniversary.update': (payload) => {
      const next = item({ anniversaryId: payload.anniversaryId, title: payload.title, date: payload.date });
      return { item: next, items: [next] };
    },
  });
  try {
    await page.load();
    page.onEdit({ currentTarget: { dataset: { id: 'a_1111111111111111' } } });
    page.onTitleInput({ detail: { value: '初见' } });
    await page.onSave();
    const call = calls.find((c) => c.action === 'anniversary.update');
    assert.deepStrictEqual(call.payload, {
      anniversaryId: 'a_1111111111111111',
      title: '初见',
      date: '2023-06-01',
    });
    assert.strictEqual(page.data.items[0].title, '初见');
    assert.strictEqual(toasts[toasts.length - 1], '改好啦');
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 删除先二次确认；取消不发请求，确认后按返回 items 重排', async () => {
  let removed = false;
  const { page, toasts, calls } = setup({
    'anniversary.list': () => ({ todayKey: '2026-11-16', items: removed ? [] : [item()] }),
    'anniversary.remove': () => {
      removed = true;
      return { removed: true, items: [] };
    },
  });
  try {
    await page.load();

    setup.modal = () => ({ confirm: false });
    await page.onDelete({ currentTarget: { dataset: { id: 'a_1111111111111111' } } });
    assert.strictEqual(calls.filter((c) => c.action === 'anniversary.remove').length, 0, '取消不该发请求');
    assert.strictEqual(page.data.items.length, 1);

    setup.modal = () => ({ confirm: true });
    await page.onDelete({ currentTarget: { dataset: { id: 'a_1111111111111111' } } });
    assert.strictEqual(calls.filter((c) => c.action === 'anniversary.remove').length, 1);
    assert.strictEqual(page.data.items.length, 0);
    assert.strictEqual(toasts[toasts.length - 1], '删掉啦');
  } finally {
    setup.modal = null;
    teardown(page);
  }
});

test('anniversary 页: 首屏失败整页错误可重试；静默刷新失败保留列表并给底部重试', async () => {
  let fail = true;
  let silentFail = false;
  const { page, errors } = setup({
    'anniversary.list': () => {
      if (fail) throw new Error('down');
      if (silentFail) throw new Error('refresh down');
      return { todayKey: '2026-11-16', items: [item()] };
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.error, '纪念日打不开，再试一次');

    fail = false;
    await page.load();
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.items.length, 1);

    silentFail = true;
    await page.load(true);
    assert.strictEqual(page.data.items.length, 1, '刷新失败不能清空已加载列表');
    assert.strictEqual(page.data.listError, '加载失败，点重试');
    assert.strictEqual(errors.length, 0, '静默刷新失败只挂底部提示，不额外 toast');
  } finally {
    teardown(page);
  }
});

test('anniversary 页: 加载中卸载不再 setData（onUnload 守卫）', async () => {
  let release;
  const { page } = setup({
    'anniversary.list': () => new Promise((resolve) => {
      release = () => resolve({ todayKey: '2026-11-16', items: [item()] });
    }),
  });
  const run = page.load();
  page.onUnload();
  release();
  await run;
  assert.strictEqual(page.data.items.length, 0, '卸载后不该再写页面数据');
});
