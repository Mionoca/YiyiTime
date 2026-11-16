'use strict';

const test = require('node:test');
const assert = require('node:assert');

const crypto = require('node:crypto');

const bind = require('../cloudfunctions/api/handlers/bind');
const { makeFakeDb } = require('./helpers/fake-db');
const { captureConsoleError } = require('./helpers/cloud-entry');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 12:00
const TODAY = '2026-11-16';
const HOUR_MS = 60 * 60 * 1000;
const TTL_MS = 24 * HOUR_MS;

function userDoc(id, extra) {
  return Object.assign({
    _id: id,
    openid: id,
    nickname: '用户' + id,
    avatarFileID: '',
    coupleId: null,
    profileComplete: true,
    bindFailCount: 0,
    bindFailResetAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  }, extra);
}

/**
 * 仿 cloudfunctions/api/lib/ctx.js 的 buildContext：每次请求重新读库。
 * 返回的是库内文档的副本（不是引用），避免 handler 对 ctx.user 的赋值「顺着别名」改到库。
 */
function makeCtx(fake, openid, now) {
  const at = now || NOW;
  let stored = fake.get('users', openid) || null;
  if (!stored) {
    stored = userDoc(openid);
    fake.db.collection('users').doc(openid).set({ data: stored });
  }
  const user = Object.assign({}, stored);
  const couple = user.coupleId ? Object.assign({}, fake.get('couples', user.coupleId) || null) : null;
  return {
    openid,
    user,
    couple,
    partner: null,
    db: fake.db,
    now: at,
    requireBound() {},
  };
}

/** 模拟下一次请求：库被 handler 写过之后重新构建 ctx（不要复用旧 ctx 做状态断言） */
function refreshCtx(fake, openid, now) {
  return makeCtx(fake, openid, now);
}

/** 让事务内第 failAt 次 users.update 抛错，用于验证「写完一半失败要整体回滚」 */
function injectUsersUpdateFailure(fake, failAt) {
  const original = fake.db.runTransaction;
  fake.db.runTransaction = async (fn) => original(async (tx) => {
    let count = 0;
    const collection = (name) => {
      const col = tx.collection(name);
      if (name !== 'users') return col;
      return {
        doc(id) {
          const ref = col.doc(id);
          return {
            get: () => ref.get(),
            update: async (arg) => {
              count += 1;
              if (count === failAt) throw new Error('injected users.update failure #' + count);
              return ref.update(arg);
            },
            set: (arg) => ref.set(arg),
            remove: () => ref.remove(),
          };
        },
      };
    };
    return fn({ collection });
  });
}

function seedInvite(extra) {
  return Object.assign({
    _id: '482913',
    code: '482913',
    creatorOpenid: 'oA',
    applicantOpenid: null,
    status: 'open',
    startDate: '2024-05-20',
    expiresAt: new Date(NOW.getTime() + TTL_MS),
    appliedAt: null,
    confirmedAt: null,
    coupleId: null,
    createdAt: new Date(NOW.getTime() - HOUR_MS),
    updatedAt: new Date(NOW.getTime() - HOUR_MS),
  }, extra);
}

