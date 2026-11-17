'use strict';

/**
 * 订阅提醒（文档 F9 / 7.15）。
 *
 * 一句话说明它是什么：**给自己开的「该报平安了」闹钟**。
 *
 * 为什么不是「提醒对方」：微信订阅消息是一次性授权，用户每点一次同意只换一条下发额度。
 * 让 A 攒额度去提醒 B，等于用 A 的授权给 B 发消息——B 没同意过，收到只会莫名其妙，
 * 而且一旦被投诉，模板会被封。所以额度只用来提醒**攒额度的那个人自己**：
 * 到点了他还没报平安，就给他发一条「今天还没给 TA 报平安」。
 *
 * 关键约束（文档 7.15）：
 * - 模板 ID 在没有配置时，所有「发」的路径都安静地不做任何事（`reminder.get` 会告诉
 *   前端 `configured: false`，页面据此禁用开关），绝不抛错让定时任务变红；
 * - 一天最多一条（`reminderLastSentDate`），配额用完就停；用户拒收（43101）直接关开关；
 * - 定时任务不依赖 cron 的时区：每 10 分钟跑一次，按东八区当前时间与用户设定的
 *   `reminderAt` 比较，所以 cron 写 UTC 还是东八区都只影响「早几分钟/晚几分钟」。
 */

const { AppError } = require('../lib/errors');
const validate = require('../lib/validate');
const time = require('../lib/time');

/** 模板 ID 从环境变量读（控制台改环境变量比改代码安全），没配就是空串 */
const TEMPLATE_PAGE = 'pages/safety/index';
const DEFAULT_AT = '21:00';

/**
 * 模板数据。**字段名必须和你选的模板关键词一致**，否则微信返回 47003。
 * 默认按「待办提醒 / 打卡提醒」类模板的两个关键词写：thing（事项）+ time（时间），
 * 换模板时只改这里。
 */
function templateData(user) {
  return {
    thing1: { value: '今天还没给 TA 报平安' },
    time2: { value: time.normalizeHhmm(user && user.reminderAt) || DEFAULT_AT },
  };
}

/** 一次性授权最多攒 7 条：够一周，也不至于让用户点一大堆同意 */
const QUOTA_MAX = 7;
/** 定时任务单批上限（云函数单次 get 上限 100）；用户量大了再加 skip 分页 */
const BATCH_MAX = 100;
/**
 * 「到点」窗口：cron 每 10 分钟一次，给 30 分钟余量——某次 tick 因故障错过时，
 * 下一个 tick 仍然会补发；超过 30 分钟就不补了（22:00 才提醒「该报平安」已经没意义）。
 * 跨天也靠它：23:55 的提醒，次日 00:00 的 tick 差 5 分钟，仍然算到点。
 */
const DUE_WINDOW_MIN = 30;
/** 这些错误是「配置错」而不是「这次运气不好」，今天不再重试，明天再说 */
const PERMANENT_ERR_CODES = ['47003', '40003', '40037'];

function templateId() {
  return String(process.env.YIYI_REMINDER_TEMPLATE_ID || '').trim();
}

/** 惰性拿 SDK：单测没有装 wx-server-sdk，直接 require 会炸 */
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

function minutesOf(hhmm) {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
}

/** 到点窗口内返回 true（含跨天：23:55 → 次日 00:00 算到点） */
function isDue(at, hhmm) {
  let diff = minutesOf(hhmm) - minutesOf(at);
  if (diff < 0) diff += 1440;
  return diff < DUE_WINDOW_MIN;
}

/**
 * 先占位再发送：事务内重读 users，确认「今天还没发、还开着、还有额度」后才写
 * `reminderLastSentDate = today`。并发两次 tick（云端重试 / 手动触发）只有一次能占到，
 * 「一天最多一条」才真的成立——发送本身是不可撤销的，靠发送后再去重已经晚了。
 *
 * 返回 original 供「瞬时失败」时把占位还回去（下一个窗口重试）。
 */
