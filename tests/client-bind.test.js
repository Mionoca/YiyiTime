'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');
const constants = require('../miniprogram/utils/constants');

/**
 * 绑定页：日期上限用服务端 todayKey（文档 1.5 / 10.9），
 * 步骤推进与 pendingPatch 的映射要对齐 bind.status 的 state。
 */
const BIND = 'miniprogram/pages/bind/index.js';

function tomorrowKey() {
  return timeUtil.dateKeyOf(Date.now() + 86400000);
}

/** 轮询等待条件成立（避免对固定 700ms 定时器只留 60ms 余量导致高负载下偶发 flake） */
async function waitFor(predicate, timeout) {
  const deadline = Date.now() + (timeout || 1500);
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return predicate();
}

function setup(handlers, wxExtra) {
  const toasts = [];
  const errors = [];
  const calls = [];
  const navs = [];
  installWx(
    Object.assign(
      {
        showToast: (opts) => toasts.push(opts),
        showModal: (opts) => {
          const next = setup.modal && setup.modal(opts);
          if (next) opts.success && opts.success(next);
        },
        reLaunch: (opts) => navs.push(opts),
      },
      wxExtra || {}
    )
  );
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (handlers[action]) return handlers[action](payload, calls.length);
    throw new Error('unexpected action: ' + action);
  };
  api.showError = (err) => errors.push(err);
  const page = instantiate(loadPage(BIND));
  return { page, toasts, errors, calls, navs };
}

function userRes(nickname, profileComplete, avatarFileID) {
  return {
    user: {
      openid: 'oA',
      nickname: nickname == null ? '小怡' : nickname,
      avatarFileID: avatarFileID || '',
      profileComplete: profileComplete == null ? true : profileComplete,
      coupleId: null,
    },
  };
}

function statusRes(patch) {
  return Object.assign({ state: 'unbound', pending: null, todayKey: tomorrowKey() }, patch);
}

function pendingRes(state, code, extra) {
  return statusRes({
    state,
    pending: Object.assign({ code, role: 'creator', status: 'open', startDate: '2024-05-20', expiresAt: 'later', other: null }, extra || {}),
  });
}

test('bind: 服务端 todayKey 覆盖设备日期，作为开始日期默认值与 picker 上限', async () => {
  const serverToday = tomorrowKey();
  const { page } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ todayKey: serverToday }),
  });
  try {
    await page.onLoad({});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(page.data.step, 'invite');
    assert.strictEqual(page.data.maxDate, serverToday);
    assert.strictEqual(page.data.todayKey, serverToday);
    assert.strictEqual(page.data.startDate, serverToday);
    assert.strictEqual(page.data.startDateText, timeUtil.formatDateCN(serverToday));
    assert.notStrictEqual(page.data.maxDate, timeUtil.todayKey());
  } finally {
    restoreWx();
  }
});

test('bind: 用户已手选开始日期时不被服务端今天覆盖', async () => {
  const serverToday = tomorrowKey();
  const { page } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ todayKey: serverToday }),
  });
  try {
    page.onStartDateChange({ detail: { value: '2024-05-20' } });
    await page.init();
    assert.strictEqual(page.data.startDate, '2024-05-20');
    assert.strictEqual(page.data.maxDate, serverToday);
  } finally {
    restoreWx();
  }
});

test('bind: 资料未完善时先走资料步骤，保存资料后重新拉状态进入邀请步骤', async () => {
  const serverToday = tomorrowKey();
  let complete = false;
  const { page, toasts, calls } = setup({
    'user.get': () => userRes('小怡', complete),
    'bind.status': () => statusRes({ todayKey: serverToday }),
    'user.updateProfile': () => {
      complete = true;
      return userRes('小怡');
    },
  });
  try {
    await page.onLoad({});
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(page.data.step, 'profile');
    page.data.nickname = '小怡';
    page.uploadAvatar = async () => 'cloud://env/avatars/a.png';
    page.pendingAvatar = 'tmp://a.png';
    await page.onTapSaveProfile();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(page.data.step, 'invite');
    const saved = calls.filter((c) => c.action === 'user.updateProfile');
    assert.strictEqual(saved.length, 1, '保存资料只发一次 user.updateProfile');
    assert.strictEqual(saved[0].payload.nickname, '小怡');
    assert.strictEqual(saved[0].payload.avatarFileID, 'cloud://env/avatars/a.png');
  } finally {
    restoreWx();
  }
});

