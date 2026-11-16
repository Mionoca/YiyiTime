'use strict';

const test = require('node:test');
const assert = require('node:assert');

const safety = require('../cloudfunctions/api/handlers/safety');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 12:00
const TODAY = '2026-11-16';
const MIN_MS = 60 * 1000;

function makeCtx({ bound = true, data = {} } = {}) {
  const fake = makeFakeDb(data);
  return {
    fake,
    ctx: {
      openid: 'oA',
      user: { _id: 'oA', nickname: '阿怡', avatarFileID: 'cloud://a.png', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      partner: { _id: 'oB', nickname: '小怡', avatarFileID: 'cloud://b.png' },
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
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.strictEqual(err.code, code);
    return true;
  });
}

test('safety.checkin: 首次报平安新增记录，返回约定字段并落库 date/createdAt', async () => {
  const { ctx, fake } = makeCtx();
  const res = await safety.checkin({ note: '  到家啦  ' }, ctx);

  assert.deepStrictEqual(res, {
    entry: {
      checkinId: 'auto_1',
      openid: 'oA',
      date: TODAY,
      note: '到家啦',
      createdAt: NOW.toISOString(),
    },
    deduped: false,
  });
  const rows = fake.all('safety_checkins');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].coupleId, 'c_1');
  assert.strictEqual(rows[0].openid, 'oA');
  assert.strictEqual(rows[0].date, TODAY);
  assert.ok(rows[0].createdAt instanceof Date);
});

test('safety.checkin: 备注可选，不传时为空串', async () => {
  const { ctx, fake } = makeCtx();
  const res = await safety.checkin({}, ctx);
  assert.strictEqual(res.entry.note, '');
  assert.strictEqual(fake.all('safety_checkins')[0].note, '');
});

test('safety.checkin: 10 分钟内重复报平安返回最近一条且不新增（deduped）', async () => {
  const lastAt = new Date(NOW.getTime() - 5 * MIN_MS);
  const { ctx, fake } = makeCtx({
    data: {
      safety_checkins: [{
        _id: 'sc_1', coupleId: 'c_1', openid: 'oA', note: '刚报过', date: TODAY, createdAt: lastAt,
      }],
    },
  });
  const res = await safety.checkin({ note: '再说一次' }, ctx);
  assert.strictEqual(res.deduped, true);
  assert.strictEqual(res.entry.checkinId, 'sc_1');
  assert.strictEqual(res.entry.note, '刚报过');
  assert.strictEqual(res.entry.createdAt, lastAt.toISOString());
  assert.strictEqual(fake.all('safety_checkins').length, 1);
});

test('safety.checkin: 恰好超过 10 分钟会新增一条', async () => {
  const { ctx, fake } = makeCtx({
    data: {
      safety_checkins: [{
        _id: 'sc_1', coupleId: 'c_1', openid: 'oA', note: '', date: TODAY,
        createdAt: new Date(NOW.getTime() - 10 * MIN_MS),
      }],
    },
  });
  const res = await safety.checkin({ note: '新的' }, ctx);
  assert.strictEqual(res.deduped, false);
  assert.strictEqual(fake.all('safety_checkins').length, 2);
});

test('safety.checkin: 别人的最近记录不影响我的去重', async () => {
  const { ctx, fake } = makeCtx({
    data: {
      safety_checkins: [{
        _id: 'sc_b', coupleId: 'c_1', openid: 'oB', note: 'TA 的', date: TODAY,
        createdAt: new Date(NOW.getTime() - MIN_MS),
      }],
    },
  });
  const res = await safety.checkin({}, ctx);
  assert.strictEqual(res.deduped, false);
  assert.strictEqual(fake.all('safety_checkins').length, 2);
});

test('safety.checkin: 参数与绑定校验', async () => {
  const { ctx } = makeCtx();
  await expectCode(safety.checkin({ note: 'x'.repeat(51) }, ctx), 'TEXT_TOO_LONG');
  await expectCode(safety.checkin({ note: 12 }, ctx), 'INVALID_INPUT');

  const unbound = makeCtx({ bound: false }).ctx;
  await expectCode(safety.checkin({}, unbound), 'NOT_BOUND');
});

