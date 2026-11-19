// 文档 8.8 图片与资源 / 8.9 性能与可访问性 的静态约束。
// 这些是评审时容易回归、又难以在真机上发现的问题：图片 mode、网络图片、lazy-load、
// 动画/过渡只动 transform/opacity、首页禁滚动、列表分页大小、心情不只靠颜色。
// 只做静态扫描，不渲染；真实观感仍需 13.8 真机验收。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'miniprogram');
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', 'coverage', '.git']);

function walk(dir, out) {
  const list = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, list);
    else list.push(full);
  }
  return list;
}

const files = walk(ROOT);
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const read = (f) => fs.readFileSync(f, 'utf8');
const wxmlFiles = files.filter((f) => f.endsWith('.wxml'));
const wxssFiles = files.filter((f) => f.endsWith('.wxss'));
const jsFiles = files.filter((f) => f.endsWith('.js'));

// 注释里的示例标签/动画不应参与校验（否则注释里的 image / keyframes 会假红或冒充实现）
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// 按引号感知扫描标签：属性值里出现的 > 不会截断（例如 wx:if="{{avatar > ''}}"）
function tags(text, name) {
  const list = [];
  const open = '<' + name;
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start === -1) break;
    let i = start + open.length;
    let quote = null;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    list.push(text.slice(start, i + 1));
    from = i + 1;
  }
  return list;
}

