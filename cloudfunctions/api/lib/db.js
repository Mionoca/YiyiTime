'use strict';

const cloud = require('wx-server-sdk');

// 注意：本模块必须在 cloud.init 之后被 require（index.js 已保证顺序）
const db = cloud.database();

module.exports = { db };
