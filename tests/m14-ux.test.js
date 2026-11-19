'use strict';

/**
 * M14 体验修复的客户端回归（文档 17.2 / 17.5 / 17.6）。
 *
 * 1) 日记「上传配图」点了没反应 —— 根因是 `chooseMedia` 的失败分支没有任何反馈，
 *    隐私未授权时微信直接 fail，用户看到的就是「点了没反应」。现在三类失败各有出口：
 *    取消静默、隐私拦截引导授权后重试一次、其它给可读原因。
 * 2) 心情打卡弹层的「记下今天的心情」被 tabBar 切掉一半 —— 弹层要让开 100rpx，
 *    由各页面显式传 `above-tab-bar`；这里锁「谁传了」「传了之后样式真的生效」。
 * 3) 头像从相册选 + 1:1 裁剪；基础库没有 cropImage 时降级为原图上传，不能白屏。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('./helpers/client-page');
const { installWx, restoreWx, loadPage, instantiate } = h;
const api = require('../miniprogram/utils/api');
const upload = require('../miniprogram/utils/upload');
const me = require('../miniprogram/utils/me');

const ROOT = path.resolve(__dirname, '..');
const DIARY = 'miniprogram/pages/diary/index.js';
const PROFILE = 'miniprogram/pages/profile/index.js';

function diarySetup(wxExtra) {
  const toasts = [];
  const calls = [];
  installWx(Object.assign({
    showToast: (opts) => { toasts.push(opts.title); },
    showModal: (opts) => { if (opts.success) opts.success({ confirm: false, cancel: true }); },
  }, wxExtra || {}));
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'diary.list') {
      return {
        todayKey: '2026-11-16',
        items: [],
        today: null,
        month: '2026-11',
      };
    }
    if (action === 'diary.save') return { diary: { date: '2026-11-16', images: [] } };
    throw new Error('unexpected action: ' + action);
  };
  api.showError = () => {};
  const page = instantiate(loadPage(DIARY));
  page.data.todayKey = '2026-11-16';
  return { page, toasts, calls };
}

test('日记配图：取消选图保持静默（不能因为「我不选了」弹错误）', () => {
  const { page, toasts } = diarySetup({
    chooseMedia: (opts) => opts.fail({ errMsg: 'chooseMedia:fail cancel' }),
  });
  try {
    page.onChooseImage();
    assert.deepStrictEqual(toasts, [], '取消不该有任何提示');
    assert.deepStrictEqual(page.data.images, []);
  } finally {
    restoreWx();
  }
});

test('日记配图：隐私未授权 → 拉起授权，成功后自动重试一次并真的拿到图', async () => {
  let mediaCalls = 0;
  let privacyCalls = 0;
  const { page, toasts } = diarySetup({
    chooseMedia: (opts) => {
      mediaCalls += 1;
      if (mediaCalls === 1) return opts.fail({ errMsg: 'chooseMedia:fail privacy permission is not authorized' });
      return opts.success({ tempFiles: [{ tempFilePath: '/tmp/a.png' }] });
    },
    requirePrivacyAuthorize: (opts) => {
      privacyCalls += 1;
      opts.success();
    },
  });
  // 上传本身不是这段的重点，替换成即时成功，避免依赖云存储
  const realUpload = upload.uploadDiaryImage;
  upload.uploadDiaryImage = async () => 'cloud://test-env/diary/a.png';
  try {
    page.onChooseImage();
    assert.strictEqual(privacyCalls, 1, '要主动拉一次隐私授权');
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(mediaCalls, 2, '授权成功后要重试一次选图');
    assert.deepStrictEqual(page.data.images, ['cloud://test-env/diary/a.png']);
    assert.deepStrictEqual(toasts, [], '重试成功后不该再弹错误');
  } finally {
    upload.uploadDiaryImage = realUpload;
    restoreWx();
  }
});

test('日记配图：隐私被拒第二次就收手，不再递归重试，并给一句人话', () => {
  let mediaCalls = 0;
  const { page, toasts } = diarySetup({
    chooseMedia: (opts) => {
      mediaCalls += 1;
      opts.fail({ errMsg: 'chooseMedia:fail privacy permission is not authorized' });
    },
    requirePrivacyAuthorize: (opts) => opts.fail({}),
  });
  try {
    page.onChooseImage();
    assert.strictEqual(mediaCalls, 1, '重试只允许一次');
    assert.deepStrictEqual(toasts, ['先同意隐私说明，才能选图']);
  } finally {
    restoreWx();
  }
});

test('日记配图：其它失败给「选图失败：原因」而不是沉默', () => {
  const { page, toasts } = diarySetup({
    chooseMedia: (opts) => opts.fail({ errMsg: 'chooseMedia:fail system error' }),
  });
  try {
    page.onChooseImage();
    assert.deepStrictEqual(toasts, ['选图失败：system error']);
  } finally {
    restoreWx();
  }
});

test('日记配图：上传中再点一次要被挡住并说明，避免同一批图重复上传', () => {
  const { page, toasts } = diarySetup({ chooseMedia: () => { throw new Error('不该打开选图面板'); } });
  try {
    page.setData({ uploadingCount: 1 });
    page.onChooseImage();
    assert.deepStrictEqual(toasts, ['图片还在上传，等一秒']);
  } finally {
    restoreWx();
  }
});

test('日记配图：部分失败说「还差几张」，全部失败给具体原因；计数一定会归零', async () => {
  const { page, toasts } = diarySetup({
    chooseMedia: (opts) => opts.success({ tempFiles: [{ tempFilePath: '/tmp/a.png' }, { tempFilePath: '/tmp/b.png' }] }),
  });
  const realUpload = upload.uploadDiaryImage;
  let index = 0;
  upload.uploadDiaryImage = async () => {
    index += 1;
    if (index === 1) return 'cloud://test-env/diary/a.png';
    throw new Error('图片上传失败，请重试');
  };
  try {
    page.onChooseImage();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(page.data.uploadingCount, 0, '失败那张也要把计数减回来（否则按钮永久卡在「…」）');
    assert.strictEqual(page.data.uploadingTotal, 0);
    assert.deepStrictEqual(page.data.images, ['cloud://test-env/diary/a.png'], '成功那张要留下');
    assert.deepStrictEqual(toasts, ['有 1 张没传上，再试一次']);
  } finally {
    upload.uploadDiaryImage = realUpload;
    restoreWx();
  }
});

/** 取某个选择器的规则体（第一个匹配），用于断言具体声明 */
function ruleBody(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(escaped + '\\s*\\{([^}]*)\\}').exec(css);
  return match ? match[1] : '';
}

