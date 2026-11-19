'use strict';

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const security = require('../lib/security');

const AVATAR_PREFIX = 'cloud://';
const AVATAR_MAX_LEN = 1024;

function publicUser(user) {
  return {
    openid: user._id || user.openid,
    nickname: user.nickname || '',
    avatarFileID: user.avatarFileID || '',
    profileComplete: !!(user.profileComplete || user.nickname),
    coupleId: user.coupleId || null,
  };
}

async function get(payload, ctx) {
  return { user: publicUser(ctx.user) };
}

async function updateProfile(payload, ctx) {
  const p = validate.asObject(payload);
  const hasNickname = p.nickname !== undefined && p.nickname !== null;
  const hasAvatar = p.avatarFileID !== undefined && p.avatarFileID !== null;
  if (!hasNickname && !hasAvatar) {
    throw new AppError('PROFILE_REQUIRED', '先给自己起个名字吧');
  }

  const data = { updatedAt: ctx.now };

  if (hasNickname) {
    // 昵称 1–12 字（去首尾空格后）
    data.nickname = validate.string(p.nickname, { field: '昵称', min: 1, max: 12, required: true });
    // 昵称会显示给对方，属于资料类内容（scene=1）
    await security.assertText(ctx, data.nickname, 'profile');
    data.profileComplete = true;
  }

  if (hasAvatar) {
    const avatarFileID = validate.string(p.avatarFileID, { field: '头像', min: 0, max: AVATAR_MAX_LEN });
    if (avatarFileID && avatarFileID.indexOf(AVATAR_PREFIX) !== 0) {
      throw new AppError('INVALID_INPUT', '头像格式不对');
    }
    data.avatarFileID = avatarFileID;
  }

  await ctx.db.collection('users').doc(ctx.openid).update({ data });

  const fresh = await ctx.db.collection('users').doc(ctx.openid).get().catch(() => null);
  return { user: publicUser((fresh && fresh.data) || Object.assign({}, ctx.user, data)) };
}

/* ────────────────────────── 自助注销（M14 / 7.20 / 17.8） ────────────────────────── */

/** 单批删除上限与最大批数：云开发单次查询上限 100，取 50 让每批的删除并发不至于太猛 */
const DELETE_BATCH = 50;
const DELETE_MAX_BATCHES = 20;
/** 云开发「集合不存在」的 errCode：M14 下线的两个集合在新环境里不会建，读到它就是「没东西可删」 */
const DB_MISSING_CODE = '-502005';

/** 集合不存在：优先看 errCode，再看 errMsg（不同 SDK 版本两种都可能只给一个） */
function isMissingCollection(err) {
  const code = String((err && (err.errCode || err.code)) || '');
  if (code === DB_MISSING_CODE) return true;
  const msg = String((err && (err.errMsg || err.message)) || '');
  return /collection\s+not\s+exist/i.test(msg);
}
/** 云存储一次最多 50 个 fileID */
const FILE_BATCH = 50;

/**
 * 惰性拿 SDK：本地单测没有 wx-server-sdk，直接 require 会炸（同 security.js / growth-sub.js）。
 * 注意 `require('wx-server-sdk')` 返回的就是 SDK 本身（deleteFile 挂在它上面），
 * 不是 `.cloud`——写成 `.cloud` 会永远拿到 undefined，云存储文件就一个都删不掉。
 */
function lazyCloud() {
  try {
    return require('wx-server-sdk');
  } catch (err) {
    return null;
  }
}

/**
 * 读一批待删文档。集合不存在（M14 下线的 `safety_checkins` / `pauses` 在新环境里根本不会建）
 * 或读失败都返回空数组：注销是「删干净」而不是「必须存在」，不能让一个空集合把整件事打断。
 */
async function queryBatch(ctx, name, where) {
  try {
    return await ctx.db.collection(name).where(where).limit(DELETE_BATCH).get();
  } catch (err) {
    if (!isMissingCollection(err)) {
      console.error('[account] query-failed', JSON.stringify({
        reason: 'query-failed',
        collection: name,
        code: String((err && (err.errCode || err.code)) || ''),
      }));
    }
    return { data: [] };
  }
}

/**
 * 删掉某集合里满足条件的全部文档。返回真正删掉的条数。
 * 不用 `where().remove()`：假库与部分 SDK 版本不支持，逐条 remove 更可预期。
 */
async function removeWhere(ctx, name, where) {
  let removed = 0;
  for (let i = 0; i < DELETE_MAX_BATCHES; i += 1) {
    const res = await queryBatch(ctx, name, where);
    const docs = (res && res.data) || [];
    if (!docs.length) break;
    const results = await Promise.all(docs.map((doc) => ctx.db.collection(name).doc(doc._id).remove()
      .then(() => 1)
      .catch(() => 0)));
    removed += results.reduce((sum, n) => sum + n, 0);
    if (docs.length < DELETE_BATCH) break;
    // 整批一条都没删掉：继续循环只会无限重试同一批，直接收手
    if (!results.some(Boolean)) break;
  }
  return removed;
}

