'use strict';

/**
 * 文档 11.9 上线安全检查清单：「所有双人 handler 调 ctx.requireBound()」目前只能人工核对。
 * 本文件把它变成可回归的守卫：
 *   1. 登记的每个 action 必须被明确分类（双人 / 未绑定安全），新增 handler 忘记接入会红；
 *   2. 双人 handler 源码里必须真实调用 ctx.requireBound()，且在访问 ctx.couple / ctx.partner /
 *      relation.coupleIdOf / relation.partnerOpenidOf 这些伴侣数据入口之前；
 *   3. 未绑定时调用双人 action 一律 NOT_BOUND（鉴权先于入参校验），不依赖 handler 内部细节。
 *
 * 边界：只验证 handler 自身源码与「空库未绑定」这一条路径，不验证绑定后的业务语义
 * （那些由 server-authorization / e2e 用例覆盖）；静态规则先遮掉注释与字符串，所以注释掉的调用、
 * 字符串里的 "ctx.requireBound()" 都不算数；但把 requireBound 存进变量/解构后再调用的写法
 * （const rb = ctx.requireBound; rb();）不会被识别，需要保留本文件接受的显式调用。
 */
const test = require('node:test');
const assert = require('node:assert');

const { createHarness, captureConsoleError } = require('./helpers/cloud-entry');

const h = createHarness();
const handlers = h.handlers;

/** 允许未绑定调用的 action（每个都要写原因，防止有人图省事把新双人接口塞进来） */
const UNBOUND_SAFE = {
  'system.ping': '健康检查，不读用户数据',
  'user.get': '读自己的资料，「我的」页未绑定也要能打开',
  'user.updateProfile': '改自己的昵称/头像，绑定前就要能设置资料',
  'bind.create': '绑定流程本身在未绑定时使用',
  'bind.preview': '绑定流程本身在未绑定时使用',
  'bind.apply': '绑定流程本身在未绑定时使用',
  'bind.confirm': '绑定流程本身在未绑定时使用（确认后才有 coupleId）',
  'bind.cancel': '绑定流程本身在未绑定时使用',
  'bind.status': '绑定状态查询，未绑定要能返回空状态',
  'home.get': '首页：未绑定走引导降级分支，自行处理 couple 为空',
  'ledger.add': '记账本是个人数据，归属只看 openid，未绑定记的账 coupleId 为 null（文档 5.3.9）',
  'ledger.update': '同上：只能改自己名下的账，不需要伴侣',
  'ledger.remove': '同上：只能删自己名下的账，不需要伴侣',
  'reminder.get': '读自己的提醒设置；解绑后仍要能打开页面把开关关掉（文档 7.15）',
  'reminder.grant': '上报订阅授权结果，只影响自己的额度；未绑定时授权也可以先攒着',
};

/**
 * 只有部分路径需要绑定的 action：鉴权按入参分支，不能整条塞进上面两张表。
 * 值可以是字符串（原因，默认用 { who: 'partner' } / {} 两条路径探测），
 * 也可以是 { reason, bound, free }：分支不看 who 的接口显式给出两边的入参。
 */
const CONDITIONAL_BOUND = {
  'ledger.list': '自己的账本按 openid 归属，未绑定也能看（文档 5.3.9）；只有 who=partner 的伴侣视角要 requireBound',
  'reminder.set': {
    reason: '关闭提醒不需要绑定（解绑后必须能关掉）；只有 enabled=true 时才 requireBound，因为提醒内容是「给 TA 报平安」（文档 7.15）',
    bound: { enabled: true },
    free: { enabled: false },
  },
};

/** 必须调用 ctx.requireBound() 的双人 action（与 UNBOUND_SAFE 互补） */
const BOUND_REQUIRED = [
  'couple.updateStartDate',
  'couple.requestUnbind',
  'couple.cancelUnbind',
  'couple.confirmUnbind',
  'mood.set',
  'mood.list',
  'anniversary.add',
  'anniversary.update',
  'anniversary.remove',
  'anniversary.list',
  'safety.checkin',
  'safety.list',
  'diary.save',
  'diary.list',
  'wish.add',
  'wish.update',
  'wish.setDone',
  'wish.remove',
  'wish.list',
];

const BACKSLASH = String.fromCharCode(92);
const BACKTICK = String.fromCharCode(96);

function blank(ch) {
  return ch === '\n' ? '\n' : ' ';
}

/**
 * 把注释与字符串内容遮成等长空白（保留换行，索引不变），避免注释掉的代码、
 * 字符串里的 "ctx.requireBound()" / "ctx.couple" 骗过静态检查或造成假红。
 * 只处理常见的字符串/注释写法，不构造完整词法分析（handler 源码由本仓库维护）。
 */
function maskCommentsAndStrings(src) {
  const out = [];
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src.charAt(i);
    const next = src.charAt(i + 1);
    if (quote) {
      if (ch === BACKSLASH) {
        out.push(blank(ch));
        if (i + 1 < src.length) out.push(blank(src.charAt(i + 1)));
        i += 2;
      } else if (ch === quote) {
        out.push(' ');
        quote = null;
        i += 1;
      } else {
        out.push(blank(ch));
        i += 1;
      }
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      while (i < stop) { out.push(blank(src.charAt(i))); i += 1; }
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src.charAt(i) !== '\n') { out.push(' '); i += 1; }
    } else if (ch === '"' || ch === "'" || ch === BACKTICK) {
      quote = ch;
      out.push(' ');
      i += 1;
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join('');
}

