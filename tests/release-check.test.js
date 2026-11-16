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
  versionAtLeast,
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
  writeFixtureFile(dir, 'project.config.json', JSON.stringify({
    miniprogramRoot: 'miniprogram/',
    cloudfunctionRoot: 'cloudfunctions/',
    compileType: 'miniprogram',
    appid: 'wx5c7cc21e713e2e3b',
    libVersion: '3.18.0',
  }));
  writeFixtureFile(dir, 'cloudfunctions/api/index.js', "const cloud = require('wx-server-sdk');\ncloud.init();\n");
  writeFixtureFile(dir, 'cloudfunctions/api/package.json', JSON.stringify({
    name: 'api',
    main: 'index.js',
    dependencies: { 'wx-server-sdk': '~2.4.0' },
  }));
  writeFixtureFile(dir, 'cloudfunctions/api/config.json', JSON.stringify({
    permissions: { openapi: [] },
    triggers: [],
  }));
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
    '云函数 package.json 依赖与入口正确',
    '云函数 config.json 权限/触发器格式正确',
    'project.config.json 的根目录 / appid / compileType / 基础库 ≥ 2.32.3 正确',
  ].forEach((needle) => {
    assert.ok(passText.includes(needle), '缺少检查项：' + needle);
  });

  // git 可用时给 PASS，沙箱里跑不了 git 时降级为 TODO，两者都算合格
  const allText = result.lines.map((l) => l.msg).join('\n');
  assert.ok(
    allText.includes('未被 Git 跟踪') || allText.includes('手动确认：git ls-files'),
    '缺少 env.js 跟踪状态的检查结果'
  );

  // 只能人工在控制台/公众平台做的项必须打印出来，否则真机验收前容易漏（超时/内存不在代码里，删掉没人发现）
  const todoText = result.lines.filter((l) => l.level === 'TODO').map((l) => l.msg).join('\n');
  ['8 个集合', '已重新上传部署', '超时 10s、内存 256MB', '用户隐私保护指引', 'F1–F8'].forEach((needle) => {
    assert.ok(todoText.includes(needle), '缺少 TODO 提醒：' + needle);
  });
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
  // 本地变量（无前缀点）走脱敏写法也不能误报，例如 coupleIdTail: coupleId ? String(coupleId).slice(-6) : ''
  assert.deepStrictEqual(scanConsoleStatement("console.log({ coupleIdTail: coupleId ? String(coupleId).slice(-6) : '' })"), []);
  // 但 String(coupleId) 没截尾时仍是完整值泄露
  assert.ok(scanConsoleStatement('console.log(String(coupleId))').includes('完整 coupleId'));

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
    const gitTodos = result.lines.filter((l) => l.level === 'TODO' && l.msg.includes('git ls-files'));
    assert.deepStrictEqual(gitTodos.map((l) => l.msg), [
      '手动确认：git ls-files miniprogram/config/env.js 输出为空',
      '手动确认：git ls-files project.private.config.json 输出为空',
    ]);
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

test('发布预检：require 路径、未注册组件、未登记集合都会 FAIL', () => {
  const dir = makeFixture();
  try {
    writeFixtureFile(dir, 'miniprogram/pages/home/index.js', "const helper = require('./not-here');\nPage({});\n");
    writeFixtureFile(dir, 'miniprogram/pages/home/index.wxml', PRIVACY_TAG + '<foo-bar />\n');
    writeFixtureFile(dir, 'cloudfunctions/api/handlers/leak.js', "db.collection('secrets_log');\n");
    const result = runChecks(dir);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(fails.includes("的 require 路径不存在：./not-here"), fails);
    assert.ok(fails.includes('用了未注册的组件 <foo-bar>'), fails);
    assert.ok(fails.includes('未登记的集合 secrets_log'), fails);
  } finally {
    cleanup(dir);
  }
});

