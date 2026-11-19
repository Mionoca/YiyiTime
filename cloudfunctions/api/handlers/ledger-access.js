'use strict';

/**
 * 账本查看授权（M13，文档 5.3.12 / 5.5 / 7.19）：
 * - 双方账本默认互相不可见；查看方申请（temp=24h / permanent），主人批准后才生效；
 * - 只有主人能同意 / 拒绝 / 收回，只有申请人能撤回 pending；
 * - temp 到期惰性判断（读取时改 expired，写失败不阻塞）；
 * - 授权只影响「看」；ledger.update / remove 的归属校验不变；
 * - 记录不物理删除（审计）；同一对同时最多一条 pending / approved（check-then-write 软约束）。
 */
const crypto = require('crypto');
const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const relation = require('../lib/relation');
const time = require('../lib/time');
const { isDocumentMissing } = require('../lib/db-util');

const SCOPES = ['temp', 'permanent'];
const REQUEST_ID_MAX = 64;
/** 一段关系的授权记录很少（申请几次 + 授权一两条），一次取回 20 条足够，超了取最新的 */
const GRANT_MAX = 20;
/** 临时授权时长：批准后 24 小时 */
const TEMP_MS = 24 * 60 * 60 * 1000;

function newGrantId() {
  return 'lg_' + crypto.randomBytes(8).toString('hex');
}

function iso(value) {
  return relation.iso(value);
}

/** temp 批准后的到期时刻；permanent 返回 null（到解绑 / 收回为止） */
function expiresAtFor(scope, decidedAt) {
  if (scope !== 'temp') return null;
  return new Date(decidedAt.getTime() + TEMP_MS);
}

/**
 * 生效状态：approved(temp) 且已过期 → expired（读取侧统一走这里，调用方负责惰性写回）。
 * 脏数据兜底：未知 status 原样返回，不给「看」的资格。
 */
function effectiveStatus(doc, now) {
  if (!doc) return 'none';
  if (doc.status === 'approved' && doc.scope === 'temp') {
    const ms = time.toMillis(doc.expiresAt);
    if (!Number.isFinite(ms) || now.getTime() >= ms) return 'expired';
  }
  return doc.status;
}

/** 是否真的有权看（approved 且 temp 未过期） */
function isEffective(doc, now) {
  return effectiveStatus(doc, now) === 'approved';
}

/** 惰性写回 expired：写失败不阻塞（下一次读取还会再判一次） */
async function markExpiredIfNeeded(ctx, doc) {
  if (!doc || doc.status !== 'approved' || doc.scope !== 'temp') return false;
  if (isEffective(doc, ctx.now)) return false;
  try {
    await ctx.db.collection('ledger_view_grants').doc(doc._id).update({
      data: { status: 'expired', updatedAt: ctx.now },
    });
  } catch (err) {
    // 惰性写失败不影响本次判定（effectiveStatus 已经按过期处理）
  }
  return true;
}

/** 一次取回本关系的全部授权记录（updatedAt 倒序，越新越靠前） */
async function loadGrants(ctx) {
  const res = await ctx.db.collection('ledger_view_grants')
    .where({ coupleId: relation.coupleIdOf(ctx) })
    .orderBy('updatedAt', 'desc')
    .limit(GRANT_MAX)
    .get();
  return (res && res.data) || [];
}

/** 视图：mine = 我是不是申请人；other = 对方（昵称 / 头像，列表展示用） */
function viewOf(doc, ctx, other) {
  return {
    requestId: doc._id,
    status: effectiveStatus(doc, ctx.now),
    scope: doc.scope === 'permanent' ? 'permanent' : 'temp',
    mine: doc.viewerOpenid === ctx.openid,
    other: other || { nickname: '', avatarFileID: '' },
    requestedAt: iso(doc.requestedAt),
    decidedAt: doc.decidedAt ? iso(doc.decidedAt) : null,
    expiresAt: doc.expiresAt ? iso(doc.expiresAt) : null,
  };
}

function partnerInfo(ctx) {
  if (!ctx.partner) return { nickname: '', avatarFileID: '' };
  return { nickname: ctx.partner.nickname || '', avatarFileID: ctx.partner.avatarFileID || '' };
}

function requestIdOf(payload) {
  const id = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
  if (!id || id.length > REQUEST_ID_MAX) {
    throw new AppError('LEDGER_ACCESS_NOT_FOUND', '这个申请找不到了');
  }
  return id;
}

/** 按 _id 读一条授权记录；「不存在」与「读故障」分开处理（同 wish / diary 口径） */
async function readGrant(ctx, requestId) {
  try {
    const res = await ctx.db.collection('ledger_view_grants').doc(requestId).get();
    return (res && res.data) || null;
  } catch (err) {
    if (isDocumentMissing(err)) return null;
    throw err;
  }
}