test('绑定全链路：create → preview → apply → status → confirm → 双方 bound（确认幂等）', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA', { nickname: '小怡' }), userDoc('oB', { nickname: '阿安' })],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');

  const created = await bind.create({ startDate: '2024-05-20' }, ctxA);
  assert.strictEqual(created.state, 'code_created');
  assert.strictEqual(created.startDate, '2024-05-20');
  assert.match(created.code, /^\d{6}$/);
  assert.strictEqual(created.expiresAt, new Date(NOW.getTime() + TTL_MS).toISOString());
  const code = created.code;

  const previewed = await bind.preview({ code }, ctxB);
  assert.deepStrictEqual(previewed, {
    code,
    creator: { nickname: '小怡', avatarFileID: '' },
    startDate: '2024-05-20',
    expiresAt: created.expiresAt,
    status: 'open',
  });

  const applied = await bind.apply({ code }, ctxB);
  assert.deepStrictEqual(applied, {
    state: 'applied_by_me',
    code,
    creator: { nickname: '小怡', avatarFileID: '' },
    startDate: '2024-05-20',
    expiresAt: created.expiresAt,
  });
  assert.strictEqual(fake.get('bind_invites', code).status, 'applied');
  assert.strictEqual(fake.get('bind_invites', code).applicantOpenid, 'oB');

  const statusA = await bind.status({}, ctxA);
  assert.deepStrictEqual(statusA, {
    state: 'applied_by_partner',
    pending: {
      code,
      role: 'creator',
      status: 'applied',
      startDate: '2024-05-20',
      expiresAt: created.expiresAt,
      other: { nickname: '阿安', avatarFileID: '' },
    },
  });
  const statusB = await bind.status({}, ctxB);
  assert.strictEqual(statusB.state, 'applied_by_me');
  assert.strictEqual(statusB.pending.role, 'applicant');
  assert.deepStrictEqual(statusB.pending.other, { nickname: '小怡', avatarFileID: '' });

  // 确认成功要清空双方失败计数（文档 6.9）
  await fake.db.collection('users').doc('oA').update({ data: { bindFailCount: 2, bindFailResetAt: NOW } });
  await fake.db.collection('users').doc('oB').update({ data: { bindFailCount: 2, bindFailResetAt: NOW } });

  const confirmed = await bind.confirm({ code }, ctxA);
  assert.match(confirmed.coupleId, /^c_[0-9a-f]{16}$/);
  assert.strictEqual(confirmed.startDate, '2024-05-20');
  // 2024-05-20 到 2026-11-16：相差 910 天，在一起第 911 天
  assert.strictEqual(confirmed.daysTogether, 911);
  assert.deepStrictEqual(confirmed.partner, { nickname: '阿安', avatarFileID: '' });

  const couple = fake.get('couples', confirmed.coupleId);
  assert.deepStrictEqual(couple.memberOpenids, ['oA', 'oB']);
  assert.strictEqual(couple.startDate, '2024-05-20');
  assert.strictEqual(couple.startDateUpdatedBy, 'oA');
  assert.strictEqual(couple.status, 'active');
  assert.strictEqual(fake.get('users', 'oA').coupleId, confirmed.coupleId);
  assert.strictEqual(fake.get('users', 'oB').coupleId, confirmed.coupleId);
  const invite = fake.get('bind_invites', code);
  assert.strictEqual(invite.status, 'confirmed');
  assert.strictEqual(invite.coupleId, confirmed.coupleId);
  assert.ok(invite.confirmedAt instanceof Date);

  // 下一次请求要重新读库：用新 ctx
  assert.deepStrictEqual(await bind.status({}, refreshCtx(fake, 'oA')), { state: 'bound', pending: null });
  assert.deepStrictEqual(await bind.status({}, refreshCtx(fake, 'oB')), { state: 'bound', pending: null });
  assert.strictEqual(fake.get('users', 'oA').bindFailCount, 0);
  assert.strictEqual(fake.get('users', 'oA').bindFailResetAt, null);
  assert.strictEqual(fake.get('users', 'oB').bindFailCount, 0);
  assert.strictEqual(fake.get('users', 'oB').bindFailResetAt, null);

  // 重复确认是幂等的：返回同一个 couple，不报错也不新建
  const again = await bind.confirm({ code }, ctxA);
  assert.deepStrictEqual(again, confirmed);
  assert.strictEqual(fake.all('couples').length, 1);
});

test('bind.create 复用活跃邀请：不传 regenerate 返回同一个码，不新增文档', async () => {
  const fake = makeFakeDb({ users: [userDoc('oA')] });
  const ctxA = makeCtx(fake, 'oA');

  const first = await bind.create({ startDate: '2024-05-20' }, ctxA);
  const second = await bind.create({ startDate: '2024-05-20' }, ctxA);
  assert.strictEqual(second.code, first.code);
  assert.strictEqual(second.state, 'code_created');
  assert.strictEqual(fake.all('bind_invites').length, 1);

  // 有申请后复用会返回 applied_by_partner
  const ctxB = makeCtx(fake, 'oB');
  await bind.apply({ code: first.code }, ctxB);
  const third = await bind.create({ startDate: '2024-05-20' }, ctxA);
  assert.strictEqual(third.code, first.code);
  assert.strictEqual(third.state, 'applied_by_partner');
});

test('bind.create regenerate：旧码作废（cancelled），新码可被预览', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');

  const first = await bind.create({ startDate: '2024-05-20' }, ctxA);
  const second = await bind.create({ startDate: '2024-06-01', regenerate: true }, ctxA);
  assert.notStrictEqual(second.code, first.code);
  assert.strictEqual(second.startDate, '2024-06-01');
  assert.strictEqual(fake.get('bind_invites', first.code).status, 'cancelled');

  await assert.rejects(() => bind.preview({ code: first.code }, ctxB), { code: 'INVITE_USED' });
  const previewed = await bind.preview({ code: second.code }, ctxB);
  assert.strictEqual(previewed.startDate, '2024-06-01');
});

