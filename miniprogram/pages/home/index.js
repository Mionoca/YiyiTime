const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const haptics = require('../../utils/haptics');
const tabbar = require('../../utils/tabbar');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;
const MOODS = constants.MOODS;
const HUG_SEEN_KEY = 'hug_seen_ids';
const HUG_SEEN_MAX = 20;
// 文档 9.7：心形上浮 1400ms；多留 40ms 余量，避免定时器先于动画结束
const HUG_FLOAT_MS = 1440;
// 卡片入场 300ms（文档 9.7），多留 20ms 再摘 class
const CARD_ENTER_MS = 320;

/** 未绑定 / 邀请中的文案（文档 9.12） */
const BIND_TEXT = {
  code_created: {
    title: '邀请码已经备好啦',
    sub: '把它发给 TA，等 TA 输入就住进来了',
    action: '去看看',
  },
  applied_by_me: {
    title: '等 TA 确认',
    sub: '已经申请了，TA 点确认你们就在一起了',
    action: '去看看',
  },
  applied_by_partner: {
    title: '有人在等你',
    sub: 'TA 想住进来，点一下确认',
    action: '去看看',
  },
};

const UNBOUND_TEXT = {
  title: '屋里还缺一个人',
  sub: '邀请 TA 一起住进来，日子从你们选的那天算起',
  action: '邀请 TA 住进来',
};

