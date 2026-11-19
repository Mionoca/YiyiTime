'use strict';

/**
 * M14 自助注销（文档 7.20 / 17.8 / 11.6）。
 *
 * 这里只测「删得对不对、留得对不对、失败能不能重试」三件事：
 * - 删：账号资料 + 日记（含配图）+ 心情 + 个人账本 + 查看授权 + 邀请码 + 未认领的成长任务；
 * - 留：共同纪念日、愿望、已开始/已归档的成长任务（对方还要看得到）；
 * - 重试：删除本身幂等，任何一步失败都可以整体再来一次。
 * 云存储删除在本地用夹具的 deleteFile 桩验证「送了哪些 fileID」与「失败不阻断」。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const A = 'oDEL_A_00000000001';
const B = 'oDEL_B_00000000002';
const C = 'oDEL_C_00000000003';
const COUPLE = 'c_delete0000000001';
const NOW = new Date('2026-11-16T04:00:00.000Z');

function userDoc(openid, extra) {
  return Object.assign({
    _id: openid,
    openid,
    nickname: openid === A ? '小怡' : '阿安',
    avatarFileID: 'cloud://test-env/avatars/' + openid + '.png',
    coupleId: COUPLE,
    profileComplete: true,
    bindFailCount: 0,
    bindFailResetAt: null,
    reminderEnabled: true,
    reminderAt: '21:00',
    reminderQuota: 3,
    createdAt: NOW,
    updatedAt: NOW,
  }, extra || {});
}

function coupleDoc(extra) {
  return Object.assign({
    _id: COUPLE,
    memberOpenids: [A, B],
    startDate: '2024-05-20',
    startDateUpdatedBy: A,
    status: 'active',
    unbindStatus: 'none',
    createdAt: NOW,
    updatedAt: NOW,
  }, extra || {});
}

function diaryDoc(id, authorOpenid, images) {
  return {
    _id: id,
    coupleId: COUPLE,
    authorOpenid,
    date: '2026-11-15',
    content: '今天很好',
    moodScore: 3,
    visibility: 'private',
    images: images || [],
    unlockAt: new Date('2026-11-16T16:00:00.000Z'),
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** 一对已绑定的情侣 + 两人各自的全部数据 */
function seed() {
  return {
    users: [userDoc(A), userDoc(B)],
    couples: [coupleDoc()],
    diaries: [
      diaryDoc('d_a1', A, ['cloud://test-env/diary/c1/2026-11-15/a1.png', 'cloud://test-env/diary/c1/2026-11-15/a2.png']),
      diaryDoc('d_a2', A, []),
      diaryDoc('d_b1', B, ['cloud://test-env/diary/c1/2026-11-15/b1.png']),
    ],
    moods: [
      { _id: A + '_2026-11-15', coupleId: COUPLE, openid: A, mood: 'sunny', note: '', date: '2026-11-15', createdAt: NOW, updatedAt: NOW },
      { _id: B + '_2026-11-15', coupleId: COUPLE, openid: B, mood: 'rainy', note: '', date: '2026-11-15', createdAt: NOW, updatedAt: NOW },
    ],
    anniversaries: [
      { _id: 'a_keep0000000001', coupleId: COUPLE, title: '第一次见面', date: '2023-06-01', createdBy: A, createdAt: NOW, updatedAt: NOW },
    ],
    wishes: [
      { _id: 'w_keep0000000001', coupleId: COUPLE, title: '去看海', note: '', createdBy: A, done: false, createdAt: NOW, updatedAt: NOW },
    ],
    ledger_entries: [
      { _id: 'l_a1', openid: A, amount: 2350, category: 'food', note: '', date: '2026-11-15', month: '2026-11', createdAt: NOW, updatedAt: NOW },
      { _id: 'l_b1', openid: B, amount: 100, category: 'fun', note: '', date: '2026-11-15', month: '2026-11', createdAt: NOW, updatedAt: NOW },
    ],
    ledger_view_grants: [
      { _id: 'g_v1', coupleId: COUPLE, ownerOpenid: A, viewerOpenid: B, scope: 'temp', status: 'approved', requestedAt: NOW, decidedAt: NOW, expiresAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW },
      { _id: 'g_v2', coupleId: COUPLE, ownerOpenid: B, viewerOpenid: A, scope: 'temp', status: 'approved', requestedAt: NOW, decidedAt: NOW, expiresAt: new Date('2026-11-16T16:00:00.000Z'), createdAt: NOW, updatedAt: NOW },
    ],
    bind_invites: [
      { _id: 'i_a1', code: '111111', creatorOpenid: A, applicantOpenid: null, status: 'confirmed', startDate: '2024-05-20', createdAt: NOW, updatedAt: NOW, expiresAt: new Date('2026-11-17T00:00:00.000Z') },
      { _id: 'i_b1', code: '222222', creatorOpenid: B, applicantOpenid: A, status: 'confirmed', startDate: '2024-05-20', createdAt: NOW, updatedAt: NOW, expiresAt: new Date('2026-11-17T00:00:00.000Z') },
    ],
    growth_tasks: [
      // A 起草、还没被认领 → 该删
      { _id: 'g_draft00000001', coupleId: COUPLE, createdBy: A, title: '一起夜跑', category: 'sport', creatorPart: '', partnerPart: '', note: '', status: 'confirming', archivedType: null, creatorHarvest: null, partnerHarvest: null, creatorReview: null, partnerReview: null, createdAt: NOW, confirmedAt: null, doneAt: null, archivedAt: null, updatedAt: NOW },
      // A 起草、已经认领 → 留给对方
      { _id: 'g_active0000001', coupleId: COUPLE, createdBy: A, title: '一起做饭', category: 'habit', creatorPart: '', partnerPart: '', note: '', status: 'active', archivedType: null, creatorHarvest: null, partnerHarvest: null, creatorReview: null, partnerReview: null, createdAt: NOW, confirmedAt: NOW, doneAt: null, archivedAt: null, updatedAt: NOW },
      // B 起草 → 本来就不是我的
      { _id: 'g_active0000002', coupleId: COUPLE, createdBy: B, title: '一起早睡', category: 'habit', creatorPart: '', partnerPart: '', note: '', status: 'active', archivedType: null, creatorHarvest: null, partnerHarvest: null, creatorReview: null, partnerReview: null, createdAt: NOW, confirmedAt: NOW, doneAt: null, archivedAt: null, updatedAt: NOW },
    ],
  };
}

