'use strict';

/**
 * 账本权限快照（M14 / 17.3）。
 *
 * 为什么需要它：`access` 是纯请求派生状态，页面一切换（切视角、从别的 tab 回来、重建）
 * 就会先变回 `null`，而锁态条件把 `null` 当成「没有权限」——于是已授权的用户每次进来
 * 都会先看到「申请查看」，等一个往返才变成账本内容。
 *
 * 快照只解决「首帧画什么」，不替代服务端判定：
 * - 写入只认 `ledger.list` 的 `permission` / `viewRequests` 的结果；
 * - 有效期 24h（与临时授权一致；永久授权也一天一刷，避免长期离线看到已收回的账本）；
 * - key 绑定 `openid + coupleId`，换账号 / 换绑直接丢弃，绝不复用上一段关系的权限。
 */
const STORAGE_KEY = 'ledger_access_snapshot_v1';
const IDENTITY_KEY = 'me_identity';
const TTL_MS = 24 * 60 * 60 * 1000;

/** 当前身份（由 utils/me.js 在拿到 user 后写入，同步可读，首帧就能判定归属） */
function identityOf() {
  try {
    const id = wx.getStorageSync(IDENTITY_KEY);
    if (!id || !id.openid) return '';
    return String(id.openid) + '|' + String(id.coupleId || '');
  } catch (err) {
    return '';
  }
}

/**
 * 读快照。返回 `{ status, scope, expiresAt, requestedAt }`，命中不了返回 null。
 * `nowMs` 只为测试注入，业务调用不传。
 */
function read(nowMs) {
  const key = identityOf();
  if (!key) return null;
  try {
    const raw = wx.getStorageSync(STORAGE_KEY);
    if (!raw || typeof raw !== 'object' || raw.key !== key) return null;
    const savedAt = Number(raw.savedAt) || 0;
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    if (!savedAt || now - savedAt >= TTL_MS) return null;
    return {
      status: raw.status || 'none',
      scope: raw.scope === 'permanent' ? 'permanent' : 'temp',
      expiresAt: raw.expiresAt || null,
      requestedAt: raw.requestedAt || null,
    };
  } catch (err) {
    return null;
  }
}

/**
 * 写快照。`permission` 为 `null` 表示「从没申请过」，按 `none` 存——
 * 「确知没有权限」和「还不知道」是两件事，前者要能首帧直接画锁。
 */
function write(permission) {
  const key = identityOf();
  if (!key) return;
  const p = permission || { status: 'none' };
  try {
    wx.setStorageSync(STORAGE_KEY, {
      key,
      status: p.status || 'none',
      scope: p.scope === 'permanent' ? 'permanent' : 'temp',
      expiresAt: p.expiresAt || null,
      requestedAt: p.requestedAt || null,
      savedAt: Date.now(),
    });
  } catch (err) {
    // 存储不可用只影响首帧体验，不影响功能
  }
}

/** 解绑 / 注销后调用：权限不应该跨关系复用 */
function clear() {
  try {
    wx.removeStorageSync(STORAGE_KEY);
  } catch (err) {
    // 忽略
  }
}

module.exports = {
  STORAGE_KEY,
  IDENTITY_KEY,
  TTL_MS,
  read,
  write,
  clear,
  identityOf,
};
