'use strict';

const validate = require('../lib/validate');
const time = require('../lib/time');
const { isDocumentMissing } = require('../lib/db-util');

/** 文档 7.6：四种心情，客户端不接受日期（日期一律服务端 todayKey） */
const MOODS = ['sunny', 'cloudy', 'rainy', 'thunder'];
const NOTE_MAX = 50;

/**
 * 心情打卡：按 _id = openid_date upsert，同一天重复调用是更新。
 * 返回 updatedAt 用本次请求时间（与写入值一致，避免再读一次）。
 */
async function set(payload, ctx) {
  const p = validate.asObject(payload);
  ctx.requireBound();

  const mood = validate.oneOf(p.mood, MOODS, 'mood');
  const note = validate.string(p.note, { field: 'note', max: NOTE_MAX });
  const coupleId = ctx.couple._id || ctx.user.coupleId;
  const date = time.dateKeyOf(ctx.now);
  const id = `${ctx.openid}_${date}`;

  let existing = null;
  try {
    existing = await ctx.db.collection('moods').doc(id).get();
  } catch (err) {
    if (!isDocumentMissing(err)) throw err;
  }
  if (existing && existing.data) {
    await ctx.db.collection('moods').doc(id).update({
      // coupleId 一并写：万一中途重新绑定，次日不会把旧关系的心情算到新关系头上
      data: { coupleId, mood, note, updatedAt: ctx.now },
    });
  } else {
    await ctx.db.collection('moods').doc(id).set({
      data: {
        coupleId,
        openid: ctx.openid,
        date,
        mood,
        note,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      },
    });
  }

  return {
    mood: {
      mood,
      note,
      date,
      updatedAt: ctx.now.toISOString(),
    },
  };
}

module.exports = { set, MOODS, NOTE_MAX };
