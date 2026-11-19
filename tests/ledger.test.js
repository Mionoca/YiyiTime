'use strict';

/**
 * 记账本（文档 5.3.9 / 7.13）：个人账本，可切换到对方账本只读。
 * 关注点：金额整数分、日期/月份范围、每人每月上限、只能改删自己的账、
 * 伴侣账本只读且只看本段关系期间的账、未绑定不读库、读故障不吞。
 */
const test = require('node:test');
const assert = require('node:assert');

const ledger = require('../cloudfunctions/api/handlers/ledger');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 2026-11-16 12:00
const TODAY = '2026-11-16';
const ENTRY_ID_RE = /^le_[0-9a-f]{16}$/;

function entryDoc(overrides) {
  return Object.assign({
    openid: 'oA',
    coupleId: 'c_1',
    amount: 2350,
    category: 'food',
    note: '牛肉面',
    date: TODAY,
    month: '2026-11',
    createdAt: NOW,
    updatedAt: NOW,
  }, overrides);
}

function makeCtx(options) {
  const opts = options || {};
  const openid = opts.openid || 'oA';
  const fake = makeFakeDb(opts.data || {});
  const members = opts.members || ['oA', 'oB'];
  const partnerOpenid = members.find((id) => id !== openid) || null;
  // bound: false 模拟真实未绑定：没有 couple 文档、user 上没有 coupleId、没有 partner
  const bound = opts.bound !== false;
  return {
    fake,
    ctx: {
      openid,
      user: { _id: openid, nickname: '', coupleId: bound ? 'c_1' : null },
      couple: bound ? { _id: 'c_1', status: 'active', memberOpenids: members } : null,
      partner: bound && partnerOpenid ? { _id: partnerOpenid, nickname: '阿泽' } : null,
      db: fake.db,
      now: NOW,
      requireBound() {
        if (opts.bound === false) {
          const err = new Error('先邀请 TA 住进来吧');
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

/** 造 n 条同月记录（用于上限用例），日期都落在当月 */
function monthEntries(openid, month, count, extra) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(entryDoc(Object.assign({
      _id: 'le_seed_' + i,
      openid,
      month,
      date: month + '-01',
      amount: 100,
    }, extra || {})));
  }
  return rows;
}

test('ledger.add: 默认今天 / 落盘字段 / 忽略客户端传来的 openid 与 coupleId', async () => {
  const { ctx, fake } = makeCtx();
  const res = await ledger.add({
    amount: 2350, category: 'food', note: '  牛肉面  ', openid: 'oHacker', coupleId: 'c_eviL',
  }, ctx);

  assert.match(res.entry.entryId, ENTRY_ID_RE);
  assert.deepStrictEqual(res.entry, {
    entryId: res.entry.entryId,
    amount: 2350,
    category: 'food',
    note: '牛肉面',
    date: TODAY,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  });

  const doc = fake.get('ledger_entries', res.entry.entryId);
  assert.strictEqual(doc.openid, 'oA', '记账人必须是 ctx.openid');
  assert.strictEqual(doc.coupleId, 'c_1', 'coupleId 必须来自关系，不能信任 payload');
  assert.strictEqual(doc.month, '2026-11');
  assert.strictEqual(doc.date, TODAY);
  assert.strictEqual(doc.amount, 2350);
});

test('ledger.add: 金额必须是整数分且在 1 分–10000 元之间', async () => {
  const { ctx } = makeCtx();
  for (const amount of [0, -1, 1.5, '2350', null, undefined, 1000001, NaN]) {
    await expectCode(ledger.add({ amount, category: 'food' }, ctx), 'INVALID_INPUT');
  }
  const ok = await ledger.add({ amount: 1, category: 'food' }, ctx);
  assert.strictEqual(ok.entry.amount, 1);
  const max = await ledger.add({ amount: 1000000, category: 'food' }, ctx);
  assert.strictEqual(max.entry.amount, 1000000);
});

test('ledger.add: 分类白名单与备注长度', async () => {
  const { ctx } = makeCtx();
  await expectCode(ledger.add({ amount: 100, category: 'travel' }, ctx), 'INVALID_INPUT');
  await expectCode(ledger.add({ amount: 100, category: undefined }, ctx), 'INVALID_INPUT');
  await expectCode(ledger.add({ amount: 100, category: 'food', note: 'x'.repeat(31) }, ctx), 'TEXT_TOO_LONG');
  const res = await ledger.add({ amount: 100, category: 'other', note: 'x'.repeat(30) }, ctx);
  assert.strictEqual(res.entry.note.length, 30);
});

test('ledger.add: 日期不能是未来 / 格式错误 / 2000 年前，缺省按服务端今天', async () => {
  const { ctx } = makeCtx();
  for (const date of ['2026-11-17', '2026-13-01', '2026-11-16 ', '1999-12-31', 20261116]) {
    await expectCode(ledger.add({ amount: 100, category: 'food', date }, ctx), 'INVALID_INPUT');
  }
  const res = await ledger.add({ amount: 100, category: 'fun', date: '2026-10-31' }, ctx);
  assert.strictEqual(res.entry.date, '2026-10-31');
  assert.strictEqual(res.entry.date.slice(0, 7), '2026-10', '月份由日期推导，不能与日期不一致');
});

test('ledger: 未绑定时只有「TA 的账本」要绑定，先于入参校验返回 NOT_BOUND', async () => {
  const { ctx } = makeCtx({ bound: false });
  // 空 payload 也先撞上绑定检查（文档 11.4：鉴权先于入参校验）
  await expectCode(ledger.list({ who: 'partner' }, ctx), 'NOT_BOUND');
  await expectCode(ledger.list({ who: 'partner', month: 'x' }, ctx), 'NOT_BOUND');
});

test('ledger: 未绑定时自己的账本照常能读能写，coupleId 落 null（文档 5.3.9）', async () => {
  const { ctx, fake } = makeCtx({
    bound: false,
    data: { ledger_entries: [entryDoc({ _id: 'le_old', coupleId: 'c_old', amount: 700 })] },
  });

  // 写：金额 / 分类 / 日期照常校验，归属仍是自己，coupleId 为 null（不属于任何一段关系）
  const added = await ledger.add({ amount: 1500, category: 'food', note: '一个人吃的' }, ctx);
  assert.strictEqual(added.entry.amount, 1500);
  const stored = fake.get('ledger_entries', added.entry.entryId);
  assert.strictEqual(stored.openid, 'oA');
  assert.strictEqual(stored.coupleId, null, '未绑定时不能挂到某段关系上');

  // 读：只有自己这一本，bound=false 让页面收起「TA 的」分段
  const res = await ledger.list({}, ctx);
  assert.strictEqual(res.bound, false);
  assert.strictEqual(res.partner, null);
  assert.strictEqual(res.who, 'me');
  assert.deepStrictEqual(
    res.items.map((item) => item.entryId).sort(),
    [added.entry.entryId, 'le_old'].sort(),
    '解绑后自己的历史记录还在（含上一段关系的）'
  );

  // 改 / 删：归属只认 openid，未绑定也能改自己的
  const updated = await ledger.update({ entryId: 'le_old', amount: 800 }, ctx);
  assert.strictEqual(updated.entry.amount, 800);
  const removed = await ledger.remove({ entryId: 'le_old' }, ctx);
  assert.strictEqual(removed.removed, true);
});

test('ledger.add: 每人每月上限 60 笔，不同月份互不影响', async () => {
  const { ctx } = makeCtx({ data: { ledger_entries: monthEntries('oA', '2026-11', 60) } });
  await expectCode(ledger.add({ amount: 100, category: 'food' }, ctx), 'LEDGER_LIMIT_REACHED');
  // 记到上个月不受本月上限影响
  const res = await ledger.add({ amount: 100, category: 'food', date: '2026-10-05' }, ctx);
  assert.strictEqual(res.entry.date, '2026-10-05');
  // 上限是「每人」的：伴侣本月没记过，仍可记
  const partner = makeCtx({
    openid: 'oB',
    data: { ledger_entries: monthEntries('oA', '2026-11', 60) },
  });
  const partnerRes = await ledger.add({ amount: 100, category: 'food' }, partner.ctx);
  assert.strictEqual(partnerRes.entry.amount, 100);
});

test('ledger.list: 默认当月、只返回自己的账，summary 按返回结果算', async () => {
  const { ctx } = makeCtx({
    data: {
      ledger_entries: [
        entryDoc({ _id: 'le_a1', amount: 2350 }),
        entryDoc({ _id: 'le_a2', amount: 1200, date: '2026-11-02', category: 'transport' }),
        entryDoc({ _id: 'le_b1', openid: 'oB', amount: 9999 }),
        entryDoc({ _id: 'le_oct', amount: 500, date: '2026-10-31', month: '2026-10' }),
      ],
    },
  });
  const res = await ledger.list({}, ctx);
  assert.strictEqual(res.who, 'me');
  assert.strictEqual(res.month, '2026-11');
  assert.strictEqual(res.todayKey, TODAY);
  assert.deepStrictEqual(res.items.map((item) => item.entryId), ['le_a1', 'le_a2']);
  assert.deepStrictEqual(res.summary, { total: 3550, count: 2 });
  assert.deepStrictEqual(res.partner, { nickname: '阿泽' });
  assert.strictEqual(res.bound, true, '已绑定要告诉页面可以显示「TA 的」分段');
});

/** M13 账本授权记录：默认永久批准，owner=对方、viewer=自己 */
function grantDoc(overrides) {
  return Object.assign({
    _id: 'lg_0000000000000001',
    coupleId: 'c_1',
    ownerOpenid: 'oB',
    viewerOpenid: 'oA',
    scope: 'permanent',
    status: 'approved',
    requestedAt: NOW,
    decidedAt: NOW,
    expiresAt: null,
    updatedAt: NOW,
  }, overrides);
}

test('ledger.list: 伴侣账本只读且只含本段关系期间的账（换绑后看不到旧的）', async () => {
  const { ctx } = makeCtx({
    data: {
      ledger_entries: [
        entryDoc({ _id: 'le_now', openid: 'oB', amount: 500 }),
        entryDoc({ _id: 'le_old', openid: 'oB', coupleId: 'c_old', amount: 7000 }),
        entryDoc({ _id: 'le_mine', amount: 100 }),
      ],
      ledger_view_grants: [grantDoc()],
    },
  });
  const res = await ledger.list({ who: 'partner' }, ctx);
  assert.strictEqual(res.who, 'partner');
  assert.deepStrictEqual(res.items.map((item) => item.entryId), ['le_now']);
  assert.deepStrictEqual(res.summary, { total: 500, count: 1 });
  assert.deepStrictEqual(res.permission, {
    status: 'approved', scope: 'permanent', expiresAt: null, requestedAt: NOW.toISOString(),
  });
});

test('ledger.list: 没有授权时「TA 的」是一把锁，不返回任何账目字段', async () => {
  const { ctx } = makeCtx({
    data: { ledger_entries: [entryDoc({ _id: 'le_now', openid: 'oB', amount: 500 })] },
  });
  const res = await ledger.list({ who: 'partner' }, ctx);
  assert.deepStrictEqual(res.items, []);
  assert.deepStrictEqual(res.summary, { total: 0, count: 0 });
  assert.strictEqual(res.permission, null, '从没申请过 → null，页面渲染锁 + 申请入口');
});

test('ledger.list: 待处理 / 已过期的授权同样不返回账目，页面据 status 渲染', async () => {
  const pending = makeCtx({
    data: {
      ledger_entries: [entryDoc({ _id: 'le_now', openid: 'oB', amount: 500 })],
      ledger_view_grants: [grantDoc({ _id: 'lg_p', status: 'pending', decidedAt: null, expiresAt: null })],
    },
  });
  const pendingRes = await ledger.list({ who: 'partner' }, pending.ctx);
  assert.deepStrictEqual(pendingRes.items, []);
  assert.strictEqual(pendingRes.permission.status, 'pending');

  const expired = makeCtx({
    data: {
      ledger_entries: [entryDoc({ _id: 'le_now', openid: 'oB', amount: 500 })],
      ledger_view_grants: [grantDoc({
        _id: 'lg_e', scope: 'temp', expiresAt: new Date(NOW.getTime() - 1000),
      })],
    },
  });
  const expiredRes = await ledger.list({ who: 'partner' }, expired.ctx);
  assert.deepStrictEqual(expiredRes.items, []);
  assert.strictEqual(expiredRes.permission.status, 'expired');
});

test('ledger.list: 我的账本不受 coupleId 影响（解绑 / 换绑后仍是自己的）', async () => {
  const { ctx } = makeCtx({
    data: {
      ledger_entries: [
        entryDoc({ _id: 'le_now', amount: 500 }),
        entryDoc({ _id: 'le_old', coupleId: 'c_old', amount: 7000 }),
      ],
    },
  });
  const res = await ledger.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.entryId), ['le_now', 'le_old']);
  assert.deepStrictEqual(res.summary, { total: 7500, count: 2 });
});

test('ledger.list: 按 date 倒序，同一天按 createdAt 倒序', async () => {
  const early = new Date('2026-11-10T01:00:00.000Z');
  const late = new Date('2026-11-10T05:00:00.000Z');
  const { ctx } = makeCtx({
    data: {
      ledger_entries: [
        entryDoc({ _id: 'le_early', date: '2026-11-10', createdAt: early }),
        entryDoc({ _id: 'le_late', date: '2026-11-10', createdAt: late }),
        entryDoc({ _id: 'le_old', date: '2026-11-01', createdAt: late }),
      ],
    },
  });
  const res = await ledger.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.entryId), ['le_late', 'le_early', 'le_old']);
});

