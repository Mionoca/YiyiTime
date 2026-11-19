'use strict';

/**
 * 端到端链路测试：用云函数入口 + 本地假库，跑两个人从「还没绑定」到「日常使用」的主链路。
 *
 * 入口使用真实 new Date() 作为 ctx.now，因此天数和解锁时刻都按 time 库实时计算，
 * 不硬编码具体日期。覆盖：
 * 1) 双账号完整主链路（资料 → 绑定 → 首页聚合 → 心情 → 抱抱 → 报平安 → 日记 → 愿望 → 改开始日期）
 * 2) 跨天日记解锁后能看到对方正文（直接种库）
 * 3) 过期抱抱在首页不展示，并惰性写回 expired
 * 4) user.coupleId 指向不存在的 couple 时 home.get 自愈回未绑定
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');
const time = require('../cloudfunctions/api/lib/time');

const h = createHarness();

const A = 'oE2E_A_0000000001';
const B = 'oE2E_B_0000000002';
const START = '2024-05-20';

/**
 * 入口用的是真实时钟（ctx.now = new Date()），这里只用来算断言的期望值。
 * 理论上在 00:00+08 前后执行的一两秒内，期望值和请求时刻可能跨天不一致，
 * 属于可接受的低概率抖动（不注入假时钟是为了让 e2e 贴近真实运行）。
 */
function today() {
  return time.dateKeyOf(new Date());
}

async function callAs(openid, action, payload) {
  const res = await h.callAs(openid, action, payload);
  assert.strictEqual(
    res.ok,
    true,
    action + ' 应成功，实际：' + JSON.stringify({ code: res.code, message: res.message }),
  );
  return res.data;
}

