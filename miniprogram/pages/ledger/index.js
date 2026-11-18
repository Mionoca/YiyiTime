'use strict';

/**
 * 记账本（文档 8.3.8）：个人账本，可切换到对方账本只读。
 * - 月份只认服务端返回的 month / todayKey（「能不能往后翻」不用设备时钟判断）；
 * - 金额全程以「分」传输，输入框里是「元」，只在 format.parseYuan / formatYuan 里换算；
 * - 只有自己的条目能点开编辑 / 删除，对方的条目只读（服务端也会再拒一次）。
 */
const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const format = require('../../utils/format');
const tabbar = require('../../utils/tabbar');

const LIMITS = constants.LIMITS;
/**
 * 金额输入框的字符上限跟着服务端上限走：整数部分位数 + 小数点 + 两位小数。
 * 硬编码 10 的话，等 5.3.9 的 1,000,000 分（10,000 元）一变就会「能输入但提交被拒」。
 */
const AMOUNT_MAX_LENGTH = String(Math.floor(LIMITS.ledgerAmountMax / 100)).length + 3;
const LIST_ERROR_TEXT = '加载失败，点重试';
const EMPTY_ERROR_TEXT = '账本打不开，再试一次';

const CATEGORY_BY_KEY = {};
constants.LEDGER_CATEGORIES.forEach((item) => {
  CATEGORY_BY_KEY[item.key] = item;
});

function categoryOf(key) {
  return CATEGORY_BY_KEY[key] || { key: 'other', label: '其他', emoji: '📦' };
}

/** 分 → 输入框里的元（12.00 / 0.50），供编辑回填 */
function centsToText(cents) {
  const n = typeof cents === 'number' && isFinite(cents) ? Math.max(0, Math.round(cents)) : 0;
  return (n / 100).toFixed(2);
}

