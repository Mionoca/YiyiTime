'use strict';

// 自定义纪念日（文档 5.3.5 / 7.7 / 8.3.9）：
// 「在一起」不在这个 handler 里（由 couple.startDate 推导），这里只管用户加的那些。
const test = require('node:test');
const assert = require('node:assert');

const anniversary = require('../cloudfunctions/api/handlers/anniversary');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 2026-11-16 12:00
const TODAY = '2026-11-16';

function makeCtx({ bound = true, items = [] } = {}) {
  const fake = makeFakeDb({ anniversaries: items });
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

function doc(overrides) {
  return Object.assign({
    _id: 'a_aaaaaaaaaaaaaaaa',
    coupleId: 'c_1',
    title: '第一次见面',
    date: '2023-06-01',
    createdBy: 'oA',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  }, overrides);
}

test('anniversary.add: 落盘字段正确，剩余天数与周年按服务端 todayKey 现算', async () => {
  const { ctx, fake } = makeCtx();
  const res = await anniversary.add({ title: '第一次见面', date: '2023-06-01' }, ctx);

  assert.match(res.item.anniversaryId, /^a_[0-9a-f]{16}$/);
  assert.strictEqual(res.item.title, '第一次见面');
  assert.strictEqual(res.item.date, '2023-06-01');
  // 2026-06-01 已过 → 下一次是 2027-06-01，距离 2026-11-16 还有 197 天
  assert.strictEqual(res.item.nextDate, '2027-06-01');
  assert.strictEqual(res.item.daysLeft, 197);
  assert.strictEqual(res.item.years, 4);

  const saved = fake.get('anniversaries', res.item.anniversaryId);
  assert.strictEqual(saved.coupleId, 'c_1');
  assert.strictEqual(saved.createdBy, 'oA');
  assert.strictEqual(saved.title, '第一次见面');
  assert.strictEqual(saved.date, '2023-06-01');
  // nextDate / daysLeft 每天都会变，禁止落库
  assert.strictEqual(saved.nextDate, undefined);
  assert.strictEqual(saved.daysLeft, undefined);
});

test('anniversary.add: 当天就是纪念日时 daysLeft 为 0，页面显示「就是今天」', async () => {
  const { ctx } = makeCtx();
  const res = await anniversary.add({ title: '今天', date: '2020-11-16' }, ctx);
  assert.strictEqual(res.item.nextDate, TODAY);
  assert.strictEqual(res.item.daysLeft, 0);
  assert.strictEqual(res.item.years, 6);
});

test('anniversary.add: 未来的日期允许记，years 为 0', async () => {
  const { ctx } = makeCtx();
  const res = await anniversary.add({ title: '婚礼', date: '2027-05-20' }, ctx);
  assert.strictEqual(res.item.nextDate, '2027-05-20');
  assert.strictEqual(res.item.daysLeft, 185);
  assert.strictEqual(res.item.years, 0);
});

test('anniversary.add: 标题必填、超长、纯空白都拒收', async () => {
  const { ctx, fake } = makeCtx();
  await assert.rejects(
    () => anniversary.add({ date: '2023-06-01' }, ctx),
    (err) => err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => anniversary.add({ title: '   ', date: '2023-06-01' }, ctx),
    (err) => err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => anniversary.add({ title: '一二三四五六七八九十一二三', date: '2023-06-01' }, ctx),
    (err) => err.code === 'TEXT_TOO_LONG'
  );
  assert.strictEqual(fake.all('anniversaries').length, 0);
});

test('anniversary.add: 日期必须是真实存在且在 2000-01-01 ~ 2099-12-31 之间', async () => {
  const { ctx, fake } = makeCtx();
  for (const date of ['2023-02-30', '1999-12-31', '2100-01-01', '2023/06/01', '', undefined]) {
    await assert.rejects(
      () => anniversary.add({ title: '纪念日', date }, ctx),
      (err) => err.code === 'INVALID_INPUT',
      'date=' + String(date)
    );
  }
  assert.strictEqual(fake.all('anniversaries').length, 0);
});

test('anniversary.add: 第 9 个返回 ANNIVERSARY_LIMIT_REACHED（上限 8）', async () => {
  const items = [];
  for (let i = 0; i < 8; i += 1) {
    items.push(doc({ _id: 'a_' + String(i).repeat(16).slice(0, 16), date: '2023-0' + ((i % 9) + 1) + '-01' }));
  }
  const { ctx, fake } = makeCtx({ items });
  const res = await anniversary.list({}, ctx);
  assert.strictEqual(res.items.length, 8);

  await assert.rejects(
    () => anniversary.add({ title: '第九个', date: '2023-06-01' }, ctx),
    (err) => err.code === 'ANNIVERSARY_LIMIT_REACHED'
  );
  assert.strictEqual(fake.all('anniversaries').length, 8);
});

test('anniversary.add: 未绑定不能加（NOT_BOUND），也不会写库', async () => {
  const { ctx, fake } = makeCtx({ bound: false });
  await assert.rejects(
    () => anniversary.add({ title: '第一次见面', date: '2023-06-01' }, ctx),
    (err) => err.code === 'NOT_BOUND'
  );
  assert.strictEqual(fake.all('anniversaries').length, 0);
});

test('anniversary.list: 按「下一次发生」升序，同天按日期、再按创建时间', async () => {
  const { ctx } = makeCtx({
    items: [
      doc({ _id: 'a_1111111111111111', title: '晚的', date: '2020-12-01' }),
      doc({ _id: 'a_2222222222222222', title: '近的', date: '2019-11-20' }),
      doc({ _id: 'a_3333333333333333', title: '同天后建', date: '2021-11-20', createdAt: new Date('2026-02-01T00:00:00.000Z') }),
    ],
  });
  const res = await anniversary.list({}, ctx);
  assert.strictEqual(res.todayKey, TODAY);
  assert.deepStrictEqual(res.items.map((item) => item.title), ['近的', '同天后建', '晚的']);
  assert.strictEqual(res.items[0].daysLeft, 4); // 11-20
});

test('anniversary.update: 改标题与日期后重新排序，items 一次返回', async () => {
  const { ctx, fake } = makeCtx({
    items: [
      doc({ _id: 'a_1111111111111111', title: '旧名字', date: '2020-12-01' }),
      doc({ _id: 'a_2222222222222222', title: '另一个', date: '2020-01-01' }),
    ],
  });
  const res = await anniversary.update(
    { anniversaryId: 'a_1111111111111111', title: '新名字', date: '2026-11-18' },
    ctx
  );

  assert.strictEqual(res.item.title, '新名字');
  assert.strictEqual(res.item.date, '2026-11-18');
  assert.strictEqual(res.item.daysLeft, 2);
  const saved = fake.get('anniversaries', 'a_1111111111111111');
  assert.strictEqual(saved.title, '新名字');
  assert.strictEqual(saved.date, '2026-11-18');
  assert.strictEqual(res.items.length, 2);
});

test('anniversary.update: 至少改一个字段；不存在的 id / 别家的记录分别报 NOT_FOUND / FORBIDDEN', async () => {
  const { ctx } = makeCtx({ items: [doc({ _id: 'a_2222222222222222', coupleId: 'c_other' })] });

  await assert.rejects(
    () => anniversary.update({ anniversaryId: 'a_2222222222222222' }, ctx),
    (err) => err.code === 'INVALID_INPUT'
  );
  await assert.rejects(
    () => anniversary.update({ anniversaryId: 'a_9999999999999999', title: 'x' }, ctx),
    (err) => err.code === 'ANNIVERSARY_NOT_FOUND'
  );
  await assert.rejects(
    () => anniversary.update({ anniversaryId: 'a_2222222222222222', title: 'x' }, ctx),
    (err) => err.code === 'FORBIDDEN'
  );
});

test('anniversary.remove: 删除成功返回 removed + 剩余列表；空 id / 不存在是幂等的 false', async () => {
  const { ctx, fake } = makeCtx({
    items: [
      doc({ _id: 'a_1111111111111111' }),
      doc({ _id: 'a_2222222222222222', date: '2020-01-02' }),
    ],
  });

  const res = await anniversary.remove({ anniversaryId: 'a_1111111111111111' }, ctx);
  assert.strictEqual(res.removed, true);
  assert.strictEqual(res.items.length, 1);
  assert.ok(!fake.get('anniversaries', 'a_1111111111111111'), '删掉后不该还在库里');

  const again = await anniversary.remove({ anniversaryId: 'a_1111111111111111' }, ctx);
  assert.strictEqual(again.removed, false);

  const empty = await anniversary.remove({}, ctx);
  assert.strictEqual(empty.removed, false);
  assert.strictEqual(empty.items.length, 1);
});

test('anniversary.remove: 别家的记录删不掉（FORBIDDEN）', async () => {
  const { ctx, fake } = makeCtx({ items: [doc({ _id: 'a_2222222222222222', coupleId: 'c_other' })] });
  await assert.rejects(
    () => anniversary.remove({ anniversaryId: 'a_2222222222222222' }, ctx),
    (err) => err.code === 'FORBIDDEN'
  );
  assert.ok(fake.get('anniversaries', 'a_2222222222222222'));
});

test('anniversary.list: 2 月 29 日在平年按 2 月最后一天算', async () => {
  const now = new Date('2027-02-10T04:00:00.000Z'); // 2027 平年
  const { ctx } = makeCtx({ items: [doc({ _id: 'a_1111111111111111', date: '2024-02-29' })] });
  ctx.now = now;
  const res = await anniversary.list({}, ctx);
  assert.strictEqual(res.todayKey, '2027-02-10');
  assert.strictEqual(res.items[0].nextDate, '2027-02-28');
  assert.strictEqual(res.items[0].daysLeft, 18);
});