test('过期邀请：预览报 INVITE_EXPIRED 并惰性置 expired，creator 状态回到 unbound 后可重新生成', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({
      _id: '111111',
      code: '111111',
      status: 'open',
      expiresAt: new Date(NOW.getTime() - HOUR_MS),
    })],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');

  await assert.rejects(() => bind.preview({ code: '111111' }, ctxB), { code: 'INVITE_EXPIRED' });
  assert.strictEqual(fake.get('bind_invites', '111111').status, 'expired');
  assert.deepStrictEqual(await bind.status({}, ctxA), { state: 'unbound', pending: null });

  const created = await bind.create({ startDate: '2024-05-20' }, ctxA);
  assert.strictEqual(created.state, 'code_created');
  assert.notStrictEqual(created.code, '111111');
});

test('错码限流：连续 5 次失败后锁 1 小时，窗口过期后重新计数', async () => {
  const fake = makeFakeDb({ users: [userDoc('oB')] });
  const ctxB = makeCtx(fake, 'oB');

  for (let i = 0; i < 5; i += 1) {
    await assert.rejects(() => bind.preview({ code: '000000' }, ctxB), { code: 'INVITE_NOT_FOUND' });
  }
  assert.strictEqual(fake.get('users', 'oB').bindFailCount, 5);

  await assert.rejects(() => bind.preview({ code: '000000' }, ctxB), (err) => {
    assert.strictEqual(err.code, 'BIND_RATE_LIMITED');
    assert.strictEqual(err.message, '试太多次了，1 小时后再试');
    return true;
  });

  // 1 小时后窗口失效：重新允许尝试，计数从 1 重新累计
  const laterCtx = makeCtx(fake, 'oB', new Date(NOW.getTime() + 61 * 60 * 1000));
  await assert.rejects(() => bind.preview({ code: '000000' }, laterCtx), { code: 'INVITE_NOT_FOUND' });
  assert.strictEqual(fake.get('users', 'oB').bindFailCount, 1);
});

test('不能预览/申请自己的码（INVITE_SELF），并计入失败次数', async () => {
  const fake = makeFakeDb({ users: [userDoc('oA')] });
  const ctxA = makeCtx(fake, 'oA');
  const created = await bind.create({ startDate: '2024-05-20' }, ctxA);

  await assert.rejects(() => bind.preview({ code: created.code }, ctxA), { code: 'INVITE_SELF' });
  await assert.rejects(() => bind.apply({ code: created.code }, ctxA), { code: 'INVITE_SELF' });
  // 预览与申请各计一次失败
  assert.strictEqual(fake.get('users', 'oA').bindFailCount, 2);
});

test('旧申请已过期时允许申请新码（不再死锁）', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oB'), userDoc('oX'), userDoc('oY')],
    bind_invites: [
      // oB 之前申请过 oX 的码，已过期
      seedInvite({
        _id: '222222', code: '222222', creatorOpenid: 'oX', applicantOpenid: 'oB',
        status: 'applied', expiresAt: new Date(NOW.getTime() - HOUR_MS),
      }),
      // oY 的新码
      seedInvite({ _id: '333333', code: '333333', creatorOpenid: 'oY' }),
    ],
  });
  const ctxB = makeCtx(fake, 'oB');

  const applied = await bind.apply({ code: '333333' }, ctxB);
  assert.strictEqual(applied.state, 'applied_by_me');
  assert.strictEqual(fake.get('bind_invites', '222222').status, 'expired');
  assert.strictEqual(fake.get('bind_invites', '333333').status, 'applied');
});

test('已有一个进行中的申请时，再申请别的码报 BIND_ALREADY_APPLIED', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB'), userDoc('oY')],
    bind_invites: [
      seedInvite({ _id: '444444', code: '444444', creatorOpenid: 'oA' }),
      seedInvite({ _id: '454545', code: '454545', creatorOpenid: 'oY' }),
    ],
  });
  const ctxB = makeCtx(fake, 'oB');
  await bind.apply({ code: '444444' }, ctxB);
  await assert.rejects(() => bind.apply({ code: '454545' }, ctxB), { code: 'BIND_ALREADY_APPLIED' });
  assert.strictEqual(fake.get('bind_invites', '454545').status, 'open');
});

