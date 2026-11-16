'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function stripComments(text) {
  return String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 顶层规则扫描：只在花括号深度 0 处取选择器，@media 内部规则不会串味 */
function parseRules(text) {
  const src = stripComments(text);
  const rules = [];
  let selector = '';
  let body = '';
  let depth = 0;
  for (const ch of src) {
    if (ch === '{') {
      if (depth === 0) {
        body = '';
      } else if (depth === 1) {
        body += '{';
      }
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push({ selector: selector.trim(), body });
        selector = '';
        body = '';
      } else if (depth === 1) {
        body += '}';
      }
      continue;
    }
    if (depth === 0) selector += ch;
    else if (depth === 1) body += ch;
  }
  return rules;
}

function decls(body) {
  const out = {};
  const re = /([a-zA-Z-]+)\s*:\s*([^;]+);?/g;
  let m;
  while ((m = re.exec(body || ''))) {
    const key = m[1].toLowerCase();
    if (!(key in out)) out[key] = m[2].trim();
  }
  return out;
}

function findRule(rules, selector) {
  const hit = rules.find((rule) => rule.selector === selector);
  assert.ok(hit, 'wxss 里找不到规则 ' + selector);
  return decls(hit.body);
}

function parseTokens(text) {
  const vars = {};
  const re = /--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  let m;
  while ((m = re.exec(stripComments(text)))) vars[m[1]] = m[2];
  return vars;
}

function toRgb(hex) {
  const h = String(hex).replace('#', '');
  assert.match(h, /^[0-9a-fA-F]{6}$/, '颜色必须是 6 位 hex：' + hex);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
}

function luminance(hex) {
  const [r, g, b] = toRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 取规则里的 color / background 颜色（支持 var(--x) 引用 token） */
function pair(rules, selector, vars) {
  const d = findRule(rules, selector);
  const color = vars[(d.color || '').replace(/var\(--([\w-]+)\)/, '$1')] || d.color;
  const background = vars[(d['background'] || '').replace(/var\(--([\w-]+)\)/, '$1')] || d['background'];
  return { color, background };
}

const tokens = parseTokens(read('miniprogram/styles/tokens.wxss'));
const homeRules = parseRules(read('miniprogram/pages/home/index.wxss'));

test('对比度：首页沙发名字昼夜都 ≥4.5:1（文档 8.9 / 9.6）', () => {
  for (const selector of ['.person-name', '.phase-night .person-name']) {
    const p = pair(homeRules, selector, tokens);
    const ratio = contrast(p.color, p.background);
    assert.ok(ratio >= 4.5, selector + ' 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  }
});

test('对比度：未绑定时空椅子提示昼夜都 ≥4.5:1（文档 8.9 / 9.6）', () => {
  for (const selector of ['.empty-text', '.phase-night .empty-text']) {
    const p = pair(homeRules, selector, tokens);
    const ratio = contrast(p.color, p.background);
    assert.ok(ratio >= 4.5, selector + ' 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  }
});

test('对比度：token 的次要文字与强调文字在各自底色上 ≥4.5:1（文档 8.9）', () => {
  const cases = [
    ['--muted on --bg', tokens.muted, tokens.bg],
    ['--muted on --card', tokens.muted, tokens.card],
    ['--accent-ink on --accent-soft', tokens['accent-ink'], tokens['accent-soft']],
    ['--accent-ink on --card', tokens['accent-ink'], tokens.card],
    ['白字 on --accent-strong', '#FFFFFF', tokens['accent-strong']],
  ];
  for (const [label, fg, bg] of cases) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, label + ' 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  }
});

test('对比度：桌子便签标题 ≥4.5:1（文档 8.9 / 9.9）', () => {
  const text = findRule(homeRules, '.table-note-text');
  const note = findRule(homeRules, '.table-note');
  const fg = tokens[(text.color || '').replace(/var\(--([\w-]+)\)/, '$1')] || text.color;
  const bg = tokens[(note['background'] || '').replace(/var\(--([\w-]+)\)/, '$1')] || note['background'];
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, '便签标题对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  // 长标题必须省略（两行 clamp），不能硬裁
  assert.match(text['-webkit-line-clamp'] || '', /^\d+$/);
  assert.strictEqual(text.overflow, 'hidden');
});

test('动画：心形上浮的 JS 清理定时器不短于 CSS 动画时长（文档 9.7）', () => {
  const wxss = read('miniprogram/pages/home/index.wxss');
  const { animation } = findRule(homeRules, '.hug-heart-float');
  const cssMs = Number((String(animation).match(/(\d+)ms/) || [])[1]);
  assert.ok(cssMs > 0, '.hug-heart-float 的 animation 应写明毫秒时长');
  const js = read('miniprogram/pages/home/index.js');
  const jsMs = Number((js.match(/HUG_FLOAT_MS\s*=\s*(\d+)/) || [])[1]);
  assert.ok(jsMs > 0, '首页 js 里应有 HUG_FLOAT_MS 常量');
  assert.ok(jsMs >= cssMs, 'JS 清理时间 ' + jsMs + 'ms 短于 CSS 动画 ' + cssMs + 'ms，心形会被截断');
});

test('对比度：墙历纪念日临近日数与副标题 ≥4.5:1（文档 9.3 / 9.10）', () => {
  const tokenOf = (value) => tokens[String(value || '').replace('var(--', '').replace(')', '')] || value;
  const calendar = findRule(homeRules, '.calendar');
  const bg = tokenOf(calendar['background']);
  assert.strictEqual(bg, tokens.card, '墙历底色应就是 --card，对比度基准才对');

  const cases = [
    ['.calendar-soon .calendar-days', '纪念日临近日数'],
    ['.calendar-sub', '墙历副标题'],
  ];
  for (const [selector, label] of cases) {
    const fg = tokenOf(findRule(homeRules, selector).color);
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, label + ' 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  }
});
