/**
 * 当前用户信息（openid 用来判断列表里哪条是「我」，文档 7.9 / 7.11）。
 * user.get 结果按会话缓存：页面间来回跳不重复请求；失败不缓存，下次重试。
 */
const api = require('./api');

// 身份快照：openid + coupleId 同步可读，给账本权限缓存做归属校验（17.3）。
// 只存这两个字段，不存昵称头像（那是 me 缓存的事）。
const IDENTITY_KEY = 'me_identity';

let cache = null;

function rememberIdentity(user) {
  try {
    wx.setStorageSync(IDENTITY_KEY, {
      openid: user.openid || '',
      coupleId: user.coupleId || '',
    });
  } catch (err) {
    // 存储不可用只影响快照命中，不影响功能
  }
}

function getMe() {
  if (cache) return cache;
  const promise = api
    .call('user.get')
    .then((res) => {
      const user = (res && res.user) || null;
      // 正常不会为空；万一为空也不要把它永久缓存，下次仍可重试
      if (!user) cache = null;
      else rememberIdentity(user);
      return user;
    })
    .catch((err) => {
      cache = null;
      throw err;
    });
  cache = promise;
  return promise;
}

/** 主动作废缓存（资料修改后调用） */
function clearMe() {
  cache = null;
}

module.exports = { getMe, clearMe, rememberIdentity };
