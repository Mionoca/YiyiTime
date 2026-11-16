'use strict';

/**
 * 云函数入口（cloudfunctions/api/index.js）的契约测试。
 *
 * 用 tests/helpers/cloud-entry.js 的夹具把 wx-server-sdk 换成本地假库，
 * 覆盖：未知 action / 未识别用户 / 成功信封 / payload 归一化 / 业务错误原样返回 /
 * 内部异常不泄露 / 日志脱敏 / 23 个已注册 action 在「空库 + 未绑定」下都不崩溃。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const h = createHarness();
const handlers = h.handlers;

const EXPECTED_ACTIONS = [
  'system.ping', 'user.get', 'user.updateProfile',
  'bind.create', 'bind.preview', 'bind.apply', 'bind.confirm', 'bind.cancel', 'bind.status',
  'couple.updateStartDate',
  'mood.set', 'hug.send', 'hug.respond',
  'safety.checkin', 'safety.list',
  'diary.save', 'diary.list',
  'wish.add', 'wish.update', 'wish.setDone', 'wish.remove', 'wish.list',
  'home.get',
];

const REQUEST_ID = /^\d+-[a-z0-9]{6}$/;

function reset(openid) {
  h.reset({}, openid === undefined ? 'oA' : openid);
}

test('未知 action 与原型链上的键都返回 UNKNOWN_ACTION，不进入鉴权', async (t) => {
  reset();
  const logs = captureConsoleError(t);
  for (const action of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const res = await h.main({ action });
    assert.strictEqual(res.ok, false, action);
    assert.strictEqual(res.code, 'UNKNOWN_ACTION', action);
    assert.strictEqual(res.message, '这个操作还不存在', action);
    assert.match(res.requestId, REQUEST_ID, action);
    assert.deepStrictEqual(Object.keys(res).sort(), ['code', 'message', 'ok', 'requestId'], action);
  }
  // event 缺失 / action 非字符串
  for (const event of [null, undefined, {}, { action: 123 }, { action: ['system.ping'] }]) {
    const res = await h.main(event);
    assert.strictEqual(res.code, 'UNKNOWN_ACTION');
  }
  // 未知 action 在鉴权之前就返回：即使用户未识别也不会报 UNAUTHORIZED
  h.setOpenid('');
  const beforeAuth = await h.main({ action: 'nope' });
  assert.strictEqual(beforeAuth.code, 'UNKNOWN_ACTION');
  assert.strictEqual(h.fake().all('users').length, 0);
  // 每次失败都记一条脱敏日志（不按条数写死，避免入口加日志就误报）
  const parsed = logs.map((args) => JSON.parse(args[1]));
  assert.ok(parsed.length >= 10);
  parsed.forEach((logged) => {
    assert.strictEqual(logged.code, 'UNKNOWN_ACTION');
    assert.match(logged.requestId, REQUEST_ID);
    assert.strictEqual(logged.openidTail, '');
  });
});

test('OPENID 为空或缺失时返回 UNAUTHORIZED，且不自动建用户文档', async (t) => {
  const logs = captureConsoleError(t);
  for (const openid of ['', undefined]) {
    reset();
    h.setOpenid(openid);
    const res = await h.main({ action: 'system.ping' });
    assert.deepStrictEqual(
      { ok: res.ok, code: res.code, message: res.message },
      { ok: false, code: 'UNAUTHORIZED', message: '无法识别当前用户' },
    );
    assert.match(res.requestId, REQUEST_ID);
    assert.strictEqual(h.fake().all('users').length, 0);
  }
  const parsed = logs.map((args) => JSON.parse(args[1]));
  assert.strictEqual(parsed.length, 2, '两个身份缺失分支都应留下一条 UNAUTHORIZED 日志');
  parsed.forEach((logged) => {
    assert.strictEqual(logged.code, 'UNAUTHORIZED');
    assert.strictEqual(logged.openidTail, '');
  });
});

test('成功请求返回 { ok:true, data }，并按需自动建用户文档', async (t) => {
  reset('oA');
  captureConsoleError(t);
  const res = await h.main({ action: 'system.ping' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.pong, true);
  assert.match(res.data.serverNow, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(res.data.todayKey, /^\d{4}-\d{2}-\d{2}$/);
  // buildContext 的副作用：首次请求自动建档
  const user = h.fake().get('users', 'oA');
  assert.strictEqual(user.openid, 'oA');
  assert.strictEqual(user.coupleId, null);
  assert.strictEqual(user.nickname, '');
  assert.strictEqual(user.profileComplete, false);
  assert.ok(user.createdAt instanceof Date);
  // data 里不能混进信封字段
  assert.deepStrictEqual(Object.keys(res.data).sort(), ['pong', 'serverNow', 'todayKey']);
});

test('payload 不是普通对象时按空对象处理（数组/字符串/null 都不能炸）', async (t) => {
  reset('oA');
  captureConsoleError(t);
  for (const payload of [[1, 2], 'nick', 42, null, true]) {
    const res = await h.main({ action: 'user.updateProfile', payload });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.code, 'PROFILE_REQUIRED');
    assert.strictEqual(res.message, '先填一下昵称吧');
  }

  // 用一个只回显入参的临时 handler，证明是入口把非对象归一成 {}（而不是 handler 内部兜底）
  handlers['test.echo'] = (payload) => ({ payload });
  t.after(() => { delete handlers['test.echo']; });
  for (const payload of [[1, 2], 'nick', 42, null, true, undefined]) {
    const res = await h.main({ action: 'test.echo', payload });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.data.payload, {});
  }
  const objectPayload = { a: 1 };
  const echoed = await h.main({ action: 'test.echo', payload: objectPayload });
  assert.deepStrictEqual(echoed.data.payload, objectPayload);
});

test('业务错误原样返回 code/message（含 AppError 文案）', async (t) => {
  reset('oA');
  const logs = captureConsoleError(t);
  const res = await h.main({ action: 'bind.create', payload: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'PROFILE_REQUIRED');
  assert.strictEqual(res.message, '先给自己起个名字吧');
  assert.match(res.requestId, REQUEST_ID);
  // 业务错误的日志同样带 requestId/action/code
  const logged = JSON.parse(logs[0][1]);
  assert.strictEqual(logged.action, 'bind.create');
  assert.strictEqual(logged.code, 'PROFILE_REQUIRED');
  assert.strictEqual(logged.requestId, res.requestId);
});

test('handler 抛非 AppError 时对客户端返回 INTERNAL_ERROR，不泄露内部细节', async (t) => {
  reset('oABCDEF123456');
  const logs = captureConsoleError(t);
  handlers['test.boom'] = () => { throw new Error('boom: internal detail'); };
  t.after(() => { delete handlers['test.boom']; });

  const res = await h.main({ action: 'test.boom', payload: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'INTERNAL_ERROR');
  assert.strictEqual(res.message, '服务开小差了，稍后再试');
  assert.strictEqual(JSON.stringify(res).includes('boom: internal detail'), false);

  // 服务端日志：只有 openid 后 6 位，其余字段可解析
  const logged = JSON.parse(logs[0][1]);
  assert.deepStrictEqual(Object.keys(logged).sort(), ['action', 'code', 'message', 'openidTail', 'requestId']);
  assert.strictEqual(logged.action, 'test.boom');
  assert.strictEqual(logged.code, 'INTERNAL_ERROR');
  assert.strictEqual(logged.openidTail, '123456');
  assert.match(logged.requestId, REQUEST_ID);
  assert.strictEqual(JSON.stringify(logged).includes('oABCDEF123456'), false);
});

test('SDK 风格 errCode 写入服务端日志 code，但客户端仍是固定 INTERNAL_ERROR', async (t) => {
  reset('oSDK000123456');
  const logs = captureConsoleError(t);
  handlers['test.sdkfail'] = () => {
    throw Object.assign(new Error('database unavailable'), { errCode: -502001 });
  };
  t.after(() => { delete handlers['test.sdkfail']; });

  const res = await h.main({ action: 'test.sdkfail', payload: {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'INTERNAL_ERROR');
  assert.strictEqual(res.message, '服务开小差了，稍后再试');
  assert.strictEqual(JSON.stringify(res).includes('database unavailable'), false);

  assert.strictEqual(logs.length, 1, '非 AppError 只应记录一次');
  const logged = JSON.parse(logs[0][1]);
  // SDK 错误是数字 errCode，日志里统一成字符串，避免同一字段类型跳动
  assert.strictEqual(logged.code, '-502001');
  assert.strictEqual(logged.openidTail, '123456');
});

test('23 个已注册 action 与清单一致，且空库未绑定下都返回可识别结果（无 INTERNAL_ERROR）', async (t) => {
  reset('oA');
  const logs = captureConsoleError(t);
  assert.deepStrictEqual(Object.keys(handlers).sort(), EXPECTED_ACTIONS.slice().sort());
  Object.keys(handlers).forEach((action) => {
    assert.strictEqual(typeof handlers[action], 'function', action + ' 必须是函数');
  });

  const internal = [];
  for (const action of EXPECTED_ACTIONS) {
    const res = await h.main({ action, payload: {} });
    assert.strictEqual(typeof res.ok, 'boolean', action);
    if (res.ok) {
      // 6.2/6.3：成功只需 ok:true + data，不额外约束是否带 requestId
      assert.ok(res.data !== undefined, action);
      assert.strictEqual('code' in res, false, action);
      assert.strictEqual('message' in res, false, action);
      continue; // system.ping / user.get / bind.status / home.get 等允许成功
    }
    assert.match(res.requestId, REQUEST_ID, action);
    assert.strictEqual(typeof res.code, 'string', action);
    assert.strictEqual(typeof res.message, 'string', action);
    assert.ok(res.message.length > 0, action);
    if (res.code === 'INTERNAL_ERROR') internal.push(action);
  }
  assert.deepStrictEqual(internal, [], '空库未绑定下不应有 action 落到 INTERNAL_ERROR');
  assert.ok(logs.length >= 1);
});
