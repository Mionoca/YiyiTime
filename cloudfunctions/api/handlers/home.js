'use strict';

const time = require('../lib/time');
const bind = require('./bind');
const blocks = require('../lib/home-blocks');

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function publicUser(user) {
  return {
    openid: user._id || user.openid,
    nickname: user.nickname || '',
    avatarFileID: user.avatarFileID || '',
    profileComplete: !!(user.profileComplete || user.nickname),
  };
}

/** lastActiveAt 节流更新：距上次超过 5 分钟才写 */
async function touchLastActive(ctx) {
  const last = time.toMillis(ctx.user.lastActiveAt);
  if (!Number.isFinite(last) || ctx.now.getTime() - last > TOUCH_INTERVAL_MS) {
    await ctx.db.collection('users').doc(ctx.openid).update({
      data: { lastActiveAt: ctx.now },
    }).catch(() => {});
  }
}

async function get(payload, ctx) {
  const todayKey = time.dateKeyOf(ctx.now);
  await touchLastActive(ctx);

  const base = {
    serverNow: ctx.now.toISOString(),
    todayKey,
    phase: time.phaseOf(ctx.now),
    user: publicUser(ctx.user),
  };
  const empty = { couple: null, partner: null, mood: null, hug: null, safety: null, diary: null, wish: null };

  if (!ctx.user.coupleId) {
    return Object.assign({}, base, empty, { bind: await bind.computeStatus(ctx) });
  }

  const couple = ctx.couple;
  if (!couple || couple.status !== 'active' || !(couple.memberOpenids || []).includes(ctx.openid)) {
    // 数据异常：记日志并重置 user.coupleId，按未绑定返回
    console.error('[home.get] couple missing or invalid', JSON.stringify({
      openidTail: String(ctx.openid).slice(-6),
      coupleIdTail: String(ctx.user.coupleId || '').slice(-6),
    }));
    await ctx.db.collection('users').doc(ctx.openid).update({
      data: { coupleId: null, updatedAt: ctx.now },
    }).catch(() => {});
    ctx.user.coupleId = null;
    ctx.couple = null;
    return Object.assign({}, base, empty, { bind: await bind.computeStatus(ctx) });
  }

  const coupleId = couple._id || ctx.user.coupleId;
  const partnerOpenid = (couple.memberOpenids || []).find((id) => id !== ctx.openid) || null;
  let partner = null;
  if (partnerOpenid) {
    partner = ctx.partner
      ? {
        openid: partnerOpenid,
        nickname: ctx.partner.nickname || '',
        avatarFileID: ctx.partner.avatarFileID || '',
      }
      : { openid: partnerOpenid, nickname: '', avatarFileID: '' };
  }

  const mood = await blocks.optionalBlock(ctx, 'mood', () => blocks.loadMood(ctx, coupleId, todayKey, partnerOpenid));
  const hug = await blocks.optionalBlock(ctx, 'hug', () => blocks.loadHug(ctx, coupleId));

  return Object.assign({}, base, {
    bind: { state: 'bound', pending: null },
    couple: {
      coupleId,
      startDate: couple.startDate,
      daysTogether: time.daysTogether(couple.startDate, todayKey),
      anniversary: time.nextAnniversary(couple.startDate, todayKey),
    },
    partner,
    mood,
    hug,
    // 报平安 / 日记 / 愿望：M4 接入后替换为真实聚合
    safety: null,
    diary: null,
    wish: null,
  });
}

module.exports = { get };
