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
  { name: '完整 openid', regex: /\.openid\b(?!\s*\)?\s*\.\s*(slice|substr|substring|length)\b)/i },
  { name: '完整 coupleId', regex: /\.coupleId\b(?!\s*\)?\s*\.\s*(slice|substr|substring|length)\b)/i },
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
    /String\(\s*[\w.$]*\.(?:openid|coupleId)\b[^)]*\)\s*\.\s*(?:slice|substr|substring|length)\s*\(/gi,
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

function checkAssets(root, lines, warnings) {
  const constants = readText(path.join(root, 'miniprogram/utils/constants.js'));
  if (!constants) {
    warnings.push('读不到 miniprogram/utils/constants.js，默认头像按约定路径检查');
    lines.push({ level: 'WARN', msg: '读不到 miniprogram/utils/constants.js，按约定路径检查默认头像' });
  }
  const m = String(constants || '').match(/DEFAULT_AVATAR\s*=\s*'([^']+)'/);
  const avatar = m ? m[1] : '/images/avatars/default.png';
  if (fs.existsSync(path.join(root, 'miniprogram', avatar.replace(/^\//, '')))) {
    lines.push({ level: 'PASS', msg: '默认头像存在：' + avatar });
  } else {
    lines.push({ level: 'FAIL', msg: '默认头像缺失：miniprogram' + avatar });
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
    warnings.push('无法执行 git（沙箱限制？）→ 请手动确认 git ls-files miniprogram/config/env.js 为空');
    lines.push({ level: 'TODO', msg: '手动确认：git ls-files miniprogram/config/env.js 输出为空' });
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
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', timeout: 10000 });
  if (status.stdout && status.stdout.trim()) {
    warnings.push('工作区有未提交改动，发布前应为干净状态');
  }
}

function runChecks(root) {
  const lines = [];
  const warnings = [];
  const app = checkPages(root, lines);
  checkTemplate(root, lines);
  checkAssets(root, lines, warnings);
  checkPrivacy(app, root, lines);
  checkConsole(root, lines, warnings);
  checkSecrets(root, lines);
  checkGit(root, lines, warnings);

  lines.push({ level: 'TODO', msg: '云开发控制台确认：8 个集合 + 权限「所有用户不可读写」+ 索引（见 docs/开发进度.md）' });
  lines.push({ level: 'TODO', msg: '云开发控制台确认：cloudfunctions/api 已重新上传部署（最近一次改动之后）' });
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
  scanTextForSecrets,
  scanConsoleStatement,
  extractConsoleStatements,
  isIgnoredByGitignore,
};