test('aboveTabBar：心情弹层与底部抽屉都要让开 tabBar 的 100rpx', () => {
  const moodWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/mood-picker/index.wxml'), 'utf8');
  const moodJs = fs.readFileSync(path.join(ROOT, 'miniprogram/components/mood-picker/index.js'), 'utf8');
  const moodWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/components/mood-picker/index.wxss'), 'utf8');
  assert.ok(/aboveTabBar/.test(moodJs), 'mood-picker 要有 aboveTabBar 属性');
  assert.ok(/mp-sheet--above/.test(moodWxml), 'wxml 要按属性挂上 class');
  assert.ok(/\.mp-sheet--above[\s\S]{0,240}100rpx/.test(moodWxss), 'above 态要给 tabBar 留 100rpx');

  const bsWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/components/bottom-sheet/index.wxml'), 'utf8');
  const bsJs = fs.readFileSync(path.join(ROOT, 'miniprogram/components/bottom-sheet/index.js'), 'utf8');
  const bsWxss = fs.readFileSync(path.join(ROOT, 'miniprogram/components/bottom-sheet/index.wxss'), 'utf8');
  assert.ok(/aboveTabBar/.test(bsJs), 'bottom-sheet 要有 aboveTabBar 属性');
  assert.ok(/bs__sheet--above/.test(bsWxml));
  assert.ok(/\.bs__sheet--above[\s\S]{0,240}100rpx/.test(bsWxss), 'above 态要给 tabBar 留 100rpx');

  // 首页心情弹层、账本页与我的页的抽屉都在 tabBar 之上
  const homeWxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.wxml'), 'utf8');
  assert.ok(/<mood-picker[\s\S]{0,200}above-tab-bar="\{\{true\}\}"/.test(homeWxml), '首页心情弹层要开 aboveTabBar');
  ['ledger', 'profile'].forEach((page) => {
    const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages', page, 'index.wxml'), 'utf8');
    assert.ok(/<bottom-sheet[\s\S]{0,200}above-tab-bar="\{\{true\}\}"/.test(wxml), page + ' 页的抽屉要开 aboveTabBar');
  });
});