test('bind.confirm 前置错误：码不存在 / 不是自己创建的 / TA 还没申请 / 已过期', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [
      seedInvite({ _id: '555555', code: '555555', creatorOpenid: 'oA' }),
      seedInvite({
        _id: '666666', code: '666666', creatorOpenid: 'oA', applicantOpenid: 'oB',
        status: 'applied', expiresAt: new Date(NOW.getTime() - HOUR_MS),
      }),
    ],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');

  await assert.rejects(() => bind.confirm({ code: '999999' }, ctxA), { code: 'INVITE_NOT_FOUND' });
  // 码是 oA 创建、但由 oB 去确认
  await assert.rejects(() => bind.confirm({ code: '555555' }, ctxB), { code: 'INVITE_NOT_CREATOR' });
  // 还没有人申请
  await assert.rejects(() => bind.confirm({ code: '555555' }, ctxA), { code: 'INVITE_NOT_APPLIED' });
  // 申请后邀请过期
  await assert.rejects(() => bind.confirm({ code: '666666' }, ctxA), { code: 'INVITE_EXPIRED' });
  assert.strictEqual(fake.get('bind_invites', '666666').status, 'expired');
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
});

test('申请人在别处已绑定时 confirm 报 APPLICANT_ALREADY_BOUND，不创建 couple', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB', { coupleId: 'c_other' })],
    couples: [{ _id: 'c_other', memberOpenids: ['oB', 'oZ'], startDate: '2024-01-01', status: 'active' }],
    bind_invites: [seedInvite({
      _id: '777777', code: '777777', creatorOpenid: 'oA', applicantOpenid: 'oB', status: 'applied',
    })],
  });
  const ctxA = makeCtx(fake, 'oA');

  await assert.rejects(() => bind.confirm({ code: '777777' }, ctxA), { code: 'APPLICANT_ALREADY_BOUND' });
  assert.deepStrictEqual(fake.all('couples').map((c) => c._id), ['c_other']);
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
  assert.strictEqual(fake.get('bind_invites', '777777').status, 'applied');
});

test('confirm 事务内重校验：预检后被取消的邀请不会生成 couple', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({ _id: '888888', code: '888888', creatorOpenid: 'oA' })],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');
  await bind.apply({ code: '888888' }, ctxB);

  const original = fake.db.runTransaction;
  fake.db.runTransaction = async (fn) => {
    // 模拟「creator 确认前，邀请被另一端取消」
    await fake.db.collection('bind_invites').doc('888888').update({ data: { status: 'cancelled' } });
    return original(fn);
  };

  await assert.rejects(() => bind.confirm({ code: '888888' }, ctxA), { code: 'INVITE_USED' });
  assert.strictEqual(fake.all('couples').length, 0);
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
  assert.strictEqual(fake.get('users', 'oB').coupleId, null);
});

test('bind.cancel：creator 可取消、applicant 可取消，第三方 FORBIDDEN，已绑定 ALREADY_BOUND', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB'), userDoc('oC')],
    bind_invites: [seedInvite({ _id: '121212', code: '121212', creatorOpenid: 'oA' })],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');
  const ctxC = makeCtx(fake, 'oC');

  await bind.apply({ code: '121212' }, ctxB);
  await assert.rejects(() => bind.cancel({ code: '121212' }, ctxC), { code: 'FORBIDDEN' });
  const cancelled = await bind.cancel({ code: '121212' }, ctxA);
  assert.deepStrictEqual(cancelled, { state: 'unbound' });
  assert.strictEqual(fake.get('bind_invites', '121212').status, 'cancelled');
  assert.deepStrictEqual(await bind.status({}, ctxB), { state: 'unbound', pending: null });

  // applicant 取消自己的申请
  const fake2 = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({ _id: '131313', code: '131313', creatorOpenid: 'oA' })],
  });
  const ctxB2 = makeCtx(fake2, 'oB');
  await bind.apply({ code: '131313' }, ctxB2);
  assert.deepStrictEqual(await bind.cancel({ code: '131313' }, ctxB2), { state: 'unbound' });
  assert.strictEqual(fake2.get('bind_invites', '131313').status, 'cancelled');

  // 已确认绑定后不可取消
  const fake3 = makeFakeDb({ users: [userDoc('oA'), userDoc('oB')] });
  const ctxA3 = makeCtx(fake3, 'oA');
  const ctxB3 = makeCtx(fake3, 'oB');
  const created = await bind.create({ startDate: '2024-05-20' }, ctxA3);
  await bind.apply({ code: created.code }, ctxB3);
  await bind.confirm({ code: created.code }, ctxA3);
  await assert.rejects(() => bind.cancel({ code: created.code }, ctxA3), { code: 'ALREADY_BOUND' });
});

