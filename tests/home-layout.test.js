'use strict';

// M8「tabBar + 手绘涂鸦风」的静态自检（文档 8.2 / 8.7 / 9.x）。
// 小程序样式无法在 Node 里真跑，这里守住「导航结构、热区、虚线/硬阴影、无渐变」这些硬约束；
// 真机观感仍以 docs/M6-真机验收与发布.md 为准。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MINI = path.join(ROOT, 'miniprogram');
const read = (rel) => fs.readFileSync(path.join(MINI, rel), 'utf8');

const HOME_WXML = read('pages/home/index.wxml');
const HOME_WXSS = read('pages/home/index.wxss');
const APP_WXSS = read('app.wxss');
const APP_JSON = JSON.parse(read('app.json'));
const TAB_WXML = read('custom-tab-bar/index.wxml');
const TAB_JS = read('custom-tab-bar/index.js');
const TAB_WXSS = read('custom-tab-bar/index.wxss');

const constants = require('../miniprogram/utils/constants');

function declsOf(css, selector) {
  const start = css.indexOf(selector + ' {');
  assert.ok(start >= 0, 'wxss 里找不到规则 ' + selector);
  const brace = css.indexOf('{', start);
  const end = css.indexOf('}', brace);
  // 只取花括号里的声明，别把「.x {」前缀当成第一条声明
  const body = css.slice(brace + 1, end);
  const out = {};
  body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf(':');
      if (i < 0) return;
      out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
  return out;
}

function walk(dir, out) {
  const list = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'miniprogram_npm') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, list);
    else list.push(full);
  }
  return list;
}

const ALL_WXSS = walk(MINI).filter((f) => f.endsWith('.wxss'));
const relOf = (f) => path.relative(MINI, f).split(path.sep).join('/');

test('8.2 tabBar：5 个 tab，顺序与 constants.TAB_ROUTES 一致', () => {
  const tabBar = APP_JSON.tabBar;
  assert.ok(tabBar, 'app.json 缺 tabBar');
  assert.strictEqual(tabBar.custom, true, '外观由 custom-tab-bar 组件渲染，必须 custom: true');
  assert.strictEqual(tabBar.list.length, 5, '小程序 tabBar 最多 5 项');
  const list = tabBar.list.map((item) => '/' + item.pagePath);
  assert.deepStrictEqual(list, constants.TAB_ROUTES, 'tabBar.list 与 TAB_ROUTES 顺序不一致');
  for (const item of tabBar.list) {
    assert.ok(item.text && item.text.length <= 4, item.pagePath + ' 的 tab 文案要短（≤4 字）');
    assert.ok(APP_JSON.pages.indexOf(item.pagePath) >= 0, item.pagePath + ' 未在 pages 注册');
    // tab 页统一用系统导航栏，标题位置才一致
    const json = JSON.parse(read(item.pagePath + '.json'));
    assert.notStrictEqual(json.navigationStyle, 'custom', item.pagePath + ' 不该再用自定义导航');
  }
});

