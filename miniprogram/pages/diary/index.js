'use strict';

const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');

const PAGE_SIZE = 10;
const CONTENT_MAX = constants.LIMITS.diary;

Page({
  data: {
    items: [],
    todayKey: '',
    content: '',
    contentMax: CONTENT_MAX,
    canSave: false,
    saving: false,
    loading: true,
    loadingMore: false,
    hasMore: false,
    error: '',
  },

  onLoad() {
    this._firstShow = true;
    this.load();
  },

  onShow() {
    // onLoad 已经拉过第一页，首屏不重复请求；之后每次回到页面刷新第一页（文档 10.7 跨天重拉）
    if (this._firstShow) {
      this._firstShow = false;
      return;
    }
    if (this._loaded) this.load(true);
  },

  onPullDownRefresh() {
    // 文档 L637：子页支持下拉刷新；静默刷新保留旧列表，成功失败都收起转圈
    const stop = () => wx.stopPullDownRefresh();
    this.load(true).then(stop, stop);
  },

  onReachBottom() {
    this.loadMore();
  },

  onRetry() {
    this.load();
  },

  onContentInput(e) {
    const content = String((e && e.detail && e.detail.value) || '');
    this.setData({ content, canSave: !!content.trim() });
  },

  async load(silent) {
    if (this._loadingList && !silent) return;
    if (!silent) this.setData({ loading: true, error: '' });
    this._loadingList = true;
    try {
      const res = await api.call('diary.list', { limit: PAGE_SIZE });
      const items = (res && res.items) || [];
      this._beforeDate = (res && res.nextBeforeDate) || '';
      // 文档 1.5 / 10.9：今天是哪天由服务端给；设备改时间不能影响跨天判断
      const todayKey = (res && res.todayKey) || timeUtil.todayKey();
      const today = items.filter((item) => item.date === todayKey)[0] || null;
      // 跨天（文档 10.7 跨天重拉）：编辑器要按新的一天重新初始化，否则昨晚草稿会被存成今天的日记
      const dayChanged = !!this.data.todayKey && this.data.todayKey !== todayKey;
      const hadDraft = !!String(this.data.content || '').trim();
      if (dayChanged) this._draftInited = false;
      const patch = {
        items,
        todayKey,
        hasMore: !!this._beforeDate,
        loading: false,
        loadingMore: false,
        error: '',
      };
      // 首次加载把今天已写的内容带进编辑器，方便改；之后静默刷新不覆盖用户正在打的草稿
      if (!this._draftInited) {
        this._draftInited = true;
        patch.content = today && today.mine ? today.mine.content : '';
        patch.canSave = !!String(patch.content).trim();
      }
      this._loaded = true;
      this.setData(patch);
      if (dayChanged && hadDraft) {
        wx.showToast({ title: '新的一天了，昨晚的草稿没保存', icon: 'none', duration: 2500 });
      }
    } catch (err) {
      if (silent && this.data.items.length) {
        api.showError(err);
      } else {
        this.setData({ loading: false, error: '台灯好像没插好，再试一次' });
      }
    } finally {
      this._loadingList = false;
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this._beforeDate) return;
    this.setData({ loadingMore: true });
    try {
      const res = await api.call('diary.list', {
        beforeDate: this._beforeDate,
        limit: PAGE_SIZE,
      });
      const items = (res && res.items) || [];
      this._beforeDate = (res && res.nextBeforeDate) || '';
      this.setData({
        items: this.data.items.concat(items),
        hasMore: !!this._beforeDate,
        loadingMore: false,
      });
    } catch (err) {
      // 加载更多失败只 toast，不丢已有列表（文档 8.3.3）
      this.setData({ loadingMore: false });
      api.showError(err);
    }
  },

  async onSave() {
    if (this.data.saving) return;
    const content = String(this.data.content || '').trim();
    if (!content) {
      wx.showToast({ title: '先写一句吧', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await api.call('diary.save', { content: this.data.content });
      const diary = (res && res.diary) || null;
      if (diary) this.applyTodayDiary(diary);
      this.setData({ saving: false });
      wx.showToast({ title: '明天 TA 才能看到', icon: 'none', duration: 2000 });
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  /** 保存成功先把今天这张卡片改成最新内容，列表顺序保持按日期倒序 */
  applyTodayDiary(diary) {
    const items = this.data.items.slice();
    // 用列表接口下发的服务端日期，取不到时退回这条日记自己的日期
    const todayKey = this.data.todayKey || diary.date;
    const index = items.findIndex((item) => item.date === diary.date);
    const mine = { content: diary.content, updatedAt: diary.updatedAt };
    if (index >= 0) {
      items[index] = Object.assign({}, items[index], {
        date: diary.date,
        unlockAt: diary.unlockAt,
        mine,
      });
    } else {
      items.push({
        date: diary.date,
        unlockAt: diary.unlockAt,
        mine,
        partnerWritten: false,
        partnerUnlocked: false,
        partner: null,
      });
      items.sort((a, b) => (a.date < b.date ? 1 : -1));
    }
    this.setData({ items, todayKey: todayKey || diary.date });
  },
});