function setup(extra) {
  const h = createHarness();
  h.reset(Object.assign(seed(), extra || {}), A);
  return h;
}

async function ok(openid, action, payload) {
  const res = await h.callAs(openid, action, payload);
  return res;
}

let h = null;
test.beforeEach(() => { h = null; });

test('注销：未绑定用户也能删掉自己的全部数据，且不需要对方确认', async () => {
  h = createHarness();
  h.reset({
    users: [userDoc(A, { coupleId: null, reminderEnabled: false })],
    diaries: [diaryDoc('d_a1', A, ['cloud://test-env/diary/x/a.png'])],
    moods: [{ _id: A + '_2026-11-15', coupleId: null, openid: A, mood: 'sunny', note: '', date: '2026-11-15', createdAt: NOW, updatedAt: NOW }],
    ledger_entries: [{ _id: 'l_a1', openid: A, amount: 100, category: 'fun', note: '', date: '2026-11-15', month: '2026-11', createdAt: NOW, updatedAt: NOW }],
  }, A);

  const res = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.data.deleted, true);
  assert.strictEqual(res.data.removed.diaries, 1);
  assert.strictEqual(res.data.removed.moods, 1);
  assert.strictEqual(res.data.removed.ledgerEntries, 1);

  const fake = h.fake();
  assert.strictEqual(fake.get('users', A), undefined, '账号文档应被删除');
  assert.deepStrictEqual(fake.all('diaries'), []);
  assert.deepStrictEqual(fake.all('moods'), []);
  assert.deepStrictEqual(fake.all('ledger_entries'), []);
});

