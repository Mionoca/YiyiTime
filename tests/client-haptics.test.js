'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx } = require('./helpers/client-page');

/**
 * 轻振动（文档 8.9：只用于抱抱 / 报平安成功，且可关闭）。
 * 工具必须对「没有 vibrateShort 的基础库」「storage 抛错」「振动本身失败」保持静默。
 */
const haptics = require('../miniprogram/utils/haptics');

test('haptics: 默认开启，light 调 vibrateShort(type=light)', () => {
  const calls = [];
  installWx({ vibrateShort: (opts) => calls.push(opts) });
  try {
    assert.strictEqual(haptics.isEnabled(), true);
    haptics.light();
    assert.deepStrictEqual(calls.map((c) => c.type), ['light']);
    // 必须带 fail 兜底，否则部分机型振动失败时会在控制台报未处理错误
    assert.strictEqual(typeof calls[0].fail, 'function');
  } finally {
    restoreWx();
  }
});

test('haptics: setEnabled(false) 后不再振动，并写入本地开关', () => {
  const calls = [];
  const stored = {};
  installWx({
    vibrateShort: (opts) => calls.push(opts),
    getStorageSync: (key) => stored[key],
    setStorageSync: (key, value) => {
      stored[key] = value;
    },
  });
  try {
    haptics.setEnabled(false);
    assert.strictEqual(stored[haptics.STORAGE_KEY], false);
    assert.strictEqual(haptics.isEnabled(), false);
    haptics.light();
    assert.deepStrictEqual(calls, []);
    haptics.setEnabled(true);
    haptics.light();
    assert.deepStrictEqual(calls.map((c) => c.type), ['light']);
    // 必须带 fail 兜底，否则部分机型振动失败时会在控制台报未处理错误
    assert.strictEqual(typeof calls[0].fail, 'function');
  } finally {
    restoreWx();
  }
});

test('haptics: 没有 vibrateShort 的基础库静默跳过', () => {
  installWx({});
  try {
    assert.doesNotThrow(() => haptics.light());
  } finally {
    restoreWx();
  }
});

test('haptics: vibrateShort 抛错或 storage 读失败都不影响业务', () => {
  const calls = [];
  installWx({
    getStorageSync: () => {
      throw new Error('storage down');
    },
    vibrateShort: (opts) => calls.push(opts),
  });
  try {
    assert.strictEqual(haptics.isEnabled(), true);
    assert.doesNotThrow(() => haptics.setEnabled(false));
    assert.doesNotThrow(() => haptics.light());
    assert.deepStrictEqual(calls.map((c) => c.type), ['light']);
    // 必须带 fail 兜底，否则部分机型振动失败时会在控制台报未处理错误
    assert.strictEqual(typeof calls[0].fail, 'function');
  } finally {
    restoreWx();
  }

  installWx({
    vibrateShort: () => {
      throw new Error('vibrate down');
    },
  });
  try {
    assert.doesNotThrow(() => haptics.light());
  } finally {
    restoreWx();
  }
});

test('haptics: 只有显式存过 false 才关闭，未存过 / null / 空串都按默认开', () => {
  const calls = [];
  for (const stored of [undefined, null, '']) {
    installWx({ getStorageSync: () => stored, vibrateShort: (opts) => calls.push(opts) });
    try {
      assert.strictEqual(haptics.isEnabled(), true, '未存过应默认开：' + String(stored));
      haptics.light();
    } finally {
      restoreWx();
    }
  }
  assert.deepStrictEqual(calls.map((c) => c.type), ['light', 'light', 'light']);
  installWx({ getStorageSync: () => false, vibrateShort: (opts) => calls.push(opts) });
  try {
    assert.strictEqual(haptics.isEnabled(), false);
    haptics.light();
  } finally {
    restoreWx();
  }
  assert.strictEqual(calls.length, 3, '显式 false 时不振动');
});

test('haptics: 本地写失败返回 false，调用方才能回滚开关显示', () => {
  installWx({
    setStorageSync: () => {
      throw new Error('storage full');
    },
  });
  try {
    assert.strictEqual(haptics.setEnabled(false), false);
    assert.strictEqual(haptics.isEnabled(), true, '没写进去就不该变成关闭');
  } finally {
    restoreWx();
  }
});