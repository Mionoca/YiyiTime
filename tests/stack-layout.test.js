'use strict';

/**
 * 纪念日堆叠的版式与动效静态自检（文档 9.4「统一高度」/ 9.7）。
 *
 * 这一组守的是「切卡时下方不跳」这个体验，而不是某个具体像素：
 * - 卡面必须固定等高：容器写死高度、卡片 flex 撑满、正文裁剪、脚注贴底；
 *   只渲染 3 层的模型下，容器高度本来取「当前这 3 张」的最大值，换一张卡集合就变，
 *   下方的心情卡与四宫格会跟着上下跳；
 * - 高度不允许进 transition（触发布局，而且那样跳得更明显）；
 * - 缓动必须是「越过目标再落回」的回弹曲线（y1 > 1），否则谈不上弹性。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WXSS = 'miniprogram/components/anniversary-stack/index.wxss';
const WXML = 'miniprogram/components/anniversary-stack/index.wxml';
const DOC = 'docs/技术设计文档.md';

function stripComments(text) {
  return String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 顶层规则扫描：只在花括号深度 0 处取选择器，@media 内部不串味（与 contrast 用例同款） */
function parseRules(text) {
  const src = stripComments(text);
  const rules = [];
  let selector = '';
  let body = '';
  let depth = 0;
  for (const ch of src) {
    if (ch === '{') {
      if (depth === 0) body = '';
      else if (depth === 1) body += '{';
      depth += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        rules.push({ selector: selector.trim(), body });
        selector = '';
        body = '';
      } else if (depth === 1) body += '}';
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
  assert.ok(hit, '缺少规则：' + selector);
  return decls(hit.body);
}

/** 从 `cubic-bezier(a, b, c, d)` 里取参数 */
function bezierParams(text) {
  const m = /cubic-bezier\(\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*([\d.]+)\s*,\s*(-?[\d.]+)\s*\)/.exec(String(text || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] : null;
}

const rules = parseRules(read(WXSS));
const wxml = read(WXML);

test('9.4 卡面固定等高：容器写死高度、卡片撑满、正文裁剪、操作行贴底', () => {
  const deck = findRule(rules, '.stack__deck');
  const height = String(deck.height || '');
  assert.match(height, /^\d+rpx$/, '容器高度必须是固定 rpx（实际 ' + height + '）：auto / 百分比都会随内容变');
  assert.strictEqual(deck['grid-template-rows'], '1fr', '后置层不参与高度计算');
  // 400rpx 是按最长内容（≈380rpx）+ 20rpx 余量算的，改小会裁到脚注
  assert.strictEqual(height, '400rpx', '卡面高度按 9.4 固定 400rpx');

  const card = findRule(rules, '.stack__card');
  assert.strictEqual(card.height, '100%', '卡片要撑满容器高度，而不是按内容撑开');
  assert.strictEqual(card['box-sizing'], 'border-box', 'padding / border 不能额外加高');
  assert.strictEqual(card.display, 'flex');
  assert.strictEqual(card['flex-direction'], 'column', '纵向 flex 才能把脚注推到卡底');

  const body = findRule(rules, '.stack__body');
  assert.strictEqual(body.flex, '1', '正文区吃满剩余高度');
  assert.strictEqual(body['min-height'], '0', '不加 min-height: 0 时 flex 子项会被内容顶开');
  assert.strictEqual(body.overflow, 'hidden', '超长正文裁掉，不许顶开卡片');

  const foot = findRule(rules, '.stack__foot');
  assert.strictEqual(foot['margin-top'], 'auto', '操作行贴底：换哪张卡它都不动');
});

test('9.4 正文与操作行的层级：操作行在正文区之外，四个文本都在正文区里', () => {
  const bodyOpen = wxml.indexOf('class="stack__body"');
  const bodyClose = wxml.indexOf('</view>', bodyOpen);
  const footOpen = wxml.indexOf('class="stack__foot"', bodyOpen);
  assert.ok(bodyOpen > 0, '模板里应有 .stack__body');
  assert.ok(footOpen > bodyClose, '操作行必须是正文区的兄弟节点，放进正文区就会被一起裁掉');

  for (const cls of ['stack__label', 'stack__main', 'stack__sub', 'stack__meta']) {
    const at = wxml.indexOf('class="' + cls + '"');
    assert.ok(at > bodyOpen && at < bodyClose, cls + ' 必须在 .stack__body 内（否则不受高度约束）');
  }
});

test('9.4 标题单行省略：超长标题不许换行把卡撑高', () => {
  const label = findRule(rules, '.stack__label');
  assert.strictEqual(label['white-space'], 'nowrap');
  assert.strictEqual(label['overflow'], 'hidden');
  assert.strictEqual(label['text-overflow'], 'ellipsis');
});

test('9.4 / 8.9 高度不进过渡：切换只动 transform 与 opacity', () => {
  const card = findRule(rules, '.stack__card');
  const transition = String(card.transition || '');
  // 逗号切分要跳过 cubic-bezier(...) 里的逗号，否则会把缓动参数当成属性
  const props = [];
  let depth = 0;
  let current = '';
  for (const ch of transition) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      props.push(current.trim().split(/\s+/)[0]);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) props.push(current.trim().split(/\s+/)[0]);
  props.splice(0, props.length, ...props.filter(Boolean));
  assert.deepStrictEqual(props.sort(), ['opacity', 'transform'], '过渡属性只能有 transform / opacity');
  for (const banned of ['height', 'min-height', 'max-height', 'padding', 'margin']) {
    assert.strictEqual(new RegExp('(^|[,\\s])' + banned + '\\s').test(transition), false,
      '过渡里出现 ' + banned + ' 会触发布局，切换会抖');
  }
});

test('9.4 弹性反馈：缓动真的越过目标（y1 > 1），时长在 300–500ms', () => {
  const card = findRule(rules, '.stack__card');
  const transition = String(card.transition || '');

  const transformMs = Number((/(?:^|[,\s])transform\s+(\d+)ms/.exec(transition) || [])[1]);
  assert.ok(transformMs >= 300 && transformMs <= 500, 'transform 时长 ' + transformMs + 'ms 超出 300–500ms');

  const curves = transition.match(/cubic-bezier\([^)]*\)/g) || [];
  assert.ok(curves.length >= 1, '切换必须写明缓动曲线');
  const spring = curves.map(bezierParams).find((p) => p && p[1] > 1);
  assert.ok(spring, '至少要有一条 y1 > 1 的回弹曲线，否则卡片是「滑过去」而不是「落回去」');
  // 回弹过头就成了弹球：1.2–1.9 之间才是「纸牌落桌」
  assert.ok(spring[1] > 1.2 && spring[1] < 1.9, '回弹幅度 ' + spring[1] + ' 不在 1.2–1.9 的轻微区间');

  // 指示器与卡片同一套回弹：选中态变化时才有一致的「手感」
  const dot = findRule(rules, '.stack__dot');
  const dotCurve = bezierParams(dot.transition);
  assert.ok(dotCurve, '.stack__dot 要写缓动曲线');
  assert.deepStrictEqual(dotCurve, spring, '指示器与卡片用同一条回弹曲线');
  const dotMs = Number((/(\d+)ms/.exec(String(dot.transition)) || [])[1]);
  assert.ok(dotMs >= 200 && dotMs <= 500, '指示器时长 ' + dotMs + 'ms 超出 200–500ms');
});

