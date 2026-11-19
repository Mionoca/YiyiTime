'use strict';

/**
 * 手帐日记服务端契约（M13，文档 5.3.7 / 7.10）：
 * - 默认私密是红线：不传 visibility 一律 private，伴侣侧连「写过」都读不到；
 * - 三档延迟解锁、心情分值、配图上限、月度日历、年度归档各一组用例；
 * - 已解锁不可改（含改可见性），避免「TA 看过又撤回」。
 */
const test = require('node:test');
const assert = require('node:assert');

const diary = require('../cloudfunctions/api/handlers/diary');
const { makeFakeDb } = require('./helpers/fake-db');

const NOW = new Date('2026-11-16T04:00:00.000Z'); // 东八区 2026-11-16 12:00
const TODAY = '2026-11-16';
const UNLOCK_TODAY = '2026-11-16T16:00:00.000Z'; // 东八区 2026-11-17 00:00

function dayDoc({ id, author, date, content, unlockAt, visibility, moodScore, images, unlockMode }) {
  return {
    _id: id,
    coupleId: 'c_1',
    authorOpenid: author,
    date,
    content,
    moodScore: typeof moodScore === 'number' ? moodScore : null,
    images: images || [],
    visibility: visibility || 'private',
    unlockMode: unlockMode || 'day',
    unlockAt: new Date(unlockAt),
    sharedAt: visibility === 'partner' ? new Date(unlockAt) : null,
    createdAt: new Date(unlockAt),
    updatedAt: new Date(unlockAt),
  };
}

function makeCtx({ bound = true, data = {} } = {}) {
  const fake = makeFakeDb(data);
  return {
    fake,
    ctx: {
      openid: 'oA',
      user: { _id: 'oA', nickname: '阿怡', coupleId: 'c_1' },
      couple: { _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'] },
      partner: { _id: 'oB', nickname: '小怡' },
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

test('diary.save: 首次写日记按 openid_date 建档，默认私密 / 无分值 / 无配图 / 次日 00:00 解锁', async () => {
  const { ctx, fake } = makeCtx();
  const res = await diary.save({ content: '  今天也想你  ' }, ctx);

  assert.deepStrictEqual(res, {
    diary: {
      date: TODAY,
      content: '今天也想你',
      moodScore: null,
      images: [],
      visibility: 'private',
      unlockMode: 'day',
      unlockAt: UNLOCK_TODAY,
      sharedAt: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    },
  });
  const doc = fake.get('diaries', 'oA_' + TODAY);
  assert.ok(doc, '应按 _id=openid_date 建档');
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(doc.authorOpenid, 'oA');
  assert.strictEqual(doc.content, '今天也想你');
  assert.strictEqual(doc.visibility, 'private', '默认值只能由服务端写成 private');
  assert.strictEqual(doc.moodScore, null);
  assert.deepStrictEqual(doc.images, []);
  assert.strictEqual(doc.unlockAt.toISOString(), UNLOCK_TODAY);
});

test('diary.save: 分享 + 心情分值 + 配图，immediate / week 两档解锁时刻', async () => {
  const { ctx, fake } = makeCtx();
  const images = ['cloud://diary/c_1/2026-11-16/1.jpg', 'cloud://diary/c_1/2026-11-16/2.jpg'];
  const res = await diary.save({
    content: '今天和你一起看了海',
    moodScore: 5,
    images,
    visibility: 'partner',
    unlockMode: 'immediate',
  }, ctx);

  assert.strictEqual(res.diary.visibility, 'partner');
  assert.strictEqual(res.diary.moodScore, 5);
  assert.deepStrictEqual(res.diary.images, images);
  assert.strictEqual(res.diary.unlockAt, NOW.toISOString(), 'immediate 保存即可见');
  assert.strictEqual(res.diary.sharedAt, NOW.toISOString(), '首次分享写 sharedAt');

  const doc = fake.get('diaries', 'oA_' + TODAY);
  assert.strictEqual(doc.unlockMode, 'immediate');
  assert.strictEqual(doc.sharedAt.getTime(), NOW.getTime());
});

test('diary.save: week 档解锁 = 保存时刻 + 7 天', async () => {
  const { ctx } = makeCtx();
  const res = await diary.save({ content: '七天后再说', unlockMode: 'week' }, ctx);
  assert.strictEqual(res.diary.unlockAt, new Date(NOW.getTime() + 7 * 24 * 3600 * 1000).toISOString());
});

test('diary.save: 同一天再写是更新，createdAt 不变，sharedAt 保持首次分享时刻', async () => {
  const createdAt = new Date('2026-11-16T01:00:00.000Z');
  const firstSharedAt = new Date('2026-11-16T02:00:00.000Z');
  const { ctx, fake } = makeCtx({
    data: {
      diaries: [{
        _id: 'oA_' + TODAY,
        coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: '草稿',
        moodScore: 3, images: [], visibility: 'partner', unlockMode: 'day',
        unlockAt: new Date(UNLOCK_TODAY), sharedAt: firstSharedAt,
        createdAt, updatedAt: createdAt,
      }],
    },
  });
  const res = await diary.save({ content: '改好了', moodScore: 4, visibility: 'partner' }, ctx);
  assert.strictEqual(res.diary.content, '改好了');
  assert.strictEqual(res.diary.moodScore, 4);
  assert.strictEqual(res.diary.createdAt, createdAt.toISOString());
  assert.strictEqual(res.diary.sharedAt, firstSharedAt.toISOString(), 'sharedAt 只记首次分享');

  const rows = fake.all('diaries');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, '改好了');
  assert.strictEqual(rows[0].updatedAt.getTime(), NOW.getTime());
});

test('diary.save: 已过解锁时刻不允许再改（DIARY_LOCKED），改可见性也拦', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [{
        _id: 'oA_' + TODAY,
        coupleId: 'c_1', authorOpenid: 'oA', date: TODAY, content: '昨天的',
        moodScore: null, images: [], visibility: 'private', unlockMode: 'day',
        unlockAt: new Date(NOW.getTime() - 1000),
        sharedAt: null,
        createdAt: new Date(NOW.getTime() - 1000),
        updatedAt: new Date(NOW.getTime() - 1000),
      }],
    },
  });
  await expectCode(diary.save({ content: '想改' }, ctx), 'DIARY_LOCKED');
  await expectCode(diary.save({ content: '想改', visibility: 'partner' }, ctx), 'DIARY_LOCKED');
});

