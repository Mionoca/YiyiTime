'use strict';

// 组件级单测：直接执行 9 个组件目录下的 index.js 逻辑（observers / methods / lifetimes）。
// 不渲染 WXML、不模拟样式，只锁组件对外行为：属性映射、一次性动画、事件载荷、防重。
const test = require('node:test');
const assert = require('node:assert');
const h = require('./helpers/client-page');
const constants = require('../miniprogram/utils/constants');
const timeUtil = require('../miniprogram/utils/time');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 每个用例自行安装 wx 桩；文件内共享全局 wx，按用例覆盖。
function installWx(overrides) {
  return h.installWx(Object.assign({ showToast() {}, getStorageSync: () => '', setStorageSync() {} }, overrides));
}

test('avatar-bubble：头像缺省/切换、心情气泡映射与一次性淡入、tap 载荷', async () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/avatar-bubble/index.js');
  const comp = h.instantiateComponent(config);
  assert.strictEqual(comp.data.avatar, constants.DEFAULT_AVATAR);
  assert.strictEqual(comp.data.showMood, true);
  assert.strictEqual(comp.data.size, 'md');

  comp.setProps({ user: { avatarFileID: 'cloud://env/avatars/a.png' } });
  assert.strictEqual(comp.data.avatar, 'cloud://env/avatars/a.png');
  comp.setProps({ user: null });
  assert.strictEqual(comp.data.avatar, constants.DEFAULT_AVATAR);

  const sunny = constants.MOODS[0];
  comp.setProps({ mood: { mood: sunny.key, updatedAt: '2026-11-16T06:00:00.000Z' } });
  assert.strictEqual(comp.data.moodKey, sunny.key);
  assert.strictEqual(comp.data.moodShort, sunny.label);
  assert.strictEqual(comp.data.moodIcon, sunny.emoji);
  await wait(30);
  assert.strictEqual(comp.data.pop, true, '心情变化应播一次淡入');
  await wait(500);
  assert.strictEqual(comp.data.pop, false, '淡入要在 260ms 后摘掉 class');

  // 同一个心情 + 同一个 updatedAt：静默刷新不应重复播动画
  comp.setProps({ mood: { mood: sunny.key, updatedAt: '2026-11-16T06:00:00.000Z' } });
  await wait(30);
  assert.strictEqual(comp.data.pop, false);
  // 更新时间变化视为新心情，重新播
  comp.setProps({ mood: { mood: sunny.key, updatedAt: '2026-11-16T07:00:00.000Z' } });
  await wait(30);
  assert.strictEqual(comp.data.pop, true);

  // 未知心情（脏数据）按没打卡处理
  comp.setProps({ mood: { mood: 'unknown', updatedAt: 'x' } });
  assert.strictEqual(comp.data.moodKey, '');
  assert.strictEqual(comp.data.moodShort, '');
  assert.strictEqual(comp.data.moodIcon, '');

  comp.setProps({ user: { avatarFileID: 'cloud://env/avatars/a.png' } });
  comp.onTap();
  const tap = comp.events.find((e) => e.name === 'tap');
  assert.ok(tap);
  assert.deepStrictEqual(tap.detail.user, { avatarFileID: 'cloud://env/avatars/a.png' });

  // detached 清掉未触发的定时器：先让淡入进入 pop=true（16ms 后），再 detached，等过 260ms 摘除点也不应变回 false
  comp.setProps({ mood: { mood: sunny.key, updatedAt: '2026-11-16T08:00:00.000Z' } });
  await wait(60);
  assert.strictEqual(comp.data.pop, true, 'detached 前淡入应已开始');
  comp.runLifetime('detached');
  await wait(400);
  assert.strictEqual(comp.data.pop, true, 'detached 后未触发的定时器必须被清掉，不能再改 data');
});

test('bottom-sheet：maskClosable 控制 close，内部点击不关闭', () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/bottom-sheet/index.js');
  const comp = h.instantiateComponent(config);
  assert.strictEqual(comp.data.show, false);
  assert.strictEqual(comp.data.maskClosable, true);
  comp.onMaskTap();
  assert.strictEqual(comp.events.length, 1);
  assert.strictEqual(comp.events[0].name, 'close');

  comp.setProps({ maskClosable: false });
  comp.onMaskTap();
  assert.strictEqual(comp.events.length, 1, 'maskClosable=false 时点遮罩不关闭');
  comp.onSheetTap();
  comp.noop();
  assert.strictEqual(comp.events.length, 1, '内部点击/阻止滚动不应发事件');
});