test('bind.status 自愈：couples 文档丢失时清掉 user.coupleId 并回到 unbound', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA', { coupleId: 'c_dead' })],
    // 故意不建 couples/c_dead
  });
  const ctxA = makeCtx(fake, 'oA');
  const originalError = console.error;
  console.error = () => {};
  try {
    const res = await bind.status({}, ctxA);
    assert.deepStrictEqual(res, { state: 'unbound', pending: null });
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
});

test('bind.create 校验：未设置昵称 / 已绑定 / 开始日期非法都报文档约定的错误码', async () => {
  const noName = makeFakeDb({ users: [userDoc('oNew', { nickname: '', profileComplete: false })] });
  await assert.rejects(
    () => bind.create({ startDate: '2024-05-20' }, makeCtx(noName, 'oNew')),
    { code: 'PROFILE_REQUIRED' },
  );

  const bound = makeFakeDb({
    users: [userDoc('oA', { coupleId: 'c_1' })],
    couples: [{ _id: 'c_1', memberOpenids: ['oA', 'oB'], startDate: '2024-05-20', status: 'active' }],
  });
  await assert.rejects(
    () => bind.create({ startDate: '2024-05-20' }, makeCtx(bound, 'oA')),
    { code: 'ALREADY_BOUND' },
  );

  const fake = makeFakeDb({ users: [userDoc('oA')] });
  const ctxA = makeCtx(fake, 'oA');
  const invalid = [
    undefined,
    null,
    '',
    '2024-5-20',
    '20240520',
    20240520,
    '1999-12-31',
    '2999-01-01',
    '2024-02-30',
    '2024-05-20 ',
  ];
  for (const bad of invalid) {
    await assert.rejects(
      () => bind.create({ startDate: bad }, ctxA),
      { code: 'START_DATE_INVALID' },
      '应拒绝开始日期：' + JSON.stringify(bad),
    );
  }
  assert.strictEqual(fake.all('bind_invites').length, 0);

  // 边界值：2000-01-01 与今天都能用
  const min = await bind.create({ startDate: '2000-01-01' }, ctxA);
  assert.strictEqual(min.startDate, '2000-01-01');
  const regen = await bind.create({ startDate: TODAY, regenerate: true }, ctxA);
  assert.strictEqual(regen.startDate, TODAY);
});

test('bind.preview 已绑定用户直接 ALREADY_BOUND', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB', { coupleId: 'c_1' })],
    couples: [{ _id: 'c_1', memberOpenids: ['oB', 'oX'], startDate: '2024-05-20', status: 'active' }],
    bind_invites: [seedInvite({ _id: '141414', code: '141414', creatorOpenid: 'oA' })],
  });
  await assert.rejects(
    () => bind.preview({ code: '141414' }, makeCtx(fake, 'oB')),
    { code: 'ALREADY_BOUND' },
  );
  // 没绑定的人可以正常预览
  const ctxC = makeCtx(fake, 'oC');
  const res = await bind.preview({ code: '141414' }, ctxC);
  assert.strictEqual(res.creator.nickname, '用户oA');
});

test('bind.status 生成邀请码但还没人申请时返回 code_created，other 为 null', async () => {
  const fake = makeFakeDb({ users: [userDoc('oA')] });
  const ctxA = makeCtx(fake, 'oA');
  const created = await bind.create({ startDate: '2024-05-20' }, ctxA);

  const res = await bind.status({}, ctxA);
  assert.strictEqual(res.state, 'code_created');
  assert.deepStrictEqual(res.pending, {
    code: created.code,
    role: 'creator',
    status: 'open',
    startDate: '2024-05-20',
    expiresAt: created.expiresAt,
    other: null,
  });
});

test('bind.cancel 边界：申请人没申请过不能取消，已作废的码报 INVITE_USED', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [
      seedInvite({ _id: '515151', code: '515151', creatorOpenid: 'oA' }),
      seedInvite({ _id: '525252', code: '525252', creatorOpenid: 'oA', status: 'cancelled' }),
    ],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');

  // oB 还没申请这个码，不能以申请人身份取消
  await assert.rejects(() => bind.cancel({ code: '515151' }, ctxB), { code: 'FORBIDDEN' });
  await assert.rejects(() => bind.cancel({ code: '909090' }, ctxB), { code: 'INVITE_NOT_FOUND' });
  assert.strictEqual(fake.get('bind_invites', '515151').status, 'open');
  // creator 取消已经作废的码
  await assert.rejects(() => bind.cancel({ code: '525252' }, ctxA), { code: 'INVITE_USED' });
});