Page({
  data: {
    who: 'me',
    // 未绑定时只有「我的」这一本，也不显示 TA 的分段（文档 8.3.8）
    bound: true,
    partnerName: 'TA',
    summaryLabel: '我这个月花了',
    month: '',
    monthText: '',
    canGoNext: false,
    loading: true,
    error: '',
    listError: '',
    groups: [],
    summaryText: '¥0.00',
    summaryCount: 0,
    todayKey: '',
    maxDate: '',
    categories: constants.LEDGER_CATEGORIES,
    noteMax: LIMITS.ledgerNote,
    // 金额输入框的字符上限由 LIMITS.ledgerAmountMax 推导（当前 8：10000.00）
    amountMaxLength: AMOUNT_MAX_LENGTH,
    formOpen: false,
    editing: false,
    saving: false,
    form: { entryId: '', amountText: '', category: 'food', note: '', date: '' },
  },

  onLoad() {
    this._firstShow = true;
    this.load();
  },

  onShow() {
    // 自定义 tabBar 的选中态要页面自己报（文档 8.2）
    tabbar.sync(this, constants.ROUTES.ledger);
    // onLoad 已经拉过一次；之后从别的页面回来静默刷新，保留列表不闪 loading（10.3）
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
    // 请求可能还在路上：卸载后不再 setData
    this._unloaded = true;
  },

  onRetry() {
    this.load(false, true);
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  /** 读屏用的一句话：日期 + 每笔「分类 备注 金额」 */
  decorate(items, todayKey) {
    const yesterdayKey = timeUtil.shiftDateKey(todayKey, -1);
    const groups = [];
    const index = {};
    const mine = this.data.who === 'me';

    (items || []).forEach((item) => {
      if (!item || !item.entryId) return;
      const meta = categoryOf(item.category);
      const amount = typeof item.amount === 'number' ? item.amount : 0;
      const row = {
        entryId: item.entryId,
        emoji: meta.emoji,
        categoryLabel: meta.label,
        category: meta.key,
        note: String(item.note || ''),
        amountText: format.formatYuan(amount),
        amount,
        date: item.date || '',
        mine,
        a11y: meta.label + (item.note ? ' ' + item.note : '') + ' ' + format.formatYuan(amount),
      };
      if (!index[item.date]) {
        index[item.date] = {
          date: item.date,
          label: item.date === todayKey
            ? '今天'
            : (item.date === yesterdayKey ? '昨天' : timeUtil.formatMonthDay(item.date)),
          items: [],
          total: 0,
          totalText: '¥0.00',
          a11y: '',
        };
        groups.push(index[item.date]);
      }
      index[item.date].items.push(row);
      index[item.date].total += amount;
    });

    groups.forEach((group) => {
      group.totalText = format.formatYuan(group.total);
      group.a11y = group.label + ' 共 ' + group.items.length + ' 笔 ' + group.totalText;
    });
    return groups;
  },

  /**
   * 拉当月账本。silent=保留旧列表静默刷新；force=丢弃在途请求的结果（切人 / 切月 / 写后）。
   * 同一时刻只保留一个在途请求：下拉刷新手势容易连发，重复请求既浪费也会让列表闪。
   */
  load(silent, force) {
    if (this.loadingPromise && !force) return this.loadingPromise;
    // 请求令牌：切人 / 切月都是新请求，旧响应不能覆盖新月份的列表
    const token = (this._seq = (this._seq || 0) + 1);
    const stale = () => this._unloaded || token !== this._seq;
    if (!silent) this.setData({ loading: true, error: '', listError: '' });

    const promise = (async () => {
      try {
        const payload = { who: this.data.who };
        if (this.data.month) payload.month = this.data.month;
        const res = await api.call('ledger.list', payload);
        if (stale()) return;

        const todayKey = (res && res.todayKey) || timeUtil.todayKey();
        const currentMonth = timeUtil.monthOf(todayKey) || String(todayKey).slice(0, 7);
        this._currentMonth = currentMonth;
        const month = (res && res.month) || currentMonth;
        const summary = (res && res.summary) || {};
        const partnerName = (res && res.partner && res.partner.nickname) || 'TA';
        // 未绑定（还没住进来 / 已经解绑）时只给自己的账本，不留一个点不动的「TA 的」
        const bound = res && res.bound !== undefined ? !!res.bound : true;

        this._loaded = true;
        this.setData({
          loading: false,
          error: '',
          listError: '',
          todayKey,
          maxDate: todayKey,
          bound,
          who: bound ? this.data.who : 'me',
          month,
          monthText: timeUtil.formatMonthCN(month),
          canGoNext: month < currentMonth,
          partnerName,
          summaryLabel: this.data.who === 'me' ? '我这个月花了' : partnerName + '这个月花了',
          summaryText: format.formatYuan(summary.total || 0),
          summaryCount: summary.count || 0,
          groups: this.decorate((res && res.items) || [], todayKey),
        });
      } catch (err) {
        if (stale()) return;
        if (err && err.code === 'NOT_BOUND') {
          // 「TA 的账本」要先绑定：回到自己的账本，不让用户卡在一个空页面上
          this.setData({ loading: false, error: '', listError: '', bound: false, who: 'me' });
          api.showError(err);
          // 等这次「回到我的账本」也完成，页面状态才是确定的（不发出去会留下一个中间态）
          return this.load(false, true);
        }
        if (silent && this.data.groups.length) {
          // 静默刷新失败：保留已加载内容，底部给可点的重试（12.9）
          this.setData({ loading: false, listError: LIST_ERROR_TEXT });
          api.showError(err);
          return;
        }
        this.setData({ loading: false, error: EMPTY_ERROR_TEXT, listError: '' });
      } finally {
        if (this.loadingPromise === promise) this.loadingPromise = null;
      }
    })();

    this.loadingPromise = promise;
    return promise;
  },

  /** 底部「加载失败，点重试」：连点复用同一次请求 */
  onRetryList() {
    if (this._retryingList) return this._retryingList;
    const run = this.load(this.data.groups.length ? true : false, true);
    this._retryingList = run;
    const clear = () => {
      this._retryingList = null;
    };
    run.then(clear, clear);
    return run;
  },

  /** 我的 / TA 的 */
  onSwitchWho(e) {
    const who = (e && e.currentTarget && e.currentTarget.dataset.who) === 'partner' ? 'partner' : 'me';
    if (who === this.data.who) return;
    // 正在保存时不切，避免表单和账本错位
    if (this.data.saving) return;
    // 先清列表：两本账不能拼在一起看；开着的表单属于上一本账，一并关掉
    this.setData({
      who,
      groups: [],
      summaryText: '¥0.00',
      summaryCount: 0,
      summaryLabel: who === 'me' ? '我这个月花了' : this.data.partnerName + '这个月花了',
      listError: '',
      formOpen: false,
      editing: false,
    });
    this.load(false, true);
  },

  /** 只改月份本身：合计与翻页态立刻重置，不等请求回来（失败时也不会卡在上个月翻不回来） */
  applyMonth(month) {
    this.setData({
      month,
      monthText: timeUtil.formatMonthCN(month),
      canGoNext: !!this._currentMonth && month < this._currentMonth,
      groups: [],
      summaryText: '¥0.00',
      summaryCount: 0,
      listError: '',
    });
  },

  onPrevMonth() {
    const prev = timeUtil.shiftMonthKey(this.data.month, -1);
    // 服务端只收 2000-01 之后，翻更早没有意义（与 5.3.9 的日期下界一致）
    if (!prev || prev < '2000-01') return;
    this.applyMonth(prev);
    this.load(false, true);
  },

  onNextMonth() {
    if (!this.data.canGoNext) return;
    const next = timeUtil.shiftMonthKey(this.data.month, 1);
    if (!next || next > this._currentMonth) return;
    this.applyMonth(next);
    this.load(false, true);
  },

  findEntry(entryId) {
    const groups = this.data.groups || [];
    for (let i = 0; i < groups.length; i += 1) {
      const hit = groups[i].items.find((item) => item.entryId === entryId);
      if (hit) return hit;
    }
    return null;
  },

  onTapEntry(e) {
    const entryId = e && e.currentTarget && e.currentTarget.dataset.id;
    const row = this.findEntry(entryId);
    if (!row) return;
    if (!row.mine) {
      this.toast('TA 的账本只能看');
      return;
    }
    this.setData({
      formOpen: true,
      editing: true,
      form: {
        entryId: row.entryId,
        amountText: centsToText(row.amount),
        category: row.category,
        note: row.note,
        date: row.date,
      },
    });
  },

  onOpenForm() {
    if (this.data.saving) return;
    // 按钮已经在 TA 视角隐藏，这里再兜一层（写接口只认自己的 openid，写进去也看不见）
    if (this.data.who !== 'me') {
      this.toast('先切回「我的」再记');
      return;
    }
    this.setData({
      formOpen: true,
      editing: false,
      form: {
        entryId: '',
        amountText: '',
        category: 'food',
        note: '',
        date: this.data.todayKey || timeUtil.todayKey(),
      },
    });
  },

  onCloseForm() {
    if (this.data.saving) return;
    this.setData({ formOpen: false });
  },

  onAmountInput(e) {
    this.setData({ 'form.amountText': (e && e.detail && e.detail.value) || '' });
  },

  onNoteInput(e) {
    this.setData({ 'form.note': (e && e.detail && e.detail.value) || '' });
  },

  onPickCategory(e) {
    const key = e && e.currentTarget && e.currentTarget.dataset.key;
    if (!CATEGORY_BY_KEY[key]) return;
    this.setData({ 'form.category': key });
  },

  onDateChange(e) {
    const value = String((e && e.detail && e.detail.value) || '');
    if (!value) return;
    if (value < '2000-01-01' || (this.data.todayKey && value > this.data.todayKey)) return;
    this.setData({ 'form.date': value });
  },

  async onSaveEntry() {
    if (this.data.saving) return;
    const form = this.data.form;
    const cents = format.parseYuan(form.amountText);
    if (cents === null || cents < LIMITS.ledgerAmountMin) {
      this.toast('先填个金额吧，最多两位小数');
      return;
    }
    if (cents > LIMITS.ledgerAmountMax) {
      this.toast('金额太大啦，单笔最多 10000 元');
      return;
    }
    const note = String(form.note || '').trim();
    if (note.length > LIMITS.ledgerNote) {
      this.toast('备注最多 ' + LIMITS.ledgerNote + ' 字');
      return;
    }
    if (!form.date) {
      this.toast('选个日期吧');
      return;
    }
    // 与服务端同一条边界（2000-01-01 至今天），本地先拦，不把明显不对的日期发出去
    if (form.date < '2000-01-01') {
      this.toast('日期太早啦，从 2000 年开始记吧');
      return;
    }
    if (this.data.todayKey && form.date > this.data.todayKey) {
      this.toast('还没到那天呢');
      return;
    }

    const editing = !!form.entryId;
    this.setData({ saving: true });
    try {
      if (editing) {
        await api.call('ledger.update', {
          entryId: form.entryId, amount: cents, category: form.category, note, date: form.date,
        });
      } else {
        await api.call('ledger.add', {
          amount: cents, category: form.category, note, date: form.date,
        });
      }
      if (this._unloaded) return;
      // 记到别的月份时跳到那个月，否则用户看不到刚记的那一笔
      const month = timeUtil.monthOf(form.date);
      const patch = { saving: false, formOpen: false };
      if (!editing && this.data.who !== 'me') {
        // 新账永远记在「我的」下面：切回来，否则刷新后看不见刚记的那笔
        patch.who = 'me';
        patch.summaryLabel = '我这个月花了';
      }
      if (!editing && month && month !== this.data.month) {
        patch.month = month;
        patch.monthText = timeUtil.formatMonthCN(month);
        patch.canGoNext = month < (this._currentMonth || month);
        // 换月份就不能留着旧分组与合计（静默刷新失败时会出现「标题 9 月、列表 11 月」）
        patch.groups = [];
        patch.summaryText = '¥0.00';
        patch.summaryCount = 0;
      }
      this.setData(patch);
      this.toast(editing ? '改好啦' : '记下啦');
      await this.load(true, true);
    } catch (err) {
      if (this._unloaded) return;
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  onDeleteEntry() {
    const entryId = this.data.form.entryId;
    if (!entryId || this.data.saving) return;
    wx.showModal({
      title: '删掉这笔？',
      content: '删掉就找不回来了。',
      confirmText: '删',
      cancelText: '留着',
      success: (res) => {
        // 弹窗期间页面可能已经退出：卸载后不再发请求
        if (this._unloaded) return;
        if (res.confirm) this.removeEntry(entryId);
      },
    });
  },

  async removeEntry(entryId) {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      await api.call('ledger.remove', { entryId });
      if (this._unloaded) return;
      this.setData({ saving: false, formOpen: false });
      this.toast('删掉啦');
      await this.load(true, true);
    } catch (err) {
      if (this._unloaded) return;
      this.setData({ saving: false });
      api.showError(err);
    }
  },
});
