/** 文本截断，超出用省略号 */
function truncate(text, max) {
  const str = text == null ? '' : String(text);
  if (!max || str.length <= max) return str;
  return str.slice(0, max - 1) + '…';
}

/** 愿望完成百分比，0–100 整数 */
function wishPercent(done, total) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

module.exports = { truncate, wishPercent };