test('diary-card：今天/以前文案、锁定与解锁内容、解锁瞬间只播一次微光', async () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/diary-card/index.js');
  const comp = h.instantiateComponent(config);
  const todayKey = '2026-11-16';
  const updatedAt = new Date('2026-11-16T06:00:00.000Z');

  comp.setProps({ todayKey });
  comp.setProps({ item: { date: todayKey, mine: { content: '今天想你', updatedAt }, partnerWritten: true, partnerUnlocked: false, partner: { content: '不该出现' } } });
  assert.strictEqual(comp.data.isToday, true);
  assert.strictEqual(comp.data.dateLabel, '今天');
  assert.strictEqual(comp.data.mineText, '今天想你');
  assert.strictEqual(comp.data.mineEmptyText, '今天还没写');
  assert.strictEqual(comp.data.partnerLocked, true);
  assert.strictEqual(comp.data.partnerUnlocked, false);
  assert.strictEqual(comp.data.partnerText, '', '锁定状态不能显示对方正文');
  assert.strictEqual(comp.data.unlockedGlow, false, '首屏就锁定的卡片不播微光');

  // 同一张卡片解锁：只播一次 400ms 微光
  comp.setProps({ item: { date: todayKey, mine: null, partnerWritten: true, partnerUnlocked: true, partner: { content: '对方的日记' } } });
  assert.strictEqual(comp.data.partnerUnlocked, true);
  assert.strictEqual(comp.data.partnerText, '对方的日记');
  assert.strictEqual(comp.data.unlockedGlow, true);
  await wait(700);
  assert.strictEqual(comp.data.unlockedGlow, false, '一次性动画要摘掉 class');
  comp.setProps({ item: { date: todayKey, mine: null, partnerWritten: true, partnerUnlocked: true, partner: { content: '对方的日记' } } });
  assert.strictEqual(comp.data.unlockedGlow, false, '静默刷新不应重复播微光');

  // 历史某天没记录
  comp.setProps({ item: { date: '2026-11-12', mine: null, partnerWritten: false, partnerUnlocked: false } });
  assert.strictEqual(comp.data.isToday, false);
  assert.strictEqual(comp.data.dateLabel, timeUtil.formatMonthDay('2026-11-12'));
  assert.strictEqual(comp.data.mineEmptyText, '那天没有记录');
  assert.strictEqual(comp.data.partnerEmptyText, '那天没有记录');

  comp.runLifetime('detached');
  await wait(20);
});

test('empty-state：action 事件只发一次载荷为空对象', () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/empty-state/index.js');
  const comp = h.instantiateComponent(config);
  assert.strictEqual(comp.data.title, '');
  assert.strictEqual(comp.data.actionText, '');
  comp.setProps({ title: '还没有人报平安', actionText: '再试一次' });
  comp.onAction();
  assert.deepStrictEqual(comp.events, [{ name: 'action', detail: {} }]);
});

test('hug-banner：只展示 incoming，respond 载荷带 hugId，清空后不再发', () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/hug-banner/index.js');
  const comp = h.instantiateComponent(config);
  assert.strictEqual(comp.data.visible, false);

  comp.setProps({ incoming: { hugId: 'h_abc123' } });
  assert.strictEqual(comp.data.visible, true);
  assert.strictEqual(comp.data.hugId, 'h_abc123');
  comp.onRespond();
  assert.deepStrictEqual(comp.events, [{ name: 'respond', detail: { hugId: 'h_abc123' } }]);

  comp.setProps({ incoming: null });
  assert.strictEqual(comp.data.visible, false);
  assert.strictEqual(comp.data.hugId, '');
  comp.onRespond();
  assert.strictEqual(comp.events.length, 1, '没有 hugId 时不发 respond');

  // outgoing 属性保留但当前页不传；传了也不应影响横幅可见性
  comp.setProps({ outgoing: { hugId: 'h_out', status: 'hugged' } });
  assert.strictEqual(comp.data.visible, false);
});

