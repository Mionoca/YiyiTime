'use strict';

// scripts/check-secrets.js 的规则、文件扫描与 CLI 端到端单测。
// 样例密钥串在运行时拼接，源码里不出现可被规则命中的字面量（否则本仓库自身会被 check-secrets 判红）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const secrets = require('../scripts/check-secrets');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/check-secrets.js');

const ENV_ID = ['cloud1', 'abcdefghijkl'].join('-');
const APP_SECRET = ['App', 'Secret'].join('') + ': ' + 'abcdefgh1234';
const SECRET_ID = ['Secret', 'Id'].join('') + ' = ' + '"AKID12345678"';
const PRIVATE_KEY = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-secrets-'));
  if (t) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('PATTERNS 里的正则都不能带 g/y（按行复用 .test() 会残留 lastIndex 导致隔行漏报）', () => {
  for (const pattern of secrets.PATTERNS) {
    assert.strictEqual(pattern.regex.global, false, pattern.name + ' 不能带 g');
    assert.strictEqual(pattern.regex.sticky, false, pattern.name + ' 不能带 y');
  }
});

function gitAvailable() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

test('scanText 命中三类规则并给出行号', () => {
  const text = ['第一行干净', ENV_ID, 'x ' + APP_SECRET, SECRET_ID, PRIVATE_KEY].join('\n');
  const findings = secrets.scanText(text);
  assert.deepStrictEqual(findings, [
    { line: 2, name: '云环境 ID' },
    { line: 3, name: 'AppSecret/SecretKey' },
    { line: 4, name: 'AppSecret/SecretKey' },
    { line: 5, name: '私钥' },
  ]);
});

test('scanText 不误报脱敏写法、裸字段名与短串', () => {
  const text = [
    'const tail = String(coupleId).slice(-6);',
    'AppSecretSecretKey',
    'cloud1-' + 'abc',
    '// 环境 ID 放在本机 miniprogram/config/env.js',
    'PRIVATE',
    'const env = readEnvConfig();',
  ].join('\n');
  assert.deepStrictEqual(secrets.scanText(text), []);
});

test('scanText 对「SecretId = 标识符」这种形态会命中（规则偏严格，已知误报）', () => {
  const text = ['const ', 'SecretId', ' = readFromEnv();'].join('');
  assert.deepStrictEqual(secrets.scanText(text), [{ line: 1, name: 'AppSecret/SecretKey' }]);
});

test('单文件上限是 1MB：恰好 1MB 会扫，多 1 字节跳过', (t) => {
  assert.strictEqual(secrets.MAX_FILE_BYTES, 1024 * 1024);

  const root = tmpRoot(t);
  const exact = ENV_ID + '\n' + 'x'.repeat(secrets.MAX_FILE_BYTES - ENV_ID.length - 1);
  fs.writeFileSync(path.join(root, 'exact.js'), exact);
  assert.deepStrictEqual(secrets.scanFile(root, 'exact.js'), ['exact.js:1  云环境 ID']);

  const over = ENV_ID + '\n' + 'x'.repeat(secrets.MAX_FILE_BYTES - ENV_ID.length);
  fs.writeFileSync(path.join(root, 'over.js'), over);
  assert.deepStrictEqual(secrets.scanFile(root, 'over.js'), []);
});

test('scanFile 跳过脚本自身、目录、读不到的文件与二进制文件', (t) => {
  const root = tmpRoot(t);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'check-secrets.js'), ENV_ID);
  assert.deepStrictEqual(secrets.scanFile(root, 'scripts/check-secrets.js'), []);

  // 目录与不可读文件同时被「!stat.isFile()」和 readFileSync 的 try/catch 兜住（双保险），
  // 这里只锁结果：任何一道防线丢了都不该让发布预检崩溃。
  fs.mkdirSync(path.join(root, 'a-dir'), { recursive: true });
  assert.deepStrictEqual(secrets.scanFile(root, 'a-dir'), []);
  assert.deepStrictEqual(secrets.scanFile(root, 'not-exist.js'), []);

  fs.writeFileSync(path.join(root, 'binary.js'), Buffer.from('a\u0000b' + ENV_ID, 'utf8'));
  assert.deepStrictEqual(secrets.scanFile(root, 'binary.js'), []);
});

test('scanFile 返回 file:line 形式的命中', (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'a.js'), ['clean', APP_SECRET].join('\n'));
  assert.deepStrictEqual(secrets.scanFile(root, 'a.js'), ['a.js:2  AppSecret/SecretKey']);
});

test('scanFiles 汇总多个文件且保留给定顺序', (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'b.js'), ENV_ID);
  fs.writeFileSync(path.join(root, 'a.js'), PRIVATE_KEY);
  fs.writeFileSync(path.join(root, 'clean.js'), 'const a = 1;');
  assert.deepStrictEqual(secrets.scanFiles(root, ['b.js', 'clean.js', 'a.js']), [
    'b.js:1  云环境 ID',
    'a.js:1  私钥',
  ]);
});

test('isSkippedFile 只跳过两个扫描脚本', () => {
  assert.strictEqual(secrets.isSkippedFile('scripts/check-secrets.js'), true);
  assert.strictEqual(secrets.isSkippedFile('scripts/release-check.js'), true);
  assert.strictEqual(secrets.isSkippedFile('tests/check-secrets.test.js'), false);
  assert.strictEqual(secrets.isSkippedFile('miniprogram/app.js'), false);
});

test('CLI：git 不可用时退出码为 2 并提示在终端运行', () => {
  const env = Object.assign({}, process.env, { PATH: '', Path: '' });
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8', env });
  assert.strictEqual(res.status, 2, res.stderr);
  assert.match(res.stderr, /无法执行 git/);
});

test('CLI：临时仓库里有密钥时退出码为 1 并打印 file:line', (t) => {
  if (!gitAvailable()) {
    t.skip('当前环境无法执行 git');
    return;
  }
  const dir = tmpRoot(t);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) {
    t.skip('当前环境无法初始化 git 仓库');
    return;
  }
  fs.writeFileSync(path.join(dir, 'leak.js'), 'const env = "' + ENV_ID + '";\n');
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(res.status, 1, res.stderr);
  assert.match(res.stderr, /发现可能泄露的配置/);
  assert.match(res.stderr, /leak\.js:1\s+云环境 ID/);
  assert.match(res.stderr, /提示：环境 ID/);
});

test('CLI：干净仓库退出码为 0（用临时 git 仓库，避免受开发者本机工作区影响）', (t) => {
  if (!gitAvailable()) {
    t.skip('当前环境无法执行 git');
    return;
  }
  const dir = tmpRoot(t);
  const init = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
  if (init.status !== 0) {
    t.skip('当前环境无法初始化 git 仓库');
    return;
  }
  fs.writeFileSync(path.join(dir, 'clean.js'), 'const a = 1;\n');
  const res = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /未发现环境 ID/);
});