async function claimToday(db, openid, todayKey, now) {
  const out = { claimed: false, original: null };
  try {
    await db.runTransaction(async (transaction) => {
      const doc = (await transaction.collection('users').doc(openid).get()).data;
      if (!doc || !doc.reminderEnabled) return;
      if (doc.reminderLastSentDate === todayKey) return;
      if (Math.max(0, Number(doc.reminderQuota) || 0) <= 0) return;
      out.original = doc.reminderLastSentDate || null;
      await transaction.collection('users').doc(openid).update({
        data: { reminderLastSentDate: todayKey, reminderUpdatedAt: now },
      });
      out.claimed = true;
    });
  } catch (err) {
    console.error('[reminder]', JSON.stringify({
      reason: 'claim-failed',
      openidTail: String(openid || '').slice(-6),
      code: String((err && (err.code || err.errCode)) || ''),
      message: err && err.message,
    }));
    return { claimed: false, original: null };
  }
  return out;
}

/** users 里的提醒字段 → 出参。字段缺失/脏数据都要能降级成默认值 */
function view(user) {
  const quota = Math.max(0, Number(user && user.reminderQuota) || 0);
  return {
    // 模板 ID 不是秘密（客户端调 requestSubscribeMessage 本来就要传），
    // 放在这里可以让「配模板」只有云函数环境变量一个地方，避免客户端再存一份
    templateId: templateId(),
    configured: !!templateId(),
    enabled: !!(user && user.reminderEnabled),
    remindAt: time.normalizeHhmm(user && user.reminderAt) || DEFAULT_AT,
    quota: Math.min(quota, QUOTA_MAX),
    quotaMax: QUOTA_MAX,
    defaultTime: DEFAULT_AT,
  };
}

/** 今天是否已经报过平安：只有绑定了才有意义 */
async function checkedInToday(ctx) {
  if (!ctx.couple || !ctx.couple._id) return false;
  const todayKey = time.dateKeyOf(ctx.now);
  const res = await ctx.db.collection('safety_checkins')
    .where({ coupleId: ctx.couple._id, openid: ctx.openid, date: todayKey })
    .count();
  return !!(res && res.total > 0);
}

async function buildView(ctx) {
  return Object.assign(view(ctx.user), {
    bound: !!(ctx.couple && ctx.couple.status === 'active'),
    todayKey: time.dateKeyOf(ctx.now),
    checkedInToday: await checkedInToday(ctx),
  });
}

async function get(payload, ctx) {
  return buildView(ctx);
}

/**
 * 保存设置。开启提醒必须先绑定——提醒的内容是「给 TA 报平安」，
 * 单身状态下开这个开关没有任何可执行的下一步。
 */
async function set(payload, ctx) {
  const p = validate.asObject(payload);
  const enabled = validate.boolean(p.enabled, '提醒开关');
  if (enabled) ctx.requireBound();

  const data = { reminderEnabled: enabled, reminderUpdatedAt: ctx.now };
  if (p.remindAt !== undefined && p.remindAt !== null) {
    const at = time.normalizeHhmm(p.remindAt);
    if (!at) throw new AppError('INVALID_INPUT', '提醒时间格式不对');
    data.reminderAt = at;
  }

  await ctx.db.collection('users').doc(ctx.openid).update({ data });
  return buildView(Object.assign(ctx, { user: Object.assign({}, ctx.user, data) }));
}

/**
 * 客户端拿到订阅授权结果（accept）后上报，攒一次下发额度。
 * 这里只加不校验来源：授权本身由微信判定，客户端伪造一次 grant 最多让自己多一条
 * 提醒额度——没有越权价值，但要卡上限（QUOTA_MAX）。
 */
async function grant(payload, ctx) {
  const current = Math.max(0, Number(ctx.user.reminderQuota) || 0);
  const next = Math.min(current + 1, QUOTA_MAX);
  if (next !== current) {
    await ctx.db.collection('users').doc(ctx.openid).update({
      data: { reminderQuota: next, reminderUpdatedAt: ctx.now },
    });
  }
  return buildView(Object.assign(ctx, { user: Object.assign({}, ctx.user, { reminderQuota: next }) }));
}

/**
 * 定时任务：把「到点、有额度、今天还没报平安、今天还没发过」的人挑出来发一条。
 * 不是 action（handlers/index.js 不导出它），客户端传 `action: 'reminder.tick'`
 * 会得到 UNKNOWN_ACTION。
 */
