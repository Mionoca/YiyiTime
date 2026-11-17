'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const A = 'oA';
const B = 'oB';
const COUPLE = 'c_1';
/** UTC 13:05 = 东八区 21:05；只喂给 runTimer({ now: NOW }) 这类可注入时间的用例 */
const NOW = new Date('2026-11-17T13:05:00.000Z');
const TODAY = '2026-11-17';

const reminder = require('../cloudfunctions/api/handlers/reminder');
const time = require('../cloudfunctions/api/lib/time');
/**
 * reminder.get / set 走的是 ctx.now（`new Date()`，没法注入），
 * 所以涉及「今天」的断言必须按运行时算：写死日期的话，跨天跑测试就会莫名其妙红。
 */
const LIVE_TODAY = time.dateKeyOf(new Date());

function userDoc(id, extra) {
  return Object.assign({
    _id: id, openid: id, nickname: id === A ? '小怡' : '小安', avatarFileID: '',
    coupleId: COUPLE, profileComplete: true, bindFailCount: 0,
    lastActiveAt: NOW, createdAt: NOW, updatedAt: NOW,
  }, extra || {});
}

function coupleDoc() {
  return {
    _id: COUPLE, memberOpenids: [A, B], startDate: '2024-05-20',
    startDateUpdatedBy: A, status: 'active',
    unbindStatus: 'none', createdAt: NOW, updatedAt: NOW,
  };
}

/** 默认：已开启提醒、21:00、还有 3 条额度、今天还没发过 */
function armedUser(id, extra) {
  return userDoc(id, Object.assign({
    reminderEnabled: true, reminderAt: '21:00', reminderQuota: 3, reminderLastSentDate: null,
  }, extra || {}));
}

function setup(extra) {
  const h = createHarness();
  h.reset(Object.assign({
    users: [armedUser(A), armedUser(B)],
    couples: [coupleDoc()],
  }, extra || {}));
  return h;
}

function withTemplate(t) {
  process.env.YIYI_REMINDER_TEMPLATE_ID = 'tpl_test';
  t.after(() => { delete process.env.YIYI_REMINDER_TEMPLATE_ID; });
}

function sentCalls(h) {
  return h.openapiCalls().filter((c) => c.api === 'subscribeMessage.send');
}

function userRow(h, id) {
  return h.fake().get('users', id);
}

test('reminder.get：默认关闭，返回默认时间与额度上限，未配置模板时 configured=false', async (t) => {
  const h = createHarness();
  h.reset({ users: [userDoc(A)], couples: [coupleDoc()] });

  const res = await h.callAs(A, 'reminder.get');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.data.enabled, false);
  assert.strictEqual(res.data.remindAt, '21:00');
  assert.strictEqual(res.data.quota, 0);
  assert.strictEqual(res.data.quotaMax, 7);
  assert.strictEqual(res.data.bound, true);
  assert.strictEqual(res.data.checkedInToday, false);
  assert.strictEqual(res.data.configured, false, '没配模板时页面要禁用开关');

  withTemplate(t);
  const res2 = await h.callAs(A, 'reminder.get');
  assert.strictEqual(res2.data.configured, true);
});

test('reminder.get：今天报过平安时 checkedInToday=true，未绑定时恒为 false', async () => {
  const h = setup({
    safety_checkins: [{
      _id: 's1', coupleId: COUPLE, openid: A, note: '', date: LIVE_TODAY, createdAt: NOW,
    }],
  });
  const res = await h.callAs(A, 'reminder.get');
  assert.strictEqual(res.data.checkedInToday, true);

  const h2 = createHarness();
  h2.reset({ users: [userDoc(A, { coupleId: null })], couples: [coupleDoc()] });
  const res2 = await h2.callAs(A, 'reminder.get');
  assert.strictEqual(res2.data.checkedInToday, false);
  assert.strictEqual(res2.data.bound, false);
});

test('reminder.set：开启要求先绑定，关闭不要求', async () => {
  const h = createHarness();
  h.reset({ users: [userDoc(A, { coupleId: null })], couples: [coupleDoc()] });

  const on = await h.callAs(A, 'reminder.set', { enabled: true });
  assert.strictEqual(on.ok, false);
  assert.strictEqual(on.code, 'NOT_BOUND');

  const off = await h.callAs(A, 'reminder.set', { enabled: false });
  assert.strictEqual(off.ok, true, JSON.stringify(off));
  assert.strictEqual(off.data.enabled, false);
});

test('reminder.set：时间归一化与非法值', async () => {
  const h = setup();
  const ok = await h.callAs(A, 'reminder.set', { enabled: true, remindAt: '9:05' });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.data.remindAt, '09:05', '不补零的写法要归一化');
  assert.strictEqual(userRow(h, A).reminderAt, '09:05');

  for (const bad of ['25:00', '21:60', '21', '', 'abc', '21:5']) {
    const res = await h.callAs(A, 'reminder.set', { enabled: true, remindAt: bad });
    assert.strictEqual(res.ok, false, '应拒绝：' + JSON.stringify(bad));
    assert.strictEqual(res.code, 'INVALID_INPUT');
  }

  const notBool = await h.callAs(A, 'reminder.set', { enabled: 'yes' });
  assert.strictEqual(notBool.code, 'INVALID_INPUT');
});

