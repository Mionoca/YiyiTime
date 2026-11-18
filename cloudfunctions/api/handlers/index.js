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
  'couple.requestUnbind': require('./couple').requestUnbind,
  'couple.cancelUnbind': require('./couple').cancelUnbind,
  'couple.confirmUnbind': require('./couple').confirmUnbind,
  'mood.set': require('./mood').set,
  'mood.list': require('./mood').list,
  'anniversary.add': require('./anniversary').add,
  'anniversary.update': require('./anniversary').update,
  'anniversary.remove': require('./anniversary').remove,
  'anniversary.list': require('./anniversary').list,
  'safety.checkin': require('./safety').checkin,
  'safety.list': require('./safety').list,
  'diary.save': require('./diary').save,
  'diary.list': require('./diary').list,
  'wish.add': require('./wish').add,
  'wish.update': require('./wish').update,
  'wish.setDone': require('./wish').setDone,
  'wish.remove': require('./wish').remove,
  'wish.list': require('./wish').list,
  'ledger.add': require('./ledger').add,
  'ledger.update': require('./ledger').update,
  'ledger.remove': require('./ledger').remove,
  'ledger.list': require('./ledger').list,
  'home.get': require('./home').get,
  'reminder.get': require('./reminder').get,
  'reminder.set': require('./reminder').set,
  'reminder.grant': require('./reminder').grant,
};
