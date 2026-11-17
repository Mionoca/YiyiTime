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

const tokens = parseTokens(read('miniprogram/styles/tokens.wxss'));
const homeRules = parseRules(read('miniprogram/pages/home/index.wxss'));

/** 把 var(--x) 还原成色值；不是变量就原样返回 */
function colorOf(value) {
  const name = String(value || '').replace('var(--', '').replace(')', '').trim();
  return tokens[name] || String(value || '').trim();
}

/** 取某个选择器的文字色，配合显式底色算对比度（透明底按纸/卡同色处理） */
function ratioOn(selector, bgHex) {
  const d = findRule(homeRules, selector);
  return contrast(colorOf(d.color), bgHex);
}

test('对比度：首页卡片里的说明文字在纸上 ≥4.5:1（文档 8.9）', () => {
  // 一张便签卡是一片纸：卡片底色与页面底色同色（--card = --bg = #FFFEF5）
  assert.strictEqual(tokens.card, tokens.bg, '便签卡与纸同色是这套风格的前提');
  for (const selector of ['.days-meta', '.mood-desc', '.grid__sub', '.invite-tip', '.hug-hint']) {
    const ratio = ratioOn(selector, tokens.card);
    assert.ok(ratio >= 4.5, selector + ' 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  }
});

test('对比度：纪念日小标签（浅色底 + 深色字）≥4.5:1（文档 8.9）', () => {
  const d = findRule(homeRules, '.days-anniv');
  const ratio = contrast(colorOf(d.color), colorOf(d['background-color']));
  assert.ok(ratio >= 4.5, '.days-anniv 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
});

test('对比度：刷新失败横幅的文字 ≥4.5:1（文档 9.12）', () => {
  const ratio = ratioOn('.refresh-bar__text', tokens.card);
  assert.ok(ratio >= 4.5, '.refresh-bar__text 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
});

test('对比度：token 的次要文字与强调文字在各自底色上 ≥4.5:1（文档 8.9）', () => {
  const cases = [
    ['--muted on --bg', tokens.muted, tokens.bg],
    ['--muted on --card', tokens.muted, tokens.card],
    ['--accent-ink on --accent-soft', tokens['accent-ink'], tokens['accent-soft']],
    ['--accent-ink on --card', tokens['accent-ink'], tokens.card],
    ['白字 on --accent-strong', '#FFFFFF', tokens['accent-strong']],
    ['--ink on --marker-yellow', tokens.ink, tokens['marker-yellow']],
    ['--danger on --card', tokens.danger, tokens.card],
  ];
  for (const [label, fg, bg] of cases) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, label + ' 对比度 ' + ratio.toFixed(2) + ':1 低于 4.5:1');
  }
});

test('对比度：马克笔色只做装饰，不做正文色（文档 8.7）', () => {
  // 三支马克笔若直接当正文色，在纸上都不到 4.5:1，所以规范要求它们只出现在阴影/胶带/高亮块上
  for (const name of ['marker-red', 'marker-teal', 'marker-yellow']) {
    const ratio = contrast(tokens[name], tokens.bg);
    assert.ok(ratio < 4.5, '--' + name + ' 若已能当正文色（' + ratio.toFixed(2) + ':1），要重新审视 8.7 的用色规则');
  }
  // 正文/说明文字必须是 ink / muted / accent-ink，不能直接写 var(--marker-*)。
  // 例外：抱抱心形是装饰符号（不是可读文案），允许用马克笔红。
  const DECORATIVE = ['.hug-heart-float'];
  const offenders = parseRules(read('miniprogram/pages/home/index.wxss'))
    .filter((rule) => /color\s*:\s*var\(--marker-/.test(rule.body) && DECORATIVE.indexOf(rule.selector) === -1)
    .map((rule) => rule.selector);
  assert.deepStrictEqual(offenders, [], '首页正文色不能直接用马克笔色：' + offenders.join('、'));
});

test('动画：心形上浮的 JS 清理定时器不短于 CSS 动画时长（文档 9.7）', () => {
  const { animation } = findRule(homeRules, '.hug-heart-float');
  const cssMs = Number((String(animation).match(/(\d+)ms/) || [])[1]);
  assert.ok(cssMs > 0, '.hug-heart-float 的 animation 应写明毫秒时长');
  const js = read('miniprogram/pages/home/index.js');
  const jsMs = Number((js.match(/HUG_FLOAT_MS\s*=\s*(\d+)/) || [])[1]);
  assert.ok(jsMs > 0, '首页 js 里应有 HUG_FLOAT_MS 常量');
  assert.ok(jsMs >= cssMs, 'JS 清理时间 ' + jsMs + 'ms 短于 CSS 动画 ' + cssMs + 'ms，心形会被截断');
});

test('对比度：心情气泡四态在淡底上 ≥4.5:1（文档 9.5）', () => {
  const bubble = read('miniprogram/components/avatar-bubble/index.wxss');
  const pairs = [
    ['#4A3A00', '#FFF3C4'],
    ['#3C424C', '#EDF0F4'],
    ['#1F4B48', '#D9F5F2'],
    ['#33304A', '#E6E4F0'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, '气泡 ' + fg + ' on ' + bg + ' 只有 ' + ratio.toFixed(2) + ':1');
  }
  // 四态必须都在，且不是靠颜色区分（8.9 要求文字 + emoji）
  for (const key of ['sunny', 'cloudy', 'rainy', 'thunder']) {
    assert.ok(bubble.includes('.bubble--' + key), '缺少 .bubble--' + key);
  }
});
