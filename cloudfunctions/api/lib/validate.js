'use strict';

const { AppError } = require('./errors');

function asObject(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
}

/**
 * 字符串字段校验：去首尾空格、长度上限 TEXT_TOO_LONG、空值按 emptyCode 报错。
 */
function string(value, { field, min = 0, max = 200, trim = true, required = false, emptyCode = 'INVALID_INPUT' }) {
  if (value === undefined || value === null) {
    if (required) throw new AppError(emptyCode, field + '不能为空');
    return '';
  }
  if (typeof value !== 'string') {
    throw new AppError('INVALID_INPUT', field + '格式不对');
  }
  const v = trim ? value.trim() : value;
  if (v.length > max) {
    throw new AppError('TEXT_TOO_LONG', field + '最多 ' + max + ' 字');
  }
  if (v.length < min) {
    throw new AppError(emptyCode, field + '不能为空');
  }
  return v;
}

function oneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    throw new AppError('INVALID_INPUT', field + '不在允许范围内');
  }
  return value;
}

function boolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new AppError('INVALID_INPUT', field + '必须是布尔值');
  }
  return value;
}

/**
 * 可选整数参数：缺省返回 defaultValue，非整数/越界抛 INVALID_INPUT。
 */
function integer(value, { field, min = 0, max = 100, defaultValue }) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
    throw new AppError('INVALID_INPUT', field + '必须是整数');
  }
  if (value < min || value > max) {
    throw new AppError('INVALID_INPUT', field + '超出范围');
  }
  return value;
}

function code(value) {
  // 先按「6 位数字」整体校验，长度不对也统一返回 INVALID_INPUT（错误码表 16.2）
  const v = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{6}$/.test(v)) {
    throw new AppError('INVALID_INPUT', '邀请码是 6 位数字');
  }
  return v;
}

module.exports = { asObject, string, oneOf, boolean, integer, code };
