'use strict';

/**
 * 极简假云数据库：只实现 handler 用到的方法（doc get/update/set、where/orderBy/limit/get）。
 * 用于单测云函数逻辑，不依赖 wx-server-sdk。
 */
function makeFakeDb(initial) {
  const stores = new Map();
  const storeOf = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  Object.keys(initial || {}).forEach((name) => {
    (initial[name] || []).forEach((doc) => {
      storeOf(name).set(doc._id, Object.assign({}, doc));
    });
  });

  const clone = (doc) => Object.assign({}, doc);

  /** 目前只支持等值与 command.in；文档没写的操作符先报错，避免静默误判 */
  function matchValue(actual, expected) {
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.indexOf(actual) !== -1;
    }
    if (expected && typeof expected === 'object') {
      throw new Error('fake-db: unsupported query operator ' + JSON.stringify(expected));
    }
    return actual === expected;
  }

  const command = {
    in: (values) => ({ $in: values.slice() }),
  };

  function collection(name) {
    return {
      doc(id) {
        return {
          async get() {
            const doc = storeOf(name).get(id);
            if (!doc) throw new Error('document.get:fail document not exists');
            return { data: clone(doc) };
          },
          async update({ data }) {
            const doc = storeOf(name).get(id);
            if (!doc) throw new Error('document.update:fail document not exists');
            Object.assign(doc, data);
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            storeOf(name).set(id, Object.assign({ _id: id }, clone(data)));
            return { _id: id };
          },
        };
      },
      where(cond) {
        const query = { cond: Object.assign({}, cond), order: null, dir: 'asc', limit: 100 };
        const api = {
          where(next) {
            Object.assign(query.cond, next);
            return api;
          },
          orderBy(field, dir) {
            query.order = field;
            query.dir = dir;
            return api;
          },
          limit(n) {
            query.limit = n;
            return api;
          },
          async get() {
            let rows = Array.from(storeOf(name).values()).filter((doc) =>
              Object.keys(query.cond).every((key) => matchValue(doc[key], query.cond[key])));
            if (query.order) {
              const key = query.order;
              rows.sort((a, b) => {
                const av = new Date(a[key]).getTime();
                const bv = new Date(b[key]).getTime();
                return query.dir === 'desc' ? bv - av : av - bv;
              });
            }
            return { data: rows.slice(0, query.limit).map(clone) };
          },
        };
        return api;
      },
    };
  }

  return {
    db: { collection, command },
    get: (name, id) => storeOf(name).get(id),
    all: (name) => Array.from(storeOf(name).values()),
  };
}

module.exports = { makeFakeDb };