test('首页自绘浮层（我们的日子 / TA 的心情）也要让开 tabBar——它不走组件，是页面里手写的', () => {
  // 17.6 首版只改了 mood-picker 与 bottom-sheet 两个组件，漏了首页这两个自绘浮层，
  // 真机上「知道啦」按钮的下半截仍然压在 tab 栏下面。这里把它钉住。
  const css = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.wxss'), 'utf8');
  const mask = ruleBody(css, '.sheet-mask');
  assert.ok(mask, '找不到 .sheet-mask 规则');
  assert.ok(/padding-bottom:\s*calc\([^;]*100rpx[^;]*\)/.test(mask), '.sheet-mask 底部要让开 tabBar 的 100rpx');
  assert.ok(/env\(safe-area-inset-bottom\)/.test(mask), '.sheet-mask 还要叠安全区');

  const sheet = ruleBody(css, '.sheet');
  assert.ok(/max-height:\s*calc\([^;]*100rpx[^;]*\)/.test(sheet), '.sheet 的高度上限要扣掉 tabBar，否则内容多时顶出屏幕');

  const wxml = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/home/index.wxml'), 'utf8');
  const sheets = (wxml.match(/class="sheet-mask"/g) || []).length;
  assert.ok(sheets >= 2, '首页应有两个自绘浮层（我们的日子 / TA 的心情），实际 ' + sheets);
  assert.strictEqual((wxml.match(/class="sheet-close"/g) || []).length, sheets, '每个浮层都要有关闭按钮');
});

test('防漏：任何「贴底 + flex-end」的遮罩，其所在 wxss 都必须处理 tabBar 留白', () => {
  // 只锁已知三个文件太脆：以后在 tab 页里再手写一个贴底浮层，谁也不会记得加 100rpx。
  // 这里按「有没有 flex-end 贴底遮罩」扫一遍，要求该文件里出现 100rpx（让开 tabBar 的痕迹）。
  const files = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(abs);
      if (entry.name.endsWith('.wxss')) files.push(abs);
    });
  };
  walk(path.join(ROOT, 'miniprogram'));

  const offenders = [];
  files.forEach((abs) => {
    const css = fs.readFileSync(abs, 'utf8');
    const rules = css.match(/\.[\w-]+\s*\{[^}]*\}/g) || [];
    const hasBottomSheet = rules.some((rule) => /position:\s*fixed/.test(rule) && /align-items:\s*flex-end/.test(rule));
    if (!hasBottomSheet) return;
    if (!/100rpx/.test(css)) {
      offenders.push(path.relative(ROOT, abs).split(path.sep).join('/'));
    }
  });
  assert.deepStrictEqual(offenders, [],
    '这些 wxss 有贴底浮层但没有为 tabBar 留白（100rpx），tab 页里会遮住底部按钮：' + offenders.join(', '));
});

test('打卡弹层底部：给「记下今天的心情」留出安全区 + tabBar 的高度', () => {
  const wxss = fs.readFileSync(path.join(ROOT, 'miniprogram/components/mood-picker/index.wxss'), 'utf8');
  const block = wxss.match(/\.mp-sheet--above\s*\{[\s\S]*?\}/);
  assert.ok(block, '缺少 .mp-sheet--above 规则');
  assert.ok(/padding-bottom:\s*calc\([^;]*100rpx[^;]*\)/.test(block[0]), '底部内边距要含 100rpx');
  assert.ok(/env\(safe-area-inset-bottom\)/.test(block[0]), '还要叠安全区，否则刘海机仍会被挡');
  assert.ok(/max-height:\s*calc\([^;]*100rpx[^;]*\)/.test(block[0]), '高度上限也要扣掉 tabBar，否则内容顶出屏幕');
});

