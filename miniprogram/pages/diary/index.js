'use strict';

/**
 * 手帐日记（M13，文档 8.3.3 / 8.7.1 / 10.7）。
 *
 * 三件事在一页里：
 * 1. 编辑器：一页手帐（正文 / 心情分值 / 配图 / 可见性 / 延迟解锁），默认私密；
 * 2. 手帐列表：按天倒序，卡片只展示服务端给的字段；
 * 3. 心情日历：月度 30 格深浅 + 统计，年度归档导出成长图（PDF 为 P1 预留）。
 *
 * 隐私约束（7.10 红线）：
 * - 「这篇给他看」默认关闭，客户端不提供任何「默认公开」设置；
 * - 私密日记在伴侣侧等于不存在，页面不为「对方是否写过」做任何推断渲染。
 */
const api = require('../../utils/api');
const constants = require('../../utils/constants');
const timeUtil = require('../../utils/time');
const upload = require('../../utils/upload');
const meUtil = require('../../utils/me');
const diaryExport = require('../../utils/diary-export');
const privacy = require('../../utils/privacy');

const PAGE_SIZE = 10;
const CONTENT_MAX = constants.LIMITS.diary;
const IMAGES_MAX = constants.LIMITS.diaryImages;
// 文档 12.9：列表失败保留已加载内容，底部提示「加载失败，点重试」
const LIST_ERROR_TEXT = '加载失败，点重试';
const CAL_ERROR_TEXT = '心情日历打不开，再试一次';

/** 日历格子：分值 → 五档色块（没有分值就是空格） */
function moodColor(score) {
  const hit = constants.MOOD_SCALE.filter((item) => item.score === score)[0];
  return hit ? hit.color : '';
}

/** 月历网格：按 1 号是星期几补空格子（周日开头，与系统日历一致） */
function buildCalendarGrid(calendar, todayKey) {
  if (!calendar || !Array.isArray(calendar.days) || !calendar.days.length) {
    return { cells: [], days: [] };
  }
  const first = calendar.days[0].date;
  const [year, month] = first.split('-').map(Number);
  const offset = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const cells = [];
  for (let i = 0; i < offset; i += 1) cells.push({ key: 'blank_' + i, blank: true });
  const days = calendar.days.map((item) => ({
    key: item.date,
    date: item.date,
    day: item.day,
    score: typeof item.score === 'number' ? item.score : null,
    hasDiary: !!item.hasDiary,
    shared: !!item.shared,
    color: moodColor(item.score),
    isToday: item.date === todayKey,
    label: item.day + ' 日' + (typeof item.score === 'number' ? '，心情 ' + item.score + ' 分' : '，没有记录心情'),
  }));
  days.forEach((day) => cells.push(day));
  return { cells, days };
}

function statsTextOf(stats, monthText) {
  if (!stats || !stats.recorded) return monthText + '还没有记下心情';
  const best = stats.best ? timeUtil.formatMonthDay(stats.best.date) : '';
  const lowest = stats.lowest ? timeUtil.formatMonthDay(stats.lowest.date) : '';
  return '记了 ' + stats.recorded + ' 天 · 平均 ' + Number(stats.average).toFixed(1)
    + (best ? ' · 最好 ' + best : '') + (lowest ? ' · 最低 ' + lowest : '');
}

