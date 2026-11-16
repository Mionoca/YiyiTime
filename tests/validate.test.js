'use strict';

const test = require('node:test');
const assert = require('node:assert');

const validate = require('../cloudfunctions/api/lib/validate');
const { AppError, toErrorResponse } = require('../cloudfunctions/api/lib/errors');

function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return null;
}

test('asObject: 非对象一律返回空对象', () => {
  assert.deepStrictEqual(validate.asObject({ a: 1 }), { a: 1 });
  assert.deepStrictEqual(validate.asObject(null), {});
  assert.deepStrictEqual(validate.asObject(undefined), {});
  assert.deepStrictEqual(validate.asObject('abc'), {});
  assert.deepStrictEqual(validate.asObject([1, 2]), {});
});

test('string: 去首尾空格', () => {
  assert.strictEqual(validate.string('  小怡  ', { field: '昵称', min: 1, max: 12 }), '小怡');
});

test('string: 空值按 required 与 emptyCode 处理', () => {
  assert.strictEqual(validate.string(undefined, { field: '昵称' }), '');
  assert.strictEqual(codeOf(() => validate.string(undefined, {
    field: '昵称',
    min: 1,
    required: true,
    emptyCode: 'PROFILE_REQUIRED',
  })), 'PROFILE_REQUIRED');
  assert.strictEqual(codeOf(() => validate.string('   ', { field: '昵称', min: 1 })), 'INVALID_INPUT');
});

test('string: 超长返回 TEXT_TOO_LONG', () => {
  assert.strictEqual(codeOf(() => validate.string('一二三四五六七八九十一二三', {
    field: '昵称',
    max: 12,
  })), 'TEXT_TOO_LONG');
});

test('string: 非字符串返回 INVALID_INPUT', () => {
  assert.strictEqual(codeOf(() => validate.string(123, { field: '昵称' })), 'INVALID_INPUT');
});

test('oneOf / boolean', () => {
  assert.strictEqual(validate.oneOf('sunny', ['sunny', 'cloudy'], '心情'), 'sunny');
  assert.strictEqual(codeOf(() => validate.oneOf('snow', ['sunny', 'cloudy'], '心情')), 'INVALID_INPUT');
  assert.strictEqual(validate.boolean(false, 'done'), false);
  assert.strictEqual(codeOf(() => validate.boolean('true', 'done')), 'INVALID_INPUT');
});

test('code: 必须是 6 位数字', () => {
  assert.strictEqual(validate.code('012345'), '012345');
  assert.strictEqual(codeOf(() => validate.code('12345')), 'INVALID_INPUT');
  assert.strictEqual(codeOf(() => validate.code('12345a')), 'INVALID_INPUT');
  assert.strictEqual(codeOf(() => validate.code(112233)), 'INVALID_INPUT');
  assert.strictEqual(codeOf(() => validate.code('')), 'INVALID_INPUT');
  // 长度不对也统一 INVALID_INPUT（不走 TEXT_TOO_LONG）
  assert.strictEqual(codeOf(() => validate.code('1234567')), 'INVALID_INPUT');
});

test('errors: AppError 保留 code/message，未知错误统一 INTERNAL_ERROR', () => {
  const appErr = new AppError('INVITE_EXPIRED', '邀请码过期了');
  const response = toErrorResponse(appErr, 'req-1');
  assert.deepStrictEqual(response, {
    ok: false,
    code: 'INVITE_EXPIRED',
    message: '邀请码过期了',
    requestId: 'req-1',
  });

  const internal = toErrorResponse(new Error('boom'), 'req-2');
  assert.deepStrictEqual(internal, {
    ok: false,
    code: 'INTERNAL_ERROR',
    message: '服务开小差了，稍后再试',
    requestId: 'req-2',
  });
});