test('头像：优先从相册/相机选，再用 cropImage 裁成 1:1；没有 cropImage 时降级为原图', async () => {
  const toasts = [];
  const uploaded = [];
  installWx({
    showToast: (opts) => { toasts.push(opts.title); },
    chooseMedia: (opts) => opts.success({ tempFiles: [{ tempFilePath: '/tmp/avatar.png' }] }),
    cropImage: (opts) => opts.success({ tempFilePath: '/tmp/avatar_cropped.png' }),
  });
  api.call = async (action, payload) => {
    if (action === 'user.updateProfile') {
      uploaded.push(payload.avatarFileID);
      return { user: { openid: 'oA', nickname: '小怡', avatarFileID: payload.avatarFileID, profileComplete: true } };
    }
    if (action === 'user.get') return { user: { openid: 'oA', nickname: '小怡', avatarFileID: '' } };
    if (action === 'reminder.get') return { enabled: false, remindAt: '21:00', quota: 0, quotaMax: 7, configured: false };
    throw new Error('unexpected action: ' + action);
  };
  api.showError = () => {};
  const realUpload = upload.uploadAvatar;
  upload.uploadAvatar = async (filePath) => {
    uploaded.push('path:' + filePath);
    return 'cloud://test-env/avatars/new.png';
  };
  try {
    const page = instantiate(loadPage(PROFILE));
    await page.onChooseAvatarTap();
    assert.deepStrictEqual(uploaded, ['path:/tmp/avatar_cropped.png', 'cloud://test-env/avatars/new.png'],
      '要走裁剪后的文件，并把 fileID 写回资料');
    assert.deepStrictEqual(toasts, [], '成功路径不该有 toast');
  } finally {
    upload.uploadAvatar = realUpload;
    restoreWx();
  }
});

test('头像：基础库没有 cropImage 时直接上传原图，不能卡住或报错', async () => {
  const uploaded = [];
  installWx({
    showToast: () => {},
    chooseMedia: (opts) => opts.success({ tempFiles: [{ tempFilePath: '/tmp/raw.png' }] }),
  });
  api.call = async (action, payload) => {
    if (action === 'user.updateProfile') return { user: { openid: 'oA', avatarFileID: payload.avatarFileID } };
    throw new Error('unexpected action: ' + action);
  };
  api.showError = () => {};
  const realUpload = upload.uploadAvatar;
  upload.uploadAvatar = async (filePath) => {
    uploaded.push(filePath);
    return 'cloud://test-env/avatars/raw.png';
  };
  try {
    const page = instantiate(loadPage(PROFILE));
    await page.onChooseAvatarTap();
    assert.deepStrictEqual(uploaded, ['/tmp/raw.png'], '降级时上传原图');
  } finally {
    upload.uploadAvatar = realUpload;
    restoreWx();
  }
});

test('头像：用户取消选图不弹错误、也不上传', async () => {
  const toasts = [];
  let uploaded = 0;
  installWx({
    showToast: (opts) => { toasts.push(opts.title); },
    chooseMedia: (opts) => opts.fail({ errMsg: 'chooseMedia:fail cancel' }),
  });
  api.call = async () => { throw new Error('不该发请求'); };
  api.showError = () => {};
  const realUpload = upload.uploadAvatar;
  upload.uploadAvatar = async () => { uploaded += 1; return 'x'; };
  try {
    const page = instantiate(loadPage(PROFILE));
    await page.onChooseAvatarTap();
    assert.strictEqual(uploaded, 0);
    assert.deepStrictEqual(toasts, []);
  } finally {
    upload.uploadAvatar = realUpload;
    restoreWx();
  }
});

test('头像渲染：aspectFill 保持比例 + object-position 偏上，避免头顶被裁掉', () => {
  // <image> 的填充方式由 mode 决定（CSS 的 object-fit 对它不生效），
  // 比例不拉伸靠 mode="aspectFill"，裁剪位置靠 object-position 兜底偏上
  const cases = [
    ['miniprogram/pages/profile/index.wxml', 'miniprogram/pages/profile/index.wxss', /\.avatar-img\s*\{[\s\S]*?\}/],
    ['miniprogram/components/avatar-bubble/index.wxml', 'miniprogram/components/avatar-bubble/index.wxss', /\.avatar\s*\{[\s\S]*?\}/],
  ];
  cases.forEach(([wxmlRel, wxssRel, pattern]) => {
    const wxml = fs.readFileSync(path.join(ROOT, wxmlRel), 'utf8');
    assert.ok(/mode="aspectFill"/.test(wxml), wxmlRel + ' 的头像要 aspectFill（否则被拉伸变形）');
    const css = fs.readFileSync(path.join(ROOT, wxssRel), 'utf8');
    const rule = css.match(pattern);
    assert.ok(rule, wxssRel + ' 里找不到头像样式');
    assert.ok(/object-position:\s*center\s+30%/.test(rule[0]), wxssRel + ' 的头像要偏上对齐（center 30%）');
  });
});

