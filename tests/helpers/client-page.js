'use strict';

// 小程序页面/工具的单测夹具：安装最小 wx 桩，并在 require 页面时捕获 Page 配置。
// 说明：node --test 每个测试文件独立子进程，所以 global.wx / global.Page 不会跨文件串味；
// 同一文件内需要还原时调用 restoreWx()。installWx 只替换 wx，不合并默认桩。
const path = require('node:path');
const Module = require('node:module');

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

/**
 * 用 Page 配置造一个可调用的实例（setData 合并进 data）。
 * setData 支持 'form.title' 这类路径键（真机支持，wish 页的输入框在用）：
 * 只做简单的点号/下标展开，不模拟同层合并语义之外的细节。
 */
function setDataPath(data, key, value) {
  const parts = String(key).replace(/\[(\d+)\]/g, '.$1').split('.').filter((part) => part !== '');
  if (!parts.length) return;
  let target = data;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!target[part] || typeof target[part] !== 'object') target[part] = {};
    target = target[part];
  }
  target[parts[parts.length - 1]] = value;
}

function instantiate(config) {
  const page = Object.assign({}, config);
  page.data = JSON.parse(JSON.stringify(config.data || {}));
  page.setData = function setData(patch) {
    Object.keys(patch || {}).forEach((key) => setDataPath(this.data, key, patch[key]));
  };
  return page;
}

/** require 一个小程序组件文件，返回传给 Component() 的配置对象。 */
function loadComponent(relPath) {
  let config = null;
  global.Component = (cfg) => {
    config = cfg;
  };
  const abs = path.resolve(__dirname, '../..', relPath);
  delete require.cache[require.resolve(abs)];
  require(abs);
  return config;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/**
 * 用 Component 配置造一个可调用的实例（最小实现）：
 * - properties 的默认值会合并进 data（与真机一致，属性可通过 this.data 读取）；
 * - methods 全部挂到实例上，且 triggerEvent 只记录不冒泡；
 * - 提供一个 setProps(patch) 触发对应 observers（模拟父页更新属性）。
 * 注意：不模拟 WXML 渲染、selectComponent、样式隔离，只覆盖组件 JS 逻辑。
 * 与真机的已知差异（故意简化，写用例时要留意）：
 * 1) 创建时传入的初始属性不触发 observer，也不自动跑 created/attached 生命周期；
 *    所有属性断言都发生在创建之后显式 setProps 时。
 * 2) setProps 即使传入相同引用/相同值也会触发 observer（真机只在属性实际更新时触发），
 *    所以「同值不重复播动画」这类断言必须靠组件自己的 signature 去重，而不是靠夹具。
 * 3) clone 用 JSON 序列化，Date 会变成 ISO 字符串（组件里同时接受 Date/ISO 时不影响判定）。
 */
function instantiateComponent(config, props) {
  const instance = {};
  const data = clone(config.data || {}) || {};
  const properties = config.properties || {};
  Object.keys(properties).forEach((name) => {
    const def = properties[name];
    const value = props && Object.prototype.hasOwnProperty.call(props, name) ? props[name] : def && def.value;
    data[name] = clone(value);
  });
  instance.data = data;
  instance.events = [];
  Object.assign(instance, config.methods || {});
  instance.triggerEvent = function triggerEvent(name, detail) {
    this.events.push({ name, detail: detail === undefined ? {} : detail });
  };
  instance.setData = function setData(patch) {
    Object.assign(this.data, patch);
  };

  // observers：键可能是 "a, b" 形式；按声明顺序取相交的观察者，用当前属性值调用。
  const observers = config.observers || {};
  instance.setProps = function setProps(patch) {
    const changed = Object.keys(patch);
    changed.forEach((key) => {
      this.data[key] = clone(patch[key]);
    });
    Object.keys(observers).forEach((keys) => {
      const watched = keys.split(',').map((k) => k.trim());
      if (!watched.some((k) => changed.indexOf(k) >= 0)) return;
      const fn = observers[keys];
      fn.apply(this, watched.map((k) => this.data[k]));
    });
  };

  instance.runLifetime = function runLifetime(name) {
    const lives = config.lifetimes || {};
    if (typeof lives[name] === 'function') lives[name].call(this);
  };

  return instance;
}

/**
 * require miniprogram/app.js 并返回传给 App() 的配置对象。
 * options.envMissing: 模拟本机没有 config/env.js（require 抛 MODULE_NOT_FOUND）；
 * options.env: 覆盖 require('./config/env') 的返回值（默认 { ENV_ID: 'test-env-id' }）。
 * options.envError: 让 require('./config/env') 抛指定错误（模拟 env.js 语法写错等）。
 * 只在加载 app.js 期间替换 Module._load，加载完立即还原并清缓存，不影响别的模块。
 */
function loadApp(options) {
  const opts = options || {};
  let config = null;
  global.App = (cfg) => {
    config = cfg;
  };
  const appPath = path.resolve(__dirname, '../..', 'miniprogram/app.js');
  const originalLoad = Module._load;
  let intercepted = 0;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === './config/env' && parent && /[\\/]app\.js$/.test(parent.filename)) {
      intercepted += 1;
      if (opts.envError) {
        throw opts.envError;
      }
      if (opts.envMissing) {
        const err = new Error("Cannot find module './config/env'");
        err.code = 'MODULE_NOT_FOUND';
        throw err;
      }
      return opts.env === undefined ? { ENV_ID: 'test-env-id' } : opts.env;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve(appPath)];
  try {
    require(appPath);
  } finally {
    Module._load = originalLoad;
    delete require.cache[require.resolve(appPath)];
  }
  // 自检：app.js 若改了 require 路径，夹具会静默失效并让「缺 env.js」用例假通过。
  if (intercepted === 0) {
    throw new Error('loadApp: 没有拦截到 app.js 对 ./config/env 的 require，app.js 的 require 路径可能变了');
  }
  return config;
}

module.exports = { installWx, restoreWx, loadPage, instantiate, loadComponent, instantiateComponent, loadApp };
