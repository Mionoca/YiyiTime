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

/** 在一起第几天；startDate 当天为 1；日期不合法返回 null（调用方负责降级） */
function daysTogether(startDate, todayKey) {
  if (!isValidDateKey(startDate) || !isValidDateKey(todayKey)) return null;
  return Math.floor((startOfDateKey(todayKey) - startOfDateKey(startDate)) / DAY_MS) + 1;
}

/** 某天日记的解锁时刻：次日 00:00 +08 */
function nextUnlockAt(dateKey) {
  return new Date(startOfDateKey(dateKey).getTime() + DAY_MS);
}

/** 任意时刻 → 东八区 HH:mm（提醒时间用；定长字符串，字典序即时间序） */
function hhmmOf(input = new Date()) {
  const d = new Date(input.getTime() + TZ_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 严格校验 HH:mm（00:00–23:59），接受 '9:00' 这种不补零写法并归一化为 '09:00' */
function normalizeHhmm(value) {
  if (typeof value !== 'string') return '';
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return '';
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return '';
  return `${pad2(h)}:${pad2(mm)}`;
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

/** 下一个纪念日；2 月 29 日按当年 2 月最后一天处理；日期不合法返回 null */
function nextAnniversary(startDate, todayKey) {
  if (!isValidDateKey(startDate) || !isValidDateKey(todayKey)) return null;
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

/**
 * 任意纪念日的下一次发生（自定义纪念日，文档 5.3.5 / 7.7）：
 * - `date` 在今天之后：直接返回它自己，`years = 0`（第一次还没到）；
 * - 今天或已过去：取本年同月同日；本年已过去则取明年；
 * - 2 月 29 日在平年按当年 2 月最后一天算（与 nextAnniversary 同一规则）；
 * - 当天发生返回 `daysLeft = 0`，页面显示「就是今天」。
 */
function yearlyOccurrence(date, todayKey) {
  if (!isValidDateKey(date) || !isValidDateKey(todayKey)) return null;
  if (date >= todayKey) {
    return {
      date,
      daysLeft: Math.round((startOfDateKey(date) - startOfDateKey(todayKey)) / DAY_MS),
      years: 0,
    };
  }

  const [sy, sm, sd] = date.split('-').map(Number);
  const [ty] = todayKey.split('-').map(Number);
  for (let y = ty; y <= ty + 1; y += 1) {
    const day = Math.min(sd, daysInMonth(y, sm));
    const key = `${y}-${pad2(sm)}-${pad2(day)}`;
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
function isValidDateKey(key) {  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
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
  hhmmOf,
  normalizeHhmm,
  phaseOf,
  nextAnniversary,
  yearlyOccurrence,
  isValidDateKey,
  isValidStartDate,
};
