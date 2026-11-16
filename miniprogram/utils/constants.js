const MOODS = [
  { key: 'sunny', label: '晴', color: '#F2CC8F' },
  { key: 'cloudy', label: '多云', color: '#B8C0CC' },
  { key: 'rainy', label: '小雨', color: '#7A9CC6' },
  { key: 'thunder', label: '雷雨', color: '#6C6A8A' },
];

const ROUTES = {
  home: '/pages/home/index',
  bind: '/pages/bind/index',
  profile: '/pages/profile/index',
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