test('mood-picker：show/value 同步、编辑中不被静默刷新覆盖、确认校验与载荷', () => {
  const toasts = [];
  installWx({ showToast: (opts) => toasts.push(opts) });
  const config = h.loadComponent('miniprogram/components/mood-picker/index.js');
  const comp = h.instantiateComponent(config);
  assert.strictEqual(comp.data.moods.length, constants.MOODS.length);
  assert.strictEqual(comp.data.noteMax, constants.LIMITS.moodNote);

  // 打开且带已有心情
  comp.setProps({ show: true, value: { mood: 'cloudy', note: '有点累', updatedAt: 't1' } });
  assert.strictEqual(comp.data.mood, 'cloudy');
  assert.strictEqual(comp.data.note, '有点累');

  // 用户正在改备注：页面静默刷新传相同 value 时不能覆盖草稿
  comp.onNoteInput({ detail: { value: '改到一半' } });
  comp.setProps({ show: true, value: { mood: 'cloudy', note: '有点累', updatedAt: 't1' } });
  assert.strictEqual(comp.data.note, '改到一半');
  // updatedAt 变了才用服务端值覆盖
  comp.setProps({ show: true, value: { mood: 'rainy', note: '服务端备注', updatedAt: 't2' } });
  assert.strictEqual(comp.data.mood, 'rainy');
  assert.strictEqual(comp.data.note, '服务端备注');

  // 关闭时清空内部状态，下次打开重新填充
  comp.setProps({ show: false });
  assert.strictEqual(comp.data.mood, '');
  assert.strictEqual(comp.data.note, '');
  assert.strictEqual(comp.data.noteMax, constants.LIMITS.moodNote);

  // 选心情 / 备注超长截断
  comp.onSelectMood({ currentTarget: { dataset: { key: 'thunder' } } });
  assert.strictEqual(comp.data.mood, 'thunder');
  comp.onNoteInput({ detail: { value: 'x'.repeat(constants.LIMITS.moodNote + 10) } });
  assert.strictEqual(comp.data.note.length, constants.LIMITS.moodNote);

  // 没选心情：提示且不发 select
  comp.setProps({ show: true, value: null });
  comp.onConfirm();
  assert.strictEqual(toasts.length, 1);
  assert.strictEqual(toasts[0].title, '先选一个心情吧');
  assert.strictEqual(comp.events.length, 0);

  // 正常确认：备注 trim 后带上
  comp.onSelectMood({ currentTarget: { dataset: { key: 'sunny' } } });
  comp.onNoteInput({ detail: { value: '  今天一起吃饭  ' } });
  comp.onConfirm();
  assert.deepStrictEqual(comp.events, [{ name: 'select', detail: { mood: 'sunny', note: '今天一起吃饭' } }]);

  // 请求中（saving）防双击
  comp.setProps({ saving: true });
  comp.onConfirm();
  assert.strictEqual(comp.events.length, 1);
  comp.setProps({ saving: false });
  comp.onClose();
  assert.deepStrictEqual(comp.events[1], { name: 'close', detail: {} });
});

test('privacy-guard：needAuthorization 才弹、24h 内不再打扰、同意/关闭/查看指引', async () => {
  const store = {};
  let settingCalls = 0;
  let settingResult = { needAuthorization: true };
  const toasts = [];
  installWx({
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value; },
    getPrivacySetting: (opts) => { settingCalls += 1; opts.success(settingResult); },
    showToast: (opts) => toasts.push(opts),
  });
  const config = h.loadComponent('miniprogram/components/privacy-guard/index.js');
  const comp = h.instantiateComponent(config);
  comp.runLifetime('attached');
  assert.strictEqual(settingCalls, 1);
  assert.strictEqual(comp.data.show, true);

  comp.onAgree();
  assert.strictEqual(comp.data.show, false);

  // 关闭后 24 小时内不再弹（哪怕微信仍要授权）
  const comp2 = h.instantiateComponent(config);
  comp2.runLifetime('attached');
  comp2.onClose();
  assert.strictEqual(comp2.data.show, false);
  assert.strictEqual(typeof store.privacy_prompt_skip_at, 'number');
  settingCalls = 0;
  const comp3 = h.instantiateComponent(config);
  comp3.runLifetime('attached');
  assert.strictEqual(settingCalls, 0, '24h 内不应再调 getPrivacySetting');
  assert.strictEqual(comp3.data.show, false);

  // 超过 24h 恢复询问；needAuthorization=false 时不弹
  store.privacy_prompt_skip_at = Date.now() - 25 * 60 * 60 * 1000;
  settingResult = { needAuthorization: false };
  const comp4 = h.instantiateComponent(config);
  comp4.runLifetime('attached');
  assert.strictEqual(settingCalls, 1);
  assert.strictEqual(comp4.data.show, false);

  // 没有 getPrivacySetting 的低版本基础库：交给微信原生弹窗
  installWx({ getStorageSync: () => '', setStorageSync() {} });
  const lowConfig = h.loadComponent('miniprogram/components/privacy-guard/index.js');
  const low = h.instantiateComponent(lowConfig);
  low.runLifetime('attached');
  assert.strictEqual(low.data.show, false);

  // 查看隐私协议：有 API 时调用，失败 toast；没有 API 时直接 toast
  let contractCalls = 0;
  installWx({
    getStorageSync: () => '',
    setStorageSync() {},
    showToast: (opts) => toasts.push(opts),
    openPrivacyContract: (opts) => { contractCalls += 1; opts.fail(); },
  });
  const apiConfig = h.loadComponent('miniprogram/components/privacy-guard/index.js');
  const withApi = h.instantiateComponent(apiConfig);
  withApi.onOpenContract();
  assert.strictEqual(contractCalls, 1);
  assert.ok(toasts.some((t) => t.title.indexOf('微信 - 设置 - 隐私') >= 0));

  installWx({ getStorageSync: () => '', setStorageSync() {}, showToast: (opts) => toasts.push(opts) });
  const noApiConfig = h.loadComponent('miniprogram/components/privacy-guard/index.js');
  const noApi = h.instantiateComponent(noApiConfig);
  noApi.onOpenContract();
  assert.ok(toasts.filter((t) => t.title.indexOf('微信 - 设置 - 隐私') >= 0).length >= 2);
});