test('ledger.list: 空账本 / 没有伴侣时返回空列表而不是报错', async () => {
  const empty = makeCtx();
  const res = await ledger.list({}, empty.ctx);
  assert.deepStrictEqual(res.items, []);
  assert.deepStrictEqual(res.summary, { total: 0, count: 0 });

  // memberOpenids 只剩自己（脏数据）：不猜伴侣，返回空 + partner null
  const solo = makeCtx({ members: ['oA'] });
  const soloRes = await ledger.list({ who: 'partner' }, solo.ctx);
  assert.deepStrictEqual(soloRes.items, []);
  assert.strictEqual(soloRes.partner, null);
});

test('ledger.list: who / month 参数校验', async () => {
  const { ctx } = makeCtx();
  for (const who of ['ta', 'ME', 1, {}]) {
    await expectCode(ledger.list({ who }, ctx), 'INVALID_INPUT');
  }
  for (const month of ['2026-13', '2026-1', '202611', '2026-11-16', '2027-01', '1999-12', 202611]) {
    await expectCode(ledger.list({ month }, ctx), 'INVALID_INPUT');
  }
  const ok = await ledger.list({ month: '2026-10' }, ctx);
  assert.strictEqual(ok.month, '2026-10');
});

test('ledger.update: 改金额/分类/备注/日期，日期跨月时重算 month', async () => {
  const { ctx, fake } = makeCtx({ data: { ledger_entries: [entryDoc({ _id: 'le_1' })] } });
  const res = await ledger.update({
    entryId: 'le_1', amount: 990, category: 'shopping', note: '袜子', date: '2026-10-02',
  }, ctx);
  assert.strictEqual(res.entry.amount, 990);
  assert.strictEqual(res.entry.category, 'shopping');
  assert.strictEqual(res.entry.note, '袜子');
  assert.strictEqual(res.entry.date, '2026-10-02');

  const doc = fake.get('ledger_entries', 'le_1');
  assert.strictEqual(doc.month, '2026-10', '月份要跟着日期一起改，否则按月查询会丢这笔');
  assert.strictEqual(doc.updatedAt, NOW);
});

