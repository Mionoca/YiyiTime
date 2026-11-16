'use strict';

/**
 * 愿望条目（文档 8.4 / 9.9 / 9.7）：只发事件 toggle / edit / remove。
 * 打勾成功时由 done 变化触发一次 300ms 弹跳（scale .9 → 1.1 → 1），动画结束立刻移除 class，
 * 不永久挂着 class（文档 9.7）。
 */
Component({
  properties: {
    wish: { type: Object, value: null },
    disabled: { type: Boolean, value: false },
  },

  data: {
    done: false,
    title: '',
    note: '',
    bouncing: false,
  },

  observers: {
    wish(wish) {
      if (!wish) {
        this._lastDone = undefined;
        this.setData({ done: false, title: '', note: '', bouncing: false });
        return;
      }
      const done = !!wish.done;
      // 只有「从没完成变成完成」才弹跳一次；首屏加载已完成项不播（文档 9.7）
      const bouncing = done && this._lastDone === false;
      this._lastDone = done;
      this.setData({
        done,
        title: wish.title || '',
        note: wish.note || '',
        bouncing,
      });
      if (bouncing) {
        clearTimeout(this._bounceTimer);
        this._bounceTimer = setTimeout(() => this.setData({ bouncing: false }), 320);
      }
    },
  },

  lifetimes: {
    detached() {
      clearTimeout(this._bounceTimer);
    },
  },

  methods: {
    onToggle() {
      if (this.data.disabled || !this.data.wish) return;
      this.triggerEvent('toggle', {
        wishId: this.data.wish.wishId,
        done: !this.data.wish.done,
      });
    },

    onEdit() {
      if (this.data.disabled || !this.data.wish) return;
      this.triggerEvent('edit', { wish: this.data.wish });
    },

    onRemove() {
      if (this.data.disabled || !this.data.wish) return;
      this.triggerEvent('remove', { wishId: this.data.wish.wishId });
    },
  },
});
