'use strict';

/**
 * 日记心情分值 1–5（文档 8.4，M13）。
 * - `value=0` 表示未选；点已选中的格子可以取消（载荷 score=0）；
 * - 组件不自持状态：只按 value 渲染、只发 change，页面是唯一状态拥有者；
 * - 五档颜色只做底色，emoji 与文字同时出现（8.9 不只靠颜色）。
 */
const constants = require('../../utils/constants');

Component({
  properties: {
    value: { type: Number, value: 0 },
    readonly: { type: Boolean, value: false },
  },

  data: {
    items: [],
    currentLabel: '',
  },

  observers: {
    value(value) {
      const current = Number(value) || 0;
      const items = constants.MOOD_SCALE.map((item) => ({
        score: item.score,
        label: item.label,
        emoji: item.emoji,
        color: item.color,
        on: item.score === current,
      }));
      const hit = constants.MOOD_SCALE.filter((item) => item.score === current)[0] || null;
      this.setData({ items, currentLabel: hit ? hit.label : '' });
    },
  },

  methods: {
    onTap(e) {
      if (this.data.readonly) return;
      const score = Number(e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.score) || 0;
      if (!score) return;
      const next = score === (Number(this.data.value) || 0) ? 0 : score;
      this.triggerEvent('change', { score: next });
    },
  },
});
