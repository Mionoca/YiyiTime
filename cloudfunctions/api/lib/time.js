'use strict';

/**
 * 服务端唯一时间实现：所有「今天 / 第几天 / 纪念日 / 解锁时刻」都从这里取。
 * 云函数运行环境时区是 UTC，因此这里显式换算东八区，禁止用本地时区 API。
 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000; // 东八区
const DAY_MS = 24 * 60 * 60 * 1000;

const pad2 = (n) => String(n).padStart(2, '0');

/** 任意时刻 → 东八区 YYYY-MM-DD */
function dateKeyOf(input = new Date()) {
  const d = new Date(input.getTime() + TZ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** YYYY-MM-DD 的东八区 00:00 对应的 UTC Date */
function startOfDateKey(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - TZ_OFFSET_MS);
}

/** 日期加减，返回 YYYY-MM-DD */
function addDays(dateKey, n) {
  const start = startOfDateKey(dateKey);
  return dateKeyOf(new Date(start.getTime() + n * DAY_MS));
}

/** 在一起第几天；startDate 当天为 1 */
function daysTogether(startDate, todayKey) {
  return Math.floor((startOfDateKey(todayKey) - startOfDateKey(startDate)) / DAY_MS) + 1;
}

/** 某天日记的解锁时刻：次日 00:00 +08 */
function nextUnlockAt(dateKey) {
  return new Date(startOfDateKey(dateKey).getTime() + DAY_MS);
}

/** 首页氛围：morning / day / dusk / night */
function phaseOf(now = new Date()) {
  const d = new Date(now.getTime() + TZ_OFFSET_MS);
  const h = d.getUTCHours();
  if (h >= 6 && h < 9) return 'morning';
  if (h >= 9 && h < 17) return 'day';
  if (h >= 17 && h < 20) return 'dusk';
  return 'night';
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 下一个纪念日；2 月 29 日按当年 2 月最后一天处理 */
function nextAnniversary(startDate, todayKey) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ty] = todayKey.split('-').map(Number);

  for (let y = ty; y <= ty + 1; y += 1) {
    const day = Math.min(sd, daysInMonth(y, sm));
    const key = `${y}-${pad2(sm)}-${pad2(day)}`;
    if (key === startDate) continue; // 开始那天不算纪念日
    if (key >= todayKey) {
      return {
        date: key,
        daysLeft: Math.round((startOfDateKey(key) - startOfDateKey(todayKey)) / DAY_MS),
        years: y - sy,
      };
    }
  }
  return null;
}

/** 严格校验 YYYY-MM-DD 是真实存在的日期 */
function isValidDateKey(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** startDate 允许 2000-01-01 至今天 */
function isValidStartDate(key, todayKey) {
  return isValidDateKey(key) && key >= '2000-01-01' && key <= todayKey;
}

/** Date / ISO 字符串 / 时间戳 → 毫秒；非法返回 NaN（云数据库日期可能是 Date、字符串或对象） */
function toMillis(value) {
  if (!value) return NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'object' && typeof value.getTime === 'function') return value.getTime();
  return new Date(value).getTime();
}

module.exports = {
  TZ_OFFSET_MS,
  DAY_MS,
  toMillis,
  dateKeyOf,
  startOfDateKey,
  addDays,
  daysTogether,
  nextUnlockAt,
  phaseOf,
  nextAnniversary,
  isValidDateKey,
  isValidStartDate,
};