test('bind.confirm 幂等分支数据异常：邀请已 confirmed 但 couple 丢失时不能返回假关系', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    // invite 指向的 couple 不存在
    bind_invites: [seedInvite({
      _id: '616161', code: '616161', creatorOpenid: 'oA', applicantOpenid: 'oB',
      status: 'confirmed', coupleId: 'c_missing', confirmedAt: NOW,
    })],
  });
  await assert.rejects(
    () => bind.confirm({ code: '616161' }, makeCtx(fake, 'oA')),
    { code: 'INVITE_USED' },
  );
});

test('bind.confirm 事务内重校验：creator 已绑定时报 ALREADY_BOUND，不写 couple', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA', { coupleId: 'c_x' }), userDoc('oB')],
    couples: [{ _id: 'c_x', memberOpenids: ['oA', 'oZ'], startDate: '2024-01-01', status: 'active' }],
    bind_invites: [seedInvite({
      _id: '717171', code: '717171', creatorOpenid: 'oA', applicantOpenid: 'oB', status: 'applied',
    })],
  });
  await assert.rejects(
    () => bind.confirm({ code: '717171' }, makeCtx(fake, 'oA')),
    { code: 'ALREADY_BOUND' },
  );
  assert.deepStrictEqual(fake.all('couples').map((c) => c._id), ['c_x']);
  assert.strictEqual(fake.get('users', 'oB').coupleId, null);
});

test('bind.apply 事务内重校验：creator 在预检后被别人抢走时不再写 applied', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oC')],
    bind_invites: [seedInvite({ _id: '818181', code: '818181', creatorOpenid: 'oA' })],
  });
  const ctxC = makeCtx(fake, 'oC');

  const original = fake.db.runTransaction;
  fake.db.runTransaction = async (fn) => {
    // 模拟预检通过后、事务提交前，creator 和别人绑定了
    await fake.db.collection('users').doc('oA').update({ data: { coupleId: 'c_theirs' } });
    return original(fn);
  };

  await assert.rejects(() => bind.apply({ code: '818181' }, ctxC), { code: 'INVITE_USED' });
  assert.strictEqual(fake.get('bind_invites', '818181').status, 'open');
});

test('confirm 事务回滚：couples 写完、第一次 users.update 失败时整体回滚', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({
      _id: '919191', code: '919191', creatorOpenid: 'oA', applicantOpenid: 'oB', status: 'applied',
    })],
  });
  const ctxA = makeCtx(fake, 'oA');
  injectUsersUpdateFailure(fake, 1);

  await assert.rejects(() => bind.confirm({ code: '919191' }, ctxA), /injected users.update failure/);

  // 事务里 couples.set 已经执行过，失败后必须回滚干净
  assert.strictEqual(fake.all('couples').length, 0);
  const invite = fake.get('bind_invites', '919191');
  assert.strictEqual(invite.status, 'applied');
  assert.strictEqual(invite.coupleId, null);
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
  assert.strictEqual(fake.get('users', 'oB').coupleId, null);
});

test('confirm 事务回滚：第二次 users.update 失败时，先写的一方也回滚', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({
      _id: '929292', code: '929292', creatorOpenid: 'oA', applicantOpenid: 'oB', status: 'applied',
    })],
  });
  const ctxA = makeCtx(fake, 'oA');
  injectUsersUpdateFailure(fake, 2);

  await assert.rejects(() => bind.confirm({ code: '929292' }, ctxA), /injected users.update failure/);

  assert.strictEqual(fake.all('couples').length, 0);
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
  assert.strictEqual(fake.get('users', 'oB').coupleId, null);
  assert.strictEqual(fake.get('bind_invites', '929292').status, 'applied');
});

test('confirm 事务内重校验：预检后邀请过期不再生成 couple', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({
      _id: '939393', code: '939393', creatorOpenid: 'oA', applicantOpenid: 'oB', status: 'applied',
    })],
  });
  const ctxA = makeCtx(fake, 'oA');
  const original = fake.db.runTransaction;
  fake.db.runTransaction = async (fn) => {
    // 模拟「预检通过后、事务提交前，时间跨过邀请有效期」
    await fake.db.collection('bind_invites').doc('939393').update({
      data: { expiresAt: new Date(NOW.getTime() - HOUR_MS) },
    });
    return original(fn);
  };

  await assert.rejects(() => bind.confirm({ code: '939393' }, ctxA), {
    code: 'INVITE_EXPIRED',
    message: '邀请码过期了',
  });
  assert.strictEqual(fake.all('couples').length, 0);
  assert.strictEqual(fake.get('users', 'oA').coupleId, null);
});

