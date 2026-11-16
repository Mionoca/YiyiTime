const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;

const BIND_HINTS = {
  code_created: '等 TA 输入邀请码',
  applied_by_me: '等 TA 确认 · 点这里看看',
  applied_by_partner: '有人在等你 · 点这里去确认',
};

Page({
  data: {
    loading: true,
    error: '',
    home: null,
    statusBarHeight: 20,
    phase: 'day',
    myAvatar: DEFAULT_AVATAR,
    myName: '我',
    partnerAvatar: DEFAULT_AVATAR,
    partnerName: 'TA',
    bindHint: '',
    daysText: '',
    startDateText: '',
    anniversaryText: '',
    showDaysSheet: false,
    defaultAvatar: DEFAULT_AVATAR,
  },

  onLoad() {
    this.setData({ statusBarHeight: this.getStatusBarHeight() });
  },

  onShow() {
    this.load(!!this.data.home);
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  getStatusBarHeight() {
    try {
      if (wx.getWindowInfo) {
        const info = wx.getWindowInfo();
        if (info && info.statusBarHeight) return info.statusBarHeight;
      }
      if (wx.getSystemInfoSync) {
        const info = wx.getSystemInfoSync();
        if (info && info.statusBarHeight) return info.statusBarHeight;
      }
    } catch (err) {
      // 取不到就用默认值
    }
    return 20;
  },

  load(silent) {
    if (this.loadingPromise) return this.loadingPromise;
    if (!silent) this.setData({ loading: true, error: '' });

    this.loadingPromise = api.call('home.get')
      .then((home) => {
        this.loadingPromise = null;
        this.setData(Object.assign({ loading: false, error: '', home }, this.derive(home)));
      })
      .catch((err) => {
        this.loadingPromise = null;
        if (silent && this.data.home) return;
        this.setData({ loading: false, error: (err && err.message) || '小屋暂时打不开' });
      });

    return this.loadingPromise;
  },

  derive(home) {
    const user = home.user || {};
    const partner = home.partner;
    const patch = {
      phase: home.phase || 'day',
      myAvatar: user.avatarFileID || DEFAULT_AVATAR,
      myName: user.nickname || '我',
      partnerAvatar: (partner && partner.avatarFileID) || DEFAULT_AVATAR,
      partnerName: (partner && partner.nickname) || 'TA',
      bindHint: (home.bind && BIND_HINTS[home.bind.state]) || '',
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
    return patch;
  },

  onRetry() {
    this.load(false);
  },

  onTapBind() {
    wx.navigateTo({ url: constants.ROUTES.bind });
  },

  onTapProfile() {
    wx.navigateTo({ url: constants.ROUTES.profile });
  },

  onTapCalendar() {
    const home = this.data.home;
    if (home && home.couple) {
      this.setData({ showDaysSheet: true });
      return;
    }
    this.toast('等 TA 住进来，墙历就开始走啦');
  },

  onCloseDaysSheet() {
    this.setData({ showDaysSheet: false });
  },

  onTapComingSoon() {
    this.toast('还在装修中，下个版本见');
  },

  noop() {},
});
