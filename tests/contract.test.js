'use strict';

/**
 * 契约一致性测试：把文档 16.2（错误码）/ 16.3（action 速查）/ 16.4（集合速查）
 * 当作唯一事实来源，和代码里的实际用法对齐。
 *
 * 为什么放在测试而不是 release-check：这些是「表与代码必须互相同步」的约束
 * （文档新增/改名错误码、注册表加减 action、集合改名），是回归测试该锁的东西；
 * release-check 只负责「发布前环境是否齐备」。
 *
 * 解析的是 docs/技术设计文档.md 的 Markdown 表格。改表格格式（换列、去掉反引号、
 * 改章节标题）会让本文件直接报「找不到章节」，这是有意的——发现即同步本测试里的
 * 标记字符串，再核对是否真的改了契约。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/cloud-entry');

const ROOT = path.join(__dirname, '..');
const DOC_PATH = path.join(ROOT, 'docs', '技术设计文档.md');
const CLOUD_DIR = path.join(ROOT, 'cloudfunctions', 'api');
const MINI_DIR = path.join(ROOT, 'miniprogram');
const RELEASE_CHECK = path.join(ROOT, 'scripts', 'release-check.js');
const TICK = String.fromCharCode(96); // 反引号；避免在源码里写字面量，便于本文件自身被扫描

// 扫描目录时跳过的第三方依赖目录（与 scripts/release-check.js 的 SKIP_DIRS 保持同一口径）
const SKIP_DIRS = new Set(['node_modules', 'miniprogram_npm', 'coverage', '.git']);

// 代码里会出现、但不是「用户可见错误码」的全大写字面量（每条都写清原因）。
const NON_USER_CODES = {
  // wx-server-sdk 的 errCode 文案，只在 lib/db-util.js 里判断「文档缺失」还是「读故障」
  DATABASE_DOCUMENT_NOT_EXIST: 'SDK errCode，不是 AppError code',
  // Node 的模块不存在错误码，miniprogram/app.js 用它区分「env.js 缺失」与其它错误
  MODULE_NOT_FOUND: 'Node 模块错误码，不是业务错误码',
  // 首页 / 时间线里的展示文案（对方），不是错误码
  TA: 'UI 文案，不是错误码',
};

// 「错误位点」：错误码只会出现在这些形态里（AppError 构造、failWith、emptyCode 字段、
// code 字段/比较）。用它排除「只在注释或普通文案里提了一句」的假阳性，
// 也避免把注释里的旧码当成实现。
const ERROR_SITE = /AppError\(|ApiError\(|failWith\(|emptyCode\s*[:=]|\bcode\s*[:=]/;

const END_SERVER = '服务端';
const END_CLIENT = '客户端';
const END_RESERVED = '服务端（预留）';
// M14 起功能下线、代码不再抛的码：仍留在表里（客户端可能收到历史码），但不要求实现
const END_RETIRED = '已下线';

function readDoc() {
  return fs.readFileSync(DOC_PATH, 'utf8');
}

function section(start, end) {
  const text = readDoc();
  const a = text.indexOf(start);
  assert.ok(a >= 0, '文档里找不到章节：' + start + '（表格式变了要同步本测试的标记字符串）');
  const b = end ? text.indexOf(end, a + start.length) : -1;
  if (end) assert.ok(b > a, '文档里找不到章节结束标记：' + end + '（同步本测试的标记字符串）');
  return text.slice(a, b > a ? b : undefined);
}

function tableRows(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|'))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
    )
    // 去掉 | --- | --- | 这种分隔行
    .filter((cells) => !cells.every((cell) => /^-+$/.test(cell)));
}

function untick(cell) {
  return String(cell || '').split(TICK).join('').trim();
}

/** 剥掉行注释与块注释，保留字符串字面量（避免把注释里的旧码/说明当实现） */
function stripComments(text) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === TICK) {
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function classifyEnd(raw) {
  const value = String(raw || '').trim();
  assert.ok(
    [END_SERVER, END_CLIENT, END_RESERVED, END_RETIRED].indexOf(value) >= 0,
    '16.2「端」列只能是「服务端 / 客户端 / 服务端（预留） / 已下线」，实际：' + value
  );
  return {
    value,
    client: value === END_CLIENT,
    reserved: value === END_RESERVED,
    retired: value === END_RETIRED,
  };
}

function errorTable() {
  const rows = tableRows(section('### 16.2 错误码', '### 16.3 action 速查'));
  assert.ok(rows.length >= 2, '错误码表为空，文档格式可能变了');
  assert.deepStrictEqual(
    rows[0].map(untick),
    ['code', '含义', '用户提示', '端'],
    '16.2 表头变了，同步本测试'
  );
  const map = new Map();
  for (const cells of rows.slice(1)) {
    assert.strictEqual(cells.length, 4, '16.2 有一行的列数不是 4：' + cells.join(' | '));
    const code = untick(cells[0]);
    assert.match(code, /^[A-Z][A-Z0-9_]+$/, '16.2 有无法识别的码行：' + code);
    assert.ok(!map.has(code), '16.2 错误码重复：' + code);
    const end = classifyEnd(cells[3]);
    map.set(code, {
      meaning: cells[1],
      hint: cells[2],
      end: end.value,
      client: end.client,
      reserved: end.reserved,
      retired: end.retired,
    });
  }
  assert.ok(map.size >= 20, '错误码表只解析到 ' + map.size + ' 条，文档格式可能变了');
  return map;
}

function actionTable() {
  const rows = tableRows(section('### 16.3 action 速查', '### 16.4 集合速查'));
  assert.ok(rows.length >= 2, 'action 表为空，文档格式可能变了');
  assert.strictEqual(untick(rows[0][0]), '域', '16.3 表头变了，同步本测试');
  const list = rows.slice(1).map((cells) => {
    assert.strictEqual(cells.length, 4, '16.3 有一行的列数不是 4：' + cells.join(' | '));
    const action = untick(cells[1]);
    assert.match(action, /^[a-zA-Z]+\.[A-Za-z0-9_]+$/, '16.3 有无法识别的 action：' + action);
    return action;
  });
  assert.ok(list.length >= 20, 'action 表只解析到 ' + list.length + ' 条，文档格式可能变了');
  return list;
}

function collectionTable() {
  const rows = tableRows(section('### 16.4 集合速查', '### 16.5 常用命令'));
  assert.ok(rows.length >= 2, '集合表为空，文档格式可能变了');
  assert.strictEqual(untick(rows[0][0]), '集合', '16.4 表头变了，同步本测试');
  const list = rows.slice(1).map((cells) => {
    assert.strictEqual(cells.length, 4, '16.4 有一行的列数不是 4：' + cells.join(' | '));
    const name = untick(cells[0]);
    assert.match(name, /^[a-z][a-z0-9_]*$/, '16.4 有无法识别的集合名：' + name);
    return name;
  });
  assert.ok(list.length >= 5, '集合表只解析到 ' + list.length + ' 条，文档格式可能变了');
  return list;
}

function walk(dir, acc) {
  const out = acc || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * 收集目录下所有单引号包裹的全大写标识符（错误码都是这个形状）。
 * opts.errorSitesOnly=true 时只收「错误位点」那一行里的字面量，避免注释/普通文案误判。
 */
function codeLiterals(dir, opts) {
  const errorSitesOnly = !!(opts && opts.errorSitesOnly);
  const found = new Map();
  for (const file of walk(dir)) {
    const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, index) => {
      if (errorSitesOnly && !ERROR_SITE.test(line)) return;
      for (const match of line.matchAll(/'([A-Z][A-Z0-9_]+)'/g)) {
        if (!found.has(match[1])) found.set(match[1], path.relative(ROOT, file) + ':' + (index + 1));
      }
    });
  }
  return found;
}

