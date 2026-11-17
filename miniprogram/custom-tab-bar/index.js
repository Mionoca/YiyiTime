/**
 * 自定义 tabBar（文档 8.2 / 8.7）。
 *
 * 为什么自定义：规范要求「虚线边框 + 马克笔高亮 + 极小圆角」，系统 tabBar 只能配颜色与
 * 位图图标，做不出虚线顶边，也会多出 5 套 PNG 与二倍图维护成本。
 *
 * 选中态由各 tab 页在 onShow 里通过 getTabBar().setData({ selected }) 同步：
 * 自定义 tabBar 是独立组件实例，页面切换时不会自动更新 selected。
 */
const LIST = [
  { path: '/pages/home/index', text: '今天' },
  { path: '/pages/diary/index', text: '日记' },
  { path: '/pages/wish/index', text: '愿望' },
  { path: '/pages/mood/index', text: '心情' },
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
