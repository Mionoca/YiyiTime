'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const COMPONENT = path.join(__dirname, '..', 'miniprogram/components/timeline-item/index.js');
const timeUtil = require('../miniprogram/utils/time');

/**
 * timeline-item 是纯展示组件：判断「今天 HH:mm」必须用页面传下来的服务端 todayKey
 * （文档 1.5 / 10.9），否则设备时钟偏一天会把昨天的时间写成「今天」。这里直接调用 observers 验证接线。
 */
function loadComponent() {
  const saved = global.Component;
  let config = null;
  global.Component = (cfg) => { config = cfg; return cfg; };
  delete require.cache[require.resolve(COMPONENT)];
  try {
    require(COMPONENT);
  } finally {
    global.Component = saved;
  }
  assert.ok(config, 'timeline-item 应调用 Component()');
  return config;
}

function instantiate(config) {
  const ctx = {
    data: Object.assign({}, config.data),
    setData(patch) { Object.assign(this.data, patch); },
  };
  ctx.observer = config.observers['item, isMine, todayKey'];
  return ctx;
}

test('timeline-item: 用页面传的服务端 todayKey 判断「今天」（文档 1.5 / 10.9）', () => {
  const config = loadComponent();
  const now = Date.now();
  const item = {
    openid: 'oA',
    nickname: '阿怡',
    avatarFileID: 'cloud://a.png',
    // item 是「现在」；页面传来的 todayKey 是「昨天」——只有真的用了传进来的值才会显示日期，
    // 退回设备时钟（也就是 now 当天）就一定显示「今天」，所以这条断言与运行日期无关。
    createdAt: new Date(now).toISOString(),
    note: '到家啦',
    checkinId: 's1',
  };
  const yesterday = timeUtil.dateKeyOf(new Date(now - 86400000));
  const expectedY = timeUtil.formatTime(item.createdAt, yesterday);
  assert.strictEqual(expectedY.includes('今天'), false, '夹具前提：昨天的时间不应显示为「今天」');

  const fromPage = instantiate(config);
  fromPage.observer.call(fromPage, item, true, yesterday);
  assert.strictEqual(fromPage.data.timeText, expectedY);
  assert.strictEqual(fromPage.data.timeText.includes('今天'), false);
  assert.strictEqual(fromPage.data.emptyText, '我到家了');

  const todayKey = timeUtil.dateKeyOf(new Date(now));
  const today = instantiate(config);
  today.observer.call(today, item, true, todayKey);
  assert.match(today.data.timeText, /^今天 \d{2}:\d{2}$/);
});

test('timeline-item: 未传 todayKey 时才退回本机日期（只影响展示）', () => {
  const config = loadComponent();
  const item = { openid: 'oB', nickname: '小怡', createdAt: '2026-11-15T10:00:00.000Z', note: '' };
  const local = instantiate(config);
  // 本机「今天」不可控，只断言格式：要么「今天 HH:mm」，要么「MM-DD HH:mm」
  local.observer.call(local, item, false, '');
  assert.match(local.data.timeText, /^(今天|\d{2}-\d{2}) \d{2}:\d{2}$/);
  assert.strictEqual(local.data.nickname, '小怡');
  assert.strictEqual(local.data.emptyText, 'TA 到家了');
  assert.strictEqual(local.data.note, '');
});

test('timeline-item: item 为空时清空展示字段', () => {
  const config = loadComponent();
  const ctx = instantiate(config);
  ctx.observer.call(ctx, null, true, '2026-11-16');
  assert.strictEqual(ctx.data.timeText, '');
  assert.strictEqual(ctx.data.nickname, '');
  assert.strictEqual(ctx.data.note, '');
  assert.strictEqual(ctx.data.emptyText, '');
  assert.ok(ctx.data.avatar.endsWith('images/avatars/default.png'), '空 item 时头像应回到默认头像');
});
