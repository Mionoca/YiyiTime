'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');
const haptics = require('../miniprogram/utils/haptics');

/**
 * profile 页的天数/开始日期/纪念日文案必须由 home.get 返回值决定：
 * 脏 startDate 时服务端会把 daysTogether / startDate / anniversary 降级为 null，
 * 页面不能拼出「第 null 天」（与首页 derive 同一守卫，见 docs/开发进度.md 已知偏差）。
 */
const PROFILE = 'miniprogram/pages/profile/index.js';

function baseHome(patch) {
  return Object.assign({
    todayKey: '2026-11-16',
    user: { nickname: '小怡', avatarFileID: '', profileComplete: true },
    bind: { state: 'bound', pending: null },
    couple: {
      coupleId: 'c_1',
      startDate: '2024-05-20',
      daysTogether: 911,
      anniversary: { date: '2027-05-20', daysLeft: 185 },
    },
  }, patch);
}

/** 提醒设置的默认出参：已配置模板、关闭、21:00 */
const REMINDER_OFF = {
  configured: true, enabled: false, remindAt: '21:00',
  quota: 0, quotaMax: 7, templateId: 'tpl_test',
  bound: true, todayKey: '2026-11-16', checkedInToday: false,
};

function stubApi(home, handlers) {
  api.call = async (action, payload) => {
    if (handlers && typeof handlers[action] === 'function') return handlers[action](payload);
    // 提醒设置是 M10 新增的第二个首屏请求；给个合理默认，避免各用例都要显式桩它
    if (action === 'reminder.get') return Object.assign({}, REMINDER_OFF);
    return home;
  };
}

function newPage() {
  const config = loadPage(PROFILE);
  return instantiate(config);
}

test('profile: 正常数据渲染天数、开始日期与纪念日', async () => {
  installWx({});
  try {
    stubApi(baseHome());
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.loading, false);
    assert.strictEqual(page.data.bound, true);
    assert.strictEqual(page.data.daysText, '第 911 天');
    assert.strictEqual(page.data.startDateText, timeUtil.formatDateCN('2024-05-20'));
    assert.strictEqual(page.data.startDateText, '2024年5月20日');
    assert.strictEqual(page.data.anniversaryText, '2027年5月20日 · 还有 185 天');
    assert.strictEqual(page.data.maxStartDate, '2026-11-16');
  } finally {
    restoreWx();
  }
});

test('profile: 脏 startDate（服务端降级为 null）不显示「第 null 天」', async () => {
  installWx({});
  try {
    stubApi(baseHome({
      couple: { coupleId: 'c_1', startDate: null, daysTogether: null, anniversary: null },
    }));
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.daysText, '');
    assert.strictEqual(page.data.startDateText, '');
    assert.strictEqual(page.data.anniversaryText, '');
    const rendered = [page.data.daysText, page.data.startDateText, page.data.anniversaryText].join('|');
    assert.strictEqual(rendered.includes('null'), false);
    assert.strictEqual(rendered.includes('NaN'), false);
  } finally {
    restoreWx();
  }
});

test('profile: 有开始日期但没有纪念日对象时，回退文案为「开始那天就是纪念日」', async () => {
  installWx({});
  try {
    stubApi(baseHome({
      couple: { coupleId: 'c_1', startDate: '2024-05-20', daysTogether: 911, anniversary: null },
    }));
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.anniversaryText, '开始那天就是纪念日');
    assert.strictEqual(page.data.startDateText, '2024年5月20日');
  } finally {
    restoreWx();
  }
});

test('profile: 未绑定时清空天数/日期/纪念日，绑定状态文案正确', async () => {
  installWx({});
  try {
    stubApi(baseHome({
      user: { nickname: '小怡', avatarFileID: '', profileComplete: true },
      bind: { state: 'unbound', pending: null },
      couple: null,
    }));
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.bound, false);
    assert.strictEqual(page.data.bindStateText, '还没绑定');
    assert.strictEqual(page.data.daysText, '');
    assert.strictEqual(page.data.startDateText, '');
    assert.strictEqual(page.data.anniversaryText, '');
  } finally {
    restoreWx();
  }
});

