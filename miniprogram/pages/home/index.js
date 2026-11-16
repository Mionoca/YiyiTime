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
    startDateSelect: '',
    maxStartDate: '',
    startDateSaving: false,
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
      // 上限用服务端 todayKey（文档 13.5：日期规则以服务端为准），取不到再退回本机
      maxStartDate: home.todayKey || timeUtil.todayKey(),
      startDateSelect: home.couple ? home.couple.startDate : '',
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

  /** 墙历里改开始日期：先二次确认，避免一方随手改掉两个人的天数 */
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
      // 先按返回值把天数和日期改对，再静默刷新补纪念日；刷新失败也不会停在旧天数
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

  onTapComingSoon() {
    this.toast('还在装修中，下个版本见');
  },

  noop() {},
});
