#!/usr/bin/env node
'use strict';

// 提交/推送前检查：扫描工作区中 Git 已跟踪、以及未被 .gitignore 忽略的新文件里的
// 云环境 ID、AppSecret、私钥。
// 用法：node scripts/check-secrets.js
// 被忽略的本地 miniprogram/config/env.js 不会进入扫描，也不应提交。
//
// 与 scripts/release-check.js 的分工：本脚本依赖 git 的文件清单（更准，会把 .gitignore 里
// 的本地密钥文件排除）；release-check 是纯 fs 遍历、不依赖 git，用于沙箱/CI。
//
// 规则与扫描函数都导出，供 tests/check-secrets.test.js 覆盖（CLI 行为与退出码不变）。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 1024 * 1024;

// 两个扫描脚本自己带着规则字面量，跳过；单测里的假样例在运行时拼接，不会被误报。
const SELF_FILES = new Set(['scripts/check-secrets.js', 'scripts/release-check.js']);

// 注意：正则都不带 g/y，scanText 里按行复用 .test() 不会留下 lastIndex 状态；
// 如果将来给规则加 g，需要每行新建正则或先重置 lastIndex，否则会隔行漏报。
const PATTERNS = [
  { name: '云环境 ID', regex: /cloud1-[a-z0-9]{10,}/i },
  { name: 'AppSecret/SecretKey', regex: /(AppSecret|SecretId|SecretKey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i },
  { name: '私钥', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
];

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
}

/** 该文件是否被规则自身跳过（扫描脚本里写着规则字面量）。 */
function isSkippedFile(file) {
  return SELF_FILES.has(file);
}

/** 扫描一段文本，返回 [{ line, name }]（line 从 1 开始，按规则顺序排列）。 */
function scanText(text) {
  const findings = [];
  const lines = String(text).split('\n');
  for (const { name, regex } of PATTERNS) {
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) findings.push({ line: i + 1, name });
    }
  }
  return findings;
}

/** 扫描单个文件（file 为相对 root 的路径）；跳过脚本自身、读不到/二进制/超大文件，返回 'file:line  name' 数组。 */
function scanFile(root, file) {
  if (isSkippedFile(file)) return [];

  const full = path.join(root, file);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  if (text.includes('\u0000')) return [];

  return scanText(text).map((finding) => `${file}:${finding.line}  ${finding.name}`);
}

/** git 视角下的全部候选文件（已跟踪 + 未忽略的新文件），相对仓库根目录。 */
function listFiles(root) {
  return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
    .split('\0')
    .filter(Boolean);
}

/** 扫描给定文件列表，返回 'file:line  name' 数组。 */
function scanFiles(root, files) {
  const findings = [];
  for (const file of files) findings.push(...scanFile(root, file));
  return findings;
}

/** CLI 入口：git 不可用退出 2，发现疑似泄露退出 1，干净退出 0。 */
function main() {
  let root;
  let files;
  try {
    root = git(['rev-parse', '--show-toplevel']).trim();
    files = listFiles(root);
  } catch (err) {
    console.error('check-secrets: 无法执行 git，请在本机终端（而不是受限沙箱）里运行。');
    console.error('原因：' + (err && err.message ? err.message.split('\n')[0] : err));
    process.exit(2);
  }

  const findings = scanFiles(root, files);
  if (findings.length > 0) {
    console.error('发现可能泄露的配置，请先移除再提交：');
    for (const finding of findings) console.error(`  ${finding}`);
    console.error('\n提示：环境 ID 放在本机 miniprogram/config/env.js，该文件已被 .gitignore 忽略。');
    process.exit(1);
  }

  console.log('check-secrets: 未发现环境 ID / AppSecret / 私钥泄露。');
}

if (require.main === module) main();

module.exports = {
  MAX_FILE_BYTES,
  SELF_FILES,
  PATTERNS,
  git,
  isSkippedFile,
  scanText,
  scanFile,
  listFiles,
  scanFiles,
  main,
};
