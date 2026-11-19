'use strict';

/**
 * 文档 14.4 / 14.9 的验收对照测试（F1–F8）。
 *
 * 目的：把「双人真机验收脚本」里能自动化的服务端契约固化下来，回归时不用重新点两台手机。
 * 每个 test 对应一个 F 项，断言直接抄文档 2.5 的验收条目；不能自动化的部分在注释里写明：
 * - F1 的双人真机流程（两台手机两个微信号）：本文件覆盖绑定契约，真机流程仍需手动；
 * - F3 的场景视觉/热区：home-layout.test.js + 真机四档机型；
 * - F4 的心情气泡、F6 的门灯/时间线滚动、F7 的解锁时点、F8 的打勾动画：客户端单测 + 真机；
 * - 14.4 步骤 12 断网恢复：client-api.test.js / client-*.test.js 覆盖客户端提示，真机断网仍要手动；
 * - 14.4 步骤 13 拒绝头像授权：本文件 F1 从「只起昵称、没有头像」开始绑定，等价覆盖；
 * - 14.4 步骤 14 四档机型：home-layout.test.js + 真机。
 *
 * 服务端时间（ctx.now）在入口层取真实时钟，因此这里不硬编码「今天」，一律拿响应的 todayKey。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness } = require('./helpers/cloud-entry');
const time = require('../cloudfunctions/api/lib/time');

const h = createHarness();

const A = 'oACC_A_00000000001';
const B = 'oACC_B_00000000002';
const C = 'oACC_C_00000000003';
const D = 'oACC_D_00000000004';
const START = '2024-05-20';
const COUPLE_ID = 'c_abcdef0123456789';

async function callAs(openid, action, payload) {
  const res = await h.callAs(openid, action, payload);
  assert.strictEqual(
    res.ok,
    true,
    action + ' 应成功，实际：' + JSON.stringify({ code: res.code, message: res.message }),
  );
  return res.data;
}

/** 期望失败：返回 code 并断言 */
async function expectFail(openid, action, payload, code) {
  const res = await h.callAs(openid, action, payload);
  assert.strictEqual(res.ok, false, action + ' 应失败但成功了');
  assert.strictEqual(res.code, code, action + ' 错误码不符：' + JSON.stringify(res));
  return res;
}

function userDoc(openid, nickname, coupleId, extra) {
  const now = new Date();
  return Object.assign({
    _id: openid,
    openid,
    nickname,
    avatarFileID: openid + '.png',
    coupleId: coupleId || null,
    profileComplete: true,
    bindFailCount: 0,
    bindFailResetAt: null,
    createdAt: now,
    updatedAt: now,
  }, extra || {});
}

function coupleDoc(coupleId, startDate) {
  const now = new Date();
  return {
    _id: coupleId,
    memberOpenids: [A, B],
    startDate: startDate || START,
    startDateUpdatedBy: A,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

/** 直接种一对已绑定的情侣（省掉绑定流程，供 F2–F8 用） */
function seedBound(extra, startDate) {
  h.reset(Object.assign({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID, startDate)],
  }, extra || {}));
  return { coupleId: COUPLE_ID };
}

/** 独立于 lib/time 的「次日 00:00（东八区）」计算，避免验收断言跟随实现漂移（审查 P2-4） */
function nextUnlockISO(dateKey) {
  return new Date(Date.parse(dateKey + 'T00:00:00+08:00') + 24 * 3600 * 1000).toISOString();
}

/** 取 year 之前最近的、真实存在的同月日（闰日回退 4 年），避免 2028-02-29 造出非法日期（审查 P2-5） */
function validPastMonthDay(year, mmdd) {
  for (let back = 1; back <= 8; back += 1) {
    const key = (year - back) + '-' + mmdd;
    const ms = Date.parse(key + 'T00:00:00+08:00');
    if (Number.isFinite(ms) && time.dateKeyOf(new Date(ms)) === key) return key;
  }
  return null;
}