test('9.7 箭头按下反馈：只挪 2rpx、不缩放，且模板挂了 hover-class', () => {
  const press = findRule(rules, '.stack__arrow.is-press');
  assert.match(String(press.transform || ''), /translate\(\s*2rpx\s*,\s*2rpx\s*\)/);
  const arrow = findRule(rules, '.stack__arrow');
  assert.match(String(arrow.transition || ''), /transform\s+120ms/, '按下反馈要短（120ms）才跟手');

  const hits = (wxml.match(/hover-class="is-press"/g) || []).length;
  assert.strictEqual(hits, 2, '左右箭头都要挂 hover-class（实际 ' + hits + ' 个）');
});

test('9.7 减弱动态效果：卡片 / 箭头 / 指示器的过渡都关掉', () => {
  const raw = read(WXSS);
  const block = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*)\}\s*$/.exec(raw);
  assert.ok(block, '缺少 prefers-reduced-motion 分支');
  for (const selector of ['.stack__card', '.stack__arrow', '.stack__dot']) {
    assert.ok(block[1].includes(selector), '减弱动态效果时 ' + selector + ' 也要停');
  }
  assert.match(block[1], /transition:\s*none/);
});

test('文档与实现不漂移：9.4 写的高度 / 回弹曲线就是代码里这两个值', () => {
  const doc = read(DOC);
  assert.ok(doc.includes('height: 400rpx'), '9.4 应写明容器固定 height: 400rpx');
  assert.ok(doc.includes('cubic-bezier(0.34, 1.56, 0.64, 1)'), '9.4 应写明回弹曲线');
  assert.ok(doc.includes('统一高度'), '9.4 应有「统一高度」小节说明为什么不跳');
});