test('profile: 版本号取不到时显示「内测版」，取得到时显示 v 前缀', async () => {
  installWx({});
  try {
    stubApi(baseHome());
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.appVersion, '内测版');

    installWx({ getAccountInfoSync: () => ({ miniProgram: { version: '1.2.3' } }) });
    const page2 = newPage();
    await page2.load();
    assert.strictEqual(page2.data.appVersion, 'v1.2.3');
  } finally {
    restoreWx();
  }
});

test('profile: 振动反馈开关默认开启，关闭后本地持久化并 toast', async () => {
  const stored = {};
  const toasts = [];
  installWx({
    getStorageSync: (key) => stored[key],
    setStorageSync: (key, value) => {
      stored[key] = value;
    },
    showToast: (opts) => toasts.push(opts),
  });
  try {
    stubApi(baseHome());
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.hapticsEnabled, true);

    page.onToggleHaptics({ detail: { value: false } });
    assert.strictEqual(page.data.hapticsEnabled, false);
    assert.strictEqual(stored[haptics.STORAGE_KEY], false);
    assert.strictEqual(toasts[0].title, '振动反馈已关闭');

    // 重新进页面（load）要读到已保存的关闭状态
    const page2 = newPage();
    await page2.load();
    assert.strictEqual(page2.data.hapticsEnabled, false);

    page2.onToggleHaptics({ detail: { value: true } });
    assert.strictEqual(stored[haptics.STORAGE_KEY], true);
    assert.strictEqual(page2.data.hapticsEnabled, true);
  } finally {
    restoreWx();
  }
});

test('profile: 振动反馈开关的 wxml 真的绑定了事件并回显状态', () => {
  // 页面测试直接调 onToggleHaptics，绑错 bindchange 也会全绿，这里静态锁一下
  const wxml = fs.readFileSync(path.join(__dirname, '..', 'miniprogram/pages/profile/index.wxml'), 'utf8');
  assert.ok(wxml.includes('bindchange="onToggleHaptics"'), '振动开关没有绑定 onToggleHaptics');
  assert.ok(wxml.includes('checked="{{hapticsEnabled}}"'), '振动开关没有回显 hapticsEnabled');
});

test('profile: 本地写开关失败时回滚 UI 并提示，不假装已关闭', async () => {
  const stored = {};
  const toasts = [];
  installWx({
    getStorageSync: (key) => stored[key],
    setStorageSync: () => {
      throw new Error('storage full');
    },
    showToast: (opts) => toasts.push(opts),
  });
  try {
    stubApi(baseHome());
    const page = newPage();
    await page.load();
    assert.strictEqual(page.data.hapticsEnabled, true);
    page.onToggleHaptics({ detail: { value: false } });
    // 写失败：storage 仍为「开」，UI 必须回滚成开，不能显示成已关闭
    assert.strictEqual(stored[haptics.STORAGE_KEY], undefined);
    assert.strictEqual(page.data.hapticsEnabled, true);
    assert.strictEqual(toasts[toasts.length - 1].title, '开关没保存成功，稍后再试');
  } finally {
    restoreWx();
  }
});

test('profile: 改昵称过程中静默刷新不覆盖输入草稿，强制刷新也保留草稿', async () => {
  installWx({});
  try {
    stubApi(baseHome());
    const page = newPage();
    page.data.editing = true;
    page.data.nickname = '改到一半';
    await page.load();
    assert.strictEqual(page.data.nickname, '改到一半');
    await page.load(true);
    assert.strictEqual(page.data.nickname, '改到一半');
    assert.strictEqual(page.data.loading, false);
  } finally {
    restoreWx();
  }
});

