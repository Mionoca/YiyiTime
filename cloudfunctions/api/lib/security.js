'use strict';

/**
 * 内容安全（文档 F12 / 11.7）。
 *
 * 只做一件事：把用户自由输入的文本送去微信 `security.msgSecCheck` v2。
 *
 * 判定策略（文档 11.7 有同样的表述）：
 * - `risky` / `review` → 拒绝，用户改一句就能继续。`review` 也拦，因为这里没有人工
 *   复审的环节，放过去等于没人管；
 * - 接口本身不可用（没声明 openapi 权限、超时、配额用尽、SDK 版本不支持）→ **放行**
 *   并记日志。这些内容只在两个人之间可见，不是公开传播；审核服务抖一下不能把写日记
 *   的路整个堵死，否则两个人的日记会因为微信接口波动而互相发不出去。
 *
 * 不接受「调用方说这段不用审」——覆盖哪些字段由各 handler 显式决定（见 11.7 的表）。
 */

const { AppError } = require('./errors');

/**
 * SDK 惰性加载：本地跑单测时没有装 wx-server-sdk，本模块又会被 handler 直接 require
 * （不经 index.js）。这里不缓存失败，等到真正调用时再取一次，测试钩子装好后即可用。
 */
let sdkRef = null;
function sdk() {
  if (sdkRef) return sdkRef;
  try {
    sdkRef = require('wx-server-sdk');
  } catch (err) {
    return null;
  }
  return sdkRef;
}

/** v2 的 scene：1 资料 / 2 评论 / 3 论坛 / 4 社交日志。字段性质不同，选的 scene 也不同 */
const SCENE = { profile: 1, comment: 2, forum: 3, social: 4 };
/** v2 单次上限 2500 字；我们的字段最长 500（M13 手帐日记），这里只是防御 */
const MAX_LEN = 2500;
/** 审核是「附加」检查，不能让它拖住写操作；超时就当不可用处理 */
const TIMEOUT_MS = 1500;
/**
 * 已知的「内容违规」errCode。v2 正常走 `result.suggest`，但如果网关 / 旧 SDK 把违规放在
 * errCode 里（87014 就是「内容含有违法违规内容」），把它当「接口不可用」放行等于留了一条
 * 完整的绕过路径。这类码必须先拦，再谈 fail-open。
 */
const RISKY_ERR_CODES = [87014];

function available() {
  const cloud = sdk();
  return !!(cloud
    && cloud.openapi
    && cloud.openapi.security
    && typeof cloud.openapi.security.msgSecCheck === 'function');
}

/**
 * 超时即视为不可用。不要在 finally 之外保留计时器：正常路径 clearTimeout，
 * 所以它不会拖住云函数返回。
 */
function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('msgSecCheck timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function warn(reason, extra) {
  // 只记原因和长度，绝不把用户原文写进日志
  console.error('[security]', JSON.stringify(Object.assign({ reason }, extra || {})));
}

/**
 * 校验一段文本。空文本直接跳过（不浪费一次调用），不返回任何值：
 * 通过就正常往下走，不通过抛 CONTENT_RISKY。
 */
async function assertText(ctx, text, scene) {
  const content = typeof text === 'string' ? text.trim() : '';
  if (!content) return;
  const openid = (ctx && ctx.openid) || '';
  if (!openid) return;

  const cloud = sdk();
  // 本地单测没有装 wx-server-sdk：这是预期情形，不记日志，免得每个用例都刷一行
  if (!cloud) return;

  if (!available()) {
    warn('openapi-unavailable', { scene: scene || 'social', length: content.length });
    return;
  }

  let res = null;
  try {
    res = await withTimeout(sdk().openapi.security.msgSecCheck({
      openid,
      scene: SCENE[scene] || SCENE.social,
      version: 2,
      content: content.slice(0, MAX_LEN),
    }), TIMEOUT_MS);
  } catch (err) {
    warn('call-failed', {
      scene: scene || 'social',
      length: content.length,
      code: String((err && (err.errCode || err.code)) || 'unknown'),
      message: err && err.message,
    });
    return;
  }

  // 云调用把业务失败放在 errCode 里（不一定会 throw）
  if (Number(res && res.errCode) !== 0) {
    const errCode = Number(res.errCode);
    if (RISKY_ERR_CODES.indexOf(errCode) !== -1) {
      warn('blocked-by-errcode', {
        scene: scene || 'social',
        length: content.length,
        code: String(errCode),
      });
      throw new AppError('CONTENT_RISKY', '这句话可能不太合适，换一句试试');
    }
    warn('api-error', {
      scene: scene || 'social',
      length: content.length,
      code: String(errCode),
    });
    return;
  }

  const suggest = res && res.result && res.result.suggest;
  if (suggest === 'risky' || suggest === 'review') {
    warn('blocked', {
      scene: scene || 'social',
      length: content.length,
      suggest,
      label: (res.result && res.result.label) || 0,
    });
    throw new AppError('CONTENT_RISKY', '这句话可能不太合适，换一句试试');
  }
  if (suggest !== 'pass') {
    // result 缺失或 suggest 是未知值：不判违规（升级 SDK 不该误伤所有用户），但要留痕
    warn('unknown-suggest', {
      scene: scene || 'social',
      length: content.length,
      suggest: String(suggest),
    });
  }
}