// ---------------------------------------------------------------- F1 绑定
test('F1 绑定：6 位码 / 预览不改状态 / 双向确认 / 同一码一次 / 自己绑自己 / 5 次限流', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => { errors.push(args); };
  try {
    h.reset({});
    // 步骤 13：B 拒绝头像授权 → 只起昵称也能绑定；A 同理（这里 A 只写昵称，不写头像）
    await callAs(A, 'user.updateProfile', { nickname: '小怡' });
    await callAs(B, 'user.updateProfile', { nickname: '阿安', avatarFileID: 'cloud://b.png' });

    // 6 位数字码 + 24 小时有效 + 开始日期来自 A 创建时填写
    const created = await callAs(A, 'bind.create', { startDate: START });
    assert.match(created.code, /^\d{6}$/, '邀请码必须是 6 位数字');
    assert.strictEqual(created.state, 'code_created');
    assert.strictEqual(created.startDate, START);
    const ttl = time.toMillis(created.expiresAt) - Date.now();
    assert.ok(ttl > 23 * 3600 * 1000 && ttl <= 24 * 3600 * 1000, '邀请码有效期 24 小时');

    // B 先看到 A 的昵称/开始日期（预览），二次确认前不能改变任何状态
    const preview = await callAs(B, 'bind.preview', { code: created.code });
    assert.deepStrictEqual(preview.creator, { nickname: '小怡', avatarFileID: '' });
    assert.strictEqual(preview.startDate, START);
    let invite = h.fake().get('bind_invites', created.code);
    assert.strictEqual(invite.status, 'open', '预览不能推进邀请状态');
    assert.strictEqual(invite.applicantOpenid, null);

    // B 申请 → A 首页显示「有人在等你」→ A 确认
    await callAs(B, 'bind.apply', { code: created.code });
    const statusA = await callAs(A, 'bind.status', {});
    assert.strictEqual(statusA.state, 'applied_by_partner');
    assert.strictEqual(statusA.pending.other.nickname, '阿安');
    const confirmed = await callAs(A, 'bind.confirm', { code: created.code });
    assert.match(confirmed.coupleId, /^c_[0-9a-f]+$/);
    assert.strictEqual(confirmed.partner.nickname, '阿安');

    // 双方写入同一 coupleId，首页都显示对方，且天数使用 A 创建时填的 startDate
    assert.strictEqual(h.fake().get('users', A).coupleId, confirmed.coupleId);
    assert.strictEqual(h.fake().get('users', B).coupleId, confirmed.coupleId);
    const homeA = await callAs(A, 'home.get', {});
    const homeB = await callAs(B, 'home.get', {});
    assert.strictEqual(homeA.bind.state, 'bound');
    assert.strictEqual(homeB.bind.state, 'bound');
    assert.strictEqual(homeA.couple.startDate, START);
    assert.strictEqual(homeA.couple.daysTogether, time.daysTogether(START, homeA.todayKey));
    assert.strictEqual(confirmed.daysTogether, homeA.couple.daysTogether, '确认接口与首页天数一致');
    assert.strictEqual(homeA.partner.nickname, '阿安');
    assert.strictEqual(homeB.partner.nickname, '小怡');
    // 拒绝头像授权的一方首页用默认头像兜底（avatarFileID 为空，客户端填 DEFAULT_AVATAR）
    assert.strictEqual(homeA.partner.avatarFileID, 'cloud://b.png');
    assert.strictEqual(homeA.user.avatarFileID, '');

    // 同一邀请码只能成功绑定一次：第三方再申请 → INVITE_USED
    await callAs(C, 'user.updateProfile', { nickname: '路人' });
    await expectFail(C, 'bind.apply', { code: created.code }, 'INVITE_USED');

    // 自己绑自己 → INVITE_SELF
    const own = await callAs(C, 'bind.create', { startDate: START });
    await expectFail(C, 'bind.preview', { code: own.code }, 'INVITE_SELF');

    // 连续输错 5 次 → 第 6 次 1 小时内禁止再试
    await callAs(D, 'user.updateProfile', { nickname: '小 D' });
    for (let i = 0; i < 5; i += 1) {
      await expectFail(D, 'bind.preview', { code: String(100000 + i) }, 'INVITE_NOT_FOUND');
    }
    const limited = await expectFail(D, 'bind.preview', { code: '654321' }, 'BIND_RATE_LIMITED');
    assert.match(limited.message, /1 小时/);
    invariantLogs(errors, [created.code, own.code]);
  } finally {
    console.error = originalError;
  }
});

/** 绑定失败日志不能带完整邀请码 / openid（6.11 脱敏） */
function invariantLogs(errors, codes) {
  const text = errors.map((args) => args.join(' ')).join('\n');
  for (const code of codes) {
    assert.strictEqual(text.includes(code), false, '日志里不应出现完整邀请码 ' + code + '：' + text);
  }
  for (const openid of [A, B, C, D]) {
    assert.strictEqual(text.includes(openid), false, '日志里不应出现完整 openid：' + text);
  }
}