test('ledger.update: 只能改自己的；不存在 / 空 id / 没有字段都报对应的错', async () => {
  const { ctx } = makeCtx({
    data: { ledger_entries: [entryDoc({ _id: 'le_mine' }), entryDoc({ _id: 'le_partner', openid: 'oB' })] },
  });
  await expectCode(ledger.update({ entryId: 'le_partner', amount: 1 }, ctx), 'FORBIDDEN');
  await expectCode(ledger.update({ entryId: 'le_nope', amount: 1 }, ctx), 'LEDGER_NOT_FOUND');
  await expectCode(ledger.update({ entryId: '', amount: 1 }, ctx), 'LEDGER_NOT_FOUND');
  await expectCode(ledger.update({ entryId: 'x'.repeat(65), amount: 1 }, ctx), 'LEDGER_NOT_FOUND');
  await expectCode(ledger.update({ entryId: 'le_mine' }, ctx), 'INVALID_INPUT');
  await expectCode(ledger.update({ entryId: 'le_mine', amount: 0 }, ctx), 'INVALID_INPUT');
  await expectCode(ledger.update({ entryId: 'le_mine', date: '2026-11-17' }, ctx), 'INVALID_INPUT');
});

test('ledger.update: 改到已满 60 笔的月份要被拦住（不能靠改日期绕过上限）', async () => {
  const { ctx } = makeCtx({
    data: {
      ledger_entries: [entryDoc({ _id: 'le_1' })].concat(monthEntries('oA', '2026-10', 60)),
    },
  });
  await expectCode(ledger.update({ entryId: 'le_1', date: '2026-10-09' }, ctx), 'LEDGER_LIMIT_REACHED');
  // 同一个月的其它字段照样能改
  const res = await ledger.update({ entryId: 'le_1', amount: 300 }, ctx);
  assert.strictEqual(res.entry.amount, 300);
});

