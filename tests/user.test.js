'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { get, updateProfile } = require('../cloudfunctions/api/handlers/user');
const { makeFakeDb } = require('./helpers/fake-db');
const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const NOW = new Date('2026-11-16T04:00:00.000Z');

function makeCtx({ user, users, couple = null, partner = null } = {}) {
  const fake = makeFakeDb({ users });
  return {
    ctx: {
      openid: 'oA',
      user: user || { _id: 'oA' },
      couple,
      partner,
      db: fake.db,
      now: NOW,
      requireBound() {},
    },
    fake,
  };
}

function fullUser(extra) {
  return Object.assign({
    _id: 'oA',
    openid: 'oA',
    nickname: '小怡',
    avatarFileID: 'cloud://env-1.abc/avatars/a.png',
    coupleId: 'c_1',
    profileComplete: true,
    bindFailCount: 3,
    bindFailResetAt: NOW,
    lastActiveAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  }, extra || {});
}

test('user.get: 只返回 7.3 约定的公开字段，不泄漏内部字段', async () => {
  const { ctx } = makeCtx({ user: fullUser() });
  const res = await get({}, ctx);

  assert.deepStrictEqual(res, {
    user: {
      openid: 'oA',
      nickname: '小怡',
      avatarFileID: 'cloud://env-1.abc/avatars/a.png',
      profileComplete: true,
      coupleId: 'c_1',
    },
  });
  assert.deepStrictEqual(Object.keys(res.user).sort(),
    ['avatarFileID', 'coupleId', 'nickname', 'openid', 'profileComplete']);
  assert.strictEqual(res.user.bindFailCount, undefined);
  assert.strictEqual(res.user.lastActiveAt, undefined);
  assert.strictEqual(res.user.createdAt, undefined);
});

test('user.get: 只读不写库（users.update 调用 0 次）', async () => {
  const { ctx, fake } = makeCtx({ user: { _id: 'oA', nickname: '小怡' } });
  const updateCalls = [];
  const realCollection = fake.db.collection.bind(fake.db);
  ctx.db = {
    collection(name) {
      const real = realCollection(name);
      if (name !== 'users') return real;
      return Object.assign({}, real, {
        doc(id) {
          return Object.assign({}, real.doc(id), {
            async update(arg) {
              updateCalls.push(arg);
              return { stats: { updated: 0 } };
            },
          });
        },
      });
    },
  };

  await get(null, ctx);
  assert.strictEqual(updateCalls.length, 0, 'user.get 不应写 users');
  assert.strictEqual(fake.all('users').length, 0, '也不应凭空建档');
});

test('user.get: 老数据没有 profileComplete 但有昵称时按已完成；缺省字段补空', async () => {
  const { ctx } = makeCtx({ user: { _id: 'oA', openid: 'oX', nickname: '小怡' } });
  const res = await get({}, ctx);

  assert.deepStrictEqual(res, {
    user: {
      openid: 'oA',
      nickname: '小怡',
      avatarFileID: '',
      profileComplete: true,
      coupleId: null,
    },
  });
});

test('user.updateProfile: 只改昵称（去首尾空格）并回读最新值', async () => {
  const seed = fullUser({
    nickname: '旧名字',
    profileComplete: false,
    updatedAt: new Date(NOW.getTime() - 3600 * 1000),
  });
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const res = await updateProfile({ nickname: '  小怡  ' }, ctx);

  assert.deepStrictEqual(res, {
    user: {
      openid: 'oA',
      nickname: '小怡',
      avatarFileID: 'cloud://env-1.abc/avatars/a.png',
      profileComplete: true,
      coupleId: 'c_1',
    },
  });
  const doc = fake.get('users', 'oA');
  assert.strictEqual(doc.nickname, '小怡');
  assert.strictEqual(doc.profileComplete, true);
  assert.strictEqual(doc.avatarFileID, 'cloud://env-1.abc/avatars/a.png', '没传的字段不能被覆盖成空');
  assert.deepStrictEqual(doc.updatedAt, NOW, 'updatedAt 用 ctx.now');
});

test('user.updateProfile: 只改头像时昵称保持不变', async () => {
  const seed = fullUser();
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const res = await updateProfile({ avatarFileID: 'cloud://env-1.abc/avatars/b.png' }, ctx);

  assert.strictEqual(res.user.avatarFileID, 'cloud://env-1.abc/avatars/b.png');
  assert.strictEqual(res.user.nickname, '小怡');
  assert.strictEqual(fake.get('users', 'oA').avatarFileID, 'cloud://env-1.abc/avatars/b.png');
});