test('diary.save: 读库故障必须上抛，不能当成文档不存在覆盖旧日记', async () => {
  const { ctx, fake } = makeCtx();
  const realDb = fake.db;
  ctx.db = {
    collection(name) {
      const real = realDb.collection(name);
      if (name !== 'diaries') return real;
      return {
        doc(id) {
          const target = real.doc(id);
          return {
            // 模拟网络超时：没有 errCode=-1、文案也不含 not exist
            async get() { throw new Error('database request timeout'); },
            async set(args) { return target.set(args); },
            async update(args) { return target.update(args); },
          };
        },
      };
    },
    command: realDb.command,
  };

  await assert.rejects(diary.save({ content: '今天也想你' }, ctx), /timeout/);
  assert.strictEqual(fake.all('diaries').length, 0, '读失败时不应写入新文档');
});

test('diary.save: 内容 / 分值 / 配图 / 可见性 / 解锁方式的校验与未绑定', async () => {
  const { ctx } = makeCtx();
  await expectCode(diary.save({ content: '' }, ctx), 'DIARY_EMPTY');
  await expectCode(diary.save({ content: '   ' }, ctx), 'DIARY_EMPTY');
  await expectCode(diary.save({}, ctx), 'DIARY_EMPTY');
  await expectCode(diary.save({ content: '字'.repeat(501) }, ctx), 'TEXT_TOO_LONG');
  await expectCode(diary.save({ content: 123 }, ctx), 'INVALID_INPUT');

  await expectCode(diary.save({ content: '你好', moodScore: 0 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.save({ content: '你好', moodScore: 6 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.save({ content: '你好', moodScore: 3.5 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.save({ content: '你好', visibility: 'public' }, ctx), 'INVALID_INPUT');
  await expectCode(diary.save({ content: '你好', unlockMode: 'month' }, ctx), 'INVALID_INPUT');

  await expectCode(diary.save({
    content: '你好',
    images: ['cloud://a/1.jpg', 'cloud://a/2.jpg', 'cloud://a/3.jpg', 'cloud://a/4.jpg'],
  }, ctx), 'DIARY_IMAGE_LIMIT');
  await expectCode(diary.save({ content: '你好', images: ['http://a/1.jpg'] }, ctx), 'DIARY_IMAGE_INVALID');
  await expectCode(diary.save({ content: '你好', images: 'cloud://a/1.jpg' }, ctx), 'DIARY_IMAGE_INVALID');

  const unbound = makeCtx({ bound: false }).ctx;
  await expectCode(diary.save({ content: '你好' }, unbound), 'NOT_BOUND');
});

test('diary.save: 500 字边界与配图去重', async () => {
  const { ctx } = makeCtx();
  const okRes = await diary.save({ content: '字'.repeat(500) }, ctx);
  assert.strictEqual(okRes.diary.content.length, 500);
  const res = await diary.save({
    content: '带图',
    images: ['cloud://a/1.jpg', 'cloud://a/1.jpg'],
  }, ctx);
  assert.deepStrictEqual(res.diary.images, ['cloud://a/1.jpg'], '重复 fileID 去重后仍算一张');
});

test('diary.list: 私密日记对伴侣完全不可见（只有我写的日子仍是「TA 没写」）', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        dayDoc({
          id: 'oA_2026-11-14', author: 'oA', date: '2026-11-14', content: '那天的我',
          unlockAt: '2026-11-15T16:00:00.000Z',
        }),
        dayDoc({
          id: 'oB_2026-11-15', author: 'oB', date: '2026-11-15', content: 'TA 的私密',
          unlockAt: '2026-11-15T16:00:00.000Z', visibility: 'private',
        }),
      ],
    },
  });
  const res = await diary.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.date), ['2026-11-14'], '只有对方私密记录的那天整个不出现');
  assert.strictEqual(res.items[0].partnerWritten, false);
  assert.strictEqual(res.items[0].partnerUnlocked, false);
  assert.strictEqual(res.items[0].partner, null);
});