// ---------------------------------------------------------------- F2 天数 / 纪念日
test('F2 天数与纪念日：第 1 天 / 跨年 +1 / 纪念日就是今天 / 改开始日期双方同步 / 客户端日期不参与', async () => {
  // 文档 14.9：边界用单元测试锁定（真机部分靠 F3/F4 的首页展示）
  assert.strictEqual(time.daysTogether('2026-11-17', '2026-11-17'), 1, '开始当天是第 1 天');
  assert.strictEqual(time.daysTogether('2026-12-31', '2027-01-01'), 2, '跨年只 +1 天');
  assert.strictEqual(time.addDays('2024-02-28', 1), '2024-02-29', '闰年 2 月');
  assert.strictEqual(time.daysTogether('2024-02-28', '2024-03-01'), 3);

  seedBound();
  const home = await callAs(A, 'home.get', {});
  // 服务端 todayKey 是合法日期，且天数与它对得上；与手机本地日期无关（客户端只展示）。
  // 不直接和 time.dateKeyOf(new Date()) 比较：跨午夜执行时那会因时钟推进偶发变红（审查 P3-5）
  assert.match(home.todayKey, /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(time.isValidDateKey(home.todayKey), true, 'todayKey 必须是真实存在的日期');
  assert.strictEqual(home.couple.daysTogether, time.daysTogether(START, home.todayKey));
  assert.strictEqual(home.couple.anniversary.date >= home.todayKey, true);
  assert.strictEqual(
    home.couple.anniversary.daysLeft,
    Math.round((time.startOfDateKey(home.couple.anniversary.date) - time.startOfDateKey(home.todayKey)) / (24 * 3600 * 1000)),
  );

  // 纪念日就是今天（开始日期的月日 = 今天月日，但年份不同 → 今年这天是纪念日）
  const ty = Number(home.todayKey.slice(0, 4));
  const mmdd = home.todayKey.slice(5);
  const anniversaryToday = validPastMonthDay(ty, mmdd);
  assert.ok(anniversaryToday, '构造出合法的「同月日、往年」开始日期');
  seedBound({}, anniversaryToday);
  const home2 = await callAs(A, 'home.get', {});
  assert.strictEqual(home2.couple.anniversary.daysLeft, 0, '当天为纪念日时剩余 0 天');
  assert.strictEqual(home2.couple.anniversary.date, home2.todayKey);

  // 双方都能改开始日期，改后双方看到同一天数；非法日期拒绝
  const updated = await callAs(B, 'couple.updateStartDate', { startDate: '2024-06-01' });
  assert.strictEqual(updated.startDate, '2024-06-01');
  const homeA3 = await callAs(A, 'home.get', {});
  const homeB3 = await callAs(B, 'home.get', {});
  assert.strictEqual(homeA3.couple.startDate, '2024-06-01');
  assert.strictEqual(homeB3.couple.startDate, '2024-06-01');
  assert.strictEqual(homeA3.couple.daysTogether, homeB3.couple.daysTogether);
  for (const bad of ['2999-01-01', '2024-13-01', '2024-06-1', '2024-06-01 ', '', null, 20240601]) {
    const res = await h.callAs(A, 'couple.updateStartDate', { startDate: bad });
    assert.strictEqual(res.ok, false, '非法开始日期应拒绝：' + JSON.stringify(bad));
    assert.strictEqual(res.code, 'START_DATE_INVALID', JSON.stringify(bad) + ' → ' + res.code);
  }

  // 客户端传的 date/today 一律被忽略：mood.set 的 date 只看服务端
  const mood = await callAs(A, 'mood.set', { mood: 'sunny', date: '1999-01-01', todayKey: '1999-01-01' });
  assert.strictEqual(mood.mood.date, homeA3.todayKey);
});

// ---------------------------------------------------------------- F3 首页三状态
test('F3 场景化首页三状态：未绑定空房 / 邀请中 / 已绑定聚合', async () => {
  h.reset({});
  await callAs(A, 'user.updateProfile', { nickname: '小怡' });

  // 未绑定：空房间，五个双人区块全 null，不能进入双人功能（服务端 requireBound）
  const unbound = await callAs(A, 'home.get', {});
  assert.strictEqual(unbound.bind.state, 'unbound');
  assert.strictEqual(unbound.bind.pending, null);
  assert.deepStrictEqual(unbound.couple, null);
  assert.deepStrictEqual(unbound.partner, null);
  for (const key of ['mood', 'anniversary', 'safety', 'diary', 'wish']) {
    assert.strictEqual(unbound[key], null, '未绑定 ' + key + ' 必须为 null');
  }
  assert.deepStrictEqual(Object.keys(unbound.user).sort(), ['avatarFileID', 'nickname', 'openid', 'profileComplete']);
  await expectFail(A, 'diary.save', { content: '还没绑定就写日记' }, 'NOT_BOUND');
  await expectFail(A, 'wish.add', { title: '还没绑定' }, 'NOT_BOUND');

  // 邀请中：A 生成码 → A 首页 code_created；B 申请后 A 首页 applied_by_partner，B applied_by_me
  const created = await callAs(A, 'bind.create', { startDate: START });
  const pendingA = await callAs(A, 'home.get', {});
  assert.strictEqual(pendingA.bind.state, 'code_created');
  assert.strictEqual(pendingA.bind.pending.code, created.code);
  assert.strictEqual(pendingA.bind.pending.other, null);
  assert.strictEqual(pendingA.couple, null);

  await callAs(B, 'user.updateProfile', { nickname: '阿安' });
  await callAs(B, 'bind.apply', { code: created.code });
  const pendingA2 = await callAs(A, 'home.get', {});
  assert.strictEqual(pendingA2.bind.state, 'applied_by_partner');
  assert.strictEqual(pendingA2.bind.pending.other.nickname, '阿安');
  const pendingB = await callAs(B, 'home.get', {});
  assert.strictEqual(pendingB.bind.state, 'applied_by_me');
  assert.strictEqual(pendingB.bind.pending.other.nickname, '小怡');

  // 已绑定：双方头像/昵称、天数、纪念日、五个区块对象都在（空数据是空对象不是 null）
  await callAs(A, 'bind.confirm', { code: created.code });
  const boundA = await callAs(A, 'home.get', {});
  const boundB = await callAs(B, 'home.get', {});
  assert.strictEqual(boundA.bind.state, 'bound');
  assert.strictEqual(boundB.bind.state, 'bound');
  assert.strictEqual(boundA.partner.nickname, '阿安');
  assert.strictEqual(boundB.partner.nickname, '小怡');
  assert.strictEqual(boundA.user.openid, A);
  assert.strictEqual(boundA.couple.daysTogether, time.daysTogether(START, boundA.todayKey));
  assert.ok(boundA.couple.anniversary && boundA.couple.anniversary.date);
  for (const key of ['mood', 'anniversary', 'safety', 'diary', 'wish']) {
    assert.notStrictEqual(boundA[key], null, '已绑定 ' + key + ' 应为聚合对象');
  }
  assert.deepStrictEqual(boundA.mood, { mine: null, partner: null });
  assert.deepStrictEqual(boundA.anniversary, { items: [] });
  assert.deepStrictEqual(boundA.safety, { mineToday: false, partnerToday: false, partnerLastAt: null });
  assert.deepStrictEqual(boundA.wish, { total: 0, done: 0, previewTitle: null });
  assert.deepStrictEqual(boundA.diary, {
    mineWritten: false,
    partnerWritten: false,
    partnerUnlocked: false,
    unlockAt: nextUnlockISO(boundA.todayKey),
  });

  // 14.4 步骤 11：关闭再打开（重新请求）状态保持
  const reopened = await callAs(A, 'home.get', {});
  assert.strictEqual(reopened.bind.state, 'bound');
  assert.strictEqual(reopened.couple.coupleId, boundA.couple.coupleId);
  assert.strictEqual(reopened.partner.nickname, boundA.partner.nickname);
});

// ---------------------------------------------------------------- F4 心情
test('F4 心情打卡：四态 / 每天一条（重复是更新）/ 备注 50 字 / 对方今日可见 / 跨天不显示昨天', async () => {
  seedBound();
  const home0 = await callAs(A, 'home.get', {});
  const todayKey = home0.todayKey;

  const first = await callAs(A, 'mood.set', { mood: 'sunny', note: '有点想你' });
  assert.deepStrictEqual(
    { mood: first.mood.mood, note: first.mood.note, date: first.mood.date },
    { mood: 'sunny', note: '有点想你', date: todayKey },
  );
  // 再次选择是更新，不新增（moods 里同一人同一天只有一条）
  const second = await callAs(A, 'mood.set', { mood: 'rainy', note: '今天有点累' });
  assert.strictEqual(second.mood.mood, 'rainy');
  const mineDocs = h.fake().all('moods').filter((doc) => doc._id === A + '_' + todayKey);
  assert.strictEqual(mineDocs.length, 1, '同一人同一天只能有一条心情');

  // 四态合法，未知心情拒绝；备注 ≤50 字
  for (const mood of ['sunny', 'cloudy', 'rainy', 'thunder']) {
    const res = await callAs(B, 'mood.set', { mood });
    assert.strictEqual(res.mood.mood, mood);
  }
  await expectFail(B, 'mood.set', { mood: 'foggy' }, 'INVALID_INPUT');
  const note50 = '字'.repeat(50);
  await callAs(B, 'mood.set', { mood: 'cloudy', note: note50 });
  await expectFail(B, 'mood.set', { mood: 'cloudy', note: '字'.repeat(51) }, 'TEXT_TOO_LONG');

  // 对方今日心情可见；自己未打卡时 mine 为 null
  const homeB = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB.mood.partner.mood, 'rainy');
  assert.strictEqual(homeB.mood.partner.note, '今天有点累');
  assert.strictEqual(homeB.mood.mine.mood, 'cloudy');
  const homeA = await callAs(A, 'home.get', {});
  assert.strictEqual(homeA.mood.mine.mood, 'rainy');
  assert.strictEqual(homeA.mood.partner.mood, 'cloudy');

  // 心情记录（文档 7.6 mood.list / 14.9 F4）：当天两人合并成一条，备注双方可见
  const history = await callAs(A, 'mood.list', {});
  assert.strictEqual(history.todayKey, todayKey);
  assert.strictEqual(history.days.length, 1);
  assert.strictEqual(history.days[0].date, todayKey);
  assert.strictEqual(history.days[0].mine.mood, 'rainy');
  assert.strictEqual(history.days[0].mine.note, '今天有点累');
  assert.strictEqual(history.days[0].partner.mood, 'cloudy');
  assert.strictEqual(history.days[0].partner.note, note50);
  assert.strictEqual(history.nextBeforeDate, null);

  // 跨天：昨天的心情不算今天（首页只给今天），但心情记录里能看到历史
  const yesterday = time.addDays(todayKey, -1);
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
  // 两个人昨天都打过卡，今天仍然都是 null：证明跨天时不会把昨天的数据当今天（审查 P3-3）
  seedBound({
    moods: [
      {
        _id: A + '_' + yesterday,
        coupleId: COUPLE_ID,
        openid: A,
        date: yesterday,
        mood: 'sunny',
        note: '昨天的',
        createdAt: dayAgo,
        updatedAt: dayAgo,
      },
      {
        _id: B + '_' + yesterday,
        coupleId: COUPLE_ID,
        openid: B,
        date: yesterday,
        mood: 'thunder',
        note: 'TA 昨天的',
        createdAt: dayAgo,
        updatedAt: dayAgo,
      },
    ],
  });
  const homeCross = await callAs(A, 'home.get', {});
  assert.strictEqual(homeCross.mood.mine, null, '昨天的心情不能显示成今天');
  assert.strictEqual(homeCross.mood.partner, null);

  // 首页跨天不带旧数据，但心情记录按天保留：这里用种库模拟「昨天写过、今天没写」，
  // 只证明列表不只返回今天；「今天记录次日变历史」由 _id=openid_date 与按 date 查询保证
  const crossHistory = await callAs(A, 'mood.list', {});
  assert.strictEqual(crossHistory.days.length, 1);
  assert.strictEqual(crossHistory.days[0].date, yesterday);
  assert.strictEqual(crossHistory.days[0].mine.note, '昨天的');
  assert.strictEqual(crossHistory.days[0].partner.note, 'TA 昨天的');
  assert.strictEqual(crossHistory.nextBeforeDate, null);
});

