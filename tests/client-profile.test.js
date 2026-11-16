'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx, loadPage, instantiate } = require('./helpers/client-page');
const api = require('../miniprogram/utils/api');
const timeUtil = require('../miniprogram/utils/time');

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

function stubApi(home) {
  api.call = async () => home;
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