test('apply 事务内重校验：预检后邀请过期不再写 applied', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({ _id: '949494', code: '949494', creatorOpenid: 'oA' })],
  });
  const ctxB = makeCtx(fake, 'oB');
  const original = fake.db.runTransaction;
  fake.db.runTransaction = async (fn) => {
    await fake.db.collection('bind_invites').doc('949494').update({
      data: { expiresAt: new Date(NOW.getTime() - HOUR_MS) },
    });
    return original(fn);
  };

  await assert.rejects(() => bind.apply({ code: '949494' }, ctxB), {
    code: 'INVITE_EXPIRED',
    message: '邀请码过期了，让 TA 重新生成',
  });
  const invite = fake.get('bind_invites', '949494');
  assert.strictEqual(invite.status, 'open');
  assert.strictEqual(invite.applicantOpenid, null);
});

/**
 * 让 newInviteCode() 依次返回指定邀请码，用于覆盖「_id 冲突 → 重试」分支
 * （正常路径码由 crypto 随机生成，无法稳定构造冲突）。返回恢复函数。
 */
function stubInviteCodes(codes) {
  const original = crypto.randomBytes;
  let index = 0;
  crypto.randomBytes = (len) => {
    const code = codes[Math.min(index, codes.length - 1)];
    index += 1;
    // 按调用方要的长度返回，避免以后别处用 randomBytes(16) 时静默拿到 4 字节
    const size = typeof len === 'number' && len > 0 ? len : 4;
    const buf = Buffer.alloc(size);
    if (size >= 4) buf.writeUInt32BE(Number(code) % 1000000, 0);
    else buf.fill(Number(code) % 256);
    return buf;
  };
  return () => { crypto.randomBytes = original; };
}

test('create 邀请码冲突时重试，成功且日志不含完整邀请码', async (t) => {
  const fake = makeFakeDb({ users: [userDoc('oA', { nickname: '小怡' }), userDoc('oB', { nickname: '阿安' })] });
  const created = await bind.create({ startDate: '2024-05-20' }, makeCtx(fake, 'oA'));
  const takenCode = created.code;
  const uniqueCode = takenCode === '123456' ? '654321' : '123456';

  const logs = captureConsoleError(t);
  const restore = stubInviteCodes([takenCode, uniqueCode]);
  let second;
  try {
    second = await bind.create({ startDate: '2024-05-20' }, makeCtx(fake, 'oB'));
  } finally {
    restore();
  }

  assert.strictEqual(second.code, uniqueCode);
  assert.strictEqual(second.state, 'code_created');
  assert.strictEqual(fake.all('bind_invites').length, 2);
  assert.strictEqual(fake.get('bind_invites', uniqueCode).creatorOpenid, 'oB');
  // A 的邀请没有被覆盖
  assert.strictEqual(fake.get('bind_invites', takenCode).creatorOpenid, 'oA');

  assert.strictEqual(logs.length, 1, '只应记录一次冲突');
  const logged = JSON.parse(logs[0][1]);
  assert.deepStrictEqual(Object.keys(logged).sort(), ['attempt', 'errCode']);
  assert.strictEqual(logged.attempt, 1);
  assert.strictEqual(logged.errCode, -502001);
  assert.ok(Object.values(logged).every((value) => typeof value !== 'string'), '日志不能带出邀请码等字符串');
});

test('create 连续 5 次邀请码冲突后返回 INTERNAL_ERROR，不产生脏邀请', async (t) => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({ _id: '482913', code: '482913', creatorOpenid: 'oA' })],
  });
  const logs = captureConsoleError(t);
  const restore = stubInviteCodes(['482913']);
  try {
    await assert.rejects(() => bind.create({ startDate: '2024-05-20' }, makeCtx(fake, 'oB')), {
      code: 'INTERNAL_ERROR',
      message: '邀请码生成失败，请稍后再试',
    });
  } finally {
    restore();
  }

  // 只有 A 那条种子邀请，B 没有留下任何半成品
  assert.strictEqual(fake.all('bind_invites').length, 1);
  assert.strictEqual(fake.get('bind_invites', '482913').status, 'open');
  assert.strictEqual(fake.get('bind_invites', '482913').creatorOpenid, 'oA');

  assert.deepStrictEqual(logs.map((args) => JSON.parse(args[1])), [
    { attempt: 1, errCode: -502001 },
    { attempt: 2, errCode: -502001 },
    { attempt: 3, errCode: -502001 },
    { attempt: 4, errCode: -502001 },
    { attempt: 5, errCode: -502001 },
  ]);
});

