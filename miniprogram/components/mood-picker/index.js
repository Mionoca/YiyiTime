'use strict';

const { MOODS, LIMITS } = require('../../utils/constants');

/**
 * 心情打卡弹层（文档 8.4）：四选一 + 备注（≤50 字）。
 * 只发事件：确认时 select({mood,note})，关闭时 close；业务请求由页面处理。
 */
Component({
  properties: {
    show: { type: Boolean, value: false },
    value: { type: Object, value: null },
    saving: { type: Boolean, value: false }, // 请求中禁用确认，防双击（文档 8.6）
  },

  data: {
    moods: MOODS,
    mood: '',
    note: '',
    noteMax: LIMITS.moodNote,
  },

  observers: {
    'show, value': function (show, value) {
      if (!show) {
        // 关闭时清空内部状态，下次打开从 value 重新填充
        this._valueSignature = '';
        this.setData({ mood: '', note: '' });
        return;
      }
      const v = value || {};
      const signature = (v.mood || '') + '|' + (v.updatedAt || '') + '|' + (v.note || '');
      // 页面静默刷新会传入内容相同的新对象，此时不要覆盖正在编辑的备注
      if (signature === this._valueSignature) return;
      this._valueSignature = signature;
      const keys = MOODS.map((item) => item.key);
      this.setData({
        mood: keys.indexOf(v.mood) >= 0 ? v.mood : '',
        note: String(v.note || '').slice(0, LIMITS.moodNote),
      });
    },
  },

  methods: {
    noop() {},

    onSelectMood(e) {
      const key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || '';
      if (key) this.setData({ mood: key });
    },

    onNoteInput(e) {
      const value = (e && e.detail && e.detail.value) || '';
      this.setData({ note: value.slice(0, LIMITS.moodNote) });
    },

    onConfirm() {
      if (this.data.saving) return;
      if (!this.data.mood) {
        wx.showToast({ title: '先选一个心情吧', icon: 'none' });
        return;
      }
      this.triggerEvent('select', {
        mood: this.data.mood,
        note: String(this.data.note || '').trim(),
      });
    },

    onClose() {
      this.triggerEvent('close', {});
    },
  },
});
