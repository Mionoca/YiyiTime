'use strict';

const test = require('node:test');
const assert = require('node:assert');

const api = require('../miniprogram/utils/api');

function stubWx(handler) {
  global.wx = {
    cloud: { callFunction: handler },
    showToast(opts) {
      global.__lastToast = opts;
    },
  };
}

test('call: 成功返回 data，并把 action/payload 原样交给云函数', async () => {
  const calls = [];
  stubWx((opts) => {
    calls.push(opts);
    return Promise.resolve({ result: { ok: true, data: { pong: true } } });
  });
  const data = await api.call('system.ping', { a: 1 });
  assert.deepStrictEqual(data, { pong: true });
  assert.deepStrictEqual(calls[0], { name: 'api', data: { action: 'system.ping', payload: { a: 1 } } });
});

test('call: 不传 payload 时补空对象，避免云端拿到 undefined', async () => {
  let sent;
  stubWx((opts) => {
    sent = opts.data;
    return Promise.resolve({ result: { ok: true, data: null } });
  });
  await api.call('home.get');
  assert.deepStrictEqual(sent, { action: 'home.get', payload: {} });
});

test('call: 响应不是 {ok:boolean} 时抛 EMPTY_RESPONSE', async () => {
  for (const result of [null, {}, { data: 1 }, { ok: 'yes' }]) {
    stubWx(() => Promise.resolve({ result }));
    await assert.rejects(() => api.call('x'), (err) => {
      assert.ok(err instanceof api.ApiError);
      assert.strictEqual(err.code, 'EMPTY_RESPONSE');
      assert.strictEqual(err.message, '服务没有正常响应，稍后再试');
      return true;
    });
  }
});

test('call: 云函数返回空响应（res 为 null/undefined/无 result）时按 EMPTY_RESPONSE 处理，不抛 TypeError', async () => {
  for (const res of [null, undefined, {}]) {
    stubWx(() => Promise.resolve(res));
    await assert.rejects(() => api.call('x'), (err) => {
      assert.ok(err instanceof api.ApiError);
      assert.strictEqual(err.code, 'EMPTY_RESPONSE');
      return true;
    });
  }
});

test('call: 业务错误缺 code/message 时 ApiError 用兜底 code 与文案', async () => {
  stubWx(() => Promise.resolve({ result: { ok: false } }));
  await assert.rejects(() => api.call('x'), (err) => {
    assert.strictEqual(err.code, 'UNKNOWN');
    assert.strictEqual(err.message, '服务开小差了，稍后再试');
    assert.strictEqual(err.requestId, '');
    return true;
  });
});

test('call: 业务失败抛 ApiError，保留 code/message/requestId', async () => {
  stubWx(() => Promise.resolve({ result: { ok: false, code: 'BIND_RATE_LIMITED', message: '试得太频繁了', requestId: 'r1' } }));
  await assert.rejects(() => api.call('bind.preview'), (err) => {
    assert.strictEqual(err.code, 'BIND_RATE_LIMITED');
    assert.strictEqual(err.message, '试得太频繁了');
    assert.strictEqual(err.requestId, 'r1');
    return true;
  });
});

test('call: 云函数调用失败的 errMsg 映射成 NETWORK_ERROR', async () => {
  stubWx(() => Promise.reject({ errMsg: 'cloud.callFunction:fail network error' }));
  await assert.rejects(() => api.call('x'), (err) => {
    assert.strictEqual(err.code, 'NETWORK_ERROR');
    assert.strictEqual(err.message, '网络不太好，稍后再试');
    return true;
  });
});

test('call: 网络失败没有 errMsg 时（字符串/空对象 reject）也归一成 NETWORK_ERROR', async () => {
  for (const failure of ['cloud.callFunction:fail', null, {}]) {
    stubWx(() => Promise.reject(failure));
    await assert.rejects(() => api.call('x'), (err) => {
      assert.strictEqual(err.code, 'NETWORK_ERROR');
      assert.strictEqual(err.message, '网络不太好，稍后再试');
      return true;
    });
  }
});

test('call: 超时归入 NETWORK_ERROR，但文案区分「网络有点慢」', async () => {
  // errMsg 与 message 两种字段都要能识别（云函数失败一般给 errMsg，普通 Error 只有 message）
  const failures = [{ errMsg: 'cloud.callFunction:fail timeout' }, { errMsg: '请求超时' }, { message: 'request:fail timeout' }];
  for (const failure of failures) {
    stubWx(() => Promise.reject(failure));
    await assert.rejects(() => api.call('x'), (err) => {
      assert.strictEqual(err.code, 'NETWORK_ERROR');
      assert.strictEqual(err.message, '网络有点慢，稍后再试');
      return true;
    });
  }
});

test('call: 抛出 ApiError 时原样透传，不再包一层 NETWORK_ERROR', async () => {
  stubWx(() => Promise.reject(new api.ApiError('UNAUTHORIZED', '无法识别当前用户', 'r2')));
  await assert.rejects(() => api.call('x'), (err) => {
    assert.strictEqual(err.code, 'UNAUTHORIZED');
    assert.strictEqual(err.requestId, 'r2');
    return true;
  });
});

test('showError: 用 toast 展示错误文案，无错误时给兜底文案', () => {
  stubWx(() => Promise.resolve());
  api.showError(new api.ApiError('X', '邀请码过期了', ''));
  assert.strictEqual(global.__lastToast.title, '邀请码过期了');
  assert.strictEqual(global.__lastToast.icon, 'none');
  assert.strictEqual(global.__lastToast.duration, 2200);
  api.showError(null);
  assert.strictEqual(global.__lastToast.title, '服务开小差了，稍后再试');
});
