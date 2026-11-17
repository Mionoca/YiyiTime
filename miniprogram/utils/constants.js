// 文案与 emoji 对齐文档 8.5 / 9.5：晴 / 阴 / 雨 / 雷（不使用「多云/小雨/雷雨」）
const MOODS = [
  { key: 'sunny', label: '晴', emoji: '☀️', color: '#F2CC8F' },
  { key: 'cloudy', label: '阴', emoji: '☁️', color: '#B8C0CC' },
  { key: 'rainy', label: '雨', emoji: '🌧️', color: '#7A9CC6' },
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

module.exports = { MOODS, ROUTES, LIMITS, DEFAULT_AVATAR };