test('diary.list: 按天合并倒序，已分享未解锁只给状态，已解锁给正文 + 分值 + 配图', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        // 干扰项：别的 couple 同一天
        dayDoc({
          id: 'oC_' + TODAY, author: 'oC', date: TODAY, content: '别人',
          unlockAt: UNLOCK_TODAY, visibility: 'partner',
        }),
        dayDoc({
          id: 'oA_' + TODAY, author: 'oA', date: TODAY, content: '今天我的',
          unlockAt: UNLOCK_TODAY, moodScore: 4,
        }),
        dayDoc({
          id: 'oB_' + TODAY, author: 'oB', date: TODAY, content: '今天 TA 的',
          unlockAt: UNLOCK_TODAY, visibility: 'partner', moodScore: 5,
        }),
        dayDoc({
          id: 'oA_2026-11-15', author: 'oA', date: '2026-11-15', content: '昨天我的',
          unlockAt: '2026-11-15T16:00:00.000Z',
        }),
        dayDoc({
          id: 'oB_2026-11-15', author: 'oB', date: '2026-11-15', content: '昨天 TA 的',
          unlockAt: '2026-11-15T16:00:00.000Z', visibility: 'partner',
          moodScore: 2, images: ['cloud://diary/c_1/2026-11-15/1.jpg'],
        }),
        dayDoc({
          id: 'oB_2026-11-14', author: 'oB', date: '2026-11-14', content: '前天 TA 的',
          unlockAt: '2026-11-14T16:00:00.000Z', visibility: 'partner',
        }),
      ],
    },
  });
  const res = await diary.list({}, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.date), [TODAY, '2026-11-15', '2026-11-14']);
  assert.deepStrictEqual(res.items[0], {
    date: TODAY,
    unlockAt: UNLOCK_TODAY,
    mine: {
      content: '今天我的', moodScore: 4, images: [],
      visibility: 'private', unlockMode: 'day', updatedAt: UNLOCK_TODAY,
    },
    partnerWritten: true,
    partnerUnlocked: false,
    partner: null,
  });
  assert.deepStrictEqual(res.items[1], {
    date: '2026-11-15',
    unlockAt: '2026-11-15T16:00:00.000Z',
    mine: {
      content: '昨天我的', moodScore: null, images: [],
      visibility: 'private', unlockMode: 'day', updatedAt: '2026-11-15T16:00:00.000Z',
    },
    partnerWritten: true,
    partnerUnlocked: true,
    partner: {
      content: '昨天 TA 的', moodScore: 2,
      images: ['cloud://diary/c_1/2026-11-15/1.jpg'],
      updatedAt: '2026-11-15T16:00:00.000Z',
    },
  });
  // 只有对方写了的那天：mine 为 null，对方已解锁可见
  assert.strictEqual(res.items[2].mine, null);
  assert.strictEqual(res.items[2].partner.content, '前天 TA 的');
  assert.strictEqual(res.nextBeforeDate, null);
});

