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

// 内置组件与模板语法标签：不需要 usingComponents 注册，扫 wxml 时必须放行。
// 清单对照微信官方「内置组件」一节；slot / block / template / import / include / wxs 属模板语法标签。
const BUILTIN_TAGS = new Set([
  // 基础组件（不带连字符）
  'view', 'text', 'image', 'icon', 'button', 'input', 'textarea', 'checkbox', 'checkbox-group',
  'radio', 'radio-group', 'form', 'label', 'picker', 'picker-view', 'picker-view-column',
  'slider', 'switch', 'navigator', 'progress', 'rich-text', 'swiper', 'swiper-item', 'video',
  'camera', 'map', 'canvas', 'audio', 'ad', 'editor',
  // 模板语法标签
  'slot', 'block', 'template', 'import', 'include', 'wxs',
  // 带连字符的内置组件
  'scroll-view', 'movable-area', 'movable-view', 'cover-view', 'cover-image',
  'live-player', 'live-pusher', 'open-data', 'web-view', 'ad-custom',
  'functional-page-navigator', 'official-account', 'match-media', 'page-meta', 'navigation-bar',
  'root-portal', 'voip-room', 'channel-live', 'channel-video', 'inline-payment-panel',
  'grid-view', 'list-view', 'sticky-header', 'sticky-section', 'share-element',
  'keyboard-accessory', 'page-container', 'store-home', 'store-product', 'store-coupon',
  'store-gift', 'store-order',
]);

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

  // 2) usingComponents：组件文件存在；wxml 用到的自定义组件必须在本页/本组件作用域注册。
  //    标签名按小写字母 / 数字 / - / _ 收集（WXML 不允许大写标签）；内置组件与模板语法标签放行。
  //    旧实现把所有 json 的 usingComponents 合成一个全局集合，于是「在 bind 页注册、却在 home 页使用」
  //    这种真机必然报「组件未找到」的写法会漏过预检；只有 app.json 的 usingComponents 才是全局生效的。
  const scopeTags = new Map(); // json 相对路径 -> 该作用域注册的标签
  const globalTags = new Set(); // app.json 的 usingComponents（全局生效）
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
    const tags = new Set();
    for (const tag of Object.keys(using)) {
      tags.add(tag);
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
    scopeTags.set(rel, tags);
    if (rel === 'miniprogram/app.json') for (const tag of tags) globalTags.add(tag);
  }
  let badTag = 0;
  for (const rel of files) {
    if (!rel.endsWith('.wxml') || !rel.startsWith('miniprogram/')) continue;
    const raw = readText(path.join(root, rel));
    if (!raw) continue;
    // wxml 注释里的示例标签不算使用（避免 <!-- <foo-bar /> --> 误报）
    const text = raw.replace(/<!--[\s\S]*?-->/g, ' ');
    // 注册域取同目录同名 json（pages/home/index.wxml → index.json；components/x/card.wxml → card.json）
    const owner = rel.replace(/\.wxml$/, '.json');
    const scoped = scopeTags.get(owner);
    const tags = new Set();
    const tagRe = /<([a-z][a-z0-9_-]*)\b/g;
    let m;
    while ((m = tagRe.exec(text))) tags.add(m[1]);
    for (const tag of tags) {
      if (BUILTIN_TAGS.has(tag)) continue;
      if (globalTags.has(tag) || (scoped && scoped.has(tag))) continue;
      lines.push({
        level: 'FAIL',
        msg: rel + ' 用了未注册的组件 <' + tag + '>（usingComponents 按页面/组件隔离，' + owner + ' 与 app.json 都没声明）',
      });
      badTag += 1;
    }
  }
  if (!badComponent && !badTag) lines.push({ level: 'PASS', msg: '自定义组件文件齐全且按页面/组件作用域注册（app.json 全局注册也放行）' });

  // 3) 云函数只访问预期集合（新增集合要先去控制台创建 + 配权限 + 建索引）
  const expected = ['users', 'couples', 'bind_invites', 'moods', 'anniversaries', 'safety_checkins', 'diaries', 'wishes', 'ledger_entries', 'pauses', 'growth_tasks', 'ledger_view_grants'];
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
      // 只校验「是数组」不够：openapi 写成 [] 时代码会静默 fail-open（内容安全等于没接），
      // 触发器丢了则订阅提醒永远不发，两者都不会在运行时报错，只能在这里拦
      const REQUIRED_OPENAPI = ['security.msgSecCheck', 'subscribeMessage.send'];
      const missingApi = REQUIRED_OPENAPI.filter((name) => openapi.indexOf(name) === -1);
      if (missingApi.length) {
        lines.push({ level: 'FAIL', msg: 'cloudfunctions/api/config.json 缺少云调用权限：' + missingApi.join('、') });
      }
      const trigger = cfg.triggers.find((t) => t && t.name === 'reminder-tick');
      if (!trigger) {
        lines.push({ level: 'FAIL', msg: 'cloudfunctions/api/config.json 缺少 reminder-tick 定时触发器' });
      } else if (trigger.type !== 'timer' || !trigger.config) {
        lines.push({ level: 'FAIL', msg: 'reminder-tick 触发器必须是 timer 类型并带 cron 配置' });
      }
      if (!missingApi.length && trigger && trigger.type === 'timer' && trigger.config) {
        lines.push({ level: 'PASS', msg: '云函数 config.json 权限/触发器正确（openapi ' + openapi.length + ' 项，reminder-tick ' + trigger.config + '）' });
      }
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

