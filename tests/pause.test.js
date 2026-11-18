'use strict';

/**
 * 先停一下（F13 / 7.17 / 5.3.10）的契约测试。
 *
 * 产品红线在这里也要锁住：不存原因、不存次数、不做历史——
 * 「closed 之后任何接口都读不到」是一条专门的用例，不是顺手断言。
 *
 * 时间注入口径：pause.* 走 ctx.now（真实时钟），种库文档相对 Date.now()；
 * runTimer 静音用例注入固定 NOW（东八区 21:05，落在 21:00 提醒的 30 分钟窗口内）。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const h = createHarness();
const reminder = require('../cloudfunctions/api/handlers/reminder');

const A = 'oA';
const B = 'oB';
const COUPLE = 'c_1';
/** 东八区 21:05：21:00 的每日提醒正落在 30 分钟到点窗口内（runTimer 用例专用） */
const NOW = new Date('2026-11-17T13:05:00.000Z');

function userDoc(id, extra) {
  return Object.assign({
    _id: id, openid: id, nickname: id === A ? '小怡' : '小安', avatarFileID: '',
    coupleId: COUPLE, profileComplete: true, bindFailCount: 0,
    lastActiveAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
  }, extra || {});
}

function coupleDoc(extra) {
  return Object.assign({
    _id: COUPLE, memberOpenids: [A, B], startDate: '2024-05-20',
    startDateUpdatedBy: A, status: 'active',
    unbindStatus: 'none', createdAt: new Date(), updatedAt: new Date(),
  }, extra || {});
}

/** 进行中的暂停：endsAt 在真实时钟的 25 分钟后（pause.* 走 ctx.now，不能用固定 NOW） */
function activePause(extra) {
  return pauseDoc(Object.assign({
    status: 'active',
    startedAt: new Date(Date.now() - 5 * 60 * 1000),
    endsAt: new Date(Date.now() + 25 * 60 * 1000),
  }, extra));
}

/** 已到点但还没被惰性写回的暂停 */
function elapsedPause(extra) {
  return pauseDoc(Object.assign({
    status: 'active',
    startedAt: new Date(Date.now() - 31 * 60 * 1000),
    endsAt: new Date(Date.now() - 60 * 1000),
  }, extra));
}

function pauseDoc(extra) {
  return Object.assign({
    _id: 'p_test0000000001', coupleId: COUPLE, byOpenid: A, durationMin: 30,
    status: 'active',
    startedAt: new Date(), endsAt: new Date(Date.now() + 30 * 60 * 1000),
    endedAt: null, endChoice: null, endChoiceBy: null,
    createdAt: new Date(), updatedAt: new Date(),
  }, extra || {});
}

function setup(extra) {
  h.reset(Object.assign({
    users: [userDoc(A), userDoc(B)],
    couples: [coupleDoc()],
  }, extra || {}));
  return h;
}

/** runTimer 静音用例：已开启提醒、21:00、还有 3 条额度、今天还没发过（同 reminder.test） */
function armedUser(id) {
  return userDoc(id, {
    reminderEnabled: true, reminderAt: '21:00', reminderQuota: 3, reminderLastSentDate: null,
  });
}

function withTemplate(t) {
  process.env.YIYI_REMINDER_TEMPLATE_ID = 'tpl_test';
  t.after(() => { delete process.env.YIYI_REMINDER_TEMPLATE_ID; });
}

const sentCalls = () => h.openapiCalls().filter((c) => c.api === 'subscribeMessage.send');

test('pause.start：三档时长合法；枚举外 PAUSE_DURATION_INVALID；非整数 INVALID_INPUT', async () => {
  const hh = setup();
  for (const durationMin of [10, 30, 60]) {
    const res = await hh.callAs(A, 'pause.start', { durationMin });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.strictEqual(res.data.pause.durationMin, durationMin);
    assert.strictEqual(res.data.pause.status, 'active');
    assert.strictEqual(res.data.existing, false);
    hh.reset({ users: [userDoc(A), userDoc(B)], couples: [coupleDoc()] });
  }
  for (const durationMin of [5, 15, 45, 90, 0, -30]) {
    const res = await hh.callAs(A, 'pause.start', { durationMin });
    assert.strictEqual(res.code, 'PAUSE_DURATION_INVALID', durationMin + ' 应被拒');
    assert.strictEqual(res.message, '选 10、30 或 60 分钟');
  }
  for (const durationMin of ['30', null, undefined, 3.5, NaN]) {
    const res = await hh.callAs(A, 'pause.start', { durationMin });
    assert.strictEqual(res.code, 'INVALID_INPUT', String(durationMin) + ' 应报 INVALID_INPUT');
  }
  assert.strictEqual(hh.fake().all('pauses').length, 0, '被拒的请求一条都不能写库');
});

