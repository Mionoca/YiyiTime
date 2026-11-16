'use strict';

// 小程序页面/工具的单测夹具：安装最小 wx 桩，并在 require 页面时捕获 Page 配置。
// 说明：node --test 每个测试文件独立子进程，所以 global.wx / global.Page 不会跨文件串味；
// 同一文件内需要还原时调用 restoreWx()。installWx 只替换 wx，不合并默认桩。
const path = require('node:path');

let savedWx;
let saved = false;

function installWx(overrides) {
  if (!saved) {
    savedWx = global.wx;
    saved = true;
  }
  global.wx = Object.assign({}, overrides);
  return global.wx;
}

function restoreWx() {
  if (!saved) return;
  global.wx = savedWx;
  saved = false;
  savedWx = undefined;
}

/** require 一个小程序页面文件，返回传给 Page() 的配置对象。 */
function loadPage(relPath) {
  let config = null;
  global.Page = (cfg) => {
    config = cfg;
  };
  const abs = path.resolve(__dirname, '../..', relPath);
  delete require.cache[require.resolve(abs)];
  require(abs);
  return config;
}

/** 用 Page 配置造一个可调用的实例（setData 合并进 data）。 */
function instantiate(config) {
  const page = Object.assign({}, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };
  return page;
}

module.exports = { installWx, restoreWx, loadPage, instantiate };
