/**
 * 当前用户信息（openid 用来判断列表里哪条是「我」，文档 7.9 / 7.11）。
 * user.get 结果按会话缓存：页面间来回跳不重复请求；失败不缓存，下次重试。
 */
const api = require('./api');

let cache = null;

function getMe() {
  if (cache) return cache;
  const promise = api
    .call('user.get')
    .then((res) => {
      const user = (res && res.user) || null;
      // 正常不会为空；万一为空也不要把它永久缓存，下次仍可重试
      if (!user) cache = null;
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

module.exports = { getMe, clearMe };
