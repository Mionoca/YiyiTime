'use strict';

const test = require('node:test');
const assert = require('node:assert');

const api = require('../miniprogram/utils/api');
const me = require('../miniprogram/utils/me');

let calls;
function stubUser(res) {
  calls = 0;
  api.call = () => {
    calls += 1;
    return typeof res === 'function' ? res() : Promise.resolve(res);
  };
}

test('getMe: 会话内只请求一次，后续复用缓存', async () => {
  me.clearMe();
  stubUser({ user: { openid: 'oA', nickname: '小怡' } });
  const first = await me.getMe();
  const second = await me.getMe();
  assert.deepStrictEqual(first, { openid: 'oA', nickname: '小怡' });
  assert.strictEqual(second, first);
  assert.strictEqual(calls, 1);
});

test('getMe: 并发调用共用同一个 promise，不会打两次接口', async () => {
  me.clearMe();
  stubUser({ user: { openid: 'oA' } });
  const [a, b] = await Promise.all([me.getMe(), me.getMe()]);
  assert.deepStrictEqual(a, { openid: 'oA' });
  assert.strictEqual(a, b);
  assert.strictEqual(calls, 1);
});

test('getMe: 返回空用户时不当成有效缓存，下次仍会重试', async () => {
  me.clearMe();
  stubUser({ user: null });
  assert.strictEqual(await me.getMe(), null);
  assert.strictEqual(calls, 1);
  stubUser({ user: { openid: 'oB' } });
  assert.deepStrictEqual(await me.getMe(), { openid: 'oB' });
  assert.strictEqual(calls, 1);
});

test('getMe: 失败不缓存，再次调用会重新请求', async () => {
  me.clearMe();
  let fail = true;
  stubUser(() => (fail ? Promise.reject(new Error('network')) : Promise.resolve({ user: { openid: 'oC' } })));
  await assert.rejects(() => me.getMe(), /network/);
  fail = false;
  assert.deepStrictEqual(await me.getMe(), { openid: 'oC' });
  assert.strictEqual(calls, 2);
});

test('clearMe: 主动作废缓存，资料修改后能拿到新值', async () => {
  me.clearMe();
  stubUser({ user: { openid: 'oA', nickname: '旧昵称' } });
  assert.strictEqual((await me.getMe()).nickname, '旧昵称');
  me.clearMe();
  stubUser({ user: { openid: 'oA', nickname: '新昵称' } });
  assert.strictEqual((await me.getMe()).nickname, '新昵称');
  assert.strictEqual(calls, 1);
});
