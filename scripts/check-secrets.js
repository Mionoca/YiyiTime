#!/usr/bin/env node
'use strict';

// 提交/推送前检查：扫描工作区中 Git 已跟踪、以及未被 .gitignore 忽略的新文件里的
// 云环境 ID、AppSecret、私钥。
// 用法：node scripts/check-secrets.js
// 被忽略的本地 miniprogram/config/env.js 不会进入扫描，也不应提交。

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
  cwd: root,
  encoding: 'utf8',
}).split('\0').filter(Boolean);

const patterns = [
  { name: '云环境 ID', regex: /cloud1-[a-z0-9]{10,}/i },
  { name: 'AppSecret/SecretKey', regex: /(AppSecret|SecretId|SecretKey)\s*[:=]\s*['"][^'"]+/i },
  { name: '私钥', regex: /BEGIN [A-Z ]*PRIVATE KEY/ },
];

const findings = [];

for (const file of files) {
  if (file === 'scripts/check-secrets.js') continue;

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
