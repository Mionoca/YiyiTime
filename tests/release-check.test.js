'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runChecks,
  scanTextForSecrets,
  scanConsoleStatement,
  extractConsoleStatements,
  isIgnoredByGitignore,
} = require('../scripts/release-check');

const ROOT = path.join(__dirname, '..');

// 假密钥一律运行时拼接，源码里不出现「长得像真的」字符串，
// 这样 scripts/check-secrets.js 扫描本文件也不会误报。
const fakeEnvId = 'cloud1-' + 'abcdefghijkl';
const fakeSecret = 'App' + 'Secret: "abcd1234efgh"';
const fakePem = '-----BEGIN RSA ' + 'PRIVATE KEY-----';

function writeFixtureFile(dir, rel, text) {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

const PRIVACY_TAG = "<privacy-guard />\n";

/** 构造一个「除了被删改项以外都健康」的临时小程序仓库 */
function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-check-'));
  const pages = ['pages/home/index', 'pages/bind/index', 'pages/profile/index'];
  writeFixtureFile(dir, 'miniprogram/app.json', JSON.stringify({
    pages,
    window: { pageOrientation: 'portrait' },
    __usePrivacyCheck__: true,
  }));
  for (const page of pages) {
    writeFixtureFile(dir, 'miniprogram/' + page + '.json', JSON.stringify({
      usingComponents: { 'privacy-guard': '/components/privacy-guard/index' },
    }));
    const extra = page === 'pages/profile/index' ? '<view bindtap="onOpenPrivacy">隐私保护指引</view>\n' : '';
    writeFixtureFile(dir, 'miniprogram/' + page + '.wxml', PRIVACY_TAG + extra);
    writeFixtureFile(dir, 'miniprogram/' + page + '.js', 'Page({});\n');
  }
  writeFixtureFile(dir, 'miniprogram/utils/constants.js', "const DEFAULT_AVATAR = '/images/avatars/default.png';\nmodule.exports = { DEFAULT_AVATAR };\n");
  writeFixtureFile(dir, 'miniprogram/images/avatars/default.png', 'not-a-real-png');
  writeFixtureFile(dir, 'miniprogram/config/env.example.js', 'module.exports = { ENV_ID: \'\' };\n');
  for (const ext of ['js', 'json', 'wxml']) {
    writeFixtureFile(dir, 'miniprogram/components/privacy-guard/index.' + ext, '');
  }
  writeFixtureFile(dir, '.gitignore', 'miniprogram/config/env.js\nproject.private.config.json\n');
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function failMessages(result) {
  return result.lines.filter((l) => l.level === 'FAIL').map((l) => l.msg);
}

test('发布预检：当前仓库静态检查全部通过', () => {
  const result = runChecks(ROOT);
  assert.deepStrictEqual(failMessages(result), [], '当前仓库不应有 FAIL 项');
  assert.strictEqual(result.ok, true);

  const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  const passText = result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
  [
    'app.json 的 ' + app.pages.length + ' 个页面文件齐全',
    '页面自定义组件路径全部存在',
    '默认头像存在',
    '隐私开关与竖屏声明已配置',
    '三页都接入了隐私弹窗',
    '没有把 openid / coupleId / 邀请码 / 正文写进 console',
    '未发现云环境 ID / AppSecret / 私钥',
  ].forEach((needle) => {
    assert.ok(passText.includes(needle), '缺少检查项：' + needle);
  });

  // git 可用时给 PASS，沙箱里跑不了 git 时降级为 TODO，两者都算合格
  const allText = result.lines.map((l) => l.msg).join('\n');
  assert.ok(
    allText.includes('未被 Git 跟踪') || allText.includes('手动确认：git ls-files'),
    '缺少 env.js 跟踪状态的检查结果'
  );
});

test('发布预检：密钥扫描能识别环境 ID、AppSecret 与私钥', () => {
  assert.strictEqual(scanTextForSecrets('const x = 1;').length, 0);
  assert.strictEqual(scanTextForSecrets('ENV_ID = "' + fakeEnvId + '"')[0].name, '云环境 ID');
  assert.strictEqual(scanTextForSecrets(fakeSecret)[0].name, 'AppSecret/SecretKey');
  assert.strictEqual(scanTextForSecrets(fakePem)[0].name, '私钥');
});

test('发布预检：敏感日志按整条 console 语句扫描（多行负载也能拦下）', () => {
  // 放过脱敏字段
  assert.deepStrictEqual(scanConsoleStatement("console.log('[api]', { openidTail: x, coupleIdTail: y, errCode: 1 })"), []);
  assert.deepStrictEqual(scanConsoleStatement('console.error(err)'), []);
  assert.deepStrictEqual(scanConsoleStatement('console.log("inviteCode 已生成")'), []);
  assert.deepStrictEqual(scanConsoleStatement('console.log("note:", err)'), []);

  // 单行对象字段
  assert.ok(scanConsoleStatement('console.log({ openid })').includes('完整 openid'));
  assert.ok(scanConsoleStatement('console.log({ coupleId: ctx.user.coupleId })').includes('完整 coupleId'));
  assert.ok(scanConsoleStatement('console.log({ inviteCode: code })').includes('邀请码'));
  assert.ok(scanConsoleStatement("console.log({ note: '今晚月亮很好' })").includes('日记正文 / 愿望备注'));
  assert.ok(scanConsoleStatement('console.log(entry.content)').includes('正文/备注取值'));
  assert.ok(scanConsoleStatement('console.log({ phone: "13800138000" })').includes('手机号'));

  // 裸变量 / 属性直接进日志也算泄露
  assert.ok(scanConsoleStatement('console.log(openid)').includes('完整 openid'));
  assert.ok(scanConsoleStatement("console.log('openid', openid)").includes('完整 openid'));
  assert.ok(scanConsoleStatement('console.log(ctx.openid)').includes('完整 openid'));
  assert.ok(scanConsoleStatement("console.log('coupleId', ctx.user.coupleId)").includes('完整 coupleId'));

  // 只截尾部 / 取长度是脱敏写法，不能误报
  assert.deepStrictEqual(scanConsoleStatement('console.log(String(ctx.openid).slice(-6))'), []);
  assert.deepStrictEqual(scanConsoleStatement("console.log(String(ctx.user.coupleId || '').slice(-6))"), []);
  assert.deepStrictEqual(scanConsoleStatement('console.log(openid.slice(-6))'), []);
  assert.deepStrictEqual(scanConsoleStatement('console.log(entry.content.length)'), []);
  assert.deepStrictEqual(scanConsoleStatement("console.log('openidTail', { openidTail: x })"), []);

  // 多行 JSON.stringify 负载（仓库里 cloudfunctions 的主流写法）
  const multiline = [
    "console.error('[x]', JSON.stringify({",
    '  requestId,',
    '  openid: ctx.openid,',
    '  coupleId: ctx.user.coupleId,',
    '  content: entry.content,',
    '}));',
  ].join('\n');
  const statements = extractConsoleStatements(multiline);
  assert.strictEqual(statements.length, 1);
  assert.strictEqual(statements[0].line, 1);
  const names = scanConsoleStatement(statements[0].text);
  assert.ok(names.includes('完整 openid'));
  assert.ok(names.includes('完整 coupleId'));
  assert.ok(names.includes('日记正文 / 愿望备注') || names.includes('正文/备注取值'));

  // 括号出现在字符串里不会截断语句
  const tricky = "console.log('(假装是括号)', { openid: ctx.openid });";
  assert.strictEqual(extractConsoleStatements(tricky).length, 1);
  assert.ok(scanConsoleStatement(extractConsoleStatements(tricky)[0].text).includes('完整 openid'));

  // 注释/字符串里的 console 不算真日志，不能误报
  const commented = [
    '// console.log({ openid })',
    '/* console.log({ coupleId }) */',
    "const s = 'console.log({ openid })';",
    "const t = `console.log({ content })`;",
    'Page({});',
  ].join('\n');
  assert.strictEqual(extractConsoleStatements(commented).length, 0);
});

test('发布预检：.gitignore 解析忽略注释与目录形式', () => {
  assert.strictEqual(isIgnoredByGitignore('miniprogram/config/env.js\n', 'miniprogram/config/env.js'), true);
  assert.strictEqual(isIgnoredByGitignore('# miniprogram/config/env.js\n', 'miniprogram/config/env.js'), false);
  assert.strictEqual(isIgnoredByGitignore('\n  project.private.config.json  \n', 'project.private.config.json'), true);
  assert.strictEqual(isIgnoredByGitignore('dist/\n', 'dist/output.js'), true);
});

test('发布预检：健康夹具无 FAIL，git 不可用时降级为 TODO', () => {
  const dir = makeFixture();
  try {
    const result = runChecks(dir);
    assert.deepStrictEqual(failMessages(result), []);
    assert.strictEqual(result.ok, true);
    assert.ok(result.lines.some((l) => l.level === 'TODO' && l.msg.includes('git ls-files')));
  } finally {
    cleanup(dir);
  }
});

test('发布预检：缺页面文件、缺组件、缺隐私入口都会 FAIL', () => {
  const dir = makeFixture();
  try {
    fs.rmSync(path.join(dir, 'miniprogram/pages/home/index.wxml'));
    writeFixtureFile(dir, 'miniprogram/pages/bind/index.json', JSON.stringify({
      usingComponents: { 'privacy-guard': '/components/not-exist/index' },
    }));
    writeFixtureFile(dir, 'miniprogram/pages/profile/index.wxml', PRIVACY_TAG);
    const result = runChecks(dir);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(fails.includes('缺少页面文件 miniprogram/pages/home/index.wxml'), fails);
    assert.ok(fails.includes('引用的组件 privacy-guard 缺少文件'), fails);
    assert.ok(fails.includes('我的页缺少「隐私保护指引」入口'), fails);
    assert.ok(fails.includes('没有接入 privacy-guard 隐私弹窗'), fails);
  } finally {
    cleanup(dir);
  }
});

test('发布预检：多行 console 泄露、被注释的 .gitignore 行都会 FAIL', () => {
  const dir = makeFixture();
  try {
    writeFixtureFile(dir, 'miniprogram/pages/home/index.js', [
      'Page({',
      '  onLoad() {',
      "    console.error('[leak]', JSON.stringify({",
      '      openid: ctx.openid,',
      '    }));',
      '  },',
      '});',
    ].join('\n'));
    writeFixtureFile(dir, '.gitignore', '# miniprogram/config/env.js\nproject.private.config.json\n');
    const result = runChecks(dir);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(fails.includes('日志可能带出完整 openid'), fails);
    assert.ok(fails.includes('.gitignore 缺少：miniprogram/config/env.js'), fails);
  } finally {
    cleanup(dir);
  }
});

test('发布预检：夹具里放一个假环境 ID 会 FAIL（密钥扫描确实接进了 runChecks）', () => {
  const dir = makeFixture();
  try {
    writeFixtureFile(dir, 'miniprogram/config/leak.js', 'module.exports = { ENV_ID: "' + fakeEnvId + '" };\n');
    const result = runChecks(dir);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(fails.includes('可能是云环境 ID'), fails);
  } finally {
    cleanup(dir);
  }
});

test('发布预检：本地 .env / .pem / env.js 不会被当成待提交密钥', () => {
  const dir = makeFixture();
  try {
    writeFixtureFile(dir, '.env', 'ENV_ID=' + fakeEnvId + '\n');
    writeFixtureFile(dir, 'deploy.pem', fakePem + '\n');
    writeFixtureFile(dir, 'miniprogram/config/env.js', "module.exports = { ENV_ID: '" + fakeEnvId + "' };\n");
    const result = runChecks(dir);
    assert.deepStrictEqual(failMessages(result), []);
  } finally {
    cleanup(dir);
  }
});