/** handler 源码的「可执行部分」：注释与字符串已遮成空白 */
function sourceOf(action) {
  assert.strictEqual(typeof handlers[action], 'function', action + ' 不是已登记的函数');
  return maskCommentsAndStrings(String(handlers[action]));
}

/** 伴侣数据入口：先碰这些说明还没确认真的绑定了 */
const PARTNER_ACCESS = /\bctx\s*\.\s*(?:couple|partner)\b|\brelation\s*\.\s*(?:coupleIdOf|partnerOpenidOf)\b/;

function requireBoundIndex(src) {
  return src.search(/\bctx\s*\.\s*requireBound\s*\(\s*\)/);
}

test('双人 handler 必须调用 ctx.requireBound()（文档 11.9）', () => {
  const registered = Object.keys(handlers).sort();
  assert.strictEqual(registered.length, 36, '登记的 action 数量变了，请同步分类');
  const classified = registered.filter((action) => (
    !Object.prototype.hasOwnProperty.call(UNBOUND_SAFE, action)
    && !Object.prototype.hasOwnProperty.call(CONDITIONAL_BOUND, action)
  ));
  assert.deepStrictEqual(classified, BOUND_REQUIRED.slice().sort(),
    '新增/删除 action 后必须更新 UNBOUND_SAFE 或 BOUND_REQUIRED；新双人 handler 若确实允许未绑定，'
    + '请加入 UNBOUND_SAFE 并写清原因');

  const missing = BOUND_REQUIRED.filter((action) => requireBoundIndex(sourceOf(action)) === -1);
  assert.deepStrictEqual(missing, [], '这些双人 handler 没有调用 ctx.requireBound()：' + missing.join(', '));
});

test('ctx.requireBound() 必须在访问伴侣数据（couple / partner / relation helper）之前调用', () => {
  for (const action of BOUND_REQUIRED.concat(Object.keys(CONDITIONAL_BOUND))) {
    const src = sourceOf(action);
    const bound = requireBoundIndex(src);
    assert.notStrictEqual(bound, -1, action + ' 没有调用 ctx.requireBound()');
    const access = src.search(PARTNER_ACCESS);
    assert.ok(access === -1 || bound < access,
      action + ' 在鉴权之前就访问了伴侣数据（未绑定时会带着 null 的 coupleId 查询/写入）');
  }
});

test('未绑定时调用双人 action 一律 NOT_BOUND（鉴权先于入参校验）', async (t) => {
  captureConsoleError(t);
  for (const action of BOUND_REQUIRED) {
    h.reset({}, 'oA');
    const res = await h.callAs('oA', action, {});
    assert.strictEqual(res.ok, false, action);
    assert.strictEqual(res.code, 'NOT_BOUND', action + ' 未绑定时应返回 NOT_BOUND，实际 ' + res.code);
    assert.strictEqual(res.message, '先邀请 TA 住进来吧', action);
  }
});

test('按路径鉴权的 action：伴侣视角未绑定必须 NOT_BOUND，自己的数据不需要绑定', async (t) => {
  captureConsoleError(t);
  for (const [action, spec] of Object.entries(CONDITIONAL_BOUND)) {
    assert.strictEqual(typeof handlers[action], 'function', action + ' 已不在 registry，请从 CONDITIONAL_BOUND 删除');
    const normalized = typeof spec === 'string' ? { reason: spec } : spec;
    const reason = normalized.reason;
    assert.ok(typeof reason === 'string' && reason.length > 0, action + ' 缺少「哪条路径不绑」的说明');
    assert.notStrictEqual(requireBoundIndex(sourceOf(action)), -1,
      action + ' 在 CONDITIONAL_BOUND 里却没调用 ctx.requireBound()');

    // 需要绑定的那条路径：未绑定一定被拦住
    h.reset({}, 'oA');
    const boundCase = await h.callAs('oA', action, normalized.bound || { who: 'partner' });
    assert.strictEqual(boundCase.code, 'NOT_BOUND', action + ' 需要绑定的路径未绑定时应返回 NOT_BOUND');

    // 不需要绑定的那条路径：未绑定不能因为「没对象」就报 NOT_BOUND
    h.reset({}, 'oA');
    const freeCase = await h.callAs('oA', action, normalized.free || {});
    assert.notStrictEqual(freeCase.code, 'NOT_BOUND',
      action + ' 的免绑定路径在未绑定时不该被绑定校验拦住（个人数据按 openid 归属）');
  }
});

test('未绑定安全名单与 registry 一致，且确实不受绑定校验拦截', async (t) => {
  captureConsoleError(t);
  const registered = Object.keys(handlers);
  for (const [action, reason] of Object.entries(UNBOUND_SAFE)) {
    assert.ok(registered.indexOf(action) !== -1, action + ' 已不在 registry，请从 UNBOUND_SAFE 删除');
    assert.ok(typeof reason === 'string' && reason.length > 0, action + ' 缺少未绑定原因说明');
    assert.strictEqual(requireBoundIndex(sourceOf(action)), -1,
      action + ' 已在未绑定安全名单却调用了 ctx.requireBound()，请确认它是否真的允许未绑定并移出名单');
    h.reset({}, 'oA');
    const res = await h.callAs('oA', action, {});
    assert.notStrictEqual(res.code, 'NOT_BOUND',
      action + ' 在未绑定安全名单里却返回 NOT_BOUND（源码未调用 requireBound，说明是别处拦的，请人工确认它是否真的允许未绑定）');
  }
});