test('user.updateProfile: 头像允许空字符串（重置默认头像）', async () => {
  const seed = fullUser();
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const res = await updateProfile({ avatarFileID: '' }, ctx);

  assert.strictEqual(res.user.avatarFileID, '');
  assert.strictEqual(fake.get('users', 'oA').avatarFileID, '');
});

test('user.updateProfile: 非 cloud:// 头像报 INVALID_INPUT，且不落库', async () => {
  const seed = fullUser({ nickname: '旧名字' });
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });

  await assert.rejects(
    () => updateProfile({ nickname: '新名字', avatarFileID: 'https://example.com/a.png' }, ctx),
    (err) => err.code === 'INVALID_INPUT' && err.message === '头像格式不对');
  assert.strictEqual(fake.get('users', 'oA').nickname, '旧名字', '校验失败不能先写昵称');
  assert.strictEqual(fake.get('users', 'oA').avatarFileID, seed.avatarFileID);
});

test('user.updateProfile: 昵称边界 12 字通过、13 字 TEXT_TOO_LONG', async () => {
  const seed = fullUser();
  const { ctx: ctx12, fake: fake12 } = makeCtx({ user: seed, users: [seed] });
  const twelve = '一二三四五六七八九十一二';
  const ok = await updateProfile({ nickname: twelve }, ctx12);
  assert.strictEqual(ok.user.nickname, twelve);
  assert.strictEqual(fake12.get('users', 'oA').nickname, twelve);

  const { ctx: ctx13, fake: fake13 } = makeCtx({ user: seed, users: [seed] });
  await assert.rejects(
    () => updateProfile({ nickname: twelve + '三' }, ctx13),
    (err) => err.code === 'TEXT_TOO_LONG' && err.message === '昵称最多 12 字');
  assert.strictEqual(fake13.get('users', 'oA').nickname, '小怡');
});

test('user.updateProfile: 纯空格昵称与非字符串昵称按 INVALID_INPUT 处理', async () => {
  const seed = fullUser();
  const { ctx } = makeCtx({ user: seed, users: [seed] });

  await assert.rejects(
    () => updateProfile({ nickname: '   ' }, ctx),
    (err) => err.code === 'INVALID_INPUT' && err.message === '昵称不能为空');
  await assert.rejects(
    () => updateProfile({ nickname: '' }, ctx),
    (err) => err.code === 'INVALID_INPUT' && err.message === '昵称不能为空');
  await assert.rejects(
    () => updateProfile({ nickname: 123 }, ctx),
    (err) => err.code === 'INVALID_INPUT' && err.message === '昵称格式不对');
});

test('user.updateProfile: 两个字段都没传（含 null/非对象 payload）报 PROFILE_REQUIRED', async () => {
  const cases = [
    {}, { nickname: null }, { avatarFileID: null }, { nickname: undefined, avatarFileID: undefined },
    null, undefined, 'nickname', [], { nickname: null, avatarFileID: null },
  ];
  for (const payload of cases) {
    const seed = fullUser();
    const { ctx } = makeCtx({ user: seed, users: [seed] });
    await assert.rejects(
      () => updateProfile(payload, ctx),
      (err) => err.code === 'PROFILE_REQUIRED' && err.message === '先给自己起个名字吧',
      'payload=' + JSON.stringify(payload));
  }
});

test('user.updateProfile: 回读失败时用 ctx.user + 新值兜底，不把错误抛给客户端', async () => {
  const seed = fullUser({ nickname: '旧名字' });
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const usersCol = fake.db.collection('users');
  ctx.db = {
    collection(name) {
      if (name !== 'users') return fake.db.collection(name);
      return {
        doc(id) {
          const real = usersCol.doc(id);
          return {
            update: (arg) => real.update(arg),
            async get() { throw new Error('database request timeout'); },
          };
        },
      };
    },
  };

  const res = await updateProfile({ nickname: '小怡' }, ctx);
  assert.deepStrictEqual(res.user, {
    openid: 'oA',
    nickname: '小怡',
    avatarFileID: 'cloud://env-1.abc/avatars/a.png',
    profileComplete: true,
    coupleId: 'c_1',
  });
});

