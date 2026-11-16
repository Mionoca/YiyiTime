'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// M5「场景与体验打磨」的静态自检（文档 9.2 / 9.6 / 9.7 / 9.8 / 9.9 / 9.12 / 13.8）。
// 小程序样式无法在 Node 里真跑，这里用四档机型把 wxss 里的百分比坐标换算成像素，
// 守住「热区不重叠、不出场景、不小于 88rpx」这些硬约束；真机观感仍以 13.8 验收为准。

const ROOT = path.join(__dirname, '..');
const HOME_WXSS = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.wxss'), 'utf8');
const HOME_WXML = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.wxml'), 'utf8');

const SCREENS = [
  { label: 'iPhone 4/5 320×568', w: 320, h: 568, statusBar: 20, safeBottom: 0 },
  { label: 'iPhone 6/7/8 375×667', w: 375, h: 667, statusBar: 20, safeBottom: 0 },
  { label: 'iPhone 12/13 390×844', w: 390, h: 844, statusBar: 44, safeBottom: 34 },
  { label: 'iPhone 14 Pro Max 430×932', w: 430, h: 932, statusBar: 47, safeBottom: 34 },
];

/** 取顶层 class 的第一个样式块（忽略 @media 内部缩进的覆盖规则） */
function blocks(css) {
  const map = {};
  const lines = css.split('\n');
  let current = null;
  let buf = [];
  for (const line of lines) {
    if (current === null) {
      const m = line.match(/^\.([a-z0-9-]+)\s*\{\s*$/);
      if (m) {
        current = m[1];
        buf = [];
      }
      continue;
    }
    if (line.trim() === '}') {
      if (!(current in map)) map[current] = buf.join('\n');
      current = null;
      continue;
    }
    buf.push(line);
  }
  return map;
}

const CSS = blocks(HOME_WXSS);

// 墙历高度由内容撑开（无显式 height）：16 + 20*1.6 + 8 + 30*1.6 + 20 = 124rpx
// （app.wxss 的 page 行高是 1.6，这里按真实行高估算，偏保守）
const ESTIMATED_HEIGHTS = { calendar: 124 };

/** 320×568 会命中 @media (max-height: 640px) 的小屏压缩（文档 9.9） */
function isCompactScreen(screen) {
  return screen.h <= 640;
}

function decl(name) {
  const raw = CSS[name];
  assert.ok(raw, '缺少 .' + name + ' 的样式块');
  const out = {};
  raw.replace(/\/\*[\s\S]*?\*\//g, '').split(';').forEach((part) => {
    const i = part.indexOf(':');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key) out[key] = value;
  });
  return out;
}

function len(value, base, rpx) {
  assert.ok(value, '缺少长度值');
  if (/^-?[\d.]+%$/.test(value)) return (parseFloat(value) / 100) * base;
  if (/^-?[\d.]+rpx$/.test(value)) return parseFloat(value) * rpx;
  if (/^-?[\d.]+px$/.test(value)) return parseFloat(value);
  throw new Error('无法解析长度: ' + value);
}

function actionBarHeight(screen) {
  const rpx = screen.w / 750;
  if (isCompactScreen(screen)) {
    // @media (max-height: 640px)：padding 8rpx 48rpx calc(16rpx + safe)、提示 22rpx、按钮 88rpx
    return (8 + 22 * 1.6 + 8 + 88 + 16) * rpx + screen.safeBottom;
  }
  // 文档 9.8：padding-bottom = 24rpx + 安全区；按钮 96rpx；提示一行 24rpx 字（页面行高 1.6）
  return (16 + 24 * 1.6 + 16 + 96 + 24) * rpx + screen.safeBottom;
}

function sceneHeight(screen, hugSlot) {
  const rpx = screen.w / 750;
  const nav = (isCompactScreen(screen) ? 72 : 88) * rpx;
  return screen.h - screen.statusBar - nav - actionBarHeight(screen) - hugSlot;
}

function rect(name, screen, sceneH) {
  const d = decl(name);
  const rpx = screen.w / 750;
  const width = len(d.width, screen.w, rpx);
  const height = d.height
    ? len(d.height, sceneH, rpx)
    : (ESTIMATED_HEIGHTS[name] || 0) * rpx;
  let x;
  if (d.left) x = len(d.left, screen.w, rpx);
  else if (d.right) x = screen.w - len(d.right, screen.w, rpx) - width;
  else throw new Error('.' + name + ' 缺少 left/right');
  let y;
  if (d.top) y = len(d.top, sceneH, rpx);
  else if (d.bottom) y = sceneH - len(d.bottom, sceneH, rpx) - height;
  else throw new Error('.' + name + ' 缺少 top/bottom');
  return { name, x, y, width, height, right: x + width, bottom: y + height, z: d['z-index'] };
}

