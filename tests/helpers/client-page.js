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

module.exports = { installWx, restoreWx, loadPage, instantiate, loadComponent, instantiateComponent };