test('diary.list: 分页按天，beforeDate 不重复不丢', async () => {
  const rows = [];
  ['2026-11-16', '2026-11-15', '2026-11-14'].forEach((date) => {
    const unlockAt = date === TODAY ? UNLOCK_TODAY : date + 'T16:00:00.000Z';
    rows.push(dayDoc({ id: 'oA_' + date, author: 'oA', date, content: date, unlockAt }));
  });
  const { ctx } = makeCtx({ data: { diaries: rows } });

  const first = await diary.list({ limit: 2 }, ctx);
  assert.deepStrictEqual(first.items.map((item) => item.date), ['2026-11-16', '2026-11-15']);
  assert.strictEqual(first.nextBeforeDate, '2026-11-15');

  const second = await diary.list({ limit: 2, beforeDate: first.nextBeforeDate }, ctx);
  assert.deepStrictEqual(second.items.map((item) => item.date), ['2026-11-14']);
  assert.strictEqual(second.nextBeforeDate, null);
});

test('diary.list: beforeDate 过滤与参数校验', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        dayDoc({ id: 'oA_2026-11-15', author: 'oA', date: '2026-11-15', content: 'a', unlockAt: '2026-11-15T16:00:00.000Z' }),
        dayDoc({ id: 'oA_2026-11-14', author: 'oA', date: '2026-11-14', content: 'b', unlockAt: '2026-11-14T16:00:00.000Z' }),
      ],
    },
  });
  const res = await diary.list({ beforeDate: '2026-11-15' }, ctx);
  assert.deepStrictEqual(res.items.map((item) => item.date), ['2026-11-14']);
  await expectCode(diary.list({ beforeDate: '2026-13-01' }, ctx), 'INVALID_INPUT');
  await expectCode(diary.list({ limit: 0 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.list({ limit: 31 }, ctx), 'INVALID_INPUT');
});

test('diary.list: 未绑定报 NOT_BOUND；空列表也带服务端 todayKey', async () => {
  const { ctx } = makeCtx();
  const res = await diary.list({}, ctx);
  assert.strictEqual(res.todayKey, TODAY);
  assert.deepStrictEqual(res.items, []);
  assert.strictEqual(res.nextBeforeDate, null);

  const unbound = makeCtx({ bound: false }).ctx;
  await expectCode(diary.list({}, unbound), 'NOT_BOUND');
});

test('diary.list: todayKey 只跟服务端 ctx.now 走，与查询参数无关', async () => {
  const { ctx } = makeCtx();
  // 把设备/请求里的日期字段塞进 payload 也不影响 todayKey
  const res = await diary.list({ todayKey: '1999-01-01', beforeDate: '1999-01-01' }, ctx);
  assert.strictEqual(res.todayKey, TODAY);
});

test('diary: 超长正文、非法分页参数用中文字段提示（16.2）', async () => {
  const { ctx } = makeCtx();
  await assert.rejects(() => diary.save({ content: '字'.repeat(501) }, ctx),
    { code: 'TEXT_TOO_LONG', message: '内容最多 500 字' });
  await assert.rejects(() => diary.list({ limit: 1.5 }, ctx),
    { code: 'INVALID_INPUT', message: '分页条数必须是整数' });
  await assert.rejects(() => diary.list({ limit: 99 }, ctx),
    { code: 'INVALID_INPUT', message: '分页条数超出范围' });
});

