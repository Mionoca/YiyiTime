'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const A = 'oA';
const B = 'oB';
const COUPLE = 'c_1';
const OTHER_COUPLE = 'c_2';
const NOW = new Date('2026-11-18T09:00:00.000Z');

const time = require('../cloudfunctions/api/lib/time');
const growth = require('../cloudfunctions/api/handlers/growth');
/** handler 走 ctx.now 真实时钟，涉及「今天」的断言必须按运行时算（同 reminder.test.js） */
const LIVE_TODAY = time.dateKeyOf(new Date());

function userDoc(id, extra) {
  return Object.assign({
    _id: id, openid: id, nickname: id === A ? '小怡' : '小安', avatarFileID: '',
    coupleId: COUPLE, profileComplete: true, bindFailCount: 0,
    lastActiveAt: NOW, createdAt: NOW, updatedAt: NOW,
  }, extra || {});
}

function coupleDoc(id, members) {
  return {
    _id: id || COUPLE, memberOpenids: members || [A, B], startDate: '2024-05-20',
    startDateUpdatedBy: A, status: 'active',
    unbindStatus: 'none', createdAt: NOW, updatedAt: NOW,
  };
}

function taskDoc(extra) {
  return Object.assign({
    _id: 'g_test0000000001',
    coupleId: COUPLE,
    createdBy: A,
    title: '一起背完六级词汇',
    category: 'learn',
    creatorPart: '每天中午 30 个',
    partnerPart: '每天晚上互相抽 20 个',
    note: '',
    status: 'confirming',
    archivedType: null,
    creatorHarvest: null,
    partnerHarvest: null,
    creatorReview: null,
    partnerReview: null,
    createdAt: NOW,
    confirmedAt: null,
    doneAt: null,
    archivedAt: null,
    updatedAt: NOW,
  }, extra || {});
}

function setup(extra, openid) {
  const h = createHarness();
  h.reset(Object.assign({
    users: [userDoc(A), userDoc(B)],
    couples: [coupleDoc()],
  }, extra || {}), openid);
  return h;
}

function withGrowthTemplate(t) {
  process.env.YIYI_GROWTH_TEMPLATE_ID = 'tpl_growth';
  t.after(() => { delete process.env.YIYI_GROWTH_TEMPLATE_ID; });
}

function sentCalls(h) {
  return h.openapiCalls().filter((c) => c.api === 'subscribeMessage.send');
}

function taskOf(h, id) {
  return h.fake().get('growth_tasks', id || 'g_test0000000001');
}

// ── add ────────────────────────────────────────────────────────────────────

test('growth.add：默认进入 confirming，落库以起草者为锚点（creatorPart / partnerPart）', async (t) => {
  withGrowthTemplate(t);
  const h = setup();
  const res = await h.callAs(A, 'growth.add', {
    title: '一起背完六级词汇',
    category: 'learn',
    myPart: '每天中午 30 个',
    partnerPart: '每天晚上互相抽 20 个',
  });

  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const task = res.data.task;
  assert.strictEqual(task.status, 'confirming');
  assert.strictEqual(task.createdByMe, true);
  assert.strictEqual(task.myPart, '每天中午 30 个');
  assert.strictEqual(task.partnerPart, '每天晚上互相抽 20 个');
  assert.strictEqual(task.archivedType, null);

  const row = h.fake().all('growth_tasks')[0];
  assert.strictEqual(row.createdBy, A);
  assert.strictEqual(row.creatorPart, '每天中午 30 个');
  assert.strictEqual(row.partnerPart, '每天晚上互相抽 20 个');
  assert.strictEqual(row.coupleId, COUPLE);
});