test('pause.*：未绑定一律 NOT_BOUND（暂停是两个人的事）', async (t) => {
  captureConsoleError(t);
  const hh = setup({ users: [userDoc(A, { coupleId: null })], couples: [coupleDoc()] });
  for (const [action, payload] of [
    ['pause.start', { durationMin: 30 }],
    ['pause.status', {}],
    ['pause.end', {}],
    ['pause.choose', { choice: 'later' }],
  ]) {
    const res = await hh.callAs(A, action, payload);
    assert.strictEqual(res.code, 'NOT_BOUND', action);
    assert.strictEqual(res.message, '先邀请 TA 住进来吧', action);
  }
});

test('pause.start：同一对同时只有一条——自己或对方再按都幂等返回现状，不新建', async () => {
  const hh = setup();
  const first = await hh.callAs(A, 'pause.start', { durationMin: 30 });
  assert.strictEqual(first.data.existing, false);

  const again = await hh.callAs(A, 'pause.start', { durationMin: 10 });
  assert.strictEqual(again.data.existing, true, '自己再按幂等');
  assert.strictEqual(again.data.pause.pauseId, first.data.pause.pauseId);
  assert.strictEqual(again.data.pause.durationMin, 30, '时长仍是第一次的，不被覆盖');

  const byPartner = await hh.callAs(B, 'pause.start', { durationMin: 60 });
  assert.strictEqual(byPartner.data.existing, true, '对方再按也幂等');
  assert.strictEqual(byPartner.data.pause.byMe, false, 'B 视角：是 A 按的');
  assert.strictEqual(byPartner.data.pause.byName, '小怡');

  assert.strictEqual(hh.fake().all('pauses').length, 1, '只允许一条未 closed 记录');
});

test('pause.status：无记录返回 { pause: null }；active 时双方视图正确且不泄漏 openid', async () => {
  const hh = setup();
  const none = await hh.callAs(A, 'pause.status', {});
  assert.deepStrictEqual(none.data, { pause: null });

  await hh.callAs(A, 'pause.start', { durationMin: 30 });
  const mine = await hh.callAs(A, 'pause.status', {});
  assert.strictEqual(mine.data.pause.byMe, true);
  assert.strictEqual(mine.data.pause.byName, '小怡');
  assert.strictEqual(mine.data.pause.status, 'active');
  assert.ok(mine.data.pause.endsAt > mine.data.pause.startedAt);

  const theirs = await hh.callAs(B, 'pause.status', {});
  assert.strictEqual(theirs.data.pause.byMe, false);
  assert.strictEqual(theirs.data.pause.byName, '小怡', 'B 看到的是发起方 A 的名字');

  // 脱敏：视图里没有 openid / coupleId / byOpenid
  const view = JSON.stringify(mine.data.pause);
  assert.ok(view.indexOf('oA') === -1 && view.indexOf(COUPLE) === -1, '视图不能带 openid / coupleId');
});

test('到点惰性 ended：读取时写回 endedAt；再次读取不重复写', async () => {
  const hh = setup({ pauses: [elapsedPause()] });
  const res = await hh.callAs(A, 'pause.status', {});
  assert.strictEqual(res.data.pause.status, 'ended', '到点即视为 ended');
  const doc = hh.fake().all('pauses')[0];
  assert.strictEqual(doc.status, 'ended');
  assert.ok(doc.endedAt instanceof Date, 'endedAt 已写回');

  const again = await hh.callAs(B, 'pause.status', {});
  assert.strictEqual(again.data.pause.status, 'ended');
  assert.strictEqual(hh.fake().all('pauses')[0].endedAt, doc.endedAt, '第二次读取不重复写');
});