test('diary.save: 已解锁的今日记录不能再改（16.2 文案）', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [dayDoc({
        id: 'oA_' + TODAY,
        author: 'oA',
        date: TODAY,
        content: '昨晚写的',
        unlockAt: '2026-11-15T16:00:00.000Z',
      })],
    },
  });
  await assert.rejects(() => diary.save({ content: '想改一下' }, ctx),
    { code: 'DIARY_LOCKED', message: '这篇日记已经解锁，不能再改了' });
});

test('diary.calendar: 当月每天一格，只统计自己的分值，同分取较近的一天', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        dayDoc({ id: 'oA_2026-11-02', author: 'oA', date: '2026-11-02', content: 'a', unlockAt: '2026-11-03T16:00:00.000Z', moodScore: 5 }),
        dayDoc({ id: 'oA_2026-11-08', author: 'oA', date: '2026-11-08', content: 'b', unlockAt: '2026-11-09T16:00:00.000Z', moodScore: 1 }),
        dayDoc({ id: 'oA_2026-11-15', author: 'oA', date: '2026-11-15', content: 'c', unlockAt: '2026-11-16T16:00:00.000Z', moodScore: 5 }),
        dayDoc({ id: 'oA_2026-11-16', author: 'oA', date: TODAY, content: 'd', unlockAt: UNLOCK_TODAY, moodScore: 4 }),
        // 对方的分值绝不进日历
        dayDoc({ id: 'oB_2026-11-03', author: 'oB', date: '2026-11-03', content: 'TA', unlockAt: '2026-11-04T16:00:00.000Z', visibility: 'partner', moodScore: 1 }),
        // 上月记录不进本月
        dayDoc({ id: 'oA_2026-10-31', author: 'oA', date: '2026-10-31', content: 'e', unlockAt: '2026-11-01T16:00:00.000Z', moodScore: 2 }),
      ],
    },
  });
  const res = await diary.calendar({}, ctx);
  assert.strictEqual(res.month, '2026-11');
  assert.strictEqual(res.todayKey, TODAY);
  assert.strictEqual(res.days.length, 30, '11 月 30 天');
  assert.deepStrictEqual(res.days[0], { date: '2026-11-01', day: 1, score: null, hasDiary: false, shared: false });
  assert.strictEqual(res.days[1].score, 5);
  assert.strictEqual(res.days[2].score, null, '对方的分值不出现');
  assert.deepStrictEqual(res.stats, {
    recorded: 4,
    average: 3.8,
    best: { date: '2026-11-15', score: 5 },
    lowest: { date: '2026-11-08', score: 1 },
  });
});

test('diary.calendar: 空月统计为 0 / null，月份参数校验', async () => {
  const { ctx } = makeCtx();
  const res = await diary.calendar({ month: '2026-10' }, ctx);
  assert.strictEqual(res.days.length, 31);
  assert.deepStrictEqual(res.stats, { recorded: 0, average: 0, best: null, lowest: null });
  await expectCode(diary.calendar({ month: '2026-13' }, ctx), 'INVALID_INPUT');
  await expectCode(diary.calendar({ month: '2026-12' }, ctx), 'INVALID_INPUT');
  await expectCode(diary.calendar({ month: '1999-12' }, ctx), 'INVALID_INPUT');
});