test('发布预检：基础库版本比较只接受合法的三段版本号', () => {
  assert.strictEqual(versionAtLeast('3.18.0', '2.32.3'), true);
  assert.strictEqual(versionAtLeast('2.32.3', '2.32.3'), true);
  assert.strictEqual(versionAtLeast('2.32.4', '2.32.3'), true);
  // 数字比较而不是字符串比较：'2.32.10' 按字典序小于 '2.32.3'
  assert.strictEqual(versionAtLeast('2.32.10', '2.32.3'), true);
  assert.strictEqual(versionAtLeast('10.0.0', '2.32.3'), true);
  assert.strictEqual(versionAtLeast('2.32.2', '2.32.3'), false);
  assert.strictEqual(versionAtLeast('1.99.99', '2.0.0'), false);
  // 字典序比较的盲区：'2.9.0' 字典序大于 '2.32.3'，但数值上更小，必须判 false
  assert.strictEqual(versionAtLeast('2.9.0', '2.32.3'), false);
  assert.strictEqual(versionAtLeast('0.9.0', '0.10.0'), false);
  assert.strictEqual(versionAtLeast('2.32.30', '2.32.3'), true);
  assert.strictEqual(versionAtLeast('10.0.0', '9.0.0'), true);
  // 前导零不是合法写法（开发者工具不会这么写），按不满足处理
  assert.strictEqual(versionAtLeast('02.32.3', '2.32.3'), false);
  // 缺失、空串、两段、带后缀、非字符串一律视为不满足（避免猜开发者工具的版本规则）
  ['', '2.32', '2.32.3.1', '3.18.0-beta', '三.十八.零', undefined, null, 318].forEach((bad) => {
    assert.strictEqual(versionAtLeast(bad, '2.32.3'), false, String(bad) + ' 应视为不满足');
  });
});

