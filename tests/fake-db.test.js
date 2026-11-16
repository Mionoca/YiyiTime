'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { makeFakeDb } = require('./helpers/fake-db');

/**
 * fake-db 的 $inc 行为要贴近真实云数据库（MongoDB），否则未来误用会被假绿掩盖：
 * 缺失字段按 0 累加、数字字段累加、非数字字段直接报错。
 */
test('fake-db: $inc 对缺失字段按 0 累加，对数字字段累加', async () => {
  const fake = makeFakeDb({ users: [{ _id: 'oA', bet: 2 }] });
  const update = (data) => fake.db.collection('users').doc('oA').update({ data });

  await update({ missing: fake.db.command.inc(1) });
  assert.strictEqual(fake.get('users', 'oA').missing, 1);

  await update({ bet: fake.db.command.inc(3) });
  assert.strictEqual(fake.get('users', 'oA').bet, 5);
});

test('fake-db: $inc 对已存在的非数字字段抛错（贴近真实 MongoDB）', async () => {
  const fake = makeFakeDb({ users: [{ _id: 'oA', bindFailCount: '3' }] });
  await assert.rejects(
    () => fake.db.collection('users').doc('oA').update({
      data: { bindFailCount: fake.db.command.inc(1) },
    }),
    /Cannot apply \$inc to a value of non-numeric type/,
    '对字符串字段 $inc 必须报错，不能静默加 1',
  );
  // 失败后原值不能被改动
  assert.strictEqual(fake.get('users', 'oA').bindFailCount, '3');
});

test('fake-db: update 文档不存在时返回 stats.updated=0（与真实云开发一致）', async () => {
  const fake = makeFakeDb({});
  const res = await fake.db.collection('users').doc('oMissing').update({ data: { nickname: '小怡' } });
  assert.deepStrictEqual(res, { stats: { updated: 0 } });
  assert.strictEqual(fake.get('users', 'oMissing'), undefined);
});

/**
 * 单次 get 的 100 条上限是云函数的真实约束（home-blocks.loadSafety 的回归用例依赖它），
 * 在 fake-db 自身锁一次，避免将来改默认值后回归静默失效。
 */
test('fake-db: 单次 get 默认最多返回 100 条（与云函数上限一致）', async () => {
  const rows = [];
  for (let i = 0; i < 120; i += 1) rows.push({ _id: 'd' + i, coupleId: 'c_1', openid: 'oA' });
  const fake = makeFakeDb({ safety_checkins: rows });
  const res = await fake.db.collection('safety_checkins').where({ coupleId: 'c_1' }).get();
  assert.strictEqual(res.data.length, 100, '默认 get 必须封顶 100 条');
});