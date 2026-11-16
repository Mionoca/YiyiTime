/**
 * 唯一云函数入口：前端只能通过这里调 api 云函数。
 * 成功返回 data；失败抛 ApiError(code, message, requestId)。
 */
class ApiError extends Error {
  constructor(code, message, requestId) {
    super(message || code);
    this.name = 'ApiError';
    // 兜底也用文档 16.2 里的码（服务端正常都会带 code，不能出现表外的码）
    this.code = code || 'INTERNAL_ERROR';
    this.message = message || '服务开小差了，稍后再试';
    this.requestId = requestId || '';
  }
}

function call(action, payload) {
  return wx.cloud
    .callFunction({
      name: 'api',
      data: { action, payload: payload || {} },
    })
    .then((res) => {
      const result = res && res.result;
      if (!result || typeof result.ok !== 'boolean') {
        throw new ApiError('EMPTY_RESPONSE', '服务没有返回结果');
      }
      if (!result.ok) {
        throw new ApiError(result.code, result.message, result.requestId);
      }
      return result.data;
    })
    .catch((err) => {
      if (err instanceof ApiError) throw err;
      const errMsg = (err && (err.errMsg || err.message)) || '';
      // 超时也归入 NETWORK_ERROR（错误码表里没有 TIMEOUT）
      const slow = errMsg.indexOf('timeout') >= 0 || errMsg.indexOf('超时') >= 0;
      throw new ApiError('NETWORK_ERROR', slow ? '网络有点慢，稍后再试' : '网络不太好，请稍后再试');
    });
}

function showError(err) {
  const message = (err && err.message) || '服务开小差了，稍后再试';
  wx.showToast({ title: message, icon: 'none', duration: 2200 });
}

module.exports = { ApiError, call, showError };
