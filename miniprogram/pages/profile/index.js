const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');

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
    defaultAvatar: DEFAULT_AVATAR,
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
      };
      if (home.couple) {
        patch.daysText = '第 ' + home.couple.daysTogether + ' 天';
        patch.startDateText = timeUtil.formatDateCN(home.couple.startDate);
        patch.anniversaryText = home.couple.anniversary
          ? timeUtil.formatDateCN(home.couple.anniversary.date) + ' · 还有 ' + home.couple.anniversary.daysLeft + ' 天'
          : '开始那天就是纪念日';
      } else {
        patch.daysText = '';
        patch.startDateText = '';
        patch.anniversaryText = '';
      }
      this.setData(patch);
    } catch (err) {
      this.setData({ loading: false, error: (err && err.message) || '小屋暂时打不开' });
    }
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
    const extMatch = String(filePath).match(/\.(\w+)$/);
    const ext = extMatch ? extMatch[1] : 'png';
    const cloudPath = 'avatars/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    return wx.cloud.uploadFile({ cloudPath, filePath }).then((res) => res.fileID);
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

  onTapBind() {
    wx.navigateTo({ url: constants.ROUTES.bind });
  },

  onTapComingSoon() {
    this.toast('这个功能还在装修中，下个版本见');
  },
});
