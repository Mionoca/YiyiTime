'use strict';

/**
 * 纪念日卡片堆叠（文档 8.4 / 9.4）。
 *
 * 职责边界：
 * - 只展示 + 发事件，不持有「当前是第几张」：`current` 由页面给，切换时发 `change`
 *   让页面改（页面才是唯一状态拥有者，静默刷新不会和组件内部状态打架）；
 * - 不认识「在一起」和自定义纪念日的差别：卡片的标题 / 主文案 / 副文案 / 脚注都由页面算好；
 * - 不调云函数、不读存储、不 import utils（日期文案一律页面给）。
 *
 * 层级只用 transform + opacity + z-index（文档 9.4）：卡片在 grid 里叠在同一格，
 * 不用绝对定位挪位置，否则容器高度会塌。
 */

/** 最多显示三层：当前 + 后两层（再往后的卡只是「存在」，不渲染） */
const MAX_VISIBLE = 3;
/** 左右滑动阈值 120rpx ≈ 60px（750 设计稿在 375pt 屏上的换算） */
const SWIPE_THRESHOLD_PX = 60;

Component({
  properties: {
    cards: { type: Array, value: [] },
    current: { type: Number, value: 0 },
  },

  data: {
    layers: [],
    count: 0,
    hasMany: false,
  },

  observers: {
    'cards, current': function render(cards, current) {
      const list = Array.isArray(cards) ? cards : [];
      const count = list.length;
      const index = count ? Math.min(Math.max(current | 0, 0), count - 1) : 0;

      const layers = [];
      const visible = Math.min(count, MAX_VISIBLE);
      for (let offset = 0; offset < visible; offset += 1) {
        const i = (index + offset) % count;
        const card = list[i] || {};
        layers.push({
          key: card.key || 'card-' + i,
          index: i,
          pos: offset, // 0 = 当前卡，1/2 = 后置层
          kind: card.kind || '',
          label: card.label || '',
          mainText: card.mainText || '',
          subText: card.subText || '',
          metaText: card.metaText || '',
        });
      }

      this.setData({ layers, count, hasMany: count > 1 });
    },
  },

  methods: {
    emitChange(next) {
      const count = this.data.count;
      if (count < 2) return;
      const index = ((next % count) + count) % count;
      if (index === this.data.current) return;
      this.triggerEvent('change', { index });
    },

    onPrev() {
      this.emitChange(this.data.current - 1);
    },

    onNext() {
      this.emitChange(this.data.current + 1);
    },

    onSelect(e) {
      const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {};
      const index = Number(dataset.index);
      if (!Number.isFinite(index)) return;
      this.emitChange(index);
    },

    /** 脚注「改日子 / 管理」：两个动作都交给页面，组件不判断当前卡是什么 */
    onEdit() {
      const card = this.data.layers[0] || {};
      this.triggerEvent('edit', { index: card.index, kind: card.kind });
    },

    onManage() {
      this.triggerEvent('manage', {});
    },

    onTouchStart(e) {
      const touch = (e && e.touches && e.touches[0]) || (e && e.changedTouches && e.changedTouches[0]);
      if (!touch) return;
      this._startX = touch.clientX;
      this._startY = touch.clientY;
    },

    onTouchEnd(e) {
      const touch = (e && e.changedTouches && e.changedTouches[0]) || (e && e.touches && e.touches[0]);
      if (!touch || typeof this._startX !== 'number') return;
      const dx = touch.clientX - this._startX;
      const dy = touch.clientY - this._startY;
      this._startX = undefined;
      // 竖直位移更大时说明用户在滚页面，不能劫持成切换（9.4）
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) <= Math.abs(dy)) return;
      if (dx < 0) this.onNext();
      else this.onPrev();
    },
  },
});
