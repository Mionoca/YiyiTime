#!/usr/bin/env node
'use strict';

// 提交/推送前检查：扫描工作区中 Git 已跟踪、以及未被 .gitignore 忽略的新文件里的
// 云环境 ID、AppSecret、私钥。
// 用法：node scripts/check-secrets.js
// 被忽略的本地 miniprogram/config/env.js 不会进入扫描，也不应提交。
//
// 与 scripts/release-check.js 的分工：本脚本依赖 git 的文件清单（更准，会把 .gitignore 里
// 的本地密钥文件排除）；release-check 是纯 fs 遍历、不依赖 git，用于沙箱/CI。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60000 });
}

let root;
let files;
try {
  root = git(['rev-parse', '--show-toplevel']).trim();
  files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
    .split('\0')
    .filter(Boolean);
} catch (err) {
  console.error('check-secrets: 无法执行 git，请在本机终端（而不是受限沙箱）里运行。');
  console.error('原因：' + (err && err.message ? err.message.split('\n')[0] : err));
  process.exit(2);
}

const patterns = [
  { name: '云环境 ID', regex: /cloud1-[a-z0-9]{10,}/i },
  { name: 'AppSecret/SecretKey', regex: /(AppSecret|SecretId|SecretKey)\s*[:=]\s*['"]?[A-Za-z0-9_\-]{8,}/i },
  { name: '私钥', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
];

const findings = [];

for (const file of files) {
  // 两个扫描脚本自己带着规则字面量，跳过；单测里的假样例在运行时拼接，不会被误报。
  if (file === 'scripts/check-secrets.js' || file === 'scripts/release-check.js') continue;

  const full = path.join(root, file);
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    continue;
  }
  if (!stat.isFile() || stat.size > 1024 * 1024) continue;

  let text;
  try {
    text = fs.readFileSync(full, 'utf8');
  } catch {
    continue;
  }
  if (text.includes('\u0000')) continue;

  const lines = text.split('\n');
  for (const { name, regex } of patterns) {
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i])) {
        findings.push(`${file}:${i + 1}  ${name}`);
      }
    }
  }
}

if (findings.length > 0) {
  console.error('发现可能泄露的配置，请先移除再提交：');
  for (const finding of findings) console.error(`  ${finding}`);
  console.error('\n提示：环境 ID 放在本机 miniprogram/config/env.js，该文件已被 .gitignore 忽略。');
  process.exit(1);
}

console.log('check-secrets: 未发现环境 ID / AppSecret / 私钥泄露。');