test('bind.status: couples 读故障必须抛出，不能把 coupleId 重置成 null', async (t) => {
  const logs = captureConsoleError(t);
  const fake = makeFakeDb({
    users: [userDoc('oA', { coupleId: 'c_1' })],
    couples: [{
      _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2024-05-20',
    }],
  });
  const ctx = makeCtx(fake, 'oA');
  const realCollection = fake.db.collection.bind(fake.db);
  fake.db.collection = (name) => {
    const col = realCollection(name);
    if (name !== 'couples') return col;
    return Object.assign({}, col, {
      doc(id) {
        return Object.assign({}, col.doc(id), {
          async get() {
            throw Object.assign(new Error('database timeout'), { errCode: -501001 });
          },
        });
      },
    });
  };

  await assert.rejects(
    () => bind.status({}, ctx),
    (err) => err.message === 'database timeout',
    '读故障要上抛，不能当成关系不存在');
  assert.strictEqual(fake.get('users', 'oA').coupleId, 'c_1', '瞬时报错不能清 coupleId');
  assert.strictEqual(logs.length, 0, '不能走自愈分支（不打 couple missing 日志）');
});

test('bind.apply: 读被邀请人资料故障要上抛，不能被当成邀请码已用过（不记失败）', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({ _id: '777777', code: '777777', creatorOpenid: 'oA' })],
  });
  const ctxB = makeCtx(fake, 'oB');
  const realCollection = fake.db.collection.bind(fake.db);
  fake.db.collection = (name) => {
    const col = realCollection(name);
    if (name !== 'users') return col;
    return Object.assign({}, col, {
      doc(id) {
        return Object.assign({}, col.doc(id), {
          async get() {
            throw Object.assign(new Error('database timeout'), { errCode: -501001 });
          },
        });
      },
    });
  };

  await assert.rejects(
    () => bind.apply({ code: '777777' }, ctxB),
    (err) => err.message === 'database timeout',
    '读故障不能被翻译成 INVITE_USED');
  assert.strictEqual(fake.get('users', 'oB').bindFailCount, 0, '读故障不能计一次绑定失败');
  assert.strictEqual(fake.get('users', 'oB').bindFailResetAt, null);
  assert.strictEqual(fake.get('bind_invites', '777777').status, 'open');
});

test('bind.preview: creator 文档真实缺失时按 INVITE_USED 处理并计一次失败', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oB')], // oA 的资料不存在
    bind_invites: [seedInvite({ _id: '888888', code: '888888', creatorOpenid: 'oA' })],
  });
  const ctxB = makeCtx(fake, 'oB');

  await assert.rejects(() => bind.preview({ code: '888888' }, ctxB), (err) => {
    assert.strictEqual(err.code, 'INVITE_USED');
    return true;
  });
  assert.strictEqual(fake.get('users', 'oB').bindFailCount, 1);
});

test('bind.preview / bind.confirm / bind.cancel: 邀请文档读故障要上抛，不能当成「码不存在」', async () => {
  const fake = makeFakeDb({
    users: [userDoc('oA'), userDoc('oB')],
    bind_invites: [seedInvite({ _id: '999999', code: '999999', creatorOpenid: 'oA' })],
  });
  const ctxA = makeCtx(fake, 'oA');
  const ctxB = makeCtx(fake, 'oB');
  const realCollection = fake.db.collection.bind(fake.db);
  fake.db.collection = (name) => {
    const col = realCollection(name);
    if (name !== 'bind_invites') return col;
    return Object.assign({}, col, {
      doc(id) {
        return Object.assign({}, col.doc(id), {
          async get() {
            throw Object.assign(new Error('database timeout'), { errCode: -501001 });
          },
        });
      },
    });
  };

  await assert.rejects(() => bind.preview({ code: '999999' }, ctxB),
    (err) => err.message === 'database timeout', '预览不能把读故障翻译成 INVITE_NOT_FOUND');
  assert.strictEqual(fake.get('users', 'oB').bindFailCount, 0, '读故障不能计绑定失败');

  await assert.rejects(() => bind.confirm({ code: '999999' }, ctxA),
    (err) => err.message === 'database timeout', '确认不能把读故障翻译成 INVITE_NOT_FOUND');

  await assert.rejects(() => bind.cancel({ code: '999999' }, ctxA),
    (err) => err.message === 'database timeout', '取消不能把读故障翻译成 INVITE_NOT_FOUND');

  fake.db.collection = realCollection;
  const applied = await bind.apply({ code: '999999' }, ctxB);
  assert.strictEqual(applied.state, 'applied_by_me');
});
