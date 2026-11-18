'use strict';

const test = require('node:test');
const assert = require('node:assert');

const time = require('../cloudfunctions/api/lib/time');

test('dateKeyOf: 东八区跨日', () => {
  assert.strictEqual(time.dateKeyOf(new Date('2026-11-15T16:00:00.000Z')), '2026-11-16');
  assert.strictEqual(time.dateKeyOf(new Date('2026-11-15T15:59:59.000Z')), '2026-11-15');
  assert.strictEqual(time.dateKeyOf(new Date('2026-01-01T00:00:00.000Z')), '2026-01-01');
});

test('startOfDateKey: 东八区 00:00 对应 UTC 前一日 16:00', () => {
  assert.strictEqual(
    time.startOfDateKey('2026-11-15').toISOString(),
    '2026-11-14T16:00:00.000Z'
  );
});

test('addDays: 跨月 / 跨年 / 闰年', () => {
  assert.strictEqual(time.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(time.addDays('2024-02-28', 1), '2024-02-29');
  assert.strictEqual(time.addDays('2024-02-29', 1), '2024-03-01');
  assert.strictEqual(time.addDays('2026-11-15', -1), '2026-11-14');
});

test('daysTogether: 开始当天算第 1 天', () => {
  assert.strictEqual(time.daysTogether('2026-11-15', '2026-11-15'), 1);
  assert.strictEqual(time.daysTogether('2026-11-14', '2026-11-15'), 2);
  assert.strictEqual(time.daysTogether('2024-05-20', '2025-05-20'), 366);
  assert.strictEqual(time.daysTogether('2025-12-31', '2026-01-01'), 2);
});

test('nextUnlockAt: 次日 00:00 +08', () => {
  assert.strictEqual(
    time.nextUnlockAt('2026-11-15').toISOString(),
    '2026-11-15T16:00:00.000Z'
  );
});

test('phaseOf: 6/9/17/20 分档边界', () => {
  const cases = [
    ['2026-11-15T21:59:00.000Z', 'night'], // 05:59 +08
    ['2026-11-15T22:00:00.000Z', 'morning'], // 06:00
    ['2026-11-16T00:59:00.000Z', 'morning'], // 08:59
    ['2026-11-16T01:00:00.000Z', 'day'], // 09:00
    ['2026-11-16T08:59:00.000Z', 'day'], // 16:59
    ['2026-11-16T09:00:00.000Z', 'dusk'], // 17:00
    ['2026-11-16T11:59:00.000Z', 'dusk'], // 19:59
    ['2026-11-16T12:00:00.000Z', 'night'], // 20:00
  ];
  for (const [iso, expected] of cases) {
    assert.strictEqual(time.phaseOf(new Date(iso)), expected, iso);
  }
});

test('nextAnniversary: 文档示例', () => {
  assert.deepStrictEqual(time.nextAnniversary('2024-05-20', '2026-11-15'), {
    date: '2027-05-20',
    daysLeft: 186,
    years: 3,
  });
  assert.deepStrictEqual(time.nextAnniversary('2024-05-20', '2026-05-20'), {
    date: '2026-05-20',
    daysLeft: 0,
    years: 2,
  });
});

test('nextAnniversary: 当天/跨年/开始那天不算', () => {
  // 开始那天（2 月 29 日）当年没有 2 月 29 日时按当月最后一天
  assert.deepStrictEqual(time.nextAnniversary('2020-02-29', '2026-02-28'), {
    date: '2026-02-28',
    daysLeft: 0,
    years: 6,
  });
  assert.deepStrictEqual(time.nextAnniversary('2020-02-29', '2026-03-01'), {
    date: '2027-02-28',
    daysLeft: 364,
    years: 7,
  });
  // 正好在开始那天：明年的今天
  assert.deepStrictEqual(time.nextAnniversary('2024-05-20', '2024-05-20'), {
    date: '2025-05-20',
    daysLeft: 365,
    years: 1,
  });
  // 开始于 2-29、平年 2-28 当天：就是今天
  assert.deepStrictEqual(time.nextAnniversary('2024-02-29', '2025-02-28'), {
    date: '2025-02-28',
    daysLeft: 0,
    years: 1,
  });
  // 12-31 的下一个纪念日是次年 12-31
  assert.deepStrictEqual(time.nextAnniversary('2024-12-31', '2026-11-15'), {
    date: '2026-12-31',
    daysLeft: 46,
    years: 2,
  });
});

test('isValidDateKey: 严格校验真实日期', () => {
  assert.strictEqual(time.isValidDateKey('2024-02-29'), true);
  assert.strictEqual(time.isValidDateKey('2023-02-29'), false);
  assert.strictEqual(time.isValidDateKey('2026-13-01'), false);
  assert.strictEqual(time.isValidDateKey('2026-1-1'), false);
  assert.strictEqual(time.isValidDateKey(''), false);
  assert.strictEqual(time.isValidDateKey(null), false);
});

test('isValidStartDate: 2000-01-01 至今天', () => {
  const todayKey = '2026-11-15';
  assert.strictEqual(time.isValidStartDate('1999-12-31', todayKey), false);
  assert.strictEqual(time.isValidStartDate('2000-01-01', todayKey), true);
  assert.strictEqual(time.isValidStartDate('2026-11-15', todayKey), true);
  assert.strictEqual(time.isValidStartDate('2026-11-16', todayKey), false);
});

test('toMillis: Date / ISO 字符串 / 时间戳 / 对象 / 非法值', () => {
  const d = new Date('2026-11-15T04:00:00.000Z');
  assert.strictEqual(time.toMillis(d), d.getTime());
  assert.strictEqual(time.toMillis('2026-11-15T04:00:00.000Z'), d.getTime());
  assert.strictEqual(time.toMillis(d.getTime()), d.getTime());
  assert.strictEqual(time.toMillis({ getTime: () => 123 }), 123);
  assert.ok(Number.isNaN(time.toMillis(null)));
  assert.ok(Number.isNaN(time.toMillis('not-a-date')));
});
test('daysTogether / nextAnniversary: 非法或缺失日期返回 null，不抛也不产生 NaN（脏 startDate 降级）', () => {
  assert.strictEqual(time.daysTogether(undefined, '2026-11-16'), null);
  assert.strictEqual(time.daysTogether('garbage', '2026-11-16'), null);
  assert.strictEqual(time.daysTogether(12345, '2026-11-16'), null);
  assert.strictEqual(time.daysTogether('2026-11-10', '2026-13-01'), null);
  // 合法输入仍然正常，确认防御没把正常路径关掉
  assert.strictEqual(time.daysTogether('2026-11-10', '2026-11-16'), 7);
  assert.strictEqual(time.nextAnniversary(undefined, '2026-11-16'), null);
  assert.strictEqual(time.nextAnniversary('garbage', '2026-11-16'), null);
  assert.strictEqual(time.nextAnniversary('2026-11-10', null), null);
  assert.deepStrictEqual(time.nextAnniversary('2026-11-10', '2026-11-16'), {
    date: '2027-11-10', daysLeft: 359, years: 1,
  });
});


test('yearlyOccurrence: 当天 / 明天 / 已过去 / 未来日期（文档 6.7 / 7.7）', () => {
  const today = '2026-11-16';
  // 当天就是纪念日：daysLeft 0，years 按年差
  assert.deepStrictEqual(time.yearlyOccurrence('2023-11-16', today), {
    date: '2026-11-16', daysLeft: 0, years: 3,
  });
  // 明天
  assert.deepStrictEqual(time.yearlyOccurrence('2020-11-17', today), {
    date: '2026-11-17', daysLeft: 1, years: 6,
  });
  // 今年已过去 → 明年
  assert.deepStrictEqual(time.yearlyOccurrence('2019-01-01', today), {
    date: '2027-01-01', daysLeft: 46, years: 8,
  });
  // 未来日期：直接返回自己，years 为 0（第一次还没到）
  assert.deepStrictEqual(time.yearlyOccurrence('2027-05-20', today), {
    date: '2027-05-20', daysLeft: 185, years: 0,
  });
});

test('yearlyOccurrence: 2 月 29 日在平年按 2 月最后一天；非法日期返回 null', () => {
  assert.deepStrictEqual(time.yearlyOccurrence('2024-02-29', '2027-02-10'), {
    date: '2027-02-28', daysLeft: 18, years: 3,
  });
  assert.strictEqual(time.yearlyOccurrence('garbage', '2026-11-16'), null);
  assert.strictEqual(time.yearlyOccurrence('2026-11-16', null), null);
});
