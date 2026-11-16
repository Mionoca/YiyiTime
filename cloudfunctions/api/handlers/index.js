'use strict';

/**
 * action 白名单映射：只映射已经实现的 handler，避免 require 不存在的模块导致云函数加载失败。
 * 后续里程碑（M2–M4）新增 handler 时在这里补充。
 *
 * 双人接口清单（文档 11.2）：
 * 1. handler 内先 buildContext，再调 ctx.requireBound()；
 * 2. 写操作只认 ctx.couple._id，不接受客户端传 coupleId/openid；
 * 3. 只返回纯数据，日志脱敏（openid/coupleId 只打后 6 位）。
 */
module.exports = {
  'system.ping': require('./system').ping,
  'user.get': require('./user').get,
  'user.updateProfile': require('./user').updateProfile,
  'bind.create': require('./bind').create,
  'bind.preview': require('./bind').preview,
  'bind.apply': require('./bind').apply,
  'bind.confirm': require('./bind').confirm,
  'bind.cancel': require('./bind').cancel,
  'bind.status': require('./bind').status,
  'couple.updateStartDate': require('./couple').updateStartDate,
  'mood.set': require('./mood').set,
  'hug.send': require('./hug').send,
  'hug.respond': require('./hug').respond,
  'home.get': require('./home').get,
};
