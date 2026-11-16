'use strict';

const test = require('node:test');
const assert = require('node:assert');

const mini = require('../miniprogram/utils/time');

// M5 门牌文案（文档 9.10）：最近一次报平安要显示成「刚刚 / N 分钟前 / N 小时前 / 昨天 / 11月14日」
// NOW 固定为东八区 2026-11-16 14:30（UTC 06:30），避免用例随本机时间漂移。
const NOW = Date.parse('2026-11-16T06:30:00.000Z');
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

test('formatAgo: 空值与非法值返回空串', () => {
  assert.strictEqual(mini.formatAgo('', NOW), '');
  assert.strictEqual(mini.formatAgo(null, NOW), '');
  assert.strictEqual(mini.formatAgo('not-a-date', NOW), '');
});

test('formatAgo: 一分钟内是「刚刚」，之后按分钟、小时递减', () => {
  assert.strictEqual(mini.formatAgo(iso(30 * 1000), NOW), '刚刚');
  assert.strictEqual(mini.formatAgo(iso(59 * 60 * 1000), NOW), '59 分钟前');
  assert.strictEqual(mini.formatAgo(iso(60 * 60 * 1000), NOW), '1 小时前');
  assert.strictEqual(mini.formatAgo(iso(3 * 60 * 60 * 1000), NOW), '3 小时前');
});

test('formatAgo: 昨天显示「昨天」，更早显示月日', () => {
  // 东八区 2026-11-15 22:00 = UTC 14:00，早于今天但只隔一天
  assert.strictEqual(mini.formatAgo('2026-11-15T14:00:00.000Z', NOW), '昨天');
  // 东八区 2026-11-12 09:00 = UTC 01:00
  assert.strictEqual(mini.formatAgo('2026-11-12T01:00:00.000Z', NOW), '11月12日');
});

test('formatAgo: 跨零点时分钟/小时优先于「昨天」', () => {
  // 东八区 2026-11-16 00:10，对方 23:50 报平安 → 20 分钟前（可接受的展示口径）
  const nowMs = Date.parse('2026-11-15T16:10:00.000Z');
  assert.strictEqual(mini.formatAgo('2026-11-15T15:50:00.000Z', nowMs), '20 分钟前');
});

test('formatAgo: 缺省 now 用当前时间也能给出非空文案', () => {
  const ago = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  assert.strictEqual(mini.formatAgo(ago), '5 分钟前');
});