// 文档 13.11 DoD「没有未处理的 Promise rejection」：客户端调用 api.call 必须被 await / return 或
// 紧跟的 .then / .catch 链处理。悬空调用在真机上表现为「点了没反应」，或直接冒未捕获 rejection。
// 判定前先用 maskCommentsAndStrings 遮掉注释与字符串，注释里的 api.call 不会误报、
// 行尾注释里的 .then 也不会让悬空调用漏报；只扫 miniprogram 下的生产代码（测试用自己的桩，不在此列）。
// 已知限制（当前仓库不触发，记录以便评审）：
//   - 模板串插值里的调用（__api.call() 写在反引号内）会被整段遮掉；
//   - 「语句里出现过 await」按整条语句近似判断，同一数组里其它悬空调用可能被放过；
//   - 只认 api.call / api?.call 形式，api['call'] 不识别。
//   - 赋值 lookahead 里 await foo(name) 会把仅作参数出现的 name 当作已处理（低风险近似）。
const STATEMENT_SCAN_MAX = 5000; // 回溯语句起点的上限，防御压缩成超长单行的代码
const ASSIGN_SCAN_MAX = 3000; // 赋值后查找 await/return/.then 的范围

// 从 open（'(' 的下标）找到同层 ')' 之后的位置，跳过参数里的对象/数组/嵌套调用
function findParenEnd(flat, open) {
  let depth = 0;
  for (let k = open; k < flat.length; k += 1) {
    const ch = flat[k];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

// 调用表达式结束后是否紧跟 .then / .catch（允许换行、中间夹 .then 等方法链）
function followedByCatch(flat, from) {
  let p = from;
  while (p < flat.length) {
    while (p < flat.length && /\s/.test(flat[p])) p += 1;
    if (flat[p] !== '.') return false;
    const m = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(flat.slice(p, p + 80));
    if (!m) return false;
    const open = p + m[0].length - 1;
    const callEnd = findParenEnd(flat, open);
    if (callEnd === -1) return false;
    if (m[1] === 'then' || m[1] === 'catch') return true;
    p = callEnd;
  }
  return false;
}

// 从调用位置向前找语句起点：跳过配对的 () [] {}，只在同层 ';' 或块 '{' 处截止；
// 已知限制：对象字面量被当成块边界时（await Promise.all([{ p: api.call() }])）
// 可能误报，真实仓库无此写法，保留为近似。
function findStatementStart(flat, pos) {
  let depth = 0;
  let scanned = 0;
  let truncated = false;
  for (let k = pos - 1; k >= 0 && scanned < STATEMENT_SCAN_MAX; k -= 1, scanned += 1) {
    const ch = flat[k];
    if (ch === ')' || ch === ']' || ch === '}') depth += 1;
    else if (ch === '(' || ch === '[') {
      if (depth > 0) depth -= 1;
    } else if (ch === '{') {
      if (depth > 0) depth -= 1;
      else return { start: k + 1, truncated: false };
    } else if (ch === ';' && depth === 0) return { start: k + 1, truncated: false };
  }
  if (scanned >= STATEMENT_SCAN_MAX && pos - scanned > 0) truncated = true;
  return { start: Math.max(0, pos - scanned), truncated };
}

function checkPromiseHandling(root, lines, warnings) {
  const files = [];
  const walkErrors = [];
  walk(root, 'miniprogram', files, walkErrors);
  for (const err of walkErrors) lines.push({ level: 'WARN', msg: err });
  let calls = 0;
  let callLines = 0;
  let bad = 0;
  let skipped = 0;
  const truncatedWarned = new Set();
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const text = readText(path.join(root, rel));
    if (text === null) {
      skipped += 1;
      warnings.push('跳过无法读取的客户端文件（>1MB 或非文本），未检查未处理 Promise：' + rel);
      continue;
    }
    const masked = maskCommentsAndStrings(text);
    const rows = masked.split(/\r?\n/);
    // rows 用 \n 重新拼成 flat，行号与字符位置一一对应，便于跨行判断 await 与链式调用
    const starts = [];
    let acc = 0;
    for (const row of rows) {
      starts.push(acc);
      acc += row.length + 1;
    }
    const flat = rows.join('\n');
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const re = /\bapi\??\.call\s*\(/g;
      let match;
      let lineHasCall = false;
      while ((match = re.exec(row))) {
        calls += 1;
        lineHasCall = true;
        const callAbs = starts[i] + match.index;
        const open = callAbs + match[0].length - 1;
        const callEnd = findParenEnd(flat, open);
        // ① 调用表达式之后紧跟 .then / .catch（含多行参数、换行后的链式调用）
        let handled = callEnd !== -1 && followedByCatch(flat, callEnd);
        if (!handled) {
          // ② 同一语句前面的 await / return：覆盖 await Promise.all([...]) 换行、
          //    const x = await Promise.all([api.call(.., { 参数 }), ...]) 等写法
          const st = findStatementStart(flat, callAbs);
          if (st.truncated) {
            const warnKey = rel + ':' + (i + 1);
            if (!truncatedWarned.has(warnKey)) {
              truncatedWarned.add(warnKey);
              warnings.push('语句回扫达到 ' + STATEMENT_SCAN_MAX + ' 字符上限，可能有未检查的 await：' + warnKey);
            }
          }
          const statement = flat.slice(st.start, callAbs);
          if (/\b(?:await|return)\b/.test(statement)) handled = true;
          // ③ 箭头函数隐式返回（const f = () => api.call(...)）
          if (!handled && /=>\s*$/.test(statement)) handled = true;
          // ④ 先存进变量、后面再 await / return / .then / .catch（支持先声明后赋值与一层别名）
          if (!handled) {
            const assigned = /([A-Za-z_$][\w$]*)\s*=\s*$/.exec(statement);
            if (assigned && statement.slice(0, assigned.index).trim() !== '==') {
              const name = assigned[1];
              const look = flat.slice(callEnd === -1 ? callAbs : callEnd, (callEnd === -1 ? callAbs : callEnd) + ASSIGN_SCAN_MAX);
              const used = new RegExp('\\b(?:await|return)\\b[^;]{0,300}?\\b' + name + '\\b|\\b' + name + '\\s*\\.\\s*(?:then|catch)\\s*\\(').test(look);
              let aliased = false;
              if (!used) {
                const alias = new RegExp('\\b(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*' + name + '\\b').exec(look);
                if (alias) {
                  aliased = new RegExp('\\b(?:await|return)\\b[^;]{0,300}?\\b' + alias[1] + '\\b|\\b' + alias[1] + '\\s*\\.\\s*(?:then|catch)\\s*\\(').test(look);
                }
              }
              if (used || aliased) handled = true;
            }
          }
        }
        if (!handled) {
          bad += 1;
          lines.push({ level: 'FAIL', msg: rel + ':' + (i + 1) + ' 的 api.call 没有被 await / .then / .catch 处理（13.11 未处理的 Promise）' });
        }
      }
      if (lineHasCall) callLines += 1;
    }
  }
  if (!calls) warnings.push('没有扫描到客户端 api.call 调用（目录为空？），请确认 miniprogram 路径');
  else if (!bad) {
    const skippedTip = skipped ? '（已跳过 ' + skipped + ' 个无法读取的文件）' : '';
    lines.push({ level: 'PASS', msg: '客户端 api.call 都已被 await / .then / .catch / return 处理（' + calls + ' 个调用 / ' + callLines + ' 行，无未处理 Promise）' + skippedTip });
  }
}

// 文档 11.9「客户端全局搜索 wx.cloud.database，结果为空」「唯一云函数入口」：
// 客户端直连数据库会绕过云函数的成员校验与限流，直调别的云函数会绕开 utils/api.js 的错误归一，
// 文档 11.9 要求「客户端全局搜索 wx.cloud.database，结果为空」，另有架构约定「云函数调用只经 utils/api.js」。
// 只扫 miniprogram 下的生产代码；注释与字符串先遮掉（示例代码不该误报），再按整段文本匹配并换算行号。
// 点号与括号写法（wx.cloud['database'] / wx.cloud['callFunction']）都算；括号里的键从原文取——遮蔽后引号与内容会变成空格。
// 动态键（wx.cloud[expr]）无法静态判断，给 WARN 而不是放过；扫描不到客户端 JS 直接 FAIL，避免检查静默失效。
// 覆盖范围：wx.cloud 的点号 / 括号（普通字符串键，含转义键还原）直接写法；可选链、括号化 wx.cloud、别名、模板键、动态键只给 WARN，不阻断发布。
const CLIENT_ENTRY = 'miniprogram/utils/api.js';

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

// 遮蔽后的括号里只剩空格，键名要从原文同一区间取回来
function bracketKey(text, start, end) {
  // 括号里可能夹注释（wx.cloud[ /* 兼容 */ 'database' ]），先去掉注释再取键
  const raw = text.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const m = /\[\s*['\"]([^'\"]*)['\"]\s*\]/.exec(raw);
  // 转义键（wx.cloud['\u0064atabase']）先还原，避免用转义绕过检查
  return (m ? m[1] : '').replace(/\\u([0-9a-fA-F]{4})/g, (s, h) => String.fromCharCode(parseInt(h, 16)));
}

function checkClientCloudBoundary(root, lines, warnings) {
  const files = [];
  const walkErrors = [];
  walk(root, 'miniprogram', files, walkErrors);
  for (const err of walkErrors) lines.push({ level: 'WARN', msg: err });
  const DOT = /\bwx\s*\.\s*cloud\s*\.\s*(database|callFunction)\b/g;
  const BRACKET = /\bwx\s*\.\s*cloud\s*\[\s*\]/g;
  const DYNAMIC = /\bwx\s*\.\s*cloud\s*\[\s*[^\s\]]/g;
  let scanned = 0;
  let skipped = 0;
  let bad = 0;
  let callFunctionHits = 0;
  const report = (rel, masked, index, key) => {
    if (key === 'database') {
      lines.push({ level: 'FAIL', msg: rel + ':' + lineOf(masked, index) + ' 客户端直接访问云数据库 wx.cloud.database（文档 11.9 要求全局搜索为空）' });
      bad += 1;
      return;
    }
    if (key === 'callFunction') {
      callFunctionHits += 1;
      if (rel === CLIENT_ENTRY) return;
      lines.push({ level: 'FAIL', msg: rel + ':' + lineOf(masked, index) + ' 在 utils/api.js 之外直接调用 wx.cloud.callFunction（客户端云函数入口唯一，只允许 utils/api.js）' });
      bad += 1;
    }
  };
  for (const rel of files) {
    if (!rel.endsWith('.js')) continue;
    const text = readText(path.join(root, rel));
    if (text === null) {
      skipped += 1;
      warnings.push('云访问边界：跳过无法读取的客户端文件（>1MB 或非文本）：' + rel);
      continue;
    }
    scanned += 1;
    const masked = maskCommentsAndStrings(text);
    // 点号与括号命中统一收集后按出现位置排序，保证 FAIL 日志是源码行序
    const hits = [];
    let m;
    DOT.lastIndex = 0;
    while ((m = DOT.exec(masked))) hits.push({ index: m.index, key: m[1] });
    BRACKET.lastIndex = 0;
    while ((m = BRACKET.exec(masked))) hits.push({ index: m.index, key: bracketKey(text, m.index, BRACKET.lastIndex) });
    hits.sort((a, b) => a.index - b.index);
    for (const hit of hits) {
      if (!hit.key) {
        warnings.push(rel + ':' + lineOf(masked, hit.index) + ' 无法静态解析 wx.cloud[...] 的键（模板字面量或变量键？），请人工确认是否绕过 utils/api.js');
        continue;
      }
      report(rel, masked, hit.index, hit.key);
    }
    DYNAMIC.lastIndex = 0;
    while ((m = DYNAMIC.exec(masked))) {
      warnings.push(rel + ':' + lineOf(masked, m.index) + ' 有动态键的 wx.cloud[...]，静态检查无法判断是否绕过 utils/api.js，请人工确认');
    }
  }
  if (!scanned) {
    lines.push({ level: 'FAIL', msg: '没有扫描到客户端 JS 文件（miniprogram 目录为空或路径不对？），无法确认客户端云访问边界（文档 11.9）' });
  }
  if (!callFunctionHits) {
    warnings.push('没有在客户端发现 wx.cloud.callFunction，云函数入口检查可能失效：请确认 miniprogram/utils/api.js 仍是唯一入口');
  }
  if (callFunctionHits && files.indexOf(CLIENT_ENTRY) === -1) {
    warnings.push('白名单入口 ' + CLIENT_ENTRY + ' 不存在（改名或移动了？），外部 wx.cloud.callFunction 会被判 FAIL，请确认仍是唯一入口');
  }
  if (scanned && !bad && callFunctionHits) {
    const skippedTip = skipped ? '（已跳过 ' + skipped + ' 个无法读取的文件）' : '';
    lines.push({ level: 'PASS', msg: '客户端未直连数据库、云函数调用只经 utils/api.js（文档 11.9 全局搜索 wx.cloud.database 为空；检查了 ' + scanned + ' 个客户端 JS' + skippedTip + '）' });
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
  checkPromiseHandling(root, lines, warnings);
  checkClientCloudBoundary(root, lines, warnings);
  checkSecrets(root, lines);
  checkGit(root, lines, warnings);

  lines.push({ level: 'TODO', msg: '云开发控制台确认：12 个集合（M13 新增 ledger_view_grants）+ 权限「所有用户不可读写」+ 索引（见 docs/开发进度.md）' });
  lines.push({ level: 'TODO', msg: '云开发控制台确认：cloudfunctions/api 已重新上传部署（最近一次改动之后）' });
  lines.push({ level: 'TODO', msg: '云开发控制台确认：cloudfunctions/api 超时 10s、内存 256MB（文档 16.6；默认超时可能只有 3s，冷启动会偶发失败）' });
  lines.push({ level: 'TODO', msg: '微信公众平台确认：用户隐私保护指引（头像/昵称）已声明' });
  lines.push({ level: 'TODO', msg: '云开发控制台确认：cloudfunctions/api 的定时触发器 reminder-tick 已生效（config.json 的 triggers 随部署上传）' });
  lines.push({ level: 'TODO', msg: '云函数环境变量确认：YIYI_REMINDER_TEMPLATE_ID 已配订阅消息模板 ID（未配时「我的」页提醒开关是禁用态）' });
  lines.push({ level: 'TODO', msg: '云函数环境变量确认：YIYI_GROWTH_TEMPLATE_ID 已配任务提醒模板 ID（可选；未配时成长任务提醒静默降级、页面不弹授权）' });
  lines.push({ level: 'TODO', msg: '双人真机按 docs/M6-真机验收与发布.md 跑 F1–F14，并导出一次数据库备份' });

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
  checkPromiseHandling,
  checkClientCloudBoundary,
  versionAtLeast,
  scanTextForSecrets,
  scanConsoleStatement,
  extractConsoleStatements,
  isIgnoredByGitignore,
};
