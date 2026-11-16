'use strict';

/**
 * 空状态组件（文档 8.4 / 8.5）：文案具体、可行动。
 * 只发 action 事件，不调用云函数；图标为可选扩展（文档只列 title/desc/actionText）。
 */
Component({
  properties: {
    title: {
      type: String,
      value: '',
    },
    desc: {
      type: String,
      value: '',
    },
    actionText: {
      type: String,
      value: '',
    },
    icon: {
      type: String,
      value: '',
    },
  },

  methods: {
    onAction() {
      this.triggerEvent('action');
    },
  },
});