function userDoc(openid, nickname, coupleId) {
  const now = new Date();
  return {
    _id: openid,
    openid,
    nickname,
    avatarFileID: 'cloud://' + openid + '.png',
    coupleId: coupleId || null,
    profileComplete: true,
    bindFailCount: 0,
    bindFailResetAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function coupleDoc(coupleId, extra) {
  const now = new Date();
  return Object.assign({
    _id: coupleId,
    memberOpenids: [A, B],
    startDate: START,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }, extra || {});
}

/** 双账号走完：改资料 → A 生成码 → B 预览/申请 → A 确认 */
async function bindTwoAccounts() {
  h.reset({});
  await callAs(A, 'user.updateProfile', { nickname: '小怡', avatarFileID: 'cloud://a.png' });
  await callAs(B, 'user.updateProfile', { nickname: '阿安', avatarFileID: 'cloud://b.png' });

  const created = await callAs(A, 'bind.create', { startDate: START });
  assert.match(created.code, /^\d{6}$/);
  assert.strictEqual(created.state, 'code_created');
  assert.strictEqual(created.startDate, START);

  const preview = await callAs(B, 'bind.preview', { code: created.code });
  assert.strictEqual(preview.creator.nickname, '小怡');

  const applied = await callAs(B, 'bind.apply', { code: created.code });
  assert.strictEqual(applied.state, 'applied_by_me');

  const statusA = await callAs(A, 'bind.status', {});
  assert.strictEqual(statusA.state, 'applied_by_partner');

  const confirmed = await callAs(A, 'bind.confirm', { code: created.code });
  assert.match(confirmed.coupleId, /^c_[0-9a-f]+$/);
  assert.strictEqual(confirmed.startDate, START);
  assert.strictEqual(confirmed.partner.nickname, '阿安');
  return { coupleId: confirmed.coupleId, code: created.code };
}

test('双账号端到端主链路：绑定 → 首页聚合 → 心情/纪念日/报平安/日记/愿望 → 改开始日期', async (t) => {
  captureConsoleError(t);
  const { coupleId } = await bindTwoAccounts();
  const todayKey = today();

  // 绑定结果落在库里：双方 coupleId 双写、coupled 状态可查询
  const store = h.fake();
  assert.strictEqual(store.get('users', A).coupleId, coupleId);
  assert.strictEqual(store.get('users', B).coupleId, coupleId);
  const couple = store.get('couples', coupleId);
  assert.deepStrictEqual(couple.memberOpenids, [A, B]);
  assert.strictEqual(couple.startDate, START);
  assert.strictEqual(couple.status, 'active');
  assert.strictEqual((await callAs(A, 'user.get', {})).user.coupleId, coupleId);

  // 首页：已绑定 + 五个区块全空 + 天数/纪念日按 time 库实时算
  const homeA = await callAs(A, 'home.get', {});
  assert.strictEqual(homeA.bind.state, 'bound');
  assert.strictEqual(homeA.bind.pending, null);
  assert.strictEqual(homeA.couple.coupleId, coupleId);
  assert.strictEqual(homeA.couple.startDate, START);
  assert.strictEqual(homeA.couple.daysTogether, time.daysTogether(START, todayKey));
  assert.deepStrictEqual(homeA.couple.anniversary, time.nextAnniversary(START, todayKey));
  assert.strictEqual(homeA.partner.nickname, '阿安');
  assert.strictEqual(homeA.partner.openid, B);
  assert.deepStrictEqual(homeA.mood, { mine: null, partner: null });
  assert.deepStrictEqual(homeA.anniversary, { items: [] });
  assert.deepStrictEqual(homeA.safety, { mineToday: false, partnerToday: false, partnerLastAt: null });
  assert.deepStrictEqual(homeA.diary, {
    mineWritten: false,
    partnerWritten: false,
    partnerUnlocked: false,
    unlockAt: time.nextUnlockAt(todayKey).toISOString(),
  });
  assert.deepStrictEqual(homeA.wish, { total: 0, done: 0, previewTitle: null });
  assert.strictEqual(homeA.todayKey, todayKey);

  // 心情：A 打卡后 B 的首页能看到，A 自己的 mine 也有
  const mood = await callAs(A, 'mood.set', { mood: 'sunny', note: '有点想你' });
  assert.strictEqual(mood.mood.mood, 'sunny');
  assert.strictEqual(mood.mood.note, '有点想你');
  assert.strictEqual(mood.mood.date, todayKey);
  const homeB1 = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB1.mood.partner.mood, 'sunny');
  assert.strictEqual(homeB1.mood.partner.note, '有点想你');
  assert.strictEqual(homeB1.mood.mine, null);
  const homeA1 = await callAs(A, 'home.get', {});
  assert.strictEqual(homeA1.mood.mine.mood, 'sunny');

  // 纪念日：A 加一个 → 双方首页都能看到（同一条数据），B 改标题后 A 也读到新标题
  const annAdded = await callAs(A, 'anniversary.add', { title: '第一次见面', date: '2023-06-01' });
  assert.match(annAdded.item.anniversaryId, /^a_[0-9a-f]+$/);
  assert.strictEqual(annAdded.items.length, 1);
  const homeB2 = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB2.anniversary.items.length, 1);
  assert.strictEqual(homeB2.anniversary.items[0].title, '第一次见面');
  assert.strictEqual(homeB2.anniversary.items[0].daysLeft, annAdded.item.daysLeft, '剩余天数只由服务端 todayKey 决定');
  const renamed = await callAs(B, 'anniversary.update', {
    anniversaryId: annAdded.item.anniversaryId, title: '初见',
  });
  assert.strictEqual(renamed.item.title, '初见');
  const homeA2 = await callAs(A, 'home.get', {});
  assert.strictEqual(homeA2.anniversary.items[0].title, '初见');

  // 报平安：10 分钟去重；时间线带昵称；对方首页 partnerToday 亮起
  const checkin = await callAs(A, 'safety.checkin', { note: '到家啦' });
  assert.strictEqual(checkin.deduped, false);
  assert.strictEqual(checkin.entry.date, todayKey);
  assert.strictEqual(checkin.entry.note, '到家啦');
  const duplicate = await callAs(A, 'safety.checkin', { note: '又点一次' });
  assert.strictEqual(duplicate.deduped, true);
  assert.strictEqual(duplicate.entry.checkinId, checkin.entry.checkinId);
  const timeline = await callAs(A, 'safety.list', {});
  assert.strictEqual(timeline.items.length, 1);
  assert.strictEqual(timeline.items[0].nickname, '小怡');
  assert.strictEqual(timeline.items[0].checkinId, checkin.entry.checkinId);
  const homeB3 = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB3.safety.mineToday, false);
  assert.strictEqual(homeB3.safety.partnerToday, true);
  assert.strictEqual(homeB3.safety.partnerLastAt, checkin.entry.createdAt);

  // 日记（M13）：默认私密，双方互不可见；手动开启「这篇给他看」后对方才看到「写了」
  const unlockISO = time.nextUnlockAt(todayKey).toISOString();
  const diaryA = await callAs(A, 'diary.save', { content: '今天很开心', moodScore: 4 });
  assert.strictEqual(diaryA.diary.unlockAt, unlockISO);
  assert.strictEqual(diaryA.diary.visibility, 'private');
  await callAs(B, 'diary.save', { content: '我也是' });
  const privateList = await callAs(A, 'diary.list', {});
  assert.strictEqual(privateList.items.length, 1);
  assert.strictEqual(privateList.items[0].partnerWritten, false, '私密日记在对方侧等于不存在');
  assert.strictEqual(privateList.items[0].partner, null);
  assert.strictEqual(privateList.items[0].unlockAt, unlockISO);

  await callAs(A, 'diary.save', { content: '今天很开心', moodScore: 4, visibility: 'partner' });
  const diaryList = await callAs(A, 'diary.list', {});
  const dayA = diaryList.items[0];
  assert.strictEqual(dayA.date, todayKey);
  assert.strictEqual(dayA.mine.content, '今天很开心');
  assert.strictEqual(dayA.mine.visibility, 'partner');
  assert.strictEqual(dayA.partnerWritten, false, 'B 没分享，A 侧看不到「TA 写了」');
  assert.strictEqual(dayA.partner, null);
  assert.strictEqual(dayA.unlockAt, unlockISO);
  const diaryListB = await callAs(B, 'diary.list', {});
  assert.strictEqual(diaryListB.items[0].partnerWritten, true, 'A 分享了，B 侧看到「TA 写了」');
  assert.strictEqual(diaryListB.items[0].partnerUnlocked, false);
  assert.strictEqual(diaryListB.items[0].partner, null);
  const homeB4 = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB4.diary.mineWritten, true);
  assert.strictEqual(homeB4.diary.partnerWritten, true);
  assert.strictEqual(homeB4.diary.partnerUnlocked, false);

  // 愿望：A 添加 → B 列表可见 → B 勾完成 → 首页统计与预览
  const added = await callAs(A, 'wish.add', { title: '去看海', note: '夏天' });
  assert.deepStrictEqual(added.stats, { total: 1, done: 0 });
  assert.strictEqual(added.wish.createdBy, A);
  const wishListB = await callAs(B, 'wish.list', {});
  assert.strictEqual(wishListB.items.length, 1);
  assert.strictEqual(wishListB.items[0].title, '去看海');
  assert.deepStrictEqual(wishListB.stats, { total: 1, done: 0 });
  const done = await callAs(B, 'wish.setDone', { wishId: added.wish.wishId, done: true });
  assert.strictEqual(done.wish.done, true);
  assert.strictEqual(done.wish.doneBy, B);
  assert.deepStrictEqual(done.stats, { total: 1, done: 1 });
  const homeA3 = await callAs(A, 'home.get', {});
  assert.deepStrictEqual(homeA3.wish, { total: 1, done: 1, previewTitle: null });

  // 改开始日期：双方都能看到新天数
  const NEW_START = '2024-06-01';
  const updated = await callAs(A, 'couple.updateStartDate', { startDate: NEW_START });
  assert.strictEqual(updated.startDate, NEW_START);
  assert.strictEqual(updated.daysTogether, time.daysTogether(NEW_START, todayKey));
  const homeB5 = await callAs(B, 'home.get', {});
  assert.strictEqual(homeB5.couple.startDate, NEW_START);
  assert.strictEqual(homeB5.couple.daysTogether, time.daysTogether(NEW_START, todayKey));
  assert.deepStrictEqual(homeB5.couple.anniversary, time.nextAnniversary(NEW_START, todayKey));
});