/** 日记要额外收集配图 fileID——文档删了但云存储文件还在，等于没删干净 */
async function removeDiaries(ctx, where) {
  const files = [];
  let removed = 0;
  for (let i = 0; i < DELETE_MAX_BATCHES; i += 1) {
    const res = await queryBatch(ctx, 'diaries', where);
    const docs = (res && res.data) || [];
    if (!docs.length) break;
    docs.forEach((doc) => {
      (doc.images || []).forEach((fileID) => {
        if (fileID) files.push(fileID);
      });
    });
    const results = await Promise.all(docs.map((doc) => ctx.db.collection('diaries').doc(doc._id).remove()
      .then(() => 1)
      .catch(() => 0)));
    removed += results.reduce((sum, n) => sum + n, 0);
    if (docs.length < DELETE_BATCH) break;
    if (!results.some(Boolean)) break;
  }
  return { removed, files };
}

/** 删云存储文件：失败只记日志，不阻断（文件成孤儿也不影响用户已经注销这件事） */
async function removeFiles(files) {
  const list = (files || []).filter(Boolean);
  if (!list.length) return 0;
  const cloud = lazyCloud();
  if (!cloud || typeof cloud.deleteFile !== 'function') return 0;
  let removed = 0;
  for (let i = 0; i < list.length; i += FILE_BATCH) {
    const batch = list.slice(i, i + FILE_BATCH);
    try {
      const res = await cloud.deleteFile({ fileList: batch });
      ((res && res.fileList) || []).forEach((item) => {
        if (item && item.status === 0) removed += 1;
      });
    } catch (err) {
      console.error('[account] delete-files-failed', JSON.stringify({ count: batch.length }));
    }
  }
  return removed;
}

/**
 * 注销时把关系直接结束：不走「双方确认」的解绑（人已经要走了，卡在确认环节等于不让他注销）。
 * 对方的 users 仍保留，只清 coupleId 与提醒开关，保证他还能正常用。
 */
async function unbindForDelete(ctx) {
  const couple = ctx.couple;
  if (!couple || !couple._id || couple.status !== 'active') return null;
  const members = couple.memberOpenids || [];

  await ctx.db.collection('couples').doc(couple._id).update({
    data: {
      status: 'closed',
      unbindStatus: 'done',
      unbindConfirmedBy: ctx.openid,
      unboundAt: ctx.now,
      updatedAt: ctx.now,
    },
  });

  for (const openid of members) {
    // 自己的文档最后整条删，这里只处理对方
    if (openid === ctx.openid) continue;
    await ctx.db.collection('users').doc(openid).update({
      data: { coupleId: null, reminderEnabled: false, updatedAt: ctx.now },
    }).catch(() => null);
  }
  return couple._id;
}

/**
 * 注销：删掉「我」的全部数据，保留共同记忆。
 * 幂等：任何一步失败都可以整体重试（删除本身幂等）；users 文档最后删。
 */
async function deleteAccount(payload, ctx) {
  const p = validate.asObject(payload);
  if (p.confirm !== 'delete') {
    throw new AppError('INVALID_INPUT', '请确认注销');
  }

  const removed = {
    diaries: 0,
    moods: 0,
    ledgerEntries: 0,
    safetyCheckins: 0,
    pauses: 0,
    growthTasks: 0,
    grants: 0,
    invites: 0,
    files: 0,
  };

  await unbindForDelete(ctx);

  // 邀请码：我创建的、我申请过的都不该留着
  removed.invites += await removeWhere(ctx, 'bind_invites', { creatorOpenid: ctx.openid });
  removed.invites += await removeWhere(ctx, 'bind_invites', { applicantOpenid: ctx.openid });

  // 授权：我作为主人给出的、我作为申请人拿到的，随人消失
  removed.grants += await removeWhere(ctx, 'ledger_view_grants', { ownerOpenid: ctx.openid });
  removed.grants += await removeWhere(ctx, 'ledger_view_grants', { viewerOpenid: ctx.openid });

  // 日记 + 配图
  const diaryResult = await removeDiaries(ctx, { authorOpenid: ctx.openid });
  removed.diaries = diaryResult.removed;

  removed.moods = await removeWhere(ctx, 'moods', { openid: ctx.openid });
  removed.safetyCheckins = await removeWhere(ctx, 'safety_checkins', { openid: ctx.openid });
  removed.ledgerEntries = await removeWhere(ctx, 'ledger_entries', { openid: ctx.openid });
  removed.pauses = await removeWhere(ctx, 'pauses', { byOpenid: ctx.openid });

  // 成长任务：只删「我起草、对方还没认领」的；已经一起做起来的留给对方
  removed.growthTasks = await removeWhere(ctx, 'growth_tasks', { createdBy: ctx.openid, status: 'confirming' });

  // 头像 + 日记配图（云存储）
  const files = diaryResult.files.slice();
  if (ctx.user && ctx.user.avatarFileID) files.push(ctx.user.avatarFileID);
  removed.files = await removeFiles(files);

  // 最后一步：删账号文档本身。删早了会让后续删除拿不到 ctx 里的资料
  await ctx.db.collection('users').doc(ctx.openid).remove().catch(() => null);

  return { deleted: true, removed };
}

module.exports = { get, updateProfile, deleteAccount };
