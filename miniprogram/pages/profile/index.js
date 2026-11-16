const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const upload = require('../../utils/upload');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;

Page({
  data: {
    loading: true,
    error: '',
    home: null,
    nickname: '',
    avatarFileID: '',
    avatarPreview: DEFAULT_AVATAR,
    bound: false,
    bindStateText: '',
    daysText: '',
    startDateText: '',
    anniversaryText: '',
    saving: false,
    editing: false,
    startDateSelect: '',
    maxStartDate: '',
    startDateSaving: false,
    defaultAvatar: DEFAULT_AVATAR,
    appVersion: '',
  },

  onShow() {
    this.load();
  },

  onRetry() {
    this.load(true);
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  async load(force) {
    // 正在改昵称时，别用服务端旧值把输入框覆盖掉
    if (this.data.editing && !force) return;
    try {
      const home = await api.call('home.get');
      const user = home.user || {};
      const patch = {
        loading: false,
        error: '',
        home,
        nickname: user.nickname || '',
        avatarFileID: user.avatarFileID || '',
        avatarPreview: user.avatarFileID || DEFAULT_AVATAR,
        bound: home.bind.state === 'bound',
        bindStateText: this.bindText(home.bind),
        // 上限用服务端 todayKey（文档 13.5：日期规则以服务端为准），取不到再退回本机
        maxStartDate: home.todayKey || timeUtil.todayKey(),
        startDateSelect: home.couple ? home.couple.startDate : '',
        appVersion: this.getAppVersion(),
      };
      if (home.couple) {
        // 脏 startDate 时服务端会把 daysTogether/anniversary 降级为 null（home.get），
        // 这里不能拼出「第 null 天」，与首页 derive 保持同一守卫
        const couple = home.couple;
        patch.daysText = couple.daysTogether ? '第 ' + couple.daysTogether + ' 天' : '';
        patch.startDateText = couple.startDate ? timeUtil.formatDateCN(couple.startDate) : '';
        patch.anniversaryText = couple.anniversary
          ? timeUtil.formatDateCN(couple.anniversary.date) + ' · 还有 ' + couple.anniversary.daysLeft + ' 天'
          : (couple.startDate ? '开始那天就是纪念日' : '');
      } else {
        patch.daysText = '';
        patch.startDateText = '';
        patch.anniversaryText = '';
      }
      // 编辑昵称时被强制刷新（比如刚改完开始日期），保留正在输入的草稿
      if (this.data.editing) patch.nickname = this.data.nickname;
      this.setData(patch);
    } catch (err) {
      this.setData({ loading: false, error: (err && err.message) || '小屋暂时打不开' });
    }
  },

  /** 关于里显示版本号（文档 8.3.6）；开发者工具/体验版取不到时退回「内测版」 */
  getAppVersion() {
    try {
      if (wx.getAccountInfoSync) {
        const info = wx.getAccountInfoSync();
        const v = info && info.miniProgram && info.miniProgram.version;
        if (v) return 'v' + v;
      }
    } catch (err) {
      // 取不到不影响页面
    }
    return '内测版';
  },

  bindText(bind) {
    if (!bind) return '';
    const map = {
      unbound: '还没绑定',
      code_created: '邀请码等你发出',
      applied_by_me: '等 TA 确认',
      applied_by_partner: '有人在等你确认',
      bound: '已绑定',
    };
    return map[bind.state] || '';
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value, editing: true });
  },

  async onSaveNickname() {
    if (this.data.saving) return;
    const nickname = String(this.data.nickname || '').trim();
    if (!nickname) {
      this.toast('先起个昵称吧');
      return;
    }
    if (nickname.length > constants.LIMITS.nickname) {
      this.toast('昵称最多 ' + constants.LIMITS.nickname + ' 个字');
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await api.call('user.updateProfile', { nickname });
      const user = res.user || {};
      this.setData({
        saving: false,
        editing: false,
        nickname: user.nickname || nickname,
        avatarFileID: user.avatarFileID || this.data.avatarFileID,
        avatarPreview: user.avatarFileID || this.data.avatarPreview,
      });
      wx.showToast({ title: '改好啦', icon: 'none' });
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  uploadAvatar(filePath) {
    return upload.uploadAvatar(filePath);
  },

  async onChooseAvatar(e) {
    const tempUrl = e.detail && e.detail.avatarUrl;
    if (!tempUrl || this.data.saving) return;

    this.setData({ saving: true, avatarPreview: tempUrl });
    try {
      let fileID = '';
      try {
        fileID = await this.uploadAvatar(tempUrl);
      } catch (uploadErr) {
        throw new Error('头像上传失败，稍后再试');
      }
      const res = await api.call('user.updateProfile', { avatarFileID: fileID });
      const user = res.user || {};
      this.setData({
        saving: false,
        avatarFileID: user.avatarFileID || fileID,
        avatarPreview: user.avatarFileID || fileID,
      });
      wx.showToast({ title: '头像换好啦', icon: 'none' });
    } catch (err) {
      this.setData({ saving: false, avatarPreview: this.data.avatarFileID || DEFAULT_AVATAR });
      api.showError(err);
    }
  },

  /** 改开始日期：和墙历一样要二次确认，文案说明双方都会看到新天数 */
  onStartDateChange(e) {
    const value = String((e && e.detail && e.detail.value) || '');
    const home = this.data.home;
    const current = home && home.couple ? home.couple.startDate : '';
    if (!value || value === current) return;
    wx.showModal({
      title: '改开始日期？',
      content: '改完后你们都会看到新的天数，纪念日也会跟着变。',
      confirmText: '改',
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) this.saveStartDate(value);
      },
    });
  },

  async saveStartDate(value) {
    if (this.data.startDateSaving) return;
    this.setData({ startDateSaving: true });
    try {
      const res = await api.call('couple.updateStartDate', { startDate: value });
      // 先按返回值更新日期和天数，再静默刷新补纪念日
      this.setData({
        startDateSaving: false,
        startDateSelect: res.startDate,
        startDateText: timeUtil.formatDateCN(res.startDate),
        daysText: '第 ' + res.daysTogether + ' 天',
      });
      await this.load(true);
      wx.showToast({ title: '日子重新算好啦', icon: 'none' });
    } catch (err) {
      this.setData({ startDateSaving: false });
      api.showError(err);
    }
  },

  onTapBind() {
    wx.navigateTo({ url: constants.ROUTES.bind });
  },

  /** 隐私保护指引（文档 13.8：隐私弹窗与授权口径要能被用户随时查到） */
  onOpenPrivacy() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({
        fail: () => this.toast('可以在「微信 - 设置 - 隐私」里查看'),
      });
      return;
    }
    this.toast('可以在「微信 - 设置 - 隐私」里查看');
  },

});
