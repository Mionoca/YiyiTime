'use strict';

// 头像上传（文档 9.13 性能：图片压缩后再上传；wx.chooseAvatar 给的临时文件仍可能偏大）。
// 文档 11.9 / 3218 / 3442：上传前客户端校验图片类型与大小（仅 JPG/PNG，单张 ≤2MB），
// 服务端不信任客户端，只按 fileID 引用；压缩失败不阻断主流程，退回原图上传。
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_EXTENSIONS = ['jpg', 'jpeg', 'png'];
const TYPE_ERROR = '头像图片格式不支持，请选择 JPG 或 PNG';
const SIZE_ERROR = '头像图片超过 2MB，请换一张';

function avatarError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function extensionOf(filePath) {
  const match = String(filePath || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

// 有后缀但不在白名单（gif/bmp/heic 等）直接拒绝；没有后缀的临时路径无法判断类型，放行。
function assertAvatarType(filePath) {
  const ext = extensionOf(filePath);
  if (ext && ALLOWED_EXTENSIONS.indexOf(ext) === -1) {
    throw avatarError(TYPE_ERROR, 'AVATAR_TYPE_INVALID');
  }
}

function isAvatarValidationError(err) {
  return !!(err && (err.code === 'AVATAR_TYPE_INVALID' || err.code === 'AVATAR_TOO_LARGE'));
}

// 取文件字节数：优先 FileSystemManager.stat，失败再试 wx.getFileInfo；
// 两者都不可用或都失败时返回 null —— 宁可不拦也不误伤正常上传（真机两者都有）。
function getFileSize(filePath) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (size) => {
      if (settled) return;
      settled = true;
      resolve(typeof size === 'number' && size >= 0 ? size : null);
    };
    const fallback = () => {
      if (typeof wx.getFileInfo !== 'function') {
        done(null);
        return;
      }
      try {
        wx.getFileInfo({
          filePath,
          success: (res) => done(res && res.size),
          fail: () => done(null),
        });
      } catch (err) {
        done(null);
      }
    };
    const manager = typeof wx.getFileSystemManager === 'function' ? wx.getFileSystemManager() : null;
    if (manager && typeof manager.stat === 'function') {
      try {
        manager.stat({
          path: filePath,
          success: (res) => {
            const size = res && res.stats && res.stats.size;
            // stat 成功但字段不可用（极少数基础库版本）时退回 getFileInfo，别静默跳过校验
            if (typeof size === 'number' && size >= 0) done(size);
            else fallback();
          },
          fail: fallback,
        });
        return;
      } catch (err) {
        fallback();
        return;
      }
    }
    fallback();
  });
}

async function assertAvatarSize(filePath) {
  const size = await getFileSize(filePath);
  if (size !== null && size > MAX_AVATAR_BYTES) {
    throw avatarError(SIZE_ERROR, 'AVATAR_TOO_LARGE');
  }
}

function compressImage(src) {
  return new Promise((resolve) => {
    if (typeof wx.compressImage !== 'function') {
      resolve(src);
      return;
    }
    wx.compressImage({
      src,
      quality: 80,
      success: (res) => resolve((res && res.tempFilePath) || src),
      fail: () => resolve(src),
    });
  });
}

async function uploadAvatar(filePath) {
  if (!filePath) throw new Error('头像文件不存在');
  // 先按原图路径校验类型（压缩后的临时文件可能改名），压缩后再按真正要上传的文件校验大小。
  assertAvatarType(filePath);
  const src = await compressImage(filePath);
  await assertAvatarSize(src);
  // 压缩后的临时路径通常保留后缀；没有后缀或后缀不在白名单时按 jpg 兜底（云存储不校验内容类型）。
  const srcExt = extensionOf(src);
  const ext = ALLOWED_EXTENSIONS.indexOf(srcExt) >= 0 ? srcExt : 'jpg';
  const cloudPath = 'avatars/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath: src });
  if (!res || !res.fileID) throw new Error('头像上传失败');
  return res.fileID;
}

module.exports = {
  uploadAvatar,
  isAvatarValidationError,
  MAX_AVATAR_BYTES,
};
