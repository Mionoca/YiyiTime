'use strict';

/**
 * mood.list（文档 7.6）：心情记录时间线。
 * 关注点：两人当天合并、按天倒序、以「天」为粒度分页（nextBeforeDate 不含上界）、
 * 跨对隔离、未绑定拒绝、以及「多取一条」正好能判断有没有更早的一天。
 */
const test = require('node:test');
const assert = require('node:assert');

const { list } = require('../cloudfunctions/api/handlers/mood');
const { AppError } = require('../cloudfunctions/api/lib/errors');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 12:00
const TODAY = '2026-11-16';
const YESTERDAY = '2026-11-15';

function moodDoc(openid, date, mood, note, updatedAt) {
  const at = updatedAt || new Date(NOW.getTime() - 3600 * 1000);
  return {
    _id: openid + '_' + date,
    coupleId: 'c_1',
    openid,
    date,
    mood,
    note: note || '',
    createdAt: at,
    updatedAt: at,
  };
}

function makeCtx({ moods = [], members = ['oA', 'oB'], bound = true, coupleId = 'c_1' } = {}) {
  const fake = makeFakeDb({ moods });
  const ctx = {
    openid: 'oA',
    user: { _id: 'oA', coupleId },
    couple: { _id: coupleId, status: 'active', memberOpenids: members },
    partner: members[1] ? { _id: members[1] } : null,
    db: fake.db,
    now: NOW,
    requireBound() {
      if (!bound) throw new AppError('NOT_BOUND', '先邀请 TA 住进来吧');
    },
  };
  return { ctx, fake };
}

test('mood.list: 把两人当天的心情合并成一条，按天倒序', async () => {
  const { ctx } = makeCtx({
    moods: [
      moodDoc('oA', TODAY, 'rainy', '今天有点累', new Date('2026-11-16T03:00:00.000Z')),
      moodDoc('oB', TODAY, 'sunny', '', new Date('2026-11-16T02:00:00.000Z')),
      moodDoc('oA', YESTERDAY, 'cloudy', '还好'),
    ],
  });

  const res = await list({}, ctx);
  assert.strictEqual(res.todayKey, TODAY);
  assert.strictEqual(res.nextBeforeDate, null);
  assert.deepStrictEqual(res.days.map((day) => day.date), [TODAY, YESTERDAY]);
  assert.deepStrictEqual(res.days[0].mine, {
    mood: 'rainy',
    note: '今天有点累',
    updatedAt: '2026-11-16T03:00:00.000Z',
  });
  assert.deepStrictEqual(res.days[0].partner, {
    mood: 'sunny',
    note: '',
    updatedAt: '2026-11-16T02:00:00.000Z',
  });
  // 昨天只有我写过，TA 是 null（不是空对象）
  assert.strictEqual(res.days[1].mine.mood, 'cloudy');
  assert.strictEqual(res.days[1].partner, null);
});

test('mood.list: 只返回展示字段，不带 openid / coupleId', async () => {
  const { ctx } = makeCtx({ moods: [moodDoc('oA', TODAY, 'sunny', '早')] });
  const res = await list({}, ctx);
  assert.deepStrictEqual(Object.keys(res.days[0]).sort(), ['date', 'mine', 'partner']);
  assert.deepStrictEqual(Object.keys(res.days[0].mine).sort(), ['mood', 'note', 'updatedAt']);
  assert.strictEqual(JSON.stringify(res).indexOf('oA'), -1);
  assert.strictEqual(JSON.stringify(res).indexOf('c_1'), -1);
});

test('mood.list: 备注缺失或脏值统一成空串，时间字段统一 ISO', async () => {
  const { ctx } = makeCtx({
    moods: [{ _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'rainy', updatedAt: '2026-11-16T01:02:03.000Z' }],
  });
  const res = await list({}, ctx);
  assert.strictEqual(res.days[0].mine.note, '');
  assert.strictEqual(res.days[0].mine.updatedAt, '2026-11-16T01:02:03.000Z');
});

test('mood.list: 以天为粒度分页，nextBeforeDate 不含上界、翻页不重复', async () => {
  const days = ['2026-11-16', '2026-11-15', '2026-11-14'];
  const moods = [];
  days.forEach((date) => {
    moods.push(moodDoc('oA', date, 'sunny', ''));
    moods.push(moodDoc('oB', date, 'cloudy', ''));
  });
  const { ctx } = makeCtx({ moods });

  const page1 = await list({ limit: 2 }, ctx);
  assert.deepStrictEqual(page1.days.map((day) => day.date), ['2026-11-16', '2026-11-15']);
  assert.strictEqual(page1.nextBeforeDate, '2026-11-15');

  const page2 = await list({ limit: 2, beforeDate: page1.nextBeforeDate }, ctx);
  assert.deepStrictEqual(page2.days.map((day) => day.date), ['2026-11-14']);
  assert.strictEqual(page2.nextBeforeDate, null, '最后一页不能再给游标');
});

