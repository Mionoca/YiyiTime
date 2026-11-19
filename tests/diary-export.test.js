'use strict';

/**
 * 年度长图排版（M13 / 文档 8.3.3）——纯函数，不碰 wx API。
 * 这里锁三件容易回归的事：折行不丢字、按 8192px 上限分页、页面消费的字段形状。
 */
const test = require('node:test');
const assert = require('node:assert');

const poster = require('../miniprogram/utils/diary-export');

function item(date, content, extra) {
  return Object.assign({ date, content, moodScore: null, images: [] }, extra);
}

test('wrapText: 中文按全角折行，不丢字也不超宽', () => {
  const text = '今天'.repeat(60); // 120 个字
  const lines = poster.wrapText(text, 300, 6);
  assert.strictEqual(lines.length, 6, '超过 6 行要截断');
  assert.ok(lines[5].endsWith('…'), '截断行要以省略号收尾');
  // 每行宽度不超过给定宽度（30px 一个汉字 → 300 宽最多 10 个字）
  lines.slice(0, 5).forEach((line) => {
    assert.ok(line.length <= 10, '每行最多 10 个字：' + line);
  });
});

test('wrapText: 保留原文换行，英文按半角估算不浪费行', () => {
  const lines = poster.wrapText('第一段\n第二段', 300, 6);
  assert.deepStrictEqual(lines, ['第一段', '第二段']);

  // 同一段文字，全角要断行、半角不用：这是 8.3.3「英文日记不被过度折行」的依据
  const wide = poster.wrapText('abcdefghijklmnopqrstuvwxyz', 200, 6);
  assert.strictEqual(wide.length, 3, '半角约 17px/字，200px 一行放 11 个 → 3 行');
  assert.strictEqual(wide.join(''), 'abcdefghijklmnopqrstuvwxyz', '断行不能丢字符');
  const narrow = poster.wrapText('abcdefghijklmnopqrstuvwxyz', 600, 6);
  assert.strictEqual(narrow.length, 1, '600px 能装下 26 个半角字符');
  assert.strictEqual(narrow[0], 'abcdefghijklmnopqrstuvwxyz');
});

test('wrapText: 空内容与 null 不炸，返回空数组', () => {
  assert.deepStrictEqual(poster.wrapText('', 300, 6), []);
  assert.deepStrictEqual(poster.wrapText(null, 300, 6), []);
  assert.deepStrictEqual(poster.wrapText('   \n  ', 300, 6), [], '纯空白不留空行');
});

test('buildPoster: 按月分组、按日期升序、标题带昵称与年份', () => {
  const data = poster.buildPoster({
    year: 2026,
    nickname: '小怡',
    items: [
      item('2026-11-19', '今天很好'),
      item('2026-03-02', '三月的事'),
      item('2026-11-18', '昨天', { moodScore: 4 }),
    ],
  });
  assert.strictEqual(data.width, 750);
  assert.strictEqual(data.header.title, '小怡 的 2026 年手帐');
  assert.strictEqual(data.header.subtitle, '3 篇 · 2 个月');
  assert.deepStrictEqual(data.months.map((m) => m.month), ['2026-03', '2026-11'], '月份升序');
  // 同月内按日期升序
  assert.deepStrictEqual(data.months[1].entries.map((e) => e.date), ['2026-11-18', '2026-11-19']);
  assert.strictEqual(data.months[1].entries[0].moodText, '心情 4 · 不错');
  assert.strictEqual(data.months[1].entries[0].dateText, '11月18日');
});

test('buildPoster: 昵称缺失回落「我」，非法日期条目被丢掉', () => {
  const data = poster.buildPoster({
    year: 2026,
    items: [item('2026-11-19', '正常'), item('bad', '坏数据'), null, { content: '没有日期' }],
  });
  assert.strictEqual(data.header.title, '我 的 2026 年手帐');
  assert.strictEqual(data.header.subtitle, '1 篇 · 1 个月');
});

test('buildPoster: 每页高度不超 8192，按月切开而不是溢出', () => {
  // 造一个「每天写满长文」的月份：单月就超过一页上限
  const items = [];
  for (let day = 1; day <= 30; day += 1) {
    items.push(item('2026-03-' + String(day).padStart(2, '0'), '很长的一段日记'.repeat(40)));
  }
  const data = poster.buildPoster({ year: 2026, items });
  assert.ok(data.pageCount > 1, '单月超限要自动分页');
  data.pages.forEach((page) => {
    assert.ok(page.height <= poster.MAX_PAGE_H, '每页高度必须在 8192 以内：' + page.height);
    assert.ok(page.months.length > 0, '每一页都要有内容');
  });
  // 条目总数守恒：分页不能把日记切丢
  const total = data.pages.reduce((sum, page) => sum
    + page.months.reduce((s, month) => s + month.entries.length, 0), 0);
  assert.strictEqual(total, 30);
});

test('buildPoster: 跨月正好卡在页尾时不产生空白页', () => {
  const items = [];
  for (let month = 1; month <= 12; month += 1) {
    items.push(item('2026-' + String(month).padStart(2, '0') + '-01', '一个月一句'));
  }
  const data = poster.buildPoster({ year: 2026, items });
  assert.strictEqual(data.pageCount, 1, '12 条短日记应该一页装下');
  assert.strictEqual(data.months.length, 12);
  data.pages[0].months.forEach((month) => {
    assert.ok(month.entries.length > 0, '短日记不按月切页，也不产生空块');
  });
});
