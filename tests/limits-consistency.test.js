'use strict';

// 参数限制的「单一真相」：文档 6.5 / 7.9 / 7.10 / 7.11 定义长度与分页，
// 服务端 handler 常量负责拒收，客户端 LIMITS 负责输入框 maxlength 与字数提示。
// 三处任何一处单独改动，都会出现「客户端能输入、服务端拒收」或「提示与限制不符」，
// 这组用例把它们锁在一起（对应 11.4 输入校验 / 6.5 参数校验）。
//
// 读取源码时一律先遮蔽注释与字符串，避免「注释里写着旧值 / 字符串里塞常量名」把断言骗过去。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/技术设计文档.md'), 'utf8');
const LIMITS = require('../miniprogram/utils/constants').LIMITS;

const HANDLERS = 'cloudfunctions/api/handlers/';
const MINIPROGRAM = path.join(ROOT, 'miniprogram');

const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// 把注释与字符串遮成等长空格（保留换行，行号不变）
function maskCommentsAndStrings(text) {
  let out = '';
  let i = 0;
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '/' && next === '*') {
      let end = text.indexOf('*/', i + 2);
      if (end < 0) end = text.length;
      for (let k = i; k < end + 2 && k < text.length; k += 1) out += blank(text.charAt(k));
      i = Math.min(end + 2, text.length);
    } else if (ch === '/' && next === '/') {
      let end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      for (let k = i; k < end; k += 1) out += ' ';
      i = end;
    } else if (ch === '"' || ch === "'" || ch === BACKTICK) {
      out += ' ';
      i += 1;
      while (i < text.length) {
        const c = text.charAt(i);
        if (c === BACKSLASH) { out += '  '; i += 2; continue; }
        if (c === ch) { out += ' '; i += 1; break; }
        out += blank(c);
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// 只遮注释、保留字符串（用于匹配 field: '昵称' 这类字符串字面量本身是判断依据的场合）
function maskCommentsOnly(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '/' && next === '*') {
      let end = text.indexOf('*/', i + 2);
      if (end < 0) end = text.length;
      for (let k = i; k < end + 2 && k < text.length; k += 1) out += (text.charAt(k) === '\n' ? '\n' : ' ');
      i = Math.min(end + 2, text.length);
    } else if (ch === '/' && next === '/') {
      let end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      for (let k = i; k < end; k += 1) out += ' ';
      i = end;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
// WXML 注释按 HTML 注释放行，其余内容原样（属性值要保留）
function stripWxmlComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
}

function section(heading, nextHeading) {
  const start = DOC.indexOf(heading);
  assert.ok(start >= 0, '文档缺少章节 ' + heading);
  const end = DOC.indexOf(nextHeading, start);
  assert.ok(end > start, '文档缺少章节 ' + nextHeading);
  return DOC.slice(start, end);
}

function isDigits(text) {
  return typeof text === 'string' && text.length > 0 && Number.isInteger(Number(text)) && String(Number(text)) === text;
}

// 表格行 -> 单元格数组（split 后含首尾空串）
function tableRows(text) {
  return text.split('\n')
    .filter((line) => line.startsWith('|') && line.indexOf('---') === -1)
    .map((line) => line.split('|').map((cell) => cell.trim()));
}

// 从 handler 源码取 const NAME = 123;：cloudfunctions 依赖 wx-server-sdk，不能直接 require
function constantIn(rel, name) {
  const masked = maskCommentsAndStrings(read(rel));
  const re = new RegExp('const ' + name + ' = (\\d+);');
  const match = masked.match(re);
  assert.ok(match, rel + ' 里找不到整数常量 ' + name + '（写法必须是单行 const NAME = 123;）');
  return Number(match[1]);
}

function maxLengthValues() {
  const found = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(abs);
      if (!entry.name.endsWith('.wxml')) return;
      const rel = path.relative(ROOT, abs).split(path.sep).join('/');
      const text = stripWxmlComments(fs.readFileSync(abs, 'utf8'));
      const attr = /maxlength\s*=\s*(["'])([\s\S]*?)\1/g;
      let count = 0;
      let match = attr.exec(text);
      while (match) {
        count += 1;
        found.push({ rel, value: match[2] });
        match = attr.exec(text);
      }
      const mentions = (text.match(/maxlength/g) || []).length;
      if (mentions > count) found.push({ rel, value: '<无法解析：maxlength 可能没加引号>' });
    });
  };
  walk(MINIPROGRAM);
  assert.ok(found.length > 0, 'miniprogram 下没扫描到任何 maxlength，检查扫描目录');
  return found;
}

test('文档 6.5 长度限制表与客户端 LIMITS 一致', () => {
  const rows = tableRows(section('### 6.5 参数校验', '### 6.6'));
  assert.ok(rows.length >= 8, '6.5 表解析到的行数异常（' + rows.length + '），检查表格格式');
  const table = {};
  rows.forEach((cells) => {
    if (cells.length < 5 || !isDigits(cells[2]) || !isDigits(cells[3])) return;
    table[cells[1]] = { min: Number(cells[2]), max: Number(cells[3]) };
  });

  const expected = [
    ['昵称', 'nickname', 1],
    ['心情备注', 'moodNote', 0],
    ['日记正文', 'diary', 1],
    ['愿望标题', 'wishTitle', 1],
    ['愿望备注', 'wishNote', 0],
    ['纪念日标题', 'anniversaryTitle', 1],
    ['纪念日条数', 'anniversaryCount', 0],
    ['记账备注', 'ledgerNote', 0],
    ['记账金额（分）', 'ledgerAmountMax', 1],
    ['记账笔数', 'ledgerMonthCount', 0],
  ];
  expected.forEach(([field, key, min]) => {
    assert.ok(table[field], '6.5 表缺少字段 ' + field);
    assert.strictEqual(table[field].min, min, field + ' 最小长度与文档不符');
    assert.strictEqual(table[field].max, LIMITS[key], field + ' 最大长度：文档 ' + table[field].max + ' 与客户端 LIMITS.' + key + ' ' + LIMITS[key] + ' 不一致');
  });
  assert.deepStrictEqual(table['邀请码'], { min: 6, max: 6 }, '邀请码必须是 6 位（11.5 / 16.2）');
});

test('服务端 handler 的长度上限常量与客户端 LIMITS 一致', () => {
  assert.strictEqual(constantIn(HANDLERS + 'mood.js', 'NOTE_MAX'), LIMITS.moodNote, 'mood.NOTE_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'diary.js', 'CONTENT_MAX'), LIMITS.diary, 'diary.CONTENT_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'wish.js', 'TITLE_MAX'), LIMITS.wishTitle, 'wish.TITLE_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'wish.js', 'NOTE_MAX'), LIMITS.wishNote, 'wish.NOTE_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'wish.js', 'WISH_MAX'), LIMITS.wishCount, 'wish.WISH_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'anniversary.js', 'TITLE_MAX'), LIMITS.anniversaryTitle, 'anniversary.TITLE_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'anniversary.js', 'MAX_COUNT'), LIMITS.anniversaryCount, 'anniversary.MAX_COUNT');
  assert.strictEqual(constantIn(HANDLERS + 'ledger.js', 'NOTE_MAX'), LIMITS.ledgerNote, 'ledger.NOTE_MAX');
  assert.strictEqual(constantIn(HANDLERS + 'ledger.js', 'MONTH_LIMIT'), LIMITS.ledgerMonthCount, 'ledger.MONTH_LIMIT');
  assert.strictEqual(constantIn(HANDLERS + 'ledger.js', 'AMOUNT_MIN'), LIMITS.ledgerAmountMin, 'ledger.AMOUNT_MIN');
  assert.strictEqual(constantIn(HANDLERS + 'ledger.js', 'AMOUNT_MAX'), LIMITS.ledgerAmountMax, 'ledger.AMOUNT_MAX');

  // user.js 的昵称上限写在 validate.string 选项里，不是独立常量；要求紧跟逗号/右花括号，防止 max: 12 + 1 被读成 12
  const masked = maskCommentsOnly(read(HANDLERS + 'user.js'));
  const match = masked.match(/field: '昵称', min: 1, max: (\d+)\s*[,}]/);
  assert.ok(match, 'user.js 里找不到昵称校验（field: 昵称 / min: 1 / max: 整数）');
  assert.strictEqual(Number(match[1]), LIMITS.nickname, '昵称上限与客户端 LIMITS.nickname 不一致');
});

