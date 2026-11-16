// app.js
let ENV_ID = '';
try {
  // 本地私有配置（不入库）：复制 config/env.example.js 为 config/env.js 并填写 ENV_ID
  ENV_ID = require('./config/env').ENV_ID || '';
} catch (e) {
  ENV_ID = '';
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
    wx.cloud.init({
      env: ENV_ID,
      traceUser: true,
    });
  },
});