test('bind: 昵称为空或超长时不提交资料', async () => {
  const { page, toasts, calls } = setup({
    'user.get': () => userRes('', false),
    'bind.status': () => statusRes(),
  });
  try {
    await page.init();
    page.data.nickname = '   ';
    await page.onTapSaveProfile();
    assert.ok(toasts.some((t) => t.title === '先起个昵称吧'));
    page.data.nickname = '一二三四五六七八九十一二三';
    await page.onTapSaveProfile();
    assert.ok(toasts.some((t) => t.title === '昵称最多 12 个字'));
    assert.strictEqual(calls.filter((c) => c.action === 'user.updateProfile').length, 0);
  } finally {
    restoreWx();
  }
});

test('bind: 已绑定直接回首页', async () => {
  const { page, navs } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ state: 'bound' }),
  });
  try {
    await page.init();
    assert.strictEqual(page.ready, true);
    // 文档 8.3.2 步骤 1：已绑定的人进绑定页应直接回首页（否则会卡在 loading）
    assert.deepStrictEqual(navs, [{ url: constants.ROUTES.home }]);
  } finally {
    restoreWx();
  }
});

test('bind: 从分享卡带 ?code 进入时自动预览并进入预览步骤', async () => {
  const { page, calls } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ todayKey: tomorrowKey() }),
    'bind.preview': (payload) => {
      assert.deepStrictEqual(payload, { code: '123456' });
      return {
        code: '123456',
        startDate: '2024-05-20',
        expiresAt: 'later',
        creator: { nickname: 'TA', avatarFileID: '', profileComplete: true },
      };
    },
  });
  try {
    await page.onLoad({ code: '123456' });
    // init 是异步的：enter 步骤会自动 doPreview，等它落地
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(calls.filter((c) => c.action === 'bind.preview').length, 1);
    assert.strictEqual(page.data.step, 'preview');
    assert.strictEqual(page.data.code, '123456');
    assert.strictEqual(page.data.codeInput, '123456');
    assert.strictEqual(page.data.startDateText, timeUtil.formatDateCN('2024-05-20'));
  } finally {
    restoreWx();
  }
});

test('bind: 邀请码不是 6 位数字时不发请求', async () => {
  const { page, toasts, calls } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes(),
  });
  try {
    await page.init();
    page.data.codeInput = '12ab56';
    await page.onTapPreview();
    assert.ok(toasts.some((t) => t.title === '邀请码是 6 位数字'));
    assert.strictEqual(calls.filter((c) => c.action === 'bind.preview').length, 0);
  } finally {
    restoreWx();
  }
});

test('bind: 申请成功后进入等待步骤，取消后回邀请步骤并刷新默认开始日期', async () => {
  setup.modal = () => ({ confirm: true });
  let todayKey = tomorrowKey();
  let state = 'unbound';
  const { page, toasts } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ state, todayKey }),
    'bind.preview': () => ({ code: '123456', startDate: '2024-05-20', creator: { nickname: 'TA' } }),
    'bind.apply': (payload) => {
      assert.deepStrictEqual(payload, { code: '123456' });
      return {
        code: '123456',
        startDate: '2024-05-20',
        expiresAt: 'later',
        creator: { nickname: 'TA', avatarFileID: '', profileComplete: true },
      };
    },
    'bind.cancel': () => ({ ok: true }),
  });
  try {
    await page.init();
    page.data.codeInput = '123456';
    await page.onTapPreview();
    await page.onTapApply();
    assert.strictEqual(page.data.step, 'waiting');
    assert.strictEqual(page.data.bindState, 'applied_by_me');
    assert.ok(toasts.some((t) => t.title === '申请已发出，等 TA 确认'));

    // 等待期间跨天：刷新只同步 picker 上限，等待中的邀请开始日期不动
    state = 'applied_by_me';
    const nextDay = timeUtil.dateKeyOf(Date.now() + 2 * 86400000);
    todayKey = nextDay;
    await page.refreshStatus(true);
    assert.strictEqual(page.data.maxDate, nextDay);
    assert.strictEqual(page.data.startDate, '2024-05-20');

    await page.onTapCancel();
    assert.strictEqual(page.data.step, 'invite');
    assert.strictEqual(page.data.bindState, 'unbound');
    assert.strictEqual(page.data.pending, null);
    // 取消回邀请步骤时，用户没手选过开始日期，应重置成服务端今天（不能带昨天的默认值提交）
    assert.strictEqual(page.data.startDate, nextDay);
    assert.strictEqual(page.data.startDateText, timeUtil.formatDateCN(nextDay));
  } finally {
    setup.modal = null;
    restoreWx();
  }
});

