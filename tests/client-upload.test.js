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
// 文档 11.9 / 3218 / 3442：上传前客户端校验图片类型与大小（仅 JPG/PNG，单张 ≤2MB）。
function fsManager(sizes) {
  return {
    stat(opts) {
      const size = sizes[opts.path];
      if (typeof size === 'number') opts.success({ stats: { size } });
      else opts.fail({ errMsg: 'stat:fail' });
    },
  };
}

test('uploadAvatar: 后缀不在白名单（GIF）直接拒绝，不压缩也不上传', async () => {
  let compressed = false;
  let uploaded = false;
  installWx({
    // 正确实现会在压缩前就拒绝，桩不会被调用；万一校验被删掉，让流程干净失败而不是悬空
    compressImage(opts) { compressed = true; opts.fail({ errMsg: 'compressImage:fail' }); },
    cloud: { uploadFile() { uploaded = true; return Promise.resolve({ fileID: 'x' }); } },
  });
  await assert.rejects(() => upload.uploadAvatar('wxfile://tmp/a.gif'), (err) => {
    assert.strictEqual(err.message, '头像图片格式不支持，请选择 JPG 或 PNG');
    assert.strictEqual(err.code, 'AVATAR_TYPE_INVALID');
    assert.strictEqual(upload.isAvatarValidationError(err), true);
    return true;
  });
  assert.strictEqual(compressed, false);
  assert.strictEqual(uploaded, false);
});

test('uploadAvatar: 后缀大小写不敏感（.PNG 允许上传）', async () => {
  let uploadOpts = null;
  installWx({
    getFileSystemManager: () => fsManager({ 'wxfile://tmp/A.PNG': 1024 }),
    cloud: { uploadFile(opts) { uploadOpts = opts; return Promise.resolve({ fileID: 'cloud://env/avatars/u.png' }); } },
  });
  assert.strictEqual(await upload.uploadAvatar('wxfile://tmp/A.PNG'), 'cloud://env/avatars/u.png');
  assert.strictEqual(uploadOpts.cloudPath, 'avatars/1794812400000-i.png');
});

test('uploadAvatar: 文件超过 2MB 拒绝上传', async () => {
  let uploaded = false;
  installWx({
    getFileSystemManager: () => fsManager({ 'wxfile://tmp/big.png': upload.MAX_AVATAR_BYTES + 1 }),
    cloud: { uploadFile() { uploaded = true; return Promise.resolve({ fileID: 'x' }); } },
  });
  await assert.rejects(() => upload.uploadAvatar('wxfile://tmp/big.png'), (err) => {
    assert.strictEqual(err.message, '头像图片超过 2MB，请换一张');
    assert.strictEqual(err.code, 'AVATAR_TOO_LARGE');
    assert.strictEqual(upload.isAvatarValidationError(err), true);
    return true;
  });
  assert.strictEqual(uploaded, false);
});

test('uploadAvatar: 恰好 2MB 允许上传（边界值不误伤）', async () => {
  let uploaded = false;
  installWx({
    getFileSystemManager: () => fsManager({ 'wxfile://tmp/2mb.png': upload.MAX_AVATAR_BYTES }),
    cloud: { uploadFile() { uploaded = true; return Promise.resolve({ fileID: 'cloud://env/avatars/2mb.png' }); } },
  });
  assert.strictEqual(await upload.uploadAvatar('wxfile://tmp/2mb.png'), 'cloud://env/avatars/2mb.png');
  assert.strictEqual(uploaded, true);
});

test('uploadAvatar: 压缩后文件仍超 2MB 时按压缩后的文件拦截', async () => {
  let uploaded = false;
  installWx({
    compressImage(opts) {
      opts.success({ tempFilePath: 'wxfile://tmp/compressed.png' });
    },
    getFileSystemManager: () => fsManager({
      'wxfile://tmp/original.png': 1024,
      'wxfile://tmp/compressed.png': upload.MAX_AVATAR_BYTES + 1,
    }),
    cloud: { uploadFile() { uploaded = true; return Promise.resolve({ fileID: 'x' }); } },
  });
  await assert.rejects(() => upload.uploadAvatar('wxfile://tmp/original.png'), /超过 2MB/);
  assert.strictEqual(uploaded, false);
});

