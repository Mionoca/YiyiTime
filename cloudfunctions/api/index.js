'use strict';

const cloud = require('wx-server-sdk');

// 先 init 再 require handlers，保证 lib 里的 cloud.database() 拿得到环境
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const handlers = require('./handlers');
const { AppError, toErrorResponse } = require('./lib/errors');
const { buildContext } = require('./lib/ctx');

exports.main = async (event) => {
  const action = event && event.action;
  let openid = '';
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
      throw new AppError('UNAUTHORIZED', '无法识别当前用户');
    }

    const ctx = await buildContext({ openid: OPENID });
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
    }));
    return toErrorResponse(err, requestId);
  }
};
