'use strict';

/**
 * 年度手帐长图排版（M13，文档 8.3.3 / 8.5）——纯函数，不调用任何 wx API，便于单测。
 *
 * 输入 `diary.archive` 的 items（只含自己的日记）与昵称，输出「画什么、画在哪」的指令：
 * 每一条日记折行后的文本、日期文案、分值文案、配图占位位置，以及按 8192px 上限切好的分页。
 * 真实字体测量在 canvas 绘制阶段做兜底截断，这里按字宽估算，保证测试可重复。
 */

const WIDTH = 750;
const MARGIN = 48;
const PAD = 22;
const HEADER_H = 232;
const MONTH_H = 76;
const DATE_H = 48;
const MOOD_H = 34;
const LINE_H = 40;
const GAP = 26;
const FOOTER_H = 96;
/** 单条最多画 6 行，长图不宜让一篇日记挤掉整月 */
const MAX_LINES = 6;
/** iOS canvas 高度上限，超过就分页出多张图 */
const MAX_PAGE_H = 8192;
const FONT_SIZE = 30;
const ELLIPSIS = '…';

const innerWidth = WIDTH - MARGIN * 2 - PAD * 2;
/** 中文按全角估算；ASCII 按半角，避免英文日记被过度折行 */
function charWidth(ch) {
  return ch.charCodeAt(0) > 255 ? FONT_SIZE : Math.round(FONT_SIZE * 0.55);
}

/** 逐字折行：保留原文换行，超宽才断行，行尾不丢字 */
function wrapText(text, maxWidth, maxLines) {
  const limit = maxWidth || innerWidth;
  const lineCap = maxLines || MAX_LINES;
  const raw = String(text == null ? '' : text).replace(/\r\n/g, '\n');
  const out = [];
  raw.split('\n').forEach((paragraph) => {
    let line = '';
    let width = 0;
    for (let i = 0; i < paragraph.length; i += 1) {
      const ch = paragraph.charAt(i);
      const w = charWidth(ch);
      if (width + w > limit && line) {
        out.push(line);
        line = ch;
        width = w;
      } else {
        line += ch;
        width += w;
      }
    }
    out.push(line);
  });
  // 去掉纯空行造成的尾部空行（含只有空格的段落），但保留段落之间的空行
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  if (out.length <= lineCap) return out;
  const clipped = out.slice(0, lineCap);
  clipped[lineCap - 1] = clipped[lineCap - 1].slice(0, Math.max(1, clipped[lineCap - 1].length - 1)) + ELLIPSIS;
  return clipped;
}

/** YYYY-MM-DD → 11月19日 */
function dayText(date) {
  const parts = String(date || '').split('-');
  if (parts.length !== 3) return String(date || '');
  return Number(parts[1]) + '月' + Number(parts[2]) + '日';
}

/** YYYY-MM → 2026年11月 */
function monthText(month) {
  const parts = String(month || '').split('-');
  if (parts.length !== 2) return String(month || '');
  return parts[0] + '年' + Number(parts[1]) + '月';
}

const MOOD_LABELS = { 1: '很低落', 2: '低落', 3: '一般', 4: '不错', 5: '很开心' };

function moodTextOf(score) {
  if (typeof score !== 'number' || !MOOD_LABELS[score]) return '';
  return '心情 ' + score + ' · ' + MOOD_LABELS[score];
}

function entryOf(item) {
  const lines = wrapText(item.content || '', innerWidth, MAX_LINES);
  const images = Array.isArray(item.images) ? item.images.length : 0;
  const moodText = moodTextOf(item.moodScore);
  const height = DATE_H + lines.length * LINE_H + (moodText ? MOOD_H : 0) + GAP;
  return {
    date: item.date,
    dateText: dayText(item.date),
    moodText,
    lines,
    // 配图占位：没有配图给 -1，页面据此跳过绘制
    imageX: images ? MARGIN + PAD : -1,
    imageCount: images,
    height,
  };
}

/**
 * 把 items 排成一张（或按高度上限切分成多张）长图。
 * @param {{ year: number, items: Array, nickname?: string, todayKey?: string }} input
 * @returns {{ width:number, header:object, months:Array, pages:Array, pageCount:number, height:number }}
 */
function buildPoster(input) {
  const data = input || {};
  const year = Number(data.year) || 0;
  const nickname = String(data.nickname || '').trim();
  const items = (Array.isArray(data.items) ? data.items : [])
    .filter((item) => item && typeof item.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.date))
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const months = [];
  const byMonth = new Map();
  items.forEach((item) => {
    const month = item.date.slice(0, 7);
    if (!byMonth.has(month)) {
      const bucket = { month, label: monthText(month), entries: [], height: MONTH_H };
      byMonth.set(month, bucket);
      months.push(bucket);
    }
    const bucket = byMonth.get(month);
    const entry = entryOf(item);
    bucket.entries.push(entry);
    bucket.height += entry.height;
  });

  const header = {
    title: (nickname || '我') + ' 的 ' + (year || '') + ' 年手帐',
    subtitle: items.length + ' 篇 · ' + months.length + ' 个月',
    year,
  };

  // 分页：每页不超过 MAX_PAGE_H（iOS canvas 上限）。
  // 一页装不下一个月时，把该月按条目切开、在新页重复月份标题——否则「每天写满 6 行」的一个月
  // 自己就有 9000+px，会整页超限导致导出直接失败
  const pages = [];
  let current = { index: 0, height: HEADER_H, months: [] };

  const closePage = () => {
    current.height += FOOTER_H;
    pages.push(current);
    current = { index: pages.length, height: HEADER_H, months: [] };
  };
  /** 当前页里这个月是否已经有块（换页后要重新出月份标题） */
  const openBlock = (month) => {
    const last = current.months[current.months.length - 1];
    if (last && last.month === month.month) return last;
    const block = { month: month.month, label: month.label, entries: [], height: MONTH_H };
    current.months.push(block);
    current.height += MONTH_H;
    return block;
  };

  months.forEach((month) => {
    month.entries.forEach((entry) => {
      const last = current.months[current.months.length - 1];
      const needHeader = !last || last.month !== month.month;
      const addH = (needHeader ? MONTH_H : 0) + entry.height;
      if (current.months.length && current.height + addH + FOOTER_H > MAX_PAGE_H) {
        closePage();
      }
      const block = openBlock(month);
      block.entries.push(entry);
      block.height += entry.height;
      current.height += entry.height;
    });
    // 空月份（没有条目）也要出月份标题，保持「记了几个月」与画面对得上
    if (!month.entries.length) {
      if (current.height + MONTH_H + FOOTER_H > MAX_PAGE_H && current.months.length) closePage();
      openBlock(month);
    }
  });
  closePage();

  return {
    width: WIDTH,
    header,
    months,
    pages,
    pageCount: pages.length,
    // 单页高度；多页时页面按 pages[i].height 逐张绘制
    height: pages[0].height,
  };
}

module.exports = {
  buildPoster,
  wrapText,
  dayText,
  monthText,
  moodTextOf,
  WIDTH,
  MAX_PAGE_H,
  MAX_LINES,
  FONT_SIZE,
  MARGIN,
  PAD,
  HEADER_H,
};