/** 场景里的关键物件按 9.8 分层，可点区域单独列出来 */
const HARD_ZONES = ['calendar', 'frame', 'lamp', 'table', 'fridge'];
const Z_LAYERS = {
  window: '10',
  calendar: '10',
  frame: '10',
  lamp: '20',
  table: '20',
  fridge: '20',
  door: '20',
  people: '30',
  envelope: '30',
};

function overlap(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.x, b.x);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y);
  return w > 0.5 && h > 0.5 ? { w, h } : null;
}

test('场景物件按文档 9.8 分层（10/20/30/50/60，0 层是背景）', () => {
  Object.keys(Z_LAYERS).forEach((name) => {
    assert.strictEqual(decl(name)['z-index'], Z_LAYERS[name], '.' + name + ' 的 z-index 不符合 9.8');
  });
  // 装饰层不许抢点击
  assert.strictEqual(decl('rug')['pointer-events'], 'none');
  assert.strictEqual(decl('sofa')['pointer-events'], 'none');
  assert.strictEqual(decl('door--off')['pointer-events'], 'none');
  // 头像层要压在沙发与家具之上
  assert.strictEqual(decl('people')['z-index'], '30');
  // 抱抱横幅 / 页面浮层（9.8 第 5、6 层）
  assert.strictEqual(decl('hug-slot')['z-index'], '50');
  assert.strictEqual(decl('sheet-mask')['z-index'], '60');
  // 台灯光晕是装饰，扩展出去的光晕不能拦点击（9.2 / 9.8）
  assert.strictEqual(decl('lamp-glow')['pointer-events'], 'none');
  // 隐私授权弹窗是页面级最高层（8.10 / 13.8）
  const guardWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/components/privacy-guard/index.wxss'), 'utf8');
  assert.match(guardWxss, /z-index:\s*200/, '隐私弹窗要高于页面浮层');
});

test('骨架屏物件与真实场景同坐标（首屏不跳位）', () => {
  // M5 审查发现：.sk-frame 曾留在左墙，数据回来后相框从左边跳到右边。
  // 骨架屏只是占位，坐标必须和真实物件一致，否则首屏会闪一下。
  ['window', 'calendar', 'frame', 'sofa', 'table', 'fridge', 'lamp', 'door'].forEach((name) => {
    const real = decl(name);
    const sk = decl('sk-' + name);
    ['top', 'left', 'right', 'bottom', 'width', 'height'].forEach((key) => {
      if (!(key in real)) return;
      assert.strictEqual(sk[key], real[key], '骨架 .sk-' + name + ' 的 ' + key + ' 与 .' + name + ' 不一致');
    });
  });
});
for (const screen of SCREENS) {
  const rpx = screen.w / 750;

  test('四档机型 · ' + screen.label + '：热区不出场景、互相不重叠、不小于 88rpx', () => {
    // 顶部抱抱横幅出现时场景会变矮，两种情形都要成立
    for (const hugSlot of [0, 140 * rpx]) {
      const sceneH = sceneHeight(screen, hugSlot);
      assert.ok(sceneH > 240, screen.label + ' 场景高度只有 ' + sceneH.toFixed(0) + 'px，说明纵向被挤爆');

      const zones = HARD_ZONES.map((n) => rect(n, screen, sceneH));
      // 三种绑定状态的可点区域不同（文档 9.12）：
      // 已绑定 = 门；完全未绑定 = 空椅子 + 邀请按钮；已生成/有人申请 = 门垫信封
      zones.push(rect('door', screen, sceneH));
      const boundZones = zones;

      const inviteZones = HARD_ZONES.map((n) => rect(n, screen, sceneH));
      inviteZones.push(rect('envelope', screen, sceneH));

      for (const list of [boundZones, inviteZones]) {
        list.forEach((z) => {
          assert.ok(z.x >= -0.5, z.name + ' 左边超出场景');
          assert.ok(z.right <= screen.w + 0.5, z.name + ' 右边超出场景');
          assert.ok(z.y >= -0.5, z.name + ' 上边超出场景');
          assert.ok(z.bottom <= sceneH + 0.5, z.name + ' 下边超出场景（会被底部按钮压住）');
          const wRpx = (z.width * 750) / screen.w;
          const hRpx = (z.height * 750) / screen.w;
          assert.ok(wRpx >= 88 - 0.5, z.name + ' 热区宽度 ' + wRpx.toFixed(0) + 'rpx < 88rpx');
          assert.ok(hRpx >= 88 - 0.5, z.name + ' 热区高度 ' + hRpx.toFixed(0) + 'rpx < 88rpx');
        });

        for (let i = 0; i < list.length; i += 1) {
          for (let j = i + 1; j < list.length; j += 1) {
            const hit = overlap(list[i], list[j]);
            assert.strictEqual(
              hit,
              null,
              screen.label + '：' + list[i].name + ' 与 ' + list[j].name + ' 热区重叠（9.2 要求所有热区不重叠）'
            );
          }
        }
      }
    }
  });
}