/**
 * 我看「对方账本」的权限快照（7.13 `ledger.list` 的 `permission` 字段同源）。
 * 返回 null = 从没申请过；status 只会是 none / pending / approved / expired
 * （rejected / revoked / cancelled 对申请人侧统一折叠成 none——页面只需要「能不能看、要不要重申」）。
 */
async function permissionFor(ctx) {
  const partnerOpenid = relation.partnerOpenidOf(ctx);
  if (!partnerOpenid) return null;
  const grants = await loadGrants(ctx);
  const doc = grants.find((item) => item.viewerOpenid === ctx.openid && item.ownerOpenid === partnerOpenid) || null;
  if (!doc) return null;
  await markExpiredIfNeeded(ctx, doc);
  const status = effectiveStatus(doc, ctx.now);
  const folded = status === 'rejected' || status === 'revoked' || status === 'cancelled' ? 'none' : status;
  return {
    status: folded,
    scope: doc.scope === 'permanent' ? 'permanent' : 'temp',
    expiresAt: doc.expiresAt ? iso(doc.expiresAt) : null,
    requestedAt: iso(doc.requestedAt),
  };
}

/** home.get 的 ledgerAccess 区块（7.8）：一次查询算三个数，读预算 +1 */
async function homeAccess(ctx) {
  const partnerOpenid = relation.partnerOpenidOf(ctx);
  if (!partnerOpenid) return null;
  const grants = await loadGrants(ctx);
  let pendingIncoming = 0;
  let approvedIncoming = 0;
  let canViewPartner = false;
  for (const doc of grants) {
    if (doc.ownerOpenid === ctx.openid) {
      if (doc.status === 'pending') pendingIncoming += 1;
      else if (isEffective(doc, ctx.now)) approvedIncoming += 1;
    } else if (doc.viewerOpenid === ctx.openid && isEffective(doc, ctx.now)) {
      canViewPartner = true;
    }
  }
  return { pendingIncoming, approvedIncoming, canViewPartner };
}

/** 发起申请：同一对最多一条 pending / approved；approved 幂等返回，pending 报错 */
async function requestView(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const scope = validate.oneOf(p.scope, SCOPES, '查看时长');
  const partnerOpenid = relation.partnerOpenidOf(ctx);
  if (!partnerOpenid) {
    throw new AppError('FORBIDDEN', '你们还没有绑定');
  }
  const coupleId = relation.coupleIdOf(ctx);

  const grants = await loadGrants(ctx);
  const existing = grants.find((item) =>
    item.viewerOpenid === ctx.openid && item.ownerOpenid === partnerOpenid) || null;
  if (existing) {
    const status = effectiveStatus(existing, ctx.now);
    if (status === 'approved') {
      // 幂等：已经同意过（或 temp 还没过期）就直接返回当前授权，不新建
      return { request: viewOf(existing, ctx, partnerInfo(ctx)) };
    }
    if (status === 'pending') {
      throw new AppError('LEDGER_ACCESS_PENDING', '申请已经发出去了，等 TA 同意');
    }
    // rejected / revoked / cancelled / expired：允许重新申请，历史记录保留
    await markExpiredIfNeeded(ctx, existing);
  }

  const grantId = newGrantId();
  const doc = {
    coupleId,
    ownerOpenid: partnerOpenid,
    viewerOpenid: ctx.openid,
    scope,
    status: 'pending',
    requestedAt: ctx.now,
    decidedAt: null,
    expiresAt: null,
    updatedAt: ctx.now,
  };
  await ctx.db.collection('ledger_view_grants').doc(grantId).set({ data: doc });
  return { request: viewOf(Object.assign({ _id: grantId }, doc), ctx, partnerInfo(ctx)) };
}

/** 双方视角的授权列表（7.19）：incoming / outgoing / granted / mine + canViewPartner */
async function viewRequests(payload, ctx) {
  // 只读 action 也过一遍入参规整：传 null / 数组时给出统一错误，而不是后面读属性报 TypeError
  validate.asObject(payload);
  ctx.requireBound();

  const grants = await loadGrants(ctx);
  const other = partnerInfo(ctx);
  const incoming = [];
  const outgoing = [];
  const granted = [];
  const mine = [];
  for (const doc of grants) {
    await markExpiredIfNeeded(ctx, doc);
    const status = effectiveStatus(doc, ctx.now);
    const isOwner = doc.ownerOpenid === ctx.openid;
    const isViewer = doc.viewerOpenid === ctx.openid;
    if (!isOwner && !isViewer) continue; // 脏数据：不是这段关系双方的记录不展示
    const view = viewOf(doc, ctx, other);
    if (isOwner && status === 'pending') incoming.push(view);
    if (isViewer && status === 'pending') outgoing.push(view);
    if (isOwner && status === 'approved') granted.push(view);
    if (isViewer && status === 'approved') mine.push(view);
  }

  return {
    incoming,
    outgoing,
    granted,
    mine,
    canViewPartner: mine.length > 0,
    todayKey: time.dateKeyOf(ctx.now),
  };
}