test('timeline-item：自己/对方文案与头像缺省、时间用页面传的服务端 todayKey', () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/timeline-item/index.js');
  const comp = h.instantiateComponent(config);
  const now = new Date('2026-11-16T06:30:00.000Z');
  const todayKey = timeUtil.dateKeyOf(now);

  comp.setProps({ item: { openid: 'oA', createdAt: now, nickname: '', avatarFileID: '', note: '', date: todayKey }, isMine: true, todayKey });
  assert.strictEqual(comp.data.avatar, constants.DEFAULT_AVATAR);
  assert.strictEqual(comp.data.nickname, '我');
  assert.strictEqual(comp.data.emptyText, '我到家了');
  assert.strictEqual(comp.data.note, '');
  assert.ok(/今天 \d{2}:\d{2}/.test(comp.data.timeText), '今天的时间显示「今天 HH:mm」，实际：' + comp.data.timeText);

  comp.setProps({ item: { openid: 'oB', createdAt: now, nickname: '小怡', avatarFileID: 'cloud://env/a.png', note: '路上买点水果', date: todayKey }, isMine: false, todayKey });
  assert.strictEqual(comp.data.avatar, 'cloud://env/a.png');
  assert.strictEqual(comp.data.nickname, '小怡');
  assert.strictEqual(comp.data.note, '路上买点水果');
  assert.strictEqual(comp.data.emptyText, 'TA 到家了');

  // 没有服务端 todayKey 时：这条 2026-11-16 的记录不能被当成「今天」（用固定日期验证展示层只依赖传入值）
  const past = new Date('2026-11-12T02:00:00.000Z');
  comp.setProps({ item: { createdAt: past, note: '前天' }, isMine: false, todayKey: '2026-11-16' });
  assert.ok(!comp.data.timeText.startsWith('今天'), '非今天的记录不能显示「今天」：' + comp.data.timeText);

  comp.setProps({ item: null });
  assert.strictEqual(comp.data.nickname, '');
  assert.strictEqual(comp.data.timeText, '');
});

test('wish-item：首次不弹、完成→弹跳一次、事件载荷与 disabled 防重', async () => {
  installWx();
  const config = h.loadComponent('miniprogram/components/wish-item/index.js');
  const comp = h.instantiateComponent(config);
  assert.strictEqual(comp.data.done, false);

  // 首屏就是已完成：不播弹跳（文档 9.7）
  comp.setProps({ wish: { wishId: 'w1', title: '去看海', note: '夏天', done: true } });
  assert.strictEqual(comp.data.done, true);
  assert.strictEqual(comp.data.bouncing, false);

  // 未完成 → 完成：弹跳一次，320ms 后摘 class
  comp.setProps({ wish: { wishId: 'w1', title: '去看海', note: '夏天', done: false } });
  assert.strictEqual(comp.data.bouncing, false);
  comp.setProps({ wish: { wishId: 'w1', title: '去看海', note: '夏天', done: true } });
  assert.strictEqual(comp.data.bouncing, true);
  await wait(520);
  assert.strictEqual(comp.data.bouncing, false, '弹跳必须是一次性动画');

  comp.onToggle();
  comp.onEdit();
  comp.onRemove();
  assert.deepStrictEqual(comp.events.map((e) => e.name), ['toggle', 'edit', 'remove']);
  assert.deepStrictEqual(comp.events[0].detail, { wishId: 'w1', done: false });
  assert.deepStrictEqual(comp.events[1].detail, { wish: { wishId: 'w1', title: '去看海', note: '夏天', done: true } });
  assert.deepStrictEqual(comp.events[2].detail, { wishId: 'w1' });

  // disabled（有请求在飞）时不重复发
  comp.setProps({ disabled: true });
  comp.onToggle();
  comp.onEdit();
  comp.onRemove();
  assert.strictEqual(comp.events.length, 3, 'disabled 时不能再发事件');

  comp.setProps({ wish: null });
  assert.strictEqual(comp.data.done, false);
  assert.strictEqual(comp.data.title, '');
  comp.onToggle();
  assert.strictEqual(comp.events.length, 3, '没有 wish 时不发事件');

  comp.runLifetime('detached');
  await wait(20);
});