/** 云函数里实际访问的集合：扫描 collection('name') 字面量 */
function usedCollections() {
  const used = new Set();
  for (const file of walk(CLOUD_DIR)) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    for (const match of text.matchAll(/collection\('([a-z][a-z0-9_]*)'\)/g)) used.add(match[1]);
  }
  return [...used].sort();
}

/** release-check 里的集合白名单（发布预检的结构自检依赖它） */
function releaseCheckCollections() {
  const text = fs.readFileSync(RELEASE_CHECK, 'utf8');
  const match = /const expected = \[([^\]]*)\]/.exec(text);
  assert.ok(match, 'release-check.js 里找不到 const expected = [...] 集合白名单');
  return [...match[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]).sort();
}

test('文档 16.2：云函数抛出的错误码都在表里', () => {
  const table = errorTable();
  const used = codeLiterals(CLOUD_DIR);
  const unknown = [...used.keys()].filter(
    (code) => !table.has(code) && !Object.prototype.hasOwnProperty.call(NON_USER_CODES, code)
  );
  assert.deepStrictEqual(
    unknown,
    [],
    '云函数用了文档 16.2 没有的错误码：' + unknown.map((code) => code + ' @' + used.get(code)).join('、')
  );
  // 白名单不能留僵尸项：两端代码里都已经不存在了就删掉，否则白名单会悄悄变宽
  const miniAll = codeLiterals(MINI_DIR);
  for (const code of Object.keys(NON_USER_CODES)) {
    assert.ok(used.has(code) || miniAll.has(code), '白名单里的 ' + code + ' 在代码里已不存在，删掉这条白名单');
  }
});

