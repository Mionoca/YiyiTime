'use strict';

/**
 * 任务池条目（文档 8.4 / 8.3.10）。
 * 只负责渲染 + 发事件，动作矩阵（canXxx）由页面算好（页面 derive 的约定同首页）。
 */
Component({
  properties: {
    task: { type: Object, value: null },
    disabled: { type: Boolean, value: false },
  },

  methods: {
    emit(name) {
      if (this.data.disabled || !this.data.task) return;
      this.triggerEvent(name, { task: this.data.task });
    },

    onConfirm() { this.emit('confirm'); },
    onDone() { this.emit('done'); },
    onHarvest() { this.emit('harvest'); },
    onReview() { this.emit('review'); },
    onEdit() { this.emit('edit'); },
    onRemove() { this.emit('remove'); },
  },
});