test('growth.add：标题为空 / 超长 / 分类非法各报文档约定的错误码', async (t) => {
  withGrowthTemplate(t);
  const h = setup();

  const empty = await h.callAs(A, 'growth.add', { title: '   ', category: 'learn' });
  assert.strictEqual(empty.code, 'GROWTH_TITLE_REQUIRED');
  assert.strictEqual(empty.message, '给这件事起个名字');

  const tooLong = await h.callAs(A, 'growth.add', { title: '字'.repeat(31), category: 'learn' });
  assert.strictEqual(tooLong.code, 'TEXT_TOO_LONG');

  const badCategory = await h.callAs(A, 'growth.add', { title: '一起跑步', category: 'sleep' });
  assert.strictEqual(badCategory.code, 'INVALID_INPUT');

  assert.strictEqual(h.fake().all('growth_tasks').length, 0, '校验失败不能落库');
});

test('growth.add：在档 10 件后拒绝，归档不计入名额', async (t) => {
  withGrowthTemplate(t);
  const many = [];
  for (let i = 0; i < 10; i += 1) {
    many.push(taskDoc({ _id: 'g_fill' + i, status: i % 3 === 0 ? 'confirming' : 'active', createdAt: new Date(NOW.getTime() + i) }));
  }
  const h = setup({ growth_tasks: many });

  const blocked = await h.callAs(A, 'growth.add', { title: '第 11 件', category: 'other' });
  assert.strictEqual(blocked.code, 'GROWTH_LIMIT_REACHED');
  assert.strictEqual(blocked.message, '先把眼前的几件事做完吧');

  // 归档任务不占名额
  h.fake().get('growth_tasks', 'g_fill0').status = 'archived';
  h.fake().get('growth_tasks', 'g_fill0').archivedType = 'done';
  const ok = await h.callAs(A, 'growth.add', { title: '第 11 件', category: 'other' });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
});

test('growth.add：标题与分工都过内容安全，拦截时写库前就停住', async (t) => {
  withGrowthTemplate(t);
  const h = setup();
  h.setOpenapi({ security: { msgSecCheck: async () => ({ errCode: 0, result: { suggest: 'risky' } }) } });

  const res = await h.callAs(A, 'growth.add', {
    title: '一句话', category: 'other', myPart: '很长的分工',
  });
  assert.strictEqual(res.code, 'CONTENT_RISKY');
  assert.strictEqual(h.fake().all('growth_tasks').length, 0, '拦截必须在写库前');
});

// ── 视角映射 ────────────────────────────────────────────────────────────────

test('视角映射：同一条任务，创建者与对方各自看到的 my/partner 不串位', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc({ status: 'active', confirmedAt: NOW })] }, A);

  const mine = await h.callAs(A, 'growth.list');
  assert.strictEqual(mine.data.items[0].createdByMe, true);
  assert.strictEqual(mine.data.items[0].myPart, '每天中午 30 个');

  const theirs = await h.callAs(B, 'growth.list');
  assert.strictEqual(theirs.data.items[0].createdByMe, false);
  assert.strictEqual(theirs.data.items[0].myPart, '每天晚上互相抽 20 个', '对方看到的「我的」是 partnerPart');
  assert.strictEqual(theirs.data.items[0].partnerPart, '每天中午 30 个');
});

test('growth.update：入参按调用者视角换算，B 改 myPart 落到 partnerPart', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc({ status: 'active', confirmedAt: NOW })] });

  const byCreator = await h.callAs(A, 'growth.update', { taskId: 'g_test0000000001', myPart: '我改了自己的部分' });
  assert.strictEqual(byCreator.ok, true, JSON.stringify(byCreator));
  assert.strictEqual(taskOf(h).creatorPart, '我改了自己的部分');

  const byPartner = await h.callAs(B, 'growth.update', { taskId: 'g_test0000000001', myPart: '我改了自己的部分' });
  assert.strictEqual(byPartner.ok, true, JSON.stringify(byPartner));
  assert.strictEqual(taskOf(h).partnerPart, '我改了自己的部分', 'B 的 myPart 是创建者的 partnerPart');
  assert.strictEqual(taskOf(h).creatorPart, '我改了自己的部分', '不能顺手把创建者那段也改了');
});

