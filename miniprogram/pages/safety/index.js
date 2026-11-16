'use strict';

const api = require('../../utils/api');
const meUtil = require('../../utils/me');
const constants = require('../../utils/constants');
const haptics = require('../../utils/haptics');

const PAGE_SIZE = 20;
const NOTE_MAX = constants.LIMITS.safetyNote;

Page({
  data: {
    items: [],
    nextCursor: null,
    note: '',
    noteMax: NOTE_MAX,
    checking: false,
    loading: true,
    loadingMore: false,
    error: '',
    myOpenid: '',
    todayKey: '',
  },

  onLoad() {
    this._firstShow = true;
    this.load(true);
    meUtil
      .getMe()
      .then((user) => {
        if (user && user.openid) this.setData({ myOpenid: user.openid });
      })
      .catch(() => {
        // 拿不到 openid 只影响「我」的左右对齐，不影响报平安
      });
  },

  onShow() {
    if (this._firstShow) {
      this._firstShow = false;
      return;
    }
    // 静默刷新：保留旧列表，不闪「正在看门口的灯」（文档 8.6 / 10.3）
    if (this._loaded) this.load(true, true);
  },

  onPullDownRefresh() {
    // 文档 L637：子页支持下拉刷新；静默刷新保留旧列表，成功失败都收起转圈
    const stop = () => wx.stopPullDownRefresh();
    this.load(true, true).then(stop, stop);
  },

  onReachBottom() {
    this.loadMore();
  },

  onRetry() {
    this.load(true);
  },

  onNoteInput(e) {
    this.setData({ note: String((e && e.detail && e.detail.value) || '') });
  },

  /** 按 checkinId 去重合并，游标分页边界不会重复插入 */
  mergeItems(first, second) {
    const seen = {};
    const out = [];
    const push = (item) => {
      if (!item || !item.checkinId || seen[item.checkinId]) return;
      seen[item.checkinId] = true;
      out.push(item);
    };
    (first || []).forEach(push);
    (second || []).forEach(push);
    return out;
  },

  async load(reset, silent) {
    if (this._loadingList) return;
    if (!reset && !this.data.nextCursor) return;
    this._loadingList = true;
    if (reset) {
      if (!silent) this.setData({ loading: true, error: '' });
    } else {
      this.setData({ loadingMore: true });
    }
    try {
      const payload = { limit: PAGE_SIZE };
      if (!reset) payload.cursor = this.data.nextCursor;
      const res = await api.call('safety.list', payload);
      const items = this.mergeItems(
        reset ? [] : this.data.items,
        (res && res.items) || []
      );
      this._loaded = true;
      this.setData({
        items,
        // 服务端今天（文档 1.5）：只用于时间线的「今天 HH:mm」展示
        todayKey: reset ? ((res && res.todayKey) || this.data.todayKey) : this.data.todayKey,
        nextCursor: (res && res.nextCursor) || null,
        loading: false,
        loadingMore: false,
        error: '',
      });
    } catch (err) {
      if (silent && this.data.items.length) {
        // 静默刷新失败：只 toast，不打断页面（文档 10.3）
        this.setData({ loading: false, loadingMore: false });
        api.showError(err);
        return;
      }
      if (!reset && this.data.items.length) {
        this.setData({ loadingMore: false });
        api.showError(err);
        return;
      }
      this.setData({ loading: false, loadingMore: false, error: '门口有点吵，再试一次' });
    } finally {
      this._loadingList = false;
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this.data.nextCursor) return;
    await this.load(false);
  },

  /** 文档 7.9 / 10.6：10 分钟内重复按只算一次，接口返回 deduped */
  async onCheckin() {
    if (this.data.checking) return;
    this.setData({ checking: true });
    try {
      const note = String(this.data.note || '').trim();
      const payload = note ? { note } : {};
      const res = await api.call('safety.checkin', payload);
      this.setData({ checking: false });
      if (res && res.deduped) {
        // 文档 8.3.5：成功（含去重命中）都要清空备注并刷新第一页
        this.setData({ note: '' });
        wx.showToast({ title: '刚刚已经报过平安', icon: 'none', duration: 1800 });
        await this.load(true, true);
        return;
      }
      this.setData({ note: '' });
      // 先把新记录插到时间线顶部，避免刷新请求失败时看不到刚报的平安
      if (res && res.entry) {
        this.setData({ items: this.mergeItems([res.entry], this.data.items) });
      }
      haptics.light();
      wx.showToast({ title: '我到家了', icon: 'none' });
      await this.load(true, true);
    } catch (err) {
      this.setData({ checking: false });
      api.showError(err);
    }
  },
});
