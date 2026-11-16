const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const upload = require('../../utils/upload');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;
const STEP_WITH_PENDING = ['code', 'confirm', 'waiting'];

Page({
  data: {
    step: 'loading', // loading | profile | invite | enter | preview | code | confirm | waiting | error
    submitting: false,
    error: '',
    nickname: '',
    avatarFileID: '',
    avatarPreview: DEFAULT_AVATAR,
    startDate: '',
    startDateText: '',
    maxDate: '',
    code: '',
    codeInput: '',
    preview: null,
    pending: null,
    bindState: '',
    defaultAvatar: DEFAULT_AVATAR,
    todayKey: '',
  },

  onLoad(options) {
    this.shareCode = options && options.code ? String(options.code).trim() : '';
    const todayKey = timeUtil.todayKey();
    this.setData({
      maxDate: todayKey,
      todayKey,
      startDate: todayKey,
      startDateText: timeUtil.formatDateCN(todayKey),
    });
    this.init();
  },

  onShow() {
    if (this.ready) this.refreshStatus(true);
  },

  onPullDownRefresh() {
    // 文档 L637：子页支持下拉刷新；成功失败都收起转圈
    const stop = () => wx.stopPullDownRefresh();
    if (!this.ready) {
      this.init();
      stop();
      return;
    }
    // refreshStatus 内部已 catch，reject 侧只是防御，保证无论如何收起转圈
    this.refreshStatus(true).then(stop, stop);
  },

  onUnload() {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
  },

  onShareAppMessage() {
    return this.buildShare();
  },

  onShareTimeline() {
    // 朋友圈固定分享当前页，且文档 11.5 要求邀请码不公开贴出：只分享标题，不带 code
    return { title: '来和我一起住进小怡怡安' };
  },

  buildShare() {
    // 只有自己刚创建、还在等的邀请码可以分享；applied_* 阶段的 code 属于对方或已失效（文档 11.5）
    const code =
      this.data.bindState === 'code_created'
        ? (this.data.pending && this.data.pending.code) || this.data.code || ''
        : '';
    return {
      title: '来和我一起住进小怡怡安',
      path: constants.ROUTES.bind + (code ? '?code=' + code : ''),
    };
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  ask(title, content) {
    return new Promise((resolve) => {
      wx.showModal({
        title,
        content,
        confirmText: '好',
        cancelText: '再想想',
        confirmColor: '#D98E73',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
  },

  async init() {
    this.setData({ step: 'loading', error: '' });
    try {
      const results = await Promise.all([api.call('user.get'), api.call('bind.status')]);
      const user = results[0].user || {};
      const status = results[1];
      this.ready = true;

      if (status.state === 'bound') {
        wx.reLaunch({ url: constants.ROUTES.home });
        return;
      }

      const patch = {
        step: 'invite',
        nickname: user.nickname || '',
        avatarFileID: user.avatarFileID || '',
        avatarPreview: user.avatarFileID || DEFAULT_AVATAR,
        bindState: status.state,
      };

      if (!user.profileComplete) {
        patch.step = 'profile';
      } else if (status.state !== 'unbound') {
        Object.assign(patch, this.pendingPatch(status.state, status.pending));
      } else if (this.shareCode) {
        patch.step = 'enter';
        patch.codeInput = this.shareCode;
      }

      if (status.todayKey) {
        // 文档 1.5 / 10.9：日期上限用服务端今天，设备时钟超前也选不到未来
        patch.todayKey = status.todayKey;
        patch.maxDate = status.todayKey;
        if (!this._startDateTouched && patch.step === 'invite') {
          patch.startDate = status.todayKey;
          patch.startDateText = timeUtil.formatDateCN(status.todayKey);
        }
      }

      this.setData(patch);
      if (patch.step === 'enter') this.doPreview(this.shareCode);
    } catch (err) {
      this.ready = false;
      this.setData({ step: 'error', error: (err && err.message) || '加载失败' });
    }
  },

  pendingPatch(state, pending) {
    const p = pending || null;
    const startDate = (p && p.startDate) || this.data.startDate;
    return {
      step: state === 'code_created' ? 'code' : (state === 'applied_by_partner' ? 'confirm' : 'waiting'),
      pending: p,
      code: (p && p.code) || this.data.code,
      bindState: state,
      startDate,
      startDateText: timeUtil.formatDateCN(startDate),
    };
  },

  async refreshStatus(silent) {
    if (!this.ready || this.data.submitting) return 'busy';
    try {
      const status = await api.call('bind.status');
      if (status.todayKey && status.todayKey !== this.data.maxDate) {
        const patch = { maxDate: status.todayKey, todayKey: status.todayKey };
        // 跨天时如果用户还没手选开始日期，把默认值一起挪到今天（否则会把昨天当成开始日提交）
        if (!this._startDateTouched && this.data.step === 'invite') {
          patch.startDate = status.todayKey;
          patch.startDateText = timeUtil.formatDateCN(status.todayKey);
        }
        this.setData(patch);
      }
      if (status.state === 'bound') {
        wx.reLaunch({ url: constants.ROUTES.home });
        return 'bound';
      }
      if (this.data.step === 'profile' || this.data.step === 'preview' || this.data.step === 'enter') {
        return 'skipped';
      }
      if (status.state === 'unbound') {
        if (STEP_WITH_PENDING.indexOf(this.data.step) >= 0) {
          this.setData({ step: 'invite', bindState: 'unbound', pending: null, code: '' });
        }
        return 'unbound';
      }
      this.setData(this.pendingPatch(status.state, status.pending));
      return 'pending';
    } catch (err) {
      if (!silent) api.showError(err);
      return 'error';
    }
  },

  onTapRetry() {
    this.init();
  },

  onChooseAvatar(e) {
    const tempUrl = e.detail && e.detail.avatarUrl;
    if (!tempUrl) return;
    this.pendingAvatar = tempUrl;
    this.setData({ avatarPreview: tempUrl });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  uploadAvatar(filePath) {
    return upload.uploadAvatar(filePath);
  },

  async onTapSaveProfile() {
    if (this.data.submitting) return;
    const nickname = String(this.data.nickname || '').trim();
    if (!nickname) {
      this.toast('先起个昵称吧');
      return;
    }
    if (nickname.length > constants.LIMITS.nickname) {
      this.toast('昵称最多 ' + constants.LIMITS.nickname + ' 个字');
      return;
    }

    this.setData({ submitting: true });
    try {
      let avatarFileID = this.data.avatarFileID;
      if (this.pendingAvatar) {
        try {
          avatarFileID = await this.uploadAvatar(this.pendingAvatar);
        } catch (uploadErr) {
          throw new Error('头像上传失败，稍后再试');
        }
      }
      const payload = { nickname };
      if (avatarFileID) payload.avatarFileID = avatarFileID;

      const res = await api.call('user.updateProfile', payload);
      const user = res.user || {};
      this.pendingAvatar = null;

      this.setData({
        submitting: false,
        nickname: user.nickname || nickname,
        avatarFileID: user.avatarFileID || avatarFileID || '',
        avatarPreview: user.avatarFileID || avatarFileID || DEFAULT_AVATAR,
      });
      // 重新拉一次状态，落到正确的步骤（资料可能是在邀请中途补齐的）
      this.init();
    } catch (err) {
      this.setData({ submitting: false });
      api.showError(err);
    }
  },

  onStartDateChange(e) {
    const startDate = e.detail.value;
    this._startDateTouched = true;
    this.setData({ startDate, startDateText: timeUtil.formatDateCN(startDate) });
  },

  onTapCreate() {
    this.doCreate(false);
  },

  onTapRegenerate() {
    this.doCreate(true);
  },

  async doCreate(regenerate) {
    if (this.data.submitting) return;
    const startDate = this.data.startDate;
    if (!startDate) {
      this.toast('先选一个开始的日子');
      return;
    }

    this.setData({ submitting: true });
    try {
      const result = await api.call('bind.create', { startDate, regenerate: !!regenerate });
      const applied = result.state === 'applied_by_partner';
      const pending = {
        code: result.code,
        role: 'creator',
        status: applied ? 'applied' : 'open',
        startDate: result.startDate,
        expiresAt: result.expiresAt,
        other: null,
      };
      this.setData(Object.assign(
        { submitting: false },
        this.pendingPatch(applied ? 'applied_by_partner' : 'code_created', pending)
      ));
      wx.showToast({ title: regenerate ? '换好啦' : '邀请码已生成', icon: 'none' });
      if (applied) this.refreshStatus(true);
    } catch (err) {
      this.setData({ submitting: false });
      api.showError(err);
    }
  },

  onCopyCode() {
    if (!this.data.code) return;
    wx.setClipboardData({
      data: String(this.data.code),
      success: () => wx.showToast({ title: '已复制，发给 TA 吧', icon: 'none' }),
    });
  },

  onTapGoEnter() {
    this.setData({ step: 'enter', codeInput: this.data.codeInput || this.shareCode || '' });
  },

  onTapGoInvite() {
    this.shareCode = '';
    this.setData({
      step: 'invite',
      preview: null,
      codeInput: '',
      startDateText: timeUtil.formatDateCN(this.data.startDate),
    });
  },

  onCodeInput(e) {
    this.setData({ codeInput: e.detail.value });
  },

  onTapPreview() {
    return this.doPreview(this.data.codeInput || this.shareCode);
  },

  async doPreview(input) {
    if (this.data.submitting) return;
    const code = String(input || '').trim();
    if (!/^\d{6}$/.test(code)) {
      this.toast('邀请码是 6 位数字');
      return;
    }

    this.setData({ submitting: true });
    try {
      const preview = await api.call('bind.preview', { code });
      // 预览只更新展示用的开始日期，不要污染邀请步骤里自己选的 startDate
      this.setData({
        submitting: false,
        step: 'preview',
        preview,
        code,
        codeInput: code,
        startDateText: timeUtil.formatDateCN(preview.startDate),
      });
    } catch (err) {
      this.setData({ submitting: false });
      api.showError(err);
    }
  },

  async onTapApply() {
    if (this.data.submitting) return;
    const code = String((this.data.preview && this.data.preview.code) || this.data.codeInput || '').trim();
    if (!/^\d{6}$/.test(code)) {
      this.toast('邀请码是 6 位数字');
      return;
    }

    this.setData({ submitting: true });
    try {
      const result = await api.call('bind.apply', { code });
      const pending = {
        code: result.code,
        role: 'applicant',
        status: 'applied',
        startDate: result.startDate,
        expiresAt: result.expiresAt,
        other: result.creator,
      };
      this.setData(Object.assign(
        { submitting: false },
        this.pendingPatch('applied_by_me', pending)
      ));
      wx.showToast({ title: '申请已发出，等 TA 确认', icon: 'none' });
    } catch (err) {
      this.setData({ submitting: false });
      api.showError(err);
    }
  },

  async onTapConfirm() {
    if (this.data.submitting) return;
    const pending = this.data.pending;
    const code = (pending && pending.code) || this.data.code;
    if (!code) return;

    const ok = await this.ask('让 TA 住进来？', '绑定后就是两个人的小屋了，开始日期是 ' + this.data.startDateText + '。');
    if (!ok) return;

    this.setData({ submitting: true });
    try {
      await api.call('bind.confirm', { code });
      wx.showToast({ title: '住进来啦', icon: 'success' });
      this.leaveTimer = setTimeout(() => wx.reLaunch({ url: constants.ROUTES.home }), 700);
    } catch (err) {
      this.setData({ submitting: false });
      api.showError(err);
      this.refreshStatus(true);
    }
  },

  async onTapCancel() {
    if (this.data.submitting) return;
    const pending = this.data.pending;
    const code = (pending && pending.code) || this.data.code;
    if (!code) {
      this.setData({ step: 'invite' });
      return;
    }

    const isApplicant = this.data.bindState === 'applied_by_me';
    const ok = await this.ask(isApplicant ? '取消这次申请？' : '取消这个邀请？', '取消后需要重新生成邀请码。');
    if (!ok) return;

    this.setData({ submitting: true });
    try {
      await api.call('bind.cancel', { code });
      const patch = {
        submitting: false,
        step: 'invite',
        bindState: 'unbound',
        pending: null,
        code: '',
      };
      // 等待期间可能跨天：取消回邀请步骤时如果用户没手选过开始日期，重置成服务端今天
      if (!this._startDateTouched) {
        const today = this.data.maxDate || this.data.todayKey;
        if (today) {
          patch.startDate = today;
          patch.startDateText = timeUtil.formatDateCN(today);
        }
      }
      this.setData(patch);
      wx.showToast({ title: '已取消', icon: 'none' });
    } catch (err) {
      this.setData({ submitting: false });
      api.showError(err);
    }
  },

  async onTapRefresh() {
    const before = this.data.step;
    const result = await this.refreshStatus(false);
    if (result === 'bound') return;
    if (result === 'skipped') {
      this.toast('先回到上一步，再看 TA 来没来');
      return;
    }
    this.toast(this.data.step === before ? '还没有新动静' : '有变化啦');
  },
});
