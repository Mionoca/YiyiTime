'use strict';

/**
 * 手帐日记卡（文档 8.4 / 8.7.1，M13）：一天一页，上面是我的手帐，下面是 TA 的那页。
 * - 只展示不发业务事件（图片预览除外）；
 * - 私密日记不会出现在伴侣侧（服务端保证），所以「TA 没写」与「TA 写了但没分享」同文案，
 *   客户端不做任何区分，避免从空白里推断对方当天写过；
 * - 分值角标、配图、可见性标签都只渲染服务端给的字段，不在前端猜。
 */
const timeUtil = require('../../utils/time');
const constants = require('../../utils/constants');

function moodOf(score) {
  if (typeof score !== 'number') return null;
  return constants.MOOD_SCALE.filter((item) => item.score === score)[0] || null;
}

Component({
  properties: {
    item: { type: Object, value: null },
    todayKey: { type: String, value: '' },
  },

  data: {
    isToday: false,
    dateLabel: '',
    mineText: '',
    mineTimeText: '',
    mineMoodLabel: '',
    mineMoodScore: 0,
    mineMoodColor: '',
    mineImages: [],
    mineShared: false,
    partnerText: '',
    partnerLocked: false,
    partnerUnlocked: false,
    partnerMoodLabel: '',
    partnerMoodScore: 0,
    partnerMoodColor: '',
    partnerImages: [],
    partnerLockText: '',
    unlockedGlow: false,
    partnerEmptyText: 'TA 那天没有分享日记',
    mineEmptyText: '那天没有记录',
  },

  observers: {
    'item, todayKey': function (item, todayKey) {
      if (!item) return;
      const isToday = !!(todayKey && item.date === todayKey);
      const mine = item.mine || null;
      const partnerLocked = !!(item.partnerWritten && !item.partnerUnlocked);
      const partnerUnlocked = !!item.partnerUnlocked;
      const partner = partnerUnlocked && item.partner ? item.partner : null;

      // 锁 → 解锁的瞬间播一次微光（文档 9.7：列表出现已解锁卡片，400ms 一次）
      const justUnlocked = partnerUnlocked && this._wasUnlocked === false;
      this._wasUnlocked = partnerUnlocked;
      if (justUnlocked) this.playUnlockGlow();

      const mineMood = mine ? moodOf(mine.moodScore) : null;
      const partnerMood = partner ? moodOf(partner.moodScore) : null;
      const unlockText = item.unlockAt ? timeUtil.formatTime(item.unlockAt, todayKey) : '';

      this.setData({
        isToday,
        dateLabel: isToday ? '今天' : timeUtil.formatMonthDay(item.date),
        mineText: mine ? mine.content : '',
        mineTimeText: mine ? timeUtil.formatHM(mine.updatedAt) : '',
        mineMoodLabel: mineMood ? mineMood.label : '',
        mineMoodScore: mineMood ? mineMood.score : 0,
        mineMoodColor: mineMood ? mineMood.color : '',
        mineImages: mine && Array.isArray(mine.images) ? mine.images : [],
        mineShared: !!(mine && mine.visibility === 'partner'),
        partnerText: partner ? partner.content : '',
        partnerLocked,
        partnerUnlocked,
        partnerMoodLabel: partnerMood ? partnerMood.label : '',
        partnerMoodScore: partnerMood ? partnerMood.score : 0,
        partnerMoodColor: partnerMood ? partnerMood.color : '',
        partnerImages: partner && Array.isArray(partner.images) ? partner.images : [],
        partnerLockText: unlockText ? 'TA 写了，' + unlockText + ' 解锁' : 'TA 写了，到时间就解锁',
        mineEmptyText: isToday ? '今天还没写' : '那天没有记录',
        partnerEmptyText: 'TA 那天没有分享日记',
      });
    },
  },

  lifetimes: {
    detached() {
      if (this._glowTimer) {
        clearTimeout(this._glowTimer);
        this._glowTimer = null;
      }
    },
  },

  methods: {
    /** 一次性动画：加 class 播完就摘掉，不常驻（文档 9.7） */
    playUnlockGlow() {
      if (this._glowTimer) clearTimeout(this._glowTimer);
      this.setData({ unlockedGlow: true });
      this._glowTimer = setTimeout(() => {
        this._glowTimer = null;
        this.setData({ unlockedGlow: false });
      }, 400);
    },

    /** 配图预览：只在组件内打开系统相册，不调云函数 */
    onPreview(e) {
      const ds = (e && e.currentTarget && e.currentTarget.dataset) || {};
      const list = ds.who === 'partner' ? this.data.partnerImages : this.data.mineImages;
      if (!list.length || typeof wx === 'undefined' || typeof wx.previewImage !== 'function') return;
      const index = Number(ds.index) || 0;
      wx.previewImage({
        current: list[index],
        urls: list.slice(),
      });
    },
  },
});
