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

module.exports = { truncate, wishRatio };