test('uploadAvatar: stat 失败时回退 wx.getFileInfo，仍能拦住超限文件', async () => {
  let infoPath = '';
  installWx({
    getFileSystemManager: () => fsManager({}),
    getFileInfo(opts) {
      infoPath = opts.filePath;
      opts.success({ size: upload.MAX_AVATAR_BYTES + 1 });
    },
    cloud: { uploadFile() { return Promise.resolve({ fileID: 'x' }); } },
  });
  await assert.rejects(() => upload.uploadAvatar('wxfile://tmp/c.png'), (err) => {
    assert.strictEqual(err.code, 'AVATAR_TOO_LARGE');
    return true;
  });
  assert.strictEqual(infoPath, 'wxfile://tmp/c.png');
});

test('uploadAvatar: 取不到文件大小（stat 与 getFileInfo 都失败）时跳过大小校验，不误伤上传', async () => {
  let uploaded = false;
  installWx({
    getFileSystemManager: () => fsManager({}),
    getFileInfo(opts) { opts.fail({ errMsg: 'getFileInfo:fail' }); },
    cloud: { uploadFile() { uploaded = true; return Promise.resolve({ fileID: 'cloud://env/avatars/ok.png' }); } },
  });
  assert.strictEqual(await upload.uploadAvatar('wxfile://tmp/ok.png'), 'cloud://env/avatars/ok.png');
  assert.strictEqual(uploaded, true);
});

test('uploadAvatar: isAvatarValidationError 只识别类型/大小两类校验错误', () => {
  assert.strictEqual(upload.isAvatarValidationError(null), false);
  assert.strictEqual(upload.isAvatarValidationError(new Error('uploadFile:fail net')), false);
  const typeErr = new Error('x');
  typeErr.code = 'AVATAR_TYPE_INVALID';
  const sizeErr = new Error('x');
  sizeErr.code = 'AVATAR_TOO_LARGE';
  assert.strictEqual(upload.isAvatarValidationError(typeErr), true);
  assert.strictEqual(upload.isAvatarValidationError(sizeErr), true);
});

// 防御分支：stat 抛同步异常 / 返回字段不可用时要回退 getFileInfo，不能静默跳过大小校验。
test('uploadAvatar: stat 同步抛异常时回退 wx.getFileInfo，仍能拦住超限文件', async () => {
  let infoCalled = false;
  installWx({
    getFileSystemManager: () => ({ stat() { throw new Error('stat boom'); } }),
    getFileInfo(opts) {
      infoCalled = true;
      opts.success({ size: upload.MAX_AVATAR_BYTES + 1 });
    },
    cloud: { uploadFile() { return Promise.resolve({ fileID: 'x' }); } },
  });
  await assert.rejects(() => upload.uploadAvatar('wxfile://tmp/throw.png'), (err) => {
    assert.strictEqual(err.code, 'AVATAR_TOO_LARGE');
    return true;
  });
  assert.strictEqual(infoCalled, true);
});

test('uploadAvatar: stat 返回的 stats.size 不是数字时回退 getFileInfo，不静默放行', async () => {
  let infoPath = '';
  installWx({
    getFileSystemManager: () => ({ stat(opts) { opts.success({ stats: { size: '1048576' } }); } }),
    getFileInfo(opts) {
      infoPath = opts.filePath;
      opts.success({ size: upload.MAX_AVATAR_BYTES + 1 });
    },
    cloud: { uploadFile() { return Promise.resolve({ fileID: 'x' }); } },
  });
  await assert.rejects(() => upload.uploadAvatar('wxfile://tmp/weird.png'), /超过 2MB/);
  assert.strictEqual(infoPath, 'wxfile://tmp/weird.png');
});