/**
 * 主人处理申请：approve=true → approved（temp 写 expiresAt）；false → rejected。
 * 幂等：重复同意返回当前记录；其它已处理状态返回 LEDGER_ACCESS_STATE。
 */
async function decideView(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const requestId = requestIdOf(p);
  if (typeof p.approve !== 'boolean') {
    throw new AppError('INVALID_INPUT', '选一下同意还是拒绝');
  }

  const doc = await readGrant(ctx, requestId);
  if (!doc || doc.coupleId !== relation.coupleIdOf(ctx)) {
    // 不存在 / 不属于这段关系：都按「找不到」返回，不泄露其它关系的记录
    throw new AppError('LEDGER_ACCESS_NOT_FOUND', '这个申请找不到了');
  }
  if (doc.ownerOpenid !== ctx.openid) {
    // 申请人不能自己批自己的申请
    throw new AppError('FORBIDDEN', '这个申请要 TA 处理');
  }

  if (doc.status === 'approved' && p.approve) {
    // 幂等：已经同意过，返回当前记录（两台设备同时点「同意」只有一个会走到写）
    return { request: viewOf(doc, ctx, partnerInfo(ctx)) };
  }
  if (doc.status === 'rejected' && !p.approve) {
    // 幂等：重复点「拒绝」（连点 / 返回后再点）不该报错
    return { request: viewOf(doc, ctx, partnerInfo(ctx)) };
  }
  if (doc.status !== 'pending') {
    throw new AppError('LEDGER_ACCESS_STATE', '这个申请已经处理过了');
  }

  const data = {
    status: p.approve ? 'approved' : 'rejected',
    decidedAt: ctx.now,
    updatedAt: ctx.now,
  };
  if (p.approve) data.expiresAt = expiresAtFor(doc.scope, ctx.now);
  await ctx.db.collection('ledger_view_grants').doc(requestId).update({ data });
  return { request: viewOf(Object.assign({}, doc, data), ctx, partnerInfo(ctx)) };
}

/** 主人收回已生效的授权；pending 请走 decideView(false)（拒绝） */
async function revokeView(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const requestId = requestIdOf(p);
  const doc = await readGrant(ctx, requestId);
  if (!doc || doc.coupleId !== relation.coupleIdOf(ctx)) {
    throw new AppError('LEDGER_ACCESS_NOT_FOUND', '这个申请找不到了');
  }
  if (doc.ownerOpenid !== ctx.openid) {
    throw new AppError('FORBIDDEN', '只有 TA 的账本主人能收回');
  }
  if (doc.status === 'revoked') {
    return { request: viewOf(doc, ctx, partnerInfo(ctx)) };
  }
  if (doc.status !== 'approved') {
    throw new AppError('LEDGER_ACCESS_STATE', '这个申请已经处理过了');
  }

  const data = { status: 'revoked', decidedAt: ctx.now, updatedAt: ctx.now };
  await ctx.db.collection('ledger_view_grants').doc(requestId).update({ data });
  return { request: viewOf(Object.assign({}, doc, data), ctx, partnerInfo(ctx)) };
}

/** 申请人撤回未处理的申请 */
async function cancelView(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const requestId = requestIdOf(p);
  const doc = await readGrant(ctx, requestId);
  if (!doc || doc.coupleId !== relation.coupleIdOf(ctx)) {
    throw new AppError('LEDGER_ACCESS_NOT_FOUND', '这个申请找不到了');
  }
  if (doc.viewerOpenid !== ctx.openid) {
    throw new AppError('FORBIDDEN', '这是 TA 的申请，你不能撤回');
  }
  if (doc.status === 'cancelled') {
    return { request: viewOf(doc, ctx, partnerInfo(ctx)) };
  }
  if (doc.status !== 'pending') {
    throw new AppError('LEDGER_ACCESS_STATE', '这个申请已经处理过了');
  }

  const data = { status: 'cancelled', decidedAt: ctx.now, updatedAt: ctx.now };
  await ctx.db.collection('ledger_view_grants').doc(requestId).update({ data });
  return { request: viewOf(Object.assign({}, doc, data), ctx, partnerInfo(ctx)) };
}

module.exports = {
  requestView, viewRequests, decideView, revokeView, cancelView,
  permissionFor, homeAccess, loadGrants, effectiveStatus, isEffective,
  SCOPES, GRANT_MAX,
};
