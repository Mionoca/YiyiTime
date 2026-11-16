'use strict';

/**
 * 数据模型一致性测试：以 docs/技术设计文档.md 第 5.3 节「集合定义」为唯一事实来源，
 * 跑一条完整双人链路，把假库里真实落盘的所有文档逐个对照文档做校验：
 * 1) 不能出现文档没定义的字段（防止悄悄加字段）；
 * 2) 文档标「必填」的字段必须存在且非 null，类型必须符合；
 * 3) 唯一键 / 编码 / 日期格式 / 跨集合不变量（users.coupleId 与 couples 成员一致等）。
 *
 * 校验函数接受 (schema, collection, doc) 并抛出带定位信息的错误，负例在最后一个 test 里锁定，
 * 避免「文档解析失败但测试全绿」的假通过。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHarness } = require('./helpers/cloud-entry');

const DOC_PATH = path.join(__dirname, '..', 'docs', '技术设计文档.md');
const COLLECTIONS = [
  'users', 'couples', 'bind_invites', 'moods',
  'hugs', 'safety_checkins', 'diaries', 'wishes',
];

function stripTicks(text) {
  return text.split(String.fromCharCode(96)).join('');
}

/** 解析 5.3 节：返回 { users: { fields: { name: { type, required } }, order: [...] }, ... } */
function parseSchema(text) {
  const lines = text.split(/\r?\n/);
  const schema = Object.create(null);
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^#### 5\.3\.\d+ \u0060([a-z_]+)\u0060$/);
    if (heading) {
      current = { fields: Object.create(null), order: [] };
      schema[heading[1]] = current;
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      current = null;
      continue;
    }
    if (!current || !line.startsWith('|')) continue;
    const cells = line.replace(/\\\|/g, '\u0001').split('|').map((c) => c.replace(/\u0001/g, '|').trim());
    if (cells.length < 4) continue;
    const field = stripTicks(cells[1]);
    const type = cells[2];
    const required = cells[3];
    if (!field || field === '字段' || /^-+$/.test(type)) continue;
    if (required !== '是' && required !== '否') continue;
    current.fields[field] = { type, required: required === '是' };
    current.order.push(field);
  }
  return schema;
}

