'use strict';

/**
 * 日志与错误响应脱敏回归测试（文档 11.8「日志与脱敏」/ 11.9「上线安全检查清单」）。
 *
 * 11.9 要求「日志无正文」「错误响应不含堆栈/集合名」，此前只能靠人工 review。本文件把红线
 * 变成回归测试：
 * 1) 用户正文（昵称/心情备注/报平安备注/日记正文/愿望标题）只留在数据库，任何一条服务端
 *    日志都不能带出来；首页可选区块降级日志的字段固定为 block/message/openidTail。
 * 2) bind.create 邀请码写入失败时日志只有 attempt/errCode：邀请码就是 _id，错误消息里可能
 *    整段带出，绝不能打印（对应 handlers/bind.js 里的注释）。
 * 3) 关系异常 / 脏开始日期的告警日志只含 openidTail / coupleIdTail（各 6 位），不含完整值。
 * 4) handler 抛内部异常时，客户端响应只有 code/message/ok/requestId，不含集合名、堆栈、
 *    代码路径。
 *
 * 日志字段白名单（assertLogKeys）只允许 11.8 规定的通用字段 requestId / durationMs 额外出现；
 * 白名单是当前实现快照，新增字段需同步这里。断言按日志 header 前缀过滤，header 文案变更时
 * 需同步本文件，否则「过滤后恰好一条」的空转保护会让用例失败。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const h = createHarness();
const handlers = h.handlers;

const A = 'oLOG_A_0000000001';
const B = 'oLOG_B_0000000002';
const COUPLE_ID = 'c_0123456789abcdef';
const START = '2024-05-20';

/** 每条正文带唯一 marker，便于在日志里精确搜索（长度都符合字段上限） */
const MARK = {
  nickname: 'MARK昵称9f3',
  moodNote: 'MARK心情7b2c',
  safetyNote: 'MARK平安5d1e',
  diaryContent: 'MARK日记4d1e 今天很开心',
  wishTitle: 'MARK愿望6a2f',
  wishNote: 'MARK愿望备注8c1d',
  avatar: 'cloud://log-avatar-marker-7a1b.png',
};

function userDoc(openid, nickname, coupleId) {
  const now = new Date();
  return {
    _id: openid,
    openid,
    nickname,
    avatarFileID: 'cloud://' + openid + '.png',
    coupleId: coupleId || null,
    profileComplete: !!nickname,
    lastActiveAt: now,
    bindFailCount: 0,
    bindFailResetAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function coupleDoc(id, extra) {
  const now = new Date();
  return Object.assign({
    _id: id,
    memberOpenids: [A, B],
    startDate: START,
    startDateUpdatedBy: A,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  }, extra || {});
}

function parseLog(call) {
  return JSON.parse(call[1]);
}

function logText(calls) {
  return calls
    .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    .join('\n');
}

/** 日志里出现任意 needle 都算泄露（needle 含完整 openid / coupleId 与全部正文 marker） */
function assertNoLeak(calls, needles) {
  const text = logText(calls);
  needles.forEach((needle) => {
    assert.strictEqual(text.indexOf(needle), -1, '服务端日志不应包含敏感内容：' + needle + '\n实际日志：' + text);
  });
}

/**
 * 11.8 允许但当前实现尚未使用的通用字段：出现它们不算违规；白名单之外的新增字段一律判红。
 * 白名单是「当前实现快照」，若将来按 11.8 增加耗时 / requestId，请同步把字段加进这里，
 * 而不是放宽成「只黑名单」——否则日志多带一个 diaryContent 之类的字段不会被发现。
 */
const LOG_EXTRA_KEYS = ['requestId', 'durationMs'];

function assertLogKeys(logged, required, label) {
  const keys = Object.keys(logged).sort();
  const allowed = required.concat(LOG_EXTRA_KEYS).sort();
  keys.forEach((key) => assert.ok(allowed.indexOf(key) !== -1,
    label + ' 日志出现未允许的字段：' + key + '\n实际：' + JSON.stringify(logged)));
  required.forEach((key) => assert.ok(keys.indexOf(key) !== -1,
    label + ' 日志缺少必填字段：' + key + '\n实际：' + JSON.stringify(logged)));
}

test('日志不含用户正文，正文只留在数据库（11.8 / 11.9「日志无正文」）', async (t) => {
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID)],
  }, A);
  const logs = captureConsoleError(t);

  const writes = [
    await h.callAs(A, 'user.updateProfile', { nickname: MARK.nickname, avatarFileID: MARK.avatar }),
    await h.callAs(A, 'mood.set', { mood: 'sunny', note: MARK.moodNote }),
    await h.callAs(A, 'safety.checkin', { note: MARK.safetyNote }),
    await h.callAs(A, 'diary.save', { content: MARK.diaryContent }),
    await h.callAs(A, 'wish.add', { title: MARK.wishTitle, note: MARK.wishNote }),
  ];
  writes.forEach((res) => assert.strictEqual(res.ok, true, JSON.stringify(res)));

  // 正常读链路（首页聚合 + 三个列表）也不应把正文打进日志
  for (const action of ['home.get', 'diary.list', 'safety.list', 'wish.list']) {
    const res = await h.callAs(A, action, {});
    assert.strictEqual(res.ok, true, action);
  }

  // 首页可选区块降级：注入通用错误后，日志必须仍然只有脱敏字段
  h.setFault({ collection: 'diaries', method: 'collection', error: new Error('db unavailable') });
  const degraded = await h.callAs(A, 'home.get', {});
  h.setFault(null);
  assert.strictEqual(degraded.ok, true, '单个区块失败不能影响整页');
  assert.strictEqual(degraded.data.diary, null, 'diaries 读失败只降级日记区块');

  const optional = logs.filter((call) => call[0] === '[home.get] optional block failed');
  assert.strictEqual(optional.length, 1, '应恰好留下一条降级日志，否则用例空转');
  const optionalLog = parseLog(optional[0]);
  assertLogKeys(optionalLog, ['block', 'message', 'openidTail'], '首页可选区块降级');
  assert.strictEqual(optionalLog.block, 'diary');
  assert.strictEqual(optionalLog.message, 'db unavailable');
  assert.strictEqual(optionalLog.openidTail, A.slice(-6));

  // 头像 fileID 也是 11.8 禁止落日志的敏感字段（含完整 openid），整段日志不应出现 cloud://
  assert.strictEqual(logText(logs).indexOf('cloud://'), -1, '日志不应包含头像 fileID：' + logText(logs));
  assertNoLeak(logs, Object.keys(MARK).map((key) => MARK[key]).concat([A, B, COUPLE_ID]));
});

