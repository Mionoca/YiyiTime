'use strict';

const time = require('../lib/time');
const relation = require('../lib/relation');
const bind = require('./bind');
const blocks = require('../lib/home-blocks');

const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
/** 未绑定 / 未确认时统一返回「没有解绑申请」，客户端只按这一个形状渲染（文档 7.14） */
const NO_UNBIND = { status: 'none', requestedByMe: false, requestedAt: null };

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
  const empty = {
    couple: null,
    partner: null,
    mood: null,
    anniversary: null,
    safety: null,
    diary: null,
    wish: null,
    pause: null,
    unbind: NO_UNBIND,
  };

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
      data: { coupleId: null, reminderEnabled: false, updatedAt: ctx.now },
    }).catch(() => {});
    ctx.user.coupleId = null;
    ctx.couple = null;
    return Object.assign({}, base, empty, { bind: await bind.computeStatus(ctx) });
  }

  const coupleId = couple._id || ctx.user.coupleId;
  // 脏 startDate 不能让整页 500：降级为「没有天数/纪念日」，用户仍可在资料页重设
  // 不只看格式：未来日期/2000 年前会让 daysTogether 变负数或溢出，按脏数据降级
  const startDateOk = time.isValidStartDate(couple.startDate, todayKey);
  if (!startDateOk) {
    console.error('[home.get] couple.startDate invalid', JSON.stringify({
      openidTail: String(ctx.openid).slice(-6),
      coupleIdTail: String(coupleId || '').slice(-6),
      startDateType: typeof couple.startDate,
    }));
  }
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

  // 六个区块互不依赖，并行读取；单个区块失败只降级自己（文档 10.3）
  const [mood, anniversary, safety, diary, wish, pause] = await Promise.all([
    blocks.optionalBlock(ctx, 'mood', () => blocks.loadMood(ctx, coupleId, todayKey, partnerOpenid)),
    blocks.optionalBlock(ctx, 'anniversary', () => blocks.loadAnniversary(ctx, coupleId, todayKey)),
    blocks.optionalBlock(ctx, 'safety', () => blocks.loadSafety(ctx, coupleId, todayKey, partnerOpenid)),
    blocks.optionalBlock(ctx, 'diary', () => blocks.loadDiary(ctx, coupleId, todayKey, partnerOpenid)),
    blocks.optionalBlock(ctx, 'wish', () => blocks.loadWish(ctx, coupleId)),
    blocks.optionalBlock(ctx, 'pause', () => blocks.loadPause(ctx, coupleId)),
  ]);

  return Object.assign({}, base, {
    bind: { state: 'bound', pending: null },
    couple: {
      coupleId,
      startDate: startDateOk ? couple.startDate : null,
      daysTogether: startDateOk ? time.daysTogether(couple.startDate, todayKey) : null,
      anniversary: startDateOk ? time.nextAnniversary(couple.startDate, todayKey) : null,
    },
    partner,
    mood,
    anniversary,
    safety,
    diary,
    wish,
    pause,
    unbind: relation.unbindView(couple, ctx.openid),
  });
}

module.exports = { get };
