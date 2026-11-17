'use strict';

const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');

const PAGE_SIZE = 10;
// 文档 12.9：列表失败保留已加载内容，底部提示「加载失败，点重试」
const LIST_ERROR_TEXT = '加载失败，点重试';
const EMPTY_ERROR_TEXT = '心情记录本打不开，再试一次';

const MOOD_BY_KEY = {};
constants.MOODS.forEach((item) => {
  MOOD_BY_KEY[item.key] = item;
});

/** 一条心情 → 展示用的图标/文字；脏数据不渲染成空白（9.5） */
function decorateMood(mood) {
  if (!mood) return null;
  const meta = MOOD_BY_KEY[mood.mood];
  return {
    emoji: meta ? meta.emoji : '·',
    label: meta ? meta.label : '心情',
    note: String(mood.note || ''),
    time: timeUtil.formatHM(mood.updatedAt),
  };
}

/** 读屏用的一句话（8.9：图标必须同时有文字） */
function a11yOf(label, mine, partner) {
  const part = (who, mood) => (mood ? who + ' ' + mood.label + (mood.note ? ' ' + mood.note : '') : who + ' 没说');
  return label + '，' + part('我', mine) + '，' + part('TA', partner);
}

Page({
  data: {
    days: [],
    todayKey: '',
    loading: true,
    loadingMore: false,
    hasMore: false,
    error: '',
    listError: '',
  },

  onLoad() {
    this._firstShow = true;
    this.load();
  },

  onShow() {
    // onLoad 已经拉过第一页；之后回到页面静默刷新，保留旧列表不闪 loading（10.3）
    if (this._firstShow) {
      this._firstShow = false;
      return;
    }
    if (this._loaded) this.load(true);
  },

  onPullDownRefresh() {
    // 文档 L637：子页支持下拉刷新；成功失败都收起转圈
    const stop = () => wx.stopPullDownRefresh();
    this.load(true).then(stop, stop);
  },

  onReachBottom() {
    this.loadMore();
  },

  onUnload() {
    // 请求可能还在路上：卸载后不再 setData（避免 "setData after unload" 告警）
    this._unloaded = true;
  },

  onRetry() {
    this.load();
  },

  /** 底部「加载失败，点重试」：翻页失败从游标继续，刷新失败重拉第一页 */
  onRetryList() {
    // 连点复用同一个请求，避免并发翻页与重复 toast
    if (this._retryingList) return this._retryingList;
    const retryMore = this._listErrorKind === 'more' && !!this._beforeDate;
    const run = retryMore ? this.loadMore() : this.load(true);
    this._retryingList = run;
    const clear = () => {
      this._retryingList = null;
    };
    run.then(clear, clear);
    return run;
  },

  /**
   * 一天一条：日期文案只认服务端 todayKey（1.5 / 10.9），
   * 「昨天」由服务端日期推出来，不用设备时钟。
   */
  decorateDays(list, todayKey) {
    const yesterdayKey = timeUtil.shiftDateKey(todayKey, -1);
    return (list || []).map((day) => {
      const label = day.date === todayKey
        ? '今天'
        : (day.date === yesterdayKey ? '昨天' : timeUtil.formatMonthDay(day.date));
      const mine = decorateMood(day.mine);
      const partner = decorateMood(day.partner);
      return {
        date: day.date,
        label,
        dateText: timeUtil.formatMonthDay(day.date),
        a11y: a11yOf(label, mine, partner),
        rows: [
          { who: '我', mood: mine },
          { who: 'TA', mood: partner },
        ],
      };
    });
  },

  /** 按 date 去重合并：翻页边界不会重复插入同一天 */
  mergeDays(first, second) {
    const seen = {};
    const out = [];
    (first || []).concat(second || []).forEach((day) => {
      if (!day || !day.date || seen[day.date]) return;
      seen[day.date] = true;
      out.push(day);
    });
    return out;
  },

  async load(silent) {
    if (this._loadingList && !silent) return;
    // 请求令牌：静默刷新会重置第一页，先用旧游标发出的翻页响应必须作废，
    // 否则会把「第一页 + 更旧的一页」拼在一起，中间那天被静默跳过。
    const token = (this._seq = (this._seq || 0) + 1);
    const stale = () => this._unloaded || token !== this._seq;
    if (!silent) this.setData({ loading: true, error: '', listError: '' });
    this._loadingList = true;
    try {
      const res = await api.call('mood.list', { limit: PAGE_SIZE });
      if (stale()) return;
      const todayKey = (res && res.todayKey) || timeUtil.todayKey();
      this._beforeDate = (res && res.nextBeforeDate) || '';
      this._loaded = true;
      this._listErrorKind = '';
      this.setData({
        days: this.decorateDays((res && res.days) || [], todayKey),
        todayKey,
        hasMore: !!this._beforeDate,
        loading: false,
        loadingMore: false,
        error: '',
        listError: '',
      });
    } catch (err) {
      if (stale()) return;
      if (err && err.code === 'NOT_BOUND') {
        // 未绑定不该看到这里（入口在「我的」已拦截），兜底提示后返回上一页
        this.setData({ loading: false, loadingMore: false, error: '', listError: '' });
        api.showError(err);
        wx.navigateBack({
          delta: 1,
          fail: () => this.setData({ error: '先邀请 TA 住进来吧' }),
        });
        return;
      }
      if (silent && this.data.days.length) {
        // 静默刷新失败：保留已加载内容，底部给可点的重试（12.9）
        this._listErrorKind = 'refresh';
        this.setData({ loading: false, loadingMore: false, listError: LIST_ERROR_TEXT });
        api.showError(err);
        return;
      }
      this.setData({
        loading: false,
        loadingMore: false,
        error: EMPTY_ERROR_TEXT,
        listError: '',
      });
    } finally {
      this._loadingList = false;
    }
  },

  async loadMore() {
    // 刷新在途时不翻页：两边的 days / 游标会互相覆盖（load 的令牌会作废旧翻页响应）
    if (this._loadingList || this.data.loading || this.data.loadingMore || !this._beforeDate) return;
    const token = this._seq || 0;
    this.setData({ loadingMore: true, listError: '' });
    try {
      const res = await api.call('mood.list', {
        beforeDate: this._beforeDate,
        limit: PAGE_SIZE,
      });
      if (this._unloaded || token !== (this._seq || 0)) {
        // 响应作废：别再改列表，但要把自己的转圈收掉（刷新分支也会兜一次）
        if (!this._unloaded) this.setData({ loadingMore: false });
        return;
      }
      const todayKey = this.data.todayKey || (res && res.todayKey) || timeUtil.todayKey();
      const more = this.decorateDays((res && res.days) || [], todayKey);
      this._beforeDate = (res && res.nextBeforeDate) || '';
      this._listErrorKind = '';
      this.setData({
        days: this.mergeDays(this.data.days, more),
        hasMore: !!this._beforeDate,
        loadingMore: false,
        listError: '',
      });
    } catch (err) {
      if (this._unloaded || token !== (this._seq || 0)) {
        if (!this._unloaded) this.setData({ loadingMore: false });
        return;
      }
      // 保留已加载内容，底部从当前游标继续（12.9）
      this._listErrorKind = 'more';
      this.setData({ loadingMore: false, listError: LIST_ERROR_TEXT });
      api.showError(err);
    }
  },
});