test('输入框 maxlength 全部走数据绑定，昵称不再硬编码 12', () => {
  const values = maxLengthValues();
  values.forEach((item) => {
    const binding = item.value.startsWith('{{') && item.value.endsWith('}}');
    // 邀请码输入框写死 6（文档 8.3.2 / 11.5），只有 bind 页那一处允许字面量
    const inviteCode = item.rel === 'miniprogram/pages/bind/index.wxml' && item.value === '6';
    assert.ok(binding || inviteCode, item.rel + ' 的 maxlength 值 ' + JSON.stringify(item.value) + ' 既不是数据绑定也不是 bind 页邀请码 6');
  });

  const byFile = {};
  values.forEach((item) => {
    if (!byFile[item.rel]) byFile[item.rel] = [];
    byFile[item.rel].push(item.value);
  });
  Object.keys(byFile).forEach((rel) => byFile[rel].sort());

  // 整个仓库只有这些文件有 maxlength；新加输入框必须登记（同时接受 limx 与单/双引号，顺序无关）
  const expected = {
    'miniprogram/pages/profile/index.wxml': ['{{nicknameMax}}'],
    'miniprogram/pages/bind/index.wxml': ['6', '{{nicknameMax}}'],
    'miniprogram/pages/diary/index.wxml': ['{{contentMax}}'],
    'miniprogram/pages/wish/index.wxml': ['{{noteMax}}', '{{titleMax}}'],
    'miniprogram/pages/ledger/index.wxml': ['{{amountMaxLength}}', '{{noteMax}}'],
    'miniprogram/pages/anniversary/index.wxml': ['{{titleMax}}'],
    'miniprogram/components/mood-picker/index.wxml': ['{{noteMax}}'],
    'miniprogram/pages/growth/index.wxml': ['{{noteMax}}', '{{partMax}}', '{{partMax}}', '{{textMax}}', '{{titleMax}}'],
  };
  assert.deepStrictEqual(Object.keys(byFile).sort(), Object.keys(expected).sort(), '出现未登记 / 缺少的含 maxlength 的 wxml：' + Object.keys(byFile).join(', '));
  Object.keys(expected).forEach((rel) => {
    assert.deepStrictEqual(byFile[rel], expected[rel].slice().sort(), rel + ' 的 maxlength 组合与预期不符');
  });

  // 光有绑定还不够：data 里的值必须与 LIMITS 一致；profile / bind 的 nicknameMax 还要真的取自 LIMITS（防硬编码碰巧相等）
  const { installWx, restoreWx, loadPage, loadComponent } = require('./helpers/client-page');
  installWx({});
  try {
    const profile = loadPage('miniprogram/pages/profile/index.js');
    assert.strictEqual(profile.data.nicknameMax, LIMITS.nickname, 'profile 页 nicknameMax 与 LIMITS.nickname 不一致');
    const bind = loadPage('miniprogram/pages/bind/index.js');
    assert.strictEqual(bind.data.nicknameMax, LIMITS.nickname, 'bind 页 nicknameMax 与 LIMITS.nickname 不一致');
    assert.strictEqual(loadPage('miniprogram/pages/diary/index.js').data.contentMax, LIMITS.diary);
    const wish = loadPage('miniprogram/pages/wish/index.js');
    assert.strictEqual(wish.data.titleMax, LIMITS.wishTitle);
    assert.strictEqual(wish.data.noteMax, LIMITS.wishNote);
    const ledger = loadPage('miniprogram/pages/ledger/index.js');
    assert.strictEqual(ledger.data.noteMax, LIMITS.ledgerNote);
    assert.strictEqual(
      ledger.data.amountMaxLength,
      String(Math.floor(LIMITS.ledgerAmountMax / 100)).length + 3,
      '金额输入框的字符上限必须由 LIMITS.ledgerAmountMax 推导，不能硬编码'
    );
    assert.ok(ledger.data.amountMaxLength >= 7, '至少要放得下「10000.00」');
    assert.strictEqual(loadComponent('miniprogram/components/mood-picker/index.js').data.noteMax, LIMITS.moodNote);
  } finally {
    restoreWx();
  }

  const nicknameFromLimits = /nicknameMax:\s*(?:[A-Za-z_$][\w$]*\.)*LIMITS\.nickname\b/;
  ['miniprogram/pages/profile/index.js', 'miniprogram/pages/bind/index.js'].forEach((rel) => {
    assert.match(maskCommentsAndStrings(read(rel)), nicknameFromLimits, rel + ' 的 nicknameMax 必须取自 LIMITS.nickname，不能另写一个数字');
  });
});