test('文档 16.2：表里的服务端错误码都有实现（预留与客户端码除外）', () => {
  const table = errorTable();
  // 只看错误位点：注释里提一句码不算「实现了」
  const used = codeLiterals(CLOUD_DIR, { errorSitesOnly: true });
  const missing = [];
  for (const [code, info] of table) {
    if (info.client || info.reserved || info.retired) continue;
    if (!used.has(code)) missing.push(code);
  }
  assert.deepStrictEqual(missing, [], '文档 16.2 写了但云函数没在错误位点用到（表与实现脱节）：' + missing.join('、'));
});

test('文档 16.2：客户端用到的错误码都在表里，兜底码是 INTERNAL_ERROR', () => {
  const table = errorTable();
  const used = codeLiterals(MINI_DIR);
  const unknown = [...used.keys()].filter(
    (code) => !table.has(code) && !Object.prototype.hasOwnProperty.call(NON_USER_CODES, code)
  );
  assert.deepStrictEqual(
    unknown,
    [],
    '小程序端用了文档 16.2 没有的错误码：' + unknown.map((code) => code + ' @' + used.get(code)).join('、')
  );
  const cloudAll = codeLiterals(CLOUD_DIR);
  for (const code of Object.keys(NON_USER_CODES)) {
    assert.ok(used.has(code) || cloudAll.has(code), '白名单里的 ' + code + ' 在代码里已不存在，删掉这条白名单');
  }

  // 业务错误缺 code 时 ApiError 的兜底码不能在表外（此前是 UNKNOWN）
  const api = require('../miniprogram/utils/api');
  const fallback = new api.ApiError('');
  assert.strictEqual(fallback.code, 'INTERNAL_ERROR');
  assert.ok(table.has(fallback.code), '兜底码必须是文档 16.2 里的码');
  assert.strictEqual(fallback.message, '服务开小差了，稍后再试');
});

test('文档 16.2：端列分类与代码位置一致（服务端码在云函数、客户端码在小程序端）', () => {
  const table = errorTable();
  const cloudSites = codeLiterals(CLOUD_DIR, { errorSitesOnly: true });
  const miniSites = codeLiterals(MINI_DIR, { errorSitesOnly: true });
  for (const [code, info] of table) {
    if (info.reserved || info.retired) continue; // 预留码 / 已下线码允许暂时没有实现
    if (info.client) {
      assert.ok(miniSites.has(code), '16.2 标为客户端的 ' + code + ' 没有在小程序端错误位点出现');
      assert.ok(
        !cloudSites.has(code),
        '16.2 标为客户端的 ' + code + ' 出现在云函数错误位点，两端标反了？'
      );
    } else {
      assert.ok(cloudSites.has(code), '16.2 标为服务端的 ' + code + ' 没有在云函数错误位点出现');
    }
  }
});

test('文档 16.3：注册的 action 与表完全一致且都是函数', () => {
  const harness = createHarness();
  const registered = Object.keys(harness.handlers).sort();
  const documented = actionTable().sort();
  assert.deepStrictEqual(registered, documented, '云函数注册表与文档 16.3 不一致');
  registered.forEach((action) => {
    assert.strictEqual(typeof harness.handlers[action], 'function', action + ' 不是函数（注册表写错了）');
  });
});

test('文档 16.4：集合表、云函数实际访问、release-check 白名单三处一致', () => {
  const documented = collectionTable().sort();
  assert.deepStrictEqual(usedCollections(), documented, '云函数访问的集合与文档 16.4 不一致');
  assert.deepStrictEqual(releaseCheckCollections(), documented, 'release-check 的集合白名单与文档 16.4 不一致');
});

test('文档 16.2：每条错误码都有含义与用户提示', () => {
  const table = errorTable();
  for (const [code, info] of table) {
    assert.ok(info.meaning && info.meaning.length >= 2, code + ' 缺含义');
    assert.ok(info.hint && info.hint.length >= 4, code + ' 的用户提示太短：' + info.hint);
    assert.notStrictEqual(info.meaning, info.hint, code + ' 的含义与用户提示不能是同一段文字');
    assert.ok(/[\u4e00-\u9fa5]/.test(info.hint), code + ' 的用户提示必须是中文：' + info.hint);
  }
});
