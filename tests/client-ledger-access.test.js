'use strict';

/**
 * 对方账本首帧（M14 / 文档 17.3）。
 *
 * 现象：申请通过后离开再回来，会先闪一下「申请查看对方账本」再变成账本内容。
 * 根因：`access` 是纯请求派生状态，页面重建就回到 `null`，而锁态把 `null` 当「没权限」。
 * 修法：`accessKnown` 三态（未知 → 骨架；已知 → 直接画内容或锁），并配 `utils/permission-cache`
 * 的本地快照（24h TTL、绑 openid+coupleId）让首帧就有确定答案。
 *
 * 这里锁四件事：命中快照首帧不出「申请查看」、没有快照才出骨架、过期/换绑不复用、服务端结果回写。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const me = require('../miniprogram/utils/me');
const permissionCache = require('../miniprogram/utils/permission-cache');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = 'miniprogram/pages/ledger/index.js';
const LEDGER_WXML = 'miniprogram/pages/ledger/index.wxml';

const OPENID = 'oLEDGER_ME_0001';
const COUPLE = 'c_ledger000000001';

/** 极简存储桩：wx.getStorageSync / setStorageSync / removeStorageSync */
function storageStub(seed) {
  const store = Object.assign({}, seed || {});
  return {
    store,
    getStorageSync: (key) => (key in store ? store[key] : ''),
    setStorageSync: (key, value) => { store[key] = value; },
    removeStorageSync: (key) => { delete store[key]; },
  };
}

function snapshot(overrides) {
  return Object.assign({
    key: OPENID + '|' + COUPLE,
    status: 'approved',
    scope: 'temp',
    expiresAt: '2026-11-17T16:00:00.000Z',
    requestedAt: '2026-11-16T00:00:00.000Z',
    savedAt: Date.now(),
  }, overrides || {});
}

function setup(options) {
  const opts = options || {};
  const st = storageStub(opts.seed);
  const calls = [];
  installWx({
    getStorageSync: st.getStorageSync,
    setStorageSync: st.setStorageSync,
    removeStorageSync: st.removeStorageSync,
    showToast: () => {},
    stopPullDownRefresh: () => {},
  });
  // 身份（utils/me 写的 me_identity）单独放，避免每个用例都重复
  if (opts.identity !== false) {
    st.store[permissionCache.IDENTITY_KEY] = { openid: OPENID, coupleId: COUPLE };
  }
  api.call = async (action, payload) => {
    calls.push({ action, payload });
    if (opts.handlers && opts.handlers[action]) return opts.handlers[action](payload);
    if (action === 'ledger.list') {
      return {
        who: payload.who || 'me',
        month: '2026-11',
        todayKey: '2026-11-16',
        bound: true,
        partner: { nickname: '阿泽' },
        items: [],
        summary: { total: 0, count: 0 },
        permission: payload.who === 'partner' ? (opts.permission || null) : null,
      };
    }
    if (action === 'ledger.viewRequests') return { incoming: [], outgoing: [], granted: [] };
    throw new Error('unexpected action: ' + action);
  };
  api.showError = () => {};
  return { page: instantiate(loadPage(LEDGER)), calls, st };
}

test('快照命中 approved：切到「TA 的账本」首帧就是内容，不会闪回「申请查看」', async () => {
  const { page, st } = setup({ seed: { [permissionCache.STORAGE_KEY]: snapshot() } });
  try {
    page.onLoad();
    // 不 await：这正是「切过去的那一帧」——请求还在路上，页面必须已经能画对
    const pending = page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    assert.strictEqual(page.data.accessKnown, true, '切过去的首帧就必须是「已知」');
    assert.strictEqual(page.data.access && page.data.access.status, 'approved', '首帧就用快照里的 approved');
    await pending;
    assert.strictEqual(page.data.accessKnown, true, '请求回来后仍然已知（这次是服务端给的答案）');
    assert.strictEqual(st.store[permissionCache.STORAGE_KEY].status, 'none', '服务端说没权限就覆盖掉旧快照');
  } finally {
    restoreWx();
  }
});

test('快照命中锁态：pending 首帧直接画「等 TA 同意」，不是骨架', async () => {
  const { page } = setup({
    seed: { [permissionCache.STORAGE_KEY]: snapshot({ status: 'pending', scope: 'temp', expiresAt: null }) },
  });
  try {
    page.onLoad();
    page.restoreAccessSnapshot();
    assert.strictEqual(page.data.accessKnown, true);
    assert.strictEqual(page.data.access.status, 'pending');
  } finally {
    restoreWx();
  }
});

test('没有快照：保持 accessKnown=false（页面画骨架，不明说没权限）', () => {
  const { page } = setup({ seed: {} });
  try {
    page.onLoad();
    assert.strictEqual(page.data.accessKnown, false);
    assert.strictEqual(page.data.access, null);
  } finally {
    restoreWx();
  }
});