test('profile: 下拉刷新静默刷新并收起转圈，改昵称中不覆盖草稿', async () => {
  const stops = [];
  installWx({ stopPullDownRefresh: () => stops.push(1) });
  try {
    let calls = 0;
    api.call = async (action) => {
      // M10 起首屏还有一次 reminder.get；这条用例数的是「整页刷新发了几轮」
      if (action !== 'home.get') return Object.assign({}, REMINDER_OFF);
      calls += 1;
      return baseHome();
    };
    const page = newPage();
    page.onPullDownRefresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(calls, 1);
    assert.strictEqual(stops.length, 1, '成功要收起转圈');
    page.data.editing = true;
    page.data.nickname = '改到一半';
    page.onPullDownRefresh();
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(stops.length, 2);
    assert.strictEqual(calls, 1, '正在改昵称时 load 提前 return，不再请求（只靠草稿兜底不算）');
    assert.strictEqual(page.data.nickname, '改到一半', '正在改昵称时别用服务端旧值覆盖输入框');
  } finally {
    restoreWx();
  }
});
test('profile: 头像校验失败时提示具体原因，不覆盖原头像（文档 11.9）', async () => {
  const shown = [];
  const realShowError = api.showError;
  const calls = [];
  installWx({});
  try {
    api.call = async (action) => {
      calls.push(action);
      if (action === 'reminder.get') return Object.assign({}, REMINDER_OFF);
      if (action !== 'home.get') throw new Error('unexpected action: ' + action);
      return baseHome();
    };
    api.showError = (err) => shown.push(err);
    const page = newPage();
    await page.load();
    page.data.avatarFileID = 'cloud://env/avatars/old.png';
    page.data.avatarPreview = 'cloud://env/avatars/old.png';
    const err = new Error('头像图片格式不支持，请选择 JPG 或 PNG');
    err.code = 'AVATAR_TYPE_INVALID';
    page.uploadAvatar = async () => {
      throw err;
    };
    await page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/a.gif' } });
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0], err, '校验错误要原样交给 api.showError，不能换成通用文案');
    assert.strictEqual(page.data.avatarPreview, 'cloud://env/avatars/old.png', '失败要回退到原头像');
    assert.strictEqual(page.data.saving, false);
    assert.deepStrictEqual(calls.filter((a) => a !== 'reminder.get'), ['home.get'], '校验失败不能提交 user.updateProfile');
  } finally {
    api.showError = realShowError;
    restoreWx();
  }
});

test('profile: 非校验类上传失败仍用通用文案', async () => {
  const shown = [];
  const realShowError = api.showError;
  installWx({});
  try {
    api.call = async () => baseHome();
    api.showError = (err) => shown.push(err);
    const page = newPage();
    await page.load();
    page.uploadAvatar = async () => {
      throw new Error('uploadFile:fail net');
    };
    await page.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp/a.png' } });
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].message, '头像上传失败，稍后再试');
  } finally {
    api.showError = realShowError;
    restoreWx();
  }
});


/* 文档 11.6：用户要求删除数据时 P1 人工处理，「我的」里要留联系方式。
 * 这里锁死三条：①入口能打开/收起说明弹层且覆盖 11.6 的全部口径；
 * ②删除数据指引走微信官方「反馈与投诉」，不编造联系方式、不把集合名/控制台这类实现细节写给用户；
 * ③wxml 真的绑定了事件、bottom-sheet 真的注册了（页面测试直接调方法，绑错也会全绿）。 */
test('profile: 数据与隐私入口打开说明弹层，覆盖 11.6 的收集 / 不收集 / 存储 / 删除口径', () => {
  installWx({});
  try {
    stubApi(baseHome());
    const page = newPage();
    assert.strictEqual(page.data.privacySheet, false, '默认不弹「数据与隐私」说明');
    page.onOpenDataPrivacy();
    assert.strictEqual(page.data.privacySheet, true, '点「数据与隐私」要打开说明弹层');
    const sections = page.data.privacySections || [];
    assert.ok(sections.length >= 5, '说明至少覆盖收集 / 不收集 / 用途 / 存储 / 删除五条，实际 ' + sections.length);
    sections.forEach((item) => {
      assert.ok(item && item.title && item.text, '每条说明都要有标题和正文：' + JSON.stringify(item));
    });
    const text = sections.map((s) => s.title + s.text).join('|') + (page.data.privacyFooter || '');
    ['openid', '昵称', '头像', '手机号', '位置', '通讯录', '身份证', '支付信息', '第三方', '云开发', '删除', '反馈与投诉'].forEach((token) => {
      assert.ok(text.indexOf(token) >= 0, '说明里缺少文档 11.6 的口径：' + token);
    });
    page.onCloseDataPrivacy();
    assert.strictEqual(page.data.privacySheet, false, '关掉弹层后要复位 privacySheet');
  } finally {
    restoreWx();
  }
});

