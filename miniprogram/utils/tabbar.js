/**
 * 自定义 tabBar 的选中态同步（文档 8.2）。
 *
 * 自定义 tabBar 是独立组件实例，切换 tab 时框架不会替你改 selected，
 * 每个 tab 页要在 onShow 里报一次自己的下标。三处都要判空：
 * - 单测里页面实例没有 getTabBar；
 * - 首次渲染时 getTabBar() 可能返回 null；
 * - 非 tab 页（bind / safety）根本没有 tabBar。
 */
const ROUTES = require('./constants').ROUTES;

const INDEX = {
  [ROUTES.home]: 0,
  [ROUTES.profile]: 1,
};

function tabIndexOf(route) {
  const index = INDEX[route];
  return typeof index === 'number' ? index : -1;
}

/**
 * @param {object} page 页面实例（this）
 * @param {string} route 页面路由，取 constants.ROUTES
 */
function sync(page, route) {
  const index = tabIndexOf(route);
  if (index < 0) return;
  if (!page || typeof page.getTabBar !== 'function') return;
  const bar = page.getTabBar();
  if (!bar || typeof bar.setData !== 'function') return;
  if (bar.data && bar.data.selected === index) return;
  bar.setData({ selected: index });
}

module.exports = { tabIndexOf, sync };
