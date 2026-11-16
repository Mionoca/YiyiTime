'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { updateStartDate } = require('../cloudfunctions/api/handlers/couple');

/** 造一个只包含 couples 集合的假 db + 业务上下文 */
function makeCtx({ startDate = '2024-05-20', today = '2026-11-16', bound = true } = {}) {
  const now = new Date(today + 'T04:00:00.000Z'); // 东八区 12:00
  const store = { _id: 'c_1', startDate, status: 'active', memberOpenids: ['oA', 'oB'] };
  const updates = [];

  const db = {
    collection(name) {
      assert.strictEqual(name, 'couples');
      return {
        doc(id) {
          assert.strictEqual(id, 'c_1');
          return {
            update: async ({ data }) => {
              updates.push(Object.assign({}, data));
              Object.assign(store, data);
            },
            get: async () => ({ data: Object.assign({}, store) }),
          };
        },
      };
    },
  };

  const ctx = {
    openid: 'oA',
    user: { _id: 'oA', coupleId: 'c_1' },
    couple: store,
    db,
    now,
    requireBound() {
      if (!bound) {
        const err = new Error('还没有绑定');
        err.code = 'NOT_BOUND';
        throw err;
      }
    },
  };

  return { ctx, store, updates };
}

test('updateStartDate: 正常修改，返回天数和时间，并记录修改人', async () => {
  const { ctx, store, updates } = makeCtx({ today: '2026-11-16' });
  const res = await updateStartDate({ startDate: '2024-05-20' }, ctx);

  assert.strictEqual(res.startDate, '2024-05-20');
  assert.strictEqual(res.daysTogether, 911); // 2024-05-20 当天算第 1 天
  assert.strictEqual(res.updatedAt, ctx.now.toISOString());
  assert.strictEqual(store.startDate, '2024-05-20');
  assert.strictEqual(store.startDateUpdatedBy, 'oA');
  assert.strictEqual(updates.length, 1);
  assert.ok(updates[0].updatedAt instanceof Date);
});

test('updateStartDate: 改成今天就是第 1 天', async () => {
  const { ctx } = makeCtx({ today: '2026-11-16' });
  const res = await updateStartDate({ startDate: '2026-11-16' }, ctx);
  assert.strictEqual(res.daysTogether, 1);
});

test('updateStartDate: 忽略客户端传来的 coupleId，只写自己的 couple 文档', async () => {
  const { ctx } = makeCtx();
  const res = await updateStartDate({ startDate: '2024-06-01', coupleId: 'c_evil' }, ctx);
  assert.strictEqual(res.startDate, '2024-06-01');
});

test('updateStartDate: 日期非法统一返回 START_DATE_INVALID', async () => {
  const cases = [
    undefined,
    null,
    '',
    20240520, // 非字符串
    '2024-05-2000', // 超长
    '2024-05-20 ', // 带空格
    '2024/05/20',
    '2024-02-30',
    '1999-12-31',
    '2099-01-01',
  ];
  for (const startDate of cases) {
    const { ctx } = makeCtx({ today: '2026-11-16' });
    await assert.rejects(
      () => updateStartDate({ startDate }, ctx),
      (err) => err.code === 'START_DATE_INVALID',
      'startDate=' + String(startDate),
    );
  }
});

test('updateStartDate: couple 文档缺 _id 时回退用 user.coupleId', async () => {
  const { ctx, store, updates } = makeCtx();
  delete store._id;
  const res = await updateStartDate({ startDate: '2024-06-01' }, ctx);
  assert.strictEqual(res.startDate, '2024-06-01');
  assert.strictEqual(updates.length, 1);
});

test('updateStartDate: 未绑定返回 NOT_BOUND，且不写库', async () => {
  const { ctx, updates } = makeCtx({ bound: false });
  await assert.rejects(
    () => updateStartDate({ startDate: '2024-05-20' }, ctx),
    (err) => err.code === 'NOT_BOUND',
  );
  assert.strictEqual(updates.length, 0);
});