test('profile: 删除数据指引是微信官方「反馈与投诉」，不编造联系方式、不暴露实现细节', () => {
  const privacy = require('../miniprogram/utils/privacy');
  const text = privacy.SECTIONS.map((s) => s.title + s.text).join('|') + privacy.FOOTER;
  assert.ok(text.indexOf('反馈与投诉') >= 0, '删除数据必须给真实可达的通道（微信「反馈与投诉」）');
  assert.ok(text.indexOf('右上角') >= 0, '要说清楚「··」入口在右上角');
  assert.strictEqual(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text), false, '不能凭空编一个邮箱当联系方式');
  assert.strictEqual(/QQ|qq|微信号\s*[:：]|电话\s*[:：]/.test(text), false, '不能凭空编 QQ / 微信号 / 电话当联系方式');
  assert.strictEqual(/\d{5,}/.test(text), false, '用户可见文案里不要放长数字（电话 / 学号这类）');
  ['集合', '控制台', 'users', 'couples', 'bind_invites'].forEach((word) => {
    assert.strictEqual(text.indexOf(word) >= 0, false, '用户可见文案不要出现实现细节：' + word);
  });
});

test('profile: 数据与隐私的 wxml 绑定与 bottom-sheet 注册真的存在', () => {
  const root = path.join(__dirname, '..');
  const wxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'index.wxml'), 'utf8');
  assert.ok(wxml.indexOf('bindtap="onOpenDataPrivacy"') >= 0, '「数据与隐私」行没有绑定 onOpenDataPrivacy');
  assert.ok(/<bottom-sheet[\s\S]*?show="\{\{privacySheet\}\}"/.test(wxml), 'bottom-sheet 没有绑定 privacySheet');
  assert.ok(wxml.indexOf('bind:close="onCloseDataPrivacy"') >= 0, 'bottom-sheet 没有绑定关闭事件');
  assert.ok(wxml.indexOf('wx:for="{{privacySections}}"') >= 0, '说明条目没有按 privacySections 渲染');
  const json = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'index.json'), 'utf8'));
  assert.strictEqual(json.usingComponents['bottom-sheet'], '/components/bottom-sheet/index', 'profile 页没有注册 bottom-sheet 组件');
});

/* M9 解绑（文档 8.3.6）：三态文案只认服务端 unbind.requestedByMe，三种操作各自二次确认。 */
function unbindSetup(unbind) {
  const calls = [];
  const toasts = [];
  const navs = [];
  installWx({
    showToast: (opts) => toasts.push(opts.title),
    showModal: (opts) => {
      if (unbindSetup.confirm !== false && opts.success) opts.success({ confirm: true, cancel: false });
    },
    reLaunch: (opts) => navs.push(opts.url),
  });
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'home.get') {
      return baseHome({ unbind: unbind.current });
    }
    if (action === 'couple.requestUnbind') {
      unbind.current = { status: 'pending', requestedByMe: true, requestedAt: '2026-11-16T04:00:00.000Z' };
      return { unbind: unbind.current };
    }
    if (action === 'couple.cancelUnbind') {
      unbind.current = { status: 'none', requestedByMe: false, requestedAt: null };
      return { unbind: unbind.current };
    }
    if (action === 'couple.confirmUnbind') {
      unbind.current = { status: 'none', requestedByMe: false, requestedAt: null };
      return { status: 'unbound' };
    }
    throw new Error('unexpected action: ' + action);
  };
  api.showError = () => {};
  return { page: newPage(), calls, toasts, navs };
}

test('profile: 解绑三态文案来自服务端 unbind.requestedByMe', async () => {
  const cases = [
    [{ status: 'none', requestedByMe: false }, 'none', '解绑'],
    [{ status: 'pending', requestedByMe: true }, 'pending_me', '等 TA 确认解绑（点击撤回）'],
    [{ status: 'pending', requestedByMe: false }, 'pending_partner', 'TA 申请解绑（点击确认）'],
  ];
  for (const [unbind, status, text] of cases) {
    const state = { current: unbind };
    const { page } = unbindSetup(state);
    try {
      await page.load();
      assert.strictEqual(page.data.unbindStatus, status, JSON.stringify(unbind));
      assert.strictEqual(page.data.unbindText, text);
    } finally {
      restoreWx();
    }
  }
});

