'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const A = 'oA';
const B = 'oB';
const COUPLE = 'c_1';
const now = () => new Date('2026-11-16T04:00:00.000Z');

function userDoc(id, extra) {
  return Object.assign({
    _id: id, openid: id, nickname: id === A ? '小怡' : '小安', avatarFileID: '',
    coupleId: COUPLE, profileComplete: true, bindFailCount: 0,
    lastActiveAt: now(), createdAt: now(), updatedAt: now(),
  }, extra || {});
}

function coupleDoc() {
  return {
    _id: COUPLE, memberOpenids: [A, B], startDate: '2024-05-20',
    startDateUpdatedBy: A, status: 'active', createdAt: now(), updatedAt: now(),
  };
}

function setup(initial) {
  const h = createHarness();
  h.reset(Object.assign({
    users: [userDoc(A), userDoc(B)],
    couples: [coupleDoc()],
  }, initial || {}));
  return h;
}

/** 让内容安全返回指定建议 */
function judge(suggest, label) {
  return async () => ({ errCode: 0, errMsg: 'ok', result: { suggest, label: label || 100 } });
}

function callsOf(h, api) {
  return h.openapiCalls().filter((c) => c.api === api);
}

test('内容安全：通过的文本正常落库，调用参数带 openid / version 2 / scene 4', async () => {
  const h = setup();
  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '今天很好' });

  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const calls = callsOf(h, 'security.msgSecCheck');
  assert.strictEqual(calls.length, 1, '一次写操作只该审一次');
  assert.strictEqual(calls[0].args.openid, A);
  assert.strictEqual(calls[0].args.version, 2);
  assert.strictEqual(calls[0].args.scene, 4, '心情备注属于社交日志');
  assert.strictEqual(calls[0].args.content, '今天很好');

  const moods = h.fake().all('moods');
  assert.strictEqual(moods.length, 1);
  assert.strictEqual(moods[0].note, '今天很好');
});

test('内容安全：risky 直接拒绝，且不写库', async (t) => {
  captureConsoleError(t);
  const h = setup();
  h.setOpenapi({ security: { msgSecCheck: judge('risky', 20011) } });

  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '违规内容' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'CONTENT_RISKY');
  assert.strictEqual(res.message, '这句话可能不太合适，换一句试试');
  assert.strictEqual(h.fake().all('moods').length, 0, '被拦下的文本不能落库');
});

test('内容安全：review（疑似）也拒绝——这里没有人工复审，放过等于没人管', async (t) => {
  captureConsoleError(t);
  const h = setup();
  h.setOpenapi({ security: { msgSecCheck: judge('review') } });

  const res = await h.callAs(A, 'diary.save', { content: '一句可疑的话' });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'CONTENT_RISKY');
  assert.strictEqual(h.fake().all('diaries').length, 0);
});

test('内容安全：接口抛错时放行，只记日志（不能因为审核抖动把日记堵死）', async (t) => {
  const logs = captureConsoleError(t);
  const h = setup();
  h.setOpenapi({
    security: {
      msgSecCheck: async () => {
        const err = new Error('system error');
        err.errCode = -1;
        throw err;
      },
    },
  });

  const res = await h.callAs(A, 'diary.save', { content: '今天很开心' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  const rows = h.fake().all('diaries');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].content, '今天很开心');

  const line = logs.map((args) => args.join(' ')).join('\n');
  assert.ok(line.indexOf('call-failed') !== -1, '必须留下可排查的日志：' + line);
  assert.ok(line.indexOf('今天很开心') === -1, '日志不能出现用户原文');
});

test('内容安全：云调用返回 errCode 非 0（如权限未开通）时放行并记 api-error', async (t) => {
  const logs = captureConsoleError(t);
  const h = setup();
  h.setOpenapi({
    security: { msgSecCheck: async () => ({ errCode: 48001, errMsg: 'api unauthorized' }) },
  });

  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '随便说说' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(logs.map((a) => a.join(' ')).join('\n').indexOf('api-error') !== -1);
});

test('内容安全：宿主没有 openapi 时放行', async (t) => {
  captureConsoleError(t);
  const h = setup();
  h.setOpenapi({ available: false });

  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '照常记录' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(h.fake().all('moods')[0].note, '照常记录');
});