test('user.updateProfile: 文档不存在时仍返回请求后视图，且 update/get 各一次、不建档', async () => {
  const seed = fullUser({ nickname: '旧名字' });
  const { ctx, fake } = makeCtx({ user: seed });
  const calls = { update: 0, get: 0 };
  const realCollection = fake.db.collection.bind(fake.db);
  ctx.db = {
    collection(name) {
      const real = realCollection(name);
      if (name !== 'users') return real;
      return Object.assign({}, real, {
        doc(id) {
          const doc = real.doc(id);
          return Object.assign({}, doc, {
            async update(arg) {
              calls.update += 1;
              return doc.update(arg);
            },
            async get() {
              calls.get += 1;
              return doc.get();
            },
          });
        },
      });
    },
  };

  const res = await updateProfile({ nickname: '小怡' }, ctx);
  assert.strictEqual(calls.update, 1, '应只写一次');
  assert.strictEqual(calls.get, 1, '应按约定回读一次（读失败才兜底）');
  assert.strictEqual(res.user.nickname, '小怡');
  assert.strictEqual(res.user.profileComplete, true);
  assert.strictEqual(fake.get('users', 'oA'), undefined, '不存在的文档不能被 update 凭空创建');
});

test('user.updateProfile: 头像超长报 TEXT_TOO_LONG，非字符串报 INVALID_INPUT', async () => {
  const seed = fullUser();
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });

  await assert.rejects(
    () => updateProfile({ avatarFileID: 'cloud://' + 'a'.repeat(1017) }, ctx),
    // 1024 上限是实现的附加约束（7.3 未规定），这里只锁错误码，不锁具体数值与文案
    (err) => err.code === 'TEXT_TOO_LONG');
  await assert.rejects(
    () => updateProfile({ avatarFileID: 123 }, ctx),
    (err) => err.code === 'INVALID_INPUT' && err.message === '头像格式不对');
  assert.strictEqual(fake.get('users', 'oA').avatarFileID, seed.avatarFileID);
});

test('user.updateProfile: 只写昵称/头像/updatedAt，不信任 payload 里的内部字段', async () => {
  const seed = fullUser({ profileComplete: false });
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const res = await updateProfile({
    nickname: '小怡',
    coupleId: 'c_hack',
    openid: 'oB',
    bindFailCount: 99,
    profileComplete: false,
  }, ctx);

  assert.strictEqual(res.user.coupleId, 'c_1');
  assert.strictEqual(res.user.openid, 'oA');
  const doc = fake.get('users', 'oA');
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(doc.openid, 'oA');
  assert.strictEqual(doc.bindFailCount, 3);
  assert.strictEqual(doc.profileComplete, true);
});
test('入口: 首次 user.get 自动建档，返回 7.3 的空资料默认值', async () => {
  const h = createHarness();
  h.reset({});

  const res = await h.callAs('oA', 'user.get');
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(res.data.user, {
    openid: 'oA',
    nickname: '',
    avatarFileID: '',
    profileComplete: false,
    coupleId: null,
  });

  const doc = h.fake().get('users', 'oA');
  assert.ok(doc, '入口层应自动建 users 文档');
  assert.strictEqual(doc.openid, 'oA');
  assert.strictEqual(doc.bindFailCount, 0);
  assert.strictEqual(doc.bindFailResetAt, null);
  assert.ok(doc.createdAt instanceof Date);
});

test('入口: 重复 user.get 不重复建档（createdAt 不变）', async () => {
  const h = createHarness();
  h.reset({});

  await h.callAs('oA', 'user.get');
  const first = h.fake().get('users', 'oA');
  const createdAt = first.createdAt;
  const updatedAt = first.updatedAt;

  await h.callAs('oA', 'user.get');
  const second = h.fake().get('users', 'oA');
  assert.strictEqual(h.fake().all('users').length, 1, '不能重复建档');
  assert.strictEqual(second.createdAt, createdAt);
  assert.strictEqual(second.updatedAt, updatedAt);
});

test('入口: updateProfile 后 user.get 读到新昵称且 profileComplete 变 true', async () => {
  const h = createHarness();
  h.reset({});

  const saved = await h.callAs('oA', 'user.updateProfile', { nickname: ' 小怡 ' });
  assert.strictEqual(saved.ok, true);
  assert.strictEqual(saved.data.user.nickname, '小怡');
  assert.strictEqual(saved.data.user.profileComplete, true);

  const got = await h.callAs('oA', 'user.get');
  assert.strictEqual(got.ok, true);
  assert.strictEqual(got.data.user.nickname, '小怡');
  assert.strictEqual(got.data.user.profileComplete, true);
  assert.strictEqual(got.data.user.coupleId, null);
});