/**
 * M13 日记配图送审（文档 7.10 / 11.7）：
 * - 逐张 `cloud.downloadFile` → `security.imgSecCheck`；`risky`（errCode 87014）→ 拦（CONTENT_RISKY）；
 * - 接口不可用 / 下载失败 / 超时 / 超过 1MB / 类型不支持 → 放行并记日志（fail-open，与文本同一口径：
 *   内容只在两个人之间，审核抖动不能堵死写日记；客户端上传前已压缩，>1MB 属异常情况）；
 * - 与 assertText 一样只记原因与长度，不把 fileID 全量写日志。
 */
const IMAGE_TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
};
const IMAGE_MAX_BYTES = 1024 * 1024;

function imageContentTypeOf(fileID) {
  const path = String(fileID).split('?')[0];
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_TYPES[ext] || null;
}

async function checkOneImage(ctx, fileID) {
  const cloud = sdk();
  const imgAvailable = !!(cloud
    && typeof cloud.downloadFile === 'function'
    && cloud.openapi && cloud.openapi.security
    && typeof cloud.openapi.security.imgSecCheck === 'function');
  // 本地单测没有 wx-server-sdk：预期情形，不记日志
  if (!cloud) return;
  if (!imgAvailable) {
    warn('img-openapi-unavailable', { length: String(fileID).length });
    return;
  }

  const contentType = imageContentTypeOf(fileID);
  if (!contentType) {
    warn('img-type-unsupported', { ext: String(fileID).slice(-6) });
    return;
  }

  let download = null;
  try {
    download = await withTimeout(cloud.downloadFile({ fileID }), TIMEOUT_MS);
  } catch (err) {
    warn('img-download-failed', { code: String((err && (err.errCode || err.code)) || 'unknown') });
    return;
  }
  const buffer = download && download.fileContent;
  if (!buffer || !buffer.length) {
    warn('img-empty', {});
    return;
  }
  if (buffer.length > IMAGE_MAX_BYTES) {
    warn('img-too-large', { size: buffer.length });
    return;
  }

  let res = null;
  try {
    res = await withTimeout(sdk().openapi.security.imgSecCheck({
      media: { contentType, value: buffer },
    }), TIMEOUT_MS);
  } catch (err) {
    // imgSecCheck 违规（87014）时云调用会 throw：必须先拦，再谈 fail-open
    const errCode = Number(err && (err.errCode || err.code));
    if (RISKY_ERR_CODES.indexOf(errCode) !== -1) {
      warn('img-blocked-by-errcode', { code: String(errCode) });
      throw new AppError('CONTENT_RISKY', '这张配图可能不太合适，换一张试试');
    }
    warn('img-call-failed', { code: String(errCode || 'unknown') });
    return;
  }

  const errCode = Number(res && res.errCode);
  if (errCode !== 0) {
    if (RISKY_ERR_CODES.indexOf(errCode) !== -1) {
      warn('img-blocked-by-errcode', { code: String(errCode) });
      throw new AppError('CONTENT_RISKY', '这张配图可能不太合适，换一张试试');
    }
    warn('img-api-error', { code: String(errCode) });
  }
  // imgSecCheck v1 没有 suggest 字段：errCode 0 即通过
}

/** 校验一组配图（≤3 由 handler 先校验数量）。空数组直接跳过，不发起任何调用。 */
async function assertImages(ctx, images) {
  const list = Array.isArray(images) ? images : [];
  const openid = (ctx && ctx.openid) || '';
  if (!list.length || !openid) return;
  for (const fileID of list) {
    await checkOneImage(ctx, fileID);
  }
}

module.exports = { assertText, assertImages, SCENE };
