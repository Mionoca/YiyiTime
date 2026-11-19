'use strict';

// 用户点了「先逛逛」后，一天内不再打扰（真正的隐私接口仍会由微信原生弹窗拦截）
const SKIP_KEY = 'privacy_prompt_skip_at';
const SKIP_MS = 24 * 60 * 60 * 1000;

/**
 * open-type 生效时是「点完马上回调」；给它 300ms，超过就认为平台没回调，走原生授权兜底。
 * 太短会与正常回调抢跑，太长用户会觉得点了没反应。
 */
const AGREE_FALLBACK_MS = 300;

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
    detached() {
      this.clearAgreeTimer();
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
      this.clearAgreeTimer();
      try {
        wx.removeStorageSync(SKIP_KEY);
      } catch (err) {
        // 存储不可用不影响弹出
      }
      this.setData({ show: true });
    },

    /**
     * 「同意并继续」的兜底点击。
     *
     * 为什么需要：`open-type="agreePrivacyAuthorization"` 在三种情况下**不会**回调
     * `bindagreeprivacyauthorization`——①基础库低于 2.32.3；②公众平台没配好《用户隐私保护
     * 指引》；③用户此前已经同意过（平台可能直接视为已授权而不回调）。
     * 此时按钮点了毫无反应，弹窗像冻住一样，用户直接卡死（真机反馈）。
     * 这里给 300ms 窗口：正常回调会先触发 onAgree 并清掉定时器；超过窗口说明 open-type
     * 没生效，改用 wx.requirePrivacyAuthorize 拉起微信原生授权弹窗，保证按钮永远有反应。
     */
    onAgreeTap() {
      this.clearAgreeTimer();
      this._agreeTimer = setTimeout(() => {
        this._agreeTimer = null;
        this.authorizeNatively();
      }, AGREE_FALLBACK_MS);
    },

    /** 原生授权兜底：open-type 不通时，让微信自己弹一次授权框 */
    authorizeNatively() {
      if (!this.data.show) return;
      if (typeof wx.requirePrivacyAuthorize !== 'function') {
        this.toast('微信版本过低，请在「微信 → 我 → 设置 → 隐私」里同意后重试');
        return;
      }
      wx.requirePrivacyAuthorize({
        success: () => this.onAgree(),
        fail: () => {
          // 弹窗保持打开：用户还能点「查看指引」或「先逛逛」，而不是卡在一个假按钮上
          this.toast('微信这边还没开放授权，多半是《用户隐私保护指引》还没配置好');
        },
      });
    },

    /**
     * 同意成功（open-type 回调或原生授权成功）。
     * 幂等：重复触发不会让页面重复执行「刚才被打断的动作」（比如弹两次相册）。
     */
    onAgree() {
      if (!this.data.show) return;
      this.clearAgreeTimer();
      try {
        wx.removeStorageSync(SKIP_KEY);
      } catch (err) {
        // 存储不可用不影响结果
      }
      this.setData({ show: false });
      this.triggerEvent('agree');
    },

    onClose() {
      this.clearAgreeTimer();
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
          fail: () => this.toast('可以在「微信 → 我 → 设置 → 隐私」里查看'),
        });
        return;
      }
      this.toast('可以在「微信 → 我 → 设置 → 隐私」里查看');
    },

    clearAgreeTimer() {
      if (this._agreeTimer) {
        clearTimeout(this._agreeTimer);
        this._agreeTimer = null;
      }
    },

    toast(title) {
      wx.showToast({ title, icon: 'none' });
    },

    noop() {},
  },
});