test('ledger.remove: 删除自己的幂等；不存在返回 removed:false；伴侣的 FORBIDDEN', async () => {
  const { ctx, fake } = makeCtx({
    data: { ledger_entries: [entryDoc({ _id: 'le_mine' }), entryDoc({ _id: 'le_partner', openid: 'oB' })] },
  });
  assert.deepStrictEqual(await ledger.remove({ entryId: 'le_mine' }, ctx), { removed: true });
  assert.strictEqual(fake.get('ledger_entries', 'le_mine'), undefined);
  assert.deepStrictEqual(await ledger.remove({ entryId: 'le_mine' }, ctx), { removed: false });
  assert.deepStrictEqual(await ledger.remove({ entryId: '' }, ctx), { removed: false });
  assert.deepStrictEqual(await ledger.remove({}, ctx), { removed: false });
  await expectCode(ledger.remove({ entryId: 'le_partner' }, ctx), 'FORBIDDEN');
});

test('ledger: 读故障（非「文档不存在」）要上抛，不能被当成不存在', async () => {
  const { ctx } = makeCtx();
  ctx.db = {
    collection: () => ({
      doc: () => ({
        async get() {
          const err = new Error('timeout');
          err.errCode = -502001;
          throw err;
        },
      }),
    }),
  };
  await assert.rejects(ledger.update({ entryId: 'le_1', amount: 1 }, ctx), /timeout/);
});
