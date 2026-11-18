'use strict';

/**
 * 成长任务的订阅提醒（文档 7.18 末节 / 增补稿 3.3）。
 *
 * 一句话说明它是什么：**事件驱动的一次性提醒**——A 起草任务就提醒 B「该认领了」，
 * 有人标记完成就提醒另一个人「该写收获了」。
 *
 * 为什么只能这样发：微信订阅消息只能发给**点过授权的那个人**，所以语义固定为
 * 「谁需要行动就提醒谁、扣谁的额度」。A 攒的额度不能用来提醒 B，否则 B 没同意过、
 * 收到只会莫名其妙，模板也有被封的风险（M10 报平安提醒踩过同样的坑）。
 *
 * 与 `reminder.js` 的差别：
 * - 不走定时器——事件发生在 `growth.add` / `growth.done` 落库成功的那一瞬间，
 *   即时发送比轮询更准，也不会占用 `reminder-tick`；
 * - 模板**不与报平安共用**：订阅授权与额度都按模板计，共用一个模板会让任务事件
 *   把报平安的额度吃光；
 * - 不做事务占位：只发一次、没有重试窗口，最坏情况是「额度扣了没发出去」，日志可查。
 *
 * 铁律（文档 7.18）：**任何失败都不能打断业务**。本文件对外只暴露 `notify`，
 * 它内部吞掉所有异常并返回结果对象，调用方（growth handler）不 await 结果做分支。
 */

const time = require('./time');
const dbUtil = require('./db-util');
const pause = require('../handlers/pause');

/** 点开订阅消息落到「一起变好」页（M11.4 上线后才有；此时模板通常也还没配） */
const TEMPLATE_PAGE = 'pages/growth/index';
/** 一次授权攒一条，封顶 7：够一周，也不至于让用户点一大堆同意（与报平安同规则） */
const QUOTA_MAX = 7;
/** 每人每天最多 3 条：事件提醒比每日提醒频繁，必须有防骚扰闸 */
const DAILY_MAX = 3;

/**
 * 文案固定、不带任务标题。
 * `thing` 字段限 20 字，而标题最长 30 字，塞进去必然 47003（模板参数超长）。
 */
const TEXT = {
  draft: 'TA 起草了新任务，等你认领',
  done: '一起的事完成了，写句收获吧',
};

function templateId() {
  return String(process.env.YIYI_GROWTH_TEMPLATE_ID || '').trim();
}

function configured() {
  return !!templateId();
}

/** 惰性拿 SDK：单测没有装 wx-server-sdk，顶层 require 会炸 */
let sdkRef = null;
function sdk() {
  if (sdkRef) return sdkRef;
  try {
    sdkRef = require('wx-server-sdk');
  } catch (err) {
    return null;
  }
  return sdkRef;
}

/** 模板数据：字段名必须和所选模板关键词一致，否则微信返回 47003（同 reminder.templateData） */
function templateData(kind, now) {
  return {
    thing1: { value: TEXT[kind] || TEXT.draft },
    time2: { value: time.hhmmOf(now) },
  };
}

async function readUser(db, openid) {
  try {
    const res = await db.collection('users').doc(openid).get();
    return (res && res.data) || null;
  } catch (err) {
    if (dbUtil.isDocumentMissing(err)) return null;
    throw err;
  }
}

/**
 * 发一条任务提醒给对方。
 *
 * @param {object} ctx  buildContext 的产物（用 ctx.db / ctx.now / ctx.couple）
 * @param {object} opts { kind: 'draft' | 'done', toOpenid }
 * @returns {Promise<{sent:boolean, reason:string}>} 只用于测试与调试，业务侧不看
 */
