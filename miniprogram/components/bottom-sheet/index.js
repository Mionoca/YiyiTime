'use strict';

/**
 * 底部弹层（文档 8.4 / 9.7）：props show / title / maskClosable，内容走 slot。
 * 只发事件 close；表单状态由页面自己持有，弹层关闭时页面负责决定是否清空。
 * mask 上 catchtouchmove 阻止背景滚动（文档 8.4）。
 */
Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    maskClosable: { type: Boolean, value: true },
  },

  methods: {
    onMaskTap() {
      if (!this.data.maskClosable) return;
      this.triggerEvent('close');
    },

    // 点弹层内部不关闭，也阻止冒泡到 mask
    onSheetTap() {},

    // catchtouchmove 的落点，避免背景跟着滚
    noop() {},
  },
});
