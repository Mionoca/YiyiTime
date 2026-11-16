'use strict';

/**
 * 日记卡片（文档 8.4 / 9.9）：按天展示「我」和「TA」各一段，只展示不发事件。
 * 对方当天写的内容由服务端裁剪（partner=null），这里只负责锁文案（文档 7.10 / 10.7）。
 */
const timeUtil = require('../../utils/time');

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
    partnerText: '',
    partnerLocked: false,
    partnerUnlocked: false,
    unlockedGlow: false,
    partnerLockText: 'TA 已经写了，明天 00:00 解锁',
    mineEmptyText: '今天还没写',
    partnerEmptyText: 'TA 今天还没写',
  },

  observers: {
    'item, todayKey': function (item, todayKey) {
      if (!item) return;
      const isToday = !!(todayKey && item.date === todayKey);
      const mine = item.mine || null;
      const partnerLocked = !!(item.partnerWritten && !item.partnerUnlocked);
      const partnerUnlocked = !!item.partnerUnlocked;
      // 锁 → 解锁的瞬间播一次微光（文档 9.7：列表出现已解锁卡片，400ms 一次）
      const justUnlocked = partnerUnlocked && this._wasUnlocked === false;
      this._wasUnlocked = partnerUnlocked;
      if (justUnlocked) this.playUnlockGlow();
      this.setData({
        isToday,
        dateLabel: isToday ? '今天' : timeUtil.formatMonthDay(item.date),
        mineText: mine ? mine.content : '',
        mineTimeText: mine ? timeUtil.formatTime(mine.updatedAt, todayKey) : '',
        partnerText: partnerUnlocked && item.partner ? item.partner.content : '',
        partnerLocked,
        partnerUnlocked,
        mineEmptyText: isToday ? '今天还没写' : '那天没有记录',
        partnerEmptyText: isToday ? 'TA 今天还没写' : '那天没有记录',
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
  },
});
