'use strict';

// 用户点了「先逛逛」后，一天内不再打扰（真正的隐私接口仍会由微信原生弹窗拦截）
const SKIP_KEY = 'privacy_prompt_skip_at';
const SKIP_MS = 24 * 60 * 60 * 1000;

/**
 * 隐私授权弹窗（文档 9.6 / 13.8 / 8.9）。
 * 只在微信要求授权时出现（wx.getPrivacySetting.needAuthorization），
 * 低版本基础库没有该 API 时直接交给微信原生弹窗，避免双重弹窗。
 */
Component({
  data: {
    show: false,
  },

  lifetimes: {
    attached() {
      this.check();
    },
  },

  methods: {
    check() {
      if (typeof wx.getPrivacySetting !== 'function') return;
      try {
        const skipAt = Number(wx.getStorageSync(SKIP_KEY)) || 0;
        if (Date.now() - skipAt < SKIP_MS) return;
      } catch (err) {
        // 读不到存储就正常走授权
      }
      wx.getPrivacySetting({
        success: (res) => {
          if (res && res.needAuthorization) this.setData({ show: true });
        },
        fail: () => {},
      });
    },

    /** 用户同意后平台会记住，这里只收起弹窗；后续接口由微信按契约放行 */
    onAgree() {
      this.setData({ show: false });
    },

    onClose() {
      this.setData({ show: false });
      try {
        wx.setStorageSync(SKIP_KEY, Date.now());
      } catch (err) {
        // 存储不可用只影响本次会话
      }
    },

    onOpenContract() {
      if (typeof wx.openPrivacyContract === 'function') {
        wx.openPrivacyContract({
          fail: () => this.toast('可以在「微信 - 设置 - 隐私」里查看'),
        });
        return;
      }
      this.toast('可以在「微信 - 设置 - 隐私」里查看');
    },

    toast(title) {
      wx.showToast({ title, icon: 'none' });
    },

    noop() {},
  },
});
