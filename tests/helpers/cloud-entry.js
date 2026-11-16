'use strict';

/**
 * 云函数入口测试夹具。
 *
 * 本地没有装 wx-server-sdk（只在部署时安装），所以用 Module._load 钩子把
 * 'wx-server-sdk' 换成桩：getWXContext 返回「当前测试用户」，database() 返回代理，
 * 代理每次转发到当前用例的假库（reset 之后换一个全新的空库）。
 *
 * 注意：钩子只在第一次 createHarness 时安装（只拦截这一个包名，对其它 require 无
 * 影响）；测试通常不调用 uninstall，因为 cloudfunctions/api/index.js 一旦被 require
 * 就会缓存，清掉钩子也不会让它退回真实 SDK。确实要卸载时用 uninstall，并自行
 * 清理 require 缓存。cloudfunctions/api/index.js 必须在钩子安装之后才被 require，
 * 这样 lib/db.js 在 require 时拿到的才是代理对象。
 */
const Module = require('node:module');
const { makeFakeDb } = require('./fake-db');

let fake = makeFakeDb({});
/** 当前测试用户；undefined 表示 getWXContext 连 OPENID 字段都不返回（模拟身份缺失） */
let currentOpenid = 'oA';
let installed = false;
let originalLoad = null;
/** 故障注入：让某个集合的 doc.get/update 抛指定错误（用于测读故障降级/上抛） */
let fault = null;

function proxyCollection(name) {
  const real = fake.db.collection(name);
  if (!fault || fault.collection !== name) return real;
  if (fault.method === 'collection') throw fault.error;
  return Object.assign({}, real, {
    doc(id) {
      const doc = real.doc(id);
      if (fault.method === 'get') {
        return Object.assign({}, doc, {
          async get() { throw fault.error; },
        });
      }
      if (fault.method === 'update') {
        return Object.assign({}, doc, {
          async update() { throw fault.error; },
        });
      }
      return doc;
    },
  });
}

const proxyDb = {
  collection: (name) => proxyCollection(name),
  command: {
    in: (values) => fake.db.command.in(values),
    lt: (value) => fake.db.command.lt(value),
    lte: (value) => fake.db.command.lte(value),
    inc: (value) => fake.db.command.inc(value),
  },
  runTransaction: (fn) => fake.db.runTransaction(fn),
};

const wxStub = {
  DYNAMIC_CURRENT_ENV: 'test-env',
  init() {},
  getWXContext: () => (currentOpenid === undefined ? {} : { OPENID: currentOpenid }),
  database: () => proxyDb,
};

function install() {
  if (installed) return;
  installed = true;
  originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'wx-server-sdk') return wxStub;
    return originalLoad.call(this, request, parent, isMain);
  };
}

/** 还原 require 钩子（同一进程里想恢复真实 SDK 行为时用；测试文件通常不需要） */
function uninstall() {
  if (!installed) return;
  Module._load = originalLoad;
  originalLoad = null;
  installed = false;
}

function createHarness() {
  install();
  // 每个夹具从干净库开始，避免用例漏掉 reset 时串状态
  fake = makeFakeDb({});
  currentOpenid = 'oA';
  fault = null;
  const api = require('../../cloudfunctions/api/index');
  const handlers = require('../../cloudfunctions/api/handlers');
  return {
    main(event) {
      return api.main(event);
    },
    /** 以指定 openid 调用入口（相当于换一个微信账号发请求） */
    callAs(openid, action, payload) {
      currentOpenid = openid;
      return api.main({ action, payload });
    },
    setOpenid(openid) {
      currentOpenid = openid;
    },
    /** 换一个全新的假库；initial 形状同 makeFakeDb({ users: [...], ... }) */
    reset(initial, openid) {
      fake = makeFakeDb(initial || {});
      currentOpenid = openid === undefined ? 'oA' : openid;
      fault = null;
    },
    /**
     * 注入故障：{ collection:'users', method:'get'|'update'|'collection', error }；传 null 清除。
     * method 写错时直接抛错，避免用例因为没注入成功而假通过。
     */
    setFault(next) {
      if (next) {
        const methods = ['get', 'update', 'collection'];
        if (methods.indexOf(next.method) === -1) {
          throw new Error('setFault: unknown method ' + next.method
            + '（可选 ' + methods.join('/') + '）');
        }
      }
      fault = next || null;
    },
    fake() {
      return fake;
    },
    handlers,
  };
}

/** 收集 console.error，测试结束自动还原 */
function captureConsoleError(t) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => { calls.push(args); };
  t.after(() => { console.error = original; });
  return calls;
}

module.exports = { createHarness, captureConsoleError, uninstall };
