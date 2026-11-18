'use strict';

const test = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');

const GROWTH = 'miniprogram/pages/growth/index.js';

/**
 * 一起变好页（文档 8.3.10 / 7.18）：
 * - 动作矩阵由页面按 createdByMe + status 算（组件只负责发事件）；
 * - 订阅授权只在动作完成且额度 < 2 时问一次，拒绝后本次会话不再问。
 */
function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const modals = [];
  const subscribe = [];
  const navBacks = [];
  h.installWx(
    Object.assign(
      {
        showToast: (opts) => toasts.push(opts),
        showModal: (opts) => {
          modals.push(opts);
          const answer = setup.modalAnswer;
          if (answer) opts.success && opts.success(answer);
        },
        navigateBack: (opts) => navBacks.push(opts),
        requestSubscribeMessage: (opts) => {
          subscribe.push(opts.tmplIds);
          const result = setup.subscribeResult;
          if (result === 'fail') return opts.fail && opts.fail({ errMsg: 'requestSubscribeMessage:fail' });
          const res = {};
          (opts.tmplIds || []).forEach((id) => { res[id] = result || 'accept'; });
          opts.success && opts.success(res);
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
  const page = h.instantiate(h.loadPage(GROWTH));
  return { page, toasts, errors, calls, modals, subscribe, navBacks };
}

function task(extra) {
  return Object.assign({
    taskId: 'g_1',
    title: '一起背完六级词汇',
    category: 'learn',
    myPart: '每天中午 30 个',
    partnerPart: '每天晚上互相抽 20 个',
    note: '',
    status: 'confirming',
    archivedType: null,
    createdByMe: true,
    createdAt: '2026-11-18T01:00:00.000Z',
    confirmedAt: null,
    doneAt: null,
    archivedAt: null,
    myHarvestWritten: false,
    partnerHarvestWritten: false,
  }, extra || {});
}

function listRes(items, extra) {
  return Object.assign({
    items: items || [],
    stats: { inFlight: (items || []).length, awaitingConfirm: 0, archivedCount: 0 },
    subConfigured: false,
    subQuota: 0,
    subQuotaMax: 7,
    subTemplateId: '',
  }, extra || {});
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 加载与动作矩阵 ─────────────────────────────────────────────────────────

test('growth: 首屏把状态翻译成动作矩阵（自己起草的待认领：可改可删、不能自己认领）', async () => {
  const { page } = setup({
    'growth.list': () => listRes([task()], {
      stats: { inFlight: 1, awaitingConfirm: 1, archivedCount: 3 },
      subConfigured: true,
      subQuota: 4,
      subTemplateId: 'tpl_growth',
    }),
  });
  try {
    await page.load();
    const item = page.data.items[0];
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(item.emoji, '📖');
    assert.strictEqual(item.categoryLabel, '学一件东西');
    assert.strictEqual(item.statusText, '等 TA 认领');
    assert.strictEqual(item.canConfirm, false, '自己起草的不能自己认领');
    assert.strictEqual(item.canEdit, true);
    assert.strictEqual(item.canRemove, true);
    assert.strictEqual(item.canDone, false);
    assert.strictEqual(page.data.stats.archivedCount, 3);
    assert.strictEqual(page.data.subConfigured, true);
    assert.strictEqual(page.data.subQuota, 4);
    assert.strictEqual(page.data.subTemplateId, 'tpl_growth');
  } finally {
    h.restoreWx();
  }
});

test('growth: 对方看到待认领时可以认领，进行中可以完成，写收获阶段有提示', async () => {
  const { page } = setup({
    'growth.list': () => listRes([
      task({ taskId: 'g_c', createdByMe: false }),
      task({ taskId: 'g_a', status: 'active', createdByMe: true, confirmedAt: '2026-11-18T02:00:00.000Z' }),
      task({ taskId: 'g_h', status: 'harvesting', createdByMe: false, myHarvestWritten: true, partnerHarvestWritten: false }),
    ]),
  });
  try {
    await page.load();
    const [confirming, active, harvesting] = page.data.items;
    assert.strictEqual(confirming.canConfirm, true);
    assert.strictEqual(confirming.statusText, '等你认领');
    assert.strictEqual(active.canDone, true);
    assert.strictEqual(active.statusText, '进行中');
    assert.strictEqual(harvesting.canHarvest, true);
    assert.strictEqual(harvesting.harvestHint, '等 TA 写完就归档', '自己写完了就等对方');
  } finally {
    h.restoreWx();
  }
});

test('growth: 在档上限时不再让起草；空标题不发请求', async () => {
  const { page, toasts, calls } = setup({
    'growth.list': () => listRes([], { stats: { inFlight: 10, awaitingConfirm: 0, archivedCount: 0 } }),
  });
  try {
    await page.load();
    page.onAdd();
    assert.strictEqual(page.data.formOpen, false, '满 10 件不该打开表单');
    assert.ok(toasts.some((t) => t.title.indexOf('先把眼前的几件事做完') !== -1));

    page.setData({ formOpen: true, form: Object.assign({}, page.data.form, { title: '   ' }) });
    await page.onSubmit();
    assert.strictEqual(calls.filter((c) => c.action === 'growth.add').length, 0, '标题为空不发请求');
    assert.ok(toasts.some((t) => t.title === '给这件事起个名字'));
  } finally {
    h.restoreWx();
  }
});

test('growth: 起草把首尾空格去掉后提交，成功后关弹层并刷新', async () => {
  const { page, calls, toasts } = setup({
    'growth.list': () => listRes([]),
    'growth.add': () => ({ task: task() }),
  });
  try {
    await page.load();
    page.onAdd();
    page.setData({ 'form.title': ' 一起跑步 ', 'form.category': 'sport', 'form.myPart': ' 早上 ', 'form.partnerPart': '', 'form.note': '' });
    await page.onSubmit();

    const add = calls.find((c) => c.action === 'growth.add');
    assert.deepStrictEqual(add.payload, {
      title: '一起跑步', category: 'sport', myPart: '早上', partnerPart: '', note: '',
    });
    assert.strictEqual(page.data.formOpen, false);
    assert.ok(toasts.some((t) => t.title.indexOf('起草好了') !== -1));
    assert.strictEqual(calls.filter((c) => c.action === 'growth.list').length, 2, '写完要刷新列表');
  } finally {
    h.restoreWx();
  }
});

test('growth: 编辑回填自己的视角，提交带 taskId 走 update', async () => {
  const { page, calls } = setup({
    'growth.list': () => listRes([task({ taskId: 'g_9', status: 'active' })]),
    'growth.update': () => ({ task: task({ taskId: 'g_9' }) }),
  });
  try {
    await page.load();
    page.onEdit({ detail: { task: page.data.items[0] } });
    assert.strictEqual(page.data.editing, true);
    assert.strictEqual(page.data.form.title, '一起背完六级词汇');
    assert.strictEqual(page.data.form.myPart, '每天中午 30 个');

    page.setData({ 'form.title': '一起背完专八词汇' });
    await page.onSubmit();
    const update = calls.find((c) => c.action === 'growth.update');
    assert.strictEqual(update.payload.taskId, 'g_9');
    assert.strictEqual(update.payload.title, '一起背完专八词汇');
  } finally {
    h.restoreWx();
  }
});

// ── 认领 / 完成 / 收获 / 复盘 / 删除 ───────────────────────────────────────

test('growth: 认领成功后刷新，并在额度不足时问一次订阅授权', async () => {
  const { page, calls, subscribe } = setup({
    'growth.list': () => listRes([task({ createdByMe: false })], {
      subConfigured: true, subQuota: 0, subTemplateId: 'tpl_growth',
    }),
    'growth.confirm': () => ({ task: task({ status: 'active' }) }),
    'reminder.grant': () => ({ taskQuota: 1 }),
  });
  try {
    await page.load();
    await page.onConfirm({ detail: { task: page.data.items[0] } });
    assert.deepStrictEqual(calls.find((c) => c.action === 'growth.confirm').payload, { taskId: 'g_1' });
    await wait(10);
    assert.deepStrictEqual(subscribe[0], ['tpl_growth']);
    assert.deepStrictEqual(calls.find((c) => c.action === 'reminder.grant').payload, { template: 'task' });
    assert.strictEqual(page.data.subQuota, 1);
  } finally {
    h.restoreWx();
  }
});

test('growth: 额度够 / 模板没配 / 本次会话已问过，都不再弹授权', async () => {
  // 1) 额度 ≥ 2
  let box = setup({
    'growth.list': () => listRes([task({ createdByMe: false })], {
      subConfigured: true, subQuota: 2, subTemplateId: 'tpl_growth',
    }),
    'growth.confirm': () => ({ task: task({ status: 'active' }) }),
  });
  try {
    await box.page.load();
    await box.page.onConfirm({ detail: { task: box.page.data.items[0] } });
    await wait(10);
    assert.strictEqual(box.subscribe.length, 0, '额度还够就别打扰');
  } finally {
    h.restoreWx();
  }

  // 2) 模板没配
  box = setup({
    'growth.list': () => listRes([task({ createdByMe: false })], { subConfigured: false, subQuota: 0 }),
    'growth.confirm': () => ({ task: task({ status: 'active' }) }),
  });
  try {
    await box.page.load();
    await box.page.onConfirm({ detail: { task: box.page.data.items[0] } });
    await wait(10);
    assert.strictEqual(box.subscribe.length, 0);
  } finally {
    h.restoreWx();
  }

  // 3) 同一次会话问过就不再问（第二个动作）
  box = setup({
    'growth.list': () => listRes([task({ createdByMe: false }), task({ taskId: 'g_2', createdByMe: false })], {
      subConfigured: true, subQuota: 0, subTemplateId: 'tpl_growth',
    }),
    'growth.confirm': () => ({ task: task({ status: 'active' }) }),
    'reminder.grant': () => ({ taskQuota: 1 }),
  });
  try {
    await box.page.load();
    await box.page.onConfirm({ detail: { task: box.page.data.items[0] } });
    await box.page.onConfirm({ detail: { task: box.page.data.items[1] } });
    await wait(10);
    assert.strictEqual(box.subscribe.length, 1, '一次会话只问一次');
  } finally {
    h.restoreWx();
  }
});

test('growth: 用户拒绝订阅授权时不上报 grant', async () => {
  setup.subscribeResult = 'reject';
  const { page, calls, subscribe } = setup({
    'growth.list': () => listRes([task({ createdByMe: false })], {
      subConfigured: true, subQuota: 0, subTemplateId: 'tpl_growth',
    }),
    'growth.confirm': () => ({ task: task({ status: 'active' }) }),
  });
  try {
    await page.load();
    await page.onConfirm({ detail: { task: page.data.items[0] } });
    await wait(10);
    assert.strictEqual(subscribe.length, 1);
    assert.strictEqual(calls.filter((c) => c.action === 'reminder.grant').length, 0, '没同意就不攒额度');
  } finally {
    setup.subscribeResult = undefined;
    h.restoreWx();
  }
});

test('growth: 标记完成后刷新列表（写收获阶段）', async () => {
  const { page, calls, toasts } = setup({
    'growth.list': () => listRes([task({ status: 'active' })]),
    'growth.done': () => ({ task: task({ status: 'harvesting' }) }),
  });
  try {
    await page.load();
    await page.onDone({ detail: { task: page.data.items[0] } });
    assert.deepStrictEqual(calls.find((c) => c.action === 'growth.done').payload, { taskId: 'g_1' });
    assert.ok(toasts.some((t) => t.title.indexOf('各写一句收获') !== -1));
  } finally {
    h.restoreWx();
  }
});

test('growth: 写收获空文本不提交；提交成功后关弹层并刷新日志', async () => {
  const { page, calls, toasts } = setup({
    'growth.list': () => listRes([task({ status: 'harvesting' })]),
    'growth.harvest': () => ({ task: task({ status: 'archived' }), archived: true }),
    'growth.log': () => ({ items: [], nextCursor: null }),
  });
  try {
    await page.load();
    page.onHarvest({ detail: { task: page.data.items[0] } });
    assert.strictEqual(page.data.textOpen, true);
    assert.strictEqual(page.data.textMode, 'harvest');

    await page.onSubmitText();
    assert.strictEqual(calls.filter((c) => c.action === 'growth.harvest').length, 0);
    assert.ok(toasts.some((t) => t.title === '写一句你们做到了什么'));

    page.setData({ text: ' 背完了 ' });
    await page.onSubmitText();
    assert.deepStrictEqual(calls.find((c) => c.action === 'growth.harvest').payload,
      { taskId: 'g_1', text: '背完了' });
    assert.strictEqual(page.data.textOpen, false);
    assert.ok(toasts.some((t) => t.title === '收进成长日志了'));
  } finally {
    h.restoreWx();
  }
});

test('growth: 复盘走 growth.review，文案与收获区分开', async () => {
  const { page, calls, toasts } = setup({
    'growth.list': () => listRes([task({ status: 'active' })]),
    'growth.review': () => ({ task: task({ status: 'archived', archivedType: 'reviewed' }), archived: true }),
  });
  try {
    await page.load();
    page.onReview({ detail: { task: page.data.items[0] } });
    assert.strictEqual(page.data.textMode, 'review');

    await page.onSubmitText();
    assert.ok(toasts.some((t) => t.title === '写一句你想说的'));

    page.setData({ text: '这次没做完，但我们说开了' });
    await page.onSubmitText();
    assert.deepStrictEqual(calls.find((c) => c.action === 'growth.review').payload,
      { taskId: 'g_1', text: '这次没做完，但我们说开了' });
  } finally {
    h.restoreWx();
  }
});

test('growth: 删除要先二次确认，取消就不发请求', async () => {
  setup.modalAnswer = { confirm: false, cancel: true };
  const { page, calls, modals } = setup({
    'growth.list': () => listRes([task()]),
  });
  try {
    await page.load();
    page.onRemove({ detail: { task: page.data.items[0] } });
    assert.strictEqual(modals.length, 1);
    assert.strictEqual(calls.filter((c) => c.action === 'growth.remove').length, 0);

    setup.modalAnswer = { confirm: true };
    page.onRemove({ detail: { task: page.data.items[0] } });
    await wait(10);
    assert.deepStrictEqual(calls.find((c) => c.action === 'growth.remove').payload, { taskId: 'g_1' });
  } finally {
    setup.modalAnswer = undefined;
    h.restoreWx();
  }
});

// ── 错误与边界 ─────────────────────────────────────────────────────────────

test('growth: 静默刷新失败保留列表，只给一行重试条', async () => {
  let fail = false;
  const { page, errors } = setup({
    'growth.list': () => {
      if (fail) throw new Error('down');
      return listRes([task()]);
    },
  });
  try {
    await page.load();
    fail = true;
    await page.load(true, true);
    assert.strictEqual(page.data.items.length, 1, '旧列表要留着');
    assert.strictEqual(page.data.listError, '没刷新成功，点这里重试');
    assert.strictEqual(errors.length, 1);
  } finally {
    h.restoreWx();
  }
});

test('growth: 解绑后进入页面按 NOT_BOUND 提示并返回', async () => {
  const { page, errors, navBacks } = setup({
    'growth.list': () => { const err = new Error('先邀请 TA 住进来吧'); err.code = 'NOT_BOUND'; throw err; },
  });
  try {
    await page.load();
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(navBacks.length, 1);
    assert.strictEqual(page.data.loading, false);
  } finally {
    h.restoreWx();
  }
});

// ── 成长日志 ───────────────────────────────────────────────────────────────

test('growth: 切到成长日志才拉数据，按月分组并按解锁规则给提示', async () => {
  const { page, calls } = setup({
    'growth.list': () => listRes([]),
    'growth.log': () => ({
      items: [
        {
          taskId: 'g_a', title: '一起背单词', category: 'learn', archivedType: 'done',
          myPart: '', partnerPart: '', archivedAt: '2026-11-02T10:00:00.000Z',
          myText: '背完了', partnerText: '抽单词抽到吵架', partnerWritten: true, partnerHarvestUnlocked: true,
        },
        {
          taskId: 'g_b', title: '一起跑步', category: 'sport', archivedType: 'reviewed',
          myPart: '', partnerPart: '', archivedAt: '2026-10-20T10:00:00.000Z',
          myText: null, partnerText: null, partnerWritten: true, partnerHarvestUnlocked: false,
        },
      ],
      nextCursor: null,
    }),
  });
  try {
    await page.load();
    assert.strictEqual(calls.filter((c) => c.action === 'growth.log').length, 0, '没切过去不该拉日志');

    page.onSwitchSeg({ currentTarget: { dataset: { seg: 'log' } } });
    await wait(10);
    assert.strictEqual(calls.filter((c) => c.action === 'growth.log').length, 1);

    const groups = page.data.logGroups;
    assert.strictEqual(groups.length, 2, '11 月和 10 月各一组');
    const first = groups[0].items[0];
    assert.strictEqual(first.chipText, '一起完成');
    assert.strictEqual(first.myText, '背完了');
    assert.strictEqual(first.partnerText, '抽单词抽到吵架');
    const locked = groups[1].items[0];
    assert.strictEqual(locked.chipText, '复盘收尾');
    assert.strictEqual(locked.partnerText, '', '没写就不能看到对方那段');
    assert.strictEqual(locked.partnerHint, 'TA 写了，你写完就能看');
    assert.strictEqual(page.data.hasMore, false);
  } finally {
    h.restoreWx();
  }
});

test('growth: 成长日志翻页用游标累加，不重置已有条目', async () => {
  let page1 = true;
  const { page, calls } = setup({
    'growth.list': () => listRes([]),
    'growth.log': (payload) => {
      if (!payload || !payload.cursor) {
        page1 = false;
        return {
          items: [{
            taskId: 'g_1', title: '第一页', category: 'other', archivedType: 'done',
            archivedAt: '2026-11-10T10:00:00.000Z', myText: 'a', partnerText: 'b', partnerWritten: true,
          }],
          nextCursor: '2026-11-10T10:00:00.000Z|g_1',
        };
      }
      return {
        items: [{
          taskId: 'g_2', title: '第二页', category: 'other', archivedType: 'done',
          archivedAt: '2026-11-01T10:00:00.000Z', myText: 'c', partnerText: null, partnerWritten: false,
        }],
        nextCursor: null,
      };
    },
  });
  try {
    await page.load();
    page.onSwitchSeg({ currentTarget: { dataset: { seg: 'log' } } });
    await wait(10);
    assert.strictEqual(page.data.hasMore, true);

    page.onLoadMore();
    await wait(10);
    const all = page.data.logGroups.reduce((acc, group) => acc.concat(group.items), []);
    assert.deepStrictEqual(all.map((entry) => entry.taskId), ['g_1', 'g_2'], '两页要累加，不能覆盖');
    assert.strictEqual(page.data.hasMore, false);
    assert.strictEqual(page1, false);
    const second = calls.filter((c) => c.action === 'growth.log')[1];
    assert.strictEqual(second.payload.cursor, '2026-11-10T10:00:00.000Z|g_1');
  } finally {
    h.restoreWx();
  }
});

// ── 组件 ───────────────────────────────────────────────────────────────────

test('growth-item: 事件载荷是整条任务，禁用时一个事件都不发', () => {
  h.installWx({});
  try {
    const config = h.loadComponent('miniprogram/components/growth-item/index.js');
    const item = task();
    const comp = h.instantiateComponent(config, { task: item });
    comp.onConfirm();
    comp.onDone();
    comp.onRemove();
    assert.deepStrictEqual(comp.events.map((e) => e.name), ['confirm', 'done', 'remove']);
    assert.strictEqual(comp.events[0].detail.task.taskId, 'g_1');

    comp.setProps({ disabled: true });
    comp.onConfirm();
    assert.strictEqual(comp.events.length, 3, '禁用后不再发事件');
  } finally {
    h.restoreWx();
  }
});

test('growth 页面与组件接线：分段、任务池动作、日志分段都在模板里绑好', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  const pageWxml = read('miniprogram/pages/growth/index.wxml');
  assert.ok(pageWxml.includes('data-seg="pool"') && pageWxml.includes('data-seg="log"'), '两分段');
  assert.ok(pageWxml.includes('bind:confirm="onConfirm"'));
  assert.ok(pageWxml.includes('bind:done="onDone"'));
  assert.ok(pageWxml.includes('bind:harvest="onHarvest"'));
  assert.ok(pageWxml.includes('bind:review="onReview"'));
  assert.ok(pageWxml.includes('bind:edit="onEdit"'));
  assert.ok(pageWxml.includes('bind:remove="onRemove"'));
  assert.ok(pageWxml.includes('growth-log-item'));
  assert.ok(pageWxml.includes('bind:action="onAdd"'), '空态要能起草第一件');

  const itemWxml = read('miniprogram/components/growth-item/index.wxml');
  ['onConfirm', 'onDone', 'onHarvest', 'onReview', 'onEdit', 'onRemove'].forEach((handler) => {
    assert.ok(itemWxml.includes('catchtap="' + handler + '"'), '缺 ' + handler + ' 接线');
  });
  assert.ok(itemWxml.includes('我的') && itemWxml.includes('TA 的'), '分工两行始终展示');
});
