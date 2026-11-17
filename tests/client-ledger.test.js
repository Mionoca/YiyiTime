'use strict';

/**
 * 记账本页（文档 8.3.8）：我的 / TA 的切换、按月查看、按天分组、记一笔 / 改 / 删。
 * 关注点：金额元↔分换算不丢精度、只有自己的条目能编辑、月份不能翻到未来、
 * 失败保留已加载内容（12.9）、下拉刷新只发一次请求、卸载后不 setData。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');
const format = require('../miniprogram/utils/format');
const constants = require('../miniprogram/utils/constants');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = 'miniprogram/pages/ledger/index.js';
const LEDGER_WXML = 'miniprogram/pages/ledger/index.wxml';
const LIST_ERROR_TEXT = '加载失败，点重试';

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const stopped = [];
  let backs = 0;
  installWx(Object.assign({
    showToast: (opts) => { toasts.push(opts); },
    navigateBack: () => { backs += 1; },
    stopPullDownRefresh: () => { stopped.push(1); },
    showModal: (opts) => {
      const next = setup.modal && setup.modal(opts);
      if (next) opts.success && opts.success(next);
    },
  }, wxExtra || {}));
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (handlers[action]) return handlers[action](payload, calls.length);
    throw new Error('unexpected action: ' + action);
  };
  api.showError = (err) => { errors.push(err); };
  const page = instantiate(loadPage(LEDGER));
  return {
    page, toasts, errors, calls, stopped, backs: () => backs,
  };
}

function listRes(patch) {
  return Object.assign({
    who: 'me',
    month: '2026-11',
    todayKey: '2026-11-16',
    partner: { nickname: '阿泽' },
    items: [],
    summary: { total: 0, count: 0 },
  }, patch);
}

const ITEMS = [
  {
    entryId: 'le_1', amount: 2350, category: 'food', note: '牛肉面', date: '2026-11-16',
  },
  {
    entryId: 'le_2', amount: 500, category: 'transport', note: '', date: '2026-11-14',
  },
];

test('ledger 页: 首屏按月拉取，按天分组并给出每天小计与合计', async () => {
  const { page, calls } = setup({
    'ledger.list': () => listRes({ items: ITEMS, summary: { total: 2850, count: 2 } }),
  });
  try {
    await page.load();
    assert.deepStrictEqual(calls[0], { action: 'ledger.list', payload: { who: 'me' } });
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.month, '2026-11');
    assert.strictEqual(page.data.monthText, '2026年11月');
    assert.strictEqual(page.data.canGoNext, false, '当前月不能再往后翻');
    assert.strictEqual(page.data.summaryText, '¥28.50');
    assert.strictEqual(page.data.summaryCount, 2);
    assert.deepStrictEqual(page.data.groups.map((group) => group.date), ['2026-11-16', '2026-11-14']);
    assert.strictEqual(page.data.groups[0].label, '今天');
    assert.strictEqual(page.data.groups[0].items[0].amountText, '¥23.50');
    assert.strictEqual(page.data.groups[0].items[0].categoryLabel, '吃饭');
    assert.strictEqual(page.data.groups[0].totalText, '¥23.50');
    assert.strictEqual(page.data.groups[1].totalText, '¥5.00');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 切到 TA 的账本会清掉旧列表并按 who=partner 重拉', async () => {
  const { page, calls } = setup({
    'ledger.list': (payload) => listRes({
      who: payload.who,
      month: payload.month || '2026-11',
      items: payload.who === 'partner' ? [Object.assign({}, ITEMS[0], { entryId: 'le_p' })] : ITEMS,
      summary: { total: 2350, count: 1 },
    }),
  });
  try {
    await page.load();
    await page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    assert.deepStrictEqual(calls[1].payload, { who: 'partner', month: '2026-11' });
    assert.strictEqual(page.data.who, 'partner');
    assert.strictEqual(page.data.summaryLabel, '阿泽这个月花了');
    assert.deepStrictEqual(page.data.groups[0].items.map((item) => item.entryId), ['le_p']);
    assert.strictEqual(page.data.groups[0].items[0].mine, false, 'TA 的账只读');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 点 TA 的条目不打开表单，只提示', async () => {
  const { page, toasts } = setup({
    'ledger.list': (payload) => listRes({
      who: payload.who,
      items: [Object.assign({}, ITEMS[0], { entryId: 'le_p' })],
    }),
  });
  try {
    await page.load();
    await page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    page.onTapEntry({ currentTarget: { dataset: { id: 'le_p' } } });
    assert.strictEqual(page.data.formOpen, false);
    assert.strictEqual(toasts[toasts.length - 1].title, 'TA 的账本只能看');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 月份切换只发允许的请求，当前月不能再往后', async () => {
  const { page, calls } = setup({
    'ledger.list': (payload) => listRes({ month: payload.month || '2026-11' }),
  });
  try {
    await page.load();
    await page.onPrevMonth();
    assert.deepStrictEqual(calls[1].payload, { who: 'me', month: '2026-10' });
    assert.strictEqual(page.data.month, '2026-10');
    assert.strictEqual(page.data.canGoNext, true, '回到当前月之前，可以往后翻');

    const before = calls.length;
    page.onNextMonth();
    assert.strictEqual(calls.length, before + 1, '往后翻一页到当前月');
    assert.strictEqual(page.data.month, '2026-11');

    page.data.canGoNext = false;
    const guard = calls.length;
    page.onNextMonth();
    assert.strictEqual(calls.length, guard, '已经在当前月，再点 › 不该发请求');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 记一笔把「元」转成整数分提交，备注去空格', async () => {
  const { page, calls, toasts } = setup({
    'ledger.list': () => listRes(),
    'ledger.add': () => ({ entry: { entryId: 'le_new' } }),
  });
  try {
    await page.load();
    page.onOpenForm();
    assert.strictEqual(page.data.form.date, '2026-11-16', '默认日期用服务端 todayKey');
    page.onAmountInput({ detail: { value: '12.5' } });
    page.onPickCategory({ currentTarget: { dataset: { key: 'fun' } } });
    page.onNoteInput({ detail: { value: '  看电影  ' } });
    await page.onSaveEntry();

    const add = calls.find((call) => call.action === 'ledger.add');
    assert.deepStrictEqual(add.payload, {
      amount: 1250, category: 'fun', note: '看电影', date: '2026-11-16',
    });
    assert.strictEqual(page.data.formOpen, false);
    assert.strictEqual(toasts[toasts.length - 1].title, '记下啦');
    assert.strictEqual(calls.filter((call) => call.action === 'ledger.list').length, 2, '保存后要重拉当月');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 金额格式 / 范围 / 备注长度在本地就拦住，不发请求', async () => {
  const { page, calls, toasts } = setup({ 'ledger.list': () => listRes() });
  try {
    await page.load();
    page.onOpenForm();
    const cases = [
      ['abc', '先填个金额吧，最多两位小数'],
      ['0', '先填个金额吧，最多两位小数'],
      ['12.345', '先填个金额吧，最多两位小数'],
      ['10000.01', '金额太大啦，单笔最多 10000 元'],
      ['', '先填个金额吧，最多两位小数'],
    ];
    for (const [value, expected] of cases) {
      page.onAmountInput({ detail: { value } });
      await page.onSaveEntry();
      assert.strictEqual(toasts[toasts.length - 1].title, expected, '输入 ' + value);
    }
    // 备注超长
    page.onAmountInput({ detail: { value: '12' } });
    page.onNoteInput({ detail: { value: 'x'.repeat(constants.LIMITS.ledgerNote + 1) } });
    await page.onSaveEntry();
    assert.strictEqual(toasts[toasts.length - 1].title, '备注最多 30 字');
    assert.strictEqual(calls.filter((call) => call.action === 'ledger.add').length, 0);
  } finally {
    restoreWx();
  }
});

test('ledger 页: 点自己的条目回填表单并走 ledger.update', async () => {
  const { page, calls } = setup({
    'ledger.list': () => listRes({ items: ITEMS, summary: { total: 2850, count: 2 } }),
    'ledger.update': () => ({ entry: { entryId: 'le_1' } }),
  });
  try {
    await page.load();
    page.onTapEntry({ currentTarget: { dataset: { id: 'le_1' } } });
    assert.strictEqual(page.data.formOpen, true);
    assert.strictEqual(page.data.editing, true);
    assert.strictEqual(page.data.form.entryId, 'le_1');
    assert.strictEqual(page.data.form.amountText, '23.50', '分 → 元要回填两位小数');
    assert.strictEqual(page.data.form.category, 'food');
    assert.strictEqual(page.data.form.note, '牛肉面');

    page.onAmountInput({ detail: { value: '24' } });
    await page.onSaveEntry();
    const update = calls.find((call) => call.action === 'ledger.update');
    assert.deepStrictEqual(update.payload, {
      entryId: 'le_1', amount: 2400, category: 'food', note: '牛肉面', date: '2026-11-16',
    });
  } finally {
    restoreWx();
  }
});

test('ledger 页: 删除要二次确认，取消就不调接口', async () => {
  const { page, calls } = setup({
    'ledger.list': () => listRes({ items: ITEMS }),
    'ledger.remove': () => ({ removed: true }),
  });
  try {
    await page.load();
    page.onTapEntry({ currentTarget: { dataset: { id: 'le_1' } } });

    setup.modal = () => ({ confirm: false, cancel: true });
    page.onDeleteEntry();
    assert.strictEqual(calls.filter((call) => call.action === 'ledger.remove').length, 0);

    setup.modal = () => ({ confirm: true, cancel: false });
    page.onDeleteEntry();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const remove = calls.find((call) => call.action === 'ledger.remove');
    assert.deepStrictEqual(remove.payload, { entryId: 'le_1' });
    assert.strictEqual(page.data.formOpen, false);
    setup.modal = null;
  } finally {
    setup.modal = null;
    restoreWx();
  }
});

test('ledger 页: 记到别的月份会自动跳到那个月', async () => {
  const { page, calls } = setup({
    'ledger.list': (payload) => listRes({ month: payload.month || '2026-11' }),
    'ledger.add': () => ({ entry: { entryId: 'le_old' } }),
  });
  try {
    await page.load();
    page.onOpenForm();
    page.onAmountInput({ detail: { value: '8' } });
    page.onDateChange({ detail: { value: '2026-09-03' } });
    await page.onSaveEntry();
    assert.strictEqual(page.data.month, '2026-09');
    const last = calls[calls.length - 1];
    assert.deepStrictEqual(last.payload, { who: 'me', month: '2026-09' });
  } finally {
    restoreWx();
  }
});

test('ledger 页: 首屏失败给整页错误 + 重试；静默刷新失败保留列表并给底部重试', async () => {
  let fail = true;
  const { page } = setup({
    'ledger.list': () => {
      if (fail) throw Object.assign(new Error('网络不太好'), { code: 'NETWORK_ERROR' });
      return listRes({ items: ITEMS });
    },
  });
  try {
    await page.load();
    assert.strictEqual(page.data.error, '账本打不开，再试一次');
    assert.deepStrictEqual(page.data.groups, []);

    fail = false;
    await page.onRetry();
    assert.strictEqual(page.data.error, '');
    assert.strictEqual(page.data.groups.length, 2);

    fail = true;
    await page.load(true);
    assert.strictEqual(page.data.listError, LIST_ERROR_TEXT);
    assert.strictEqual(page.data.groups.length, 2, '静默刷新失败要保留已加载内容');
    assert.strictEqual(page.data.error, '');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 未绑定时只显示「我的」一本，收起 TA 的分段与记一笔', async () => {
  const { page } = setup({ 'ledger.list': () => listRes({ bound: false, partner: null }) });
  try {
    await page.load();
    assert.strictEqual(page.data.bound, false);
    assert.strictEqual(page.data.who, 'me');
    assert.strictEqual(page.data.loading, false);
    // 模板接线：分段与「记一笔」都按 bound / who 收起，不能留一个点不动的入口
    const wxml = fs.readFileSync(LEDGER_WXML, 'utf8');
    assert.match(wxml, /<view wx:if="\{\{bound\}\}" class="seg"/, '未绑定时不显示「TA 的」分段');
    assert.match(wxml, /<view wx:if="\{\{who === 'me'\}\}" class="fab">/, 'TA 的账本下不显示「记一笔」');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 看 TA 的账本撞上 NOT_BOUND 时提示并回到自己的账本，不退出页面', async () => {
  const { page, backs, errors, calls } = setup({
    'ledger.list': (payload) => {
      if (payload && payload.who === 'partner') {
        throw Object.assign(new Error('先邀请 TA 住进来吧'), { code: 'NOT_BOUND' });
      }
      return listRes({ bound: false, partner: null });
    },
  });
  try {
    await page.load();
    page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    await page.loadingPromise;
    assert.strictEqual(page.data.who, 'me', '要切回自己的账本');
    assert.strictEqual(page.data.bound, false);
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(backs(), 0, '个人账本未绑定可用，不该退出页面');
    assert.strictEqual(errors.length, 1, '要点出为什么看不到 TA 的账本');
    assert.deepStrictEqual(
      calls.map((call) => (call.payload && call.payload.who) || 'me'),
      ['me', 'partner', 'me'],
      '切人失败后要补一次自己的账本请求'
    );
  } finally {
    restoreWx();
  }
});

test('ledger 页: 下拉刷新只发一次请求并收起转圈', async () => {
  const { page, calls, stopped } = setup({ 'ledger.list': () => listRes() });
  try {
    await page.load();
    const before = calls.length;
    const run = page.onPullDownRefresh();
    const run2 = page.onPullDownRefresh();
    await Promise.all([run, run2]);
    assert.strictEqual(calls.length - before, 1);
    assert.deepStrictEqual(stopped, [1, 1], '两次手势各收一次转圈');
  } finally {
    restoreWx();
  }
});

test('ledger 页: 切人后旧请求的响应作废，不会把两本账拼在一起', async () => {
  let release = null;
  const { page } = setup({
    'ledger.list': (payload) => {
      if (payload.who === 'me') {
        return new Promise((resolve) => {
          release = () => resolve(listRes({ items: ITEMS, summary: { total: 2850, count: 2 } }));
        });
      }
      return listRes({
        who: 'partner',
        items: [Object.assign({}, ITEMS[0], { entryId: 'le_p' })],
        summary: { total: 2350, count: 1 },
      });
    },
  });
  try {
    const slow = page.load();
    await page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    release();
    await slow;
    assert.strictEqual(page.data.who, 'partner');
    assert.deepStrictEqual(page.data.groups[0].items.map((item) => item.entryId), ['le_p']);
  } finally {
    restoreWx();
  }
});

test('ledger 页: 卸载后不再 setData', async () => {
  let release = null;
  const { page } = setup({
    'ledger.list': () => new Promise((resolve) => {
      release = () => resolve(listRes({ items: ITEMS }));
    }),
  });
  try {
    const run = page.load();
    page.onUnload();
    release();
    await run;
    assert.deepStrictEqual(page.data.groups, []);
    assert.strictEqual(page.data.loading, true);
  } finally {
    restoreWx();
  }
});

test('ledger 页: 模板与注册静态自检（页面、组件、下拉刷新、入口）', () => {
  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  assert.ok(app.pages.indexOf('pages/ledger/index') >= 0, '新页面必须在 app.json 注册');
  assert.strictEqual(constants.ROUTES.ledger, '/pages/ledger/index');
  assert.strictEqual(constants.isTabRoute(constants.ROUTES.ledger), false, '记账本是普通页，只能 navigateTo');

  const json = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/ledger/index.json'), 'utf8'));
  assert.strictEqual(json.enablePullDownRefresh, true);
  assert.ok(json.usingComponents['empty-state']);
  assert.ok(json.usingComponents['bottom-sheet']);

  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/ledger/index.wxml'), 'utf8');
  assert.ok(wxml.includes('bindtap="onSwitchWho"'), '要有我的 / TA 的切换');
  assert.ok(wxml.includes('bindtap="onOpenForm"'), '要有记一笔入口');
  assert.ok(wxml.includes('bindchange="onDateChange"'), '日期选择要接住');
  assert.ok(wxml.includes('aria-label'), '可点区域要有无障碍标签');

  const profileWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.ok(profileWxml.includes('onOpenLedger'), '「我的」要有记账本入口');
  assert.ok(!profileWxml.includes('见面基金'), '见面基金占位已经下线');
});

test('金额与月份的纯函数：元↔分、跨年月份、展示格式', () => {
  assert.strictEqual(format.formatYuan(0), '¥0.00');
  assert.strictEqual(format.formatYuan(5), '¥0.05');
  assert.strictEqual(format.formatYuan(2350), '¥23.50');
  assert.strictEqual(format.formatYuan(1000000), '¥10000.00');
  assert.strictEqual(format.formatYuan(-120), '-¥1.20');
  assert.strictEqual(format.formatYuan('x'), '¥0.00');

  assert.strictEqual(format.parseYuan('12'), 1200);
  assert.strictEqual(format.parseYuan('12.5'), 1250);
  assert.strictEqual(format.parseYuan('12.50'), 1250);
  assert.strictEqual(format.parseYuan(' 12.05 '), 1205);
  assert.strictEqual(format.parseYuan('0.01'), 1);
  for (const bad of ['', 'abc', '-1', '1.234', '1.', '.5', '1e3', null]) {
    assert.strictEqual(format.parseYuan(bad), null, '输入 ' + bad + ' 应判非法');
  }

  assert.strictEqual(timeUtil.monthOf('2026-11-16'), '2026-11');
  assert.strictEqual(timeUtil.monthOf('2026-1-6'), '');
  assert.strictEqual(timeUtil.shiftMonthKey('2026-01', -1), '2025-12');
  assert.strictEqual(timeUtil.shiftMonthKey('2026-12', 1), '2027-01');
  assert.strictEqual(timeUtil.shiftMonthKey('2026-13', 1), '');
  assert.strictEqual(timeUtil.formatMonthCN('2026-01'), '2026年1月');
});
