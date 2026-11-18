'use strict';

/**
 * 一起变好（文档 F14 / 8.3.10 / 7.18）。
 *
 * 一句话说明它是什么：**两个人一起做一件小事的任务池**。起草 → 对方认领 →
 * 分工（我的 / TA 的）→ 完成后各写一段收获 → 双写自动归档进成长日志；
 * 任意阶段可以「复盘」体面收尾。
 *
 * 客户端不判断「谁起草的该干什么」，只按服务端给的 `createdByMe` 与 `status`
 * 渲染动作矩阵；视角映射（myPart / partnerPart）也由服务端算好，页面直接展示。
 *
 * 订阅提醒（文档 7.18 末节）：只在**动作完成的正反馈时刻**问一次——
 * 认领 / 标记完成 / 写收获成功后，若自己的任务额度 < 2 且模板已配，
 * 才 `wx.requestSubscribeMessage` → `reminder.grant({ template: 'task' })`。
 * 不在设置页放开关（没人会主动开），被拒绝后本次会话内不再问。
 */

const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');

const LIMITS = constants.LIMITS;
const CATEGORIES = constants.GROWTH_CATEGORIES;
const CATEGORY_BY_KEY = {};
CATEGORIES.forEach((item) => {
  CATEGORY_BY_KEY[item.key] = item;
});

const SEG_POOL = 'pool';
const SEG_LOG = 'log';
/** 成长日志分页大小（服务端上限 20） */
const LOG_PAGE = 10;
/** 额度低于这个数才值得再问一次授权（每问一次只换一条额度，问太勤很烦） */
const SUB_ASK_BELOW = 2;

const EMPTY_FORM = { taskId: '', title: '', category: 'learn', myPart: '', partnerPart: '', note: '' };

function categoryOf(key) {
  return CATEGORY_BY_KEY[key] || CATEGORY_BY_KEY.other;
}

/**
 * 任务 → 视图（动作矩阵见文档 8.3.10）。
 * `canXxx` 全部在这里算好，wxml 不做逻辑判断——同首页 derive 的约定。
 */
function decorateTask(task) {
  const meta = categoryOf(task.category);
  const confirming = task.status === 'confirming';
  const active = task.status === 'active';
  const harvesting = task.status === 'harvesting';
  const mine = !!task.createdByMe;
  let statusText = '';
  if (confirming) statusText = mine ? '等 TA 认领' : '等你认领';
  else if (active) statusText = '进行中';
  else if (harvesting) statusText = '写收获';

  return Object.assign({}, task, {
    emoji: meta.emoji,
    categoryLabel: meta.label,
    statusText,
    canConfirm: confirming && !mine,
    // 自己起草的「待认领」也能删（反悔了），所以 canRemove 与 canConfirm 分开
    canEdit: confirming || active,
    canRemove: confirming || active || harvesting,
    canDone: active,
    canHarvest: harvesting,
    canReview: confirming || active || harvesting,
    harvestHint: harvesting
      ? (task.myHarvestWritten ? '等 TA 写完就归档' : '写一句你做到了什么')
      : '',
    a11y: (meta.label + ' ' + (task.title || '') + ' ' + statusText
      + (task.myPart ? ' 我的部分 ' + task.myPart : '')
      + (task.partnerPart ? ' TA 的部分 ' + task.partnerPart : '')).trim(),
  });
}

/** 成长日志 → 按月分组（分组在客户端做，同账本页先例） */
function decorateLogEntry(entry) {
  const meta = categoryOf(entry.category);
  const key = timeUtil.dateKeyOf(new Date(entry.archivedAt));
  const done = entry.archivedType !== 'reviewed';
  let partnerText = '';
  let partnerHint = '';
  if (entry.partnerText) partnerText = entry.partnerText;
  else if (entry.partnerWritten) partnerHint = 'TA 写了，你写完就能看';
  else partnerHint = 'TA 还没写';
  return Object.assign({}, entry, {
    emoji: meta.emoji,
    categoryLabel: meta.label,
    chipText: done ? '一起完成' : '复盘收尾',
    dateText: timeUtil.formatMonthDay(key),
    month: key.slice(0, 7),
    myText: entry.myText || '',
    partnerText,
    partnerHint: partnerText ? '' : partnerHint,
    a11y: (entry.title || '') + ' ' + (done ? '一起完成' : '复盘收尾')
      + (entry.myText ? ' 我写的 ' + entry.myText : '')
      + (partnerText ? ' TA 写的 ' + partnerText : ''),
  });
}