test('user.updateProfile: 昵称 1 字边界；去首尾空格后再算长度', async () => {
  const seed = fullUser();
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const ok = await updateProfile({ nickname: '  好  ' }, ctx);
  assert.strictEqual(ok.user.nickname, '好');
  assert.strictEqual(fake.get('users', 'oA').nickname, '好');

  const another = fullUser();
  const { ctx: ctx2, fake: fake2 } = makeCtx({ user: another, users: [another] });
  const twelve = '一二三四五六七八九十一二';
  await assert.rejects(
    () => updateProfile({ nickname: '  ' + twelve + '三  ' }, ctx2),
    (err) => err.code === 'TEXT_TOO_LONG',
    'trim 后 13 字应拒绝（不先把空格也算进长度）');
  assert.strictEqual(fake2.get('users', 'oA').nickname, '小怡');

  // 反向边界：raw 14 字但去空格后 12 字，应通过（证明是「先 trim 再算长度」）
  const third = fullUser();
  const { ctx: ctx3, fake: fake3 } = makeCtx({ user: third, users: [third] });
  const padded = await updateProfile({ nickname: ' ' + twelve + ' ' }, ctx3);
  assert.strictEqual(padded.user.nickname, twelve, '首尾空格不计入长度');
  assert.strictEqual(fake3.get('users', 'oA').nickname, twelve);
});

test('user.updateProfile: nickname 为 null 时只更新头像，昵称保持不变', async () => {
  const seed = fullUser();
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const res = await updateProfile(
    { nickname: null, avatarFileID: 'cloud://env-1.abc/avatars/c.png' }, ctx);

  assert.strictEqual(res.user.nickname, '小怡');
  assert.strictEqual(res.user.avatarFileID, 'cloud://env-1.abc/avatars/c.png');
  assert.strictEqual(res.user.profileComplete, true);
  assert.strictEqual(fake.get('users', 'oA').nickname, '小怡');
});

test('user.updateProfile: 只改头像的新用户 profileComplete 仍为 false', async () => {
  const seed = fullUser({ nickname: '', profileComplete: false });
  const { ctx, fake } = makeCtx({ user: seed, users: [seed] });
  const res = await updateProfile({ avatarFileID: 'cloud://env-1.abc/avatars/d.png' }, ctx);

  assert.strictEqual(res.user.profileComplete, false, '没名字不算资料完整');
  assert.strictEqual(fake.get('users', 'oA').profileComplete, false);
});

test('user.get: 存量 profileComplete=true 但昵称为空时按已完成返回（不反推）', async () => {
  const { ctx } = makeCtx({ user: fullUser({ nickname: '', profileComplete: true }) });
  const res = await get({}, ctx);

  assert.strictEqual(res.user.profileComplete, true);
  assert.strictEqual(res.user.nickname, '');
});

test('入口: updateProfile 校验失败返回业务错误信封', async () => {
  const h = createHarness();
  h.reset({});

  // 让 users.update 抛错：如果校验通过并尝试写库，入口会返回 INTERNAL_ERROR；
  // 返回 TEXT_TOO_LONG 说明在写库前就被校验拦下（比只看库值更强）。
  h.setFault({
    collection: 'users',
    method: 'update',
    error: new Error('update should not be called'),
  });

  const res = await h.callAs('oA', 'user.updateProfile', { nickname: '一二三四五六七八九十一二三' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'TEXT_TOO_LONG');
  assert.strictEqual(res.message, '昵称最多 12 字');
  assert.strictEqual(typeof res.requestId, 'string');

  h.setFault(null);
  assert.strictEqual(h.fake().get('users', 'oA').nickname, '', '校验失败不能落库');
});

test('入口: users 读故障（非文档缺失）按 INTERNAL_ERROR 失败，且不覆盖老资料', async (t) => {
  const h = createHarness();
  const logs = captureConsoleError(t);
  h.reset({
    users: [{ _id: 'oA', nickname: '小怡', coupleId: 'c_1', profileComplete: true }],
  });
  h.setFault({
    collection: 'users',
    method: 'get',
    error: Object.assign(new Error('database timeout'), { errCode: -501001 }),
  });

  const res = await h.callAs('oA', 'user.get');
  assert.strictEqual(res.ok, false, '读故障不能被当成「没有文档」');
  assert.strictEqual(res.code, 'INTERNAL_ERROR');
  assert.strictEqual(res.message, '服务开小差了，稍后再试');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0][0], '[api]');
  const logged = JSON.parse(logs[0][1]);
  // 日志记录真实原因（SDK errCode），客户端只拿到固定文案
  assert.strictEqual(logged.code, '-501001');
  assert.strictEqual(logged.message, 'database timeout');
  assert.strictEqual(logged.action, 'user.get');

  h.setFault(null);
  const doc = h.fake().get('users', 'oA');
  assert.strictEqual(doc.nickname, '小怡', '故障时不能被空白用户覆盖');
  assert.strictEqual(doc.coupleId, 'c_1');
  assert.strictEqual(h.fake().all('users').length, 1);
});

