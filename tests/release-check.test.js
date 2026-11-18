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

/** 合成一张结构完整的最小 PNG（签名 + IHDR + IEND；CRC 置 0，预检不校验像素与 CRC） */
function pngBytes(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

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
  writeFixtureFile(dir, 'miniprogram/utils/api.js', "function call(action) {\n  return wx.cloud.callFunction({ name: 'api', data: { action } });\n}\nmodule.exports = { call };\n");
  writeFixtureFile(dir, 'miniprogram/images/avatars/default.png', pngBytes(200, 200));
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
    permissions: { openapi: ['security.msgSecCheck', 'subscribeMessage.send'] },
    triggers: [{ name: 'reminder-tick', type: 'timer', config: '0 */10 * * * * *' }],
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
    '云函数 config.json 权限/触发器正确',
    'project.config.json 的根目录 / appid / compileType / 基础库 ≥ 2.32.3 正确',
    '图片资源与包体符合 8.8',
    '客户端 api.call 都已被 await / .then / .catch / return 处理',
    '客户端未直连数据库、云函数调用只经 utils/api.js',
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
  // 集合数从「云函数只用了预期的 N 个集合」这条 PASS 里取，避免新增集合后两处数字漂移
  const collectionPass = passText.split('\n').find((m) => m.includes('云函数只用了预期的'));
  const collectionCount = (collectionPass && collectionPass.match(/预期的 (\d+) 个集合/) || [])[1];
  assert.ok(collectionCount, '缺少「云函数只用了预期的 N 个集合」检查项');
  ['个集合', '已重新上传部署', '超时 10s、内存 256MB', '用户隐私保护指引', 'reminder-tick', 'YIYI_REMINDER_TEMPLATE_ID', 'F1–F12'].forEach((needle) => {
    assert.ok(todoText.includes(needle), '缺少 TODO 提醒：' + needle);
  });
  assert.ok(
    todoText.includes(collectionCount + ' 个集合'),
    '云开发控制台 TODO 的集合数（' + collectionCount + '）与集合白名单不一致'
  );
});