function groupLogs(items) {
  const groups = [];
  const index = {};
  (items || []).forEach((entry) => {
    const row = decorateLogEntry(entry);
    if (!index[row.month]) {
      index[row.month] = { month: row.month, label: timeUtil.formatMonthCN(row.month), items: [] };
      groups.push(index[row.month]);
    }
    index[row.month].items.push(row);
  });
  return groups;
}

Page({
  data: {
    seg: SEG_POOL,
    loading: true,
    error: '',
    listError: '',
    items: [],
    stats: { inFlight: 0, awaitingConfirm: 0, archivedCount: 0 },
    inFlightMax: LIMITS.growthInFlight,

    logLoading: false,
    logError: '',
    logGroups: [],
    logLoaded: false,
    nextCursor: null,
    hasMore: false,

    // 起草 / 编辑弹层
    formOpen: false,
    editing: false,
    saving: false,
    form: Object.assign({}, EMPTY_FORM),
    categories: CATEGORIES,
    titleMax: LIMITS.growthTitle,
    partMax: LIMITS.growthPart,
    noteMax: LIMITS.growthNote,

    // 写收获 / 复盘弹层
    textOpen: false,
    textMode: 'harvest',
    textTaskId: '',
    text: '',
    textMax: LIMITS.growthText,
    textSaving: false,

    // 订阅提醒（文档 7.18）：自己攒的任务额度与模板
    subConfigured: false,
    subQuota: 0,
    subTemplateId: '',
  },

  onLoad() {
    this._firstShow = true;
    // 本次会话是否已经问过授权（拒绝后不再问，避免每次动作都弹）
    this._subAsked = false;
    this.load();
  },

  onShow() {
    // onLoad 已经拉过一次；从别处回来静默刷新，保留列表不闪 loading（10.3）
    if (this._firstShow) {
      this._firstShow = false;
      return;
    }
    if (this._loaded) this.load(true);
  },

  onUnload() {
    this._unloaded = true;
  },

  onPullDownRefresh() {
    const stop = () => wx.stopPullDownRefresh();
    if (this.data.seg === SEG_LOG) this.loadLog(false, true).then(stop, stop);
    else this.load(true).then(stop, stop);
  },

  onRetry() {
    this.load(false, true);
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  /** 列表 + 订阅额度一次拿回（服务端 growth.list 顺带返回 sub* 字段） */
  load(silent, force) {
    if (this.loadingPromise && !force) return this.loadingPromise;
    const token = (this._seq = (this._seq || 0) + 1);
    const stale = () => this._unloaded || token !== this._seq;
    if (!silent) this.setData({ loading: true, error: '', listError: '' });

    const promise = (async () => {
      try {
        const res = await api.call('growth.list');
        if (stale()) return;
        const items = ((res && res.items) || []).map(decorateTask);
        this._loaded = true;
        this.loadingPromise = null;
        this.setData({
          items,
          stats: (res && res.stats) || { inFlight: items.length, awaitingConfirm: 0, archivedCount: 0 },
          loading: false,
          error: '',
          listError: '',
          subConfigured: !!(res && res.subConfigured),
          subQuota: (res && res.subQuota) || 0,
          subTemplateId: (res && res.subTemplateId) || '',
        });
      } catch (err) {
        if (stale()) return;
        this.loadingPromise = null;
        if (err && err.code === 'NOT_BOUND') {
          // 未绑定（解绑后回到这里）：入口本来不该出现，兜底提示并退回去
          this.setData({ loading: false, error: '', listError: '' });
          api.showError(err);
          wx.navigateBack({ delta: 1 });
          return;
        }
        if (silent && this.data.items.length) {
          this.setData({ listError: '没刷新成功，点这里重试' });
          api.showError(err);
          return;
        }
        this.setData({ loading: false, error: '这件事的清单打不开，再试一次' });
      }
    })();

    this.loadingPromise = promise;
    return promise;
  },

  onRetryList() {
    this.load(true, true);
  },

  // ── 分段 ────────────────────────────────────────────────────────────────

  onSwitchSeg(e) {
    const seg = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.seg) || SEG_POOL;
    if (seg !== SEG_POOL && seg !== SEG_LOG) return;
    if (seg === this.data.seg) return;
    this.setData({ seg });
    // 日志第一次进来才拉；之后切回来用缓存，下拉刷新才更新
    if (seg === SEG_LOG && !this.data.logLoaded) this.loadLog(true);
  },

  /** 成长日志：reset=true 从第一页开始（切换 / 写完收获 / 下拉刷新） */
  loadLog(reset, force) {
    if (this.data.logLoading && !force) return Promise.resolve();
    const cursor = reset ? '' : this.data.nextCursor;
    if (!reset && !cursor) return Promise.resolve();
    const token = (this._logSeq = (this._logSeq || 0) + 1);
    const stale = () => this._unloaded || token !== this._logSeq;
    this.setData({ logLoading: true, logError: '' });

    return (async () => {
      try {
        const payload = { limit: LOG_PAGE };
        if (cursor) payload.cursor = cursor;
        const res = await api.call('growth.log', payload);
        if (stale()) return;
        const incoming = (res && res.items) || [];
        const merged = reset ? incoming : this._rawLogs.concat(incoming);
        this._rawLogs = merged;
        this.setData({
          logGroups: groupLogs(merged),
          logLoaded: true,
          logLoading: false,
          logError: '',
          nextCursor: (res && res.nextCursor) || null,
          hasMore: !!(res && res.nextCursor),
        });
      } catch (err) {
        if (stale()) return;
        this.setData({ logLoading: false, logError: '成长日志打不开，再试一次' });
        if (!this.data.logLoaded) api.showError(err);
      }
    })();
  },

  onRetryLog() {
    this.loadLog(!this.data.logLoaded, true);
  },

  onLoadMore() {
    if (!this.data.hasMore || this.data.logLoading) return;
    this.loadLog(false);
  },

  // ── 起草 / 编辑 ─────────────────────────────────────────────────────────

  onAdd() {
    if (this.data.stats.inFlight >= LIMITS.growthInFlight) {
      this.toast('先把眼前的几件事做完吧');
      return;
    }
    this.setData({
      formOpen: true,
      editing: false,
      form: Object.assign({}, EMPTY_FORM),
    });
  },

  onEdit(e) {
    const task = (e && e.detail && e.detail.task) || null;
    if (!task) return;
    this.setData({
      formOpen: true,
      editing: true,
      form: {
        taskId: task.taskId,
        title: task.title || '',
        category: task.category || 'other',
        myPart: task.myPart || '',
        partnerPart: task.partnerPart || '',
        note: task.note || '',
      },
    });
  },

  onFormClose() {
    if (this.data.saving) return;
    this.setData({ formOpen: false, form: Object.assign({}, EMPTY_FORM) });
  },

  onFormInput(e) {
    const field = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.field) || '';
    if (!field) return;
    const value = String((e && e.detail && e.detail.value) || '');
    this.setData({ ['form.' + field]: value });
  },

  onPickCategory(e) {
    const key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || '';
    if (!key || !CATEGORY_BY_KEY[key]) return;
    this.setData({ 'form.category': key });
  },

  async onSubmit() {
    if (this.data.saving) return;
    const form = this.data.form;
    const title = String(form.title || '').trim();
    if (!title) {
      this.toast('给这件事起个名字');
      return;
    }
    this.setData({ saving: true });
    const payload = {
      title,
      category: form.category,
      myPart: String(form.myPart || '').trim(),
      partnerPart: String(form.partnerPart || '').trim(),
      note: String(form.note || '').trim(),
    };
    try {
      if (this.data.editing) {
        payload.taskId = form.taskId;
        await api.call('growth.update', payload);
      } else {
        await api.call('growth.add', payload);
      }
      this.setData({ saving: false, formOpen: false, form: Object.assign({}, EMPTY_FORM) });
      this.toast(this.data.editing ? '改好了' : '起草好了，等 TA 认领');
      await this.load(true, true);
      if (this.data.logLoaded) this.loadLog(true, true);
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  // ── 认领 / 完成 / 收获 / 复盘 / 删除 ────────────────────────────────────

  async onConfirm(e) {
    const task = (e && e.detail && e.detail.task) || null;
    if (!task || this.data.saving) return;
    this.setData({ saving: true });
    try {
      await api.call('growth.confirm', { taskId: task.taskId });
      this.setData({ saving: false });
      this.toast('你们一起开始了');
      await this.load(true, true);
      // 正反馈时刻顺手问一次授权（文档 7.18）
      this.maybeAskTaskSubscribe();
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  async onDone(e) {
    const task = (e && e.detail && e.detail.task) || null;
    if (!task || this.data.saving) return;
    this.setData({ saving: true });
    try {
      await api.call('growth.done', { taskId: task.taskId });
      this.setData({ saving: false });
      this.toast('厉害了，各写一句收获吧');
      await this.load(true, true);
      this.maybeAskTaskSubscribe();
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  onHarvest(e) {
    const task = (e && e.detail && e.detail.task) || null;
    if (!task) return;
    this.setData({
      textOpen: true,
      textMode: 'harvest',
      textTaskId: task.taskId,
      text: '',
    });
  },

  onReview(e) {
    const task = (e && e.detail && e.detail.task) || null;
    if (!task) return;
    this.setData({
      textOpen: true,
      textMode: 'review',
      textTaskId: task.taskId,
      text: '',
    });
  },

  onTextInput(e) {
    this.setData({ text: String((e && e.detail && e.detail.value) || '') });
  },

  onTextClose() {
    if (this.data.textSaving) return;
    this.setData({ textOpen: false, text: '', textTaskId: '' });
  },

  async onSubmitText() {
    if (this.data.textSaving) return;
    const text = String(this.data.text || '').trim();
    if (!text) {
      this.toast(this.data.textMode === 'review' ? '写一句你想说的' : '写一句你们做到了什么');
      return;
    }
    const mode = this.data.textMode;
    this.setData({ textSaving: true });
    try {
      const res = await api.call(mode === 'review' ? 'growth.review' : 'growth.harvest', {
        taskId: this.data.textTaskId,
        text,
      });
      this.setData({ textSaving: false, textOpen: false, text: '', textTaskId: '' });
      this.toast(mode === 'review' ? '收进成长日志了' : (res && res.archived ? '收进成长日志了' : '写好了，等 TA 也写一句'));
      await this.load(true, true);
      if (this.data.logLoaded) this.loadLog(true, true);
      if (mode === 'harvest') this.maybeAskTaskSubscribe();
    } catch (err) {
      this.setData({ textSaving: false });
      api.showError(err);
    }
  },

  onRemove(e) {
    const task = (e && e.detail && e.detail.task) || null;
    if (!task || this.data.saving) return;
    wx.showModal({
      title: '删掉这件事？',
      content: '删掉就找不回来了，已归档的会留在成长日志里。',
      confirmText: '删掉',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return;
        this.removeTask(task.taskId);
      },
    });
  },

  async removeTask(taskId) {
    if (!taskId || this.data.saving) return;
    this.setData({ saving: true });
    try {
      await api.call('growth.remove', { taskId });
      this.setData({ saving: false });
      this.toast('删掉了');
      await this.load(true, true);
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  // ── 订阅授权（文档 7.18：动作完成的正反馈时刻才问）──────────────────────

  maybeAskTaskSubscribe() {
    // 模板没配、本次会话已问过、额度还够、当前没有模板 ID 都不问
    if (!this.data.subConfigured || !this.data.subTemplateId) return;
    if (this._subAsked) return;
    if (this.data.subQuota >= SUB_ASK_BELOW) return;
    if (typeof wx.requestSubscribeMessage !== 'function') return;
    this._subAsked = true;

    wx.requestSubscribeMessage({
      tmplIds: [this.data.subTemplateId],
      success: (res) => {
        const accepted = res && res[this.data.subTemplateId] === 'accept';
        if (!accepted) return;
        api.call('reminder.grant', { template: 'task' })
          .then((next) => {
            if (next && typeof next.taskQuota === 'number') {
              this.setData({ subQuota: next.taskQuota });
            }
          })
          .catch(() => {}); // 授权已经拿到，grant 失败只是少一条额度，不打扰用户
      },
      fail: () => {},
    });
  },
});
