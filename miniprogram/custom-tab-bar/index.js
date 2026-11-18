/**
 * 自定义 tabBar（文档 8.2 / 8.7）。
 *
 * 三个 tab： 「今天」放聚合与四个入口，「记账本」是每天都可能用一次的账本，
 * 「我的」放资料与设置；日记 / 愿望 / 心情 / 报平安 / 纪念日管理都从页面内
 * wx.navigateTo 进入，不再占底部。
 *
 * 为什么自定义：规范要求「虚线边框 + 马克笔高亮 + 极小圆角」，系统 tabBar 只能配颜色与
 * 位图图标，做不出虚线顶边，也会多出两套 PNG 与二倍图维护成本。
 *
 * 选中态由三个 tab 页在 onShow 里通过 tabbar.sync 同步：
 * 自定义 tabBar 是独立组件实例，页面切换时不会自动更新 selected。
 */
const LIST = [
  { path: '/pages/home/index', text: '今天' },
  { path: '/pages/ledger/index', text: '记账本' },
  { path: '/pages/profile/index', text: '我的' },
];

Component({
  data: {
    selected: 0,
    list: LIST,
  },

  methods: {
    onTap(e) {
      const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
      const index = Number(dataset.index);
      const path = dataset.path;
      if (!path) return;
      // 点当前 tab 不重复 switchTab（会触发一次无意义的页面显示）
      if (index === this.data.selected) return;
      wx.switchTab({
        url: path,
        // 切换失败（例如页面栈异常）不打断用户，停留在当前页即可
        fail: () => {},
      });
    },
  },
});
