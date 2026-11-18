'use strict';

/**
 * 成长日志条目（文档 8.4 / 8.3.10）：纯展示，不发事件。
 * 解锁规则由服务端算好（7.18）：自己没写时 `partnerText` 为 null、
 * `partnerHint` 说明「TA 写了，你写完就能看」或「TA 还没写」。
 */
Component({
  properties: {
    entry: { type: Object, value: null },
  },
});
