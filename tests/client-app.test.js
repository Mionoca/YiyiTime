'use strict';

// miniprogram/app.js 的启动分支：基础库不支持云能力、没配置 ENV_ID、初始化失败、正常初始化。
// 文档 11.6 要求「未配置时明确报错不白屏」，此前完全没有测试。
// 夹具会临时替换 Module._load 来模拟 config/env.js 存在/缺失，只在 require app.js 期间生效。
const test = require('node:test');
const assert = require('node:assert/strict');
const { installWx, restoreWx, loadApp } = require('./helpers/client-page');

function captureErrors(fn) {
  const logs = [];
  const original = console.error;
  console.error = (...args) => logs.push(args.join(' '));
  try {
    fn();
  } finally {
    console.error = original;
  }
  return logs;
}

test('基础库没有 wx.cloud：报错提示升级基础库，不初始化云能力', (t) => {
  t.after(restoreWx);
  installWx({});
  const config = loadApp();
  const logs = captureErrors(() => {
    config.onLaunch();
  });
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /2\.2\.3/);
  assert.strictEqual(config.globalData.envId, 'test-env-id');
});

test('本机没有 config/env.js：提示未配置环境 ID，不调用 wx.cloud.init', (t) => {
  t.after(restoreWx);
  const inits = [];
  installWx({ cloud: { init: (...args) => inits.push(args) } });
  const config = loadApp({ envMissing: true });
  const logs = captureErrors(() => {
    config.onLaunch();
  });
  assert.strictEqual(config.globalData.envId, '');
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /未配置云开发环境 ID/);
  assert.match(logs[0], /env\.example\.js/);
  assert.strictEqual(inits.length, 0);
});

test('env.js 存在但没有 ENV_ID：按未配置处理', (t) => {
  t.after(restoreWx);
  const inits = [];
  installWx({ cloud: { init: (...args) => inits.push(args) } });
  const config = loadApp({ env: {} });
  const logs = captureErrors(() => {
    config.onLaunch();
  });
  assert.strictEqual(config.globalData.envId, '');
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /未配置云开发环境 ID/);
  assert.strictEqual(inits.length, 0);
});

test('配置了 ENV_ID：初始化云能力并保留 globalData 初始值', (t) => {
  t.after(restoreWx);
  const inits = [];
  installWx({ cloud: { init: (options) => inits.push(options) } });
  const config = loadApp({ env: { ENV_ID: 'env-test-1' } });
  const logs = captureErrors(() => {
    config.onLaunch();
  });
  assert.deepStrictEqual(logs, []);
  assert.deepStrictEqual(inits, [{ env: 'env-test-1', traceUser: true }]);
  assert.deepStrictEqual(config.globalData, { envId: 'env-test-1', user: null, couple: null });
});

test('wx.cloud.init 抛错时不把异常抛给 onLaunch，只报错（11.6 不白屏）', (t) => {
  t.after(restoreWx);
  installWx({
    cloud: {
      init: () => {
        throw new Error('init boom');
      },
    },
  });
  const config = loadApp({ env: { ENV_ID: 'env-test-1' } });
  const logs = captureErrors(() => {
    config.onLaunch();
  });
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /云开发初始化失败/);
  assert.match(logs[0], /init boom/);
});

test('基础库的 cloud.init 不是函数时同样只报错不抛', (t) => {
  t.after(restoreWx);
  installWx({ cloud: { init: 'not-a-function' } });
  const config = loadApp({ env: { ENV_ID: 'env-test-1' } });
  const logs = captureErrors(() => {
    config.onLaunch();
  });
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /云开发初始化失败/);
});

test('config/env.js 写错（非「文件不存在」）时明确报错，不误报成未配置', (t) => {
  t.after(restoreWx);
  const inits = [];
  installWx({ cloud: { init: (...args) => inits.push(args) } });
  let config;
  const logs = captureErrors(() => {
    config = loadApp({ envError: new SyntaxError('Unexpected identifier') });
  });
  assert.strictEqual(logs.length, 1);
  assert.match(logs[0], /读取 config\/env\.js 失败/);
  assert.match(logs[0], /Unexpected identifier/);
  assert.strictEqual(config.globalData.envId, '');
  const launchLogs = captureErrors(() => {
    config.onLaunch();
  });
  assert.strictEqual(launchLogs.length, 1);
  assert.match(launchLogs[0], /未配置云开发环境 ID/);
  assert.strictEqual(inits.length, 0);
});

test('每次 require app.js 都重新读取 env 配置（换环境只需改 env.js）', (t) => {
  t.after(restoreWx);
  const inits = [];
  installWx({ cloud: { init: (options) => inits.push(options) } });
  const first = loadApp({ env: { ENV_ID: 'env-a' } });
  const second = loadApp({ env: { ENV_ID: 'env-b' } });
  captureErrors(() => {
    first.onLaunch();
    second.onLaunch();
  });
  assert.strictEqual(first.globalData.envId, 'env-a');
  assert.strictEqual(second.globalData.envId, 'env-b');
  assert.deepStrictEqual(inits, [
    { env: 'env-a', traceUser: true },
    { env: 'env-b', traceUser: true },
  ]);
});