test('growth.update：全空入参报 INVALID_INPUT；归档后不能再改', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc({ status: 'confirming' })] });

  const empty = await h.callAs(A, 'growth.update', { taskId: 'g_test0000000001' });
  assert.strictEqual(empty.code, 'INVALID_INPUT');

  taskOf(h).status = 'archived';
  taskOf(h).archivedType = 'done';
  const archived = await h.callAs(A, 'growth.update', { taskId: 'g_test0000000001', title: '改不了' });
  assert.strictEqual(archived.code, 'GROWTH_STATE_INVALID');
});

// ── confirm / done ──────────────────────────────────────────────────────────

test('growth.confirm：只有对方能认领，创建者自己认领被拒，重复认领被拒', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc()] });

  const self = await h.callAs(A, 'growth.confirm', { taskId: 'g_test0000000001' });
  assert.strictEqual(self.code, 'GROWTH_STATE_INVALID');
  assert.strictEqual(self.message, '这件事是你起草的，等 TA 认领');

  const ok = await h.callAs(B, 'growth.confirm', { taskId: 'g_test0000000001' });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.data.task.status, 'active');
  assert.ok(ok.data.task.confirmedAt, '要写 confirmedAt');
  assert.ok(taskOf(h).confirmedAt);

  const again = await h.callAs(B, 'growth.confirm', { taskId: 'g_test0000000001' });
  assert.strictEqual(again.code, 'GROWTH_STATE_INVALID');
});

test('growth.done：confirming 不能直接完成；active → harvesting；重复点幂等', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc()] });

  const early = await h.callAs(A, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(early.code, 'GROWTH_STATE_INVALID');
  assert.strictEqual(early.message, '这件事还没一起认领');

  taskOf(h).status = 'active';
  const done = await h.callAs(A, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(done.data.task.status, 'harvesting');
  assert.ok(taskOf(h).doneAt);

  const again = await h.callAs(B, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(again.ok, true, '重复点要幂等返回而不是报错');
  assert.strictEqual(again.data.task.status, 'harvesting');
});

// ── 收获 / 复盘 ─────────────────────────────────────────────────────────────

test('growth.harvest：active 时不能写；第一段不归档，双方都写完自动 archived(done)', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc({ status: 'active', confirmedAt: NOW })] });

  const tooEarly = await h.callAs(A, 'growth.harvest', { taskId: 'g_test0000000001', text: '写早了' });
  assert.strictEqual(tooEarly.code, 'GROWTH_STATE_INVALID');

  taskOf(h).status = 'harvesting';
  const first = await h.callAs(A, 'growth.harvest', { taskId: 'g_test0000000001', text: '背完了，最后三天在赶' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assert.strictEqual(first.data.archived, false);
  assert.strictEqual(taskOf(h).status, 'harvesting');
  assert.strictEqual(taskOf(h).creatorHarvest, '背完了，最后三天在赶');

  const second = await h.callAs(B, 'growth.harvest', { taskId: 'g_test0000000001', text: '抽单词抽到吵架又和好' });
  assert.strictEqual(second.data.archived, true, '双方都写了要自动归档');
  assert.strictEqual(taskOf(h).status, 'archived');
  assert.strictEqual(taskOf(h).archivedType, 'done');
  assert.ok(taskOf(h).archivedAt);
});

test('growth.harvest：空文本报 GROWTH_HARVEST_EMPTY；复盘收尾的任务不能再补收获', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc({ status: 'harvesting', doneAt: NOW })] });

  const empty = await h.callAs(A, 'growth.harvest', { taskId: 'g_test0000000001', text: '  ' });
  assert.strictEqual(empty.code, 'GROWTH_HARVEST_EMPTY');
  assert.strictEqual(empty.message, '写一句你们做到了什么');

  taskOf(h).status = 'archived';
  taskOf(h).archivedType = 'reviewed';
  const blocked = await h.callAs(A, 'growth.harvest', { taskId: 'g_test0000000001', text: '补一段' });
  assert.strictEqual(blocked.code, 'GROWTH_STATE_INVALID');
});