test('profile: 申请解绑先二次确认，成功进入等待态并刷新', async () => {
  const state = { current: { status: 'none', requestedByMe: false, requestedAt: null } };
  const { page, calls, toasts } = unbindSetup(state);
  try {
    await page.load();
    page.onTapUnbind();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const request = calls.filter((call) => call.action === 'couple.requestUnbind');
    assert.strictEqual(request.length, 1);
    assert.strictEqual(page.data.unbindStatus, 'pending_me');
    assert.strictEqual(toasts[toasts.length - 1], '已经申请啦，等 TA 确认');
    assert.strictEqual(calls.filter((call) => call.action === 'home.get').length, 2, '写成功后要重拉 home.get');
  } finally {
    restoreWx();
  }
});

test('profile: 取消二次确认时不发请求', async () => {
  const state = { current: { status: 'none', requestedByMe: false, requestedAt: null } };
  unbindSetup.confirm = false;
  const { page, calls } = unbindSetup(state);
  try {
    await page.load();
    page.onTapUnbind();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(calls.filter((call) => call.action === 'couple.requestUnbind').length, 0);
    assert.strictEqual(page.data.unbindStatus, 'none');
  } finally {
    unbindSetup.confirm = true;
    restoreWx();
  }
});

test('profile: 自己发起的解绑点一下是撤回', async () => {
  const state = { current: { status: 'pending', requestedByMe: true, requestedAt: '2026-11-16T04:00:00.000Z' } };
  const { page, calls, toasts } = unbindSetup(state);
  try {
    await page.load();
    assert.strictEqual(page.data.unbindStatus, 'pending_me');
    page.onTapUnbind();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(calls.filter((call) => call.action === 'couple.cancelUnbind').length, 1);
    assert.strictEqual(page.data.unbindStatus, 'none');
    assert.strictEqual(page.data.unbindText, '解绑');
    assert.strictEqual(toasts[toasts.length - 1], '撤回啦');
  } finally {
    restoreWx();
  }
});

test('profile: 对方发起的解绑确认后提示并延迟回首页', async () => {
  const state = { current: { status: 'pending', requestedByMe: false, requestedAt: '2026-11-16T04:00:00.000Z' } };
  const { page, calls, toasts, navs } = unbindSetup(state);
  try {
    await page.load();
    assert.strictEqual(page.data.unbindStatus, 'pending_partner');
    page.onTapUnbind();
    await new Promise((resolve) => setTimeout(resolve, 780));
    assert.strictEqual(calls.filter((call) => call.action === 'couple.confirmUnbind').length, 1);
    assert.strictEqual(toasts[0], '已经解绑了');
    assert.deepStrictEqual(navs, ['/pages/home/index'], '解绑成功后要回首页');
  } finally {
    restoreWx();
  }
});

test('profile: 解绑 / 记账本入口的 wxml 接线存在，见面基金占位已下线', () => {
  const root = path.join(__dirname, '..');
  const wxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'index.wxml'), 'utf8');
  assert.ok(wxml.indexOf('bindtap="onTapUnbind"') >= 0, '解绑行没有绑定 onTapUnbind');
  assert.ok(wxml.indexOf('wx:if="{{bound}}"') >= 0, '解绑行只在已绑定时出现');
  assert.ok(wxml.indexOf('bindtap="onOpenLedger"') >= 0, '记账本入口没有绑定 onOpenLedger');
  assert.ok(wxml.indexOf('{{unbindText}}') >= 0, '解绑行文案要走数据绑定');
  assert.strictEqual(wxml.indexOf('见面基金'), -1, '见面基金已被个人记账本替代');
  assert.strictEqual(wxml.indexOf('解绑（联系开发者）'), -1, '解绑已改为应用内双方确认');
});

