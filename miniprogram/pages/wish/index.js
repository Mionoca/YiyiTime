'use strict';

const api = require('../../utils/api');
const constants = require('../../utils/constants');
const tabbar = require('../../utils/tabbar');
const format = require('../../utils/format');

const LIMITS = constants.LIMITS;

Page({
  data: {
    items: [],
    stats: { total: 0, done: 0 },
    loading: true,
    error: '',
    showEditor: false,
    editing: null,
    form: { title: '', note: '' },
    titleMax: LIMITS.wishTitle,
    noteMax: LIMITS.wishNote,
    saving: false,
    pendingId: '',
    progressText: '0/0',
    ratio: 0,
    canAdd: true,
    limitMax: LIMITS.wishCount,
  },

  onLoad() {
    this._firstShow = true;
    this.load();
  },

  onShow() {
    // 自定义 tabBar 的选中态要页面自己报（文档 8.2）
    tabbar.sync(this, constants.ROUTES.wish);
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

  onRetry() {
    this.load();
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const res = await api.call('wish.list');
      const stats = (res && res.stats) || { total: 0, done: 0 };
      this._loaded = true;
      this.setData(
        Object.assign(
          {
            items: (res && res.items) || [],
            loading: false,
            error: '',
          },
          this.statsPatch(stats)
        )
      );
    } catch (err) {
      if (silent && this.data.items.length) {
        api.showError(err);
        return;
      }
      this.setData({ loading: false, error: '愿望清单打不开了，再试一次' });
    }
  },

  /** 统计实时算（服务端返回），这里只做展示 */
  statsPatch(stats) {
    const total = (stats && stats.total) || 0;
    const done = (stats && stats.done) || 0;
    return {
      stats: { total, done },
      progressText: done + '/' + total,
      ratio: format.wishRatio(done, total),
      canAdd: total < LIMITS.wishCount,
    };
  },

  onAdd() {
    if (!this.data.canAdd) {
      wx.showToast({ title: '愿望最多存 ' + LIMITS.wishCount + ' 条', icon: 'none' });
      return;
    }
    this.setData({
      showEditor: true,
      editing: null,
      form: { title: '', note: '' },
    });
  },

  onEdit(e) {
    const wish = (e && e.detail && e.detail.wish) || null;
    if (!wish) return;
    this.setData({
      showEditor: true,
      editing: wish,
      form: { title: wish.title || '', note: wish.note || '' },
    });
  },

  onEditorClose() {
    if (this.data.saving) return;
    this.setData({ showEditor: false, editing: null, form: { title: '', note: '' } });
  },

  onTitleInput(e) {
    this.setData({ 'form.title': String((e && e.detail && e.detail.value) || '') });
  },

  onNoteInput(e) {
    this.setData({ 'form.note': String((e && e.detail && e.detail.value) || '') });
  },

  async onSaveWish() {
    if (this.data.saving) return;
    const title = String(this.data.form.title || '').trim();
    if (!title) {
      wx.showToast({ title: '先写下想做的事', icon: 'none' });
      return;
    }
    const note = String(this.data.form.note || '').trim();
    const editing = this.data.editing;
    this.setData({ saving: true });
    try {
      if (editing) {
        await api.call('wish.update', { wishId: editing.wishId, title, note });
      } else {
        await api.call('wish.add', { title, note });
      }
      this.setData({ saving: false, showEditor: false, editing: null, form: { title: '', note: '' } });
      wx.showToast({ title: editing ? '改好啦' : '记下啦', icon: 'none' });
      await this.load(true);
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  /** 打勾：显式传目标状态（文档 7.11），pendingId 防重复点 */
  async onToggle(e) {
    const detail = (e && e.detail) || {};
    const wishId = detail.wishId;
    if (!wishId || this.data.pendingId) return;
    const done = !!detail.done;
    this.setData({ pendingId: wishId });
    try {
      const res = await api.call('wish.setDone', { wishId, done });
      const items = this.data.items
        .map((item) => (item.wishId === wishId ? res.wish : item))
        .sort(this.sortWishes);
      this.setData(
        Object.assign({ items, pendingId: '' }, this.statsPatch(res.stats))
      );
    } catch (err) {
      this.setData({ pendingId: '' });
      api.showError(err);
    }
  },

  onRemove(e) {
    const wishId = (e && e.detail && e.detail.wishId) || '';
    if (!wishId || this.data.pendingId) return;
    wx.showModal({
      title: '删掉这个愿望？',
      content: '删掉就找不回来了，确定吗？',
      confirmText: '删除',
      confirmColor: '#C25B4E',
      cancelText: '留着',
      success: (res) => {
        if (res.confirm) this.removeWish(wishId);
      },
    });
  },

  async removeWish(wishId) {
    if (this.data.pendingId) return;
    this.setData({ pendingId: wishId });
    try {
      const res = await api.call('wish.remove', { wishId });
      const patch = Object.assign({ pendingId: '' }, this.statsPatch(res.stats));
      if (res.removed) {
        patch.items = this.data.items.filter((item) => item.wishId !== wishId);
        this.setData(patch);
      } else {
        this.setData(patch);
        await this.load(true);
      }
    } catch (err) {
      this.setData({ pendingId: '' });
      api.showError(err);
    }
  },

  /** 与服务端一致的排序：未完成在前（createdAt 升序），完成在后（doneAt 降序） */
  sortWishes(a, b) {
    if (!!a.done !== !!b.done) return a.done ? 1 : -1;
    if (!a.done) {
      const am = new Date(a.createdAt).getTime() || 0;
      const bm = new Date(b.createdAt).getTime() || 0;
      return am - bm;
    }
    const am = new Date(a.doneAt || a.createdAt).getTime() || 0;
    const bm = new Date(b.doneAt || b.createdAt).getTime() || 0;
    return bm - am;
  },
});