test('bind.create 邀请码写入失败日志只有 attempt/errCode，不含邀请码（11.8）', async (t) => {
  h.reset({ users: [userDoc(A, '小怡')] }, A);
  const logs = captureConsoleError(t);
  // 只让 add 失败（读邀请仍可用），模拟 _id 冲突；错误消息故意带出疑似邀请码
  h.setFault({
    collection: 'bind_invites',
    method: 'add',
    error: Object.assign(new Error('duplicate key _id 123456'), { errCode: 11000 }),
  });
  const res = await h.callAs(A, 'bind.create', { startDate: START });
  h.setFault(null);

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'INTERNAL_ERROR');
  assert.strictEqual(res.message, '服务开小差了，稍后再试');
  assert.strictEqual(JSON.stringify(res).indexOf('duplicate'), -1);
  assert.strictEqual(JSON.stringify(res).indexOf('11000'), -1);

  const bindLogs = logs.filter((call) => call[0] === '[bind.create] invite write failed');
  assert.strictEqual(bindLogs.length, 5, '码冲突重试 5 次应各记一条失败日志');
  bindLogs.forEach((call, index) => {
    assert.strictEqual(call[0], '[bind.create] invite write failed');
    const logged = parseLog(call);
    // 字段名精确锁定：任何新增字段（message/code/openid 等）都会让用例失败
    assertLogKeys(logged, ['attempt', 'errCode'], '邀请码写入失败第 ' + (index + 1) + ' 次');
    assert.strictEqual(logged.attempt, index + 1);
    assert.strictEqual(logged.errCode, 11000);
  });
  assert.strictEqual(h.fake().all('bind_invites').length, 0);

  // 入口兜底日志同样不能带出邀请码或原始错误消息
  const entryLogs = logs.filter((call) => call[0] === '[api]');
  assert.strictEqual(entryLogs.length, 1, '最终失败应留一条入口日志');
  const entryLog = parseLog(entryLogs[0]);
  assert.strictEqual(entryLog.action, 'bind.create');
  assert.strictEqual(entryLog.code, 'INTERNAL_ERROR');
  assert.strictEqual(entryLog.message, '服务开小差了，稍后再试');
  assert.strictEqual(logText(entryLogs).indexOf('duplicate'), -1);
  assert.strictEqual(logText(entryLogs).indexOf('11000'), -1);
  // 邀请码本身（错误消息里的 _id）也不能落日志；用固定短语避免误伤随机 requestId
  assert.strictEqual(logText(logs).indexOf('_id 123456'), -1, '邀请码不应落日志：' + logText(logs));
});

