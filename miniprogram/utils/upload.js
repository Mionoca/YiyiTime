'use strict';

// 头像上传（文档 9.13 性能：图片压缩后再上传；wx.chooseAvatar 给的临时文件仍可能偏大）
// 压缩失败不阻断主流程，退回原图上传。
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
  const src = await compressImage(filePath);
  // 压缩后的临时路径通常保留后缀；没有后缀时按 jpg 兜底（不影响上传，云存储不校验内容类型）
  const extMatch = String(src).match(/\.(\w+)$/);
  const ext = extMatch ? extMatch[1] : 'jpg';
  const cloudPath = 'avatars/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath: src });
  if (!res || !res.fileID) throw new Error('头像上传失败');
  return res.fileID;
}

module.exports = { uploadAvatar };