// ---------------------------------------------------------------- F2 自定义纪念日
test('F2 纪念日：添加 / 双方可见 / 修改同步 / 上限 8 条 / 删除 / 未来日期与 2-29', async () => {
  seedBound();
  const todayKey = time.dateKeyOf(new Date());

  // 添加：落库字段干净（不存 nextDate / daysLeft），返回排好序的完整列表
  const first = await callAs(A, 'anniversary.add', { title: '第一次见面', date: '2023-06-01' });
  assert.strictEqual(first.items.length, 1);
  assert.strictEqual(first.item.date, '2023-06-01');
  const stored = h.fake().get('anniversaries', first.item.anniversaryId);
  assert.strictEqual(stored.coupleId, COUPLE_ID);
  assert.strictEqual(stored.nextDate, undefined, '剩余天数每天都会变，不能落库');
  assert.strictEqual(stored.daysLeft, undefined);

  // 双方可见：B 的首页与列表都能读到
  const homeB = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB.anniversary.items.length, 1);
  assert.strictEqual(homeB.anniversary.items[0].title, '第一次见面');
  const listB = await callAs(B, 'anniversary.list', {});
  assert.strictEqual(listB.todayKey, todayKey);

  // 修改：B 改标题，A 立刻读到新标题（两个人共同的纪念日）
  await callAs(B, 'anniversary.update', { anniversaryId: first.item.anniversaryId, title: '初见' });
  assert.strictEqual((await callAs(A, 'home.get', {})).anniversary.items[0].title, '初见');

  // 未来日期允许：第一次发生还没到，years 为 0
  const future = await callAs(A, 'anniversary.add', { title: '婚礼', date: '2099-12-31' });
  const futureItem = future.items.find((item) => item.title === '婚礼');
  assert.strictEqual(futureItem.date, '2099-12-31');
  assert.strictEqual(futureItem.years, 0);

  // 上限 8 条：补到 8 条后第 9 条被拒
  let count = future.items.length;
  let i = 0;
  while (count < 8) {
    const res = await callAs(A, 'anniversary.add', {
      title: '纪念日' + i,
      date: '2020-' + String((i % 9) + 1).padStart(2, '0') + '-01',
    });
    count = res.items.length;
    i += 1;
  }
  await expectFail(A, 'anniversary.add', { title: '第九个', date: '2023-06-01' }, 'ANNIVERSARY_LIMIT_REACHED');

  // 删除：物理删除，幂等
  const removed = await callAs(A, 'anniversary.remove', { anniversaryId: first.item.anniversaryId });
  assert.strictEqual(removed.removed, true);
  assert.strictEqual(removed.items.length, 7);
  const removedAgain = await callAs(A, 'anniversary.remove', { anniversaryId: first.item.anniversaryId });
  assert.strictEqual(removedAgain.removed, false);

  // 非法输入：标题超 12 字 / 日期越界
  await expectFail(A, 'anniversary.update', {
    anniversaryId: futureItem.anniversaryId, title: '一二三四五六七八九十一二三',
  }, 'TEXT_TOO_LONG');
  await expectFail(A, 'anniversary.update', {
    anniversaryId: futureItem.anniversaryId, date: '2100-01-01',
  }, 'INVALID_INPUT');
});

