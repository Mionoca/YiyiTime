'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { installWx, restoreWx } = require('./helpers/client-page');
const upload = require('../miniprogram/utils/upload');

// 固定时钟与随机数，避免 cloudPath 断言随运行时间漂移。
// node --test 每个测试文件独立子进程，这里覆盖全局不会影响其它文件；文件结束用 test.after 还原。
const realNow = Date.now;
const realRandom = Math.random;
const FIXED_NOW = 1794812400000; // 东八区 2026-11-16 15:00
Date.now = () => FIXED_NOW;
Math.random = () => 0.5; // (0.5).toString(36) === '0.i'，slice(2, 8) === 'i'

test.after(() => {
  Date.now = realNow;
  Math.random = realRandom;
  restoreWx();
});

test('uploadAvatar: 压缩成功后用压缩文件上传，路径带时间戳与原后缀', async () => {
  let compressedWith = null;
  let uploadOpts = null;
  installWx({
    compressImage(opts) {
      compressedWith = opts;
      opts.success({ tempFilePath: 'wxfile://tmp/compressed.png' });
    },
    cloud: {
      uploadFile(opts) {
        uploadOpts = opts;
        return Promise.resolve({ fileID: 'cloud://env/avatars/a.png' });
      },
    },
  });
  const fileID = await upload.uploadAvatar('wxfile://tmp/original.png');
  assert.strictEqual(fileID, 'cloud://env/avatars/a.png');
  assert.strictEqual(compressedWith.src, 'wxfile://tmp/original.png');
  assert.strictEqual(compressedWith.quality, 80);
  assert.strictEqual(uploadOpts.filePath, 'wxfile://tmp/compressed.png');
  assert.strictEqual(uploadOpts.cloudPath, 'avatars/1794812400000-i.png');
});

test('uploadAvatar: 压缩成功但没返回 tempFilePath 时回退原图，不传空路径', async () => {
  let uploadOpts = null;
  installWx({
    compressImage(opts) {
      opts.success({});
    },
    cloud: {
      uploadFile(opts) {
        uploadOpts = opts;
        return Promise.resolve({ fileID: 'cloud://env/avatars/e.png' });
      },
    },
  });
  assert.strictEqual(await upload.uploadAvatar('wxfile://tmp/original.png'), 'cloud://env/avatars/e.png');
  assert.strictEqual(uploadOpts.filePath, 'wxfile://tmp/original.png');
});

test('uploadAvatar: 压缩失败回退原图，不阻断主流程', async () => {
  let uploadOpts = null;
  installWx({
    compressImage(opts) {
      opts.fail({ errMsg: 'compressImage:fail' });
    },
    cloud: {
      uploadFile(opts) {
        uploadOpts = opts;
        return Promise.resolve({ fileID: 'cloud://env/avatars/b.jpg' });
      },
    },
  });
  assert.strictEqual(await upload.uploadAvatar('wxfile://tmp/original.jpg'), 'cloud://env/avatars/b.jpg');
  assert.strictEqual(uploadOpts.filePath, 'wxfile://tmp/original.jpg');
});

test('uploadAvatar: 基础库没有 compressImage 时直接上传原图', async () => {
  let uploadOpts = null;
  installWx({
    cloud: {
      uploadFile(opts) {
        uploadOpts = opts;
        return Promise.resolve({ fileID: 'cloud://env/avatars/c.jpeg' });
      },
    },
  });
  await upload.uploadAvatar('/tmp/noext');
  assert.strictEqual(uploadOpts.filePath, '/tmp/noext');
  // 没有后缀时按 jpg 兜底
  assert.strictEqual(uploadOpts.cloudPath, 'avatars/1794812400000-i.jpg');
});

test('uploadAvatar: 上传接口 reject 时原样上抛，不吞成「上传失败」', async () => {
  const boom = new Error('uploadFile:fail net');
  installWx({
    cloud: { uploadFile: () => Promise.reject(boom) },
  });
  // 断言同一个错误对象透传，而不是被包装成新的「头像上传失败」
  await assert.rejects(() => upload.uploadAvatar('/tmp/a.png'), (err) => {
    assert.strictEqual(err, boom);
    return true;
  });
});

test('uploadAvatar: 上传成功但没有 fileID 视为失败', async () => {
  installWx({ cloud: { uploadFile: () => Promise.resolve({}) } });
  await assert.rejects(() => upload.uploadAvatar('/tmp/a.png'), /头像上传失败/);
  installWx({ cloud: { uploadFile: () => Promise.resolve(null) } });
  await assert.rejects(() => upload.uploadAvatar('/tmp/a.png'), /头像上传失败/);
});

test('uploadAvatar: 空文件路径直接拒绝，不发请求', async () => {
  let called = false;
  installWx({
    cloud: {
      uploadFile() {
        called = true;
        return Promise.resolve({ fileID: 'x' });
      },
    },
  });
  await assert.rejects(() => upload.uploadAvatar(''), /头像文件不存在/);
  await assert.rejects(() => upload.uploadAvatar(null), /头像文件不存在/);
  assert.strictEqual(called, false);
});