async function notify(ctx, opts) {
  const options = opts || {};
  const kind = options.kind === 'done' ? 'done' : 'draft';
  const out = { sent: false, reason: '' };
  // 只有真的扣过额度才允许退还：读库失败、暂停判断抛错都发生在扣款之前，
  // 那时候「还额度」会凭空多给一条（额度只增不减，越用越多）
  let deducted = false;

  try {
    if (!configured()) { out.reason = 'template-not-configured'; return out; }

    const toOpenid = options.toOpenid;
    if (!toOpenid) { out.reason = 'no-recipient'; return out; }
    if (toOpenid === ctx.openid) { out.reason = 'self'; return out; }

    const cloud = sdk();
    if (!cloud || !cloud.openapi || !cloud.openapi.subscribeMessage) {
      out.reason = 'openapi-unavailable';
      return out;
    }

    const user = await readUser(ctx.db, toOpenid);
    if (!user) { out.reason = 'user-missing'; return out; }
    if (!user.coupleId) { out.reason = 'recipient-unbound'; return out; }
    if (Math.max(0, Number(user.growthSubQuota) || 0) <= 0) { out.reason = 'no-quota'; return out; }

    const todayKey = time.dateKeyOf(ctx.now);
    // 跨天自然重置：不是今天的计数按 0 算
    const sentToday = user.growthSubSentDate === todayKey
      ? Math.max(0, Number(user.growthSubSentCount) || 0)
      : 0;
    if (sentToday >= DAILY_MAX) { out.reason = 'daily-limit'; return out; }

    // 刹车优先：吵架期间别弹「来认领任务」（与 runTimer 静音同一条规则）
    if (await pause.isOngoing(ctx.db, user.coupleId, ctx.now)) {
      out.reason = 'paused';
      return out;
    }

    // 先扣额度再发：发送不可撤销，先扣可以保证「额度用光了就不会再发」；
    // 用 inc 而不是绝对写，避免把这期间用户刚攒的那条覆盖掉
    await ctx.db.collection('users').doc(toOpenid).update({
      data: { growthSubQuota: ctx.db.command.inc(-1) },
    });
    deducted = true;

    const sent = await cloud.openapi.subscribeMessage.send({
      touser: toOpenid,
      templateId: templateId(),
      page: TEMPLATE_PAGE,
      data: templateData(kind, ctx.now),
    });
    if (Number(sent && sent.errCode) !== 0) {
      const err = new Error((sent && sent.errMsg) || 'send failed');
      err.errCode = sent && sent.errCode;
      throw err;
    }

    out.sent = true;
    out.reason = 'sent';
    // 发送成功才计数：失败的不占当天的 3 条名额。
    // 这一步失败**不能再退额度**（消息已经发出去了），只记日志——
    // 最坏情况是当天少记一条，多条性由「发了就发一条」本身兜底。
    try {
      await ctx.db.collection('users').doc(toOpenid).update({
        data: { growthSubSentDate: todayKey, growthSubSentCount: sentToday + 1 },
      });
    } catch (countErr) {
      console.error('[growth-sub]', JSON.stringify({
        reason: 'count-failed',
        openidTail: String(toOpenid || '').slice(-6),
        code: String((countErr && (countErr.errCode || countErr.code)) || ''),
      }));
    }
    return out;
  } catch (err) {
    const code = String((err && (err.errCode || err.code)) || '');
    out.reason = code === '43101' ? 'rejected' : 'send-failed';
    try {
      const toOpenid = options.toOpenid;
      if (toOpenid && deducted && code === '43101') {
        // 用户拒收：别再发了，额度归零（再发只会继续被拒）
        await ctx.db.collection('users').doc(toOpenid).update({ data: { growthSubQuota: 0 } });
      } else if (toOpenid && deducted) {
        // 其它错误（网络 / 频率限制 / 模板参数）：把刚扣的额度还回去
        await ctx.db.collection('users').doc(toOpenid).update({
          data: { growthSubQuota: ctx.db.command.inc(1) },
        });
      }
    } catch (rollbackErr) {
      // 还额度都失败说明库也不可用，只能留日志（额度少一条，不影响任何业务）
      console.error('[growth-sub]', JSON.stringify({
        reason: 'rollback-failed',
        code: String((rollbackErr && (rollbackErr.errCode || rollbackErr.code)) || ''),
      }));
    }
    // 只记 code 与 openid 尾号，**不打任务标题**（文档 11.8）
    console.error('[growth-sub]', JSON.stringify({
      reason: out.reason,
      kind,
      openidTail: String(options.toOpenid || '').slice(-6),
      code,
      message: err && err.message,
    }));
    return out;
  }
}

/** 自己当前的额度（给 growth.list 出参用，客户端据此决定要不要弹授权） */
function quotaOf(user) {
  return Math.min(Math.max(0, Number(user && user.growthSubQuota) || 0), QUOTA_MAX);
}

module.exports = { notify, configured, templateId, quotaOf, QUOTA_MAX, DAILY_MAX, TEMPLATE_PAGE, TEXT };