// ---------------------------------------------------------------- F6 报平安
test('F6 报平安：一键 / 10 分钟去重 / 双方今日状态 / 时间线倒序分页 / 50 字备注', async () => {
  seedBound();
  const home0 = await callAs(A, 'home.get', {});
  const todayKey = home0.todayKey;
  const yesterdayKey = time.addDays(todayKey, -1);
  const now = Date.now();

  const checkin = await callAs(A, 'safety.checkin', { note: '到家啦' });
  assert.strictEqual(checkin.deduped, false);
  assert.strictEqual(checkin.entry.date, todayKey);
  assert.strictEqual(checkin.entry.note, '到家啦');
  const dup = await callAs(A, 'safety.checkin', { note: '又点一次' });
  assert.strictEqual(dup.deduped, true, '10 分钟内重复点击不新增');
  assert.strictEqual(dup.entry.checkinId, checkin.entry.checkinId);
  assert.strictEqual(h.fake().all('safety_checkins').length, 1);
  assert.strictEqual(dup.entry.createdAt, checkin.entry.createdAt, '去重不能改创建时间');

  // 去重窗口是 10 分钟：9 分钟前同一天算重复且不覆盖原备注，满 10 分钟就算新记录（审查 P2-3）
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    safety_checkins: [{
      _id: 's_9min', coupleId: COUPLE_ID, openid: A, note: '九分钟前', date: todayKey,
      createdAt: new Date(now - 9 * 60 * 1000),
    }],
  });
  const nine = await callAs(A, 'safety.checkin', { note: '又点一次' });
  assert.strictEqual(nine.deduped, true, '9 分钟前同一天算重复');
  assert.strictEqual(nine.entry.checkinId, 's_9min');
  assert.strictEqual(nine.entry.note, '九分钟前', '去重不能覆盖原记录备注');
  assert.strictEqual(h.fake().all('safety_checkins').length, 1);

  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    safety_checkins: [{
      _id: 's_10min', coupleId: COUPLE_ID, openid: A, note: '十分钟前', date: todayKey,
      createdAt: new Date(now - 10 * 60 * 1000),
    }],
  });
  const ten = await callAs(A, 'safety.checkin', { note: '十分钟后' });
  assert.strictEqual(ten.deduped, false, '满 10 分钟算新记录（窗口是严格小于）');
  assert.strictEqual(ten.entry.date, todayKey);
  assert.strictEqual(h.fake().all('safety_checkins').length, 2);

  // 跨天边界：23:58 报过、次日 00:02 再点应算新的一天。
  // safety.js 的 last.date === todayKey 分支是全仓库唯一入口（审查 P1-1：删掉它其余用例全绿）
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    safety_checkins: [{
      _id: 's_before_midnight', coupleId: COUPLE_ID, openid: A, note: '昨天睡前', date: yesterdayKey,
      createdAt: new Date(now - 2 * 60 * 1000),
    }],
  });
  const crossDay = await callAs(A, 'safety.checkin', { note: '零点后' });
  assert.strictEqual(crossDay.deduped, false, '跨天即使 2 分钟前报过也不去重');
  assert.strictEqual(crossDay.entry.date, todayKey);
  assert.notStrictEqual(crossDay.entry.checkinId, 's_before_midnight');
  assert.strictEqual(crossDay.entry.note, '零点后', '新一天要写新备注');
  assert.strictEqual(h.fake().all('safety_checkins').length, 2);

  // 对照：昨天 11 分钟前（窗口外）同样不参与今天的去重
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    safety_checkins: [{
      _id: 's_yesterday_old', coupleId: COUPLE_ID, openid: A, note: '昨天', date: yesterdayKey,
      createdAt: new Date(now - 11 * 60 * 1000),
    }],
  });
  const crossDayOld = await callAs(A, 'safety.checkin', { note: '今天第一次' });
  assert.strictEqual(crossDayOld.deduped, false);

  await expectFail(A, 'safety.checkin', { note: '字'.repeat(51) }, 'TEXT_TOO_LONG');
  await callAs(B, 'safety.checkin', { note: '字'.repeat(50) });

  // 首页双方今日状态
  const homeA = await callAs(A, 'home.get', {});
  assert.strictEqual(homeA.safety.mineToday, true);
  assert.strictEqual(homeA.safety.partnerToday, true);
  assert.strictEqual(homeA.safety.partnerLastAt, h.fake().all('safety_checkins').find((d) => d.openid === B).createdAt.toISOString());

  // 时间线：双方混排、时间倒序、分页不重不漏
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    safety_checkins: [
      { _id: 's1', coupleId: COUPLE_ID, openid: A, note: '1', date: todayKey, createdAt: new Date(now - 5000) },
      { _id: 's2', coupleId: COUPLE_ID, openid: B, note: '2', date: todayKey, createdAt: new Date(now - 4000) },
      { _id: 's3', coupleId: COUPLE_ID, openid: A, note: '3', date: todayKey, createdAt: new Date(now - 3000) },
      { _id: 's4', coupleId: COUPLE_ID, openid: B, note: '4', date: todayKey, createdAt: new Date(now - 2000) },
      { _id: 's5', coupleId: COUPLE_ID, openid: A, note: '5', date: todayKey, createdAt: new Date(now - 1000) },
    ],
  });
  const page1 = await callAs(A, 'safety.list', { limit: 2 });
  assert.deepStrictEqual(page1.items.map((item) => item.nickname), ['小怡', '阿安']);
  assert.deepStrictEqual(page1.items.map((item) => item.note), ['5', '4']);
  assert.ok(page1.nextCursor);
  const page2 = await callAs(A, 'safety.list', { limit: 2, cursor: page1.nextCursor });
  assert.deepStrictEqual(page2.items.map((item) => item.note), ['3', '2']);
  const page3 = await callAs(A, 'safety.list', { limit: 2, cursor: page2.nextCursor });
  assert.deepStrictEqual(page3.items.map((item) => item.note), ['1']);
  assert.strictEqual(page3.nextCursor, null);
  const seen = new Set(page1.items.concat(page2.items, page3.items).map((item) => item.checkinId));
  assert.strictEqual(seen.size, 5, '分页不重不漏');
  assert.ok(page1.items[0].nickname && page1.items[0].nickname.length > 0, '时间线带昵称');

  // 昨天报的平安不算今天；对方未报时 partnerLastAt 是最近一次时间
  const yesterday = time.addDays(todayKey, -1);
  const old = new Date(now - 24 * 3600 * 1000);
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    safety_checkins: [{ _id: 's_old', coupleId: COUPLE_ID, openid: B, note: '', date: yesterday, createdAt: old }],
  });
  const homeOld = await callAs(A, 'home.get', {});
  assert.strictEqual(homeOld.safety.mineToday, false);
  assert.strictEqual(homeOld.safety.partnerToday, false);
  assert.strictEqual(homeOld.safety.partnerLastAt, old.toISOString());
});

