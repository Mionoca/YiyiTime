'use strict';

const time = require('../lib/time');

/** system.ping：M0 联调健康检查 */
async function ping(payload, ctx) {
  return {
    pong: true,
    serverNow: ctx.now.toISOString(),
    todayKey: time.dateKeyOf(ctx.now),
  };
}

module.exports = { ping };