test('bind: 邀请码状态为 code_created 时展示邀请码步骤并只分享自己的码', async () => {
  const { page } = setup({
    'user.get': () => userRes(),
    'bind.status': () => pendingRes('code_created', '654321'),
  });
  try {
    await page.init();
    assert.strictEqual(page.data.step, 'code');
    assert.strictEqual(page.data.code, '654321');
    page.data.bindState = 'code_created';
    page.data.pending = { code: '654321', startDate: '2024-05-20' };
    const share = page.buildShare();
    assert.strictEqual(share.path, constants.ROUTES.bind + '?code=654321');
    // 对方申请/自己已申请阶段不外传 code
    page.data.bindState = 'applied_by_me';
    assert.strictEqual(page.buildShare().path, constants.ROUTES.bind);
    // 朋友圈永远不带码
    assert.strictEqual(page.onShareTimeline().path, undefined);
  } finally {
    restoreWx();
  }
});

test('bind: 创建邀请码成功后进入邀请码步骤，重新生成再调 bind.create', async () => {
  const { page, toasts } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ todayKey: tomorrowKey() }),
    'bind.create': (payload) => {
      assert.strictEqual(payload.regenerate, true);
      return { state: 'code_created', code: '111222', startDate: '2024-05-20', expiresAt: 'later' };
    },
  });
  try {
    await page.init();
    page.data.startDate = '2024-05-20';
    await page.doCreate(true);
    assert.strictEqual(page.data.step, 'code');
    assert.strictEqual(page.data.code, '111222');
    assert.ok(toasts.some((t) => t.title === '换好啦'));
  } finally {
    restoreWx();
  }
});

function confirmHandlers() {
  return {
    'user.get': () => userRes(),
    'bind.status': () => pendingRes('applied_by_partner', '123456'),
    'bind.confirm': (payload) => {
      assert.deepStrictEqual(payload, { code: '123456' });
      return { ok: true };
    },
  };
}

test('bind: 确认绑定成功后延迟回首页', async () => {
  setup.modal = () => ({ confirm: true });
  const { page, navs } = setup(confirmHandlers());
  try {
    await page.init();
    assert.strictEqual(page.data.step, 'confirm');
    await page.onTapConfirm();
    assert.ok(page.leaveTimer, '成功后应挂上回首页的定时器');
    assert.ok(await waitFor(() => navs.length === 1), '700ms 后应回首页');
    assert.deepStrictEqual(navs, [{ url: constants.ROUTES.home }]);
  } finally {
    setup.modal = null;
    restoreWx();
  }
});

test('bind: 确认成功但立刻离开页面，定时器被清掉不再跳首页', async () => {
  setup.modal = () => ({ confirm: true });
  const { page, navs } = setup(confirmHandlers());
  try {
    await page.init();
    await page.onTapConfirm();
    assert.ok(page.leaveTimer);
    page.onUnload();
    await new Promise((r) => setTimeout(r, 760));
    assert.deepStrictEqual(navs, []);
  } finally {
    setup.modal = null;
    restoreWx();
  }
});

test('bind: 刷新状态发现已绑定时回首页，跨天同步 picker 上限与默认开始日期', async () => {
  let serverToday = '2026-11-16';
  let state = 'unbound';
  const { page, navs } = setup({
    'user.get': () => userRes(),
    'bind.status': () => statusRes({ state, todayKey: serverToday }),
  });
  try {
    await page.init();
    assert.strictEqual(page.data.maxDate, '2026-11-16');
    assert.strictEqual(page.data.startDate, '2026-11-16');

    serverToday = '2026-11-17';
    await page.refreshStatus(true);
    assert.strictEqual(page.data.maxDate, '2026-11-17');
    assert.strictEqual(page.data.todayKey, '2026-11-17');
    // 用户没手选日期时，跨天后默认开始日期要跟着服务端今天走，避免把昨天当成开始日
    assert.strictEqual(page.data.startDate, '2026-11-17');
    assert.strictEqual(page.data.startDateText, timeUtil.formatDateCN('2026-11-17'));

    // 手选过日期后不能被服务端今天覆盖
    page.onStartDateChange({ detail: { value: '2024-05-20' } });
    serverToday = '2026-11-18';
    await page.refreshStatus(true);
    assert.strictEqual(page.data.maxDate, '2026-11-18');
    assert.strictEqual(page.data.startDate, '2024-05-20');

    state = 'bound';
    const result = await page.refreshStatus(true);
    assert.strictEqual(result, 'bound');
    assert.deepStrictEqual(navs, [{ url: constants.ROUTES.home }]);
  } finally {
    restoreWx();
  }
});

test('bind: 初始化失败进入错误步骤，重试成功后恢复', async () => {
  let fail = true;
  const { page } = setup({
    'user.get': () => userRes(),
    'bind.status': () => {
      if (fail) throw new Error('down');
      return statusRes({ todayKey: tomorrowKey() });
    },
  });
  try {
    await page.init();
    assert.strictEqual(page.data.step, 'error');
    assert.strictEqual(page.data.error, 'down');
    fail = false;
    await page.onTapRetry();
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(page.data.step, 'invite');
  } finally {
    restoreWx();
  }
});