test('惰性写回失败不阻塞返回（仍按 ended 视图走，只记一条日志）', async (t) => {
  const logs = captureConsoleError(t);
  const hh = setup({ pauses: [elapsedPause()] });
  hh.setFault({ collection: 'pauses', method: 'update', error: new Error('write down') });

  const res = await hh.callAs(A, 'pause.status', {});
  assert.strictEqual(res.ok, true, '写回失败不能影响读取');
  assert.strictEqual(res.data.pause.status, 'ended');

  const line = logs.map((args) => args.join(' ')).find((text) => text.includes('lazy-end-failed'));
  assert.ok(line, '应记录 lazy-end-failed 日志');
  hh.setFault(null);
});

test('pause.end：发起方提前结束 active → ended；再 end 幂等', async () => {
  const hh = setup();
  await hh.callAs(A, 'pause.start', { durationMin: 60 });

  const ended = await hh.callAs(A, 'pause.end', {});
  assert.strictEqual(ended.data.pause.status, 'ended');
  assert.strictEqual(hh.fake().all('pauses')[0].status, 'ended');

  const again = await hh.callAs(A, 'pause.end', {});
  assert.strictEqual(again.data.pause.status, 'ended');
  assert.strictEqual(hh.fake().all('pauses').length, 1);
});

test('pause.end：非发起方 PAUSE_NOT_OWNER（active / ended 都拦）；无记录 PAUSE_NOT_FOUND', async () => {
  const hh = setup();
  const none = await hh.callAs(A, 'pause.end', {});
  assert.strictEqual(none.code, 'PAUSE_NOT_FOUND');
  assert.strictEqual(none.message, '现在不需要暂停');

  await hh.callAs(A, 'pause.start', { durationMin: 30 });
  const byPartner = await hh.callAs(B, 'pause.end', {});
  assert.strictEqual(byPartner.code, 'PAUSE_NOT_OWNER');
  assert.strictEqual(byPartner.message, '这个暂停是 TA 按的，等 TA 回来');
  assert.strictEqual(hh.fake().all('pauses')[0].status, 'active', '非发起方动不了状态');

  const byOwner = await hh.callAs(A, 'pause.end', {}); // 发起方结束
  assert.strictEqual(byOwner.data.pause.status, 'ended');
  const byPartnerAfterEnded = await hh.callAs(B, 'pause.end', {});
  assert.strictEqual(byPartnerAfterEnded.code, 'PAUSE_NOT_OWNER', 'ended 后非发起方仍不能碰');
});

test('pause.choose：choice 枚举外 INVALID_INPUT；无未 closed 记录 PAUSE_NOT_FOUND', async () => {
  const hh = setup();
  for (const choice of ['hug2', '', null, undefined, 'HURRY']) {
    const res = await hh.callAs(A, 'pause.choose', { choice });
    assert.strictEqual(res.code, 'INVALID_INPUT', String(choice) + ' 应报 INVALID_INPUT');
  }
  const none = await hh.callAs(A, 'pause.choose', { choice: 'later' });
  assert.strictEqual(none.code, 'PAUSE_NOT_FOUND');
});

test('pause.choose：active 上调 → PAUSE_STATE_INVALID（还没结束，不能选和好话）', async () => {
  const hh = setup();
  await hh.callAs(A, 'pause.start', { durationMin: 30 });
  const res = await hh.callAs(B, 'pause.choose', { choice: 'later' });
  assert.strictEqual(res.code, 'PAUSE_STATE_INVALID');
  assert.strictEqual(res.message, '暂停还没结束，先等一等');
  assert.strictEqual(hh.fake().all('pauses')[0].status, 'active');
});