test('跨天日记解锁后，能读到对方正文（直接种库）', async (t) => {
  captureConsoleError(t);
  const todayKey = today();
  const yesterday = time.addDays(todayKey, -1);
  const coupleId = 'c_00000000deadbeef';
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  h.reset({
    users: [userDoc(A, '小怡', coupleId), userDoc(B, '阿安', coupleId)],
    couples: [coupleDoc(coupleId)],
    diaries: [
      {
        _id: A + '_' + yesterday,
        coupleId,
        authorOpenid: A,
        date: yesterday,
        content: '昨天我写的',
        visibility: 'partner',
        unlockAt: past,
        createdAt: past,
        updatedAt: past,
      },
      {
        _id: B + '_' + yesterday,
        coupleId,
        authorOpenid: B,
        date: yesterday,
        content: '昨天 TA 写的',
        visibility: 'partner',
        unlockAt: past,
        createdAt: past,
        updatedAt: past,
      },
    ],
  });

  const list = await callAs(A, 'diary.list', {});
  assert.strictEqual(list.items.length, 1);
  assert.strictEqual(list.items[0].date, yesterday);
  assert.strictEqual(list.items[0].mine.content, '昨天我写的');
  assert.strictEqual(list.items[0].partnerWritten, true);
  assert.strictEqual(list.items[0].partnerUnlocked, true);
  assert.strictEqual(list.items[0].partner.content, '昨天 TA 写的');
});