test('growth.review：任意阶段都能复盘收尾；done 收尾的不能再复盘', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc({ status: 'active', confirmedAt: NOW })] });

  const res = await h.callAs(A, 'growth.review', { taskId: 'g_test0000000001', text: '这次没做完，但我们说开了' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.data.archived, true);
  assert.strictEqual(taskOf(h).status, 'archived');
  assert.strictEqual(taskOf(h).archivedType, 'reviewed');
  assert.strictEqual(taskOf(h).creatorReview, '这次没做完，但我们说开了');
  assert.strictEqual(taskOf(h).creatorHarvest, null, '复盘不写收获段');

  // 对方补写自己那段：只改 partnerReview
  const later = await h.callAs(B, 'growth.review', { taskId: 'g_test0000000001', text: '我也觉得' });
  assert.strictEqual(later.ok, true, JSON.stringify(later));
  assert.strictEqual(taskOf(h).partnerReview, '我也觉得');
  assert.strictEqual(taskOf(h).creatorReview, '这次没做完，但我们说开了');

  taskOf(h).status = 'archived';
  taskOf(h).archivedType = 'done';
  const wrong = await h.callAs(A, 'growth.review', { taskId: 'g_test0000000001', text: '再复盘' });
  assert.strictEqual(wrong.code, 'GROWTH_STATE_INVALID');
});

// ── remove ─────────────────────────────────────────────────────────────────

test('growth.remove：在档可删、不存在幂等、归档拒删', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ growth_tasks: [taskDoc()] });

  const missing = await h.callAs(A, 'growth.remove', { taskId: '' });
  assert.strictEqual(missing.data.removed, false, '空 id 按不存在处理');
  const notFound = await h.callAs(A, 'growth.remove', { taskId: 'g_nope' });
  assert.strictEqual(notFound.data.removed, false);

  const ok = await h.callAs(A, 'growth.remove', { taskId: 'g_test0000000001' });
  assert.strictEqual(ok.data.removed, true);
  assert.strictEqual(h.fake().all('growth_tasks').length, 0);

  h.reset({ users: [userDoc(A), userDoc(B)], couples: [coupleDoc()], growth_tasks: [taskDoc({ status: 'archived', archivedType: 'done' })] });
  const archived = await h.callAs(A, 'growth.remove', { taskId: 'g_test0000000001' });
  assert.strictEqual(archived.code, 'GROWTH_STATE_INVALID');
  assert.strictEqual(archived.message, '成长日志是写完的历史，不删');
});

// ── 越权 ───────────────────────────────────────────────────────────────────