Page({
  data: {
    view: 'journal', // journal | calendar
    items: [],
    todayKey: '',
    content: '',
    contentMax: CONTENT_MAX,
    moodScore: 0,
    images: [],
    uploadingCount: 0,
    uploadingTotal: 0,
    shared: false,
    unlockMode: 'day',
    unlockOptions: constants.DIARY_UNLOCK_MODES,
    canSave: false,
    // 今天这篇已经给 TA 看过（immediate 档保存即解锁）：当天不能再改，编辑器直接显示说明
    lockedToday: false,
    saving: false,
    loading: true,
    loadingMore: false,
    hasMore: false,
    error: '',
    listError: '',
    calendar: null,
    calMonth: '',
    calMonthText: '',
    calCells: [],
    calStatsText: '',
    calCanNext: false,
    calLoading: false,
    calError: '',
    exporting: false,
    posterWidth: 0,
    posterHeight: 0,
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
    const stop = () => wx.stopPullDownRefresh();
    const job = this.data.view === 'calendar' ? this.loadCalendar(this.data.calMonth) : this.load(true);
    job.then(stop, stop);
  },

  onReachBottom() {
    if (this.data.view !== 'journal') return;
    this.loadMore();
  },

  onRetry() {
    this.load();
  },

  /** 列表底部「加载失败，点重试」（文档 12.9）：在途时复用同一个请求，避免连点并发 */
  onRetryList() {
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

  // ── 编辑器 ──────────────────────────────────────────────────────
  onContentInput(e) {
    const content = String((e && e.detail && e.detail.value) || '');
    this.setData({ content, canSave: !!content.trim() });
  },

  onMoodChange(e) {
    const score = Number(e && e.detail && e.detail.score) || 0;
    this.setData({ moodScore: score });
  },

  onShareChange(e) {
    const shared = !!(e && e.detail && e.detail.value);
    this.setData({ shared });
  },

  onUnlockChange(e) {
    const key = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.key) || '';
    if (['immediate', 'day', 'week'].indexOf(key) === -1) return;
    this.setData({ unlockMode: key });
  },

  /** 选图 → 压缩 → 云存储：逐张上传，失败只跳过这一张，不阻塞写日记 */
  onChooseImage() {
    // 上传中再点一次会让同一批图重复上传，先挡住并说明原因（17.2）
    if (this.data.uploadingCount > 0) {
      wx.showToast({ title: '图片还在上传，等一秒', icon: 'none' });
      return;
    }
    this.pickImages(false);
  },

  /**
   * 打开选图面板。retried 用来标记「已经为隐私授权重试过一次」，
   * 避免微信一直拒绝时无限递归（17.2）。
   */
  pickImages(retried) {
    const remain = IMAGES_MAX - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: '配图最多 3 张', icon: 'none' });
      return;
    }
    if (typeof wx.chooseMedia !== 'function') {
      wx.showToast({ title: '这个版本不支持选图', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: remain,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = (res && res.tempFiles) || [];
        this.uploadFiles(files.map((file) => file && file.tempFilePath).filter(Boolean));
      },
      // 原来这里是空的 fail：隐私未授权（errno 112）也被吞掉，表现就是「点了没反应」
      fail: (err) => this.handlePickFail(err, retried),
    });
  },

  /** 选图失败的三类处理：取消静默 / 隐私拦截引导后重试 / 其它给可读原因 */
  handlePickFail(err, retried) {
    const msg = String((err && err.errMsg) || '');
    if (/cancel/i.test(msg)) return;

    const privacyBlocked = /privacy/i.test(msg) || (err && err.errno === 112);
    if (privacyBlocked) {
      if (retried) {
        wx.showToast({ title: '先同意隐私说明，才能选图', icon: 'none' });
        return;
      }
      this.askPrivacyThenRetry();
      return;
    }

    wx.showToast({ title: this.pickErrorText(err), icon: 'none' });
  },

  /**
   * 主动拉起隐私授权；成功后自动重试一次选图。
   * 微信的 requirePrivacyAuthorize 被拒（或公众平台还没配好指引）时，把页面上的授权弹窗
   * 叫回来——只弹一句 toast 的话，用户根本找不到「同意」在哪（M14 修订）。
   */
  askPrivacyThenRetry() {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      this.showPrivacyGuard();
      return;
    }
    wx.requirePrivacyAuthorize({
      success: () => this.pickImages(true),
      fail: () => this.showPrivacyGuard(),
    });
  },

  /** 唤起页面里的隐私弹窗；拿不到组件（极端情况）才退回文案提示 */
  showPrivacyGuard() {
    if (!privacy.openGuard(this)) {
      wx.showToast({ title: '先同意隐私说明，才能选图', icon: 'none' });
    }
  },

  /** 用户在弹窗里点了「同意并继续」→ 继续刚才没做成的选图 */
  onPrivacyAgreed() {
    this.pickImages(true);
  },

  /** errMsg 形如「chooseMedia:fail xxx」，只取冒号后的部分并截断，不把整串抛给用户 */
  pickErrorText(err) {
    const raw = String((err && err.errMsg) || '');
    const tail = raw.split(':').slice(-1)[0].replace(/^fail\s*/i, '').trim();
    return tail ? '选图失败：' + tail.slice(0, 20) : '选图失败，再试一次';
  },

  async uploadFiles(paths) {
    if (!paths.length) return;
    const total = paths.length;
    this.setData({ uploadingCount: total, uploadingTotal: total });
    let coupleId = '';
    try {
      const me = await meUtil.getMe();
      coupleId = (me && me.coupleId) || '';
    } catch (err) {
      coupleId = '';
    }
    const added = [];
    let firstError = '';
    for (let i = 0; i < paths.length; i += 1) {
      try {
        const fileID = await upload.uploadDiaryImage(paths[i], {
          coupleId,
          date: this.data.todayKey || timeUtil.todayKey(),
        });
        added.push(fileID);
      } catch (err) {
        if (!firstError) firstError = (err && err.message) || '图片上传失败';
      } finally {
        // 无论成功失败都减一：原来只在成功路径减，失败会留下永久的「…」按钮（17.2）
        this.setData({ uploadingCount: Math.max(0, this.data.uploadingCount - 1) });
      }
    }
    this.setData({ uploadingCount: 0, uploadingTotal: 0 });
    if (added.length) {
      this.setData({ images: this.data.images.concat(added).slice(0, IMAGES_MAX) });
    }
    if (firstError) {
      // 全失败给具体原因；部分失败说清「还差几张」，别让人以为全丢或全成
      const title = added.length
        ? '有 ' + (total - added.length) + ' 张没传上，再试一次'
        : firstError;
      wx.showToast({ title, icon: 'none' });
    }
  },

  onRemoveImage(e) {
    const index = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index);
    if (!(index >= 0)) return;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  onPreviewImage(e) {
    const index = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.index) || 0;
    const urls = this.data.images.slice();
    if (!urls.length || typeof wx.previewImage !== 'function') return;
    wx.previewImage({ current: urls[index], urls });
  },

  async onSave() {
    if (this.data.saving) return;
    // 图片还在上传就保存，会把「已选但没传完」的图静默丢掉——宁可让用户等一秒
    if (this.data.uploadingCount > 0) {
      wx.showToast({ title: '图片还在上传，等一秒', icon: 'none' });
      return;
    }
    if (this.data.lockedToday) {
      wx.showToast({ title: '这篇已经给 TA 看过了，改不了', icon: 'none' });
      return;
    }
    const content = String(this.data.content || '').trim();
    if (!content) {
      wx.showToast({ title: '先写一句吧', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    const shared = this.data.shared;
    const payload = {
      content: this.data.content,
      images: this.data.images.slice(),
      visibility: shared ? 'partner' : 'private',
      unlockMode: shared ? this.data.unlockMode : 'day',
    };
    if (this.data.moodScore) payload.moodScore = this.data.moodScore;
    try {
      const res = await api.call('diary.save', payload);
      const diary = (res && res.diary) || null;
      if (diary) this.applyTodayDiary(diary);
      // 心情分值可能变了：日历缓存作废，下次切过去重新拉（否则看到的是保存前的深浅）
      this.setData({ saving: false, calendar: null, calCells: [] });
      wx.showToast({ title: this.saveToast(diary, shared), icon: 'none', duration: 2200 });
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  /** 保存文案按可见性分开：私密强调「只有你看过」，分享告诉对方什么时候能看到 */
  saveToast(diary, shared) {
    if (!shared) return '收好了，只有你看过';
    const unlockAt = (diary && diary.unlockAt) || '';
    const mode = (diary && diary.unlockMode) || this.data.unlockMode;
    if (mode === 'immediate') return 'TA 现在就能看到了';
    const when = unlockAt ? timeUtil.formatTime(unlockAt, this.data.todayKey) : '';
    return when ? 'TA 在 ' + when + ' 会看到' : '收好了，TA 到时间就能看到';
  },

  // ── 列表 ────────────────────────────────────────────────────────
  async load(silent) {
    if (this._loadingList && !silent) return;
    if (!silent) this.setData({ loading: true, error: '', listError: '' });
    this._loadingList = true;
    try {
      const res = await api.call('diary.list', { limit: PAGE_SIZE });
      const items = (res && res.items) || [];
      this._beforeDate = (res && res.nextBeforeDate) || '';
      // 文档 1.5 / 10.9：今天是哪天由服务端给；设备改时间不能影响跨天判断
      const todayKey = (res && res.todayKey) || timeUtil.todayKey();
      const today = items.filter((item) => item.date === todayKey)[0] || null;
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
        listError: '',
      };
      // 首次加载把今天已写的内容带进编辑器，方便改；之后静默刷新不覆盖正在打的草稿
      if (!this._draftInited) {
        this._draftInited = true;
        const mine = today && today.mine ? today.mine : null;
        patch.content = mine ? mine.content : '';
        patch.canSave = !!String(patch.content).trim();
        patch.moodScore = mine && typeof mine.moodScore === 'number' ? mine.moodScore : 0;
        patch.images = mine && Array.isArray(mine.images) ? mine.images.slice() : [];
        patch.shared = !!(mine && mine.visibility === 'partner');
        patch.unlockMode = mine && mine.unlockMode ? mine.unlockMode : 'day';
        // 只有 immediate 档可能当天就解锁（day 档是次日 00:00、week 档是 7 天后），
        // 用 unlockMode 判断而不是比时间：客户端时钟不可信（文档 13.5）
        patch.lockedToday = !!(mine && mine.unlockMode === 'immediate');
      }
      this._loaded = true;
      this.setData(patch);
      if (dayChanged && hadDraft) {
        wx.showToast({ title: '新的一天了，昨晚的草稿没保存', icon: 'none', duration: 2500 });
      }
    } catch (err) {
      if (silent && this.data.items.length) {
        this._listErrorKind = 'refresh';
        this.setData({ listError: LIST_ERROR_TEXT });
        api.showError(err);
      } else {
        this.setData({ loading: false, error: '台灯好像没插好，再试一次', listError: '' });
      }
    } finally {
      this._loadingList = false;
    }
  },

  async loadMore() {
    if (this.data.loading || this.data.loadingMore || !this._beforeDate) return;
    this.setData({ loadingMore: true, listError: '' });
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
        listError: '',
      });
    } catch (err) {
      this._listErrorKind = 'more';
      this.setData({ loadingMore: false, listError: LIST_ERROR_TEXT });
      api.showError(err);
    }
  },

  /** 保存成功先把今天这张卡片改成最新内容，列表顺序保持按日期倒序 */
  applyTodayDiary(diary) {
    const items = this.data.items.slice();
    const todayKey = this.data.todayKey || diary.date;
    const index = items.findIndex((item) => item.date === diary.date);
    const mine = {
      content: diary.content,
      moodScore: typeof diary.moodScore === 'number' ? diary.moodScore : null,
      images: Array.isArray(diary.images) ? diary.images.slice() : [],
      visibility: diary.visibility === 'partner' ? 'partner' : 'private',
      unlockMode: diary.unlockMode || 'day',
      updatedAt: diary.updatedAt,
    };
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

  // ── 分段与心情日历 ──────────────────────────────────────────────
  onSwitchView(e) {
    const view = (e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.view) || '';
    if (view !== 'journal' && view !== 'calendar') return;
    this.setData({ view });
    if (view === 'calendar' && !this.data.calendar) {
      // 缓存被保存动作作废时，优先回到上次看的那一个月，不要默跳回本月
      this.loadCalendar(this.data.calMonth || (this.data.todayKey ? this.data.todayKey.slice(0, 7) : ''));
    }
  },

  async loadCalendar(month) {
    if (this.data.calLoading) return;
    this.setData({ calLoading: true, calError: '' });
    try {
      const res = await api.call('diary.calendar', month ? { month } : {});
      const todayKey = (res && res.todayKey) || this.data.todayKey;
      const currentMonth = (res && res.month) || month || todayKey.slice(0, 7);
      const grid = buildCalendarGrid(res, todayKey);
      this.setData({
        calendar: res,
        calMonth: currentMonth,
        calMonthText: timeUtil.formatMonthCN(currentMonth),
        calCells: grid.cells,
        calStatsText: statsTextOf(res && res.stats, timeUtil.formatMonthCN(currentMonth)),
        calCanNext: currentMonth < todayKey.slice(0, 7),
        calLoading: false,
        calError: '',
        todayKey,
      });
    } catch (err) {
      this.setData({ calLoading: false, calError: CAL_ERROR_TEXT });
      api.showError(err);
    }
  },

  onPrevMonth() {
    if (this.data.calLoading) return;
    const next = timeUtil.shiftMonthKey(this.data.calMonth, -1);
    if (next) this.loadCalendar(next);
  },

  onNextMonth() {
    if (this.data.calLoading || !this.data.calCanNext) return;
    const next = timeUtil.shiftMonthKey(this.data.calMonth, 1);
    if (next && next <= this.data.todayKey.slice(0, 7)) this.loadCalendar(next);
  },

  onRetryCalendar() {
    this.loadCalendar(this.data.calMonth);
  },

  // ── 年度长图导出（PDF 为 P1 预留，文档 2.6 / 7.10）────────────
  async onExport() {
    if (this.data.exporting) return;
    const year = Number((this.data.todayKey || timeUtil.todayKey()).slice(0, 4));
    this.setData({ exporting: true });
    try {
      const res = await api.call('diary.archive', { year });
      const items = (res && res.items) || [];
      if (!items.length) {
        this.setData({ exporting: false });
        wx.showToast({ title: '这一年还没有日记', icon: 'none' });
        return;
      }
      const me = await meUtil.getMe().catch(() => null);
      const poster = diaryExport.buildPoster({
        year,
        items,
        nickname: (me && me.nickname) || '',
        todayKey: this.data.todayKey,
      });
      await this.drawPoster(poster);
      this.setData({ exporting: false });
      wx.showToast({ title: '已存到相册', icon: 'none', duration: 2200 });
    } catch (err) {
      this.setData({ exporting: false });
      if (err && err.posterUnsupported) {
        wx.showToast({ title: '长图导出要真机试一下', icon: 'none' });
        return;
      }
      api.showError(err);
    }
  },

  /** 逐页绘制并保存；每页高度不超过 8192（iOS canvas 上限） */
  async drawPoster(poster) {
    if (typeof wx.createSelectorQuery !== 'function') {
      const err = new Error('current environment has no canvas');
      err.posterUnsupported = true;
      throw err;
    }
    for (let i = 0; i < poster.pages.length; i += 1) {
      const page = poster.pages[i];
      this.setData({ posterWidth: poster.width, posterHeight: page.height });
      // 等 setData 把 canvas 尺寸同步到视图层
      await new Promise((resolve) => {
        if (typeof wx.nextTick === 'function') wx.nextTick(resolve);
        else setTimeout(resolve, 16);
      });
      const canvas = await this.queryCanvas();
      this.paintPage(canvas, poster, page);
      await this.saveCanvas(canvas, poster.width, page.height, i);
    }
  },

  queryCanvas() {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .select('#poster')
        .fields({ node: true, size: true })
        .exec((res) => {
          const node = res && res[0] && res[0].node;
          if (!node) {
            const err = new Error('canvas not found');
            err.posterUnsupported = true;
            reject(err);
            return;
          }
          resolve(node);
        });
    });
  },

  paintPage(canvas, poster, page) {
    const dpr = (wx.getWindowInfo && wx.getWindowInfo().pixelRatio) || 2;
    canvas.width = poster.width * dpr;
    canvas.height = page.height * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.fillStyle = '#FFFEF5';
    ctx.fillRect(0, 0, poster.width, page.height);
    ctx.fillStyle = '#2C2C2C';
    ctx.font = 'bold 40px serif';
    ctx.fillText(poster.header.title, diaryExport.MARGIN, 96);
    ctx.font = '26px serif';
    ctx.fillStyle = '#5F574C';
    ctx.fillText(poster.header.subtitle, diaryExport.MARGIN, 142);

    let y = 210;
    page.months.forEach((month) => {
      ctx.fillStyle = '#7A2E22';
      ctx.font = 'bold 32px serif';
      ctx.fillText(month.label, diaryExport.MARGIN, y);
      y += 34;
      ctx.strokeStyle = '#2C2C2C';
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(diaryExport.MARGIN, y);
      ctx.lineTo(poster.width - diaryExport.MARGIN, y);
      ctx.stroke();
      ctx.setLineDash([]);
      y += 22;

      month.entries.forEach((entry) => {
        ctx.fillStyle = '#5F574C';
        ctx.font = '24px serif';
        ctx.fillText(entry.dateText + (entry.moodText ? '　' + entry.moodText : ''), diaryExport.MARGIN, y);
        y += 34;
        ctx.fillStyle = '#2C2C2C';
        ctx.font = '30px serif';
        entry.lines.forEach((line) => {
          ctx.fillText(line, diaryExport.MARGIN, y);
          y += 40;
        });
        y += 26;
      });
    });
  },

  saveCanvas(canvas, width, height, index) {
    return new Promise((resolve, reject) => {
      wx.canvasToTempFilePath({
        canvas,
        x: 0,
        y: 0,
        width,
        height,
        destWidth: width * 2,
        destHeight: height * 2,
        fileType: 'jpg',
        quality: 0.9,
        success: (res) => {
          const filePath = res && res.tempFilePath;
          if (!filePath) {
            reject(new Error('导出失败'));
            return;
          }
          wx.saveImageToPhotosAlbum({
            filePath,
            success: () => resolve(filePath),
            fail: (err) => {
              const msg = String((err && err.errMsg) || '');
              // 隐私协议没同意时保存相册同样会被拦（errno 112）：和选图走同一条自救路径
              if (/privacy/i.test(msg) || (err && err.errno === 112)) {
                this.showPrivacyGuard();
                resolve(filePath);
                return;
              }
              if (msg.indexOf('auth deny') >= 0 || msg.indexOf('authorize') >= 0) {
                this.guidePhotoSetting();
                resolve(filePath);
                return;
              }
              reject(new Error('保存到相册失败' + (index ? '（第 ' + (index + 1) + ' 张）' : '')));
            },
          });
        },
        fail: reject,
      });
    });
  },

  guidePhotoSetting() {
    wx.showModal({
      title: '需要相册权限',
      content: '长图已经画好了，去设置里允许保存到相册，就能把它留下来。',
      confirmText: '去设置',
      success: (res) => {
        if (res && res.confirm && typeof wx.openSetting === 'function') wx.openSetting();
      },
    });
  },
});
