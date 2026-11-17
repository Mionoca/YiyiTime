'use strict';

/**
 * 应用内解绑（文档 5.5 / 7.14）：一方发起、另一方确认才生效。
 * 关注点：发起者不能自确认、撤回 / 拒绝归零、重复发起幂等、事务同时清双方 coupleId、
 * 业务数据不删、解绑后所有双人接口回到 NOT_BOUND、可以重新绑定。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness } = require('./helpers/cloud-entry');

const A = 'oUB_A_000000000001';
const B = 'oUB_B_000000000002';
const C = 'oUB_C_000000000003';
const D = 'oUB_D_000000000004';

async function call(h, who, action, payload) {
  const res = await h.callAs(who, action, payload);
  return res;
}

async function callOk(h, who, action, payload) {
  const res = await call(h, who, action, payload);
  assert.strictEqual(res && res.ok, true, action + ' 应成功：' + JSON.stringify(res));
  return res.data;
}

async function callErr(h, who, action, payload, code) {
  const res = await call(h, who, action, payload);
  assert.strictEqual(res && res.ok, false, action + ' 应失败：' + JSON.stringify(res));
  assert.strictEqual(res.code, code, action + ' 期望 ' + code + '，实际 ' + res.code);
  return res;
}

/** 走一遍真实绑定：A 生成码 → B 申请 → A 确认 */
async function bindPair(h, x, y, startDate) {
  await callOk(h, x, 'user.updateProfile', { nickname: 'X' });
  await callOk(h, y, 'user.updateProfile', { nickname: 'Y' });
  const invite = await callOk(h, x, 'bind.create', { startDate: startDate || '2024-05-20' });
  await callOk(h, y, 'bind.apply', { code: invite.code });
  return callOk(h, x, 'bind.confirm', { code: invite.code });
}

test('解绑：一方发起后双方在 home.get 看到同一件事，发起者标记不同', async () => {
  const h = createHarness();
  await bindPair(h, A, B);

  const before = await callOk(h, A, 'home.get');
  assert.deepStrictEqual(before.unbind, { status: 'none', requestedByMe: false, requestedAt: null });

  const res = await callOk(h, A, 'couple.requestUnbind');
  assert.strictEqual(res.unbind.status, 'pending');
  assert.strictEqual(res.unbind.requestedByMe, true);
  assert.match(res.unbind.requestedAt, /^\d{4}-\d{2}-\d{2}T/);

  const a = await callOk(h, A, 'home.get');
  const b = await callOk(h, B, 'home.get');
  assert.strictEqual(a.unbind.status, 'pending');
  assert.strictEqual(a.unbind.requestedByMe, true);
  assert.strictEqual(b.unbind.status, 'pending');
  assert.strictEqual(b.unbind.requestedByMe, false);
  assert.strictEqual(b.unbind.requestedAt, a.unbind.requestedAt);
});

test('解绑：发起者自己确认被拒绝，对方确认后关系关闭且双方 coupleId 清空', async () => {
  const h = createHarness();
  const couple = await bindPair(h, A, B);
  await callOk(h, A, 'wish.add', { title: '一起看海' });
  await callOk(h, B, 'diary.save', { content: '今天很好' });
  const preEntry = await callOk(h, A, 'ledger.add', { amount: 1200, category: 'food', note: '解绑前' });

  await callOk(h, A, 'couple.requestUnbind');
  await callErr(h, A, 'couple.confirmUnbind', {}, 'UNBIND_WAIT_PARTNER');

  const confirmed = await callOk(h, B, 'couple.confirmUnbind');
  assert.deepStrictEqual(confirmed, { status: 'unbound' });

  const coupleDoc = h.fake().get('couples', couple.coupleId);
  assert.strictEqual(coupleDoc.status, 'closed');
  assert.strictEqual(coupleDoc.unbindStatus, 'done');
  assert.strictEqual(coupleDoc.unbindConfirmedBy, B);
  assert.ok(coupleDoc.unboundAt instanceof Date);
  assert.strictEqual(h.fake().get('users', A).coupleId, null);
  assert.strictEqual(h.fake().get('users', B).coupleId, null);

  // 业务数据一条都不删
  assert.strictEqual(h.fake().all('wishes').length, 1);
  assert.strictEqual(h.fake().all('diaries').length, 1);

  // 双方首页回到未绑定
  const homeA = await callOk(h, A, 'home.get');
  assert.strictEqual(homeA.couple, null);
  assert.strictEqual(homeA.unbind.status, 'none');
  assert.strictEqual(homeA.bind.state, 'unbound');

  // 所有双人接口回到 NOT_BOUND（数据还在，但读不到）
  for (const [who, action, payload] of [
    [A, 'wish.list', {}],
    [B, 'diary.list', {}],
    [B, 'mood.list', {}],
    [A, 'couple.updateStartDate', { startDate: '2024-05-20' }],
  ]) {
    await callErr(h, who, action, payload, 'NOT_BOUND');
  }

  // 记账本是个人账本（文档 5.3.9）：解绑前记的账还在自己名下，只有「TA 的账本」回到 NOT_BOUND
  const mine = await callOk(h, A, 'ledger.list', {});
  assert.strictEqual(mine.who, 'me');
  assert.strictEqual(mine.bound, false, '页面据此收起「TA 的」分段');
  assert.strictEqual(mine.partner, null);
  assert.deepStrictEqual(mine.items.map((item) => item.entryId), [preEntry.entry.entryId]);
  await callErr(h, A, 'ledger.list', { who: 'partner' }, 'NOT_BOUND');
  await callErr(h, B, 'ledger.list', { who: 'partner' }, 'NOT_BOUND');

  // 解绑后新记的账不能再挂到已经关闭的关系上
  const added = await callOk(h, A, 'ledger.add', { amount: 300, category: 'fun', note: '一个人' });
  assert.strictEqual(added.entry.amount, 300);
  assert.strictEqual(h.fake().get('ledger_entries', added.entry.entryId).coupleId, null);
});

