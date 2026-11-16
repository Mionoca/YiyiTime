'use strict';

const { DEFAULT_AVATAR, MOODS } = require('../../utils/constants');

// 心情文案只保留一份真相源（utils/constants.js），组件不再自维护映射
const MOOD_META = {};
MOODS.forEach((item) => {
  MOOD_META[item.key] = { short: item.label, icon: item.emoji };
});

/**
 * 头像 + 心情气泡（文档 8.4 / 9.5）。
 * 只负责展示并发 tap 事件，不调云函数；心情为 null 时显示虚线「？」。
 */
Component({
  properties: {
    user: { type: Object, value: null },
    mood: { type: Object, value: null },
    size: { type: String, value: 'md' }, // sm / md / lg
    showMood: { type: Boolean, value: true },
    hugBadge: { type: Boolean, value: false }, // 对方有 pending 抱抱时头像旁心形
  },

  data: {
    avatar: DEFAULT_AVATAR,
    moodKey: '',
    moodShort: '',
    moodIcon: '',
    pop: false,
  },

  observers: {
    user(user) {
      const avatar = (user && (user.avatarFileID || user.avatar)) || DEFAULT_AVATAR;
      if (avatar !== this.data.avatar) this.setData({ avatar });
    },
    mood(mood) {
      const key = mood && mood.mood;
      const meta = MOOD_META[key] || null;
      const signature = meta ? key + '|' + (mood.updatedAt || '') : '';
      this.setData({
        moodKey: meta ? key : '',
        moodShort: meta ? meta.short : '',
        moodIcon: meta ? meta.icon : '',
      });
      // 只在心情真的变化时播 200ms 淡入（文档 10.4），静默刷新不重复动画
      if (meta && signature !== this._moodSignature) this.playPop();
      this._moodSignature = signature;
    },
  },

  lifetimes: {
    detached() {
      clearTimeout(this._popOnTimer);
      clearTimeout(this._popOffTimer);
    },
  },

  methods: {
    playPop() {
      clearTimeout(this._popOnTimer);
      clearTimeout(this._popOffTimer);
      this.setData({ pop: false });
      this._popOnTimer = setTimeout(() => {
        this.setData({ pop: true });
        this._popOffTimer = setTimeout(() => this.setData({ pop: false }), 260);
      }, 16);
    },

    onTap() {
      this.triggerEvent('tap', { user: this.data.user });
    },
  },
});