test('关系异常与脏开始日期的告警日志只含 ID 尾号（11.8）', async (t) => {
  const logs = captureConsoleError(t);

  // 1) user.coupleId 指向不存在的 couple：自愈为未绑定，日志只留 6 位尾号
  const missingId = 'c_missing1234567890';
  h.reset({ users: [userDoc(A, '小怡', missingId)], couples: [] }, A);
  const healed = await h.callAs(A, 'home.get', {});
  assert.strictEqual(healed.ok, true);
  assert.strictEqual(healed.data.bind.state, 'unbound');

  const selfHeal = logs.filter((call) => call[0] === '[home.get] couple missing or invalid');
  assert.strictEqual(selfHeal.length, 1);
  const selfHealLog = parseLog(selfHeal[0]);
  assertLogKeys(selfHealLog, ['coupleIdTail', 'openidTail'], 'home 自愈');
  assert.strictEqual(selfHealLog.openidTail, A.slice(-6));
  assert.strictEqual(selfHealLog.coupleIdTail, missingId.slice(-6));
  assert.strictEqual(logText(selfHeal).indexOf(A), -1);
  assert.strictEqual(logText(selfHeal).indexOf(missingId), -1);

  // 2) 脏 startDate：日志只记类型不记值，首页降级为没有天数/纪念日
  h.reset({
    users: [userDoc(A, '小怡', COUPLE_ID), userDoc(B, '阿安', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID, { startDate: '1999-01-01' })],
  }, A);
  const degraded = await h.callAs(A, 'home.get', {});
  assert.strictEqual(degraded.ok, true);
  assert.strictEqual(degraded.data.couple.startDate, null);
  assert.strictEqual(degraded.data.couple.daysTogether, null);

  const startLogs = logs.filter((call) => call[0] === '[home.get] couple.startDate invalid');
  assert.strictEqual(startLogs.length, 1);
  const startLog = parseLog(startLogs[0]);
  assertLogKeys(startLog, ['coupleIdTail', 'openidTail', 'startDateType'], '脏开始日期');
  assert.strictEqual(startLog.startDateType, 'string');
  assert.strictEqual(startLog.openidTail, A.slice(-6));
  assert.strictEqual(startLog.coupleIdTail, COUPLE_ID.slice(-6));
  assert.strictEqual(logText(startLogs).indexOf('1999-01-01'), -1);
  assert.strictEqual(logText(startLogs).indexOf(A), -1);

  // 3) bind.status 自愈（handlers/bind.js:509）：couples 文档缺失时同样只留 6 位尾号
  h.reset({ users: [userDoc(A, '小怡', missingId)], couples: [] }, A);
  const status = await h.callAs(A, 'bind.status', {});
  assert.strictEqual(status.ok, true);
  const bindHeal = logs.filter((call) => call[0] === '[bind] couple missing or invalid');
  assert.strictEqual(bindHeal.length, 1, 'bind.status 自愈应留一条日志');
  const bindHealLog = parseLog(bindHeal[0]);
  assertLogKeys(bindHealLog, ['coupleIdTail', 'openidTail'], 'bind 自愈');
  assert.strictEqual(bindHealLog.openidTail, A.slice(-6));
  assert.strictEqual(bindHealLog.coupleIdTail, missingId.slice(-6));
  assertNoLeak(bindHeal, [A, missingId]);
});

test('内部异常对客户端的响应不含集合名 / 堆栈 / 代码路径（11.9）', async (t) => {
  const openid = 'oLEAK_000000123456';
  // 用已绑定用户，才能验证入口日志的 coupleIdTail 也是 6 位尾号而不是完整 coupleId
  h.reset({
    users: [userDoc(openid, '小怡', COUPLE_ID)],
    couples: [coupleDoc(COUPLE_ID, { memberOpenids: [openid, B] })],
  }, openid);
  const logs = captureConsoleError(t);
  const boom = new Error('collection diaries read failed: users/couples/moods/hugs/safety_checkins/wishes/bind_invites');
  boom.stack = 'Error: collection diaries read failed\n    at loadDiary (cloudfunctions/api/lib/home-blocks.js:10:5)\n    at async home.get (cloudfunctions/api/handlers/home.js:20:3)';
  handlers['test.leak'] = () => { throw boom; };
  t.after(() => { delete handlers['test.leak']; });

  const res = await h.callAs(openid, 'test.leak', {});
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.code, 'INTERNAL_ERROR');
  assert.strictEqual(res.message, '服务开小差了，稍后再试');
  assert.deepStrictEqual(Object.keys(res).sort(), ['code', 'message', 'ok', 'requestId']);

  const resText = JSON.stringify(res);
  ['collection', 'loadDiary', 'cloudfunctions/', '    at ', 'Error:'].forEach((needle) => {
    assert.strictEqual(resText.indexOf(needle), -1, '客户端响应不应包含：' + needle + '\n' + resText);
  });

  // 服务端日志允许记录错误消息（11.8 允许堆栈，但仅云函数日志），openid / coupleId 只保留 6 位尾号。
  // 只断言入口日志：其他模块将来新增完全脱敏的日志不应让本用例红（也不该靠 logs.length 硬锁）。
  const entryLogs = logs.filter((call) => call[0] === '[api]');
  assert.strictEqual(entryLogs.length, 1, '不应缺少入口错误日志');
  const logged = parseLog(entryLogs[0]);
  assert.strictEqual(logged.message, boom.message);
  assert.strictEqual(logged.action, 'test.leak');
  assert.strictEqual(logged.code, 'INTERNAL_ERROR');
  assert.strictEqual(logged.openidTail, openid.slice(-6));
  // 11.8 / 6.11：coupleId 只记后 6 位；M7 变异（把完整 coupleId 塞进 coupleIdTail）靠这条断言拦红
  assert.strictEqual(logged.coupleIdTail, COUPLE_ID.slice(-6));
  assertNoLeak(logs, [openid, COUPLE_ID]);
});
