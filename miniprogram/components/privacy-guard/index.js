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

    /**
     * 页面主动唤起（M14 修订）：用户点过「先逛逛」会写 24h 跳过标记，之后隐私接口被微信
     * 拦下时就没有任何可点的地方了——只能看到一句「先同意隐私说明」。选图/换头像失败时
     * 由页面 selectComponent 调这个方法，清掉跳过标记并重新显示弹窗，给回一条自救路径。
     */
    open() {
      try {
        wx.removeStorageSync(SKIP_KEY);
      } catch (err) {
        // 存储不可用不影响弹出
      }
      this.setData({ show: true });
    },

    /** 用户同意后平台会记住，收起弹窗并通知页面继续刚才的动作（如重试选图） */
    onAgree() {
      this.setData({ show: false });
      this.triggerEvent('agree');
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
