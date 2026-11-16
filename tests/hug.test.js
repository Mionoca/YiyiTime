'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { send, respond, HUG_TTL_MS } = require('../cloudfunctions/api/handlers/hug');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function makeCtx({ bound = true, hugs = [] } = {}) {
  const fake = makeFakeDb({ hugs });
  return {
    ctx: {
      openid: 'oA',
      user: { _id: 'oA', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      partner: { _id: 'oB' },
      db: fake.db,
      now: NOW,
      requireBound() {
        if (!bound) {
          const err = new Error('还没有绑定');
          err.code = 'NOT_BOUND';
          throw err;
        }
      },
    },
    fake,
  };
}

function pendingDoc(overrides) {
  return Object.assign({
    _id: 'h_aaaaaaaaaaaaaaaa',
    coupleId: 'c_1',
    fromOpenid: 'oA',
    toOpenid: 'oB',
    status: 'pending',
    createdAt: new Date(NOW.getTime() - 60 * 1000),
    respondedAt: null,
    expiresAt: new Date(NOW.getTime() + WEEK_MS),
  }, overrides);
}

test('hug.send: 没有 pending 时创建，7 天后过期，接收者是伴侣', async () => {
  const { ctx, fake } = makeCtx();
  const res = await send({}, ctx);

  assert.strictEqual(res.existing, false);
  assert.strictEqual(res.hug.status, 'pending');
  assert.match(res.hug.hugId, /^h_[0-9a-f]{16}$/);
  assert.strictEqual(res.hug.createdAt, NOW.toISOString());
  assert.strictEqual(res.hug.respondedAt, null);
  assert.strictEqual(res.hug.expiresAt, new Date(NOW.getTime() + HUG_TTL_MS).toISOString());
  assert.strictEqual(HUG_TTL_MS, WEEK_MS);

  const doc = fake.get('hugs', res.hug.hugId);
  assert.ok(doc);
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(doc.fromOpenid, 'oA');
  assert.strictEqual(doc.toOpenid, 'oB');
  assert.strictEqual(doc.status, 'pending');
  assert.strictEqual(doc.respondedAt, null);
  assert.strictEqual(doc.expiresAt.getTime(), NOW.getTime() + WEEK_MS);
});

test('hug.send: 已有未过期 pending 时返回原记录，不新增', async () => {
  const existing = pendingDoc({ _id: 'h_bbbbbbbbbbbbbbbb' });
  const { ctx, fake } = makeCtx({ hugs: [existing] });
  const res = await send({}, ctx);

  assert.strictEqual(res.existing, true);
  assert.strictEqual(res.hug.hugId, 'h_bbbbbbbbbbbbbbbb');
  assert.strictEqual(fake.all('hugs').length, 1);
});

test('hug.send: 过期 pending 惰性置 expired 后可以再发', async () => {
  const expired = pendingDoc({
    _id: 'h_cccccccccccccccc',
    expiresAt: new Date(NOW.getTime() - 1000),
  });
  const { ctx, fake } = makeCtx({ hugs: [expired] });

  const res = await send({}, ctx);
  assert.strictEqual(res.existing, false);
  assert.notStrictEqual(res.hug.hugId, 'h_cccccccccccccccc');
  assert.strictEqual(fake.get('hugs', 'h_cccccccccccccccc').status, 'expired');
  assert.strictEqual(fake.all('hugs').length, 2);
});

test('hug.send: 未绑定返回 NOT_BOUND 且不写库', async () => {
  const { ctx, fake } = makeCtx({ bound: false });
  await assert.rejects(
    () => send({}, ctx),
    (err) => err.code === 'NOT_BOUND',
  );
  assert.strictEqual(fake.all('hugs').length, 0);
});

test('hug.respond: 接收者回应 pending，写 respondedAt', async () => {
  const hug = pendingDoc({ _id: 'h_dddddddddddddddd', fromOpenid: 'oB', toOpenid: 'oA' });
  const { ctx, fake } = makeCtx({ hugs: [hug] });
  const res = await respond({ hugId: hug._id }, ctx);

  assert.deepStrictEqual(res, {
    hugId: hug._id,
    status: 'hugged',
    respondedAt: NOW.toISOString(),
    already: false,
  });
  const doc = fake.get('hugs', hug._id);
  assert.strictEqual(doc.status, 'hugged');
  assert.strictEqual(doc.respondedAt.toISOString(), NOW.toISOString());
});

test('hug.respond: 已回应的抱抱幂等返回 already=true，不覆盖时间', async () => {
  const respondedAt = new Date('2026-11-15T01:00:00.000Z');
  const hug = pendingDoc({
    _id: 'h_eeeeeeeeeeeeeeee',
    fromOpenid: 'oB',
    toOpenid: 'oA',
    status: 'hugged',
    respondedAt,
  });
  const { ctx, fake } = makeCtx({ hugs: [hug] });
  const res = await respond({ hugId: hug._id }, ctx);

  assert.strictEqual(res.already, true);
  assert.strictEqual(res.status, 'hugged');
  assert.strictEqual(res.respondedAt, respondedAt.toISOString());
  assert.strictEqual(fake.get('hugs', hug._id).respondedAt.toISOString(), respondedAt.toISOString());
});

test('hug.respond: 不存在 / 空 hugId 返回 HUG_NOT_FOUND', async () => {
  for (const payload of [{ hugId: 'h_notexist' }, {}, { hugId: '   ' }]) {
    const { ctx } = makeCtx();
    await assert.rejects(
      () => respond(payload, ctx),
      (err) => err.code === 'HUG_NOT_FOUND',
      JSON.stringify(payload),
    );
  }
});

test('hug.respond: 非接收者返回 HUG_NOT_RECIPIENT', async () => {
  const hug = pendingDoc({ _id: 'h_ffffffffffffffff' }); // toOpenid 是 oB
  const { ctx } = makeCtx({ hugs: [hug] });
  await assert.rejects(
    () => respond({ hugId: hug._id }, ctx),
    (err) => err.code === 'HUG_NOT_RECIPIENT',
  );
});

test('hug.respond: 过期 pending 返回 HUG_EXPIRED 并置为 expired', async () => {
  const hug = pendingDoc({
    _id: 'h_1111111111111111',
    fromOpenid: 'oB',
    toOpenid: 'oA',
    expiresAt: new Date(NOW.getTime() - 1000),
  });
  const { ctx, fake } = makeCtx({ hugs: [hug] });
  await assert.rejects(
    () => respond({ hugId: hug._id }, ctx),
    (err) => err.code === 'HUG_EXPIRED',
  );
  assert.strictEqual(fake.get('hugs', hug._id).status, 'expired');
});

test('hug.respond: 已是 expired 状态返回 HUG_EXPIRED', async () => {
  const hug = pendingDoc({ _id: 'h_2222222222222222', fromOpenid: 'oB', toOpenid: 'oA', status: 'expired' });
  const { ctx } = makeCtx({ hugs: [hug] });
  await assert.rejects(
    () => respond({ hugId: hug._id }, ctx),
    (err) => err.code === 'HUG_EXPIRED',
  );
});

test('hug.respond: 别的 couple 的抱抱按 HUG_NOT_FOUND 处理', async () => {
  const hug = pendingDoc({ _id: 'h_3333333333333333', coupleId: 'c_other', fromOpenid: 'oX', toOpenid: 'oA' });
  const { ctx } = makeCtx({ hugs: [hug] });
  await assert.rejects(
    () => respond({ hugId: hug._id }, ctx),
    (err) => err.code === 'HUG_NOT_FOUND',
  );
});
