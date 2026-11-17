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

module.exports = { get, updateProfile };
