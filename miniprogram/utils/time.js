/**
 * 客户端时间只做展示；所有业务时间规则（今天/第几天/解锁）以服务端为准。
 * 但展示用的日期/时刻统一按东八区换算，避免设备时区不同导致「今天」与服务端不一致。
 */
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/** 把任意时刻平移到东八区，之后用 getUTC* 读取就是东八区的年月日时分 */
function shifted(d) {
  return new Date(d.getTime() + TZ_OFFSET_MS);
}

/** 任意时刻 → 东八区 YYYY-MM-DD */
function dateKeyOf(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const s = shifted(d);
  return s.getUTCFullYear() + '-' + pad2(s.getUTCMonth() + 1) + '-' + pad2(s.getUTCDate());
}

/** ISO 时间 → 「今天 HH:mm」或「MM-DD HH:mm」（东八区） */
function formatTime(iso, todayKey) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const s = shifted(d);
  const hm = pad2(s.getUTCHours()) + ':' + pad2(s.getUTCMinutes());
  if (todayKey && dateKeyOf(d) === todayKey) return '今天 ' + hm;
  return pad2(s.getUTCMonth() + 1) + '-' + pad2(s.getUTCDate()) + ' ' + hm;
}

/** YYYY-MM-DD → 2026年11月15日 */
function formatDateCN(dateKey) {
  if (!dateKey) return '';
  const parts = String(dateKey).split('-');
  if (parts.length !== 3) return dateKey;
  return parts[0] + '年' + Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

/** YYYY-MM-DD → 11月15日 */
function formatMonthDay(dateKey) {
  if (!dateKey) return '';
  const parts = String(dateKey).split('-');
  if (parts.length !== 3) return dateKey;
  return Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

/** 东八区的今天（用于日期选择器默认值/上限） */
function todayKey() {
  return dateKeyOf(new Date());
}

module.exports = { dateKeyOf, formatTime, formatDateCN, formatMonthDay, todayKey };