test('跨对隔离：别的情侣的任务读不到也改不动', async (t) => {
  withGrowthTemplate(t);
  const h = setup({
    users: [userDoc(A), userDoc(B), userDoc('oC', { coupleId: OTHER_COUPLE }), userDoc('oD', { coupleId: OTHER_COUPLE })],
    couples: [coupleDoc(), coupleDoc(OTHER_COUPLE, ['oC', 'oD'])],
    growth_tasks: [taskDoc({ coupleId: OTHER_COUPLE })],
  });

  const confirm = await h.callAs(A, 'growth.confirm', { taskId: 'g_test0000000001' });
  assert.strictEqual(confirm.code, 'FORBIDDEN');
  const update = await h.callAs(A, 'growth.update', { taskId: 'g_test0000000001', title: '偷偷改' });
  assert.strictEqual(update.code, 'FORBIDDEN');
  const remove = await h.callAs(A, 'growth.remove', { taskId: 'g_test0000000001' });
  assert.strictEqual(remove.code, 'FORBIDDEN');
  const done = await h.callAs(A, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(done.code, 'FORBIDDEN');

  const missing = await h.callAs(A, 'growth.update', { taskId: 'g_missing', title: 'x' });
  assert.strictEqual(missing.code, 'GROWTH_NOT_FOUND');
});

// ── list / log ─────────────────────────────────────────────────────────────

test('growth.list：待认领排前面，stats 与订阅额度一起返回', async (t) => {
  const h = setup({
    users: [userDoc(A), userDoc(B, { growthSubQuota: 2 })],
    couples: [coupleDoc()],
    growth_tasks: [
      taskDoc({ _id: 'g_active', status: 'active', createdAt: new Date(NOW.getTime() + 2) }),
      taskDoc({ _id: 'g_confirm', status: 'confirming', createdAt: new Date(NOW.getTime() + 5) }),
      taskDoc({ _id: 'g_arch', status: 'archived', archivedType: 'done', archivedAt: NOW }),
    ],
  });

  const res = await h.callAs(A, 'growth.list');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.deepStrictEqual(res.data.items.map((item) => item.taskId), ['g_confirm', 'g_active']);
  assert.deepStrictEqual(res.data.stats, { inFlight: 2, awaitingConfirm: 1, archivedCount: 1 });
  assert.strictEqual(res.data.subConfigured, false, '没配模板要如实告诉客户端');
  assert.strictEqual(res.data.subQuota, 0);
  assert.strictEqual(res.data.subQuotaMax, 7);

  // B 有额度、且模板配好了
  process.env.YIYI_GROWTH_TEMPLATE_ID = 'tpl_growth';
  t.after(() => { delete process.env.YIYI_GROWTH_TEMPLATE_ID; });
  const asB = await h.callAs(B, 'growth.list');
  assert.strictEqual(asB.data.subConfigured, true);
  assert.strictEqual(asB.data.subQuota, 2);
});

test('growth.log：自己写了才解锁对方那段；补写后两段都返回', async (t) => {
  // A 是起草者，还没写收获；B 写了 → A 看到的是「TA 写了，你写完就能看」
  const archived = taskDoc({
    _id: 'g_done1',
    status: 'archived',
    archivedType: 'done',
    creatorHarvest: null,
    partnerHarvest: '抽单词抽到吵架又和好',
    archivedAt: new Date(NOW.getTime() + 1000),
    doneAt: NOW,
  });
  const h = setup({ growth_tasks: [archived] });

  const locked = await h.callAs(A, 'growth.log');
  const lockedItem = locked.data.items[0];
  assert.strictEqual(lockedItem.myText, null, 'A 没写，自己那段是 null');
  assert.strictEqual(lockedItem.partnerText, null, '没写就不能看对方那段');
  assert.strictEqual(lockedItem.partnerWritten, true, '但要告诉客户端 TA 写了');
  assert.strictEqual(lockedItem.partnerHarvestUnlocked, false);

  // A 补写自己的那段（archived(done) 允许纯补写）→ 立刻解锁
  const wrote = await h.callAs(A, 'growth.harvest', { taskId: 'g_done1', text: '背完了，最后三天在赶' });
  assert.strictEqual(wrote.ok, true, JSON.stringify(wrote));
  assert.strictEqual(wrote.data.archived, true, '已归档的补写仍算归档态');

  const unlocked = await h.callAs(A, 'growth.log');
  const item = unlocked.data.items[0];
  assert.strictEqual(item.myText, '背完了，最后三天在赶');
  assert.strictEqual(item.partnerText, '抽单词抽到吵架又和好');
  assert.strictEqual(item.partnerHarvestUnlocked, true);
  assert.strictEqual(item.archivedType, 'done');
});

test('growth.log：复盘收尾读的是 review 段；游标翻页不重不漏', async (t) => {
  const docs = [];
  for (let i = 0; i < 3; i += 1) {
    docs.push(taskDoc({
      _id: 'g_rev' + i,
      status: 'archived',
      archivedType: 'reviewed',
      creatorReview: 'A 的复盘 ' + i,
      partnerReview: 'B 的复盘 ' + i,
      archivedAt: new Date(NOW.getTime() + i * 1000),
    }));
  }
  const h = setup({ growth_tasks: docs });

  const first = await h.callAs(A, 'growth.log', { limit: 2 });
  assert.strictEqual(first.data.items.length, 2);
  assert.deepStrictEqual(first.data.items.map((item) => item.taskId), ['g_rev2', 'g_rev1']);
  assert.strictEqual(first.data.items[0].myText, 'A 的复盘 2', '复盘收尾读 review 段');
  assert.ok(first.data.nextCursor);

  const second = await h.callAs(A, 'growth.log', { limit: 2, cursor: first.data.nextCursor });
  assert.deepStrictEqual(second.data.items.map((item) => item.taskId), ['g_rev0']);
  assert.strictEqual(second.data.nextCursor, null, '没有更多时 nextCursor 为 null');
});

// ── 订阅提醒（增补稿 3.3 / 文档 7.18）─────────────────────────────────────

test('订阅提醒：起草后提醒对方认领，扣对方的额度并记当天计数', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ users: [userDoc(A, { growthSubQuota: 5 }), userDoc(B, { growthSubQuota: 2 })] });

  const res = await h.callAs(A, 'growth.add', { title: '一起跑步', category: 'sport' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const calls = sentCalls(h);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].args.touser, B, '提醒的是对方');
  assert.strictEqual(calls[0].args.templateId, 'tpl_growth');
  assert.strictEqual(calls[0].args.data.thing1.value, 'TA 起草了新任务，等你认领');
  assert.ok(/^\d{2}:\d{2}$/.test(calls[0].args.data.time2.value));

  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 1, '扣的是收件人的额度');
  assert.strictEqual(h.fake().get('users', A).growthSubQuota, 5, '发起人不扣');
  assert.strictEqual(h.fake().get('users', B).growthSubSentCount, 1);
  assert.strictEqual(h.fake().get('users', B).growthSubSentDate, LIVE_TODAY);
});

