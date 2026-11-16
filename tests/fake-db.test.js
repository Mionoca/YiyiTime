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

/**
 * 操作钩子是查询预算测试的计数底座；七个 notify 点任何一个被删都会静默少计，
 * 单测锁住「每类真实读写各触发一次且集合名透传、链式构造不触发、事务内计数、
 * 读不存在的文档（抛错路径）也计数、可关闭」。
 */
test('fake-db: 操作钩子对七类读写各触发一次，链式构造不触发，可关闭', async () => {
  const fake = makeFakeDb({
    users: [{ _id: 'oA', nickname: '小怡' }],
    couples: [{ _id: 'c_1', startDate: '2024-05-20' }],
  });
  const ops = [];
  fake.setOperationHook((name, op) => ops.push(name + ':' + op));
  const users = fake.db.collection('users');
  const couples = fake.db.collection('couples');

  // 七类操作分散在 users / couples 两个集合上，顺便锁集合名透传（写死 'users' 会被抓）
  await users.doc('oA').get();
  await couples.doc('c_1').update({ data: { startDate: '2024-05-21' } });
  await users.doc('oB').set({ data: { nickname: '小乙' } });
  await couples.doc('c_1').remove();
  await users.add({ data: { nickname: '小丙' } });
  await couples.where({}).get();
  await users.where({ nickname: '小丙' }).count();
  assert.deepStrictEqual(ops, [
    'users:doc.get', 'couples:doc.update', 'users:doc.set', 'couples:doc.remove',
    'users:add', 'couples:where.get', 'users:where.count',
  ], '七类真实读写必须各触发一次钩子，且集合名透传不能写死');

  // 只拼链式查询不执行时不计数
  users.where({}).orderBy('nickname', 'asc').limit(1);
  assert.strictEqual(ops.length, 7, '链式构造不能触发计数');

  // 事务内复用同一 collection，读也要计数（否则事务读写会绕过预算统计）
  await fake.db.runTransaction(async (tx) => {
    await tx.collection('users').doc('oA').get();
  });
  assert.deepStrictEqual(ops.slice(7), ['users:doc.get'], '事务内读必须计数');

  // 读不存在的文档要抛错，但钩子必须在读取前触发（抛错路径也计数，供预算统计）
  await assert.rejects(users.doc('oMissing').get());
  assert.deepStrictEqual(ops.slice(8), ['users:doc.get'], '读不存在文档的抛错路径也要计数');

  // 关闭钩子后不再计数
  fake.setOperationHook(null);
  await users.doc('oA').get();
  assert.strictEqual(ops.length, 9, 'setOperationHook(null) 后必须停止计数');
});
