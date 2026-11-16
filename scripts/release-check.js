#!/usr/bin/env node
'use strict';

// 发布前自动预检（文档 14.6 / 14.7 / 13.11 DoD 的可自动化部分）。
// 用法：node scripts/release-check.js
// 静态检查为主（fs 遍历，沙箱里也能跑）；只有「env.js 是否被 git 跟踪」与「工作区是否干净」两项
// 依赖 git，git 不可用时降级为 TODO/WARN，不会给假 PASS。云开发控制台的集合/索引/隐私指引仍需
// 人工确认，脚本会把这些列成 TODO 提醒。
//
// 与 scripts/check-secrets.js 的分工：那个脚本用 git 列出「已跟踪文件」做密钥扫描（沙箱可能
// spawn 不了 git）；本脚本遍历工作区（跳过 node_modules/.git/本地 env.js 等永远不会提交的文件），
// 再额外抽查少量已跟踪项。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SECRET_PATTERNS = [
  { name: '云环境 ID', regex: /cloud1-[a-z0-9]{10,}/i },
  { name: 'AppSecret/SecretKey', regex: /(AppSecret|SecretId|SecretKey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i },
  { name: '私钥', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
];

// 敏感日志规则：对「整条 console 语句」生效（支持多行 JSON.stringify 负载），
// 只认字段名形式（openid: / coupleId: / content: / note: / inviteCode:），
// 因此 openidTail、coupleIdTail、errCode 这类脱敏字段不会误报。
const SENSITIVE_CONSOLE = [
  { name: '完整 openid', regex: /[{,]\s*["'`]?openid["'`]?\s*(?::|[},])/i },
  { name: '完整 coupleId', regex: /[{,]\s*["'`]?coupleId["'`]?\s*(?::|[},])/i },
  { name: '邀请码', regex: /[{,]\s*["'`]?inviteCode["'`]?\s*(?::|[},])/i },
  { name: '6 位邀请码字面量', regex: /\bcode\s*:\s*["'`]\d{6}["'`]/ },
  { name: '日记正文 / 愿望备注', regex: /[{,]\s*["'`]?(content|note)["'`]?\s*(?::|[},])/i },
  { name: '正文/备注取值', regex: /\.(content|note)\b(?!\s*=|\.(length|size)\b)/i },
  // 裸变量/属性直接进日志：console.log(openid)、console.log('x', openid)、console.log(ctx.openid)
  // 只截尾部（.slice(-6)）或取长度（.length）不算泄露，故排除这两种安全用法。
  { name: '完整 openid', regex: /(\(|,)\s*openid\s*[,)]/i },
  { name: '完整 coupleId', regex: /(\(|,)\s*coupleId\s*[,)]/i },
  // 属性形式同样只放过「真截尾」：slice/substr 且负索引；substring 不支持负索引、slice(-0) 返回整串，都要报
  { name: '完整 openid', regex: /\.openid\b(?!\s*(?:\)\s*)?\.\s*(?:(?:slice|substr)\s*\(\s*-\s*[1-9]\d*\s*\)|length\b))/i },
  { name: '完整 coupleId', regex: /\.coupleId\b(?!\s*(?:\)\s*)?\.\s*(?:(?:slice|substr)\s*\(\s*-\s*[1-9]\d*\s*\)|length\b))/i },
  { name: '手机号', regex: /\b1[3-9]\d{9}\b/ },
  { name: '密钥', regex: /AppSecret|SecretKey|PRIVATE KEY/i },
];

const SKIP_DIRS = new Set(['.git', 'node_modules', 'miniprogram_npm', 'dist', 'coverage', 'logs']);
const SKIP_FILES = new Set([
  'miniprogram/config/env.js', // 本地环境 ID，已被 .gitignore 忽略
  'project.private.config.json',
]);
// 本地私钥/环境文件即使存在也不该被当成「待提交」而报错
const SKIP_FILE_PATTERNS = [/^\.env(\.|$)/, /\.pem$/i, /\.key$/i];

function walk(root, relDir, out, errors) {
  const dir = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (relDir) errors.push('无法读取目录 ' + relDir + '：' + (err && err.message));
    return;
  }
  for (const entry of entries) {
    const rel = relDir ? relDir + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(root, rel, out, errors);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(rel)) continue;
      if (SKIP_FILE_PATTERNS.some((re) => re.test(rel))) continue;
      out.push(rel);
    }
  }
}

function readText(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > 1024 * 1024 || buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/** 扫描一段文本里的密钥模式 → [{line, name}]，导出给单测用 */
function scanTextForSecrets(text) {
  const hits = [];
  if (typeof text !== 'string') return hits;
  text.split('\n').forEach((line, i) => {
    for (const { name, regex } of SECRET_PATTERNS) {
      if (regex.test(line)) hits.push({ line: i + 1, name });
    }
  });
  return hits;
}

/** 把注释与字符串内容替换成等长空格（保留换行），用于「只认真的代码」而不误报注释/字符串里的 console。 */
function maskCommentsAndStrings(text) {
  const chars = text.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < chars.length; k += 1) {
      if (chars[k] !== '\n') chars[k] = ' ';
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      const end = nl === -1 ? text.length : nl;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) { j += 1; break; }
        j += 1;
      }
      blank(i, j);
      i = j;
      continue;
    }
    i += 1;
  }
  return chars.join('');
}

/**
 * 从源码里取出每一条 console.* 语句（括号配平）。注释/字符串内容先被遮成空格，
 * 所以注释掉的 console、字符串里的 "console.log(" 都不会误报；语句文本仍取原文（保留引号里的字段名）。
 * 返回 [{ line, text }]，line 从 1 开始；导出给单测用。
 */
function extractConsoleStatements(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  const masked = maskCommentsAndStrings(text);
  const re = /console\.(log|info|warn|error|debug)\s*\(/g;
  let match;
  while ((match = re.exec(masked))) {
    const start = match.index;
    let i = re.lastIndex;
    let depth = 1;
    while (i < masked.length && depth > 0) {
      const ch = masked[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (depth === 0) break;
      i += 1;
    }
    const line = text.slice(0, start).split('\n').length;
    out.push({ line, text: text.slice(start, Math.min(i + 1, text.length)) });
    re.lastIndex = Math.max(re.lastIndex, i + 1);
  }
  return out;
}

/**
 * 把「脱敏写法」里的 openid / coupleId 抹掉再套规则，避免 String(ctx.openid).slice(-6)、
 * String(ctx.user.coupleId || '').slice(-6) 这类只留尾号的安全用法被误报。
 */
function maskDesensitizedProps(statement) {
  return statement.replace(
    // 只认「真的只取尾部」的写法：slice/substr 且负索引且不是 -0；
    // substring 不支持负索引（substring(-6) 返回整串）、slice(-0) 也返回整串，都不能当脱敏。
    /String\(\s*(?:[\w.$]*\.)?(?:openid|coupleId)\b[^)]*\)\s*\.\s*(?:(?:slice|substr)\s*\(\s*-\s*[1-9]\d*\s*\)|length\b)/gi,
    'MASKED'
  );
}

/** 对一条 console 语句应用敏感规则 → 命中的敏感项名，导出给单测用 */
function scanConsoleStatement(statement) {
  const names = [];
  if (typeof statement !== 'string' || !/console\.(log|info|warn|error|debug)\s*\(/.test(statement)) return names;
  const scanned = maskDesensitizedProps(statement);
  for (const { name, regex } of SENSITIVE_CONSOLE) {
    if (regex.test(scanned)) names.push(name);
  }
  return names;
}

/** 解析 .gitignore（去掉空行与 # 注释，处理目录形式） */
function isIgnoredByGitignore(gitignoreText, target) {
  return String(gitignoreText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .some((entry) => {
      const clean = entry.replace(/\/+$/, '');
      return clean === target || target.startsWith(clean + '/');
    });
}

function checkPages(root, lines) {
  const appPath = path.join(root, 'miniprogram/app.json');
  let app;
  try {
    app = JSON.parse(readText(appPath) || '');
  } catch {
    lines.push({ level: 'FAIL', msg: 'miniprogram/app.json 无法解析' });
    return null;
  }
  const pages = app.pages || [];
  if (!pages.length) lines.push({ level: 'FAIL', msg: 'app.json 没有页面' });
  let missing = 0;
  for (const page of pages) {
    for (const ext of ['.js', '.wxml', '.json']) {
      const file = path.join(root, 'miniprogram', page + ext);
      if (!fs.existsSync(file)) {
        lines.push({ level: 'FAIL', msg: '缺少页面文件 miniprogram/' + page + ext });
        missing += 1;
      }
    }
  }
  if (!missing && pages.length) lines.push({ level: 'PASS', msg: 'app.json 的 ' + pages.length + ' 个页面文件齐全' });

  // 页面里的自定义组件路径要真实存在，避免上线才报「组件未找到」
  let badComponent = 0;
  for (const page of pages) {
    const jsonFile = path.join(root, 'miniprogram', page + '.json');
    const text = readText(jsonFile);
    if (!text) continue;
    let conf;
    try {
      conf = JSON.parse(text);
    } catch {
      lines.push({ level: 'FAIL', msg: page + '.json 无法解析' });
      badComponent += 1;
      continue;
    }
    const using = conf.usingComponents || {};
    for (const tag of Object.keys(using)) {
      const ref = using[tag];
      if (!ref.startsWith('/')) continue;
      const base = path.join(root, 'miniprogram', ref.replace(/^\//, ''));
      if (!fs.existsSync(base + '.js') || !fs.existsSync(base + '.wxml') || !fs.existsSync(base + '.json')) {
        lines.push({ level: 'FAIL', msg: page + ' 引用的组件 ' + tag + ' 缺少文件：' + ref });
        badComponent += 1;
      }
    }
  }
  if (!badComponent) lines.push({ level: 'PASS', msg: '页面自定义组件路径全部存在' });
  return app;
}

/**
 * 结构自检：相对 require 能解析、自定义组件都有注册与文件、云函数只碰预期集合。
 * 这三类问题编译期不报，往往到真机才炸（组件未找到 / 新集合没建权限）。
 */
function checkStructure(root, lines, warnings) {
  const files = [];
  const walkErrors = [];
  walk(root, 'miniprogram', files, walkErrors);
  walk(root, 'cloudfunctions', files, walkErrors);
  for (const err of walkErrors) lines.push({ level: 'WARN', msg: err });


  // 1) 相对 require 路径必须存在
  let badRequire = 0;
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    if (!(rel.startsWith('miniprogram/') || rel.startsWith('cloudfunctions/api/'))) continue;
    const text = readText(path.join(root, rel));
    if (!text) continue;
    const re = /require\(\s*['"](\.[^'"]*)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      const target = path.resolve(path.dirname(path.join(root, rel)), m[1]);
      const candidates = [target, target + '.js', target + '.json', path.join(target, 'index.js'), path.join(target, 'index.json')];
      if (!candidates.some((c) => fs.existsSync(c))) {
        lines.push({ level: 'FAIL', msg: rel + ' 的 require 路径不存在：' + m[1] });
        badRequire += 1;
      }
    }
  }
  if (!badRequire) lines.push({ level: 'PASS', msg: '小程序与云函数里的相对 require 路径全部可解析' });

  // 2) usingComponents 的文件存在，wxml 里用到的自定义组件都已在某个 json 注册
  const registered = new Set();
  let badComponent = 0;
  for (const rel of files) {
    if (!rel.endsWith('.json') || !rel.startsWith('miniprogram/')) continue;
    let conf;
    try {
      conf = JSON.parse(readText(path.join(root, rel)) || '{}');
    } catch {
      lines.push({ level: 'FAIL', msg: rel + ' 无法解析' });
      badComponent += 1;
      continue;
    }
    const using = conf.usingComponents || {};
    for (const tag of Object.keys(using)) {
      registered.add(tag);
      const ref = using[tag];
      const base = ref.startsWith('/')
        ? path.join(root, 'miniprogram', ref.replace(/^\//, ''))
        : path.resolve(path.dirname(path.join(root, rel)), ref);
      const ok = ['.js', '.wxml', '.json'].every((ext) => fs.existsSync(base + ext));
      if (!ok) {
        lines.push({ level: 'FAIL', msg: rel + ' 引用的组件 ' + tag + ' 缺少文件：' + ref });
        badComponent += 1;
      }
    }
  }
  let badTag = 0;
  for (const rel of files) {
    if (!rel.endsWith('.wxml') || !rel.startsWith('miniprogram/')) continue;
    const text = readText(path.join(root, rel)) || '';
    const tags = new Set();
    const tagRe = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\b/g;
    let m;
    while ((m = tagRe.exec(text))) tags.add(m[1]);
    for (const tag of tags) {
      if (!registered.has(tag)) {
        lines.push({ level: 'FAIL', msg: rel + ' 用了未注册的组件 <' + tag + '>' });
        badTag += 1;
      }
    }
  }
  if (!badComponent && !badTag) lines.push({ level: 'PASS', msg: '自定义组件都有文件且已在 json 注册' });

  // 3) 云函数只访问预期集合（新增集合要先去控制台创建 + 配权限 + 建索引）
  const expected = ['users', 'couples', 'bind_invites', 'moods', 'hugs', 'safety_checkins', 'diaries', 'wishes'];
  const used = new Set();
  let badCollection = 0;
  for (const rel of files) {
    if (!rel.endsWith('.js') || !rel.startsWith('cloudfunctions/api/')) continue;
    const text = readText(path.join(root, rel));
    if (!text) continue;
    const re = /collection\(\s*'([A-Za-z_][A-Za-z0-9_]*)'\s*\)/g;
    let m;
    while ((m = re.exec(text))) {
      if (!expected.includes(m[1])) {
        lines.push({ level: 'FAIL', msg: '云函数用了未登记的集合 ' + m[1] + '（需先在云开发控制台创建并配权限）' });
        badCollection += 1;
      }
      used.add(m[1]);
    }
  }
  if (!used.size) warnings.push('没有读到云函数里的集合引用（目录为空？），请确认 cloudfunctions/api 路径');
  if (!badCollection && used.size) {
    lines.push({ level: 'PASS', msg: '云函数只用了预期的 ' + expected.length + ' 个集合（' + Array.from(used).sort().join('、') + '）' });
  }
}

/**
 * 读一个必须是 JSON 对象的配置文件；缺失 / 解析失败 / 顶层不是对象都记 FAIL 并返回 null。
 * 顶层是 null / 数组也算配置写错——否则后续字段检查会全部静默跳过，变成假通过。
 */
function readJsonObject(root, rel, hint, lines) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    lines.push({ level: 'FAIL', msg: '缺少 ' + rel + '（' + hint + '）' });
    return null;
  }
  const text = readText(full);
  if (!text) {
    lines.push({ level: 'FAIL', msg: rel + ' 为空或不是 UTF-8 文本（' + hint + '）' });
    return null;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    lines.push({ level: 'FAIL', msg: rel + ' 无法解析：' + (err && err.message) });
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    lines.push({ level: 'FAIL', msg: rel + ' 内容必须是一个 JSON 对象' });
    return null;
  }
  return data;
}

// 项目要求的最低基础库（隐私开关 __usePrivacyCheck__ 的下限；chooseAvatar 只需 2.21.2+）。
// 注意：本地 project.private.config.json 里若写了别的 libVersion，开发者工具会覆盖这个模拟值。
const MIN_LIB_VERSION = '2.32.3';
// 微信开发者工具的 project.config.json 允许把 libVersion 写成这些符号值：
// latest=最新非灰度、trial=最新（含灰度）、widelyUsed=使用比例最高。
// 前两个一定不比下限旧，视为满足；widelyUsed 无法确认，仍按不满足处理并给出明确文案。
const LIB_VERSION_SYMBOLS = ['latest', 'trial'];

/**
 * 版本号比较：只用于「基础库不得低于下限」这类三段的比较，非法格式一律视为不满足。
 * 前导零（如 02.32.3）不是合法写法，也视为不满足；逐段按数值比较，不能按字符串字典序。
 */
function versionAtLeast(version, minVersion) {
  const parse = (v) => {
    if (typeof v !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)) return null;
    return v.split('.').map((n) => Number(n));
  };
  const a = parse(version);
  const b = parse(minVersion);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}

/**
 * 部署配置自检：云函数的 package.json / config.json 决定云端装什么依赖、开哪些 openapi；
 * project.config.json 的根目录与 appid 错了，开发者工具会传错目录或直接传不上去。
 * 这三处都不在编译期报错，属于「真机/部署时才发现」的坑。
 */
function checkDeployConfig(root, lines) {
  if (!fs.existsSync(path.join(root, 'cloudfunctions/api/index.js'))) {
    lines.push({ level: 'FAIL', msg: '缺少 cloudfunctions/api/index.js（云函数入口）' });
  }

  const pkg = readJsonObject(root, 'cloudfunctions/api/package.json', '云端安装依赖要用', lines);
  if (pkg) {
    // main 与 triggers 按文档 6.12 的团队约定显式声明，不依赖运行时默认值
    const mainOk = pkg.main === 'index.js';
    if (!mainOk) {
      lines.push({ level: 'FAIL', msg: 'cloudfunctions/api/package.json 的 main 必须是 index.js' });
    }
    const sdk = pkg.dependencies && pkg.dependencies['wx-server-sdk'];
    if (!sdk) {
      lines.push({ level: 'FAIL', msg: 'cloudfunctions/api/package.json 缺少 wx-server-sdk 依赖' });
    }
    if (mainOk && sdk) {
      lines.push({ level: 'PASS', msg: '云函数 package.json 依赖与入口正确（wx-server-sdk ' + sdk + '）' });
    }
  }

  const cfg = readJsonObject(root, 'cloudfunctions/api/config.json', 'openapi 权限/触发器配置', lines);
  if (cfg) {
    const openapi = cfg.permissions && cfg.permissions.openapi;
    if (!Array.isArray(openapi)) {
      lines.push({ level: 'FAIL', msg: 'cloudfunctions/api/config.json 的 permissions.openapi 必须是数组' });
    }
    if (!Array.isArray(cfg.triggers)) {
      lines.push({ level: 'FAIL', msg: 'cloudfunctions/api/config.json 的 triggers 必须是数组' });
    }
    if (Array.isArray(openapi) && Array.isArray(cfg.triggers)) {
      lines.push({ level: 'PASS', msg: '云函数 config.json 权限/触发器格式正确（openapi ' + openapi.length + ' 项）' });
    }
  }

  const proj = readJsonObject(root, 'project.config.json', '开发者工具项目配置', lines);
  if (proj) {
    let projProblems = 0;
    if (proj.miniprogramRoot !== 'miniprogram/') {
      lines.push({ level: 'FAIL', msg: 'project.config.json 的 miniprogramRoot 必须是 miniprogram/' });
      projProblems += 1;
    }
    if (proj.cloudfunctionRoot !== 'cloudfunctions/') {
      lines.push({ level: 'FAIL', msg: 'project.config.json 的 cloudfunctionRoot 必须是 cloudfunctions/' });
      projProblems += 1;
    }
    if (proj.compileType !== 'miniprogram') {
      lines.push({ level: 'FAIL', msg: 'project.config.json 的 compileType 必须是 miniprogram' });
      projProblems += 1;
    }
    if (typeof proj.appid !== 'string' || !/^wx[0-9a-f]{16}$/.test(proj.appid)) {
      lines.push({ level: 'FAIL', msg: 'project.config.json 的 appid 不合法' });
      projProblems += 1;
    }
    // 项目按 MIN_LIB_VERSION 的下限自测（而不是文档 16.6 的 3.18.0），已知偏差已记录。
    if (proj.libVersion === undefined || proj.libVersion === null || proj.libVersion === '') {
      lines.push({ level: 'FAIL', msg: 'project.config.json 缺少 libVersion（最低基础库 ' + MIN_LIB_VERSION + '）' });
      projProblems += 1;
    } else if (LIB_VERSION_SYMBOLS.indexOf(proj.libVersion) >= 0) {
      // latest / trial 一定不比下限旧，放行（避免为测最新基础库改成符号值就误报）
    } else if (proj.libVersion === 'widelyUsed') {
      lines.push({ level: 'FAIL', msg: 'project.config.json 的 libVersion 是 widelyUsed，无法确认 ≥ ' + MIN_LIB_VERSION + '，请改成三段数字' });
      projProblems += 1;
    } else if (!versionAtLeast(proj.libVersion, MIN_LIB_VERSION)) {
      lines.push({ level: 'FAIL', msg: 'project.config.json 的 libVersion 必须 ≥ ' + MIN_LIB_VERSION + '（当前：' + String(proj.libVersion) + '）' });
      projProblems += 1;
    }
    if (!projProblems) {
      lines.push({ level: 'PASS', msg: 'project.config.json 的根目录 / appid / compileType / 基础库 ≥ ' + MIN_LIB_VERSION + ' 正确' });
    }
  }
}

function checkTemplate(root, lines) {
  const candidates = [
    'miniprogram/pages/example',
    'miniprogram/pages/quickstart',
    'miniprogram/pages/quickstart-functions',
    'cloudfunctions/quickstartFunctions',
  ];
  const found = candidates.filter((rel) => fs.existsSync(path.join(root, rel)));
  if (found.length) {
    lines.push({ level: 'FAIL', msg: '还有模板残留目录：' + found.join('、') });
  } else {
    lines.push({ level: 'PASS', msg: '没有 pages/example、quickstartFunctions 等模板残留' });
  }
}

/** 从 constants.js 解析默认头像路径；checkAssets 与包体预算共用，避免两处硬编码不一致 */
function resolveAvatar(root) {
  const constants = readText(path.join(root, 'miniprogram/utils/constants.js'));
  const m = String(constants || '').match(/DEFAULT_AVATAR\s*=\s*'([^']+)'/);
  const display = m ? m[1] : '/images/avatars/default.png';
  // 统一成 walkPackage 使用的相对路径（miniprogram/ 开头、正斜杠）
  return { display: display, rel: 'miniprogram/' + display.replace(/^\//, ''), constantsOk: Boolean(constants) };
}

function checkAssets(root, lines, warnings) {
  const avatar = resolveAvatar(root);
  if (!avatar.constantsOk) {
    warnings.push('读不到 miniprogram/utils/constants.js，默认头像按约定路径检查');
    lines.push({ level: 'WARN', msg: '读不到 miniprogram/utils/constants.js，按约定路径检查默认头像' });
  }
  if (fs.existsSync(path.join(root, avatar.rel))) {
    lines.push({ level: 'PASS', msg: '默认头像存在：' + avatar.display });
  } else {
    lines.push({ level: 'FAIL', msg: '默认头像缺失：' + avatar.rel });
  }
}

// ---- 文档 8.8 资源与包体预算 ----
// 只做静态预算检查（图片位置/单张体积/默认头像尺寸/小程序包体总量），不含真机渲染性能。
// 云函数不计入小程序包体；miniprogram_npm 若存在会一起统计（它会被打进包）。
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_MAX_BYTES = 100 * 1024;
const PACKAGE_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_SIZE = 200;

/**
 * 校验默认头像是结构完整的 PNG 并读取 IHDR 宽高；不依赖图片库。
 * 要求 PNG 签名 + IHDR + 结尾 IEND，避免「只有 33 字节头」或截断文件蒙混过关。
 * 默认头像很小（文档 8.8 要求 200×200），整文件读入即可，不做流式读取。
 */
function readPngSize(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (buf.length < 45) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function walkPackage(root, relDir, out, warnings) {
  const dir = path.join(root, relDir);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warnings.push('无法读取 ' + relDir + '：' + (err && err.message));
    return;
  }
  for (const entry of entries) {
    const rel = relDir + '/' + entry.name;
    if (entry.isDirectory()) {
      // 包体统计不含 .git/node_modules；miniprogram_npm 属于包体，保留统计
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walkPackage(root, rel, out, warnings);
    } else if (entry.isFile()) {
      try {
        out.push({ rel: rel, size: fs.statSync(path.join(root, rel)).size });
      } catch (err) {
        warnings.push('无法读取 ' + rel + ' 的大小：' + (err && err.message));
      }
    } else if (entry.isSymbolicLink()) {
      warnings.push('跳过符号链接 ' + rel + '（包体统计不含软链，请确认上传包里没有链接）');
    }
  }
}

function checkPackageBudget(root, lines, warnings) {
  const files = [];
  walkPackage(root, 'miniprogram', files, warnings);
  if (!files.length) {
    warnings.push('miniprogram 目录为空或读不到，跳过图片与包体预算检查');
    lines.push({ level: 'WARN', msg: '读不到 miniprogram 目录，跳过图片与包体预算检查' });
    return;
  }

  const images = files.filter((f) => IMAGE_EXT.test(f.rel));
  const outside = images.filter((f) => !f.rel.startsWith('miniprogram/images/'));
  const oversize = images.filter((f) => f.size > IMAGE_MAX_BYTES);
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);

  if (outside.length) {
    lines.push({ level: 'FAIL', msg: '图片必须放在 miniprogram/images/ 下（发现：' + outside.map((f) => f.rel).slice(0, 5).join('、') + '）' });
  }
  if (oversize.length) {
    lines.push({
      level: 'FAIL',
      msg: '单张图片不能超过 100KB（发现：' + oversize.map((f) => f.rel + ' ' + f.size + ' 字节').slice(0, 5).join('、') + '）',
    });
  }
  // 文档 8.8 是「总包体 < 2MB」，恰好 2MB 也不合规，所以用 >= 判 FAIL
  if (totalBytes >= PACKAGE_MAX_BYTES) {
    lines.push({
      level: 'FAIL',
      msg: '小程序包体不能超过 2MB（当前 ' + totalBytes + ' 字节，' + files.length + ' 个文件）',
    });
  }

  // 默认头像：路径从 constants.js 解析（与 checkAssets 同源），要求结构完整的 200×200 PNG。
  // 文件缺失由 checkAssets 报 FAIL，这里不再重复；PASS 文案也不会硬说「默认头像 200×200」。
  const avatar = resolveAvatar(root);
  const avatarFile = files.find((f) => f.rel === avatar.rel);
  let avatarOk = false;
  if (avatarFile) {
    const size = readPngSize(path.join(root, avatar.rel));
    if (!size) {
      lines.push({ level: 'FAIL', msg: '默认头像不是可解析的 PNG（需要签名 / IHDR / IEND）：' + avatar.rel });
    } else if (size.width !== AVATAR_SIZE || size.height !== AVATAR_SIZE) {
      lines.push({ level: 'FAIL', msg: '默认头像尺寸应为 200×200（当前 ' + size.width + '×' + size.height + '）' });
    } else {
      avatarOk = true;
    }
  }

  if (!outside.length && !oversize.length && totalBytes < PACKAGE_MAX_BYTES && avatarOk) {
    const maxImage = images.reduce((max, f) => Math.max(max, f.size), 0);
    lines.push({
      level: 'PASS',
      msg:
        '图片资源与包体符合 8.8（' + images.length + ' 张图片、单张最大 ' + Math.round(maxImage / 1024) + 'KB、包体 ' +
        Math.floor(totalBytes / 1024) + 'KB < 2MB、默认头像 200×200）',
    });
  }
}

function checkPrivacy(app, root, lines) {
  if (!app || app.__usePrivacyCheck__ !== true) {
    lines.push({ level: 'FAIL', msg: 'app.json 未开启 __usePrivacyCheck__（隐私授权会被拦截）' });
  } else if (!app.window || app.window.pageOrientation !== 'portrait') {
    lines.push({ level: 'FAIL', msg: 'app.json 未声明 pageOrientation: portrait（文档 9.9）' });
  } else {
    lines.push({ level: 'PASS', msg: '隐私开关与竖屏声明已配置' });
  }

  let wired = 0;
  for (const page of ['pages/home/index', 'pages/bind/index', 'pages/profile/index']) {
    const wxml = readText(path.join(root, 'miniprogram', page + '.wxml')) || '';
    const json = readText(path.join(root, 'miniprogram', page + '.json')) || '';
    if (!wxml.includes('<privacy-guard') || !json.includes('/components/privacy-guard/index')) {
      lines.push({ level: 'FAIL', msg: page + ' 没有接入 privacy-guard 隐私弹窗' });
    } else {
      wired += 1;
    }
  }
  if (wired === 3) lines.push({ level: 'PASS', msg: '首页/绑定/我的三页都接入了隐私弹窗' });

  const profileWxml = readText(path.join(root, 'miniprogram/pages/profile/index.wxml')) || '';
  if (!profileWxml.includes('onOpenPrivacy')) {
    lines.push({ level: 'FAIL', msg: '我的页缺少「隐私保护指引」入口（14.7）' });
  } else {
    lines.push({ level: 'PASS', msg: '我的页有隐私保护指引入口' });
  }
}

function checkSecrets(root, lines) {
  const files = [];
  const walkErrors = [];
  walk(root, '', files, walkErrors);
  for (const err of walkErrors) lines.push({ level: 'WARN', msg: err });
  let hits = 0;
  for (const rel of files) {
    if (rel === 'scripts/check-secrets.js' || rel === 'scripts/release-check.js') continue;
    const text = readText(path.join(root, rel));
    if (!text) continue;
    for (const hit of scanTextForSecrets(text)) {
      lines.push({ level: 'FAIL', msg: rel + ':' + hit.line + ' 可能是' + hit.name });
      hits += 1;
    }
  }
  if (!hits) lines.push({ level: 'PASS', msg: '未发现云环境 ID / AppSecret / 私钥（不含本地 env.js）' });

  const gitignore = readText(path.join(root, '.gitignore')) || '';
  const missing = ['miniprogram/config/env.js', 'project.private.config.json']
    .filter((p) => !isIgnoredByGitignore(gitignore, p));
  if (missing.length) {
    lines.push({ level: 'FAIL', msg: '.gitignore 缺少：' + missing.join('、') });
  } else {
    lines.push({ level: 'PASS', msg: '本地 env.js / project.private.config.json 已被 .gitignore 排除' });
  }
  if (!fs.existsSync(path.join(root, 'miniprogram/config/env.example.js'))) {
    lines.push({ level: 'FAIL', msg: '缺少 miniprogram/config/env.example.js' });
  }
}

function checkConsole(root, lines, warnings) {
  const files = [];
  const walkErrors = [];
  walk(root, 'miniprogram', files, walkErrors);
  walk(root, 'cloudfunctions', files, walkErrors);
  for (const err of walkErrors) lines.push({ level: 'WARN', msg: err });
  let total = 0;
  let bad = 0;
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const text = readText(path.join(root, rel));
    if (!text) continue;
    for (const statement of extractConsoleStatements(text)) {
      total += 1;
      const names = scanConsoleStatement(statement.text);
      if (!names.length) continue;
      lines.push({ level: 'FAIL', msg: rel + ':' + statement.line + ' 日志可能带出' + names.join('、') });
      bad += 1;
    }
  }
  if (!total) warnings.push('没有扫描到任何 console 日志（目录为空？），请确认检查路径');
  if (!bad) {
    lines.push({ level: 'PASS', msg: '没有把 openid / coupleId / 邀请码 / 正文写进 console（共 ' + total + ' 条日志，均为脱敏/错误类型）' });
  }
}

function checkGit(root, lines, warnings) {
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (probe.error || probe.status !== 0) {
    warnings.push('无法执行 git（沙箱限制？）→ 请手动确认 env.js / project.private.config.json 没被跟踪');
    lines.push({ level: 'TODO', msg: '手动确认：git ls-files miniprogram/config/env.js 输出为空' });
    lines.push({ level: 'TODO', msg: '手动确认：git ls-files project.private.config.json 输出为空' });
    return;
  }
  const tracked = spawnSync('git', ['ls-files', 'miniprogram/config/env.js'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (tracked.error || tracked.status !== 0) {
    warnings.push('git ls-files 执行失败 → 请手动确认 miniprogram/config/env.js 没被跟踪');
    lines.push({ level: 'TODO', msg: '手动确认：git ls-files miniprogram/config/env.js 输出为空' });
  } else if (tracked.stdout && tracked.stdout.trim()) {
    lines.push({ level: 'FAIL', msg: 'miniprogram/config/env.js 被 Git 跟踪了，请 git rm --cached 并确认 .gitignore' });
  } else {
    lines.push({ level: 'PASS', msg: 'miniprogram/config/env.js 未被 Git 跟踪' });
  }
  const privateTracked = spawnSync('git', ['ls-files', 'project.private.config.json'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (privateTracked.error || privateTracked.status !== 0) {
    warnings.push('git ls-files 执行失败 → 请手动确认 project.private.config.json 没被跟踪');
    lines.push({ level: 'TODO', msg: '手动确认：git ls-files project.private.config.json 输出为空' });
  } else if (privateTracked.stdout && privateTracked.stdout.trim()) {
    lines.push({ level: 'FAIL', msg: 'project.private.config.json 被 Git 跟踪了，请 git rm --cached 并确认 .gitignore' });
  } else {
    lines.push({ level: 'PASS', msg: 'project.private.config.json 未被 Git 跟踪' });
  }
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (status.stdout && status.stdout.trim()) {
    warnings.push('工作区有未提交改动，发布前应为干净状态');
  }
}

function runChecks(root) {
  const lines = [];
  const warnings = [];
  const app = checkPages(root, lines);
  checkStructure(root, lines, warnings);
  checkDeployConfig(root, lines);
  checkTemplate(root, lines);
  checkAssets(root, lines, warnings);
  checkPackageBudget(root, lines, warnings);
  checkPrivacy(app, root, lines);
  checkConsole(root, lines, warnings);
  checkSecrets(root, lines);
  checkGit(root, lines, warnings);

  lines.push({ level: 'TODO', msg: '云开发控制台确认：8 个集合 + 权限「所有用户不可读写」+ 索引（见 docs/开发进度.md）' });
  lines.push({ level: 'TODO', msg: '云开发控制台确认：cloudfunctions/api 已重新上传部署（最近一次改动之后）' });
  lines.push({ level: 'TODO', msg: '云开发控制台确认：cloudfunctions/api 超时 10s、内存 256MB（文档 16.6；默认超时可能只有 3s，冷启动会偶发失败）' });
  lines.push({ level: 'TODO', msg: '微信公众平台确认：用户隐私保护指引（头像/昵称）已声明' });
  lines.push({ level: 'TODO', msg: '双人真机按 docs/M6-真机验收与发布.md 跑 F1–F8，并导出一次数据库备份' });

  const failed = lines.filter((l) => l.level === 'FAIL');
  return { ok: failed.length === 0, lines, warnings };
}

function main() {
  const root = path.resolve(__dirname, '..');
  const result = runChecks(root);
  for (const line of result.lines) {
    console.log('[' + line.level + '] ' + line.msg);
  }
  for (const warning of result.warnings) console.log('[WARN] ' + warning);
  console.log('');
  if (result.ok) {
    console.log('release-check: 静态预检通过，请继续完成上面的 TODO 项。');
  } else {
    console.error('release-check: 有 FAIL 项，修完再发布。');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  runChecks,
  checkStructure,
  checkDeployConfig,
  checkPackageBudget,
  versionAtLeast,
  scanTextForSecrets,
  scanConsoleStatement,
  extractConsoleStatements,
  isIgnoredByGitignore,
};