test('快照过期（超过 24h）或换绑（coupleId 变了）一律不复用', () => {
  const old = Date.now() - permissionCache.TTL_MS - 1000;
  const expired = setup({ seed: { [permissionCache.STORAGE_KEY]: snapshot({ savedAt: old }) } });
  try {
    expired.page.onLoad();
    assert.strictEqual(expired.page.data.accessKnown, false, '过期快照不能当成权限');
  } finally {
    restoreWx();
  }

  const rebound = setup({
    seed: { [permissionCache.STORAGE_KEY]: snapshot({ key: OPENID + '|c_previous0000001' }) },
  });
  try {
    rebound.page.onLoad();
    assert.strictEqual(rebound.page.data.accessKnown, false, '上一段关系的权限不能带到这一段');
  } finally {
    restoreWx();
  }

  const otherUser = setup({
    identity: false,
    seed: {
      [permissionCache.IDENTITY_KEY]: { openid: 'oSOMEONE_ELSE', coupleId: COUPLE },
      [permissionCache.STORAGE_KEY]: snapshot(),
    },
  });
  try {
    otherUser.page.onLoad();
    assert.strictEqual(otherUser.page.data.accessKnown, false, '换账号不能复用上一个账号的快照');
  } finally {
    restoreWx();
  }
});

test('服务端结果回写快照：approved 与 none 都要落下，下次首帧才有答案', async () => {
  const approved = setup({ seed: {}, permission: { status: 'approved', scope: 'permanent', expiresAt: null } });
  try {
    approved.page.onLoad();
    await approved.page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    const saved = approved.st.store[permissionCache.STORAGE_KEY];
    assert.ok(saved, '应写入快照');
    assert.strictEqual(saved.status, 'approved');
    assert.strictEqual(saved.scope, 'permanent');
    assert.strictEqual(saved.key, OPENID + '|' + COUPLE);
  } finally {
    restoreWx();
  }

  const none = setup({ seed: {}, permission: null });
  try {
    none.page.onLoad();
    await none.page.onSwitchWho({ currentTarget: { dataset: { who: 'partner' } } });
    const saved = none.st.store[permissionCache.STORAGE_KEY];
    assert.ok(saved, '「确知没有权限」也要落库，否则下次又要重新等一次请求');
    assert.strictEqual(saved.status, 'none');
  } finally {
    restoreWx();
  }
});

test('解绑 / 注销后清快照：permissionCache.clear() 真的把 key 删掉', () => {
  const st = storageStub({
    [permissionCache.IDENTITY_KEY]: { openid: OPENID, coupleId: COUPLE },
    [permissionCache.STORAGE_KEY]: snapshot(),
  });
  installWx({
    getStorageSync: st.getStorageSync,
    setStorageSync: st.setStorageSync,
    removeStorageSync: st.removeStorageSync,
  });
  try {
    assert.ok(permissionCache.read(), '先确认能读到');
    permissionCache.clear();
    assert.strictEqual(permissionCache.read(), null, '清掉之后不能再命中');
    assert.ok(st.store[permissionCache.IDENTITY_KEY], '身份本身不由这个模块清（utils/me 负责）');
  } finally {
    restoreWx();
  }
});

test('utils/me 拿到 user 后写入身份，供快照同步判定归属', () => {
  const st = storageStub({});
  installWx({
    getStorageSync: st.getStorageSync,
    setStorageSync: st.setStorageSync,
    removeStorageSync: st.removeStorageSync,
  });
  try {
    me.clearMe();
    const user = { openid: OPENID, coupleId: COUPLE, nickname: '小怡', avatarFileID: 'a.png' };
    // 只走「记住身份」这一条（其余靠 getMe 的请求路径，单测里不发请求）
    me.rememberIdentity(user);
    assert.deepStrictEqual(st.store[permissionCache.IDENTITY_KEY], { openid: OPENID, coupleId: COUPLE });
    assert.strictEqual(permissionCache.identityOf(), OPENID + '|' + COUPLE);
  } finally {
    restoreWx();
  }
});

test('账本 wxml：三态渲染顺序是「骨架 → 锁 → 内容」，骨架不承诺「没权限」', () => {
  const wxml = fs.readFileSync(path.join(ROOT, LEDGER_WXML), 'utf8');
  const skeleton = wxml.indexOf('正在确认权限');
  const lock = wxml.indexOf('TA 的账本是 TA 的隐私');
  assert.ok(skeleton > 0, '缺少骨架态文案');
  assert.ok(lock > skeleton, '骨架必须排在锁前面（wx:if / wx:elif 顺序就是优先级）');
  assert.ok(/wx:if="\{\{who === 'partner' && !accessKnown\}\}"/.test(wxml), '骨架条件是「partner 视角且权限未知」');
  assert.ok(/wx:elif="\{\{who === 'partner' && \(!access \|\| access\.status !== 'approved'\)\}\}"/.test(wxml),
    '锁态必须是 elif，否则骨架和锁会同屏');
  assert.ok(wxml.indexOf('申请查看') === -1 || wxml.indexOf('想看得先问一句') > 0, '锁态文案要是「先问一句」而不是「申请查看」标题');
});
