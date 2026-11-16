'use strict';

/**
 * 业务错误：code 给客户端做分支，message 直接展示给用户（中文、可行动）。
 */
class AppError extends Error {
  constructor(code, message, details) {
    super(message || code);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

function toErrorResponse(err, requestId) {
  if (err instanceof AppError) {
    return {
      ok: false,
      code: err.code,
      message: err.message,
      requestId,
    };
  }
  return {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: '服务开小差了，稍后再试',
    requestId,
  };
}

module.exports = { AppError, toErrorResponse };