function isDate(value) {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function describe(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (value instanceof Date) return 'Date(' + value.toISOString() + ')';
  return typeof value + ':' + JSON.stringify(value);
}

/** type 允许 'string'、'string | null'、'string[2]'、'Date'、'Date | null'、'number'、'boolean' */
function typeMatches(type, value) {
  const union = type.split('|').map((s) => s.trim());
  return union.some((part) => {
    if (part === 'null') return value === null;
    if (part === 'string') return typeof value === 'string';
    if (part === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (part === 'boolean') return typeof value === 'boolean';
    if (part === 'Date') return isDate(value);
    const arr = part.match(/^string\[(\d+)\]$/);
    if (arr) {
      return Array.isArray(value) && value.length === Number(arr[1])
        && value.every((item) => typeof item === 'string');
    }
    throw new Error('schema: 未识别的字段类型 ' + part);
  });
}

function validateDoc(schema, collection, doc) {
  const def = schema[collection];
  if (!def) throw new Error('schema: 文档 5.3 没有集合 ' + collection);
  const prefix = collection + ' ' + String(doc._id) + ': ';
  const keys = Object.keys(doc);
  for (const key of keys) {
    if (!def.fields[key]) throw new Error(prefix + '出现文档未定义的字段 ' + key);
  }
  for (const field of def.order) {
    const meta = def.fields[field];
    const present = Object.prototype.hasOwnProperty.call(doc, field) && doc[field] !== undefined;
    if (meta.required && !present) throw new Error(prefix + '缺少必填字段 ' + field);
    if (!present) continue;
    if (doc[field] === null) {
      // 可选字段用 null 表示「未设置」也算合法（文档 5.3 有的可选字段没写 null 联合类型）
      if (meta.required && !/null/.test(meta.type)) {
        throw new Error(prefix + '必填字段 ' + field + ' 不允许为 null（文档类型 ' + meta.type + '）');
      }
      continue;
    }
    if (!typeMatches(meta.type, doc[field])) {
      throw new Error(prefix + '字段 ' + field + ' 类型不符：期望 ' + meta.type + '，实际 ' + describe(doc[field]));
    }
  }
}

/** 一条完整双人链路，尽量让 8 个集合都落盘 */
async function runHappyFlow(h) {
  const A = 'oDM_A_000000000001';
  const B = 'oDM_B_000000000002';
  async function call(who, action, payload) {
    const res = await h.callAs(who, action, payload);
    assert.strictEqual(res && res.ok, true, action + ' 应成功：' + JSON.stringify(res));
    return res.data;
  }
  await call(A, 'user.updateProfile', { nickname: '小怡' });
  await call(B, 'user.updateProfile', { nickname: '阿泽' });
  const invite = await call(A, 'bind.create', { startDate: '2024-05-20' });
  await call(B, 'bind.apply', { code: invite.code });
  await call(A, 'bind.confirm', { code: invite.code });
  await call(A, 'couple.updateStartDate', { startDate: '2024-05-20' });
  await call(A, 'mood.set', { mood: 'sunny', note: '开心' });
  await call(B, 'mood.set', { mood: 'cloudy' });
  const hug = await call(A, 'hug.send', {});
  const hugId = (hug.hug && hug.hug.hugId) || hug.hugId;
  await call(B, 'hug.respond', { hugId });
  await call(A, 'safety.checkin', { note: '到家了' });
  await call(A, 'diary.save', { content: '今天很好' });
  await call(B, 'diary.save', { content: '我也很好' });
  const wish = await call(A, 'wish.add', { title: '去看海', note: '夏天' });
  const wishId = (wish.wish && wish.wish.wishId) || wish.wishId;
  await call(A, 'wish.update', { wishId, title: '去看海吧' });
  await call(A, 'wish.setDone', { wishId, done: true });
  return { A, B };
}

test('数据模型：完整链路落盘的文档字段都在文档 5.3 定义内，必填齐全、类型正确', async () => {
  const schema = parseSchema(fs.readFileSync(DOC_PATH, 'utf8'));
  for (const collection of COLLECTIONS) {
    assert.ok(schema[collection], '文档 5.3 应定义集合 ' + collection);
    assert.ok(schema[collection].order.length >= 5, '集合 ' + collection + ' 的字段表解析不应为空');
  }
  const h = createHarness();
  await runHappyFlow(h);
  const fake = h.fake();
  for (const collection of COLLECTIONS) {
    const docs = fake.all(collection);
    assert.ok(docs.length > 0, '链路跑完后集合 ' + collection + ' 应有文档');
    for (const doc of docs) validateDoc(schema, collection, doc);
  }
});

test('数据模型：唯一键 / 日期格式 / 跨集合不变量', async () => {
  const h = createHarness();
  const { A, B } = await runHappyFlow(h);
  const fake = h.fake();
  function one(collection) {
    const docs = fake.all(collection);
    assert.strictEqual(docs.length, 1, collection + ' 应有 1 条文档');
    return docs[0];
  }
  const users = fake.all('users');
  assert.strictEqual(users.length, 2, '两个账号都应建档');
  const couple = one('couples');
  assert.match(couple._id, /^c_[0-9a-f]{16}$/);
  assert.strictEqual(couple.status, 'active');
  assert.strictEqual(couple.startDate, '2024-05-20');
  assert.strictEqual(couple.startDateUpdatedBy, A);
  assert.deepStrictEqual(couple.memberOpenids.slice().sort(), [A, B].sort());
  for (const user of users) {
    assert.strictEqual(user._id, user.openid);
    assert.strictEqual(user.coupleId, couple._id);
    assert.strictEqual(user.profileComplete, user.nickname.length > 0);
    assert.ok(Number.isInteger(user.bindFailCount) && user.bindFailCount >= 0);
    assert.ok(isDate(user.createdAt) && isDate(user.updatedAt));
  }
  const invite = one('bind_invites');
  assert.match(invite._id, /^\d{6}$/);
  assert.strictEqual(invite.code, invite._id);
  assert.strictEqual(invite.creatorOpenid, A);
  assert.strictEqual(invite.applicantOpenid, B);
  assert.strictEqual(invite.status, 'confirmed');
  assert.strictEqual(invite.coupleId, couple._id);
  assert.strictEqual(invite.startDate, '2024-05-20');
  assert.ok(invite.expiresAt instanceof Date && invite.createdAt instanceof Date);
  assert.strictEqual(invite.expiresAt.getTime() - invite.createdAt.getTime(), 24 * 3600 * 1000);
  const moods = fake.all('moods');
  assert.strictEqual(moods.length, 2, '两个人都打过卡');
  const dates = moods.map((m) => m.date);
  assert.strictEqual(dates[0], dates[1], '同一天');
  assert.match(dates[0], /^\d{4}-\d{2}-\d{2}$/);
  for (const mood of moods) {
    assert.strictEqual(mood.coupleId, couple._id);
    assert.strictEqual(mood._id, mood.openid + '_' + mood.date);
    assert.ok(['sunny', 'cloudy', 'rainy', 'thunder'].indexOf(mood.mood) !== -1);
    assert.ok(mood.note.length <= 50);
  }
  const hug = one('hugs');
  assert.match(hug._id, /^h_[0-9a-f]{16}$/);
  assert.strictEqual(hug.coupleId, couple._id);
  assert.strictEqual(hug.fromOpenid, A);
  assert.strictEqual(hug.toOpenid, B);
  assert.strictEqual(hug.status, 'hugged');
  assert.ok(hug.respondedAt instanceof Date);
  assert.ok(hug.respondedAt.getTime() >= hug.createdAt.getTime());
  assert.strictEqual(hug.expiresAt.getTime() - hug.createdAt.getTime(), 7 * 24 * 3600 * 1000);
  const safety = one('safety_checkins');
  assert.strictEqual(safety.coupleId, couple._id);
  assert.strictEqual(safety.openid, A);
  assert.strictEqual(safety.note, '到家了');
  assert.strictEqual(safety.date, dates[0]);
  assert.ok(isDate(safety.createdAt));
  const diaries = fake.all('diaries');
  assert.strictEqual(diaries.length, 2, '两个人都写过日记');
  for (const diary of diaries) {
    assert.strictEqual(diary.coupleId, couple._id);
    assert.strictEqual(diary._id, diary.authorOpenid + '_' + diary.date);
    // unlockAt 必须是 date 次日 00:00 +08:00
    const expected = new Date(Date.parse(diary.date + 'T00:00:00+08:00') + 24 * 3600 * 1000);
    assert.strictEqual(diary.unlockAt.toISOString(), expected.toISOString());
  }
  const wish = one('wishes');
  assert.match(wish._id, /^w_[0-9a-f]{16}$/);
  assert.strictEqual(wish.coupleId, couple._id);
  assert.strictEqual(wish.createdBy, A);
  assert.strictEqual(wish.title, '去看海吧');
  assert.strictEqual(wish.done, true);
  assert.strictEqual(wish.doneBy, A);
  assert.ok(isDate(wish.doneAt));
});

test('数据模型校验器本身能拦住未定义字段 / 缺必填 / 类型错 / 非法 null', () => {
  const schema = parseSchema(fs.readFileSync(DOC_PATH, 'utf8'));
  const valid = {
    _id: 'oA', openid: 'oA', nickname: '小怡', coupleId: null,
    profileComplete: true, bindFailCount: 0,
    createdAt: new Date(), updatedAt: new Date(),
  };
  validateDoc(schema, 'users', valid);
  assert.throws(() => validateDoc(schema, 'users', Object.assign({}, valid, { hacked: 1 })),
    /出现文档未定义的字段 hacked/);
  const missing = Object.assign({}, valid);
  delete missing.openid;
  assert.throws(() => validateDoc(schema, 'users', missing), /缺少必填字段 openid/);
  assert.throws(() => validateDoc(schema, 'users', Object.assign({}, valid, { bindFailCount: '0' })),
    /字段 bindFailCount 类型不符/);
  assert.throws(() => validateDoc(schema, 'users', Object.assign({}, valid, { nickname: null })),
    /必填字段 nickname 不允许为 null/);
  // 可选字段用 null 表示未设置是合法状态（bindFailResetAt 文档只写 Date，实现初始写 null）
  // Date 字段的校验器自身也要有负例，否则 isDate 恒真不会被发现
  assert.throws(() => validateDoc(schema, 'users', Object.assign({}, valid, { createdAt: '2024-01-01' })),
    /字段 createdAt 类型不符/);
  assert.throws(() => validateDoc(schema, 'users', Object.assign({}, valid, { updatedAt: 1700000000000 })),
    /字段 updatedAt 类型不符/);
  // string[2] 的长度必须严格相等（多一个、少一个都算类型不符）
  const validCouple = {
    _id: 'c_abcdef0123456789', memberOpenids: ['oA', 'oB'], startDate: '2024-05-20',
    startDateUpdatedBy: 'oA', status: 'active', createdAt: new Date(), updatedAt: new Date(),
  };
  validateDoc(schema, 'couples', validCouple);
  assert.throws(() => validateDoc(schema, 'couples', Object.assign({}, validCouple, { memberOpenids: ['oA'] })),
    /字段 memberOpenids 类型不符/);
  assert.throws(() => validateDoc(schema, 'couples', Object.assign({}, validCouple, { memberOpenids: ['oA', 'oB', 'oC'] })),
    /字段 memberOpenids 类型不符/);
  assert.throws(() => validateDoc(schema, 'not_a_collection', valid), /文档 5.3 没有集合 not_a_collection/);
});