test('8.2 tab 页之间只走 switchTab：首页与我的都不再用 navigateTo 跳 tab', () => {
  const homeJs = read('pages/home/index.js');
  assert.ok(homeJs.includes('constants.isTabRoute(route)'), '首页要按 tab / 非 tab 分流');
  assert.ok(homeJs.includes('wx.switchTab({ url: route })'), 'tab 页要用 switchTab');
  assert.ok(homeJs.includes('wx.navigateTo({ url: route })'), '非 tab 页（报平安）仍用 navigateTo');
  const profileJs = read('pages/profile/index.js');
  assert.ok(
    /onOpenMood[\s\S]{0,220}wx\.switchTab\(\{\s*url:\s*constants\.ROUTES\.mood/.test(profileJs),
    '我的页的「心情记录」入口要改成 switchTab'
  );
  // isTabRoute 要认路径，也要认带 query 的 url（分享卡片会带 ?code=）
  assert.strictEqual(constants.isTabRoute('/pages/mood/index'), true);
  assert.strictEqual(constants.isTabRoute('/pages/mood/index?from=home'), true);
  assert.strictEqual(constants.isTabRoute('/pages/safety/index'), false);
});

test('8.2 每个 tab 页在 onShow 里同步选中态（getTabBar 判空）', () => {
  for (const page of ['home', 'diary', 'wish', 'mood', 'profile']) {
    const js = read('pages/' + page + '/index.js');
    assert.match(
      js,
      new RegExp('tabbar\\.sync\\(this, constants\\.ROUTES\\.' + page + '\\)'),
      page + ' 页没有同步 tabBar 选中态'
    );
    assert.match(js, /onShow\s*\(\)\s*\{[\s\S]{0,200}tabbar\.sync/, page + ' 的 sync 要写在 onShow 里（每次切回都同步）');
  }
  const util = read('utils/tabbar.js');
  assert.ok(util.includes("typeof page.getTabBar !== 'function'"), 'getTabBar 不存在时要判空（非 tab 页/单测）');
  assert.ok(util.includes("if (!bar || typeof bar.setData !== 'function') return"), 'getTabBar() 首次可能返回 null');
});

test('8.2 自定义 tabBar：虚线顶边、文字标签、马克笔高亮、安全区、热区 88rpx', () => {
  assert.ok(TAB_WXML.includes('bindtap="onTap"'), 'tab 项要可点');
  assert.ok(TAB_WXML.includes('aria-role="button"'), 'tab 项要有无障碍角色');
  assert.ok(TAB_WXML.includes('aria-label="{{item.text}}"'), 'tab 项要有可读标签');
  assert.ok(TAB_WXML.includes('aria-selected'), '当前 tab 要暴露选中态');
  assert.ok(TAB_JS.includes('wx.switchTab'), '点 tab 走 switchTab');
  assert.ok(TAB_JS.includes('fail: () => {}'), '切换失败不能抛到用户面前');

  const bar = declsOf(TAB_WXSS, '.tabbar');
  assert.ok(/dashed/.test(bar['border-top']), '顶边必须是虚线（8.7 不要实线边框）');
  assert.ok(bar.height.includes('env(safe-area-inset-bottom)'), 'tabBar 高度要含安全区');
  const item = declsOf(TAB_WXSS, '.tabbar__item');
  assert.strictEqual(item['min-height'], '88rpx', '单个 tab 热区 ≥88rpx（8.9）');
  const mark = declsOf(TAB_WXSS, '.tabbar__mark');
  assert.ok(mark['background-color'], '选中要高亮条');
});

test('8.7 全局：只有虚线边、彩色硬阴影、极小圆角，不用渐变与胶囊', () => {
  const card = declsOf(APP_WXSS, '.dk-card');
  assert.ok(/dashed/.test(card.border), '.dk-card 必须虚线描边');
  assert.ok(/var\(--shadow-card\)/.test(card['box-shadow']), '.dk-card 用 token 里的硬阴影');

  for (const file of ALL_WXSS) {
    const css = read(relOf(file));
    assert.strictEqual(/linear-gradient|radial-gradient/.test(css), false, relOf(file) + ' 用了渐变（8.7 禁止）');
    assert.strictEqual(/border-radius:\s*999rpx/.test(css), false, relOf(file) + ' 用了胶囊圆角（8.7 禁止大圆角）');
  }
});

test('8.7 页面卡片换成便签：日记/愿望/报平安/我的都走虚线 + 硬阴影', () => {
  const cases = [
    ['pages/diary/index.wxss', '.editor'],
    ['pages/wish/index.wxss', '.stats'],
    ['pages/safety/index.wxss', '.checkin'],
    ['components/diary-card/index.wxss', '.dc'],
    ['components/wish-item/index.wxss', '.wi'],
  ];
  // 我的页的卡片用的是公共 .card（app.wxss），单独校验一次
  const card = declsOf(APP_WXSS, '.card');
  assert.ok(/dashed/.test(card.border || ''), 'app.wxss 的 .card 也要走虚线');
  assert.ok(card['box-shadow'], 'app.wxss 的 .card 缺硬阴影');
  for (const [file, selector] of cases) {
    const d = declsOf(read(file), selector);
    assert.ok(/dashed/.test(d.border || ''), file + ' 的 ' + selector + ' 不是虚线边框');
    assert.ok(d['box-shadow'], file + ' 的 ' + selector + ' 缺硬阴影');
  }
});

test('9.2 首页：三张卡 + 四个入口，且不再有场景物件', () => {
  for (const gone of ['class="scene', 'class="lamp', 'class="fridge', 'class="sofa', 'class="door ', 'envelope']) {
    assert.strictEqual(HOME_WXML.includes(gone), false, '场景残留：' + gone + '（9.1 已废弃物件隐喻）');
  }
  const expects = [
    ['class="dk-card days-card', '日子卡'],
    ['class="dk-card hug-card', '抱抱卡'],
    ['class="dk-card mood-card', '心情卡'],
    ['bindtap="onTapDiary"', '写日记入口'],
    ['bindtap="onTapWish"', '愿望清单入口'],
    ['bindtap="onTapSafety"', '报平安入口'],
    ['bindtap="onTapMoodHistory"', '心情记录入口'],
  ];
  for (const [needle, label] of expects) {
    assert.ok(HOME_WXML.includes(needle), '首页缺少' + label);
  }
  // 入口必须写成「动词短语 + 一行状态」，不能只留图标
  assert.ok(HOME_WXML.includes('{{diarySub}}'), '日记入口缺状态摘要');
  assert.ok(HOME_WXML.includes('{{wishSub}}'), '愿望入口缺状态摘要');
  assert.ok(HOME_WXML.includes('{{safetySub}}'), '报平安入口缺状态摘要');
  // 旋转卡最多两张（9.2）；邀请卡与日子卡互斥（未绑定 / 已绑定），不会同时出现
  const visible = HOME_WXML.replace(/<view class="dk-card invite-card[\s\S]*?<\/view>\s*<\/view>/, '');
  const tilts = (visible.match(/dk-card--tilt-/g) || []).length;
  assert.ok(tilts <= 2, '同屏旋转卡超过 2 张会让整页歪斜，实际 ' + tilts);
});

test('9.3 首页可点区域都有 aria-role 与 aria-label', () => {
  const tags = (HOME_WXML.match(/<view[^>]*bindtap="[^"]+"[^>]*>/g) || [])
    // 浮层遮罩是「点外面关闭」的一整片，由浮层里的关闭按钮承担可读标签
    .filter((tag) => tag.indexOf('sheet-mask') === -1);
  assert.ok(tags.length >= 5, '首页可点 view 应有 5 个以上，实际 ' + tags.length);
  for (const tag of tags) {
    assert.ok(tag.includes('aria-role="button"'), '可点区域缺 aria-role：' + tag.replace(/\s+/g, ' '));
    assert.ok(/aria-label=/.test(tag), '可点区域缺 aria-label：' + tag.replace(/\s+/g, ' '));
  }
  assert.ok(/class="sheet-close"[^>]*aria-role="button"/.test(HOME_WXML), '浮层关闭要声明按钮角色');
});

test('8.9 首页热区不小于 88rpx（含底部重试与链接式入口）', () => {
  const appLink = declsOf(APP_WXSS, '.dk-link');
  assert.strictEqual(appLink['min-height'], '88rpx', '.dk-link 热区要 88rpx');
  for (const selector of ['.refresh-bar__btn', '.mood-link', '.sheet-close']) {
    const d = declsOf(HOME_WXSS, selector);
    assert.ok(/88rpx|96rpx/.test(d['min-height'] || ''), selector + ' 热区不足 88rpx');
  }
  const grid = declsOf(HOME_WXSS, '.grid__item');
  assert.ok(parseFloat(grid['min-height']) >= 88, '.grid__item 热区不足 88rpx');
});

test('9.9 tab 页底部留出 tabBar + 安全区，否则最后一张卡被压住', () => {
  for (const page of ['home', 'diary', 'wish', 'mood', 'profile']) {
    const css = read('pages/' + page + '/index.wxss');
    assert.ok(
      /env\(safe-area-inset-bottom\)/.test(css) && /140rpx/.test(css),
      page + ' 页底部没有留 tabBar 高度 + 安全区'
    );
  }
});

test('9.12 首屏骨架、错误态、未绑定文案都还在', () => {
  assert.ok(HOME_WXML.includes('dk-skeleton'), '首屏要有虚线骨架卡，不白屏');
  assert.ok(HOME_WXML.includes('检查一下网络，再敲敲门'), '首屏失败要有可操作的副文案');
  assert.ok(HOME_WXML.includes('再试一次'), '首屏失败要有重试按钮');
  assert.ok(HOME_WXML.includes('{{bindTitle}}'), '未绑定文案来自 data（BIND_TEXT）');
  const js = read('pages/home/index.js');
  assert.ok(js.includes('屋里还缺一个人'), '未绑定主文案丢了');
  assert.ok(js.includes('小屋的门卡住了'), '首屏/刷新失败文案丢了（12.9）');
  assert.ok(HOME_WXML.includes('invite-tip'), '未绑定时要说明「绑好后会出现什么」');
});

test('9.9 小屏与减少动效：max-height 640 压缩 + prefers-reduced-motion 关闭动效', () => {
  assert.ok(HOME_WXSS.includes('@media (max-height: 640px)'), '缺少小屏压缩规则');
  assert.ok(HOME_WXSS.includes('@media (prefers-reduced-motion: reduce)'), '缺少减少动效规则');
  assert.ok(APP_WXSS.includes('@media (prefers-reduced-motion: reduce)'), '公共按钮/骨架也要响应减少动效');
});

test('8.2 app.json 窗口与 tabBar 用同一张纸的颜色', () => {
  assert.strictEqual(APP_JSON.window.backgroundColor, '#FFFEF5');
  assert.strictEqual(APP_JSON.window.navigationBarBackgroundColor, '#FFFEF5');
  assert.strictEqual(APP_JSON.tabBar.backgroundColor, '#FFFEF5');
  assert.strictEqual(APP_JSON.window.pageOrientation, 'portrait', '小程序不支持横屏（9.9）');
  assert.strictEqual(APP_JSON.__usePrivacyCheck__, true);
});

test('首页仍接分享与隐私授权（8.9 / 13.8）', () => {
  const homeJs = read('pages/home/index.js');
  assert.match(homeJs, /onShareAppMessage\(\)/, '首页缺少分享卡片');
  assert.match(homeJs, /onShareTimeline\(\)/, '首页缺少朋友圈分享');
  assert.match(homeJs, /\?code=/, '分享卡片要带上邀请码');
  assert.ok(HOME_WXML.includes('<privacy-guard />'), '首页缺少隐私授权弹窗');
});
