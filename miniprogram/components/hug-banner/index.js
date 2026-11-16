'use strict';

/**
 * 抱抱横幅（文档 8.4 / 9.4 / 10.5）：只负责「TA 需要抱抱」这一种待处理状态。
 * 我发出 pending / 已回应 / 已过期由底部按钮文案 + 心形动画表达（文档 9.4 状态矩阵），
 * 不在场景里再叠一条横幅，避免和按钮重复。
 * 只发事件：respond({ hugId })；业务请求由页面处理。
 *
 * 保留 outgoing 属性是为了对齐文档 8.4 的组件契约，当前页不传也不会报错。
 */
Component({
  properties: {
    incoming: { type: Object, value: null },
    outgoing: { type: Object, value: null },
  },

  data: {
    visible: false,
    hugId: '',
  },

  observers: {
    incoming(incoming) {
      const hugId = (incoming && incoming.hugId) || '';
      this.setData({ visible: !!hugId, hugId });
    },
  },

  methods: {
    onRespond() {
      if (!this.data.hugId) return;
      this.triggerEvent('respond', { hugId: this.data.hugId });
    },
  },
});