function keyframesOf(text) {
  const list = [];
  const re = /@keyframes\s+([\w-]+)\s*\{/g;
  const clean = stripComments(text);
  let m;
  while ((m = re.exec(clean))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i + 1;
    for (; i < clean.length; i += 1) {
      if (clean[i] === '{') depth += 1;
      else if (clean[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    list.push({ name: m[1], body: clean.slice(start, i) });
  }
  return list;
}

function animatedProps(body) {
  const props = new Set();
  const re = /([a-zA-Z-]+)\s*:/g;
  let m;
  while ((m = re.exec(body))) props.add(m[1].toLowerCase());
  return props;
}

// 取方法体：从 onUnload(…) { 开始按花括号配平，供「清理必须写在 onUnload 里」这类断言使用
function methodBody(src, name) {
  // 同时支持方法简写 onUnload() {} 与属性写法 onUnload: function () {}
  const re = new RegExp(name + '\\s*(?::\\s*function\\s*\\([^)]*\\)|\\([^)]*\\))\\s*\\{');
  const m = re.exec(src);
  assert.ok(m, name + ' 方法不存在');
  let depth = 0;
  const start = m.index + m[0].length - 1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  throw new Error(name + ' 方法的大括号没有闭合');
}

// 按逗号切分，但忽略括号内的逗号（cubic-bezier(0.4, 0, 0.2, 1) / steps(4, end)）
function splitTopLevel(value) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

// 取「属性名」：去掉括号里的函数参数，再取首 token（transition: transform 300ms cubic-bezier(...)）
function propertyOf(segment) {
  const head = segment.trim().split('(')[0].trim();
  if (!head) return '';
  return head.split(/\s+/)[0].toLowerCase();
}

// 取某个标签的文本内容（属性顺序无关；属性值里的 > 不截断，注释里的标签不参与）
function tagText(text, tagName, classNeedle) {
  const open = '<' + tagName;
  let from = 0;
  for (;;) {
    const start = text.indexOf(open, from);
    if (start === -1) return null;
    let i = start + open.length;
    let quote = null;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    const tag = text.slice(start, i + 1);
    if (tag.includes(classNeedle)) {
      if (/\/\s*>$/.test(tag)) return '';
      const close = text.indexOf('</' + tagName + '>', i + 1);
      return close === -1 ? null : text.slice(i + 1, close);
    }
    from = i + 1;
  }
}

test('8.8 所有 image 用 aspectFill，且 wxml / wxss 不用网络图片', () => {
  let count = 0;
  for (const f of wxmlFiles) {
    const text = stripComments(read(f));
    for (const tag of tags(text, 'image')) {
      count += 1;
      assert.match(tag, /mode\s*=\s*['"]aspectFill['"]/, rel(f) + ' 的 image 缺少 mode="aspectFill"：' + tag.replace(/\s+/g, ' '));
      const src = tag.match(/src\s*=\s*['"]([^'"]*)['"]/);
      if (src) assert.ok(!/https?:\/\//.test(src[1]), rel(f) + ' 使用了网络图片（8.8 要求不使用网络图片）：' + tag.replace(/\s+/g, ' '));
    }
  }
  // 首页 M8 去掉相框/信封图后，全站剩 7 张（默认头像、绑定头像、时间线头像等）
  assert.ok(count >= 7, '应扫描到至少 7 个 image 标签，实际 ' + count + '（夹具或目录结构可能变了）');
  for (const f of wxssFiles) {
    const text = stripComments(read(f));
    const urls = text.match(/url\(\s*['"]?https?:\/\/[^)]*\)/g) || [];
    assert.strictEqual(urls.length, 0, rel(f) + ' 的 wxss 引用了网络图片：' + urls.join(' '));
  }
});

test('8.8 头像（avatar-bubble，M14 起唯一头像渲染器）开启 lazy-load', () => {
  // M14 下线报平安后 timeline-item 一起删了，头像只剩 avatar-bubble 一处渲染点
  const file = path.join(ROOT, 'components', 'avatar-bubble', 'index.wxml');
  const list = tags(stripComments(read(file)), 'image');
  assert.ok(list.length >= 1, 'avatar-bubble 应有头像 image');
  for (const tag of list) {
    assert.match(tag, /lazy-load/, '头像必须 lazy-load');
  }
  const text = stripComments(read(file));
  assert.match(text, /aria-label=/, '头像组件需要 aria-label（8.9 可访问性）');
});

test('8.9 页面集合与滚动配置：全部可滚动、可下拉刷新', () => {
  const app = JSON.parse(read(path.join(ROOT, 'app.json')));
  const pages = app.pages.map((p) => p.replace(/^pages\//, '').replace(/\/index$/, ''));
  assert.deepStrictEqual(pages.slice().sort(), ['anniversary', 'bind', 'diary', 'growth', 'home', 'ledger', 'mood', 'profile', 'wish'], '页面集合变了，请同步本测试与发布文档');
  for (const page of pages) {
    const json = JSON.parse(read(path.join(ROOT, 'pages', page, 'index.json')));
    assert.strictEqual(json.enablePullDownRefresh, true, page + ' 页应支持下拉刷新');
    assert.notStrictEqual(json.disableScroll, true, page + ' 页不应禁用滚动（M8 起首页也是卡片流）');
  }
});

test('8.9 动画与过渡只动 transform / opacity', () => {
  const allowed = new Set(['transform', 'opacity']);
  let total = 0;
  for (const f of wxssFiles) {
    for (const kf of keyframesOf(read(f))) {
      total += 1;
      const props = animatedProps(kf.body);
      for (const prop of props) {
        assert.ok(allowed.has(prop), rel(f) + ' 的 @keyframes ' + kf.name + ' 动了 ' + prop + '（8.9 要求动画只用 transform / opacity）');
      }
      assert.ok(props.size >= 1, rel(f) + ' 的 @keyframes ' + kf.name + ' 没有任何属性');
    }
  }
  assert.ok(total >= 12, '应扫描到至少 12 个 @keyframes，实际 ' + total);

  // transition 同样只允许 transform / opacity（width/height 过渡会触发布局，低端机掉帧）
  let transitions = 0;
  const checkTransition = (value, where) => {
    for (const segment of splitTopLevel(value)) {
      const prop = propertyOf(segment);
      if (!prop || prop === 'none') continue;
      transitions += 1;
      assert.ok(allowed.has(prop), where + ' 过渡了 ' + prop + '（8.9 只允许 transform / opacity）');
    }
  };
  // 同时扫简写 transition 与 transition-property，以及 -webkit- 前缀写法
  const TRANSITION_DECL = /(?:^|[;{\s])(?:-webkit-)?transition(?:-property)?\s*:\s*([^;}]+)/g;
  for (const f of wxssFiles) {
    const text = stripComments(read(f));
    TRANSITION_DECL.lastIndex = 0;
    let m;
    while ((m = TRANSITION_DECL.exec(text))) checkTransition(m[1], rel(f));
  }
  for (const f of wxmlFiles) {
    const text = stripComments(read(f));
    const re = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(text))) {
      const style = m[1] || m[2] || '';
      const decl = style.match(/(?:^|;)\s*(?:-webkit-)?transition(?:-property)?\s*:\s*([^;]+)/);
      if (decl) checkTransition(decl[1], rel(f) + ' 的行内 style');
    }
  }
  assert.ok(transitions >= 2, '应扫描到至少 2 条 transition，实际 ' + transitions);
});

test('8.9 animation 引用的 keyframes 都已定义（含多值 / 无分号 / animation-name）', () => {
  const defined = new Set();
  for (const f of wxssFiles) for (const kf of keyframesOf(read(f))) defined.add(kf.name);
  let count = 0;
  const ANIMATION_DECL = /(?:^|[;{\s])(?:-webkit-)?animation(?:-name)?\s*:\s*([^;}]+)/g;
  const checkAnimation = (value, where) => {
    for (const segment of splitTopLevel(value)) {
      const text = segment.trim();
      if (!text || text === 'none') continue;
      count += 1;
      const motion = text.split('(')[0];
      const name = motion.split(/\s+/).find((token) => defined.has(token));
      assert.ok(name, where + ' 的 animation 引用了未定义的 keyframes：' + text);
    }
  };
  for (const f of wxssFiles) {
    const text = stripComments(read(f));
    ANIMATION_DECL.lastIndex = 0;
    let m;
    while ((m = ANIMATION_DECL.exec(text))) checkAnimation(m[1], rel(f));
  }
  // 行内 style 的 animation 同样要引用已定义 keyframes（wxml 允许单/双引号）
  for (const f of wxmlFiles) {
    const text = stripComments(read(f));
    const re = /style\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let m;
    while ((m = re.exec(text))) {
      const style = m[1] || m[2] || '';
      const decl = style.match(/(?:^|;)\s*(?:-webkit-)?animation(?:-name)?\s*:\s*([^;]+)/);
      if (decl) checkAnimation(decl[1], rel(f) + ' 的行内 style');
    }
  }
  // M8 去掉场景化首页后少了 7 条场景动画；这里守的是「引用的 keyframes 必须存在」，
  // 数量只防止扫描器被改坏（例如正则失效后恒为 0）
  assert.ok(count >= 12, '应扫描到至少 12 条 animation 声明，实际 ' + count);
});

test('8.9 子页列表分页 10–20 条，onPageScroll 里不得 setData', () => {
  const pageSize = (page) => {
    const src = read(path.join(ROOT, 'pages', page, 'index.js'));
    const m = src.match(/const PAGE_SIZE\s*=\s*(\d+)/);
    assert.ok(m, page + ' 页应有 PAGE_SIZE 常量');
    return Number(m[1]);
  };
  // M14 下线报平安后，带分页列表的子页只剩日记（成长池是固定窗口，不算列表分页）
  for (const page of ['diary']) {
    const size = pageSize(page);
    assert.ok(size >= 10 && size <= 20, page + ' 页分页大小 ' + size + ' 不在 10–20（8.9）');
  }
  for (const f of jsFiles) {
    const src = read(f);
    if (!/onPageScroll\s*[:=(]/.test(src)) continue;
    const body = methodBody(src, 'onPageScroll');
    assert.ok(!/setData\s*\(/.test(body), rel(f) + ' 在 onPageScroll 里 setData（8.9 禁止频繁 setData）');
  }
});

test('8.9 心情不只靠颜色：四个心情都有文字标签与 emoji，气泡同时渲染文字', () => {
  const constants = require(path.join(ROOT, 'utils', 'constants.js'));
  assert.strictEqual(constants.MOODS.length, 4);
  for (const mood of constants.MOODS) {
    assert.ok(mood.label && mood.label.length >= 1, mood.key + ' 缺少中文标签');
    assert.ok(mood.emoji && mood.emoji.length >= 1, mood.key + ' 缺少 emoji 兜底图标');
    assert.match(mood.color, /^#[0-9A-Fa-f]{6}$/, mood.key + ' 的颜色格式不对');
  }
  const bubble = stripComments(read(path.join(ROOT, 'components', 'avatar-bubble', 'index.wxml')));
  const charText = tagText(bubble, 'text', 'class="bubble__char"');
  assert.ok(charText !== null, '心情气泡缺少 bubble__char 文字节点');
  assert.match(charText, /\{\{[^}]*moodShort[^}]*\}\}/, '心情气泡的文字节点必须是 moodShort 文本，不能为空');
  const iconText = tagText(bubble, 'text', 'class="bubble__icon"');
  assert.ok(iconText !== null, '心情气泡缺少 bubble__icon 图标节点');
  assert.match(iconText, /\{\{[^}]*moodIcon[^}]*\}\}/, '心情气泡应渲染 moodIcon emoji');
});

test('8.9 首页在 onUnload 里清理定时器并置 _unloaded 守卫', () => {
  const src = read(path.join(ROOT, 'pages', 'home', 'index.js'));
  const body = methodBody(src, 'onUnload');
  assert.match(body, /_unloaded\s*=\s*true/, 'onUnload 应置 _unloaded 守卫（防止异步回调再 setData）');
  // 清理可以写在 onUnload 体内，也可以抽到它调用的 helper 方法里（重构不应被误判）
  // M12 起首页只剩入场动画一个定时器（心形上浮随抱一抱下线）
  const cleanup = (text) => /clearTimeout\s*\(\s*this\._enterTimer\s*\)/.test(text);
  let cleaned = cleanup(body);
  if (!cleaned) {
    const calls = body.match(/this\.(\w+)\s*\(/g) || [];
    for (const call of calls) {
      const name = call.replace(/this\./, '').replace(/\s*\($/, '');
      try {
        if (cleanup(methodBody(src, name))) {
          cleaned = true;
          break;
        }
      } catch (_) {
        // 被调用的不是本文件内定义的方法（例如 setData），跳过
      }
    }
  }
  assert.ok(cleaned, 'onUnload 或其调用的清理方法应 clearTimeout(this._celebrateTimer) 与 clearTimeout(this._enterTimer)');
});