test('reminder.grant：攒额度 +1，最多 7 条；到上限后不报错', async () => {
  const h = setup();
  let res = await h.callAs(A, 'reminder.grant');
  assert.strictEqual(res.data.quota, 4, '原有 3 条 + 1');

  for (let i = 0; i < 5; i += 1) res = await h.callAs(A, 'reminder.grant');
  assert.strictEqual(res.data.quota, 7);
  assert.strictEqual(userRow(h, A).reminderQuota, 7);
});

test('定时任务：到点、没报平安、有额度 → 发一条，扣额度并记日期', async (t) => {
  withTemplate(t);
  const h = setup();

  const res = await reminder.runTimer({ now: NOW, trigger: 'reminder-tick' });
  assert.strictEqual(res.todayKey, TODAY);
  assert.strictEqual(res.hhmm, '21:05');
  assert.strictEqual(res.sent, 2, '两个人都该收到（各自给自己开）');

  const calls = sentCalls(h);
  assert.strictEqual(calls.length, 2);
  const toA = calls.find((c) => c.args.touser === A);
  assert.strictEqual(toA.args.templateId, 'tpl_test');
  assert.strictEqual(toA.args.page, 'pages/safety/index');
  assert.strictEqual(toA.args.data.thing1.value, '今天还没给 TA 报平安');
  assert.strictEqual(toA.args.data.time2.value, '21:00');

  assert.strictEqual(userRow(h, A).reminderQuota, 2);
  assert.strictEqual(userRow(h, A).reminderLastSentDate, TODAY);
});

test('定时任务：还没到点不发（22:00 的人在 21:05 不该被叫）', async (t) => {
  withTemplate(t);
  const h = setup({ users: [armedUser(A, { reminderAt: '22:00' })] });
  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(sentCalls(h).length, 0);
});

test('定时任务：今天已经报过平安就不打扰', async (t) => {
  withTemplate(t);
  const h = setup({
    users: [armedUser(A)],
    safety_checkins: [{ _id: 's1', coupleId: COUPLE, openid: A, note: '', date: TODAY, createdAt: NOW }],
  });
  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(res.skipped, 1);
  assert.strictEqual(userRow(h, A).reminderQuota, 3, '没发就不该扣额度');
});

test('定时任务：额度用完、今天已发过都跳过（一天最多一条）', async (t) => {
  withTemplate(t);
  const h = setup({
    users: [
      armedUser(A, { reminderQuota: 0 }),
      armedUser(B, { reminderLastSentDate: TODAY }),
    ],
  });
  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(res.skipped, 2);
  assert.strictEqual(sentCalls(h).length, 0);
});

test('定时任务：用户拒收（43101）→ 关开关、额度清零，不再重试', async (t) => {
  withTemplate(t);
  captureConsoleError(t);
  const h = setup({ users: [armedUser(A)] });
  h.setOpenapi({
    subscribeMessage: { send: async () => ({ errCode: 43101, errMsg: 'user refuse to accept the msg' }) },
  });

  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.rejected, 1);
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(userRow(h, A).reminderEnabled, false);
  assert.strictEqual(userRow(h, A).reminderQuota, 0);
  // 发送前已经占位（这是「一天最多一条」的实现方式）；拒收后开关已关，
  // 占位留着只是让今天不要再试一次，不会影响明天
  assert.strictEqual(userRow(h, A).reminderLastSentDate, TODAY);

  // 再跑一次也不会再尝试（开关已关）
  const again = await reminder.runTimer({ now: NOW });
  assert.strictEqual(again.sent, 0);
  assert.strictEqual(sentCalls(h).length, 1);
});

test('定时任务：瞬时失败不扣额度、把占位还回去，下个窗口还能再试', async (t) => {
  withTemplate(t);
  const logs = captureConsoleError(t);
  const h = setup({ users: [armedUser(A)] });
  h.setOpenapi({
    subscribeMessage: { send: async () => ({ errCode: 45009, errMsg: 'reach max api daily quota limit' }) },
  });

  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.failed, 1);
  assert.strictEqual(userRow(h, A).reminderQuota, 3, '没发成功不扣额度');
  assert.strictEqual(userRow(h, A).reminderLastSentDate, null, '占位要还回去');
  assert.ok(logs.map((a) => a.join(' ')).join('\n').indexOf('send-failed') !== -1);

  // 修好之后再跑一次，能正常发
  h.setOpenapi({});
  const retry = await reminder.runTimer({ now: NOW });
  assert.strictEqual(retry.sent, 1);
  assert.strictEqual(userRow(h, A).reminderQuota, 2);
});