test('safety.list: 双方混排按 createdAt 倒序，返回昵称头像且只含本 couple', async () => {
  const { ctx } = makeCtx({
    data: {
      safety_checkins: [
        {
          _id: 'sc_1', coupleId: 'c_1', openid: 'oA', note: '我到家了', date: TODAY,
          createdAt: new Date(NOW.getTime() - 2 * MIN_MS),
        },
        {
          _id: 'sc_2', coupleId: 'c_1', openid: 'oB', note: '', date: TODAY,
          createdAt: new Date(NOW.getTime() - MIN_MS),
        },
        {
          _id: 'sc_x', coupleId: 'c_2', openid: 'oA', note: '别的家', date: TODAY,
          createdAt: new Date(NOW.getTime() - 3 * MIN_MS),
        },
      ],
    },
  });
  const res = await safety.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.checkinId), ['sc_2', 'sc_1']);
  assert.deepStrictEqual(res.items[0], {
    checkinId: 'sc_2',
    openid: 'oB',
    nickname: '小怡',
    avatarFileID: 'cloud://b.png',
    createdAt: new Date(NOW.getTime() - MIN_MS).toISOString(),
    date: TODAY,
    note: '',
  });
  assert.strictEqual(res.items[1].nickname, '阿怡');
  assert.strictEqual(res.items[1].avatarFileID, 'cloud://a.png');
  assert.strictEqual(res.nextCursor, null);
});

/** 与 miniprogram/pages/safety/index.js 的 mergeItems 等价：按 checkinId 去重保序 */
function mergeByCheckinId(pages) {
  const seen = {};
  const out = [];
  pages.forEach((page) => page.items.forEach((item) => {
    if (seen[item.checkinId]) return;
    seen[item.checkinId] = true;
    out.push(item.checkinId);
  }));
  return out;
}

test('safety.list: limit 满页时给复合游标，翻页不丢不重', async () => {
  const rows = [4, 3, 2, 1].map((n) => ({
    _id: 'sc_' + n,
    coupleId: 'c_1',
    openid: n % 2 ? 'oA' : 'oB',
    note: '',
    date: TODAY,
    createdAt: new Date(NOW.getTime() - n * MIN_MS),
  }));
  const { ctx } = makeCtx({ data: { safety_checkins: rows } });

  const pages = [];
  let cursor = undefined;
  for (let i = 0; i < 10; i += 1) {
    const page = await safety.list(Object.assign({ limit: 2 }, cursor ? { cursor } : {}), ctx);
    pages.push(page);
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  assert.deepStrictEqual(pages[0].items.map((item) => item.checkinId), ['sc_1', 'sc_2']);
  // 游标是 createdAt ISO + '|' + _id 的复合键（7.9 只写了 ISO，见已记录偏差）
  assert.strictEqual(
    pages[0].nextCursor,
    new Date(NOW.getTime() - 2 * MIN_MS).toISOString() + '|sc_2'
  );
  assert.deepStrictEqual(
    mergeByCheckinId(pages),
    ['sc_1', 'sc_2', 'sc_3', 'sc_4']
  );
  assert.strictEqual(pages[pages.length - 1].nextCursor, null);
});

test('safety.list: 同一毫秒的多条记录翻页不会丢、也不会原地打转（B2 回归）', async () => {
  const tieMs = NOW.getTime() - MIN_MS;
  const rows = [
    { _id: 's13', createdAt: new Date(tieMs) },
    { _id: 's12', createdAt: new Date(tieMs) },
    { _id: 's11', createdAt: new Date(tieMs) },
    { _id: 's10', createdAt: new Date(NOW.getTime() - 2 * MIN_MS) },
    { _id: 's9', createdAt: new Date(NOW.getTime() - 3 * MIN_MS) },
  ].map((row) => Object.assign({
    coupleId: 'c_1', openid: 'oA', note: '', date: TODAY,
  }, row));
  const { ctx } = makeCtx({ data: { safety_checkins: rows } });

  // 第一页刚好用完：s13、s12 同一毫秒，游标带 _id 才能描述「s12 之后」
  const first = await safety.list({ limit: 2 }, ctx);
  assert.deepStrictEqual(first.items.map((item) => item.checkinId), ['s13', 's12']);
  assert.strictEqual(first.nextCursor, new Date(tieMs).toISOString() + '|s12');

  // 第二页：边界那一毫秒还剩 s11（_id 小于游标），必须补回来
  const second = await safety.list({ limit: 2, cursor: first.nextCursor }, ctx);
  assert.deepStrictEqual(second.items.map((item) => item.checkinId), ['s11', 's10']);

  const merged = mergeByCheckinId([first, second]);
  assert.deepStrictEqual(merged, ['s13', 's12', 's11', 's10', 's9'].slice(0, 4));
});

test('safety.list: limit / cursor 参数校验', async () => {
  const { ctx } = makeCtx();
  await expectCode(safety.list({ limit: 0 }, ctx), 'INVALID_INPUT');
  await expectCode(safety.list({ limit: 51 }, ctx), 'INVALID_INPUT');
  await expectCode(safety.list({ limit: 1.5 }, ctx), 'INVALID_INPUT');
  await expectCode(safety.list({ cursor: 'not-a-date' }, ctx), 'INVALID_INPUT');
});

test('safety.list: 未绑定报 NOT_BOUND', async () => {
  const { ctx } = makeCtx({ bound: false });
  await expectCode(safety.list({}, ctx), 'NOT_BOUND');
});