test('注销：删自己的、留共同的，并把关系结束掉（对方不受牵连）', async () => {
  h = setup();
  const res = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const fake = h.fake();

  // 自己的数据：日记（含对方那篇不动）、心情、个人账本、双向授权、两类邀请码
  assert.deepStrictEqual(fake.all('diaries').map((d) => d._id), ['d_b1'], '只删自己写的日记');
  assert.deepStrictEqual(fake.all('moods').map((d) => d.openid), [B]);
  assert.deepStrictEqual(fake.all('ledger_entries').map((d) => d.openid), [B]);
  assert.deepStrictEqual(fake.all('ledger_view_grants'), [], '我给出的与我拿到的授权都随人消失');
  assert.deepStrictEqual(fake.all('bind_invites'), [], '我创建的与我申请过的邀请码都不留');

  // 共同数据：纪念日 / 愿望 / 已被认领的成长任务都要留给对方
  assert.strictEqual(fake.all('anniversaries').length, 1, '共同纪念日保留');
  assert.strictEqual(fake.all('wishes').length, 1, '共同愿望保留');
  assert.deepStrictEqual(
    fake.all('growth_tasks').map((d) => d._id).sort(),
    ['g_active0000001', 'g_active0000002'],
    '没被认领的草稿删掉，已经一起做起来的留给对方'
  );

  // 关系结束：couple 关闭，对方的 coupleId / 提醒开关复位，但账号本身还在
  const couple = fake.get('couples', COUPLE);
  assert.strictEqual(couple.status, 'closed');
  assert.strictEqual(couple.unbindStatus, 'done');
  assert.ok(couple.unboundAt, '要记下解绑时间');
  const partner = fake.get('users', B);
  assert.ok(partner, '对方账号不能被删');
  assert.strictEqual(partner.coupleId, null);
  assert.strictEqual(partner.reminderEnabled, false);
  assert.strictEqual(fake.get('users', A), undefined, '自己的账号文档最后删掉');
});

test('注销后对方能继续用：首页回未绑定视图，共同数据还在', async () => {
  h = setup();
  await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });

  const home = await h.callAs(B, 'home.get', {});
  assert.strictEqual(home.ok, true, JSON.stringify(home));
  assert.strictEqual(home.data.bind.state, 'unbound');
  assert.strictEqual(home.data.couple, null);
  assert.strictEqual(home.data.partner, null);
  assert.strictEqual(home.data.anniversary, null, '未绑定不再聚合区块');
  assert.strictEqual(home.data.growth, null);

  const own = await h.callAs(B, 'user.get', {});
  assert.strictEqual(own.ok, true);
  assert.strictEqual(own.data.user.coupleId, null);
});

test('注销：confirm 缺失或写错一律拒绝，且一条数据都不动', async () => {
  h = setup();
  const before = {
    users: h.fake().all('users').length,
    diaries: h.fake().all('diaries').length,
    moods: h.fake().all('moods').length,
  };

  for (const payload of [{}, { confirm: '' }, { confirm: 'DELETE' }, { confirm: true }, null]) {
    const res = await h.callAs(A, 'user.deleteAccount', payload);
    assert.strictEqual(res.ok, false, '应拒绝：' + JSON.stringify(payload));
    assert.strictEqual(res.code, 'INVALID_INPUT');
  }

  assert.strictEqual(h.fake().all('users').length, before.users);
  assert.strictEqual(h.fake().all('diaries').length, before.diaries);
  assert.strictEqual(h.fake().all('moods').length, before.moods);
  assert.strictEqual(h.fake().get('couples', COUPLE).status, 'active', '被拒时关系不能被动');
});

test('注销：幂等——再调一次不报错，也不会误删别人的数据', async () => {
  h = setup();
  const first = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(first.ok, true);

  const second = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(second.ok, true, '重复注销不应报错：' + JSON.stringify(second));
  assert.strictEqual(second.data.deleted, true);
  assert.strictEqual(second.data.removed.diaries, 0, '第二次已经没东西可删');
  assert.strictEqual(h.fake().all('diaries').length, 1, '对方那篇日记还在');
  assert.strictEqual(h.fake().all('wishes').length, 1);
});

