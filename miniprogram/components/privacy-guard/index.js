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
 * 原生授权接口的兜底上限。正常情况下它一定会回调（用户点同意或拒绝）；
 * 这里只是保证「极端情况下接口不回调」时，按钮也会在 5 秒内收尾，不把用户锁在弹窗里。
 */
const AUTHORIZE_GUARD_MS = 5000;

/**
 * 隐私授权弹窗（文档 9.6 / 13.8 / 8.9）。
 * 只在微信要求授权时出现（wx.getPrivacySetting.needAuthorization），
 * 低版本基础库没有该 API 时直接交给微信原生弹窗，避免双重弹窗。
 */
Component({
  data: {
    show: false,
    busy: false,
  },

  lifetimes: {
    attached() {
      this.check();
    },
    detached() {
      this.clearAgreeTimer();
      this.clearAuthorizeGuard();
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
      this.clearAuthorizeGuard();
      try {
        wx.removeStorageSync(SKIP_KEY);
      } catch (err) {
        // 存储不可用不影响弹出
      }
      this.setData({ show: true, busy: false });
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
      if (!this.data.show) return;
      if (this.data.busy) return; // 连点只算一次
      this.clearAgreeTimer();
      // 立刻给视觉反馈：按钮变成「正在打开授权…」，避免「点了没反应」的观感
      this.setData({ busy: true });
      this._agreeTimer = setTimeout(() => {
        this._agreeTimer = null;
        this.settleAgree();
      }, AGREE_FALLBACK_MS);
    },

    /**
     * 收尾：先让微信记一次同意（原生授权），无论它成功、失败还是不回调，
     * 最终都由 onAgree 关掉弹窗。
     *
     * 这里刻意**不把失败当成卡住**：平台侧没配好指引、基础库异常、接口不回调，
     * 都不该让用户停在一个按不动的按钮前面。用户已经在弹窗里看过说明并明确点了同意，
     * 站内弹窗本身即同意记录；真正的功能限制由后续接口的失败提示来说明。
     */
    settleAgree() {
      if (!this.data.show) return;
      if (typeof wx.requirePrivacyAuthorize !== 'function') {
        this.onAgree();
        return;
      }
      const self = this;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        self.clearAuthorizeGuard();
        self.onAgree();
      };
      this._authorizeGuard = setTimeout(finish, AUTHORIZE_GUARD_MS);
      try {
        wx.requirePrivacyAuthorize({ success: finish, fail: finish });
      } catch (err) {
        finish();
      }
    },

    /**
     * 同意成功（open-type 回调或原生授权成功）。
     * 幂等：重复触发不会让页面重复执行「刚才被打断的动作」（比如弹两次相册）。
     */
    onAgree() {
      if (!this.data.show) return;
      this.clearAgreeTimer();
      this.clearAuthorizeGuard();
      try {
        wx.removeStorageSync(SKIP_KEY);
      } catch (err) {
        // 存储不可用不影响结果
      }
      this.setData({ show: false, busy: false });
      this.triggerEvent('agree');
    },

    onClose() {
      this.clearAgreeTimer();
      this.clearAuthorizeGuard();
      this.setData({ show: false, busy: false });
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

    clearAuthorizeGuard() {
      if (this._authorizeGuard) {
        clearTimeout(this._authorizeGuard);
        this._authorizeGuard = null;
      }
    },

    toast(title) {
      wx.showToast({ title, icon: 'none' });
    },

    noop() {},
  },
});