/* ── 隐私授权被拦之后，必须有「可以点同意」的地方（M14 修订） ────────────── */

test('隐私守卫：open() 清掉 24h 跳过标记并重新显示，agree 会广播给页面', () => {
  const store = {};
  installWx({
    getStorageSync: (key) => (key in store ? store[key] : ''),
    setStorageSync: (key, value) => { store[key] = value; },
    removeStorageSync: (key) => { delete store[key]; },
    getPrivacySetting: (opts) => opts.success({ needAuthorization: true }),
    showToast: () => {},
  });
  try {
    const comp = h.instantiateComponent(h.loadComponent('miniprogram/components/privacy-guard/index.js'));
    // 用户点过「先逛逛，之后再说」→ 写跳过标记
    comp.onClose();
    assert.ok(store.privacy_prompt_skip_at, '关闭后要写跳过标记');
    assert.strictEqual(comp.data.show, false);

    // 之后选图被拦，页面调 open()：必须清标记并重新显示
    const agreed = [];
    comp.triggerEvent = (name) => agreed.push(name);
    comp.open();
    assert.strictEqual(comp.data.show, true, 'open() 要把弹窗叫回来');
    assert.strictEqual(store.privacy_prompt_skip_at, undefined, 'open() 必须清掉跳过标记，否则下次又弹不出来');

    comp.onAgree();
    assert.strictEqual(comp.data.show, false);
    assert.deepStrictEqual(agreed, ['agree'], '同意后要通知页面继续刚才的动作');
  } finally {
    restoreWx();
  }
});

test('隐私被拦：日记页与我的页都要唤起授权弹窗，而不是只丢一句 toast', () => {
  // 静态锁接线：wxml 上有 id 与 bind:agree，js 里两处隐私失败分支走 privacy.openGuard
  const cases = [
    ['miniprogram/pages/diary/index.wxml', 'miniprogram/pages/diary/index.js'],
    ['miniprogram/pages/profile/index.wxml', 'miniprogram/pages/profile/index.js'],
  ];
  cases.forEach(([wxmlRel, jsRel]) => {
    const wxml = fs.readFileSync(path.join(ROOT, wxmlRel), 'utf8');
    assert.ok(/<privacy-guard[^>]*id="privacyGuard"/.test(wxml), wxmlRel + ' 的守卫缺 id，页面 selectComponent 拿不到');
    assert.ok(/<privacy-guard[^>]*bind:agree="onPrivacyAgreed"/.test(wxml), wxmlRel + ' 的守卫没接 agree 事件');
    const js = fs.readFileSync(path.join(ROOT, jsRel), 'utf8');
    assert.ok(/require\('\.\.\/\.\.\/utils\/privacy'\)/.test(js), jsRel + ' 没引入 utils/privacy');
    assert.ok(/privacy\.openGuard\(this\)/.test(js), jsRel + ' 隐私失败时没有唤起授权弹窗');
    assert.ok(/onPrivacyAgreed\s*\(/.test(js), jsRel + ' 缺少 onPrivacyAgreed 处理');
  });
});

test('隐私被拦：日记页同意后会重试选图，我的页同意后会重开相册', () => {
  const diary = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/diary/index.js'), 'utf8');
  const agreeBody = diary.slice(diary.indexOf('onPrivacyAgreed('), diary.indexOf('onPrivacyAgreed(') + 120);
  assert.ok(/pickImages/.test(agreeBody), '日记页同意后应重试选图：' + agreeBody);

  const profile = fs.readFileSync(path.join(ROOT, 'miniprogram/pages/profile/index.js'), 'utf8');
  const profileAgree = profile.slice(profile.indexOf('onPrivacyAgreed('), profile.indexOf('onPrivacyAgreed(') + 120);
  assert.ok(/onChooseAvatarTap/.test(profileAgree), '我的页同意后应重开相册：' + profileAgree);
});
