'use strict';

const cloud = require('wx-server-sdk');

// 先 init 再 require handlers，保证 lib 里的 cloud.database() 拿得到环境
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const handlers = require('./handlers');
const { runTimer } = require('./handlers/reminder');
const { AppError, toErrorResponse } = require('./lib/errors');
const { buildContext } = require('./lib/ctx');

/**
 * 定时触发器（config.json 的 triggers）走这里，不是 action：
 * 客户端传 action: 'reminder.tick' 会被 action 白名单挡成 UNKNOWN_ACTION。
 *
 * 但 `event` 就是客户端 wx.cloud.callFunction({ data }) 的任意对象，光看 `Type === 'Timer'`
 * 挡不住伪造——真实的定时触发器**没有用户身份**，所以必须再要求 getWXContext().OPENID 为空。
 * 同时不信任 `event.Time`：伪造一个未来日期就能让 `todayKey` 错位，「一天最多一条」直接失效；
 * 一律用服务端当前时间。
 */
function isTimerEvent(event) {
  return !!(event && event.Type === 'Timer');
}

exports.main = async (event) => {
  if (isTimerEvent(event)) {
    const wx = cloud.getWXContext() || {};
    if (wx.OPENID) {
      console.error('[timer]', JSON.stringify({
        reason: 'forged-timer-event',
        openidTail: String(wx.OPENID).slice(-6),
      }));
      return { ok: false, code: 'FORBIDDEN', message: '这个操作还不存在' };
    }

    // 触发器失败会被云端重试，所以这里自己兜住异常，只留日志
    const started = Date.now();
    try {
      const result = await runTimer({ trigger: event.TriggerName });
      console.log('[timer]', JSON.stringify(Object.assign({ ms: Date.now() - started }, result)));
      return { ok: true, data: result };
    } catch (err) {
      console.error('[timer]', JSON.stringify({
        reason: 'crashed',
        trigger: String(event.TriggerName || ''),
        code: String((err && (err.code || err.errCode)) || 'INTERNAL_ERROR'),
        message: err && err.message,
      }));
      return { ok: false, code: 'INTERNAL_ERROR' };
    }
  }

  const action = event && event.action;
  let openid = '';
  let coupleId = '';
  const rawPayload = event && event.payload;
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? rawPayload
    : {};
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(handlers, action)) {
      throw new AppError('UNKNOWN_ACTION', '这个操作还不存在');
    }

    const { OPENID } = cloud.getWXContext();
    openid = OPENID || '';
    if (!OPENID) {
      throw new AppError('UNAUTHORIZED', '请重新进入小程序');
    }

    const ctx = await buildContext({ openid: OPENID });
    coupleId = ctx.user.coupleId || '';
    const data = await handlers[action](payload, ctx);
    return { ok: true, data };
  } catch (err) {
    console.error('[api]', JSON.stringify({
      requestId,
      action,
      // 业务错误有 code，SDK 错误用 errCode；都没有时标 INTERNAL_ERROR。
      // 统一成字符串，避免同一个字段在日志里一会儿是数字一会儿是字符串
      code: String((err && (err.code || err.errCode)) || 'INTERNAL_ERROR'),
      message: err && err.message,
      openidTail: openid ? openid.slice(-6) : '',
      // 文档 6.11：coupleId 只记后 6 位，不记完整值
      coupleIdTail: coupleId ? String(coupleId).slice(-6) : '',
    }));
    return toErrorResponse(err, requestId);
  }
};
