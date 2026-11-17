'use strict';

// 自定义 tabBar 的选中态同步（文档 8.2）：只有「今天 / 我的」两个 tab，
// 其余页面都是普通页，由首页卡片 navigateTo 进入。
const test = require('node:test');
const assert = require('node:assert');

const constants = require('../miniprogram/utils/constants');
const tabbar = require('../miniprogram/utils/tabbar');

test('tabbar: 只有两个 tab，下标与 TAB_ROUTES 一致', () => {
  assert.deepStrictEqual(constants.TAB_ROUTES, ['/pages/home/index', '/pages/profile/index']);
  assert.strictEqual(tabbar.tabIndexOf(constants.ROUTES.home), 0);
  assert.strictEqual(tabbar.tabIndexOf(constants.ROUTES.profile), 1);
  // 普通页没有 tab 下标：调用方据此跳过 setData，不会把别人的 tab 点亮
  for (const page of ['diary', 'wish', 'mood', 'safety', 'bind']) {
    assert.strictEqual(tabbar.tabIndexOf(constants.ROUTES[page]), -1, page + ' 不该有 tab 下标');
  }
  assert.strictEqual(tabbar.tabIndexOf(undefined), -1);
  assert.strictEqual(tabbar.tabIndexOf(''), -1);
});

test('tabbar: sync 把选中态写给当前页的 tabBar 实例', () => {
  const calls = [];
  const bar = {
    data: { selected: 0 },
    setData(patch) {
      calls.push(patch);
      Object.assign(this.data, patch);
    },
  };
  const page = { getTabBar: () => bar };

  tabbar.sync(page, constants.ROUTES.profile);
  assert.deepStrictEqual(calls, [{ selected: 1 }]);
  assert.strictEqual(bar.data.selected, 1);

  // 已经选中就不重复 setData（切回同一页时不触发多余渲染）
  tabbar.sync(page, constants.ROUTES.profile);
  assert.strictEqual(calls.length, 1);

  tabbar.sync(page, constants.ROUTES.home);
  assert.deepStrictEqual(calls, [{ selected: 1 }, { selected: 0 }]);
});

test('tabbar: sync 遇到非 tab 页 / 空实例都不抛错', () => {
  // 非 tab 页：没有 getTabBar
  assert.doesNotThrow(() => tabbar.sync({}, constants.ROUTES.home));
  // 传错页：直接跳过
  assert.doesNotThrow(() => tabbar.sync(null, constants.ROUTES.diary));
  // 首次渲染 getTabBar() 可能返回 null
  assert.doesNotThrow(() => tabbar.sync({ getTabBar: () => null }, constants.ROUTES.home));
  // 组件实例缺 setData（单测桩 / 异常实例）
  assert.doesNotThrow(() => tabbar.sync({ getTabBar: () => ({ data: {} }) }, constants.ROUTES.home));
  let touched = false;
  tabbar.sync(
    {
      getTabBar: () => ({
        data: {},
        // 没有 setData 时不能被调用到
        setData: () => {
          touched = true;
        },
      }),
    },
    constants.ROUTES.diary
  );
  assert.strictEqual(touched, false, '非 tab 页不该写 tabBar');
});

test('tabbar: isTabRoute 只认两个 tab，query 不影响判断', () => {
  assert.strictEqual(constants.isTabRoute('/pages/home/index'), true);
  assert.strictEqual(constants.isTabRoute('/pages/home/index?code=ABC123'), true);
  assert.strictEqual(constants.isTabRoute('/pages/profile/index'), true);
  assert.strictEqual(constants.isTabRoute('/pages/diary/index'), false);
  assert.strictEqual(constants.isTabRoute('/pages/mood/index?from=profile'), false);
  assert.strictEqual(constants.isTabRoute('/pages/safety/index'), false);
  assert.strictEqual(constants.isTabRoute(''), false);
  assert.strictEqual(constants.isTabRoute(undefined), false);
});