test('pause.choose：ended → closed 先选者定，双方可见同一选择；后到者幂等不覆盖', async () => {
  const hh = setup({ pauses: [elapsedPause()] });

  const first = await hh.callAs(B, 'pause.choose', { choice: 'later' });
  assert.strictEqual(first.data.pause.status, 'closed');
  assert.strictEqual(first.data.pause.endChoice, 'later');

  const doc = hh.fake().all('pauses')[0];
  assert.strictEqual(doc.endChoice, 'later');
  assert.strictEqual(doc.endChoiceBy, B, '先选者的 openid 落库');

  // 串行后到者：closed 等于不存在（「没有历史」红线），PAUSE_NOT_FOUND。
  // 并发窗口内的后到者由事务内重读兑幂等（真实云开发事务有快照隔离；
  // 假库不模拟隔离，见 fake-db 头注释，所以这里不并发模拟）
  const second = await hh.callAs(A, 'pause.choose', { choice: 'hurry' });
  assert.strictEqual(second.code, 'PAUSE_NOT_FOUND');
  assert.strictEqual(hh.fake().all('pauses')[0].endChoice, 'later', '后到者不能改选择');
});

test('closed 之后从任何接口都读不到：status 返回 null（没有历史就没有翻旧账）', async () => {
  const hh = setup({
    pauses: [pauseDoc({ status: 'closed', endedAt: new Date(), endChoice: 'hug', endChoiceBy: A })],
  });
  const res = await hh.callAs(A, 'pause.status', {});
  assert.deepStrictEqual(res.data, { pause: null });

  const afterClosed = await hh.callAs(B, 'pause.choose', { choice: 'later' });
  assert.strictEqual(afterClosed.code, 'PAUSE_NOT_FOUND', 'closed 记录等于不存在');
  assert.strictEqual(hh.fake().all('pauses').length, 1, 'closed 文档保留（不物理删除），只是读不到');
});

test('跨对隔离：别的 couple 的暂停不可见，也不能 end / choose', async () => {
  const hh = setup({
    pauses: [
      activePause({ _id: 'p_other', coupleId: 'c_2', byOpenid: 'oX' }),
    ],
  });
  const res = await hh.callAs(A, 'pause.status', {});
  assert.deepStrictEqual(res.data, { pause: null });
  const end = await hh.callAs(A, 'pause.end', {});
  assert.strictEqual(end.code, 'PAUSE_NOT_FOUND');
  assert.strictEqual(hh.fake().get('pauses', 'p_other').status, 'active', '别人家的暂停动不了');
});

test('runTimer 静音：暂停进行中整轮跳过（不发送、不扣额度、不写日期）', async (t) => {
  withTemplate(t);
  const hh = h;
  hh.reset({
    users: [armedUser(A), armedUser(B)],
    couples: [coupleDoc()],
    // NOW 之后 10 分钟才到点：两人都在暂停期
    pauses: [pauseDoc({
      startedAt: new Date(NOW.getTime() - 20 * 60 * 1000),
      endsAt: new Date(NOW.getTime() + 10 * 60 * 1000),
    })],
  });

  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 0, '暂停期不发每日提醒');
  assert.strictEqual(res.skipped, 2);
  assert.strictEqual(sentCalls().length, 0);
  for (const id of [A, B]) {
    const row = hh.fake().get('users', id);
    assert.strictEqual(row.reminderQuota, 3, '额度未扣');
    assert.strictEqual(row.reminderLastSentDate, null, '不写占位：下个窗口自然重试');
  }
});

test('runTimer：到点（哪怕惰性未写回）或已 closed 不再静音，次日照常恢复', async (t) => {
  withTemplate(t);
  const hh = h;

  // 到点未写回：status 还是 active，但 endsAt 已过 —— 静音只看「进行中」
  hh.reset({
    users: [armedUser(A), armedUser(B)],
    couples: [coupleDoc()],
    pauses: [pauseDoc({
      startedAt: new Date(NOW.getTime() - 40 * 60 * 1000),
      endsAt: new Date(NOW.getTime() - 10 * 60 * 1000),
    })],
  });
  let res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 2, '到点后不再静音');
  assert.strictEqual(sentCalls().length, 2);

  // closed（和好卡已选完）：同样不静音
  hh.reset({
    users: [armedUser(A), armedUser(B)],
    couples: [coupleDoc()],
    pauses: [pauseDoc({
      status: 'closed',
      startedAt: new Date(NOW.getTime() - 40 * 60 * 1000),
      endsAt: new Date(NOW.getTime() - 10 * 60 * 1000),
      endedAt: new Date(NOW.getTime() - 9 * 60 * 1000),
      endChoice: 'hug', endChoiceBy: A,
    })],
  });
  res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 2, 'closed 不影响提醒');
});
