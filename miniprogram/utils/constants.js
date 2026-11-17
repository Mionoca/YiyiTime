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
};

/**
 * tabBar 页（文档 8.2）：只有「今天」和「我的」两个。
 * 日记 / 愿望 / 心情 / 报平安都是普通页面，从首页卡片 wx.navigateTo 进入。
 * 这些页面只能 wx.switchTab，用 navigateTo 会 fail（tab 页不在页面栈里）。
 * 顺序必须与 app.json 的 tabBar.list 一致，custom-tab-bar 的 selected 下标依赖它。
 */
const TAB_ROUTES = [ROUTES.home, ROUTES.profile];

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
};

const DEFAULT_AVATAR = '/images/avatars/default.png';

module.exports = { MOODS, ROUTES, TAB_ROUTES, isTabRoute, LIMITS, DEFAULT_AVATAR };