async function runTimer(options) {
  const opts = options || {};
  const now = opts.now instanceof Date && !isNaN(opts.now.getTime()) ? opts.now : new Date();
  const todayKey = time.dateKeyOf(now);
  const hhmm = time.hhmmOf(now);
  const result = {
    trigger: String(opts.trigger || ''), todayKey, hhmm,
    scanned: 0, sent: 0, skipped: 0, failed: 0, rejected: 0,
    reason: '',
  };

  if (!templateId()) {
    result.reason = 'template-not-configured';
    return result;
  }

  const cloud = sdk();
  if (!cloud || !cloud.openapi || !cloud.openapi.subscribeMessage) {
    result.reason = 'openapi-unavailable';
    return result;
  }
  const db = cloud.database();

  // 只按开关做等值查询（走索引），时间与去重在内存里判断：单批 100 人，
  // 这点计算量远小于多建两条索引的维护成本
  const res = await db.collection('users')
    .where({ reminderEnabled: true })
    .orderBy('_id', 'asc')
    .limit(BATCH_MAX)
    .get();
  const users = (res && res.data) || [];
  result.scanned = users.length;

  for (const user of users) {
    const at = time.normalizeHhmm(user.reminderAt) || DEFAULT_AT;
    if (!isDue(at, hhmm)) continue;                          // 还没到点（或已过窗口）
    if (!user.coupleId) { result.skipped += 1; continue; }   // 解绑后不再打扰
    if (user.reminderLastSentDate === todayKey) { result.skipped += 1; continue; }
    if (Math.max(0, Number(user.reminderQuota) || 0) <= 0) { result.skipped += 1; continue; }

    // 已报平安就别再叫了
    const cnt = await db.collection('safety_checkins')
      .where({ coupleId: user.coupleId, openid: user.openid, date: todayKey })
      .count();
    if (cnt && cnt.total > 0) { result.skipped += 1; continue; }

    const claim = await claimToday(db, user._id, todayKey, now);
    if (!claim.claimed) { result.skipped += 1; continue; }

    try {
      const sent = await cloud.openapi.subscribeMessage.send({
        touser: user.openid,
        templateId: templateId(),
        page: TEMPLATE_PAGE,
        data: templateData(user),
      });
      if (Number(sent && sent.errCode) !== 0) {
        const err = new Error(sent.errMsg || 'send failed');
        err.errCode = sent.errCode;
        throw err;
      }
      result.sent += 1;
      // 扣额度用 inc：这中间用户可能刚好又攒了一条，绝对写会把那次 grant 覆盖掉
      await db.collection('users').doc(user._id).update({
        data: { reminderQuota: db.command.inc(-1), reminderUpdatedAt: now },
      });
    } catch (err) {
      const code = String((err && (err.errCode || err.code)) || '');
      if (code === '43101') {
        // 用户拒收：别再发了，额度也归零（再发只会继续被拒）
        result.rejected += 1;
        await db.collection('users').doc(user._id).update({
          data: { reminderEnabled: false, reminderQuota: 0, reminderUpdatedAt: now },
        });
      } else if (PERMANENT_ERR_CODES.indexOf(code) !== -1) {
        // 模板参数错 / openid 无效：配置问题，今天不再重试（保留占位），明天再说
        result.failed += 1;
        console.error('[reminder]', JSON.stringify({
          reason: 'send-failed-permanent',
          openidTail: String(user.openid || '').slice(-6),
          code,
          message: err && err.message,
        }));
      } else {
        // 瞬时错误（网络 / 频率限制）：把占位还回去，下个窗口重试
        result.failed += 1;
        await db.collection('users').doc(user._id).update({
          data: { reminderLastSentDate: claim.original, reminderUpdatedAt: now },
        });
        console.error('[reminder]', JSON.stringify({
          reason: 'send-failed',
          openidTail: String(user.openid || '').slice(-6),
          code,
          message: err && err.message,
        }));
      }
    }
  }

  return result;
}

module.exports = { get, set, grant, runTimer };