// ---------------------------------------------------------------- F7 日记（M13 手帐）
test('F7 手帐日记：默认私密 / 逐篇分享 / 三档解锁 / 500 字 / 日历与年度归档', async () => {
  seedBound();
  const home0 = await callAs(A, 'home.get', {});
  const todayKey = home0.todayKey;
  // 独立计算「次日 00:00（东八区）」，不调用 time.nextUnlockAt（审查 P2-4：避免断言跟随实现漂移）
  const unlockISO = nextUnlockISO(todayKey);

  await expectFail(A, 'diary.save', { content: '' }, 'DIARY_EMPTY');
  const saved = await callAs(A, 'diary.save', { content: '今天路过面包店' });
  assert.strictEqual(saved.diary.date, todayKey);
  assert.strictEqual(saved.diary.unlockAt, unlockISO);
  assert.strictEqual(saved.diary.visibility, 'private', '默认只能是私密');
  assert.strictEqual(saved.diary.moodScore, null);
  assert.deepStrictEqual(saved.diary.images, []);
  assert.strictEqual((await callAs(A, 'diary.save', { content: '字'.repeat(500) })).diary.content.length, 500);
  await expectFail(A, 'diary.save', { content: '字'.repeat(501) }, 'TEXT_TOO_LONG');
  await expectFail(A, 'diary.save', { content: '心情越界', moodScore: 6 }, 'INVALID_INPUT');
  await expectFail(A, 'diary.save', {
    content: '配图太多',
    images: ['cloud://a/1.jpg', 'cloud://a/2.jpg', 'cloud://a/3.jpg', 'cloud://a/4.jpg'],
  }, 'DIARY_IMAGE_LIMIT');

  // 当天可修改：同一人同一天只有一条
  const edited = await callAs(A, 'diary.save', { content: '改一下：路过面包店' });
  assert.strictEqual(edited.diary.content, '改一下：路过面包店');
  assert.strictEqual(h.fake().all('diaries').filter((doc) => doc.authorOpenid === A).length, 1);

  // 私密是红线：B 侧与「A 那天没写」完全不可区分（没有 partnerWritten、没有 unlockAt 泄露）
  await callAs(B, 'diary.save', { content: '我也是' });
  const listB = await callAs(B, 'diary.list', {});
  assert.strictEqual(listB.items[0].date, todayKey);
  assert.strictEqual(listB.items[0].partnerWritten, false, '私密日记在对方侧等于不存在');
  assert.strictEqual(listB.items[0].partnerUnlocked, false);
  assert.strictEqual(listB.items[0].partner, null);
  assert.strictEqual(listB.items[0].mine.content, '我也是');
  assert.strictEqual(listB.todayKey, todayKey);
  const homeB = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB.diary.partnerWritten, false, '首页摘要也不能透露私密日记');

  // day 档（默认）：对方当天只看到「写了」，次日 00:00 解锁
  const dayShared = await callAs(A, 'diary.save', { content: '明天见', visibility: 'partner' });
  assert.strictEqual(dayShared.diary.unlockAt, unlockISO);
  assert.ok(dayShared.diary.sharedAt, '首次分享要记 sharedAt');
  const lockedB = await callAs(B, 'diary.list', {});
  assert.strictEqual(lockedB.items[0].partnerWritten, true);
  assert.strictEqual(lockedB.items[0].partnerUnlocked, false);
  assert.strictEqual(lockedB.items[0].partner, null, '未解锁时绝不能下发对方正文');

  // 改成「立即」：对方马上能读到正文 + 分值 + 配图
  const shared = await callAs(A, 'diary.save', {
    content: '今天的海很好看',
    moodScore: 5,
    images: ['cloud://diary/c_abcdef0123456789/2026-11-16/1.jpg'],
    visibility: 'partner',
    unlockMode: 'immediate',
  });
  assert.strictEqual(shared.diary.visibility, 'partner');
  const sharedB = await callAs(B, 'diary.list', {});
  assert.strictEqual(sharedB.items[0].partnerWritten, true);
  assert.strictEqual(sharedB.items[0].partnerUnlocked, true);
  assert.strictEqual(sharedB.items[0].partner.content, '今天的海很好看');
  assert.strictEqual(sharedB.items[0].partner.moodScore, 5);
  assert.deepStrictEqual(sharedB.items[0].partner.images, ['cloud://diary/c_abcdef0123456789/2026-11-16/1.jpg']);

  // 次日 00:00 后对方可见（14.5 的 dev 手法：把 unlockAt 改成过去 → 重新拉列表）
  const yesterday = time.addDays(todayKey, -1);
  const past = new Date(Date.now() - 24 * 3600 * 1000);

  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    diaries: [
      {
        _id: B + '_' + yesterday, coupleId: COUPLE_ID, authorOpenid: B, date: yesterday,
        content: '昨天 TA 写的', moodScore: null, images: [], visibility: 'private', unlockMode: 'day',
        unlockAt: past, sharedAt: null, createdAt: past, updatedAt: past,
      },
      {
        _id: A + '_' + yesterday, coupleId: COUPLE_ID, authorOpenid: A, date: yesterday,
        content: '昨天我写的', moodScore: 3, images: [], visibility: 'partner', unlockMode: 'day',
        unlockAt: past, sharedAt: past, createdAt: past, updatedAt: past,
      },
    ],
  });
  const unlocked = await callAs(B, 'diary.list', {});
  assert.strictEqual(unlocked.items[0].partnerUnlocked, true);
  assert.strictEqual(unlocked.items[0].partner.content, '昨天我写的');
  assert.strictEqual(unlocked.items[0].partner.moodScore, 3);

  // 已解锁的旧日记不能再改（14.9 / 7.10 DIARY_LOCKED），改可见性也拦
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    diaries: [{
      _id: A + '_' + todayKey, coupleId: COUPLE_ID, authorOpenid: A, date: todayKey,
      content: '今天写的', moodScore: 4, images: [], visibility: 'private', unlockMode: 'day',
      unlockAt: past, sharedAt: null, createdAt: past, updatedAt: past,
    }],
  });
  await expectFail(A, 'diary.save', { content: '想改已经解锁的' }, 'DIARY_LOCKED');
  await expectFail(A, 'diary.save', { content: '想改已经解锁的', visibility: 'partner' }, 'DIARY_LOCKED');

  // 月度心情日历：只统计自己的分值；同日有记录但没填分值 → score=null
  const month = todayKey.slice(0, 7);
  const dayOne = month + '-01';
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    diaries: [
      {
        _id: A + '_' + dayOne, coupleId: COUPLE_ID, authorOpenid: A, date: dayOne,
        content: '一号', moodScore: 2, images: [], visibility: 'private', unlockMode: 'day',
        unlockAt: past, sharedAt: null, createdAt: past, updatedAt: past,
      },
      {
        _id: A + '_' + todayKey, coupleId: COUPLE_ID, authorOpenid: A, date: todayKey,
        content: '今天', moodScore: 4, images: [], visibility: 'partner', unlockMode: 'day',
        unlockAt: past, sharedAt: past, createdAt: past, updatedAt: past,
      },
      {
        _id: B + '_' + dayOne, coupleId: COUPLE_ID, authorOpenid: B, date: dayOne,
        content: 'TA 的', moodScore: 1, images: [], visibility: 'partner', unlockMode: 'day',
        unlockAt: past, sharedAt: past, createdAt: past, updatedAt: past,
      },
    ],
  });
  const calendar = await callAs(A, 'diary.calendar', { month });
  assert.strictEqual(calendar.month, month);
  assert.strictEqual(calendar.todayKey, todayKey);
  assert.ok(calendar.days.length >= 28 && calendar.days.length <= 31, '日历覆盖当月每一天');
  assert.strictEqual(calendar.days[0].score, 2);
  assert.strictEqual(calendar.days[0].hasDiary, true);
  assert.strictEqual(calendar.days[0].shared, false);
  assert.deepStrictEqual(calendar.stats.best, { date: todayKey, score: 4 });
  assert.deepStrictEqual(calendar.stats.lowest, { date: dayOne, score: 2 }, '对方的分值绝不进日历');
  assert.strictEqual(calendar.stats.recorded, 2);
  assert.strictEqual(calendar.stats.average, 3);

  const archive = await callAs(A, 'diary.archive', { year: Number(todayKey.slice(0, 4)) });
  assert.deepStrictEqual(archive.items.map((item) => item.date), [dayOne, todayKey], '归档按日期升序');
  assert.strictEqual(archive.count, 2, '只含自己的日记');
  assert.strictEqual(archive.truncated, false);

  // 列表按日期倒序、分页加载
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    diaries: [
      { _id: A + '_' + todayKey, coupleId: COUPLE_ID, authorOpenid: A, date: todayKey, content: '今天', unlockAt: new Date(Date.now() + 3600 * 1000), createdAt: new Date(), updatedAt: new Date() },
      { _id: A + '_' + yesterday, coupleId: COUPLE_ID, authorOpenid: A, date: yesterday, content: '昨天', unlockAt: past, createdAt: past, updatedAt: past },
      { _id: A + '_' + time.addDays(todayKey, -2), coupleId: COUPLE_ID, authorOpenid: A, date: time.addDays(todayKey, -2), content: '前天', unlockAt: past, createdAt: past, updatedAt: past },
    ],
  });
  const d1 = await callAs(A, 'diary.list', { limit: 2 });
  assert.deepStrictEqual(d1.items.map((item) => item.date), [todayKey, yesterday]);
  assert.ok(d1.nextBeforeDate);
  const d2 = await callAs(A, 'diary.list', { limit: 2, beforeDate: d1.nextBeforeDate });
  assert.deepStrictEqual(d2.items.map((item) => item.date), [time.addDays(todayKey, -2)]);
  assert.strictEqual(d2.nextBeforeDate, null);
});