test('入口: couples 读故障按 INTERNAL_ERROR 失败，不把用户重置成未绑定', async (t) => {
  const h = createHarness();
  const logs = captureConsoleError(t);
  h.reset({
    users: [{ _id: 'oA', nickname: '小怡', coupleId: 'c_1', profileComplete: true }],
    couples: [{ _id: 'c_1', status: 'active', memberOpenids: ['oA', 'oB'], startDate: '2024-05-20' }],
  });
  h.setFault({
    collection: 'couples',
    method: 'get',
    error: Object.assign(new Error('database timeout'), { errCode: -501001 }),
  });

  for (const action of ['home.get', 'bind.status']) {
    const res = await h.callAs('oA', action);
    assert.strictEqual(res.ok, false, action + ' 读故障不能当成「关系不存在」');
    assert.strictEqual(res.code, 'INTERNAL_ERROR');
    assert.strictEqual(res.message, '服务开小差了，稍后再试');
    assert.strictEqual(h.fake().get('users', 'oA').coupleId, 'c_1',
      action + ' 失败后 coupleId 必须保持');
  }

  assert.strictEqual(logs.length, 2);
  for (const entry of logs) {
    assert.strictEqual(entry[0], '[api]');
    const logged = JSON.parse(entry[1]);
    assert.strictEqual(logged.code, '-501001');
    assert.strictEqual(logged.message, 'database timeout');
  }

  h.setFault(null);
  const retry = await h.callAs('oA', 'home.get');
  assert.strictEqual(retry.ok, true);
  assert.strictEqual(retry.data.bind.state, 'bound');
  assert.strictEqual(retry.data.couple.coupleId, 'c_1');
  assert.strictEqual(h.fake().get('users', 'oA').coupleId, 'c_1');
});

test('入口: couples 文档确实缺失时仍按数据异常自愈回未绑定', async (t) => {
  const h = createHarness();
  const logs = captureConsoleError(t);
  h.reset({
    users: [{ _id: 'oA', nickname: '小怡', coupleId: 'c_missing', profileComplete: true }],
  });

  const res = await h.callAs('oA', 'home.get');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.data.bind.state, 'unbound');
  assert.strictEqual(h.fake().get('users', 'oA').coupleId, null, '文档缺失才允许自愈');
  assert.strictEqual(logs.length, 1);
  assert.strictEqual(logs[0][0], '[home.get] couple missing or invalid');
  assert.strictEqual(JSON.parse(logs[0][1]).coupleIdTail, 'issing');
});

test('cloud-entry.setFault: method 写错时直接抛错，避免故障没注入却假通过', () => {
  const h = createHarness();
  assert.throws(() => h.setFault({ collection: 'users', method: 'gets', error: new Error('x') }),
    /unknown method gets/);
  assert.doesNotThrow(() => h.setFault({ collection: 'users', method: 'get', error: new Error('x') }));
  assert.doesNotThrow(() => h.setFault(null));
});

test('buildContext：新用户并发建档只留一份，第二次撞 _id 时重读而不是 set 覆盖', async () => {
  const h = createHarness();
  h.reset({ users: [] });

  // 两个请求同时进来，都会先读到「文档不存在」；用 add 而不是 set，
  // 后到的那个撞 _id 唯一性后重读，不会把先到者的数据抹掉
  const [r1, r2] = await Promise.all([
    h.callAs('oNew', 'user.get'),
    h.callAs('oNew', 'user.get'),
  ]);
  assert.strictEqual(r1.ok, true, JSON.stringify(r1));
  assert.strictEqual(r2.ok, true, JSON.stringify(r2));
  assert.strictEqual(h.fake().all('users').length, 1, '只应留下一份用户文档');
  assert.strictEqual(h.fake().get('users', 'oNew').profileComplete, false);
});