test('发布预检：云函数部署配置 / 项目根目录写错都会 FAIL', () => {
  const projectConfig = (overrides) => JSON.stringify(Object.assign({
    miniprogramRoot: 'miniprogram/',
    cloudfunctionRoot: 'cloudfunctions/',
    compileType: 'miniprogram',
    appid: 'wx5c7cc21e713e2e3b',
    libVersion: '3.18.0',
  }, overrides));
  const cases = [
    {
      name: '缺少云函数 package.json',
      mutate: (dir) => fs.rmSync(path.join(dir, 'cloudfunctions/api/package.json')),
      expect: '缺少 cloudfunctions/api/package.json',
    },
    {
      name: 'package.json 的 main 不是 index.js',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/package.json', JSON.stringify({
        main: 'server.js',
        dependencies: { 'wx-server-sdk': '~2.4.0' },
      })),
      expect: 'main 必须是 index.js',
      // main 错时不能同时打印「依赖与入口正确」
      noPass: '云函数 package.json 依赖与入口正确',
    },
    {
      name: 'package.json 无法解析',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/package.json', '{"main":'),
      expect: 'cloudfunctions/api/package.json 无法解析',
    },
    {
      name: '缺少云函数入口 index.js',
      mutate: (dir) => fs.rmSync(path.join(dir, 'cloudfunctions/api/index.js')),
      expect: '缺少 cloudfunctions/api/index.js',
    },
    {
      name: 'config.json 的 openapi 写成对象',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/config.json', JSON.stringify({
        permissions: { openapi: {} },
        triggers: [],
      })),
      expect: 'permissions.openapi 必须是数组',
    },
    {
      name: 'config.json 的 triggers 写成对象',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/config.json', JSON.stringify({
        permissions: { openapi: [] },
        triggers: {},
      })),
      expect: 'triggers 必须是数组',
    },
    {
      name: 'project.config.json 顶层是 null',
      mutate: (dir) => writeFixtureFile(dir, 'project.config.json', 'null'),
      expect: 'project.config.json 内容必须是一个 JSON 对象',
    },
    {
      name: 'project.config.json 的 cloudfunctionRoot 写错',
      mutate: (dir) => writeFixtureFile(dir, 'project.config.json', projectConfig({ cloudfunctionRoot: 'cloud/' })),
      expect: 'cloudfunctionRoot 必须是 cloudfunctions/',
    },
    {
      name: 'project.config.json 的 appid 不合法',
      mutate: (dir) => writeFixtureFile(dir, 'project.config.json', projectConfig({ appid: 'wx123' })),
      expect: 'appid 不合法',
    },
    {
      // JSON.stringify 会丢掉 undefined 字段，等价于「没写 libVersion」
      name: 'project.config.json 缺少 libVersion',
      mutate: (dir) => writeFixtureFile(dir, 'project.config.json', projectConfig({ libVersion: undefined })),
      expect: '缺少 libVersion（最低基础库 2.32.3）',
    },
    {
      name: 'project.config.json 的 libVersion 是 widelyUsed（无法确认版本）',
      mutate: (dir) => writeFixtureFile(dir, 'project.config.json', projectConfig({ libVersion: 'widelyUsed' })),
      expect: 'libVersion 是 widelyUsed',
      noPass: '基础库 ≥ 2.32.3 正确',
    },
    {
      name: 'project.config.json 的基础库低于隐私开关下限',
      mutate: (dir) => writeFixtureFile(dir, 'project.config.json', projectConfig({ libVersion: '2.21.2' })),
      expect: 'libVersion 必须 ≥ 2.32.3',
      noPass: '基础库 ≥ 2.32.3 正确',
    },
  ];

  for (const item of cases) {
    const dir = makeFixture();
    try {
      item.mutate(dir);
      const result = runChecks(dir);
      const fails = failMessages(result).join('\n');
      assert.strictEqual(result.ok, false, item.name + ' 应让预检失败');
      assert.ok(fails.includes(item.expect), item.name + ' 缺少 FAIL 文案：' + fails);
      if (item.noPass) {
        const passText = result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
        assert.ok(!passText.includes(item.noPass), item.name + ' 不应给出 PASS：' + item.noPass);
      }
    } finally {
      cleanup(dir);
    }
  }

  // latest / trial 是微信允许的符号值，一定不比下限旧，不能误报
  for (const symbol of ['latest', 'trial']) {
    const symbolDir = makeFixture();
    try {
      writeFixtureFile(symbolDir, 'project.config.json', projectConfig({ libVersion: symbol }));
      const symbolResult = runChecks(symbolDir);
      const symbolFails = failMessages(symbolResult).join('\n');
      assert.strictEqual(symbolResult.ok, true, 'libVersion=' + symbol + ' 不该让预检失败：' + symbolFails);
      assert.ok(!symbolFails.includes('libVersion'), 'libVersion=' + symbol + ' 不该报 libVersion：' + symbolFails);
    } finally {
      cleanup(symbolDir);
    }
  }

  // 顶层是非法 JSON 对象（null / 数组 / 解析失败）时，字段检查会静默跳过，必须自己 FAIL
  const dir = makeFixture();
  try {
    writeFixtureFile(dir, 'cloudfunctions/api/package.json', 'null');
    writeFixtureFile(dir, 'cloudfunctions/api/config.json', '[]');
    const result = runChecks(dir);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(fails.includes('cloudfunctions/api/package.json 内容必须是一个 JSON 对象'), fails);
    assert.ok(fails.includes('cloudfunctions/api/config.json 内容必须是一个 JSON 对象'), fails);
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

test('发布预检：脱敏只认负索引，slice(0) 仍算泄露', () => {
  const leak = extractConsoleStatements('console.log(String(coupleId).slice(0));')[0].text;
  const ok = extractConsoleStatements('console.log(String(coupleId).slice(-6));')[0].text;
  assert.ok(scanConsoleStatement(leak).includes('完整 coupleId'), 'slice(0) 不是脱敏，必须报');
  assert.deepStrictEqual(scanConsoleStatement(ok), []);
});

test('发布预检：只有真正的负索引截尾才算脱敏（substring / slice(-0) 会返回整串）', () => {
  const asStatement = (expr) => extractConsoleStatements('console.log(' + expr + ');')[0].text;
  const leaks = [
    ['String(coupleId).substring(-6)', 'substring 不支持负索引，返回整串'],
    ['String(coupleId).slice(-0)', 'slice(-0) 等于 slice(0)，返回整串'],
    ['String(ctx.openid).substring(-6)', '属性形式同样不能放行'],
  ];
  for (const [expr, why] of leaks) {
    assert.ok(
      scanConsoleStatement(asStatement(expr)).includes('完整 ' + (expr.indexOf('openid') !== -1 ? 'openid' : 'coupleId')),
      expr + ' 会泄露完整值（' + why + '），必须报',
    );
  }
  const safe = [
    'String(coupleId).slice(-6)',
    'String(ctx.user.coupleId || "").substr(-6)',
    'String(coupleId).length',
  ];
  for (const expr of safe) {
    assert.deepStrictEqual(scanConsoleStatement(asStatement(expr)), [], expr + ' 是安全的脱敏写法，不应误报');
  }
});
