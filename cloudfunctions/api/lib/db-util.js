'use strict';

/**
 * 云开发 document.get / update 在文档不存在时的错误形状不统一
 * （errCode -1 / DATABASE_DOCUMENT_NOT_EXIST / 文案含 not exist 等）。
 * 只有确属「不存在」才返回 true；超时、网络、权限等其它错误必须继续抛，
 * 否则会把读故障误当新建，覆盖已有文档并绕过状态校验。
 */
function isDocumentMissing(err) {
  if (!err) return false;
  const code = err.errCode || err.code || '';
  const message = String(err.message || err.errMsg || '');
  return code === -1 || code === 'DATABASE_DOCUMENT_NOT_EXIST' || /not exist|not found|不存在/i.test(message);
}

module.exports = { isDocumentMissing };