test('解绑：撤回 / 拒绝都把状态清回 none，之后确认报 UNBIND_NOT_PENDING', async () => {
  const h = createHarness();
  await bindPair(h, A, B);

  await callOk(h, A, 'couple.requestUnbind');
  const cancelled = await callOk(h, A, 'couple.cancelUnbind');
  assert.deepStrictEqual(cancelled.unbind, { status: 'none', requestedByMe: false, requestedAt: null });
  const coupleDoc = h.fake().all('couples')[0];
  assert.strictEqual(coupleDoc.unbindStatus, 'none');
  assert.strictEqual(coupleDoc.unbindRequestedBy, null);
  assert.strictEqual(coupleDoc.unbindRequestedAt, null);
  assert.strictEqual(coupleDoc.status, 'active');

  await callErr(h, B, 'couple.confirmUnbind', {}, 'UNBIND_NOT_PENDING');
  await callErr(h, B, 'couple.cancelUnbind', {}, 'UNBIND_NOT_PENDING');

  // 被申请方也能「拒绝」（等价于撤回）
  await callOk(h, A, 'couple.requestUnbind');
  const rejected = await callOk(h, B, 'couple.cancelUnbind');
  assert.strictEqual(rejected.unbind.status, 'none');
  assert.strictEqual(h.fake().all('couples')[0].status, 'active');
});

test('解绑：重复发起幂等；对方先发起时再点申请返回 requestedByMe:false 而不是报错', async () => {
  const h = createHarness();
  await bindPair(h, A, B);

  const first = await callOk(h, A, 'couple.requestUnbind');
  const second = await callOk(h, A, 'couple.requestUnbind');
  assert.strictEqual(second.unbind.status, 'pending');
  assert.strictEqual(second.unbind.requestedAt, first.unbind.requestedAt, '重复发起不应该改 requestedAt');

  const b = await callOk(h, B, 'couple.requestUnbind');
  assert.strictEqual(b.unbind.status, 'pending');
  assert.strictEqual(b.unbind.requestedByMe, false);
  assert.strictEqual(h.fake().all('couples')[0].unbindRequestedBy, A, '后点的不会抢走发起者');
});

test('解绑：未绑定调用一律 NOT_BOUND（含从未绑定过的新用户）', async () => {
  const h = createHarness();
  for (const action of ['couple.requestUnbind', 'couple.cancelUnbind', 'couple.confirmUnbind']) {
    await callErr(h, A, action, {}, 'NOT_BOUND');
  }
});

test('解绑：只影响这一对，另一对不受影响', async () => {
  const h = createHarness();
  const ab = await bindPair(h, A, B);
  const cd = await bindPair(h, C, D);

  await callOk(h, A, 'couple.requestUnbind');
  await callOk(h, B, 'couple.confirmUnbind');

  assert.strictEqual(h.fake().get('couples', ab.coupleId).status, 'closed');
  assert.strictEqual(h.fake().get('couples', cd.coupleId).status, 'active');
  assert.strictEqual(h.fake().get('users', C).coupleId, cd.coupleId);
  assert.strictEqual(h.fake().get('users', D).coupleId, cd.coupleId);
  const home = await callOk(h, C, 'home.get');
  assert.strictEqual(home.bind.state, 'bound');
});

test('解绑后可以重新绑定，且是新的关系与新天数', async () => {
  const h = createHarness();
  const old = await bindPair(h, A, B);
  await callOk(h, A, 'couple.requestUnbind');
  await callOk(h, B, 'couple.confirmUnbind');

  const rebind = await bindPair(h, B, A, '2025-01-01');
  assert.notStrictEqual(rebind.coupleId, old.coupleId);
  assert.strictEqual(rebind.startDate, '2025-01-01');
  assert.strictEqual(h.fake().get('users', A).coupleId, rebind.coupleId);
  assert.strictEqual(h.fake().get('users', B).coupleId, rebind.coupleId);

  const home = await callOk(h, A, 'home.get');
  assert.strictEqual(home.bind.state, 'bound');
  assert.strictEqual(home.unbind.status, 'none');
});