Page({
  data: {
    loading: true,
    error: '',
    // 文档 9.12：静默刷新失败保留上次卡片，吸顶横幅「小屋的门卡住了」+「再试一次」
    refreshError: '',
    home: null,
    // 卡片入场动画（文档 9.7）：一次性 class，320ms 后移除
    cardEnter: false,
    // 首页分享卡片带的邀请码（文档 9.12 / 13.8）
    shareCode: '',
    myAvatar: DEFAULT_AVATAR,
    myName: '我',
    partnerName: 'TA',
    myUser: null,
    partnerUser: null,
    // 日子卡
    daysText: '',
    startDateText: '',
    anniversaryText: '',
    showDaysSheet: false,
    startDateSelect: '',
    maxStartDate: '',
    startDateSaving: false,
    // 今天的心情（文档 7.8 / 9.5）
    moodMine: null,
    moodPartner: null,
    moodMineText: '还没说',
    moodPartnerText: '还没说',
    moodPickerShow: false,
    moodSaving: false,
    partnerMoodSheet: false,
    partnerMood: null,
    // 抱抱（文档 7.8 / 9.4）
    hugIncoming: null,
    hugOutgoing: null,
    hugButtonText: '我需要抱抱',
    hugButtonDisabled: false,
    hugHint: '',
    hugSending: false,
    hugCelebrate: false,
    // 四个入口的状态摘要（文档 9.2）
    diarySub: '今天还没写',
    wishSub: '还没有愿望',
    safetySub: '还没报平安',
    // 未绑定 / 邀请中
    bindTitle: UNBOUND_TEXT.title,
    bindSub: UNBOUND_TEXT.sub,
    bindActionText: UNBOUND_TEXT.action,
    // 解绑提示条（M9 / 文档 9.2）：只有对方发起时才在首页提示，自己发起的看「我的」
    unbindNotice: false,
    unbindNoticeText: '',
  },

  onLoad() {
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
    // 自定义 tabBar 的选中态要页面自己报（文档 8.2）
    tabbar.sync(this, constants.ROUTES.home);
    this.load(!!this.data.home);
  },

  onUnload() {
    // 页面已卸载：之后的定时器 / nextTick 回调不再 setData（微信会告警）
    this._unloaded = true;
    clearTimeout(this._celebrateTimer);
    clearTimeout(this._enterTimer);
  },

  onPullDownRefresh() {
    // 下拉刷新：失败也要收起转圈，否则用户一直看到加载中（12.9）
    this.load(false, true).then(
      () => wx.stopPullDownRefresh(),
      () => wx.stopPullDownRefresh()
    );
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  /**
   * 拉首页聚合。silent=保留旧数据静默刷新；force=丢弃在途请求的结果。
   * 写操作成功后必须 force，否则可能拿到写之前发出的旧响应，把刚更新的状态覆盖回去。
   */
  load(silent, force) {
    if (this.loadingPromise && !force) return this.loadingPromise;
    if (!silent) this.setData({ loading: true, error: '', refreshError: '' });

    const seq = (this._loadSeq = (this._loadSeq || 0) + 1);
    const promise = api.call('home.get')
      .then((home) => {
        if (seq !== this._loadSeq) return;
        this.loadingPromise = null;
        const firstHome = !this.data.home;
        this.setData(Object.assign({ loading: false, error: '', refreshError: '', home }, this.derive(home)));
        if (firstHome) this.playCardEnter();
        this.maybeCelebrate(home);
      })
      .catch((err) => {
        // 已有更新请求发出时，旧请求的失败不打扰用户
        if (seq !== this._loadSeq) return;
        this.loadingPromise = null;
        if (silent && this.data.home) {
          // 文档 12.9：静默刷新失败保留旧卡片，toast 不打断，另给持久的恢复入口
          this.setData({ refreshError: '小屋的门卡住了' });
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
      // 上限用服务端 todayKey（文档 13.5：日期规则以服务端为准），取不到再退回本机
      maxStartDate: home.todayKey || timeUtil.todayKey(),
      startDateSelect: home.couple ? home.couple.startDate : '',
      myAvatar: user.avatarFileID || DEFAULT_AVATAR,
      myName: user.nickname || '我',
      myUser: home.user || null,
      partnerName: (partner && partner.nickname) || 'TA',
      partnerUser: partner || null,
      moodMine: mood.mine || null,
      moodPartner: mood.partner || null,
      moodMineText: moodText(mood.mine),
      moodPartnerText: moodText(mood.partner),
      hugIncoming: hug.incoming || null,
      hugOutgoing: hug.outgoing || null,
      // 只有自己刚创建的邀请码可以分享；applied_* 阶段的 code 已失效或属于对方（文档 11.5）
      shareCode: (home.bind && home.bind.state === 'code_created' && home.bind.pending && home.bind.pending.code) || '',
      diarySub: diarySubText(home.couple, diary),
      wishSub: wishSubText(wish),
      safetySub: safetySubText(home.couple, safety, nowMs),
    };

    // 解绑提示条：只有「对方发起」才提示（自己发起的去「我的」撤回，首页不重复打扰）。
    // requestedByMe 必须是明确的 false 才算「对方发起」：字段缺失时宁可不提示，也不能吓用户一跳
    const unbind = home.unbind || { status: 'none', requestedByMe: false };
    patch.unbindNotice = !!(home.couple && unbind.status === 'pending' && unbind.requestedByMe === false);
    patch.unbindNoticeText = patch.unbindNotice ? 'TA 申请了解绑，去「我的」看看' : '';

    const bindState = (home.bind && home.bind.state) || 'unbound';
    if (!home.couple) {
      const text = BIND_TEXT[bindState] || UNBOUND_TEXT;
      patch.bindTitle = text.title;
      patch.bindSub = text.sub;
      patch.bindActionText = text.action;
    }

    if (home.couple) {
      // 服务端在 couple.startDate 脏数据时会降级成 null，这里不能拼出「第 null 天」
      patch.daysText = home.couple.daysTogether ? '第 ' + home.couple.daysTogether + ' 天' : '从今天开始';
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

  /** 按文档 9.4 的抱抱状态矩阵算按钮与提示 */
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

  /** 首屏卡片入场（文档 9.7）：一次性 class，不永久挂 */
  playCardEnter() {
    this.setData({ cardEnter: false });
    const start = () => {
      if (this._unloaded) return;
      this.setData({ cardEnter: true });
      clearTimeout(this._enterTimer);
      this._enterTimer = setTimeout(() => {
        if (this._unloaded) return;
        this.setData({ cardEnter: false });
      }, CARD_ENTER_MS);
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

  /** 吸顶横幅「再试一次」（文档 9.12）：保留当前卡片静默重拉；连点复用同一请求 */
  onRetryRefresh() {
    if (this._retryingRefresh) return this._retryingRefresh;
    const run = this.load(true, true);
    this._retryingRefresh = run;
    const clear = () => {
      this._retryingRefresh = null;
    };
    run.then(clear, clear);
    return run;
  },

  onTapBind() {
    wx.navigateTo({ url: constants.ROUTES.bind });
  },

  /** 解绑提示条（文档 9.2）：「我的」是 tab 页，只能 switchTab */
  onTapUnbindNotice() {
    wx.switchTab({ url: constants.ROUTES.profile });
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
      this.setData({
        moodSaving: false,
        moodPickerShow: false,
        moodMine: res.mood,
        moodMineText: moodText(res.mood),
      });
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
      // 先把本地状态从「TA 需要抱抱」切走，即使随后的静默刷新失败也不会停在旧状态上。
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
    this.toast('等 TA 住进来，日子才开始算');
  },

  onCloseDaysSheet() {
    this.setData({ showDaysSheet: false });
  },

  /** 浮层里改开始日期：先二次确认，避免一方随手改掉两个人的天数 */
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

  /**
   * 四个入口（文档 9.2）：日记 / 愿望 / 报平安 / 心情记录都是普通页面，navigateTo 进入；
   * 仍然先判 isTabRoute，将来把它们收进 tabBar 也只改 TAB_ROUTES。
   * 没绑定时不跳转，只提示 —— 进去也全是空态。
   */
  openEntry(route) {
    const home = this.data.home;
    if (!home || !home.couple) {
      this.toast('等 TA 住进来，这里就开门啦');
      return;
    }
    if (constants.isTabRoute(route)) {
      wx.switchTab({ url: route });
      return;
    }
    wx.navigateTo({ url: route });
  },

  onTapDiary() {
    this.openEntry(constants.ROUTES.diary);
  },

  onTapWish() {
    this.openEntry(constants.ROUTES.wish);
  },

  onTapSafety() {
    this.openEntry(constants.ROUTES.safety);
  },

  onTapMoodHistory() {
    this.openEntry(constants.ROUTES.mood);
  },

  noop() {},
});

/** 心情一行摘要：「晴 · 今天很好」，没打卡是「还没说」 */
function moodText(mood) {
  if (!mood || !mood.mood) return '还没说';
  const meta = MOODS.find((item) => item.key === mood.mood);
  const label = meta ? meta.label : '';
  const note = mood.note ? ' · ' + mood.note : '';
  return label ? label + note : '还没说';
}

/** 日记入口摘要（文档 9.10）：只提示「谁写了 / 能不能看」，不泄露正文 */
function diarySubText(couple, diary) {
  if (!couple) return '等 TA 住进来';
  if (!diary) return '今天还没写';
  if (diary.mineWritten && diary.partnerWritten) {
    // 双方都写了，但对方那篇要等到明天才解锁
    return diary.partnerUnlocked ? '你们都写了今天' : '你写了，TA 的明天解锁';
  }
  if (diary.mineWritten) return '你写了，等 TA';
  if (diary.partnerWritten) return 'TA 写了，明天就能看';
  return '今天还没写';
}

function wishSubText(wish) {
  if (!wish || !wish.total) return '还没有愿望';
  return wish.done + '/' + wish.total + ' 完成';
}

/** 报平安摘要：对方今天报过就直说，否则给「多久之前」，从没报过才说没报 */
function safetySubText(couple, safety, nowMs) {
  if (!couple) return '等 TA 住进来';
  if (!safety) return '还没报平安';
  if (safety.partnerToday) return 'TA 到家了';
  if (safety.partnerLastAt) return 'TA ' + timeUtil.formatAgo(safety.partnerLastAt, nowMs);
  return '还没报平安';
}
