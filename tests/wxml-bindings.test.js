'use strict';

// WXML 事件绑定的静态自检：wxml 里 bind*/catch* 指定的 handler 必须在同目录 index.js 里定义。
// 目的：拦住「模板里绑了但 JS 里没有/拼错」这类真机点击才暴露的低级 bug。
// 只做静态文本检查，不渲染 WXML；handler 存在性按 methods 简写 `name(` 或 `name:` 判断。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');

const HANDLER_ATTR = /\s(?:bind|catch|mut-bind|capture-bind|capture-catch)(?::)?[a-zA-Z]+\s*=\s*(["'])([^"']*)\1/g;

/** 去掉块注释与行注释（含行尾注释），字符串里的 // 不算注释。 */
function stripComments(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (ch === '/' && source[i + 1] === '/') {
      const end = source.indexOf('\n', i + 2);
      const stop = end < 0 ? n : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue; }
        if (source[j] === quote) { j += 1; break; }
        j += 1;
      }
      out += source.slice(i, j);
      i = j;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

function collectWxml(dir) {
  const out = [];
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectWxml(abs));
    } else if (entry.name.endsWith('.wxml')) {
      out.push(abs);
    }
  });
  return out;
}

/** 返回 [{handler, line}]；handler 含 {{}} 的视为动态绑定跳过。 */
function findHandlers(wxmlFile) {
  const text = fs.readFileSync(wxmlFile, 'utf8');
  const found = [];
  let match;
  HANDLER_ATTR.lastIndex = 0;
  while ((match = HANDLER_ATTR.exec(text))) {
    const handler = match[2].trim();
    if (!handler || handler.indexOf('{{') >= 0) continue;
    const line = text.slice(0, match.index).split('\n').length;
    found.push({ handler, line });
  }
  return found;
}

function definesHandler(source, handler) {
  const clean = stripComments(source);
  const escape = handler.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const shorthand = new RegExp('(?:^|[\\s,{])(?:async\\s+)?' + escape + '\\s*[(:]');
  const quoted = new RegExp('(["\'])' + escape + '\\1\\s*:');
  return shorthand.test(clean) || quoted.test(clean);
}

/** 扫描一个根目录下所有 wxml，返回缺失 handler 的列表。 */
function collectMissingHandlers(root) {
  const missing = [];
  collectWxml(root).forEach((wxmlFile) => {
    const jsFile = path.join(path.dirname(wxmlFile), 'index.js');
    const source = fs.existsSync(jsFile) ? fs.readFileSync(jsFile, 'utf8') : '';
    findHandlers(wxmlFile).forEach((item) => {
      if (!definesHandler(source, item.handler)) {
        missing.push({
          wxml: path.relative(root, wxmlFile).replace(/\\/g, '/'),
          line: item.line,
          handler: item.handler,
          hasJs: fs.existsSync(jsFile),
        });
      }
    });
  });
  return missing;
}

test('所有 wxml 的 bind/catch handler 都能在 index.js 找到定义', () => {
  const wxmlFiles = collectWxml(MINI);
  assert.ok(wxmlFiles.length >= 15, '应扫描到 6 个页面 + 9 个组件的 wxml，实际：' + wxmlFiles.length);
  const total = wxmlFiles.reduce((sum, file) => sum + findHandlers(file).length, 0);
  // 当前是 6 个页面 + 9 个组件、共 87 个绑定；留一点余量，避免正常增删页面时误报。
  assert.ok(total >= 80, '应至少扫到 80 个事件绑定，实际：' + total);
  const missing = collectMissingHandlers(MINI);
  assert.deepStrictEqual(missing, [], '存在未定义的事件 handler：' + JSON.stringify(missing, null, 2));
});

test('静态检查能拦住模板里拼错/漏写的 handler（负例，防止恒真）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yiyi-wxml-'));
  try {
    fs.mkdirSync(path.join(dir, 'pages', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pages', 'demo', 'index.wxml'), '<view bindtap="onTap" catchchange="onMissing">{{x}}</view>');
    fs.writeFileSync(path.join(dir, 'pages', 'demo', 'index.js'), 'Page({ onTap() {} });');
    const missing = collectMissingHandlers(dir);
    assert.strictEqual(missing.length, 1, '只应报出 onMissing，实际：' + JSON.stringify(missing));
    assert.strictEqual(missing[0].handler, 'onMissing');
    assert.strictEqual(missing[0].line, 1);
    assert.strictEqual(missing[0].wxml, 'pages/demo/index.wxml');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('模板里的动态 handler（{{...}}）不会误报', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yiyi-wxml-'));
  try {
    fs.mkdirSync(path.join(dir, 'components', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'components', 'demo', 'index.wxml'), '<view bindtap="{{handler}}"></view>');
    fs.writeFileSync(path.join(dir, 'components', 'demo', 'index.js'), 'Component({ methods: {} });');
    assert.deepStrictEqual(collectMissingHandlers(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('单引号绑定与字符串键 methods 都能识别', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yiyi-wxml-'));
  try {
    fs.mkdirSync(path.join(dir, 'components', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'components', 'demo', 'index.wxml'), "<view bindtap='onSingle' catch:touchmove=\"onMove\"></view>");
    fs.writeFileSync(path.join(dir, 'components', 'demo', 'index.js'), "Component({ methods: { 'onSingle': function () {}, 'onMove': function () {} } });");
    assert.deepStrictEqual(collectMissingHandlers(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('只出现在注释或调用里的名字不算 handler 定义（负例）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yiyi-wxml-'));
  try {
    fs.mkdirSync(path.join(dir, 'pages', 'demo'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pages', 'demo', 'index.wxml'), '<view bindtap="onComment" bindlongpress="onCalled"></view>');
    fs.writeFileSync(
      path.join(dir, 'pages', 'demo', 'index.js'),
      'Page({ /* onComment 只在块注释里 */ });\n// 行尾注释里提到 onCalled() 也不算\nmodule.exports = { run() { this.onCalled(); } };\n'
    );
    const missing = collectMissingHandlers(dir);
    assert.deepStrictEqual(missing.map((m) => m.handler), ['onComment', 'onCalled']);
    assert.strictEqual(missing[0].line, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});