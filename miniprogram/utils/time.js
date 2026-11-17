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

/** ISO 时间 → HH:mm（东八区）；日期已经单独展示时用，避免重复 */
function formatHM(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const s = shifted(d);
  return pad2(s.getUTCHours()) + ':' + pad2(s.getUTCMinutes());
}

/** YYYY-MM-DD 加减天数（只用于「昨天」这类相对日期展示，业务日期仍以服务端为准） */
function shiftDateKey(dateKey, delta) {
  const parts = String(dateKey || '').split('-');
  if (parts.length !== 3) return '';
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  // 先做日历合法性校验：2026-02-30 / 2026-13-01 这类输入不能被 Date 静默归一化
  if (!(y >= 1970 && y <= 9999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return '';
  const base = Date.UTC(y, m - 1, d);
  const probe = new Date(base);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return '';
  const shiftedDay = new Date(base + Number(delta) * 86400000);
  if (isNaN(shiftedDay.getTime())) return '';
  return shiftedDay.getUTCFullYear() + '-' + pad2(shiftedDay.getUTCMonth() + 1) + '-' + pad2(shiftedDay.getUTCDate());
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

/** 最近一次发生的时刻 → 短文案（门牌等窄标签用）：刚刚 / N 分钟前 / N 小时前 / 昨天 / 11月14日 */
function formatAgo(iso, nowMs) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date(Number.isFinite(nowMs) ? nowMs : Date.now());
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  const day = dateKeyOf(d);
  if (day === dateKeyOf(now)) return Math.floor(diff / 3600000) + ' 小时前';
  if (day === dateKeyOf(new Date(now.getTime() - 86400000))) return '昨天';
  return formatMonthDay(day);
}

/** 东八区的今天（用于日期选择器默认值/上限） */
function todayKey() {
  return dateKeyOf(new Date());
}

module.exports = {
  dateKeyOf, formatTime, formatHM, shiftDateKey, formatDateCN, formatMonthDay, formatAgo, todayKey,
};
