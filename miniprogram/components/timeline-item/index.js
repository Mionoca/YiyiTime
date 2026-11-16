'use strict';

/**
 * 报平安时间线的一条（文档 8.4 / 9.9）：只展示，不发事件。
 * isMine 决定左右与强调色（文档 8.3.5）；昵称/头像/时间都用接口返回值。
 */
const timeUtil = require('../../utils/time');
const DEFAULT_AVATAR = require('../../utils/constants').DEFAULT_AVATAR;

Component({
  properties: {
    item: { type: Object, value: null },
    isMine: { type: Boolean, value: false },
  },

  data: {
    avatar: DEFAULT_AVATAR,
    nickname: '',
    timeText: '',
    note: '',
    emptyText: '',
  },

  observers: {
    'item, isMine': function (item, isMine) {
      if (!item) {
        this.setData({ avatar: DEFAULT_AVATAR, nickname: '', timeText: '', note: '', emptyText: '' });
        return;
      }
      this.setData({
        avatar: item.avatarFileID || DEFAULT_AVATAR,
        nickname: item.nickname || (isMine ? '我' : 'TA'),
        timeText: timeUtil.formatTime(item.createdAt, timeUtil.todayKey()),
        note: item.note || '',
        emptyText: isMine ? '我到家了' : 'TA 到家了',
      });
    },
  },
});