test('订阅提醒：标记完成后提醒对方写收获', async (t) => {
  withGrowthTemplate(t);
  const h = setup({
    users: [userDoc(A), userDoc(B, { growthSubQuota: 2 })],
    growth_tasks: [taskDoc({ status: 'active', confirmedAt: NOW })],
  });

  const res = await h.callAs(A, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const calls = sentCalls(h);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].args.touser, B);
  assert.strictEqual(calls[0].args.data.thing1.value, '一起的事完成了，写句收获吧');
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 1);
});

test('订阅提醒：done 重复点幂等，不会重复发；发起人自己的额度不动', async (t) => {
  withGrowthTemplate(t);
  const h = setup({
    users: [userDoc(A, { growthSubQuota: 4 }), userDoc(B, { growthSubQuota: 3 })],
    growth_tasks: [taskDoc({ status: 'active', confirmedAt: NOW })],
  });

  const first = await h.callAs(A, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  const second = await h.callAs(B, 'growth.done', { taskId: 'g_test0000000001' });
  assert.strictEqual(second.ok, true, '幂等返回而不是报错');

  assert.strictEqual(sentCalls(h).length, 1, '只有第一次推进状态时发提醒');
  assert.strictEqual(sentCalls(h)[0].args.touser, B, '第一次是 A 点的，提醒 B');
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 2);
  assert.strictEqual(h.fake().get('users', A).growthSubQuota, 4, '发起人自己的额度不动');
});

