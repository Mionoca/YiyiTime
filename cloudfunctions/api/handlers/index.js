'use strict';

/**
 * action 白名单映射：只映射已经实现的 handler，避免 require 不存在的模块导致云函数加载失败。
 * 后续里程碑（M2–M4）新增 handler 时在这里补充。
 *
 * M2 起接入双人接口时的清单（见文档 11.2）：
 * 1. handler 内先 buildContext，再调 ctx.requireBound()；
 * 2. 校验 data.coupleId === ctx.couple._id，防止旧数据串到别人的小屋；
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
  'home.get': require('./home').get,
};