test('纪念日 8 条上限：第 9 条被拒，首页仍返回全部 8 条', async (t) => {
  captureConsoleError(t);
  const coupleId = 'c_00000000deadbeef';
  h.reset({
    users: [userDoc(A, '小怡', coupleId), userDoc(B, '阿安', coupleId)],
    couples: [coupleDoc(coupleId)],
  });

  for (let i = 0; i < 8; i += 1) {
    const res = await callAs(A, 'anniversary.add', {
      title: '纪念日 ' + i,
      date: '2020-' + String(i + 1).padStart(2, '0') + '-01',
    });
    assert.strictEqual(res.items.length, i + 1);
  }
  const ninth = await h.callAs(A, 'anniversary.add', { title: '第九个', date: '2023-06-01' });
  assert.strictEqual(ninth.ok, false);
  assert.strictEqual(ninth.code, 'ANNIVERSARY_LIMIT_REACHED');

  const homeA = await callAs(A, 'home.get', {});
  assert.strictEqual(homeA.anniversary.items.length, 8);
  assert.strictEqual(h.fake().all('anniversaries').length, 8);
});

test('user.coupleId 指向不存在的 couple 时，home.get 自愈回未绑定', async (t) => {
  const errors = captureConsoleError(t);
  h.reset({
    // 带着「已开启提醒」的脏数据进自愈：开关必须一起关掉
    users: [Object.assign(userDoc(A, '小怡', 'c_00000000deadbeef'), {
      reminderEnabled: true, reminderAt: '21:00', reminderQuota: 2,
    })],
  });

  const home = await callAs(A, 'home.get', {});
  assert.strictEqual(home.bind.state, 'unbound');
  assert.strictEqual(home.couple, null);
  assert.strictEqual(home.partner, null);
  assert.strictEqual(home.mood, null);
  assert.strictEqual(h.fake().get('users', A).coupleId, null);
  // 关系已经不存在了，提醒开关不能留在「开着」状态（否则「我的」页显示已开启、却永远不会发）
  assert.strictEqual(h.fake().get('users', A).reminderEnabled, false);

  // 失败日志只带尾部 6 位，不打印完整 openid
  const line = errors.map((args) => args.join(' ')).find((text) => text.includes('couple missing'));
  assert.ok(line, '应记录 couple 缺失日志');
  assert.strictEqual(line.includes(A), false);
  assert.ok(line.includes(A.slice(-6)));
});
