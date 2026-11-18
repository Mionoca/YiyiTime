'use strict';

/**
 * 纪念日管理（文档 8.3.9 / 7.7）。
 *
 * 只做增 / 改 / 删：展示与切换都在首页的卡片堆叠里（9.4）。
 * 剩余天数与周年一律用服务端返回的 daysLeft / years，客户端不自己算日期（1.5）。
 */
const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');

const LIMITS = constants.LIMITS;
const MIN_DATE = '2000-01-01';
const MAX_DATE = '2099-12-31';
const LIST_ERROR_TEXT = '加载失败，点重试';
const EMPTY_ERROR_TEXT = '纪念日打不开，再试一次';

Page({
  data: {
    items: [],
    todayKey: '',
    loading: true,
    error: '',
    listError: '',
    canAdd: true,
    maxCount: LIMITS.anniversaryCount,
    titleMax: LIMITS.anniversaryTitle,
    minDate: MIN_DATE,
    maxDate: MAX_DATE,
    formOpen: false,
    editing: false,
    saving: false,
    form: { anniversaryId: '', title: '', date: '' },
  },

  onLoad() {
    this._firstShow = true;
    this.load();
  },

  onShow() {
    // onLoad 已经拉过一次；之后（例如从别的页面回来）静默刷新，保留列表不闪 loading（10.3）
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

  onUnload() {
    this._unloaded = true;
  },

  onRetry() {
    this.load();
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  /** 服务端 items → 列表行（日期文案在这里拼，WXML 里不做计算） */
  rowsOf(items) {
    return (items || []).map((item) => ({
      anniversaryId: item.anniversaryId,
      title: item.title || '纪念日',
      dateText: item.nextDate ? timeUtil.formatDateCN(item.nextDate) : '日期没算好',
      daysText: item.daysLeft === 0
        ? '就是今天'
        : (typeof item.daysLeft === 'number' ? '还有 ' + item.daysLeft + ' 天' : ''),
      metaText: item.years ? '第 ' + item.years + ' 个' : '',
    }));
  },

  applyItems(items) {
    const list = items || [];
    // 原始记录留一份（不进 data）：编辑时要回填「原始 date」，而列表行里是「下一次」的日期
    this._rawById = {};
    list.forEach((item) => {
      this._rawById[item.anniversaryId] = item;
    });
    this._loaded = true;
    this.setData({
      items: this.rowsOf(list),
      loading: false,
      error: '',
      listError: '',
      canAdd: list.length < LIMITS.anniversaryCount,
    });
  },

  async load(silent) {
    if (!silent) this.setData({ loading: true, error: '' });
    try {
      const res = await api.call('anniversary.list');
      if (this._unloaded) return;
      this.setData({ todayKey: (res && res.todayKey) || '' });
      this.applyItems(res && res.items);
    } catch (err) {
      if (this._unloaded) return;
      if (silent && this.data.items.length) {
        // 12.9：刷新失败保留已加载列表，底部给一个持久的重试入口
        this.setData({ listError: LIST_ERROR_TEXT });
        return;
      }
      this.setData({ loading: false, error: EMPTY_ERROR_TEXT });
    }
  },

  onRetryList() {
    this.setData({ listError: '' });
    this.load(true);
  },

  onAdd() {
    if (!this.data.canAdd) {
      this.toast('纪念日最多记 ' + LIMITS.anniversaryCount + ' 个');
      return;
    }
    this.setData({
      formOpen: true,
      editing: false,
      form: { anniversaryId: '', title: '', date: this.data.todayKey || '' },
    });
  },

  onEdit(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const id = dataset.id || '';
    const item = (this.data.items || []).find((row) => row.anniversaryId === id);
    if (!item) return;
    // 编辑时把日期还原成原始 date：列表里显示的是「下一次」的日期，
    // 拿它回填会把「第一次见面 2023-06-01」悄悄改成 2027-06-01。
    const raw = (this._rawById && this._rawById[id]) || {};
    this.setData({
      formOpen: true,
      editing: true,
      form: {
        anniversaryId: id,
        title: item.title,
        date: raw.date || this.data.todayKey || '',
      },
    });
  },

  onCloseForm() {
    if (this.data.saving) return;
    this.setData({ formOpen: false, editing: false });
  },

  onTitleInput(e) {
    this.setData({ 'form.title': String((e && e.detail && e.detail.value) || '') });
  },

  onDateChange(e) {
    const value = String((e && e.detail && e.detail.value) || '');
    if (!value) return;
    this.setData({ 'form.date': value });
  },

  async onSave() {
    if (this.data.saving) return;
    const form = this.data.form;
    const title = String(form.title || '').trim();
    if (!title) {
      this.toast('给它起个名字吧');
      return;
    }
    if (!form.date) {
      this.toast('选一个日子吧');
      return;
    }

    this.setData({ saving: true });
    const editing = this.data.editing;
    try {
      const payload = editing
        ? { anniversaryId: form.anniversaryId, title, date: form.date }
        : { title, date: form.date };
      const res = await api.call(editing ? 'anniversary.update' : 'anniversary.add', payload);
      if (this._unloaded) return;
      this.setData({ saving: false, formOpen: false, editing: false });
      this.applyItems(res && res.items);
      this.toast(editing ? '改好啦' : '记下啦');
    } catch (err) {
      if (this._unloaded) return;
      this.setData({ saving: false });
      // 失败保留弹层与输入：让用户改一句再试，不要清空
      api.showError(err);
    }
  },

  async onDelete(e) {
    const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
    const id = dataset.id || '';
    if (!id || this.data.saving) return;
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: '删掉这个纪念日？',
        content: '删掉就找不回来了，你们都能看到它消失。',
        confirmText: '删掉',
        cancelText: '再想想',
        confirmColor: '#B23A2E',
        success: (res) => resolve(!!res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;

    this.setData({ saving: true });
    try {
      const res = await api.call('anniversary.remove', { anniversaryId: id });
      if (this._unloaded) return;
      this.setData({ saving: false });
      this.applyItems(res && res.items);
      this.toast(res && res.removed ? '删掉啦' : '它已经不在了');
    } catch (err) {
      if (this._unloaded) return;
      this.setData({ saving: false });
      api.showError(err);
    }
  },
});
