'use strict';

/**
 * 极简假云数据库：只实现 handler 用到的方法（doc get/update/set/remove、add、
 * where/orderBy/limit/get/count）。
 * 用于单测云函数逻辑，不依赖 wx-server-sdk。
 */
function makeFakeDb(initial) {
  let autoIdSeq = 0;
  /** 可选操作钩子：每次真实读/写前调用 onOperation(collection, op)，用于查询预算测试 */
  let operationHook = null;
  const notify = (name, op) => { if (operationHook) operationHook(name, op); };
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

  /** 目前只支持等值、command.in、command.lt、command.lte；文档没写的操作符先报错，避免静默误判 */
  function matchValue(actual, expected) {
    // Date 是标量不是查询操作符（等值查询会传 Date 对象）
    if (expected instanceof Date) return compare(actual, expected) === 0;
    if (expected && typeof expected === 'object' && Array.isArray(expected.$in)) {
      return expected.$in.indexOf(actual) !== -1;
    }
    if (expected && typeof expected === 'object' && expected.$lt !== undefined) {
      return compare(actual, expected.$lt) < 0;
    }
    if (expected && typeof expected === 'object' && expected.$lte !== undefined) {
      return compare(actual, expected.$lte) <= 0;
    }
    if (expected && typeof expected === 'object') {
      throw new Error('fake-db: unsupported query operator ' + JSON.stringify(expected));
    }
    return actual === expected;
  }

  /** 时间/日期/数字统一比较，模拟云数据库对 Date 与 'YYYY-MM-DD' 的排序 */
  function compare(a, b) {
    const av = a instanceof Date ? a.getTime() : new Date(a).getTime();
    const bv = b instanceof Date ? b.getTime() : new Date(b).getTime();
    if (Number.isFinite(av) && Number.isFinite(bv)) return av - bv;
    const as = String(a);
    const bs = String(b);
    return as < bs ? -1 : (as > bs ? 1 : 0);
  }

  const command = {
    in: (values) => ({ $in: values.slice() }),
    lt: (value) => ({ $lt: value }),
    lte: (value) => ({ $lte: value }),
    // 真实云开发 db.command.inc(n)：原子自增，用于避免读改写丢计数
    inc: (value) => ({ $inc: value }),
  };

  function collection(name) {
    return {
      doc(id) {
        return {
          async get() {
            notify(name, 'doc.get');
            const doc = storeOf(name).get(id);
            if (!doc) {
              // 与真实云开发一致：不存在时抛 errCode=-1，供 isDocumentMissing 判定
              const err = new Error('document.get:fail document not exists');
              err.errCode = -1;
              throw err;
            }
            return { data: clone(doc) };
          },
          async update({ data }) {
            notify(name, 'doc.update');
            const doc = storeOf(name).get(id);
            // 真实云开发 update 文档不存在时返回 stats.updated=0 而不抛错
            if (!doc) return { stats: { updated: 0 } };
            Object.keys(data || {}).forEach((key) => {
              const value = data[key];
              if (value && typeof value === 'object' && typeof value.$inc === 'number') {
                // 与真实 MongoDB 一致：对非数字字段 $inc 会报错（不存在按 0 处理）
                if (doc[key] !== undefined && typeof doc[key] !== 'number') {
                  throw new Error('Cannot apply $inc to a value of non-numeric type');
                }
                doc[key] = (doc[key] || 0) + value.$inc;
              } else {
                doc[key] = value;
              }
            });
            return { stats: { updated: 1 } };
          },
          async set({ data }) {
            notify(name, 'doc.set');
            storeOf(name).set(id, Object.assign({ _id: id }, clone(data)));
            return { _id: id };
          },
          async remove() {
            notify(name, 'doc.remove');
            const existed = storeOf(name).delete(id);
            return { stats: { removed: existed ? 1 : 0 } };
          },
        };
      },
      async add({ data }) {
        notify(name, 'add');
        if (data && data._id !== undefined && storeOf(name).has(data._id)) {
          // 真实云开发对显式 _id 重复会报错（bind_invites 用邀请码当 _id，靠它兜底冲突）
          const err = new Error('duplicate key _id: ' + data._id);
          err.errCode = -502001;
          throw err;
        }
        autoIdSeq += 1;
        const id = data && data._id !== undefined ? data._id : 'auto_' + autoIdSeq;
        storeOf(name).set(id, Object.assign({ _id: id }, clone(data)));
        return { _id: id };
      },
      where(cond) {
        const query = { cond: Object.assign({}, cond), orders: [], limit: 100 };
        const api = {
          where(next) {
            Object.assign(query.cond, next);
            return api;
          },
          orderBy(field, dir) {
            // 真实云开发支持链式 orderBy（多字段排序），这里按顺序比较
            query.orders.push({ field, dir });
            return api;
          },
          limit(n) {
            query.limit = n;
            return api;
          },
          async get() {
            notify(name, 'where.get');
            let rows = Array.from(storeOf(name).values()).filter((doc) =>
              Object.keys(query.cond).every((key) => matchValue(doc[key], query.cond[key])));
            // 注意：没有 orderBy 时保持插入顺序；真实云库的默认顺序未定义，
            // 依赖顺序的用例必须显式 orderBy，否则测试会掩盖生产问题
            if (query.orders.length) {
              rows.sort((a, b) => {
                for (const order of query.orders) {
                  const diff = compare(a[order.field], b[order.field]);
                  if (diff !== 0) return order.dir === 'desc' ? -diff : diff;
                }
                return 0;
              });
            }
            return { data: rows.slice(0, query.limit).map(clone) };
          },
          async count() {
            notify(name, 'where.count');
            const rows = Array.from(storeOf(name).values()).filter((doc) =>
              Object.keys(query.cond).every((key) => matchValue(doc[key], query.cond[key])));
            return { total: rows.length };
          },
        };
        return api;
      },
    };
  }

  /**
   * 简化的云开发事务：同一份存储上执行回调，抛错时整体回滚。
   * 深拷贝快照用 structuredClone（保留 Date，嵌套数组/对象也一起回滚）。
   * 注意：不模拟真实 SDK 的并发隔离与事务冲突自动重试（默认 3 次），
   * 所以测试覆盖的是「单次执行失败回滚」，不是并发冲突重试。
   */
  async function runTransaction(fn) {
    const snapshot = new Map();
    for (const [name, store] of stores) {
      snapshot.set(name, new Map(Array.from(store, ([id, doc]) => [id, structuredClone(doc)])));
    }
    const restore = () => {
      stores.clear();
      for (const [name, store] of snapshot) {
        stores.set(name, new Map(Array.from(store, ([id, doc]) => [id, structuredClone(doc)])));
      }
    };
    try {
      return await fn({ collection });
    } catch (err) {
      restore();
      throw err;
    }
  }

  return {
    db: { collection, command, runTransaction },
    setOperationHook: (fn) => { operationHook = typeof fn === 'function' ? fn : null; },
    get: (name, id) => storeOf(name).get(id),
    all: (name) => Array.from(storeOf(name).values()),
  };
}

module.exports = { makeFakeDb };