test('台灯在左、冰箱在右、门在右下（文档 9.2）', () => {
  const screen = SCREENS[1];
  const sceneH = sceneHeight(screen, 0);
  const lamp = rect('lamp', screen, sceneH);
  const fridge = rect('fridge', screen, sceneH);
  const door = rect('door', screen, sceneH);
  assert.ok(lamp.x + lamp.width <= screen.w * 0.25, '台灯应在左侧');
  assert.ok(fridge.x >= screen.w * 0.55, '冰箱应在右侧');
  assert.ok(door.x >= screen.w * 0.75 && door.bottom >= sceneH * 0.9, '门应在右下角');
  // 9.2 示意图：相框在右侧墙面（墙历下方），不在左墙
  const frame = rect('frame', screen, sceneH);
  assert.ok(frame.x >= screen.w * 0.6, '相框应挂在右侧墙面');
});

test('信封是门垫热区，固定 88rpx 高且允许两行门牌（文档 9.9 / 9.12）', () => {
  assert.strictEqual(decl('envelope').height, '88rpx');
  // 信封压住门（门 20）才能点：9.8 层表未单列信封，见开发进度「已知偏差」
  assert.strictEqual(decl('envelope')['z-index'], '30');
  const label = decl('door-label');
  assert.strictEqual(label['white-space'], 'normal', '门牌要允许换行，不能写死 nowrap');
  assert.strictEqual(label['word-break'], 'break-all');
});

test('昼夜四态与夜间文字对比度（文档 9.6）', () => {
  // day 是默认配色（无 .phase-day 覆盖），morning/dusk/night 各有独立规则
  ['morning', 'dusk', 'night'].forEach((phase) => {
    assert.ok(HOME_WXSS.includes('.phase-' + phase), '缺少 ' + phase + ' 的配色规则');
  });
  assert.ok(HOME_WXSS.includes('.phase-morning .window-glass'), '清晨窗色未单独处理');
  assert.ok(HOME_WXSS.includes('.phase-night .nav-title'), '夜间导航标题需要单独配色');
  assert.ok(HOME_WXSS.includes('.phase-night .action-hint'), '夜间按钮上方的提示需要单独配色');
  assert.ok(HOME_WXSS.includes('.phase-night .state-sub'), '夜间错误态副文案需要单独配色');
  assert.ok(HOME_WXSS.includes('.sun--dusk'), '黄昏太阳缺少样式');
  assert.ok(HOME_WXML.includes("phase === 'dusk'"), '黄昏没有渲染太阳');
});

test('动效时长与一次性 class（文档 9.7）', () => {
  assert.match(HOME_WXSS, /animation:\s*lamp-breathe\s+4s/, '台灯呼吸应为 4s 循环');
  assert.match(HOME_WXSS, /envelope-pulse[\s\S]{0,160}scale\(1\.04\)/, '信封脉冲幅度应为 1.04');
  assert.match(HOME_WXSS, /scene-lift[\s\S]{0,160}500ms/, '场景入场应为 500ms');
  assert.match(HOME_WXSS, /animation:\s*hug-float\s+1400ms/, '心形上浮应为 1.4s');
  const enterBlock = HOME_WXSS.slice(HOME_WXSS.indexOf('.scene.is-enter {'), HOME_WXSS.indexOf('}', HOME_WXSS.indexOf('.scene.is-enter {')));
  assert.ok(enterBlock.includes('animation'), '入场动画应挂在一次性的 is-enter 上');
  // 入场是一次性 class：页面 520ms 后必须移除，不能永久挂 class
  const homeJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.js'), 'utf8');
  assert.match(homeJs, /sceneEnter: false/, '页面要主动回收 is-enter');
  assert.match(homeJs, /_enterTimer/, '入场动画需要可清理的 timer');
});