test('分页默认值与上限：文档 7.9 / 7.10 / 11.4 与服务端、客户端一致', () => {
  const parseLimitRule = (text, label) => {
    const marker = '`limit` 1–';
    const start = text.indexOf(marker);
    assert.ok(start >= 0, label + ' 规则里找不到「limit 1–」');
    const tail = text.slice(start + marker.length);
    const max = Number(tail.split('，')[0]);
    assert.ok(isDigits(String(max)), label + ' 的分页上限不是整数：' + max);
    const defIndex = tail.indexOf('默认 ');
    assert.ok(defIndex >= 0, label + ' 规则里找不到默认值');
    const after = tail.slice(defIndex + 3);
    let digits = '';
    for (let i = 0; i < after.length; i += 1) {
      const ch = after.charAt(i);
      if (ch >= '0' && ch <= '9') digits += ch;
      else break;
    }
    assert.ok(isDigits(digits), label + ' 的默认分页不是整数：' + digits);
    return { max, def: Number(digits) };
  };

  // 7.9 报平安在 M14 下线，只留历史契约（没有 handler 可对），分页一致性只看日记
  const diaryRule = parseLimitRule(section('### 7.10 日记', '### 7.11 愿望'), '7.10');
  assert.deepStrictEqual(diaryRule, { max: 30, def: 10 });

  assert.strictEqual(constantIn(HANDLERS + 'diary.js', 'LIMIT_MAX'), diaryRule.max);
  assert.strictEqual(constantIn(HANDLERS + 'diary.js', 'LIMIT_DEFAULT'), diaryRule.def);

  const pageSizeOf = (rel) => {
    const masked = maskCommentsAndStrings(read(rel));
    const match = masked.match(/const PAGE_SIZE = (\d+);/);
    assert.ok(match, rel + ' 里找不到整数 PAGE_SIZE');
    return Number(match[1]);
  };
  assert.strictEqual(pageSizeOf('miniprogram/pages/diary/index.js'), diaryRule.def, 'diary 页每页条数应等于接口默认值');

  // 6.5 / 11.4 两处口述都要写明一般 1–50 与日记 1–30；用数字边界匹配，避免 1–500 / 1–300 也算通过
  const rule = (text, value) => new RegExp('(?<!\\d)' + value + '(?!\\d)').test(text);
  const doc65 = section('### 6.5 参数校验', '### 6.6');
  assert.ok(rule(doc65, '1–50') && rule(doc65, '1–30'), '6.5 分页说明要同时写清一般 1–50 与日记 1–30');
  const doc114 = section('### 11.4 输入校验', '### 11.5');
  assert.ok(rule(doc114, '1–50') && rule(doc114, '1–30'), '11.4 limit 规则要同时写清一般 1–50 与日记 1–30');
});
