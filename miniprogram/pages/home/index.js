const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const haptics = require('../../utils/haptics');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;
const MOODS = constants.MOODS;
const HUG_SEEN_KEY = 'hug_seen_ids';
const HUG_SEEN_MAX = 20;
// 文档 9.7：心形上浮 1400ms；多留 40ms 余量，避免定时器先于动画结束
const HUG_FLOAT_MS = 1440;

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
    // 场景首屏入场动画（文档 9.7）：一次性 class，520ms 后移除
    sceneEnter: false,
    // 首页分享卡片带的邀请码（文档 9.12 / 13.8）
    shareCode: '',
    myAvatar: DEFAULT_AVATAR,
    myName: '我',
    partnerName: 'TA',
    myUser: null,
    partnerUser: null,
    bindHint: '',
    daysText: '',
    startDateText: '',
    anniversaryText: '',
    showDaysSheet: false,
    startDateSelect: '',
    maxStartDate: '',
    startDateSaving: false,
    // 今天的心情（文档 7.8 / 9.3）
    moodMine: null,
    moodPartner: null,
    moodPickerShow: false,
    moodSaving: false,
    partnerMoodSheet: false,
    partnerMood: null,
    // 抱抱（文档 7.8 / 9.4 / 10.5）
    hugIncoming: null,
    hugOutgoing: null,
    hugButtonText: '我需要抱抱',
    hugButtonDisabled: false,
    hugHint: '',
    hugSending: false,
    hugCelebrate: false,
    // 报平安 / 日记 / 愿望（文档 7.8 / 9.10）
    doorLit: false,
    safetyLabel: '还没报平安',
    lampDim: true,
    lampDot: false,
    wishPreviewTitle: '',
    wishTotal: 0,
    wishDone: 0,
  },

  onLoad() {
    this.setData({ statusBarHeight: this.getStatusBarHeight() });
    try {
      // 让分享卡片能带邀请码（文档 9.12 / 13.8）
      if (wx.showShareMenu) {
        wx.showShareMenu({ menus: ['shareAppMessage', 'shareTimeline'] });
      }
    } catch (err) {
      // 分享菜单不可用不影响主流程
    }
  },

  onShow() {
    this.load(!!this.data.home);
  },

  onUnload() {
    // 页面已卸载：之后的定时器 / nextTick 回调不再 setData（微信会告警）
    this._unloaded = true;
    clearTimeout(this._celebrateTimer);
    clearTimeout(this._enterTimer);
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

  /**
   * 拉首页聚合。silent=保留旧数据静默刷新；force=丢弃在途请求的结果。
   * 写操作成功后必须 force，否则可能拿到写之前发出的旧响应，把刚更新的状态覆盖回去。
   */
  load(silent, force) {
    if (this.loadingPromise && !force) return this.loadingPromise;
    if (!silent) this.setData({ loading: true, error: '' });

    const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
    const promise = api.call('home.get')
      .then((home) => {
        if (seq !== this._loadSeq) return;
        this.loadingPromise = null;
        const firstHome = !this.data.home;
        this.setData(Object.assign({ loading: false, error: '', home }, this.derive(home)));
        if (firstHome) this.playSceneEnter();
        this.maybeCelebrate(home);
      })
      .catch((err) => {
        // 已有更新请求发出时，旧请求的失败不打扰用户
        if (seq !== this._loadSeq) return;
        this.loadingPromise = null;
        if (silent && this.data.home) {
          // 文档 10.3：静默刷新失败保留旧数据，toast 不打断
          this.toast((err && err.message) || '刷新失败，稍后再试');
          return;
        }
        this.setData({ loading: false, error: '小屋的门卡住了' });
      });

    this.loadingPromise = promise;
    return promise;
  },

  derive(home) {
    const user = home.user || {};
    const partner = home.partner;
    const mood = home.mood || {};
    const hug = home.hug || {};
    // 三个区块可能是 null（查询失败降级，文档 10.3），这里按「没有数据」渲染
    const safety = home.safety || null;
    const diary = home.diary || null;
    const wish = home.wish || null;
    const nowMs = Date.parse(home.serverNow || '') || Date.now();
    const patch = {
      phase: home.phase || 'day',
      // 上限用服务端 todayKey（文档 13.5：日期规则以服务端为准），取不到再退回本机
      maxStartDate: home.todayKey || timeUtil.todayKey(),
      startDateSelect: home.couple ? home.couple.startDate : '',
      myAvatar: user.avatarFileID || DEFAULT_AVATAR,
      myName: user.nickname || '我',
      myUser: home.user || null,
      partnerName: (partner && partner.nickname) || 'TA',
      partnerUser: partner || null,
      bindHint: (home.bind && BIND_HINTS[home.bind.state]) || '',
      moodMine: mood.mine || null,
      moodPartner: mood.partner || null,
      hugIncoming: hug.incoming || null,
      hugOutgoing: hug.outgoing || null,
      // 门：对方今天报平安门灯暖；门牌显示对方最近一次报平安（文档 9.10）
      doorLit: !!(safety && safety.partnerToday),
      safetyLabel: !home.couple
        ? ''
        : (safety && safety.partnerToday
          ? 'TA 到家了'
          : (safety && safety.partnerLastAt
            ? 'TA ' + timeUtil.formatAgo(safety.partnerLastAt, nowMs)
            : '还没报平安')),
      // 只有自己刚创建的邀请码可以分享；applied_* 阶段的 code 已失效或属于对方（文档 11.5）
      shareCode: (home.bind && home.bind.state === 'code_created' && home.bind.pending && home.bind.pending.code) || '',
      // 台灯：我写了今天灯亮；TA 写了未解锁旁边小光点（文档 9.10）
      lampDim: !home.couple || !diary || diary.mineWritten === false,
      lampDot: !!(diary && diary.partnerWritten && !diary.partnerUnlocked),
      // 冰箱贴纸 done/total，桌子便签第一条未完成（文档 9.10）
      wishPreviewTitle: (wish && wish.previewTitle) || '',
      wishTotal: (wish && wish.total) || 0,
      wishDone: (wish && wish.done) || 0,
      // 文档 9.3：资料没填完时相框显示「+ 我的」占位
      profileIncomplete: !user.profileComplete,
      // 文档 9.3 / 9.10：纪念日临近时墙历高亮并提示还有几天
      calendarSoon: !!(home.couple && home.couple.anniversary && home.couple.anniversary.daysLeft <= 30),
      calendarSub: home.couple && home.couple.anniversary && home.couple.anniversary.daysLeft <= 30
        ? '纪念日还有 ' + home.couple.anniversary.daysLeft + ' 天'
        : '',
    };
    if (home.couple) {
      // 服务端在 couple.startDate 脏数据时会降级成 null，这里不能拼出「第 null 天」
      patch.daysText = home.couple.daysTogether ? '第 ' + home.couple.daysTogether + ' 天' : '';
      patch.startDateText = home.couple.startDate ? timeUtil.formatDateCN(home.couple.startDate) : '';
      patch.anniversaryText = home.couple.anniversary
        ? timeUtil.formatDateCN(home.couple.anniversary.date) + ' · 还有 ' + home.couple.anniversary.daysLeft + ' 天'
        : (home.couple.startDate ? '开始那天就是纪念日' : '');
    } else {
      patch.daysText = '';
      patch.startDateText = '';
      patch.anniversaryText = '';
    }
    return Object.assign(patch, this.deriveHugState(patch));
  },

  /** 按文档 9.4 的抱抱状态矩阵算底部按钮与提示 */
  deriveHugState(patch) {
    const incoming = patch.hugIncoming;
    const outgoing = patch.hugOutgoing;
    const days = patch.daysText || '';
    if (incoming) {
      return { hugButtonText: '抱抱 TA', hugButtonDisabled: false, hugHint: 'TA 现在需要抱抱' };
    }
    if (outgoing && outgoing.status === 'pending') {
      return {
        hugButtonText: '等 TA 抱抱',
        hugButtonDisabled: true,
        hugHint: '抱抱已经送出去啦，等 TA 回应',
      };
    }
    if (outgoing && outgoing.status === 'hugged') {
      return {
        hugButtonText: '再抱一次',
        hugButtonDisabled: false,
        hugHint: days ? days + ' · TA 抱了你' : 'TA 抱了你',
      };
    }
    if (outgoing && outgoing.status === 'expired') {
      return {
        hugButtonText: '我需要抱抱',
        hugButtonDisabled: false,
        hugHint: '上次抱抱过期了，再抱一次吧',
      };
    }
    return {
      hugButtonText: '我需要抱抱',
      hugButtonDisabled: false,
      hugHint: days ? days + ' · 一起的日子还在继续' : '一起的日子还在继续',
    };
  },

  /** 对方回应后只播一次心形动画（按 hugId 记录，已在本次会话/本机播过就不再播） */
  maybeCelebrate(home) {
    const outgoing = home && home.hug && home.hug.outgoing;
    if (!outgoing || outgoing.status !== 'hugged' || !outgoing.hugId) return;
    if (this.hasSeenHug(outgoing.hugId)) return;
    this.markHugSeen(outgoing.hugId);
    this.playHugCelebrate();
  },

  hasSeenHug(hugId) {
    // 存储不可用时用内存数组兜底，避免每次刷新重播心形动画
    if ((this._seenHugIds || []).indexOf(hugId) !== -1) return true;
    try {
      const seen = wx.getStorageSync(HUG_SEEN_KEY);
      return Array.isArray(seen) && seen.indexOf(hugId) !== -1;
    } catch (err) {
      return false;
    }
  },

  markHugSeen(hugId) {
    if (!hugId) return;
    this._seenHugIds = this._seenHugIds || [];
    if (this._seenHugIds.indexOf(hugId) === -1) this._seenHugIds.push(hugId);
    try {
      const seen = wx.getStorageSync(HUG_SEEN_KEY);
      const list = (Array.isArray(seen) ? seen : []).filter((id) => id !== hugId);
      list.push(hugId);
      wx.setStorageSync(HUG_SEEN_KEY, list.slice(-HUG_SEEN_MAX));
    } catch (err) {
      // 存储不可用就只用上面的内存标记
    }
  },

  playHugCelebrate() {
    clearTimeout(this._celebrateTimer);
    this.setData({ hugCelebrate: false });
    this._celebrateTimer = setTimeout(() => {
      if (this._unloaded) return;
      this.setData({ hugCelebrate: true });
      this._celebrateTimer = setTimeout(() => {
        if (this._unloaded) return;
        this.setData({ hugCelebrate: false });
        // 文档 9.7 心形上浮 1.4s：必须等动画播完再摘 class，否则尾巴被剪掉
      }, HUG_FLOAT_MS);
    }, 16);
  },

  /** 首屏场景入场（文档 9.7）：背景淡入 + 家具上移 8rpx，一次性 */
  playSceneEnter() {
    this.setData({ sceneEnter: false });
    const start = () => {
      if (this._unloaded) return;
      this.setData({ sceneEnter: true });
      clearTimeout(this._enterTimer);
      this._enterTimer = setTimeout(() => {
        if (this._unloaded) return;
        this.setData({ sceneEnter: false });
      }, 520);
    };
    // 等一次渲染后再加 class，保证动画能重播（同心形动画的做法）；低端机 setData 慢也不会丢
    this._enterTimer = setTimeout(() => {
      if (this._unloaded) return;
      if (typeof wx.nextTick === 'function') wx.nextTick(start);
      else start();
    }, 16);
  },

  onShareAppMessage() {
    const code = this.data.shareCode;
    const home = this.data.home;
    if (home && home.bind && home.bind.state === 'bound') {
      return { title: '我的小屋，今天也在等你', path: constants.ROUTES.home };
    }
    return {
      title: '来和我一起住进小怡怡安',
      path: constants.ROUTES.bind + (code ? '?code=' + code : ''),
    };
  },

  onShareTimeline() {
    // 朋友圈固定分享当前页（首页）；home.onLoad 不解析 code，带码也没用，
    // 且文档 11.5 要求邀请码不公开贴出 —— 朋友圈只分享小屋本身
    const home = this.data.home;
    const bound = !!(home && home.bind && home.bind.state === 'bound');
    return { title: bound ? '我的小屋，今天也在等你' : '来和我一起住进小怡怡安' };
  },

  onRetry() {
    this.load(false, true);
  },

  onTapBind() {
    wx.navigateTo({ url: constants.ROUTES.bind });
  },

  onTapProfile() {
    wx.navigateTo({ url: constants.ROUTES.profile });
  },

  /** 点我的头像：打开心情打卡弹层 */
  onTapMyAvatar() {
    const home = this.data.home;
    if (!home || !home.couple || !home.bind || home.bind.state !== 'bound') {
      this.toast('等 TA 住进来就能打卡啦');
      return;
    }
    this.setData({ moodPickerShow: true });
  },

  onCloseMoodPicker() {
    this.setData({ moodPickerShow: false });
  },

  async onMoodSelect(e) {
    if (this.data.moodSaving) return;
    const detail = (e && e.detail) || {};
    if (!detail.mood) return;
    this.setData({ moodSaving: true });
    try {
      const res = await api.call('mood.set', { mood: detail.mood, note: detail.note || '' });
      // 先按返回值更新气泡（组件负责 200ms 淡入），再静默刷新补对方视角
      this.setData({ moodSaving: false, moodPickerShow: false, moodMine: res.mood });
      this.toast('今天的心情记下啦');
      await this.load(true, true);
    } catch (err) {
      this.setData({ moodSaving: false });
      api.showError(err);
    }
  },

  /** 点对方头像：打开只读的对方心情详情（备注只在这里出现） */
  onTapPartnerAvatar() {
    const home = this.data.home;
    if (!home || !home.couple) {
      this.toast('等 TA 住进来吧');
      return;
    }
    const mood = this.data.moodPartner;
    if (!mood) {
      this.setData({ partnerMoodSheet: true, partnerMood: null });
      return;
    }
    const meta = MOODS.find((item) => item.key === mood.mood) || null;
    this.setData({
      partnerMoodSheet: true,
      partnerMood: {
        mood: mood.mood || '',
        label: meta ? meta.label : '',
        emoji: meta ? meta.emoji : '',
        timeText: timeUtil.formatTime(mood.updatedAt, home.todayKey || ''),
        note: mood.note || '',
      },
    });
  },

  onClosePartnerMood() {
    this.setData({ partnerMoodSheet: false });
  },

  onTapHug() {
    const home = this.data.home;
    if (!home || !home.couple) {
      this.onTapBind();
      return;
    }
    if (this.data.hugIncoming && this.data.hugIncoming.hugId) {
      this.respondHug(this.data.hugIncoming.hugId);
      return;
    }
    this.sendHug();
  },

  onHugRespond(e) {
    const hugId = (e && e.detail && e.detail.hugId) || (this.data.hugIncoming && this.data.hugIncoming.hugId);
    this.respondHug(hugId);
  },

  async sendHug() {
    if (this.data.hugSending) return;
    if (this.data.hugOutgoing && this.data.hugOutgoing.status === 'pending') {
      this.toast('抱抱已经发出去了，等 TA 回应');
      return;
    }
    this.setData({ hugSending: true });
    try {
      const res = await api.call('hug.send');
      this.setData({
        hugSending: false,
        hugOutgoing: res.hug,
        hugButtonText: '等 TA 抱抱',
        hugButtonDisabled: true,
        hugHint: '抱抱已经送出去啦，等 TA 回应',
      });
      this.toast(res.existing ? '抱抱已经发出去了，等 TA 回应' : '抱抱送出去啦');
      if (!res.existing) {
        this.playHugCelebrate();
        haptics.light();
      }
      await this.load(true, true);
    } catch (err) {
      this.setData({ hugSending: false });
      api.showError(err);
    }
  },

  async respondHug(hugId) {
    if (!hugId || this.data.hugSending) return;
    this.setData({ hugSending: true });
    try {
      const res = await api.call('hug.respond', { hugId });
      // 先把本地状态从「TA 需要抱抱」切走，即使随后的静默刷新失败也不会停在旧横幅上。
      // 注意不要伪造 hugOutgoing：回应方此刻并没有自己的发出记录，真实状态交给刷新补。
      this.setData({
        hugSending: false,
        hugCelebrate: false,
        hugIncoming: null,
        hugButtonText: '我需要抱抱',
        hugButtonDisabled: false,
        hugHint: '抱抱送到啦',
      });
      this.playHugCelebrate();
      if (!res.already) haptics.light();
      this.toast(res.already ? '你们已经抱过啦' : '抱到啦');
      await this.load(true, true);
    } catch (err) {
      this.setData({ hugSending: false });
      api.showError(err);
      if (err && (err.code === 'HUG_EXPIRED' || err.code === 'HUG_NOT_FOUND')) {
        this.load(true, true);
      }
    }
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
      // 先给成功反馈，再静默刷新；否则刷新失败的错误 toast 会被成功 toast 盖掉
      wx.showToast({ title: '日子重新算好啦', icon: 'none' });
      await this.load(true, true);
    } catch (err) {
      this.setData({ startDateSaving: false });
      api.showError(err);
    }
  },

  /** 场景里的三个房间入口（文档 9.3 / 10.6-10.8）：没绑定先引导绑定 */
  openRoomPage(route) {
    const home = this.data.home;
    if (!home || !home.couple) {
      this.toast('等 TA 住进来，这里就开门啦');
      return;
    }
    wx.navigateTo({ url: route });
  },

  onTapLamp() {
    this.openRoomPage(constants.ROUTES.diary);
  },

  onTapFridge() {
    this.openRoomPage(constants.ROUTES.wish);
  },

  onTapTableNote() {
    this.openRoomPage(constants.ROUTES.wish);
  },

  onTapDoor() {
    this.openRoomPage(constants.ROUTES.safety);
  },

  noop() {},
});
