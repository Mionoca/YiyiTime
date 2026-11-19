const api = require('../../utils/api');
const constants = require('../../utils/constants');
const tabbar = require('../../utils/tabbar');
const permissionCache = require('../../utils/permission-cache');
const timeUtil = require('../../utils/time');
const upload = require('../../utils/upload');
const haptics = require('../../utils/haptics');
const privacy = require('../../utils/privacy');

const DEFAULT_AVATAR = constants.DEFAULT_AVATAR;

Page({
  data: {
    loading: true,
    error: '',
    home: null,
    nickname: '',
    nicknameMax: constants.LIMITS.nickname,
    avatarFileID: '',
    avatarPreview: DEFAULT_AVATAR,
    bound: false,
    bindStateText: '',
    daysText: '',
    startDateText: '',
    anniversaryText: '',
    saving: false,
    editing: false,
    startDateSelect: '',
    maxStartDate: '',
    startDateSaving: false,
    defaultAvatar: DEFAULT_AVATAR,
    appVersion: '',
    // 文档 8.9：振动反馈只用于抱抱 / 报平安成功，且可关闭
    hapticsEnabled: true,
    // 文档 11.6：数据与隐私说明（收集 / 不收集 / 用途 / 存储 / 删除数据）
    privacySheet: false,
    // 注销进行中：防连点；成功后会 reLaunch，失败允许原地重试（服务端幂等）
    deleting: false,
    privacySections: privacy.SECTIONS,
    privacyFooter: privacy.FOOTER,
    // 解绑（M9 / 文档 8.3.6）：none / pending_me / pending_partner
    unbindStatus: 'none',
    unbindText: '解绑',
    unbinding: false,
    // 每日提醒（M10 / 文档 8.3.6）：configured 由服务端给（模板 ID 没配就整行禁用）
    reminder: {
      configured: false, enabled: false, remindAt: '21:00',
      quota: 0, quotaMax: 7, templateId: '',
    },
    reminderCheckedIn: false,
    reminderSaving: false,
    // 设置读不到时不要伪装成「提醒还没开通」，单独给一句可重试的提示
    reminderError: false,
  },

  onShow() {
    // 自定义 tabBar 的选中态要页面自己报（文档 8.2）
    tabbar.sync(this, constants.ROUTES.profile);
    this.load();
  },

  onUnload() {
    // 解绑成功后的延迟跳转：页面已经卸载就别再 reLaunch
    this._unloaded = true;
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
  },

  onPullDownRefresh() {
    // 文档 L637：子页支持下拉刷新。这里不 force：正在改昵称时别用服务端旧值覆盖输入框
    const stop = () => wx.stopPullDownRefresh();
    this.load().then(stop, stop);
  },

  onRetry() {
    this.load(true);
  },

  toast(title) {
    wx.showToast({ title, icon: 'none' });
  },

  async load(force) {
    // 正在改昵称时，别用服务端旧值把输入框覆盖掉
    if (this.data.editing && !force) return;
    // 请求令牌：下拉刷新 / onShow / 解绑后的刷新可能并发，旧响应不能覆盖新的解绑状态
    const token = (this._seq = (this._seq || 0) + 1);
    const stale = () => this._unloaded || token !== this._seq;
    try {
      // 提醒设置是「附加信息」：它失败不该让整个「我的」页打不开，所以单独 catch 成 null
      const [home, rem] = await Promise.all([
        api.call('home.get'),
        api.call('reminder.get').catch(() => null),
      ]);
      if (stale()) return;
      const user = home.user || {};
      const unbind = this.unbindView(home);
      const patch = {
        loading: false,
        error: '',
        home,
        nickname: user.nickname || '',
        avatarFileID: user.avatarFileID || '',
        avatarPreview: user.avatarFileID || DEFAULT_AVATAR,
        bound: home.bind.state === 'bound',
        bindStateText: this.bindText(home.bind),
        unbindStatus: unbind.status,
        unbindText: unbind.text,
        // 上限用服务端 todayKey（文档 13.5：日期规则以服务端为准），取不到再退回本机
        maxStartDate: home.todayKey || timeUtil.todayKey(),
        startDateSelect: home.couple ? home.couple.startDate : '',
        appVersion: this.getAppVersion(),
        hapticsEnabled: haptics.isEnabled(),
      };
      if (rem) {
        patch.reminder = this.normalizeReminder(rem);
        patch.reminderCheckedIn = !!rem.checkedInToday;
        patch.reminderError = false;
      } else {
        patch.reminderError = true;
      }
      if (home.couple) {
        // 脏 startDate 时服务端会把 daysTogether/anniversary 降级为 null（home.get），
        // 这里不能拼出「第 null 天」，与首页 derive 保持同一守卫
        const couple = home.couple;
        patch.daysText = couple.daysTogether ? '第 ' + couple.daysTogether + ' 天' : '';
        patch.startDateText = couple.startDate ? timeUtil.formatDateCN(couple.startDate) : '';
        patch.anniversaryText = couple.anniversary
          ? timeUtil.formatDateCN(couple.anniversary.date) + ' · 还有 ' + couple.anniversary.daysLeft + ' 天'
          : (couple.startDate ? '开始那天就是纪念日' : '');
      } else {
        patch.daysText = '';
        patch.startDateText = '';
        patch.anniversaryText = '';
      }
      // 编辑昵称时被强制刷新（比如刚改完开始日期），保留正在输入的草稿
      if (this.data.editing) patch.nickname = this.data.nickname;
      this.setData(patch);
    } catch (err) {
      if (stale()) return;
      this.setData({ loading: false, error: (err && err.message) || '小屋暂时打不开' });
    }
  },

  /** 关于里显示版本号（文档 8.3.6）；开发者工具/体验版取不到时退回「内测版」 */
  getAppVersion() {
    try {
      if (wx.getAccountInfoSync) {
        const info = wx.getAccountInfoSync();
        const v = info && info.miniProgram && info.miniProgram.version;
        if (v) return 'v' + v;
      }
    } catch (err) {
      // 取不到不影响页面
    }
    return '内测版';
  },

  /** 文档 8.9：开关只影响抱抱 / 报平安成功的轻振动，不影响其它交互 */
  onToggleHaptics(e) {
    const enabled = !!(e && e.detail && e.detail.value);
    if (!haptics.setEnabled(enabled)) {
      // 本地写失败时开关要回滚，否则界面显示「已关闭」但还在振动
      this.setData({ hapticsEnabled: haptics.isEnabled() });
      this.toast('开关没保存成功，稍后再试');
      return;
    }
    this.setData({ hapticsEnabled: enabled });
    this.toast(enabled ? '振动反馈已打开' : '振动反馈已关闭');
  },

  bindText(bind) {
    if (!bind) return '';
    const map = {
      unbound: '还没绑定',
      code_created: '邀请码等你发出',
      applied_by_me: '等 TA 确认',
      applied_by_partner: '有人在等你确认',
      bound: '已绑定',
    };
    return map[bind.state] || '';
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value, editing: true });
  },

  async onSaveNickname() {
    if (this.data.saving) return;
    const nickname = String(this.data.nickname || '').trim();
    if (!nickname) {
      this.toast('先起个昵称吧');
      return;
    }
    if (nickname.length > constants.LIMITS.nickname) {
      this.toast('昵称最多 ' + constants.LIMITS.nickname + ' 个字');
      return;
    }
    this.setData({ saving: true });
    try {
      const res = await api.call('user.updateProfile', { nickname });
      const user = res.user || {};
      this.setData({
        saving: false,
        editing: false,
        nickname: user.nickname || nickname,
        avatarFileID: user.avatarFileID || this.data.avatarFileID,
        avatarPreview: user.avatarFileID || this.data.avatarPreview,
      });
      wx.showToast({ title: '改好啦', icon: 'none' });
    } catch (err) {
      this.setData({ saving: false });
      api.showError(err);
    }
  },

  uploadAvatar(filePath) {
    return upload.uploadAvatar(filePath);
  },

  /** 换头像入口（M14 / 17.7）：从相册或相机选一张，不再限定微信头像 */
  onChooseAvatarTap() {
    if (this.data.saving) return;
    if (typeof wx.chooseMedia !== 'function') {
      wx.showToast({ title: '这个版本不支持选图', icon: 'none' });
      return;
    }
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const file = res && res.tempFiles && res.tempFiles[0];
        const path = file && file.tempFilePath;
        if (path) this.cropThenUpload(path);
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '');
        if (/cancel/i.test(msg)) return;
        // 隐私说明没同意时 chooseMedia 会被平台直接拦下（errno 112），必须说清楚
        if (/privacy/i.test(msg) || (err && err.errno === 112)) {
          wx.showToast({ title: '先同意隐私说明，才能换头像', icon: 'none' });
          return;
        }
        wx.showToast({ title: '选图失败，再试一次', icon: 'none' });
      },
    });
  },

  /**
   * 头像容器是圆的，最终必须裁成 1:1；但「脸在哪」交给用户自己框，
   * 不用 aspectFill 硬居中（竖构图会切掉额头 / 下巴）。
   * 基础库 < 2.26 没有 wx.cropImage 时直接上传原图，展示侧偏上对齐兜底。
   */
  cropThenUpload(filePath) {
    if (typeof wx.cropImage !== 'function') {
      this.onChooseAvatar({ detail: { avatarUrl: filePath } });
      return;
    }
    wx.cropImage({
      src: filePath,
      cropScale: '1:1',
      success: (res) => {
        const path = (res && res.tempFilePath) || '';
        if (path) this.onChooseAvatar({ detail: { avatarUrl: path } });
      },
      // 用户在裁剪页取消：保留原头像，不提示（取消不是错误）
      fail: () => {},
    });
  },

  /** 注销入口（M14 / 17.8）：先讲影响，再要求输入「注销」二次确认 */
  onTapDeleteAccount() {
    if (this.data.deleting) return;
    wx.showModal({
      title: '注销账号？',
      content: '会删掉：日记（含配图）、心情、个人账本、查看授权、账号资料。\n会留给对方：共同的纪念日、愿望、已归档的成长任务。\n关系会同时结束，删掉之后找不回来。',
      confirmText: '下一步',
      cancelText: '再想想',
      success: (res) => {
        if (res && res.confirm) this.confirmDeleteAccount();
      },
    });
  },

  /** 二次确认用输入框：只有真的打出「注销」两个字才继续，防误触 */
  confirmDeleteAccount() {
    wx.showModal({
      title: '确认注销',
      editable: true,
      placeholderText: '输入「注销」两个字',
      confirmText: '注销',
      cancelText: '取消',
      success: (res) => {
        if (!res || !res.confirm) return;
        const text = String(res.content || '').trim();
        if (text !== '注销') {
          this.toast('要输入「注销」两个字才能继续');
          return;
        }
        this.deleteAccount();
      },
    });
  },

  async deleteAccount() {
    if (this.data.deleting) return;
    this.setData({ deleting: true });
    try {
      await api.call('user.deleteAccount', { confirm: 'delete' });
      // 本地缓存里可能还有上一个身份的快照 / 权限 / 邀请码，一并清掉，避免重进时闪旧数据
      try {
        wx.clearStorageSync();
      } catch (err) {
        // 存储不可用不影响账号已经删掉的事实
      }
      wx.showToast({ title: '已经注销了', icon: 'none' });
      // 等 toast 露一下再跳：reLaunch 会销毁当前页
      setTimeout(() => {
        wx.reLaunch({ url: constants.ROUTES.bind });
      }, 600);
    } catch (err) {
      this.setData({ deleting: false });
      api.showError(err);
    }
  },

  async onChooseAvatar(e) {
    const tempUrl = e.detail && e.detail.avatarUrl;
    if (!tempUrl || this.data.saving) return;

    this.setData({ saving: true, avatarPreview: tempUrl });
    try {
      let fileID = '';
      try {
        fileID = await this.uploadAvatar(tempUrl);
      } catch (uploadErr) {
        // 类型/大小校验失败要把具体原因透给用户，其它上传失败仍用通用文案
        throw upload.isAvatarValidationError(uploadErr) ? uploadErr : new Error('头像上传失败，稍后再试');
      }
      const res = await api.call('user.updateProfile', { avatarFileID: fileID });
      const user = res.user || {};
      this.setData({
        saving: false,
        avatarFileID: user.avatarFileID || fileID,
        avatarPreview: user.avatarFileID || fileID,
      });
      wx.showToast({ title: '头像换好啦', icon: 'none' });
    } catch (err) {
      this.setData({ saving: false, avatarPreview: this.data.avatarFileID || DEFAULT_AVATAR });
      api.showError(err);
    }
  },

  /** 改开始日期：和墙历一样要二次确认，文案说明双方都会看到新天数 */
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
      // 先按返回值更新日期和天数，再静默刷新补纪念日
      this.setData({
        startDateSaving: false,
        startDateSelect: res.startDate,
        startDateText: timeUtil.formatDateCN(res.startDate),
        daysText: '第 ' + res.daysTogether + ' 天',
      });
      await this.load(true);
      wx.showToast({ title: '日子重新算好啦', icon: 'none' });
    } catch (err) {
      this.setData({ startDateSaving: false });
      api.showError(err);
    }
  },

  onTapBind() {
    wx.navigateTo({ url: constants.ROUTES.bind });
  },

  /** 心情记录（文档 8.3.7）：只读时间线；普通页面，navigateTo 进入（文档 8.2） */
  onOpenMood() {
    if (!this.data.bound) {
      this.toast('先邀请 TA 住进来吧');
      return;
    }
    wx.navigateTo({ url: constants.ROUTES.mood });
  },

  /** 服务端出参 → 页面 data（脏值一律降级，避免 switch / picker 拿到 undefined） */
  normalizeReminder(res) {
    return {
      configured: !!(res && res.configured),
      enabled: !!(res && res.enabled),
      remindAt: (res && res.remindAt) || '21:00',
      quota: Math.max(0, Number(res && res.quota) || 0),
      quotaMax: Number(res && res.quotaMax) || 7,
      templateId: (res && res.templateId) || '',
    };
  },

  applyReminder(res) {
    if (!res) return;
    this.setData({
      reminderSaving: false,
      reminder: this.normalizeReminder(res),
      reminderCheckedIn: !!res.checkedInToday,
    });
  },

  /** 订阅消息授权：只有 accept 才算拿到一条额度（reject / ban / fail 一律 false） */
  requestReminderSubscribe(templateId) {
    return new Promise((resolve) => {
      if (!templateId || typeof wx.requestSubscribeMessage !== 'function') {
        resolve(false);
        return;
      }
      wx.requestSubscribeMessage({
        tmplIds: [templateId],
        success: (res) => resolve(!!res && res[templateId] === 'accept'),
        fail: () => resolve(false),
      });
    });
  },

  /**
   * 每日提醒开关（文档 7.15 / 8.3.6）：
   * 关掉只要一次 set；打开要先 requestSubscribeMessage 拿授权，accept 后攒额度再打开。
   * 顺序不能反：先 set 再要授权，用户拒绝时开关已经开了，会变成「开了但永远不发」。
   */
  async onToggleReminder(e) {
    const want = !!(e && e.detail && e.detail.value);
    const prev = this.data.reminder;
    if (this.data.reminderSaving) return;
    if (!prev.configured) {
      // switch 是 disabled 的，正常点不到；这里兜住从代码 / 无障碍通道触发的情况
      this.setData({ reminder: Object.assign({}, prev, { enabled: false }) });
      this.toast('提醒还没开通');
      return;
    }
    if (want && !this.data.bound) {
      this.setData({ reminder: Object.assign({}, prev, { enabled: false }) });
      this.toast('先邀请 TA 住进来吧');
      return;
    }

    // 乐观更新：switch 已经翻过去了，先跟手，失败再回滚
    this.setData({ reminderSaving: true, reminder: Object.assign({}, prev, { enabled: want }) });
    let granted = false;
    try {
      if (want) {
        const accepted = await this.requestReminderSubscribe(prev.templateId);
        if (this._unloaded) return;
        if (!accepted) {
          this.setData({ reminderSaving: false, reminder: Object.assign({}, prev, { enabled: false }) });
          this.toast('没收到授权，提醒没打开');
          return;
        }
        await api.call('reminder.grant');
        granted = true;
      }
      const res = await api.call('reminder.set', { enabled: want, remindAt: prev.remindAt });
      if (this._unloaded) return;
      this.applyReminder(res);
      this.toast(want ? '到点会提醒你' : '提醒已关闭');
    } catch (err) {
      if (this._unloaded) return;
      this.setData({ reminderSaving: false, reminder: Object.assign({}, prev, { enabled: prev.enabled }) });
      api.showError(err);
      // 授权额度已经在服务端 +1 了，页面上的「还能提醒 N 次」是旧值，拉一次纠正
      if (granted) this.load(true);
    }
  },

  async onReminderTimeChange(e) {
    const time = String((e && e.detail && e.detail.value) || '');
    if (!/^\d{1,2}:\d{2}$/.test(time)) return;
    if (this.data.reminderSaving) {
      this.toast('正在保存，稍后再改');
      return;
    }
    this.setData({ reminderSaving: true });
    try {
      const res = await api.call('reminder.set', {
        enabled: this.data.reminder.enabled,
        remindAt: time,
      });
      if (this._unloaded) return;
      this.applyReminder(res);
      this.toast('提醒时间改成 ' + res.remindAt);
    } catch (err) {
      if (this._unloaded) return;
      this.setData({ reminderSaving: false });
      api.showError(err);
    }
  },

  /** 三态对应文案（文档 8.3.6）：三处（load / 申请 / 撤回）用同一份，避免某一处写成「解绑」 */
  unbindTextOf(status) {
    if (status === 'pending_me') return '等 TA 确认解绑（点击撤回）';
    if (status === 'pending_partner') return 'TA 申请解绑（点击确认）';
    return '解绑';
  },

  /** 解绑三态（文档 8.3.6）：只认服务端 requestedByMe，不自己推断发起者 */
  unbindView(home) {
    const unbind = (home && home.unbind) || { status: 'none', requestedByMe: false };
    // requestedByMe 不是布尔说明服务端出了新形状：按「没有待确认解绑」处理（点一下会重新同步），
    // 绝不把它当成「TA 申请」——那会给出一个确认解绑的按钮
    if (!home || !home.couple || unbind.status !== 'pending') {
      return { status: 'none', text: this.unbindTextOf('none') };
    }
    if (typeof unbind.requestedByMe !== 'boolean') {
      return { status: 'none', text: this.unbindTextOf('none') };
    }
    const status = unbind.requestedByMe ? 'pending_me' : 'pending_partner';
    return { status, text: this.unbindTextOf(status) };
  },

  /** 解绑：申请 / 撤回 / 确认按当前状态分流，每种都先二次确认（文档 8.3.6） */
  onTapUnbind() {
    if (!this.data.bound || this.data.unbinding) return;
    const status = this.data.unbindStatus;

    if (status === 'pending_me') {
      wx.showModal({
        title: '撤回解绑申请？',
        content: '撤回后你们还是在一起的，TA 也不会再看到申请。',
        confirmText: '撤回',
        cancelText: '不了',
        success: (res) => {
          if (res.confirm) this.cancelUnbind();
        },
      });
      return;
    }

    if (status === 'pending_partner') {
      wx.showModal({
        title: '确认解绑？',
        content: '确认后小屋会关掉，你们都不再看到对方的记录；以前记下的还在原处。',
        confirmText: '解绑',
        cancelText: '再想想',
        success: (res) => {
          if (res.confirm) this.confirmUnbind();
        },
      });
      return;
    }

    wx.showModal({
      title: '申请解绑？',
      content: '要 TA 也点确认才会解绑；在那之前你可以随时撤回。',
      confirmText: '申请',
      cancelText: '再想想',
      success: (res) => {
        if (res.confirm) this.requestUnbind();
      },
    });
  },

  async requestUnbind() {
    if (this.data.unbinding) return;
    this.setData({ unbinding: true });
    try {
      const res = await api.call('couple.requestUnbind');
      const pending = !!(res && res.unbind && res.unbind.status === 'pending');
      const status = pending ? (res.unbind.requestedByMe ? 'pending_me' : 'pending_partner') : 'none';
      this.setData({
        unbinding: false,
        unbindStatus: status,
        unbindText: this.unbindTextOf(status),
      });
      this.toast(status === 'pending_me' ? '已经申请啦，等 TA 确认' : 'TA 也申请了解绑，点确认就能解绑');
      await this.load(true);
    } catch (err) {
      this.setData({ unbinding: false });
      api.showError(err);
    }
  },

  async cancelUnbind() {
    if (this.data.unbinding) return;
    this.setData({ unbinding: true });
    try {
      await api.call('couple.cancelUnbind');
      this.setData({ unbinding: false, unbindStatus: 'none', unbindText: this.unbindTextOf('none') });
      this.toast('撤回啦');
      await this.load(true);
    } catch (err) {
      // 已经没待确认的解绑（对方刚撤回）：按最新状态刷新，不让按钮停在旧文案上
      this.setData({ unbinding: false });
      api.showError(err);
      this.load(true);
    }
  },

  async confirmUnbind() {
    if (this.data.unbinding) return;
    this.setData({ unbinding: true });
    try {
      await api.call('couple.confirmUnbind');
      // 关系结束后账本授权不再成立：把权限快照清掉，别让下一次进账本先闪一下「能看」（17.3）
      permissionCache.clear();
      this.setData({ unbinding: false });
      wx.showToast({ title: '已经解绑了', icon: 'none' });
      // 与绑定成功一致：清掉页面栈回首页，避免停在已失效的资料页
      this.leaveTimer = setTimeout(() => {
        if (this._unloaded) return;
        wx.reLaunch({ url: constants.ROUTES.home });
      }, 700);
    } catch (err) {
      this.setData({ unbinding: false });
      api.showError(err);
      this.load(true);
    }
  },

  /** 隐私保护指引（文档 13.8：隐私弹窗与授权口径要能被用户随时查到） */
  onOpenPrivacy() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({
        fail: () => this.toast('可以在「微信 - 设置 - 隐私」里查看'),
      });
      return;
    }
    this.toast('可以在「微信 - 设置 - 隐私」里查看');
  },

  /** 文档 11.6：数据与隐私说明（收集什么 / 不收集什么 / 怎么删数据），弹层内容走 utils/privacy.js */
  onOpenDataPrivacy() {
    this.setData({ privacySheet: true });
  },

  onCloseDataPrivacy() {
    this.setData({ privacySheet: false });
  },

});
