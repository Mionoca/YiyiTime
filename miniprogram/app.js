// app.js
let ENV_ID = '';
try {
  // 本地私有配置（不入库）：复制 config/env.example.js 为 config/env.js 并填写 ENV_ID
  ENV_ID = require('./config/env').ENV_ID || '';
} catch (e) {
  ENV_ID = '';
  // 只有「文件不存在」才按未配置处理；env.js 存在但写错（语法/路径错误）要明确报出来，
  // 否则会被误报成「未配置环境 ID」，按提示去复制 env.example.js 也修不好（排障误导）。
  if (!e || e.code !== 'MODULE_NOT_FOUND') {
    console.error('[app] 读取 config/env.js 失败：' + (e && e.message ? e.message : e));
  }
}

App({
  globalData: {
    envId: ENV_ID,
    user: null,
    couple: null,
  },

  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    if (!ENV_ID) {
      console.error('[app] 未配置云开发环境 ID：请把 miniprogram/config/env.example.js 复制为 env.js 并填写 ENV_ID');
      return;
    }
    try {
      wx.cloud.init({
        env: ENV_ID,
        traceUser: true,
      });
    } catch (err) {
      // 云能力初始化失败（基础库异常、init 被改坏等）也只报错，不让 onLaunch 抛出去白屏（11.6）。
      console.error('[app] 云开发初始化失败：' + (err && err.message ? err.message : err));
    }
  },
});