test('注销：头像与日记配图都送去云存储删除，一批不超过 50 个', async () => {
  h = setup();
  const res = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));

  const batches = h.fileCalls();
  assert.ok(batches.length >= 1, '应调用 cloud.deleteFile');
  const files = batches.flat();
  assert.strictEqual(files.length, 3, '2 张日记配图 + 头像，对方那篇的配图不能动：' + JSON.stringify(files));
  assert.ok(files.indexOf('cloud://test-env/avatars/' + A + '.png') !== -1, '头像要删');
  assert.ok(files.indexOf('cloud://test-env/avatars/' + B + '.png') === -1, '对方头像不能删');
  assert.ok(files.indexOf('cloud://test-env/diary/c1/2026-11-15/b1.png') === -1, '对方配图不能删');
  batches.forEach((batch) => assert.ok(batch.length <= 50, '单批不超过 50 个 fileID'));
  assert.strictEqual(res.data.removed.files, files.length);
});

test('注销：云存储删除失败不阻断（账号已经注销这件事不能被文件拖住）', async (t) => {
  h = setup();
  const logs = captureConsoleError(t);
  h.setFileApi(async () => { throw new Error('storage down'); });

  const res = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.data.removed.files, 0, '全失败就记 0');
  assert.strictEqual(h.fake().get('users', A), undefined, '账号仍然删掉');
  const text = logs.map((args) => args.join(' ')).join('\n');
  assert.ok(text.indexOf('delete-files-failed') !== -1, '要留一条脱敏日志：' + text);
  assert.strictEqual(text.indexOf('cloud://'), -1, '日志不能打 fileID');
});

test('注销：只删自己名下的，别家的同名数据不受影响', async () => {
  const OTHER = 'c_delete0000000002';
  h = createHarness();
  h.reset({
    users: [userDoc(A), userDoc(B), userDoc(C, { nickname: '别人', coupleId: OTHER })],
    couples: [coupleDoc(), coupleDoc({ _id: OTHER, memberOpenids: [C, 'oDEL_D'] })],
    diaries: [diaryDoc('d_a1', A), diaryDoc('d_c1', C)],
    moods: [
      { _id: A + '_2026-11-15', coupleId: COUPLE, openid: A, mood: 'sunny', note: '', date: '2026-11-15', createdAt: NOW, updatedAt: NOW },
      { _id: C + '_2026-11-15', coupleId: OTHER, openid: C, mood: 'rainy', note: '', date: '2026-11-15', createdAt: NOW, updatedAt: NOW },
    ],
  }, A);

  const res = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const fake = h.fake();
  assert.deepStrictEqual(fake.all('moods').map((d) => d.openid), [C]);
  assert.strictEqual(fake.get('couples', OTHER).status, 'active', '别家的关系不能被关掉');
  assert.ok(fake.get('users', C), '别家的账号不能被删');
});

test('注销：下线集合不存在（或读失败）不算错误，不能把注销整件事打断', async () => {
  h = setup();
  // 真实环境里 M14 下线的两个集合可能根本没建：读到它就等于「没东西可删」
  const missing = new Error('database collection not exists');
  missing.errCode = -502005;
  h.setFault({ collection: 'safety_checkins', method: 'collection', error: missing });

  const res = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.data.deleted, true);
  assert.strictEqual(res.data.removed.safetyCheckins, 0, '集合不存在就是 0 条');
  assert.deepStrictEqual(h.fake().all('diaries').map((d) => d._id), ['d_b1'], '其余集合照常删');
  assert.strictEqual(h.fake().get('users', A), undefined);

  // 读失败（不是「不存在」）也要继续删，只是因为已删账号而无法再调一次
  h.setFault(null);
  h = setup();
  const broken = new Error('internal error');
  broken.errCode = -1;
  h.setFault({ collection: 'pauses', method: 'collection', error: broken });
  const res2 = await h.callAs(A, 'user.deleteAccount', { confirm: 'delete' });
  assert.strictEqual(res2.ok, true, '单集合读失败不该阻断注销：' + JSON.stringify(res2));
  assert.strictEqual(res2.data.removed.pauses, 0);
});