/**
 * 每日提醒（M10 / 文档 7.15 / 8.3.6）。
 * 这里的重点是「先授权后开启」的顺序：顺序反了就会出现「开关开着但永远发不出去」。
 */
function reminderSetup(opts) {
  const o = opts || {};
  const calls = [];
  const toasts = [];
  const subscribe = { tmplIds: [], result: o.result === undefined ? 'accept' : o.result, called: 0 };
  const state = Object.assign({}, REMINDER_OFF, o.reminder || {});
  const originalShowError = api.showError;

  installWx({
    showToast: (x) => toasts.push(x.title),
    showModal: () => {},
    stopPullDownRefresh: () => {},
    requestSubscribeMessage: (x) => {
      subscribe.called += 1;
      subscribe.tmplIds.push(x.tmplIds);
      if (subscribe.result === 'fail') {
        if (x.fail) x.fail({ errMsg: 'requestSubscribeMessage:fail' });
        return;
      }
      const res = {};
      (x.tmplIds || []).forEach((id) => { res[id] = subscribe.result; });
      if (x.success) x.success(res);
    },
  });

  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (action === 'home.get') {
      if (o.homeFails) throw Object.assign(new Error('小屋打不开'), { code: 'NETWORK_ERROR' });
      return baseHome(o.home);
    }
    if (action === 'reminder.get') {
      if (o.getFails) throw Object.assign(new Error('设置读不到'), { code: 'INTERNAL_ERROR' });
      return Object.assign({}, state);
    }
    if (action === 'reminder.grant') {
      if (o.grantFails) throw Object.assign(new Error('额度没攒上'), { code: 'INTERNAL_ERROR' });
      state.quota = Math.min(state.quota + 1, state.quotaMax);
      return Object.assign({}, state);
    }
    if (action === 'reminder.set') {
      if (o.setFails) throw Object.assign(new Error('保存失败'), { code: 'INTERNAL_ERROR' });
      state.enabled = !!payload.enabled;
      // 服务端会把 '9:05' 归一化成 '09:05'；桩按真实契约返回，才能验证页面是否采用服务端的值
      if (payload.remindAt) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(payload.remindAt);
        state.remindAt = m ? (m[1].length === 1 ? '0' + m[1] : m[1]) + ':' + m[2] : payload.remindAt;
      }
      return Object.assign({}, state);
    }
    return null;
  };
  api.showError = (err) => toasts.push(err && err.message);

  const page = newPage();
  return {
    page, calls, toasts, subscribe, state,
    restore() {
      api.showError = originalShowError;
      restoreWx();
    },
  };
}

function actionsOf(calls) {
  return calls.map((c) => c.action);
}

test('profile: 首屏渲染提醒设置（开关、时间、剩余额度）', async () => {
  const env = reminderSetup({
    reminder: { enabled: true, remindAt: '22:30', quota: 3 },
  });
  try {
    await env.page.load();
    assert.strictEqual(env.page.data.reminder.enabled, true);
    assert.strictEqual(env.page.data.reminder.remindAt, '22:30');
    assert.strictEqual(env.page.data.reminder.quota, 3);
    assert.strictEqual(env.page.data.reminder.configured, true);
  } finally {
    env.restore();
  }
});

test('profile: 开启提醒要先拿订阅授权，accept 后才 grant + set（顺序不能反）', async () => {
  const env = reminderSetup();
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: true } });

    assert.deepStrictEqual(env.subscribe.tmplIds, [['tpl_test']], '必须用服务端下发的模板 ID');
    assert.deepStrictEqual(
      actionsOf(env.calls).filter((a) => a !== 'home.get' && a !== 'reminder.get'),
      ['reminder.grant', 'reminder.set'],
      '顺序必须是先攒额度再打开开关'
    );
    const set = env.calls.filter((c) => c.action === 'reminder.set').pop();
    assert.strictEqual(set.payload.enabled, true);
    assert.strictEqual(set.payload.remindAt, '21:00', '改开关不该顺手改时间');
    assert.strictEqual(env.page.data.reminder.enabled, true);
    assert.strictEqual(env.page.data.reminder.quota, 1);
    assert.strictEqual(env.toasts[env.toasts.length - 1], '到点会提醒你');
  } finally {
    env.restore();
  }
});