test('diary.archive: 只导出自己的全年日记，按日期升序，含可见性与分值', async () => {
  const { ctx } = makeCtx({
    data: {
      diaries: [
        dayDoc({ id: 'oA_2026-01-02', author: 'oA', date: '2026-01-02', content: '新年第二天', unlockAt: '2026-01-03T16:00:00.000Z', moodScore: 5 }),
        dayDoc({ id: 'oA_2026-03-05', author: 'oA', date: '2026-03-05', content: '春天', unlockAt: '2026-03-06T16:00:00.000Z', visibility: 'partner' }),
        dayDoc({ id: 'oA_2025-12-31', author: 'oA', date: '2025-12-31', content: '去年', unlockAt: '2026-01-01T16:00:00.000Z' }),
        dayDoc({ id: 'oB_2026-01-03', author: 'oB', date: '2026-01-03', content: 'TA 的', unlockAt: '2026-01-04T16:00:00.000Z', visibility: 'partner' }),
      ],
    },
  });
  const res = await diary.archive({ year: 2026 }, ctx);
  assert.strictEqual(res.year, 2026);
  assert.strictEqual(res.count, 2);
  assert.strictEqual(res.truncated, false);
  assert.deepStrictEqual(res.items.map((item) => item.date), ['2026-01-02', '2026-03-05']);
  assert.strictEqual(res.items[0].moodScore, 5);
  assert.strictEqual(res.items[1].visibility, 'partner');
  await expectCode(diary.archive({ year: 1999 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.archive({ year: 2027 }, ctx), 'INVALID_INPUT');
  await expectCode(diary.archive({}, ctx), 'INVALID_INPUT');
});

// M13 隐私默认值的副作用（回归）：对方连续几天只写私密日记时，那些天一条条目都不产出。
// 游标必须按「扫过的天」推进，否则我自己的历史日记会永远翻不到（游标为 null = 客户端认为没有更多）
test('diary.list: 对方连续写私密日记不会把分页游标卡死', async () => {
  const rows = ['2026-11-16', '2026-11-15', '2026-11-14'].map((date) => dayDoc({
    id: 'oB_' + date, author: 'oB', date, content: 'TA 的私密',
    unlockAt: date + 'T16:00:00.000Z', visibility: 'private',
  }));
  rows.push(dayDoc({
    id: 'oA_2026-11-13', author: 'oA', date: '2026-11-13', content: '我自己的历史',
    unlockAt: '2026-11-13T16:00:00.000Z',
  }));
  const { ctx } = makeCtx({ data: { diaries: rows } });

  const first = await diary.list({ limit: 2 }, ctx);
  assert.deepStrictEqual(first.items, [], '对方私密的三天不该产出任何条目');
  assert.strictEqual(first.nextBeforeDate, '2026-11-14', '游标必须越过这些天，否则历史翻不到');

  const second = await diary.list({ limit: 2, beforeDate: first.nextBeforeDate }, ctx);
  assert.deepStrictEqual(second.items.map((item) => item.date), ['2026-11-13']);
  assert.strictEqual(second.items[0].mine.content, '我自己的历史');
  assert.strictEqual(second.nextBeforeDate, null);
});

// 页边界刚好切在同一天的两条记录中间时，不能凭半天的数据判断「TA 那天没写」
test('diary.list: 页边界不把同一天拆开判断', async () => {
  const rows = [
    dayDoc({ id: 'oA_2026-11-16', author: 'oA', date: '2026-11-16', content: '我的 16', unlockAt: UNLOCK_TODAY }),
    dayDoc({
      id: 'oB_2026-11-16', author: 'oB', date: '2026-11-16', content: 'TA 的 16',
      unlockAt: UNLOCK_TODAY, visibility: 'partner',
    }),
    dayDoc({
      id: 'oA_2026-11-15', author: 'oA', date: '2026-11-15', content: '我的 15',
      unlockAt: '2026-11-15T16:00:00.000Z',
    }),
    dayDoc({
      id: 'oB_2026-11-15', author: 'oB', date: '2026-11-15', content: 'TA 的 15',
      unlockAt: '2026-11-15T16:00:00.000Z', visibility: 'partner',
    }),
  ];
  const { ctx } = makeCtx({ data: { diaries: rows } });

  // limit=1 → 只取 2 条：正好是 11-16 那天的两条，完整
  const first = await diary.list({ limit: 1 }, ctx);
  assert.deepStrictEqual(first.items.map((item) => item.date), ['2026-11-16']);
  assert.strictEqual(first.items[0].partnerWritten, true, '同一天的两条要一起算');
  assert.strictEqual(first.nextBeforeDate, '2026-11-16');
});