// ---------------------------------------------------------------- F8 愿望
test('F8 愿望清单：双方增删改 / 打勾与取消 / 进度统计 / 标题 30 字 / 最多 100 条 / 删除幂等', async () => {
  seedBound();
  await expectFail(A, 'wish.add', { title: '' }, 'INVALID_INPUT');
  const added = await callAs(A, 'wish.add', { title: '一起去看海', note: '夏天' });
  assert.strictEqual(added.wish.title, '一起去看海');
  assert.strictEqual(added.wish.createdBy, A);
  assert.deepStrictEqual(added.stats, { total: 1, done: 0 });
  await expectFail(A, 'wish.add', { title: '字'.repeat(31) }, 'TEXT_TOO_LONG');
  await callAs(A, 'wish.add', { title: '字'.repeat(30) });
  await callAs(A, 'wish.add', { title: '备注', note: '字'.repeat(100) });
  await expectFail(A, 'wish.add', { title: '备注超长', note: '字'.repeat(101) }, 'TEXT_TOO_LONG');

  // 双方都能改、能打勾/取消，统计实时变化；同一愿望重复打勾保留首次完成信息
  const wishId = added.wish.wishId;
  const updated = await callAs(B, 'wish.update', { wishId, title: '一起去看海（夏天）' });
  assert.strictEqual(updated.wish.title, '一起去看海（夏天）');
  const done = await callAs(B, 'wish.setDone', { wishId, done: true });
  assert.strictEqual(done.wish.done, true);
  assert.strictEqual(done.wish.doneBy, B);
  assert.deepStrictEqual(done.stats, { total: 3, done: 1 });
  const doneAgain = await callAs(A, 'wish.setDone', { wishId, done: true });
  assert.strictEqual(doneAgain.wish.doneBy, B, '重复打勾保留首次 doneBy');
  const undone = await callAs(A, 'wish.setDone', { wishId, done: false });
  assert.strictEqual(undone.wish.done, false);
  assert.strictEqual(undone.wish.doneBy, null);
  assert.deepStrictEqual(undone.stats, { total: 3, done: 0 });

  const list = await callAs(A, 'wish.list', {});
  assert.deepStrictEqual(list.stats, { total: 3, done: 0 });
  const home = await callAs(A, 'home.get', {});
  assert.strictEqual(home.wish.total, 3);
  assert.strictEqual(home.wish.done, 0);
  assert.strictEqual(home.wish.previewTitle, '一起去看海（夏天）');

  // 删除（客户端二次确认）→ 不可恢复；再删一次返回 removed:false，不报错
  const removed = await callAs(B, 'wish.remove', { wishId });
  assert.strictEqual(removed.removed, true);
  assert.deepStrictEqual(removed.stats, { total: 2, done: 0 });
  const removedAgain = await callAs(B, 'wish.remove', { wishId });
  assert.strictEqual(removedAgain.removed, false);
  await expectFail(C, 'wish.remove', { wishId: 'not-exist' }, 'NOT_BOUND');

  // 上限 100 条：种 99 条再新增 1 条成功，第 101 条拒绝
  const wishes = [];
  for (let i = 0; i < 99; i += 1) {
    const past = new Date(Date.now() - (100 - i) * 60000);
    wishes.push({
      _id: 'w_seed_' + String(i).padStart(4, '0'),
      coupleId: COUPLE_ID,
      title: '愿望 ' + i,
      note: '',
      createdBy: A,
      done: false,
      doneBy: null,
      doneAt: null,
      createdAt: past,
      updatedAt: past,
    });
  }
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    wishes,
  });
  const hundredth = await callAs(A, 'wish.add', { title: '第 100 条' });
  assert.deepStrictEqual(hundredth.stats, { total: 100, done: 0 });
  await expectFail(B, 'wish.add', { title: '第 101 条' }, 'WISH_LIMIT_REACHED');

  // 列表顺序：未完成按创建时间升序在前，完成按完成时间倒序在后；首页预览跳过已完成（审查 P2-2）
  const seededAt = (offsetMs) => new Date(Date.now() - offsetMs);
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
    wishes: [
      { _id: 'w_undone_new', coupleId: COUPLE_ID, title: '未完成 新', note: '', createdBy: A, done: false, doneBy: null, doneAt: null, createdAt: seededAt(1000), updatedAt: seededAt(1000) },
      { _id: 'w_done_old', coupleId: COUPLE_ID, title: '已完成 旧', note: '', createdBy: A, done: true, doneBy: B, doneAt: seededAt(5000), createdAt: seededAt(9000), updatedAt: seededAt(5000) },
      { _id: 'w_undone_old', coupleId: COUPLE_ID, title: '未完成 旧', note: '', createdBy: A, done: false, doneBy: null, doneAt: null, createdAt: seededAt(5000), updatedAt: seededAt(5000) },
    ],
  });
  const sorted = await callAs(A, 'wish.list', {});
  assert.deepStrictEqual(sorted.items.map((item) => item.wishId), ['w_undone_old', 'w_undone_new', 'w_done_old']);
  assert.deepStrictEqual(sorted.items.map((item) => item.done), [false, false, true]);
  const sortedHome = await callAs(A, 'home.get', {});
  assert.strictEqual(sortedHome.wish.total, 3);
  assert.strictEqual(sortedHome.wish.done, 1);
  assert.strictEqual(sortedHome.wish.previewTitle, '未完成 旧', '首页预览要跳过已完成');
});