test('内容安全：空文本不浪费调用（不传备注时一次都不审）', async () => {
  const h = setup();
  const res = await h.callAs(A, 'mood.set', { mood: 'sunny' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(callsOf(h, 'security.msgSecCheck').length, 0);
});

test('内容安全：超时按不可用处理，放行走（1.5s 上限）', async (t) => {
  const logs = captureConsoleError(t);
  const h = setup();
  h.setOpenapi({ security: { msgSecCheck: () => new Promise(() => {}) } });

  const started = Date.now();
  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '慢一点也没关系' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.ok(Date.now() - started < 4000, '超时保护应尽快返回');
  // 放行是兜底，但必须留痕：不然审核一直超时也没人知道
  const securityLogs = logs.filter((args) => String(args[0]).indexOf('[security]') !== -1);
  assert.strictEqual(securityLogs.length, 1, '超时放行要记一条日志：' + JSON.stringify(logs));
  assert.ok(String(securityLogs[0][1]).indexOf('call-failed') !== -1, '日志应标出 call-failed');
  assert.ok(String(securityLogs[0][1]).indexOf('慢一点也没关系') === -1, '日志不能带原文');
});

test('内容安全：昵称走 scene=1（资料），愿望标题走 scene=3（论坛）', async () => {
  const h = setup();
  await h.callAs(A, 'user.updateProfile', { nickname: '阿怡' });
  let calls = callsOf(h, 'security.msgSecCheck');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].args.scene, 1);
  assert.strictEqual(calls[0].args.content, '阿怡');

  h.reset({ users: [userDoc(A), userDoc(B)], couples: [coupleDoc()] });
  await h.callAs(A, 'wish.add', { title: '去看海', note: '夏天之前' });
  calls = callsOf(h, 'security.msgSecCheck');
  assert.deepStrictEqual(calls.map((c) => c.args.scene), [3, 4], '标题论坛、备注社交');
  assert.deepStrictEqual(calls.map((c) => c.args.content), ['去看海', '夏天之前']);
});

test('内容安全：日记 / 报平安 / 记账备注都会被审', async () => {
  const h = setup();
  await h.callAs(A, 'diary.save', { content: '今天也很喜欢你' });
  await h.callAs(A, 'safety.checkin', { note: '加班，晚点回' });
  await h.callAs(A, 'ledger.add', { amount: 1250, category: 'food', note: '午饭' });

  const contents = callsOf(h, 'security.msgSecCheck').map((c) => c.args.content);
  assert.deepStrictEqual(contents, ['今天也很喜欢你', '加班，晚点回', '午饭']);
  contents.forEach((c) => assert.ok(c.length > 0));
});

test('内容安全：愿望与记账的「修改」分支同样要审，不能只审新增', async () => {
  const h = setup({
    wishes: [{
      _id: 'w_1', coupleId: COUPLE, title: '去看海', note: '', createdBy: A,
      done: false, createdAt: now(), updatedAt: now(),
    }],
  });
  await h.callAs(A, 'wish.update', { wishId: 'w_1', title: '去看雪' });
  let contents = callsOf(h, 'security.msgSecCheck').map((c) => c.args.content);
  assert.deepStrictEqual(contents, ['去看雪']);

  const h2 = setup();
  const added = await h2.callAs(A, 'ledger.add', { amount: 100, category: 'fun' });
  await h2.callAs(A, 'ledger.update', { entryId: added.data.entry.entryId, note: '改成看电影' });
  contents = callsOf(h2, 'security.msgSecCheck').map((c) => c.args.content);
  assert.deepStrictEqual(contents, ['改成看电影'], '新增时备注为空不审，改的时候要审');
});

test('内容安全：违规拦截发生在写库之前，连「改一半」都不会发生', async (t) => {
  captureConsoleError(t);
  const h = setup();
  // 先正常记一笔
  const added = await h.callAs(A, 'ledger.add', { amount: 100, category: 'fun', note: '电影' });
  const entryId = added.data.entry.entryId;

  h.setOpenapi({ security: { msgSecCheck: judge('risky') } });
  const res = await h.callAs(A, 'ledger.update', { entryId, note: '换个说法' });
  assert.strictEqual(res.code, 'CONTENT_RISKY');

  const row = h.fake().all('ledger_entries').find((e) => e._id === entryId);
  assert.strictEqual(row.note, '电影', '被拦下时原值必须保持不变');
});

test('内容安全：首尾空格被去掉后再送审', async () => {
  const h = setup();
  await h.callAs(A, 'mood.set', { mood: 'sunny', note: '  今天很好  ' });
  assert.strictEqual(callsOf(h, 'security.msgSecCheck')[0].args.content, '今天很好');
});

test('内容安全：errCode 87014（违规）必须拦，不能当成「接口不可用」放行', async (t) => {
  const logs = captureConsoleError(t);
  const h = setup();
  h.setOpenapi({
    security: { msgSecCheck: async () => ({ errCode: 87014, errMsg: 'risky content' }) },
  });

  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '一段违规内容' });
  assert.strictEqual(res.ok, false, '87014 是「内容违规」，不是接口故障');
  assert.strictEqual(res.code, 'CONTENT_RISKY');
  assert.strictEqual(h.fake().all('moods').length, 0);
  assert.ok(logs.map((a) => a.join(' ')).join('\n').indexOf('blocked-by-errcode') !== -1);
});

test('内容安全：errCode=0 但缺 result 时放行（响应形状变了不该误伤所有人）', async (t) => {
  const logs = captureConsoleError(t);
  const h = setup();
  h.setOpenapi({ security: { msgSecCheck: async () => ({ errCode: 0, errMsg: 'ok' }) } });

  const res = await h.callAs(A, 'mood.set', { mood: 'sunny', note: '照常记录' });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(h.fake().all('moods').length, 1);
  assert.ok(logs.map((a) => a.join(' ')).join('\n').indexOf('unknown-suggest') !== -1,
    '看不懂的响应要留痕，方便发现 SDK 变了');
});