test('mood.list: 页数刚好等于 limit 时不给多余游标（多取一条的边界）', async () => {
  const { ctx } = makeCtx({
    moods: [
      moodDoc('oA', TODAY, 'sunny', ''),
      moodDoc('oB', TODAY, 'sunny', ''),
      moodDoc('oA', YESTERDAY, 'rainy', ''),
    ],
  });
  const res = await list({ limit: 2 }, ctx);
  assert.strictEqual(res.days.length, 2);
  assert.strictEqual(res.nextBeforeDate, null, '只有两天时不该让客户端再翻一页');
});

test('mood.list: 只有一天但那天两人都打了卡，也不会误判还有更多', async () => {
  const { ctx } = makeCtx({
    moods: [moodDoc('oA', TODAY, 'sunny', ''), moodDoc('oB', TODAY, 'rainy', '')],
  });
  const res = await list({ limit: 1 }, ctx);
  assert.strictEqual(res.days.length, 1);
  assert.strictEqual(res.nextBeforeDate, null);
});

test('mood.list: limit 缺省 10，越界 / 非整数 / 0 都返回 INVALID_INPUT', async () => {
  const moods = [];
  for (let i = 0; i < 12; i += 1) {
    const d = new Date(Date.UTC(2026, 10, 16 - i));
    moods.push(moodDoc('oA', d.toISOString().slice(0, 10), 'sunny', ''));
  }
  const { ctx } = makeCtx({ moods });
  const res = await list({}, ctx);
  assert.strictEqual(res.days.length, 10, '缺省 limit 应为 10');

  for (const limit of [0, 31, -1, 1.5, '3', NaN]) {
    await assert.rejects(
      () => list({ limit }, ctx),
      (err) => err.code === 'INVALID_INPUT',
      'limit=' + String(limit),
    );
  }
  await assert.rejects(() => list({ limit: 31 }, ctx), { message: '分页条数超出范围' });
});

test('mood.list: beforeDate 非法格式返回 INVALID_INPUT', async () => {
  const { ctx } = makeCtx();
  for (const beforeDate of ['2026-13-01', '2026-02-30', '20261116', '2026-1-1', 20261116]) {
    await assert.rejects(
      () => list({ beforeDate }, ctx),
      (err) => err.code === 'INVALID_INPUT',
      'beforeDate=' + String(beforeDate),
    );
  }
});

test('mood.list: beforeDate 只返回更早的记录，且不会带出未来脏数据', async () => {
  const { ctx } = makeCtx({
    moods: [
      moodDoc('oA', '2026-11-17', 'sunny', '未来的脏数据'),
      moodDoc('oA', TODAY, 'rainy', ''),
      moodDoc('oA', YESTERDAY, 'cloudy', ''),
    ],
  });
  const def = await list({}, ctx);
  assert.deepStrictEqual(def.days.map((day) => day.date), [TODAY, YESTERDAY]);

  const older = await list({ beforeDate: TODAY }, ctx);
  assert.deepStrictEqual(older.days.map((day) => day.date), [YESTERDAY]);
});

test('mood.list: 另一对情侣的记录不会出现（跨对隔离）', async () => {
  const { ctx } = makeCtx({
    moods: [
      moodDoc('oA', TODAY, 'sunny', '我们的'),
      { _id: 'oC_' + TODAY, coupleId: 'c_2', openid: 'oC', date: TODAY, mood: 'thunder', note: '别人的', updatedAt: NOW },
    ],
  });
  const res = await list({}, ctx);
  assert.strictEqual(res.days.length, 1);
  assert.strictEqual(res.days[0].mine.note, '我们的');
  assert.strictEqual(res.days[0].partner, null);
});

test('mood.list: 关系里没有伴侣时 partner 恒为 null，不把别人的记录当成 TA', async () => {
  const { ctx } = makeCtx({
    members: ['oA'],
    moods: [
      moodDoc('oA', TODAY, 'sunny', ''),
      { _id: 'oC_' + TODAY, coupleId: 'c_1', openid: 'oC', date: TODAY, mood: 'rainy', note: '残留', updatedAt: NOW },
    ],
  });
  const res = await list({}, ctx);
  assert.strictEqual(res.days[0].partner, null);
});