test('订阅提醒：模板未配 / 对方没额度 / 当天已 3 条 都不发，业务照常成功', async (t) => {
  // 1) 模板未配
  let h = setup({ users: [userDoc(A), userDoc(B, { growthSubQuota: 3 })] });
  let res = await h.callAs(A, 'growth.add', { title: '一起跑步', category: 'sport' });
  assert.strictEqual(res.ok, true, '提醒失败不能影响业务');
  assert.strictEqual(sentCalls(h).length, 0);
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 3, '没发就不扣额度');

  // 2) 对方没额度
  process.env.YIYI_GROWTH_TEMPLATE_ID = 'tpl_growth';
  t.after(() => { delete process.env.YIYI_GROWTH_TEMPLATE_ID; });
  h = setup({ users: [userDoc(A), userDoc(B, { growthSubQuota: 0 })] });
  res = await h.callAs(A, 'growth.add', { title: '一起跑步', category: 'sport' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(sentCalls(h).length, 0);

  // 3) 当天已经发满 3 条
  h = setup({
    users: [userDoc(A), userDoc(B, {
      growthSubQuota: 3, growthSubSentDate: LIVE_TODAY, growthSubSentCount: 3,
    })],
  });
  res = await h.callAs(A, 'growth.add', { title: '一起跑步', category: 'sport' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(sentCalls(h).length, 0, '防骚扰上限要生效');
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 3);
});

test('订阅提醒：暂停进行中静音，额度不扣', async (t) => {
  withGrowthTemplate(t);
  const h = setup({
    users: [userDoc(A), userDoc(B, { growthSubQuota: 3 })],
    pauses: [{
      _id: 'p_1', coupleId: COUPLE, byOpenid: A, durationMin: 30, status: 'active',
      startedAt: new Date(Date.now() - 5 * 60 * 1000),
      endsAt: new Date(Date.now() + 25 * 60 * 1000),
      endedAt: null, endChoice: null, endChoiceBy: null,
      createdAt: new Date(), updatedAt: new Date(),
    }],
  });

  const res = await h.callAs(A, 'growth.add', { title: '一起跑步', category: 'sport' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(sentCalls(h).length, 0, '吵架期间别弹「来认领任务」');
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 3);
});

test('订阅提醒：43101 拒收清零，其它错误把额度还回去，日志不含任务标题', async (t) => {
  withGrowthTemplate(t);
  const errors = captureConsoleError(t);

  // 43101：用户拒收
  let h = setup({ users: [userDoc(A), userDoc(B, { growthSubQuota: 3 })] });
  h.setOpenapi({ subscribeMessage: { send: async () => ({ errCode: 43101, errMsg: 'user refuse' }) } });
  let res = await h.callAs(A, 'growth.add', { title: '悄悄话标题', category: 'other' });
  assert.strictEqual(res.ok, true, '拒收也不能打断业务');
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 0, '拒收后额度清零');
  assert.strictEqual(h.fake().get('users', B).growthSubSentCount, undefined, '没发成功不计数');

  // 瞬时错误：额度还回去
  h = setup({ users: [userDoc(A), userDoc(B, { growthSubQuota: 3 })] });
  h.setOpenapi({
    subscribeMessage: {
      send: async () => { const err = new Error('system busy'); err.errCode = 45009; throw err; },
    },
  });
  res = await h.callAs(A, 'growth.add', { title: '悄悄话标题', category: 'other' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(h.fake().get('users', B).growthSubQuota, 3, '没发出去要把额度还回去');
  assert.ok(JSON.stringify(errors).indexOf('growth-sub') !== -1, '要有 [growth-sub] 日志');
  assert.strictEqual(JSON.stringify(errors).indexOf('悄悄话标题'), -1, '日志不能打任务标题');
});

test('reminder.grant：template=task 攒任务额度，与报平安额度互不串', async (t) => {
  withGrowthTemplate(t);
  const h = setup({ users: [userDoc(A, { reminderQuota: 1, growthSubQuota: 0 })] });

  const res = await h.callAs(A, 'reminder.grant', { template: 'task' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(h.fake().get('users', A).growthSubQuota, 1);
  assert.strictEqual(h.fake().get('users', A).reminderQuota, 1, '报平安额度不能动');
  assert.strictEqual(res.data.taskQuota, 1);
  assert.strictEqual(res.data.taskQuotaMax, 7);
  assert.strictEqual(res.data.taskConfigured, true);

  // 缺省仍然是 safety（老的客户端不改也能用）
  const legacy = await h.callAs(A, 'reminder.grant');
  assert.strictEqual(h.fake().get('users', A).reminderQuota, 2);
  assert.strictEqual(h.fake().get('users', A).growthSubQuota, 1);

  // 封顶 7
  h.fake().get('users', A).growthSubQuota = 7;
  const capped = await h.callAs(A, 'reminder.grant', { template: 'task' });
  assert.strictEqual(capped.data.taskQuota, 7);

  const bad = await h.callAs(A, 'reminder.grant', { template: 'growth' });
  assert.strictEqual(bad.code, 'INVALID_INPUT');
});

test('growth 常量：分类与状态在 handler 与文档之间同源', () => {
  assert.deepStrictEqual(growth.CATEGORIES, ['learn', 'sport', 'money', 'habit', 'other']);
  assert.deepStrictEqual(growth.IN_FLIGHT, ['confirming', 'active', 'harvesting']);
  assert.strictEqual(growth.IN_FLIGHT_MAX, 10);
});