test('小屏适配：320×568 命中 @media (max-height: 640px) 压缩（文档 9.9）', () => {
  assert.ok(HOME_WXSS.includes('@media (max-height: 640px)'), '缺少小屏 media query');
  assert.ok(/@media \(max-height: 640px\)[\s\S]*\.nav-title/.test(HOME_WXSS));
  assert.ok(/@media \(max-height: 640px\)[\s\S]*\.action-bar/.test(HOME_WXSS));
});

test('首页无障碍、分享、隐私授权已接线（文档 8.9 / 9.12 / 13.8）', () => {
  // 所有可点物件都要 aria-role="button" 与 aria-label
  ['onTapCalendar', 'onTapProfile', 'onTapLamp', 'onTapFridge', 'onTapTableNote', 'onTapDoor', 'onTapBind'].forEach((handler) => {
    const idx = HOME_WXML.indexOf(handler);
    assert.ok(idx > 0, '缺少 ' + handler + ' 的绑定');
    const window = HOME_WXML.slice(Math.max(0, idx - 400), idx + 80);
    assert.ok(window.includes('aria-role="button"'), handler + ' 所在热区缺少 aria-role');
    assert.ok(window.includes('aria-label'), handler + ' 所在热区缺少 aria-label');
  });
  assert.ok(HOME_WXML.includes('<privacy-guard />'), '首页缺少隐私授权弹窗');
  assert.ok(HOME_WXML.includes('door--off'), '未绑定时门应只做装饰');
  assert.ok(HOME_WXML.includes('envelope-avatar'), '邀请信封要带对方小头像');

  const homeJs = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.js'), 'utf8');
  assert.match(homeJs, /onShareAppMessage\(\)/, '首页缺少分享卡片');
  assert.match(homeJs, /onShareTimeline\(\)/, '首页缺少朋友圈分享');
  assert.match(homeJs, /\?code=/, '分享卡片要带上邀请码');

  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/app.json'), 'utf8'));
  assert.strictEqual(appJson.window.pageOrientation, 'portrait', '小程序不支持横屏（9.9）');
  assert.strictEqual(appJson.__usePrivacyCheck__, true);

  ['home', 'profile', 'bind'].forEach((page) => {
    const pageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'miniprogram/pages/' + page + '/index.json'), 'utf8'));
    assert.ok(
      pageJson.usingComponents && pageJson.usingComponents['privacy-guard'],
      page + ' 页没有注册隐私授权组件'
    );
  });

  const guardWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/privacy-guard/index.wxml'), 'utf8');
  const guardJs = fs.readFileSync(path.join(ROOT, 'miniprogram/components/privacy-guard/index.js'), 'utf8');
  assert.ok(guardWxml.includes('agreePrivacyAuthorization'), '隐私弹窗缺少官方同意按钮');
  assert.ok(guardJs.includes('wx.getPrivacySetting'), '隐私弹窗应只在需要授权时出现');
  assert.ok(guardJs.includes('wx.openPrivacyContract'), '隐私弹窗要能打开隐私保护指引');

  const profileWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.ok(profileWxml.includes('onOpenPrivacy'), '我的页缺少隐私保护指引入口');
});

test('加载失败与空态（文档 9.12）', () => {
  // 错误态文案要真的存在；不能用 state-sub 这种恒在的 class 兜底，否则回归发现不了
  const homeScript = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.js'), 'utf8');
  assert.ok(homeScript.includes('小屋的门卡住了'), '首屏失败文案「小屋的门卡住了」丢了（9.12）');
  assert.ok(HOME_WXML.includes('检查一下网络，再敲敲门'), '首屏失败要有可操作的副文案');
  assert.ok(HOME_WXML.includes('再试一次'), '首屏失败要有重试按钮');
  assert.ok(HOME_WXML.includes('屋里还缺一个人'), '未绑定需要空椅子文案');
  assert.ok(HOME_WXML.includes('邀请 TA 住进来'), '未绑定需要邀请按钮');
  assert.ok(HOME_WXSS.includes('.skeleton-scene'), '首次加载失败不能白屏，需要房间轮廓');
});