test('mood.list: 未绑定返回 NOT_BOUND，鉴权先于任何读库', async () => {
  const { ctx, fake } = makeCtx({ bound: false, moods: [moodDoc('oA', TODAY, 'sunny', '')] });
  let ops = 0;
  fake.setOperationHook(() => { ops += 1; });
  await assert.rejects(() => list({}, ctx), { code: 'NOT_BOUND' });
  assert.strictEqual(ops, 0, '未绑定不应该碰数据库');
});

test('mood.list: 同一天出现三条脏记录时只取我和 TA 各一条', async () => {
  const { ctx } = makeCtx({
    moods: [
      moodDoc('oA', TODAY, 'sunny', '我'),
      moodDoc('oB', TODAY, 'rainy', 'TA'),
      { _id: 'oC_' + TODAY, coupleId: 'c_1', openid: 'oC', date: TODAY, mood: 'thunder', note: '脏', updatedAt: NOW },
    ],
  });
  const res = await list({}, ctx);
  assert.strictEqual(res.days.length, 1);
  assert.strictEqual(res.days[0].mine.note, '我');
  assert.strictEqual(res.days[0].partner.note, 'TA');
});

test('mood.list: limit 30 是允许的上限', async () => {
  const { ctx } = makeCtx();
  const res = await list({ limit: 30 }, ctx);
  assert.deepStrictEqual(res.days, []);
});

test('mood.list: 成员残留 3 人时只返回自己的记录，不把旧伴侣当成 TA', async () => {
  const { ctx } = makeCtx({
    members: ['oA', 'oB', 'oC'],
    moods: [
      moodDoc('oA', TODAY, 'sunny', '我'),
      moodDoc('oB', TODAY, 'rainy', '旧伴侣'),
      moodDoc('oC', TODAY, 'thunder', '现伴侣'),
    ],
  });
  const res = await list({}, ctx);
  assert.strictEqual(res.days.length, 1);
  assert.strictEqual(res.days[0].mine.note, '我');
  assert.strictEqual(res.days[0].partner, null, '无法判断谁是现任时不能猜');
  assert.strictEqual(JSON.stringify(res).includes('旧伴侣'), false);
  assert.strictEqual(JSON.stringify(res).includes('现伴侣'), false);
});

test('mood.list: 成员残留 3 人且每天 3 条时，历史仍能逐页翻到（分页不被截断）', async () => {
  const dates = ['2026-11-16', '2026-11-15', '2026-11-14'];
  const moods = [];
  dates.forEach((date) => {
    moods.push(moodDoc('oA', date, 'sunny', '我' + date));
    moods.push(moodDoc('oB', date, 'rainy', '旧' + date));
    moods.push(moodDoc('oC', date, 'thunder', '现' + date));
  });
  const { ctx } = makeCtx({ members: ['oA', 'oB', 'oC'], moods });

  const page1 = await list({ limit: 1 }, ctx);
  assert.deepStrictEqual(page1.days.map((day) => day.date), ['2026-11-16']);
  assert.strictEqual(page1.nextBeforeDate, '2026-11-16');

  const page2 = await list({ limit: 1, beforeDate: page1.nextBeforeDate }, ctx);
  assert.deepStrictEqual(page2.days.map((day) => day.date), ['2026-11-15']);

  const page3 = await list({ limit: 1, beforeDate: page2.nextBeforeDate }, ctx);
  assert.deepStrictEqual(page3.days.map((day) => day.date), ['2026-11-14']);
  assert.strictEqual(page3.nextBeforeDate, null, '最后一天必须能翻到');
  // 任何一页都不该带出旧伴侣的备注
  assert.strictEqual(JSON.stringify([page1, page2, page3]).includes('旧'), false);
});

test('mood.list: beforeDate 传未来日期会被夹到今天，不返回未来脏数据', async () => {
  const { ctx } = makeCtx({
    moods: [
      moodDoc('oA', '2026-11-20', 'sunny', '未来'),
      moodDoc('oA', TODAY, 'rainy', '今天'),
    ],
  });
  const res = await list({ beforeDate: '2099-01-01' }, ctx);
  assert.deepStrictEqual(res.days.map((day) => day.date), [TODAY]);
  assert.strictEqual(res.days[0].mine.note, '今天');
});

test('mood.list: 脏 note（非字符串）按空串返回，不破坏 string 契约', async () => {
  const { ctx } = makeCtx({
    moods: [{
      _id: 'oA_' + TODAY, coupleId: 'c_1', openid: 'oA', date: TODAY, mood: 'sunny',
      note: 123, updatedAt: NOW,
    }],
  });
  const res = await list({}, ctx);
  assert.strictEqual(res.days[0].mine.note, '');
});