test('定时任务：模板参数错（47003）属于配置问题，今天不再重试', async (t) => {
  withTemplate(t);
  const logs = captureConsoleError(t);
  const h = setup({ users: [armedUser(A)] });
  h.setOpenapi({
    subscribeMessage: { send: async () => ({ errCode: 47003, errMsg: 'argument invalid' }) },
  });

  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.failed, 1);
  assert.strictEqual(userRow(h, A).reminderLastSentDate, TODAY, '保留占位，今天不再刷日志');
  assert.strictEqual(userRow(h, A).reminderQuota, 3);
  assert.ok(logs.map((a) => a.join(' ')).join('\n').indexOf('send-failed-permanent') !== -1);

  const again = await reminder.runTimer({ now: NOW });
  assert.strictEqual(again.sent, 0);
  assert.strictEqual(sentCalls(h).length, 1, '今天只尝试一次');
});

test('定时任务：没配模板时一条都不发，也不报错', async () => {
  const h = setup();
  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.reason, 'template-not-configured');
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(sentCalls(h).length, 0);
});

test('定时任务：解绑后（coupleId 为空）不再打扰', async (t) => {
  withTemplate(t);
  const h = setup({ users: [armedUser(A, { coupleId: null })] });
  const res = await reminder.runTimer({ now: NOW });
  assert.strictEqual(res.sent, 0);
  assert.strictEqual(res.skipped, 1);
});

test('定时任务：按东八区判断时间（UTC 13:05 视为北京 21:05）', async (t) => {
  withTemplate(t);
  const h = setup({ users: [armedUser(A, { reminderAt: '21:00' })] });
  const res = await reminder.runTimer({ now: new Date('2026-11-17T13:05:00.000Z') });
  assert.strictEqual(res.hhmm, '21:05');
  assert.strictEqual(res.sent, 1, 'cron 时区怎么写都不影响判断，只要算对东八区');

  const h2 = setup({ users: [armedUser(A, { reminderAt: '21:00' })] });
  const res2 = await reminder.runTimer({ now: new Date('2026-11-17T12:55:00.000Z') });
  assert.strictEqual(res2.hhmm, '20:55');
  assert.strictEqual(res2.sent, 0);
});

test('定时任务不是 action：客户端传 reminder.tick 只会得到 UNKNOWN_ACTION', async (t) => {
  withTemplate(t);
  const h = setup();
  const res = await h.callAs(A, 'reminder.tick');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'UNKNOWN_ACTION');
  assert.strictEqual(sentCalls(h).length, 0);
});

test('入口：真实的定时触发器（没有 OPENID）走定时任务而不是 action 白名单', async (t) => {
  withTemplate(t);
  const h = setup({ users: [armedUser(A)] });
  // 真实的定时触发没有用户身份；getWXContext() 只返回 APPID / UNIONID
  h.setOpenid(undefined);
  const res = await h.main({ Type: 'Timer', TriggerName: 'reminder-tick', Time: '2020-01-01T00:00:00.000Z' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.data.trigger, 'reminder-tick');
  // event.Time 是客户端可控的，入口必须忽略它、用服务端当前时间
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(res.data.todayKey), 'todayKey 形状不对：' + res.data.todayKey);
  assert.notStrictEqual(res.data.todayKey, '2020-01-01', '不能信任 event.Time');
  assert.notStrictEqual(res.data.hhmm, '08:00', '不能信任 event.Time 推出来的时刻');
});

test('入口：客户端伪造 Type=Timer 会被拒（否则能越过 action 白名单触发全局发送）', async (t) => {
  withTemplate(t);
  const logs = captureConsoleError(t);
  const h = setup({ users: [armedUser(A)] });
  // 默认 currentOpenid='oA'，相当于客户端自己构造了 event
  const res = await h.main({ Type: 'Timer', TriggerName: 'reminder-tick', Time: NOW.toISOString() });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'FORBIDDEN');
  assert.strictEqual(sentCalls(h).length, 0, '一条消息都不能发出去');
  assert.strictEqual(userRow(h, A).reminderLastSentDate, null, '也不能动用户数据');
  assert.ok(logs.map((a) => a.join(' ')).join('\n').indexOf('forged-timer-event') !== -1);
});

test('解绑确认后双方的提醒开关一起关掉（不留「开着但永远不发」的状态）', async () => {
  const h = setup({
    couples: [Object.assign(coupleDoc(), {
      unbindStatus: 'pending', unbindRequestedBy: A, unbindRequestedAt: NOW,
    })],
  });
  const res = await h.callAs(B, 'couple.confirmUnbind');
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(userRow(h, A).reminderEnabled, false);
  assert.strictEqual(userRow(h, B).reminderEnabled, false);
  assert.strictEqual(userRow(h, A).coupleId, null);
});

test('reminder.set / grant 只写自己的 users 文档，改不到对方', async () => {
  const h = setup();
  await h.callAs(A, 'reminder.set', { enabled: true, remindAt: '22:15' });
  await h.callAs(A, 'reminder.grant');

  assert.strictEqual(userRow(h, A).reminderAt, '22:15');
  assert.strictEqual(userRow(h, A).reminderQuota, 4);
  assert.strictEqual(userRow(h, B).reminderAt, '21:00', 'B 的提醒时间不受影响');
  assert.strictEqual(userRow(h, B).reminderQuota, 3, 'B 的额度不受影响');
});