test('profile: 拒绝订阅授权时开关回滚、不攒额度、不发 set', async () => {
  const env = reminderSetup({ result: 'reject' });
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: true } });

    assert.deepStrictEqual(
      actionsOf(env.calls).filter((a) => a.indexOf('reminder.') === 0 && a !== 'reminder.get'),
      [],
      '没授权就什么都不该提交'
    );
    assert.strictEqual(env.page.data.reminder.enabled, false, '开关必须回到用户操作前的状态');
    assert.strictEqual(env.page.data.reminderSaving, false);
    assert.strictEqual(env.toasts[env.toasts.length - 1], '没收到授权，提醒没打开');
  } finally {
    env.restore();
  }
});

test('profile: 授权接口直接 fail 也按「没授权」处理', async () => {
  const env = reminderSetup({ result: 'fail' });
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: true } });
    assert.strictEqual(env.page.data.reminder.enabled, false);
    assert.strictEqual(env.subscribe.called, 1);
  } finally {
    env.restore();
  }
});

test('profile: 关闭提醒不需要授权，直接 set(false)', async () => {
  const env = reminderSetup({ reminder: { enabled: true, quota: 2 } });
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: false } });

    assert.strictEqual(env.subscribe.called, 0, '关掉不该再骚扰用户要授权');
    assert.deepStrictEqual(
      actionsOf(env.calls).filter((a) => a.indexOf('reminder.') === 0 && a !== 'reminder.get'),
      ['reminder.set']
    );
    assert.strictEqual(env.calls.filter((c) => c.action === 'reminder.set')[0].payload.enabled, false);
    assert.strictEqual(env.page.data.reminder.enabled, false);
    assert.strictEqual(env.toasts[env.toasts.length - 1], '提醒已关闭');
  } finally {
    env.restore();
  }
});

test('profile: 模板没配 / 未绑定时打不开开关，并给出原因', async () => {
  const notConfigured = reminderSetup({ reminder: { configured: false, templateId: '' } });
  try {
    await notConfigured.page.load();
    await notConfigured.page.onToggleReminder({ detail: { value: true } });
    assert.strictEqual(notConfigured.page.data.reminder.enabled, false);
    assert.strictEqual(notConfigured.subscribe.called, 0);
    assert.strictEqual(notConfigured.toasts[notConfigured.toasts.length - 1], '提醒还没开通');
  } finally {
    notConfigured.restore();
  }

  const notBound = reminderSetup({ home: { bind: { state: 'unbound', pending: null }, couple: null } });
  try {
    await notBound.page.load();
    assert.strictEqual(notBound.page.data.bound, false);
    await notBound.page.onToggleReminder({ detail: { value: true } });
    assert.strictEqual(notBound.page.data.reminder.enabled, false);
    assert.strictEqual(notBound.subscribe.called, 0);
    assert.strictEqual(notBound.toasts[notBound.toasts.length - 1], '先邀请 TA 住进来吧');
  } finally {
    notBound.restore();
  }
});

test('profile: 改提醒时间走 set，并把服务端归一化后的值回填', async () => {
  const env = reminderSetup({ reminder: { enabled: true, quota: 1 } });
  try {
    await env.page.load();
    await env.page.onReminderTimeChange({ detail: { value: '9:05' } });

    const set = env.calls.filter((c) => c.action === 'reminder.set').pop();
    assert.strictEqual(set.payload.enabled, true, '改时间不该把开关关掉');
    assert.strictEqual(set.payload.remindAt, '9:05');
    assert.strictEqual(env.page.data.reminder.remindAt, '09:05', '回填要用服务端归一化后的值');
    assert.strictEqual(env.page.data.reminderSaving, false);
  } finally {
    env.restore();
  }
});

test('profile: 明显不合法的 time 值不发请求', async () => {
  const env = reminderSetup();
  try {
    await env.page.load();
    await env.page.onReminderTimeChange({ detail: { value: 'abc' } });
    await env.page.onReminderTimeChange({ detail: { value: '' } });
    assert.strictEqual(env.calls.filter((c) => c.action === 'reminder.set').length, 0);
  } finally {
    env.restore();
  }
});

