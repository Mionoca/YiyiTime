// 文案与 emoji 对齐文档 8.5 / 9.5：晴 / 阴 / 雨 / 雷（不使用「多云/小雨/雷雨」）。
// 颜色取涂鸦风的三支马克笔 + 灰紫（文档 8.7），且始终与文字、emoji 同时出现（8.9）。
const MOODS = [
  { key: 'sunny', label: '晴', emoji: '☀️', color: '#FFD93D' },
  { key: 'cloudy', label: '阴', emoji: '☁️', color: '#B9C0CA' },
  { key: 'rainy', label: '雨', emoji: '🌧️', color: '#4ECDC4' },
  { key: 'thunder', label: '雷', emoji: '⛈️', color: '#6C6A8A' },
];

const ROUTES = {
  home: '/pages/home/index',
  bind: '/pages/bind/index',
  profile: '/pages/profile/index',
  safety: '/pages/safety/index',
  diary: '/pages/diary/index',
  wish: '/pages/wish/index',
  mood: '/pages/mood/index',
  anniversary: '/pages/anniversary/index',
  ledger: '/pages/ledger/index',
};

/**
 * tabBar 页（文档 8.2）：今天 / 记账本 / 我的（M12 起三个）。
 * 日记 / 愿望 / 心情 / 报平安 / 纪念日管理都是普通页面，wx.navigateTo 进入。
 * tab 页只能 wx.switchTab，用 navigateTo 会 fail（tab 页不在页面栈里）。
 * 顺序必须与 app.json 的 tabBar.list 一致，custom-tab-bar 的 selected 下标依赖它。
 */
const TAB_ROUTES = [ROUTES.home, ROUTES.ledger, ROUTES.profile];

/** 把带 query 的 url 也判定成 tab（分享卡片可能带 ?code=） */
function isTabRoute(url) {
  const path = String(url || '').split('?')[0];
  return TAB_ROUTES.indexOf(path) !== -1;
}

const LIMITS = {
  nickname: 12,
  moodNote: 50,
  safetyNote: 50,
  diary: 200,
  wishTitle: 30,
  wishNote: 100,
  wishCount: 100,
  // 纪念日（文档 5.3.5 / 6.5）：标题 ≤12 字、每对最多 8 个自定义纪念日
  anniversaryTitle: 12,
  anniversaryCount: 8,
  // 记账本（文档 6.5 / 7.13）：备注 ≤30 字、单笔 1 分–10,000 元、每人每月 60 笔
  ledgerNote: 30,
  ledgerAmountMin: 1,
  ledgerAmountMax: 1000000,
  ledgerMonthCount: 60,
};

/**
 * 记账分类（文档 7.13）：key 与云函数 CATEGORIES 必须一致，
 * emoji 只做辅助，文字一定同时出现（8.9）。
 */
const LEDGER_CATEGORIES = [
  { key: 'food', label: '吃饭', emoji: '🍜' },
  { key: 'transport', label: '交通', emoji: '🚌' },
  { key: 'shopping', label: '购物', emoji: '🛍️' },
  { key: 'fun', label: '玩乐', emoji: '🎡' },
  { key: 'daily', label: '日用', emoji: '🧴' },
  { key: 'other', label: '其他', emoji: '📦' },
];

const DEFAULT_AVATAR = '/images/avatars/default.png';

module.exports = { MOODS, ROUTES, TAB_ROUTES, isTabRoute, LIMITS, LEDGER_CATEGORIES, DEFAULT_AVATAR };