test('发布预检：图片位置 / 单张体积 / 包体预算 / 默认头像尺寸', () => {
  const passText = (result) => result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
  const packagePass = (result) => passText(result).includes('图片资源与包体符合 8.8');
  const noPackagePass = (result) => assert.ok(!packagePass(result), '有 FAIL 时不应再打印「图片资源与包体符合 8.8」');

  // 健康夹具：有 PASS，且没有任何 FAIL
  const healthy = makeFixture();
  try {
    const result = runChecks(healthy);
    assert.deepStrictEqual(failMessages(result), [], '健康夹具不应有 FAIL 项');
    assert.ok(packagePass(result), '缺少资源与包体 PASS：' + passText(result));
  } finally {
    cleanup(healthy);
  }

  // 默认头像尺寸不是 200×200
  const wrongAvatar = makeFixture();
  try {
    fs.writeFileSync(path.join(wrongAvatar, 'miniprogram/images/avatars/default.png'), pngBytes(210, 212));
    const result = runChecks(wrongAvatar);
    assert.ok(failMessages(result).some((m) => m.includes('默认头像尺寸应为 200×200（当前 210×212）')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(wrongAvatar);
  }

  // 默认头像不是结构完整的 PNG（只有 IHDR 头、没有 IEND）→ 必须 FAIL，不能只 WARN
  const brokenAvatar = makeFixture();
  try {
    fs.writeFileSync(path.join(brokenAvatar, 'miniprogram/images/avatars/default.png'), pngBytes(200, 200).subarray(0, 40));
    const result = runChecks(brokenAvatar);
    assert.ok(failMessages(result).some((m) => m.includes('默认头像不是可解析的 PNG')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(brokenAvatar);
  }

  // 头像文件短到读不出 PNG 头（4 字节）：必须安全 FAIL，不能抛异常中断预检
  const tinyAvatar = makeFixture();
  try {
    fs.writeFileSync(path.join(tinyAvatar, 'miniprogram/images/avatars/default.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = runChecks(tinyAvatar);
    assert.ok(failMessages(result).some((m) => m.includes('默认头像不是可解析的 PNG')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(tinyAvatar);
  }

  // 默认头像路径以 constants.js 为准：改了常量而旧文件还在时，不能继续 PASS 旧头像
  const movedAvatar = makeFixture();
  try {
    writeFixtureFile(movedAvatar, 'miniprogram/utils/constants.js', 'const DEFAULT_AVATAR = ' + "'/images/moved.png';\n" + 'module.exports = { DEFAULT_AVATAR };\n');
    const result = runChecks(movedAvatar);
    assert.ok(failMessages(result).some((m) => m.includes('默认头像缺失：miniprogram/images/moved.png')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(movedAvatar);
  }

  // 图片放到 images/ 之外（含大写扩展名，扩展名匹配不区分大小写）
  const misplaced = makeFixture();
  try {
    writeFixtureFile(misplaced, 'miniprogram/pages/home/bg.png', pngBytes(10, 10));
    writeFixtureFile(misplaced, 'miniprogram/pages/home/BG.PNG', pngBytes(10, 10));
    const result = runChecks(misplaced);
    assert.ok(failMessages(result).some((m) => m.includes('图片必须放在 miniprogram/images/ 下')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(misplaced);
  }

  // 只有大写扩展名时也必须被识别为图片（扩展名匹配不区分大小写）
  const upperOnly = makeFixture();
  try {
    writeFixtureFile(upperOnly, 'miniprogram/pages/home/ONLY.PNG', pngBytes(10, 10));
    const result = runChecks(upperOnly);
    assert.ok(failMessages(result).some((m) => m.includes('图片必须放在 miniprogram/images/ 下')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(upperOnly);
  }

  // 目录前缀必须精确到 images/：images_extra/ 不算合规
  const siblingDir = makeFixture();
  try {
    writeFixtureFile(siblingDir, 'miniprogram/images_extra/x.png', pngBytes(10, 10));
    const result = runChecks(siblingDir);
    assert.ok(failMessages(result).some((m) => m.includes('图片必须放在 miniprogram/images/ 下')), failMessages(result).join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(siblingDir);
  }

  // 单张图片超过 100KB（文案带真实字节数，不四舍五入成「100KB」自相矛盾）
  const oversized = makeFixture();
  try {
    writeFixtureFile(oversized, 'miniprogram/images/big.png', Buffer.alloc(100 * 1024 + 1, 1));
    const result = runChecks(oversized);
    const msgs = failMessages(result);
    assert.ok(msgs.some((m) => m.includes('单张图片不能超过 100KB')), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.includes('102401 字节')), 'FAIL 文案应给出真实字节数：' + msgs.join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(oversized);
  }

  // 恰好 100KB 属于「≤100KB」，应当通过
  const exact = makeFixture();
  try {
    writeFixtureFile(exact, 'miniprogram/images/edge.png', Buffer.alloc(100 * 1024, 1));
    const result = runChecks(exact);
    assert.deepStrictEqual(failMessages(result), [], '恰好 100KB 不应 FAIL');
    assert.ok(packagePass(result), '恰好 100KB 应打印包体 PASS');
  } finally {
    cleanup(exact);
  }

  // 小程序包体达到 2MB（文档是「< 2MB」，等于也不合规）
  const heavy = makeFixture();
  try {
    writeFixtureFile(heavy, 'miniprogram/utils/big.bin', Buffer.alloc(2 * 1024 * 1024, 1));
    const result = runChecks(heavy);
    const msgs = failMessages(result);
    assert.ok(msgs.some((m) => m.includes('小程序包体不能超过 2MB')), msgs.join('\n'));
    noPackagePass(result);
  } finally {
    cleanup(heavy);
  }
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

test('发布预检：自定义组件按页面/组件作用域注册，跨页注册不算（app.json 全局注册才全局生效）', () => {
  const STRUCTURE_PASS = '自定义组件文件齐全且按页面/组件作用域注册（app.json 全局注册也放行）';
  const writeComponent = (dir, name) => {
    for (const ext of ['js', 'json', 'wxml']) {
      writeFixtureFile(dir, 'miniprogram/components/' + name + '/index.' + ext, ext === 'json' ? '{"component":true}' : '');
    }
  };

  // ① 健康夹具：作用域检查 PASS
  const healthy = makeFixture();
  try {
    const result = runChecks(healthy);
    assert.deepStrictEqual(failMessages(result), [], failMessages(result).join('\n'));
    const passText = result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
    assert.ok(passText.includes(STRUCTURE_PASS), passText);
  } finally {
    cleanup(healthy);
  }

  // ② 只在 bind 页注册、却在 home 页使用：真机必然「组件未找到」，旧的全仓合并集合会漏报
  const crossPage = makeFixture();
  try {
    writeFixtureFile(crossPage, 'miniprogram/pages/home/index.json', JSON.stringify({ usingComponents: {} }));
    const result = runChecks(crossPage);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(
      fails.includes(
        'miniprogram/pages/home/index.wxml 用了未注册的组件 <privacy-guard>（usingComponents 按页面/组件隔离，miniprogram/pages/home/index.json 与 app.json 都没声明）'
      ),
      fails
    );
    const passText = result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
    assert.ok(!passText.includes(STRUCTURE_PASS), '有 FAIL 时不应再打印作用域 PASS');
  } finally {
    cleanup(crossPage);
  }

  // ③ app.json 的 usingComponents 是全局生效的：没在页面 json 注册也应放行
  const globalReg = makeFixture();
  try {
    writeComponent(globalReg, 'bottom-sheet');
    const app = JSON.parse(fs.readFileSync(path.join(globalReg, 'miniprogram/app.json'), 'utf8'));
    app.usingComponents = { 'bottom-sheet': '/components/bottom-sheet/index' };
    writeFixtureFile(globalReg, 'miniprogram/app.json', JSON.stringify(app));
    writeFixtureFile(globalReg, 'miniprogram/pages/home/index.wxml', PRIVACY_TAG + '<bottom-sheet show="{{false}}" />\n');
    const result = runChecks(globalReg);
    assert.deepStrictEqual(failMessages(result), [], failMessages(result).join('\n'));
  } finally {
    cleanup(globalReg);
  }

  // ④ 组件自己的 wxml 也受作用域约束：页面 json 注册的组件不能给组件用
  const componentScope = makeFixture();
  try {
    writeComponent(componentScope, 'empty-state');
    writeFixtureFile(componentScope, 'miniprogram/pages/bind/index.json', JSON.stringify({
      usingComponents: {
        'privacy-guard': '/components/privacy-guard/index',
        'empty-state': '/components/empty-state/index',
      },
    }));
    writeFixtureFile(componentScope, 'miniprogram/components/privacy-guard/index.wxml', '<empty-state />\n');
    const result = runChecks(componentScope);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(
      fails.includes(
        'miniprogram/components/privacy-guard/index.wxml 用了未注册的组件 <empty-state>（usingComponents 按页面/组件隔离，miniprogram/components/privacy-guard/index.json 与 app.json 都没声明）'
      ),
      fails
    );
  } finally {
    cleanup(componentScope);
  }

  // ⑤ 内置组件（view / scroll-view / rich-text / picker-view 等）不需要注册；
  //    wxml 注释（含跨行）里的示例标签也不算使用
  const builtinAndComment = makeFixture();
  try {
    writeFixtureFile(
      builtinAndComment,
      'miniprogram/pages/home/index.wxml',
      PRIVACY_TAG
        + '<scroll-view scroll-y="{{true}}"><view>x</view></scroll-view>' + '\n'
        + '<rich-text nodes="{{[]}}" /><picker-view><picker-view-column /></picker-view>' + '\n'
        + '<view bindtap="noop">x</view>' + '\n'
        + '<!-- 单行 <foo-bar /> -->' + '\n'
        + '<!--' + '\n<foo-bar />\n' + '-->' + '\n'
    );
    const result = runChecks(builtinAndComment);
    assert.deepStrictEqual(failMessages(result), [], failMessages(result).join('\n'));
  } finally {
    cleanup(builtinAndComment);
  }

  // ⑥ 组件自身 json 注册的组件给组件自己用：合法（不能只测页面作用域的负例）
  const componentOwnScope = makeFixture();
  try {
    writeComponent(componentOwnScope, 'empty-state');
    writeFixtureFile(componentOwnScope, 'miniprogram/components/privacy-guard/index.json', JSON.stringify({
      component: true,
      usingComponents: { 'empty-state': '/components/empty-state/index' },
    }));
    writeFixtureFile(componentOwnScope, 'miniprogram/components/privacy-guard/index.wxml', '<empty-state />' + '\n');
    const result = runChecks(componentOwnScope);
    assert.deepStrictEqual(failMessages(result), [], failMessages(result).join('\n'));
  } finally {
    cleanup(componentOwnScope);
  }

  // ⑦ usingComponents 用相对路径（../../components/x/index）时按 json 所在目录解析
  const relativeRef = makeFixture();
  try {
    writeFixtureFile(relativeRef, 'miniprogram/pages/home/index.json', JSON.stringify({
      usingComponents: { 'privacy-guard': '../../components/privacy-guard/index' },
    }));
    const result = runChecks(relativeRef);
    assert.deepStrictEqual(failMessages(result), [], failMessages(result).join('\n'));
  } finally {
    cleanup(relativeRef);
  }

  // ⑧ wxml 与 json 同名但不叫 index（components/y/card.wxml + card.json）也按同名 json 取注册域
  const nonIndexName = makeFixture();
  try {
    writeComponent(nonIndexName, 'inner-comp');
    writeFixtureFile(nonIndexName, 'miniprogram/components/y/card.js', 'Component({});' + '\n');
    writeFixtureFile(nonIndexName, 'miniprogram/components/y/card.json', JSON.stringify({
      component: true,
      usingComponents: { 'inner-comp': '/components/inner-comp/index' },
    }));
    writeFixtureFile(nonIndexName, 'miniprogram/components/y/card.wxml', '<inner-comp />' + '\n');
    const result = runChecks(nonIndexName);
    assert.deepStrictEqual(failMessages(result), [], failMessages(result).join('\n'));
  } finally {
    cleanup(nonIndexName);
  }

  // ⑨ 无连字符 / 下划线的自定义组件也纳入扫描：<foo>、<my_comp> 未注册要 FAIL
  const plainTags = makeFixture();
  try {
    writeFixtureFile(plainTags, 'miniprogram/pages/home/index.wxml', PRIVACY_TAG + '<foo />' + '\n<my_comp />' + '\n');
    const result = runChecks(plainTags);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false);
    assert.ok(
      fails.includes(
        'miniprogram/pages/home/index.wxml 用了未注册的组件 <foo>（usingComponents 按页面/组件隔离，miniprogram/pages/home/index.json 与 app.json 都没声明）'
      ),
      fails
    );
    assert.ok(fails.includes('用了未注册的组件 <my_comp>'), fails);
  } finally {
    cleanup(plainTags);
  }

  // ⑩ 同一组件重复使用只报一条（Set 去重）；自闭合与成对写法按标签名比较
  const duplicateTag = makeFixture();
  try {
    writeFixtureFile(duplicateTag, 'miniprogram/pages/home/index.json', JSON.stringify({ usingComponents: {} }));
    writeFixtureFile(duplicateTag, 'miniprogram/pages/home/index.wxml', '<foo-bar />' + '\n<foo-bar></foo-bar>' + '\n');
    const result = runChecks(duplicateTag);
    const fails = failMessages(result);
    assert.strictEqual(fails.filter((m) => m.includes('<foo-bar>')).length, 1, fails.join('\n'));
  } finally {
    cleanup(duplicateTag);
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
        permissions: { openapi: ['security.msgSecCheck', 'subscribeMessage.send'] },
        triggers: {},
      })),
      expect: 'triggers 必须是数组',
    },
    {
      name: 'config.json 少了内容安全权限（会让审核静默 fail-open）',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/config.json', JSON.stringify({
        permissions: { openapi: ['subscribeMessage.send'] },
        triggers: [{ name: 'reminder-tick', type: 'timer', config: '0 */10 * * * * *' }],
      })),
      expect: '缺少云调用权限：security.msgSecCheck',
    },
    {
      name: 'config.json 少了订阅消息权限',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/config.json', JSON.stringify({
        permissions: { openapi: ['security.msgSecCheck'] },
        triggers: [{ name: 'reminder-tick', type: 'timer', config: '0 */10 * * * * *' }],
      })),
      expect: '缺少云调用权限：subscribeMessage.send',
    },
    {
      name: 'config.json 少了 reminder-tick 触发器（提醒永远不会发）',
      mutate: (dir) => writeFixtureFile(dir, 'cloudfunctions/api/config.json', JSON.stringify({
        permissions: { openapi: ['security.msgSecCheck', 'subscribeMessage.send'] },
        triggers: [],
      })),
      expect: '缺少 reminder-tick 定时触发器',
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

test('发布预检：客户端悬空的 api.call 会被拦下（13.11 未处理的 Promise）', () => {
  const passText = (result) => result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
  const hasPromisePass = (result) => passText(result).includes('客户端 api.call 都已被 await / .then / .catch / return 处理');

  // 没有 api.call 时只提示 WARN，不能让预检失败
  const empty = makeFixture();
  try {
    const result = runChecks(empty);
    assert.deepStrictEqual(failMessages(result), [], '没有 api.call 时不该 FAIL');
    assert.strictEqual(
      result.warnings.filter((w) => w.includes('没有扫描到客户端 api.call')).length,
      1,
      '没有 api.call 时应提示一次 WARN',
    );
  } finally {
    cleanup(empty);
  }

  // 各种「已处理」写法都必须放过：await / return / 同行与跨行链式 /
  // 注释与字符串（含反引号模板串里的 //）里的 api.call 不算调用 / 多行 await Promise.all / 先存 promise 后 await
  const handled = makeFixture();
  try {
    writeFixtureFile(handled, 'miniprogram/utils/http.js', [
      "'use strict';",
      'async function load() {',
      "  await api.call('home.get');",
      "  return api.call('user.get');",
      "  api.call('mood.set').catch(() => {});",
      "  api.call('anniversary.add')",
      '    .then(() => {})',
      '    .catch(() => {});',
      "  // api.call('line.comment');",
      "  const noop = 1; // api.call('tail.comment');",
      "  /* api.call('block.comment'); */",
      "  const s1 = 'a // b'; // 字符串里的 // 不是注释",
      "  const s2 = \"api.call('str.inside')\";",
      "  const s3 = \u0060https://a.b\u0060; await api.call('template.after');",
      '  /*',
      "   * api.call('jsdoc.body');",
      '   */',
      '  const many = await Promise.all([',
      "    api.call('a.one'),",
      "    api.call('a.two'),",
      '  ]);',
      "  const pending = api.call('later.init');",
      '  await pending;',
      "  api.call('chain.cmt')",
      '    // 中间夹注释',
      '',
      '    .then(() => {})',
      '    .catch(() => {});',
      "  api.call('multi.arg', {",
      '    id: 1,',
      '  }).then(() => {});',
      "  api.call('multi.arg2', {",
      '    id: 2,',
      '  })',
      '    .catch(() => {});',
      "  const pair = await Promise.all([api.call('pair.one', { limit: 20 }), api.call('pair.two')]);",
      "  const longOne = await Promise.all([api.call('long.pad', '" + 'x'.repeat(1500) + "'), api.call('long.second')]);",
      '  let late;',
      "  late = api.call('late.assign');",
      '  await late;',
      "  const origin = api.call('alias.origin');",
      '  const aliasRef = origin;',
      '  aliasRef.then(() => {});',
      "  const arrow = () => api.call('arrow.return');",
      "  api?.call('optional.chain').then(() => {});",
      "  const p1 = api.call('stored.one');",
      "  const p2 = api.call('stored.two');",
      '  await Promise.all([p1, p2]);',
      "  const p3 = api.call('stored.three');",
      "  const origin2 = api.call('alias.await');",
      '  const ref2 = origin2;',
      '  await Promise.all([ref2]);',
      '  return Promise.allSettled([p3]);',
      '}',
      'module.exports = { load, many };',
    ].join('\n') + '\n');
    const result = runChecks(handled);
    assert.deepStrictEqual(failMessages(result), [], '已处理的 api.call 不该误报：' + failMessages(result).join('\n'));
    assert.ok(
      hasPromisePass(result) && passText(result).includes('（23 个调用 / 21 行，无未处理 Promise）'),
      '注释/字符串不该计入，23 个真实调用应全部放行（含对象参数 Promise.all / 多行参数 .then / 长语句 / 先声明后赋值 / 别名 / 箭头隐式返回 / 可选链 / 存进变量后 Promise.all）：' + passText(result),
    );
  } finally {
    cleanup(handled);
  }

  // 悬空调用必须 FAIL 并指出文件与行号；同行无关 await、行尾注释里的 .then 都不算已处理
  const dangling = makeFixture();
  try {
    writeFixtureFile(dangling, 'miniprogram/pages/home/extra.js', [
      'async function load() {',
      "  api.call('home.get');",
      "  const a = await foo(); api.call('after.await');",
      "  api.call('cmt.tail'); // .then(() => {})",
      '}',
      'module.exports = { load };',
      '',
    ].join('\n'));
    const result = runChecks(dangling);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false, '悬空 api.call 应让预检失败');
    [2, 3, 4].forEach((line) => {
      assert.ok(
        fails.includes('miniprogram/pages/home/extra.js:' + line + ' 的 api.call 没有被 await / .then / .catch 处理（13.11 未处理的 Promise）'),
        '第 ' + line + ' 行应报未处理：' + fails,
      );
    });
    assert.ok(!hasPromisePass(result), '有 FAIL 时不应再输出 api.call PASS 文案');
  } finally {
    cleanup(dangling);
  }

  // 语句回扫超过上限时必须 WARN，不能静默漏掉更前面的 await
  const far = makeFixture();
  try {
    writeFixtureFile(
      far,
      'miniprogram/utils/far.js',
      'async function f() {\n  const far = await Promise.all([' + ' '.repeat(6000) + "api.call('far.one'), api.call('far.two')]);\n}\n",
    );
    const result = runChecks(far);
    assert.strictEqual(result.ok, false, '回扫截断后找不到 await，该调用应 FAIL');
    assert.strictEqual(
      result.warnings.filter((w) => w.includes('语句回扫达到 5000 字符上限')).length,
      1,
      '回扫截断必须 WARN，且同一行多个调用只报一次',
    );
  } finally {
    cleanup(far);
  }
  // 调用偏移恰好等于回扫上限、前面已扫到文件头：不应误报「截断」WARN
  const edge = makeFixture();
  try {
    writeFixtureFile(edge, 'miniprogram/utils/edge.js', ' '.repeat(5000) + "api.call('edge.dangling')\n");
    const result = runChecks(edge);
    assert.strictEqual(result.ok, false, '悬空调用仍应 FAIL');
    assert.strictEqual(
      result.warnings.filter((w) => w.includes('语句回扫达到 5000 字符上限')).length,
      0,
      '扫到文件头时不应误报截断',
    );
  } finally {
    cleanup(edge);
  }
  // 超大文件被 readText 跳过后不能静默：至少 WARN 提示未检查
  const huge = makeFixture();
  try {
    writeFixtureFile(
      huge,
      'miniprogram/utils/huge.js',
      '// filler\n'.repeat(120000) + "api.call('huge.dangling');\n",
    );
    writeFixtureFile(huge, 'miniprogram/utils/ok.js', "async function f() { await api.call('ok.get'); }\n");
    const result = runChecks(huge);
    assert.strictEqual(result.ok, true, '超大文件应跳过而不是 FAIL：' + failMessages(result).join(' | '));
    assert.strictEqual(
      result.warnings.filter((w) => w.includes('未检查未处理 Promise')).length,
      1,
      '跳过大文件必须 WARN（未处理 Promise 检查）',
    );
    assert.strictEqual(
      result.warnings.filter((w) => w.includes('云访问边界：跳过无法读取的客户端文件')).length,
      1,
      '跳过大文件必须 WARN（云访问边界检查）',
    );
    assert.ok(
      passText(result).includes('（已跳过 1 个无法读取的文件）'),
      'PASS 文案要注明跳过的文件数，不能过度声称全部检查过：' + passText(result),
    );
  } finally {
    cleanup(huge);
  }
});

test('发布预检：客户端不直连数据库、云函数入口唯一（11.9）', () => {
  const passText = (result) => result.lines.filter((l) => l.level === 'PASS').map((l) => l.msg).join('\n');
  const warnText = (result) => result.warnings.join('\n');
  const boundaryPass = (result) => passText(result).includes('客户端未直连数据库、云函数调用只经 utils/api.js');

  // 健康夹具：检查项给出 PASS，且不误报
  const healthy = makeFixture();
  try {
    const result = runChecks(healthy);
    assert.deepStrictEqual(failMessages(result), [], '健康夹具不应有 FAIL 项');
    assert.ok(boundaryPass(result), '缺少客户端云访问边界 PASS：' + passText(result));
    assert.ok(!warnText(result).includes('云函数入口检查可能失效'), '有入口时不应提示检查失效');
    assert.ok(!warnText(result).includes('白名单入口'), '入口存在时不应提示入口缺失');
  } finally {
    cleanup(healthy);
  }

  // 页面绕过 api.js：直连数据库 + 直调云函数，两处都要 FAIL 并带文件:行号
  const bypass = makeFixture();
  try {
    writeFixtureFile(
      bypass,
      'miniprogram/pages/home/extra.js',
      ['const db = wx.cloud.database();', "wx.cloud.callFunction({ name: 'api' });", 'module.exports = {};', ''].join('\n'),
    );
    const result = runChecks(bypass);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false, '绕过 utils/api.js 应让预检失败');
    assert.ok(
      fails.includes('miniprogram/pages/home/extra.js:1 客户端直接访问云数据库 wx.cloud.database（文档 11.9 要求全局搜索为空）'),
      '直连数据库应报文件:1：' + fails,
    );
    assert.ok(
      fails.includes('miniprogram/pages/home/extra.js:2 在 utils/api.js 之外直接调用 wx.cloud.callFunction（客户端云函数入口唯一，只允许 utils/api.js）'),
      '绕过入口应报文件:2：' + fails,
    );
    assert.ok(!boundaryPass(result), '有 FAIL 时不应再打印云访问边界 PASS');
  } finally {
    cleanup(bypass);
  }

  // 括号写法同样要拦（遮蔽后括号里的键要从原文取回来）
  const bracket = makeFixture();
  try {
    writeFixtureFile(
      bracket,
      'miniprogram/pages/home/extra.js',
      [
        "const db = wx.cloud['database']();",
        "wx.cloud['callFunction']({ name: 'api' });",
        "const db2 = wx.cloud[ /* 兼容旧写法 */ 'database' ]();",
        'module.exports = {};',
        '',
      ].join('\n'),
    );
    const result = runChecks(bracket);
    const fails = failMessages(result).join('\n');
    assert.strictEqual(result.ok, false, "wx.cloud['database'] / wx.cloud['callFunction'] 也要让预检失败");
    assert.ok(
      fails.includes('miniprogram/pages/home/extra.js:1 客户端直接访问云数据库 wx.cloud.database'),
      '括号直连数据库应报文件:1：' + fails,
    );
    assert.ok(
      fails.includes('miniprogram/pages/home/extra.js:2 在 utils/api.js 之外直接调用 wx.cloud.callFunction'),
      '括号绕过入口应报文件:2：' + fails,
    );
    assert.ok(
      fails.includes('miniprogram/pages/home/extra.js:3 客户端直接访问云数据库 wx.cloud.database'),
      '括号里夹注释也要拦住（第 3 行）：' + fails,
    );
  } finally {
    cleanup(bracket);
  }

  // 白名单只认精确路径：同名 pages/api.js 不算；入口文件自己直连数据库也要 FAIL
  const sameName = makeFixture();
  try {
    writeFixtureFile(sameName, 'miniprogram/pages/api.js', "wx.cloud.callFunction({ name: 'api' });\n");
    const fails = failMessages(runChecks(sameName)).join('\n');
    assert.ok(
      fails.includes('miniprogram/pages/api.js:1 在 utils/api.js 之外直接调用 wx.cloud.callFunction'),
      '只有精确路径才算入口：' + fails,
    );
  } finally {
    cleanup(sameName);
  }

  const entryDb = makeFixture();
  try {
    writeFixtureFile(
      entryDb,
      'miniprogram/utils/api.js',
      "const db = wx.cloud.database();\nfunction call(action) {\n  return wx.cloud.callFunction({ name: 'api', data: { action } });\n}\nmodule.exports = { call };\n",
    );
    const fails = failMessages(runChecks(entryDb)).join('\n');
    assert.ok(
      fails.includes('miniprogram/utils/api.js:1 客户端直接访问云数据库 wx.cloud.database'),
      '入口文件自己直连数据库也要 FAIL：' + fails,
    );
  } finally {
    cleanup(entryDb);
  }

  // 注释 / 字符串里的示例不误报；api.js 里跨行的 wx.cloud 换行 .callFunction 属于允许写法
  const subtle = makeFixture();
  try {
    writeFixtureFile(
      subtle,
      'miniprogram/pages/home/comment.js',
      [
        '// wx.cloud.database() 只是示例',
        "const tip = 'wx.cloud.database';",
        '/* wx.cloud.callFunction */',
        'const note = "wx.cloud.callFunction";',
        'module.exports = { tip, note };',
        '',
      ].join('\n'),
    );
    writeFixtureFile(
      subtle,
      'miniprogram/utils/api.js',
      [
        'function call(action) {',
        '  return wx.cloud',
        "    .callFunction({ name: 'api', data: { action } });",
        '}',
        'module.exports = { call };',
        '',
      ].join('\n'),
    );
    const result = runChecks(subtle);
    assert.deepStrictEqual(failMessages(result), [], '注释/字符串里的示例不应误报');
    assert.ok(boundaryPass(result), '跨行入口写法应当放行：' + passText(result));
  } finally {
    cleanup(subtle);
  }

  // CRLF 与多命中：行号要准，两处违规要各报一条
  const crlf = makeFixture();
  try {
    writeFixtureFile(
      crlf,
      'miniprogram/pages/home/crlf.js',
      [
        'module.exports = {};',
        'wx.cloud.database();',
        'module.exports = {};',
        'module.exports = {};',
        "wx.cloud.callFunction({ name: 'api' });",
        '',
      ].join('\r\n'),
    );
    const fails = failMessages(runChecks(crlf));
    assert.strictEqual(fails.length, 2, '两处违规应各报一条：' + fails.join(' | '));
    assert.ok(fails[0].startsWith('miniprogram/pages/home/crlf.js:2 '), 'CRLF 第 2 行：' + fails[0]);
    assert.ok(fails[1].startsWith('miniprogram/pages/home/crlf.js:5 '), 'CRLF 第 5 行：' + fails[1]);
  } finally {
    cleanup(crlf);
  }

  // 点号与括号混合命中：FAIL 必须按源码行序输出
  const mixed = makeFixture();
  try {
    writeFixtureFile(
      mixed,
      'miniprogram/pages/home/mixed.js',
      [
        'module.exports = {};',
        'wx.cloud.database();',
        "wx.cloud['database']();",
        'module.exports = {};',
        'module.exports = {};',
        "wx.cloud.callFunction({ name: 'api' });",
        '',
      ].join('\n'),
    );
    const fails = failMessages(runChecks(mixed));
    assert.strictEqual(fails.length, 3, '三处违规应各报一条：' + fails.join(' | '));
    assert.ok(fails[0].startsWith('miniprogram/pages/home/mixed.js:2 '), '第 2 行点号直连：' + fails[0]);
    assert.ok(fails[1].startsWith('miniprogram/pages/home/mixed.js:3 '), '第 3 行括号直连：' + fails[1]);
    assert.ok(fails[2].startsWith('miniprogram/pages/home/mixed.js:6 '), '第 6 行绕过入口：' + fails[2]);
  } finally {
    cleanup(mixed);
  }

  // 入口文件用括号写法调 callFunction 属于允许写法：放行且仍算入口调用
  const entryBracket = makeFixture();
  try {
    writeFixtureFile(
      entryBracket,
      'miniprogram/utils/api.js',
      "function call(action) {\n  return wx.cloud['callFunction']({ name: 'api', data: { action } });\n}\nmodule.exports = { call };\n",
    );
    const result = runChecks(entryBracket);
    assert.deepStrictEqual(failMessages(result), [], '入口括号写法不应 FAIL：' + failMessages(result).join(' | '));
    assert.ok(boundaryPass(result), '入口括号写法应放行：' + passText(result));
    assert.ok(!warnText(result).includes('白名单入口'), '入口存在时不应提示入口缺失：' + warnText(result));
  } finally {
    cleanup(entryBracket);
  }

  // 转义键（'\\u0064atabase'）先还原再比对，不能靠转义绕过
  const escaped = makeFixture();
  try {
    writeFixtureFile(
      escaped,
      'miniprogram/pages/home/escaped.js',
      "const db = wx.cloud['\\u0064atabase']();\nmodule.exports = {};\n",
    );
    const fails = failMessages(runChecks(escaped)).join('\n');
    assert.ok(
      fails.includes('miniprogram/pages/home/escaped.js:1 客户端直接访问云数据库 wx.cloud.database'),
      '转义键应还原后 FAIL：' + fails,
    );
  } finally {
    cleanup(escaped);
  }

  // 模板字面量键无法静态解析：WARN 提示人工确认，不直接判 FAIL
  const templated = makeFixture();
  try {
    writeFixtureFile(
      templated,
      'miniprogram/pages/home/templated.js',
      'const db = wx.cloud[`database`]();\nmodule.exports = {};\n',
    );
    const result = runChecks(templated);
    assert.deepStrictEqual(failMessages(result), [], '模板键不直接判 FAIL：' + failMessages(result).join(' | '));
    assert.ok(warnText(result).includes('无法静态解析 wx.cloud[...] 的键'), '模板键必须 WARN：' + warnText(result));
    assert.ok(boundaryPass(result), '存在入口调用时整体仍可 PASS：' + passText(result));
  } finally {
    cleanup(templated);
  }

  // 动态键无法静态判断：给 WARN 而不是放过
  const dynamic = makeFixture();
  try {
    writeFixtureFile(dynamic, 'miniprogram/pages/home/dyn.js', "const key = 'database';\nmodule.exports = wx.cloud[key];\n");
    const result = runChecks(dynamic);
    assert.deepStrictEqual(failMessages(result), [], '动态键不直接判 FAIL：' + failMessages(result).join(' | '));
    assert.ok(warnText(result).includes('有动态键的 wx.cloud[...]'), '动态键必须 WARN：' + warnText(result));
    assert.ok(boundaryPass(result), '存在入口调用时整体仍可 PASS：' + passText(result));
  } finally {
    cleanup(dynamic);
  }

  // 入口整个消失：没有 callFunction 时必须 WARN，不能静默绿成 PASS
  const noEntry = makeFixture();
  try {
    fs.rmSync(path.join(noEntry, 'miniprogram/utils/api.js'));
    const result = runChecks(noEntry);
    assert.strictEqual(result.ok, true, '缺入口不是 FAIL（结构检查另有职责）：' + failMessages(result).join(' | '));
    assert.ok(
      result.warnings.some((w) => w.includes('云函数入口检查可能失效')),
      '没有 callFunction 时必须 WARN，否则检查静默失效',
    );
    assert.ok(!boundaryPass(result), '没有可检查的调用时不应假 PASS');
  } finally {
    cleanup(noEntry);
  }

  // 改名 / 移动入口：外部调用判 FAIL，并额外提示白名单入口不存在
  const renamed = makeFixture();
  try {
    fs.rmSync(path.join(renamed, 'miniprogram/utils/api.js'));
    writeFixtureFile(
      renamed,
      'miniprogram/utils/cloud-api.js',
      "function call(action) {\n  return wx.cloud.callFunction({ name: 'api', data: { action } });\n}\nmodule.exports = { call };\n",
    );
    const result = runChecks(renamed);
    const fails = failMessages(result).join('\n');
    assert.ok(
      fails.includes('miniprogram/utils/cloud-api.js:2 在 utils/api.js 之外直接调用 wx.cloud.callFunction'),
      '改名后入口调用应 FAIL：' + fails,
    );
    assert.ok(warnText(result).includes('白名单入口 miniprogram/utils/api.js 不存在'), '改名应额外 WARN：' + warnText(result));
  } finally {
    cleanup(renamed);
  }

  // 一个客户端 JS 都扫不到：FAIL，不能因为「没东西可查」而静默通过
  const noJs = makeFixture();
  try {
    const entries = fs.readdirSync(path.join(noJs, 'miniprogram'), { recursive: true });
    for (const rel of entries) {
      if (String(rel).endsWith('.js')) fs.rmSync(path.join(noJs, 'miniprogram', String(rel)));
    }
    const result = runChecks(noJs);
    assert.strictEqual(result.ok, false, '扫不到客户端 JS 应 FAIL');
    assert.ok(
      failMessages(result).join('\n').includes('没有扫描到客户端 JS 文件'),
      '应给出明确 FAIL 文案：' + failMessages(result).join(' | '),
    );
    assert.ok(!boundaryPass(result), '空目录不应假 PASS');
  } finally {
    cleanup(noJs);
  }
});