test('profile: 保存失败时开关回滚并提示', async () => {
  const env = reminderSetup({ setFails: true });
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: true } });
    assert.strictEqual(env.page.data.reminder.enabled, false);
    assert.strictEqual(env.page.data.reminderSaving, false);
    assert.strictEqual(env.toasts[env.toasts.length - 1], '保存失败');
  } finally {
    env.restore();
  }
});

test('profile: 提醒设置读不到时页面照常打开（附加信息不能拖垮整页）', async () => {
  const env = reminderSetup({ getFails: true });
  try {
    await env.page.load();
    assert.strictEqual(env.page.data.loading, false);
    assert.strictEqual(env.page.data.error, '');
    assert.strictEqual(env.page.data.daysText, '第 911 天');
    assert.strictEqual(env.page.data.reminderError, true, '读不到要单独标记，不能伪装成「提醒还没开通」');
    assert.strictEqual(env.page.data.reminder.configured, false, '同时开关是禁用态');
  } finally {
    env.restore();
  }
});

test('profile: 每日提醒的 wxml 接线存在（switch + time picker + 说明文案）', () => {
  const root = path.join(__dirname, '..');
  const wxml = fs.readFileSync(path.join(root, 'miniprogram', 'pages', 'profile', 'index.wxml'), 'utf8');
  assert.ok(wxml.indexOf('bindchange="onToggleReminder"') >= 0, '开关没有绑定 onToggleReminder');
  assert.ok(wxml.indexOf('bindchange="onReminderTimeChange"') >= 0, '时间选择没有绑定');
  assert.ok(wxml.indexOf('mode="time"') >= 0, '时间要用原生 time picker');
  assert.ok(wxml.indexOf('{{reminder.remindAt}}') >= 0, '时间要走数据绑定');
  assert.ok(wxml.indexOf('额度用完了') >= 0, '额度为 0 要给出「关掉再开一次会重新问授权」的说明');
  assert.strictEqual(wxml.indexOf('每日提醒（即将上线）'), -1, '每日提醒不再是占位');
  assert.strictEqual(wxml.indexOf('list-item--disabled'), -1, '提醒行不再是禁用占位');
});

test('profile: 额度攒上了但开关没保存成功时，重新拉一次把额度纠正过来', async () => {
  const env = reminderSetup({ setFails: true });
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: true } });
    await new Promise((r) => setTimeout(r, 10));

    assert.strictEqual(env.page.data.reminder.enabled, false, '开关要回滚');
    assert.strictEqual(env.page.data.reminderSaving, false);
    // 默认 quota 0，grant 成功后服务端是 1；catch 里的 load(true) 要把这个新额度拉回来
    assert.strictEqual(env.page.data.reminder.quota, 1, '不刷新的话页面会一直显示旧额度 0');
    assert.strictEqual(env.calls.filter((c) => c.action === 'reminder.get').length, 2, '应该重新读了一次设置');
  } finally {
    env.restore();
  }
});

test('profile: 额度都没攒上时不用白跑一次 load', async () => {
  const env = reminderSetup({ grantFails: true });
  try {
    await env.page.load();
    await env.page.onToggleReminder({ detail: { value: true } });
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(env.page.data.reminder.enabled, false);
    assert.strictEqual(env.calls.filter((c) => c.action === 'reminder.get').length, 1, 'grant 都失败了就不必重拉');
    assert.strictEqual(env.toasts[env.toasts.length - 1], '额度没攒上');
  } finally {
    env.restore();
  }
});

test('profile: 保存中改时间会提示而不是静默丢弃', async () => {
  const env = reminderSetup({ reminder: { enabled: true, quota: 1 } });
  try {
    await env.page.load();
    env.page.data.reminderSaving = true;
    await env.page.onReminderTimeChange({ detail: { value: '22:00' } });
    assert.strictEqual(env.calls.filter((c) => c.action === 'reminder.set').length, 0);
    assert.strictEqual(env.toasts[env.toasts.length - 1], '正在保存，稍后再改');
  } finally {
    env.restore();
  }
});
