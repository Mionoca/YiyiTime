const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const tabbar = require('../../utils/tabbar');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;
const MOODS = constants.MOODS;
// 卡片入场 300ms（文档 9.7），多留 20ms 再摘 class
const CARD_ENTER_MS = 320;
/** 先停一下（M11）：三档时长与和好卡文案（与服务端 DURATIONS / CHOICES 同源，见 7.17） */
const PAUSE_DURATIONS = [10, 30, 60];
const PAUSE_CHOICE_TEXT = { hurry: '我刚才有点急', later: '晚点再说', hug: '抱一下' };
/** 便签倒计时本地每分钟重算一次（文档 9.3：不轮询服务端，只用来展示） */
const PAUSE_TICK_MS = 60 * 1000;

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
    // 纪念日堆叠（文档 9.4）：卡 0 是「在一起」，后面是自定义纪念日
    cards: [],
    cardIndex: 0,
    cardCount: 0,
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
    // 先停一下（M11 / 文档 9.2 第 0.5 位、9.3、7.17）：条件卡，无暂停时整块不存在
    pauseState: '',            // '' | active | ended
    pauseByMe: false,
    pauseByName: '',
    pauseRemainText: '',
    pauseSaving: false,
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

  onHide() {
    // 离开首页就不再走倒计时（回来时 onShow 全量对齐服务端）
    this.stopPauseTicker();
  },

  onUnload() {
    // 页面已卸载：之后的定时器 / nextTick 回调不再 setData（微信会告警）
    this._unloaded = true;
    clearTimeout(this._enterTimer);
    this.stopPauseTicker();
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
        this.startPauseTicker();
        if (firstHome) this.playCardEnter();
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

    // 先停一下（M11 / 文档 7.17）：未绑定、没有暂停、单块读失败降级 null 三种情况都不渲染便签
    const pauseView = home.couple ? (home.pause || null) : null;
    const pausePatch = pauseDataOf(pauseView, nowMs);
    Object.assign(patch, pausePatch);
    this._pauseBase = pauseBaseOf(pauseView, nowMs);

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

    // 纪念日堆叠（文档 9.4）：卡 0 永远是「在一起」，后面按服务端给的剩余天数顺序排
    patch.cards = buildCards(home, patch.daysText, patch.startDateText);
    patch.cardCount = patch.cards.length;
    // 对方可能刚删掉你正在看的那张 → 下标夹回合法范围，不留空白卡
    patch.cardIndex = patch.cardCount
      ? Math.min(Math.max(this.data.cardIndex | 0, 0), patch.cardCount - 1)
      : 0;
    return patch;
  },

  /** 堆叠切换：只改下标，组件按位置重算 transform / opacity（文档 9.4） */
  onCardChange(e) {
    const index = Number(e && e.detail && e.detail.index);
    if (!Number.isFinite(index) || index === this.data.cardIndex) return;
    if (index < 0 || index >= this.data.cards.length) return;
    this.setData({ cardIndex: index });
  },

  /** 卡片脚注「改日子」：只有「在一起」那张卡会出现这个链接 */
  onCardEdit(e) {
    const kind = e && e.detail && e.detail.kind;
    if (kind !== 'together') return;
    this.onTapCalendar();
  },

  /** 卡片脚注「管理 ›」：进纪念日管理页（增删改都在那一页） */
  onManageAnniversary() {
    const home = this.data.home;
    if (!home || !home.couple) {
      this.toast('等 TA 住进来再一起记日子');
      return;
    }
    wx.navigateTo({ url: constants.ROUTES.anniversary });
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

  /**
   * 「先停一下」入口（文档 9.3）：心情卡下方一行文字链，三档时长走 ActionSheet，
   * 全 app 只放这一处入口（不在「我的」重复）。
   */
  onTapPauseStart() {
    const home = this.data.home;
    if (!home || !home.couple) {
      this.toast('等 TA 住进来，再一起按暂停');
      return;
    }
    if (this.data.pauseSaving) return;
    if (this.data.pauseState) {
      // 已经在暂停里（便签在顶上），入口不再重复触发
      this.toast(this.data.pauseState === 'active' ? '先缓一缓，到点了会提醒你们' : '可以选一句和好的话');
      return;
    }
    wx.showActionSheet({
      itemList: PAUSE_DURATIONS.map((min) => min + ' 分钟'),
      success: (res) => {
        const durationMin = PAUSE_DURATIONS[res.tapIndex];
        if (durationMin) this.startPause(durationMin);
      },
      fail: () => {}, // 用户取消，什么都不做
    });
  },

  /** 发起暂停：成功后先本地渲染便签再看服务端（刷新失败也看得到） */
  async startPause(durationMin) {
    if (this.data.pauseSaving) return;
    this.setData({ pauseSaving: true });
    try {
      const res = await api.call('pause.start', { durationMin });
      this.setData({ pauseSaving: false });
      this.applyPause(res.pause);
      this.toast(res.existing ? '已经在暂停里了' : '先停 ' + durationMin + ' 分钟');
      await this.load(true, true);
    } catch (err) {
      this.setData({ pauseSaving: false });
      api.showError(err);
    }
  },

  /** 发起方提前结束（「我缓好了」）：幂等，重复点不会报错 */
  async onTapPauseEnd() {
    if (this.data.pauseSaving) return;
    this.setData({ pauseSaving: true });
    try {
      const res = await api.call('pause.end');
      this.setData({ pauseSaving: false });
      this.applyPause(res.pause);
      this.toast('好，等 TA 也缓缓');
      await this.load(true, true);
    } catch (err) {
      this.setData({ pauseSaving: false });
      api.showError(err);
    }
  },

  /** 和好卡三选一：先选者定，选完卡片消失（closed 之后服务端不再返回） */
  async onTapPauseChoose(e) {
    if (this.data.pauseSaving) return;
    const choice = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.choice) || '';
    if (!choice) return;
    this.setData({ pauseSaving: true });
    try {
      await api.call('pause.choose', { choice });
      // 本地先收起：closed 等于不存在，下一次 load 也拿不到它
      this.setData({
        pauseSaving: false, pauseState: '', pauseByMe: false, pauseByName: '', pauseRemainText: '',
      });
      this.stopPauseTicker();
      this._pauseBase = null;
      this.toast('记下了');
      await this.load(true, true);
    } catch (err) {
      this.setData({ pauseSaving: false });
      api.showError(err);
    }
  },

  /** 写操作后先本地渲染：服务端视图 → data 片段，再静默对齐（失败也不影响已渲染结果） */
  applyPause(pauseView) {
    const nowMs = serverNowOf(this.data.home);
    this.setData(pauseDataOf(pauseView, nowMs));
    this._pauseBase = pauseBaseOf(pauseView, nowMs);
    if (this.data.pauseState === 'active') this.startPauseTicker();
    else this.stopPauseTicker();
  },

  /**
   * 便签倒计时（文档 9.3）：本地每分钟重算剩余分钟，**不轮询服务端**。
   * 以「服务端给的剩余毫秒 + 本地流逝」推算，设备时钟偏移不影响差值。
   * 到点后先本地翻面（服务端在下一次读取时惰性写回 ended），再静默对齐一次。
   */
  startPauseTicker() {
    this.stopPauseTicker();
    const base = this._pauseBase;
    if (!base || this.data.pauseState !== 'active') return;
    this._pauseTimer = setInterval(() => {
      if (this._unloaded) return;
      const remainMs = base.remainMs - (Date.now() - base.at);
      if (remainMs > 0) {
        const text = pauseRemainText(remainMs);
        if (text !== this.data.pauseRemainText) this.setData({ pauseRemainText: text });
        return;
      }
      this.stopPauseTicker();
      this.setData({ pauseState: 'ended', pauseRemainText: '' });
      this.load(true, true);
    }, PAUSE_TICK_MS);
  },

  stopPauseTicker() {
    if (this._pauseTimer) clearInterval(this._pauseTimer);
    this._pauseTimer = null;
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

/** 服务端「现在」（毫秒）：页面里的时间展示都对齐 serverNow，不用设备时钟（1.5 / 12.5） */
function serverNowOf(home) {
  const ms = Date.parse((home && home.serverNow) || '');
  return Number.isFinite(ms) ? ms : Date.now();
}

/** 剩余毫秒 → 便签文案：向上取整到分钟（还剩 23.2 分钟就说「还有 24 分钟」），到点说「马上就到点了」 */
function pauseRemainText(remainMs) {
  if (!Number.isFinite(remainMs) || remainMs <= 0) return '马上就到点了';
  return '还有 ' + Math.ceil(remainMs / 60000) + ' 分钟';
}

/**
 * 服务端 pause 视图 → 首页 data 片段（纯函数）。
 * null / 未知状态一律清空：未绑定、没有暂停、可选区块降级 null 三种情况客户端表现一致——
 * 便签根本不渲染，也不留占位。
 */
function pauseDataOf(pauseView, nowMs) {
  const blank = { pauseState: '', pauseByMe: false, pauseByName: '', pauseRemainText: '' };
  if (!pauseView || (pauseView.status !== 'active' && pauseView.status !== 'ended')) return blank;
  const ended = pauseView.status === 'ended';
  const endsMs = Date.parse(pauseView.endsAt || '');
  const remainMs = Number.isFinite(endsMs) ? endsMs - nowMs : NaN;
  return {
    pauseState: ended ? 'ended' : 'active',
    pauseByMe: !!pauseView.byMe,
    pauseByName: pauseView.byName || 'TA',
    pauseRemainText: ended ? '' : pauseRemainText(remainMs),
  };
}

/** 倒计时本地基准：只有进行中的暂停才有（到点 / 已翻面都不需要） */
function pauseBaseOf(pauseView, nowMs) {
  if (!pauseView || pauseView.status !== 'active') return null;
  const endsMs = Date.parse(pauseView.endsAt || '');
  if (!Number.isFinite(endsMs)) return null;
  return { remainMs: Math.max(0, endsMs - nowMs), at: Date.now() };
}

/**
 * 拼堆叠卡（文档 9.4）：卡 0 永远是「在一起」（来自 couple），后面是自定义纪念日。
 * 组件不认识这两种卡，所以文案全部在这里算好；
 * 剩余天数与周年都用服务端返回的值，客户端不自己算日期（1.5 / 12.5）。
 */
function buildCards(home, daysText, startDateText) {
  if (!home || !home.couple) return [];
  const couple = home.couple;
  const ann = couple.anniversary;
  const cards = [{
    key: 'together',
    kind: 'together',
    label: '我们的日子',
    mainText: daysText || '从今天开始',
    subText: startDateText ? '开始于 ' + startDateText : '还没选开始的日子',
    metaText: ann
      ? (ann.daysLeft === 0 ? '周年 · 就是今天' : '周年 · 还有 ' + ann.daysLeft + ' 天')
      : (couple.startDate ? '开始那天就是纪念日' : ''),
  }];

  const items = (home.anniversary && home.anniversary.items) || [];
  items.forEach((item, i) => {
    const daysLeft = typeof item.daysLeft === 'number' ? item.daysLeft : null;
    cards.push({
      key: item.anniversaryId || 'custom-' + i,
      kind: 'custom',
      label: item.title || '纪念日',
      mainText: daysLeft === null
        ? '日子还没算好'
        : (daysLeft === 0 ? '就是今天' : '还有 ' + daysLeft + ' 天'),
      subText: item.nextDate ? timeUtil.formatMonthDay(item.nextDate) : '',
      metaText: item.years ? '第 ' + item.years + ' 个' : '',
    });
  });
  return cards;
}

/** 心情一行摘要：「晴 · 今天很好」，没打卡是「还没说」 */function moodText(mood) {
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
