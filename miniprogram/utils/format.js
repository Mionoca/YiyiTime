/** 文本截断，超出用省略号 */
function truncate(text, max) {
  const str = text == null ? '' : String(text);
  if (!max || str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

/**
 * 愿望完成比例 0–1，用于 transform: scaleX() 进度条（8.9 只允许 transform/opacity 动画）。
 * 保留 4 位小数，避免 setData 字符串抖动。
 */
function wishRatio(done, total) {
  if (!total || total <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, done / total));
  return Math.round(ratio * 10000) / 10000;
}

/**
 * 金额（整数分）→ 「¥12.50」。记账本全程以分为单位传输（文档 1.5），只在展示层换算；
 * 非法值按 0 处理、非整数分（脏数据）四舍五入，宁可显示一个近似值也不整页 NaN。
 */
function formatYuan(cents) {
  const n = typeof cents === 'number' && isFinite(cents) ? Math.round(cents) : 0;
  const abs = Math.abs(n);
  const yuan = Math.floor(abs / 100);
  const rest = abs % 100;
  return (n < 0 ? '-¥' : '¥') + yuan + '.' + (rest < 10 ? '0' + rest : String(rest));
}

/**
 * 用户输入的「元」→ 整数分；格式不对返回 null。
 * 只接受最多两位小数的正数写法（12 / 12.5 / 12.50），不做四舍五入，避免「输入 12.345 存成 12.35」
 * 这种用户看不出来的静默改动。范围校验交给调用方（LIMITS.ledgerAmountMin/Max）。
 */
function parseYuan(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const parts = raw.split('.');
  const yuan = Number(parts[0]);
  // 超过 10 亿的输入直接判非法：JS 大数会丢精度，算出来的分没有意义
  if (!isFinite(yuan) || yuan > 1000000000) return null;
  const fraction = parts[1] ? Number((parts[1] + '00').slice(0, 2)) : 0;
  return yuan * 100 + fraction;
}

module.exports = { truncate, wishRatio, formatYuan, parseYuan };
