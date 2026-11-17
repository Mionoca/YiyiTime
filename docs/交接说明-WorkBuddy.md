# 交接说明（WorkBuddy 接手用）

> 更新时间：2026-11-17 19:10（Asia/Shanghai）
> 仓库：`D:/大学/YiyiTime`　分支：`hjj`　当前 HEAD：以 `git ls-remote origin hjj` 为准（交接时先 `git pull origin hjj`）
> 单测基线：599 pass / 0 fail / 0 skip；`release-check`：21 PASS + 5 TODO + 0 FAIL + 1 WARN（工作区有未提交改动时才出现这条 WARN）；`check-secrets`：exit 0。

## 一、当前状态

- 代码侧 M0–M6 与 F1–F8 全部实现（历史轮次与每轮验证记录见 `docs/开发进度.md` → 六、变更记录）。
- 前两轮交付 **M7 心情记录时间线**（只读 `mood.list` + `pages/mood`）与 **M8 前端改版**（2 个 tab + 手绘涂鸦风）。
- 本轮交付 **M9：记账本 + 应用内解绑**（用户决定砍掉原计划的「见面基金」）：
  1. **记账本替代见面基金**：`F10` 改为「个人记账本」——各记各的花销，同时能切到 TA 的账本看（只读）。新集合 `ledger_entries`，字段 `openid`（归属人）/ `coupleId`（本段关系快照）/ `amount`（整数分）/ `category`（6 类）/ `note` / `date` / `month`（冗余，让按月查询变等值查询）/ `createdAt` / `updatedAt`；四个 action `ledger.add / update / remove / list`。`openid` 一律取 `ctx.openid`、`coupleId` 取 `relation.coupleIdOf(ctx)`——自己的账永远属于自己，伴侣只看得到本段关系期间的账，换绑后新伴侣看不到上一段。**个人账本不要求绑定**：`who=me` 与增删改都不调 `requireBound`，未绑定时 `coupleId` 落 `null`；只有 `who=partner` 才要绑定，`ledger.list` 出参的 `bound` 让页面收起「TA 的」分段。金额全程整数分（拒绝浮点 / 字符串 / NaN，1–1000000），每人每月 60 笔上限用 `count()` 前置校验（`update` 改到另一个月也要重查目标月），`list` 不分页、`summary` 按返回结果实时算。
  2. **应用内解绑（双方确认）**：`F11` 从「联系开发者」占位改成真功能。`couples` 加 `unbindStatus`（`none | pending | done`）/ `unbindRequestedBy` / `unbindRequestedAt` / `unbindConfirmedBy` / `unboundAt`，`status` 收为 `active | closed`；三个 action `couple.requestUnbind / cancelUnbind / confirmUnbind` 全部在 `runTransaction` 内重读再写（并发只写一次、对方已发起时返回 `requestedByMe: false`、自确认返回 `UNBIND_WAIT_PARTNER`），确认时一次事务写关系状态并清双方 `users.coupleId`；业务数据一条不删，后续读取由 `requireBound` 自然拦成 `NOT_BOUND`。
  3. **页面**：新增 `pages/ledger`（我的 / TA 的分段切换、月份 ‹ ›、合计卡、按天分组与小计、固定「记一笔」+ 底部表单、点 TA 的条目只提示）；「我的」删掉「见面基金（即将上线）」与「解绑（联系开发者）」两个占位，换成记账本入口 + 解绑三态（未申请 / 等 TA 确认可撤回 / TA 申请去确认）；首页只在「对方发起」时显示解绑提示条，点了 `switchTab` 去「我的」。
- 改动范围：**云函数**（新增 `handlers/ledger.js`、`handlers/couple.js` 加 3 个 action、`lib/relation.js` 加 `unbindView`、`handlers/home.js` 出参加 `unbind`、`handlers/index.js` 注册 7 个 action 共 31 个）；**小程序端**（新增 `pages/ledger/*`、`profile` 三态与入口、`home` 提示条、`utils/format.js` 加 `formatYuan` / `parseYuan`、`utils/time.js` 加 `monthOf` / `shiftMonthKey` / `formatMonthCN`、`utils/constants.js` 加 `ROUTES.ledger` + 记账 4 个 `LIMITS` + `LEDGER_CATEGORIES`、`app.json` 注册新页面）；**文档**（技术设计文档 1.3 / 2.4 / 2.5 / 5.3.2 / 5.3.9 / 5.4 / 5.5 / 5.6 / 5.7 / 6.5 / 7.13 / 7.14 / 8.2 / 8.3.6 / 8.3.8 / 9.2 / 11.9 / 14.9 / 16.2 / 16.3 / 16.4 / 16.8 全部同步，16.8 记 `v0.1.2`）。
- 验证记录：`node --test` **599 pass / 0 fail**（新增 `ledger` 18、`unbind` 7、`client-ledger` 17；`client-profile` 21、`client-home` 28、`server-authorization` 11、`e2e-page` 12；随动 `handler-boundary` 双人 action 24 → 31、`api-entry` 31 个 action、`limits-consistency` / `data-model` / `query-budget` / `pull-down` / `ui-standards` / `release-check` 集合白名单）；`release-check` 21 PASS + 5 TODO + 0 FAIL；`check-secrets` exit 0。
- 已知边界（不阻断）：`ledger.list` 不分页（60 笔/月一页放得下，超了写不进去）；60 笔是「先 count 再写」的软上限，两台设备真正同时提交可能写成 61；条目 id 用 `le_` + 16 位 hex，碰撞概率可忽略；解绑后 `unbindStatus` 停在 `done`，重新绑定会新建一条 `couples`（旧记录保留作历史）；`unbindConfirmedBy` 只在确认时写入，撤回后仍为 `null`；解绑后再调解绑接口返回的是 `NOT_BOUND`（`coupleId` 已清空，定位不到关系），客户端把它和 `UNBIND_NOT_PENDING` 一样当「没有待确认解绑」。

## 二、接手第一步

```bash
cd D:/大学/YiyiTime
git pull origin hjj
node --test
node scripts/release-check.js
node scripts/check-secrets.js
```

然后按顺序读：`docs/开发进度.md`（一、已完成 → M9 小节；二、已知缺口；三、手动操作；六、变更记录顶部）、`docs/M6-真机验收与发布.md`、`docs/技术设计文档.md`（5.3.9 `ledger_entries`、5.5 解绑状态机、7.13 / 7.14、8.3.8 记账本页、8.3.6 我的页、9.2 首页第 0 行）。

## 三、仍需用户手动完成的（卡真机验收）

1. 云开发控制台：按 `docs/M6-真机验收与发布.md` 建 **9 个集合**（M9 新增 `ledger_entries`）、配权限与索引（`ledger_entries`：`openid + month + date`、`openid + coupleId + month`）。**没建 `ledger_entries` 直接记账会失败。**
2. **部署顺序：先云函数、再小程序端。** `cloudfunctions/api` →「上传并部署：云端安装依赖」（超时 10s、内存 256MB）。本轮云函数改了（新增 `handlers/ledger.js`、`couple.*Unbind`、`home.get` 出参），必须重部署，否则记账本与解绑会报「这个操作还不存在」。
3. **小程序端要重新上传**：本轮新增 `pages/ledger/`，漏传会点进去白屏 / 报页面不存在。
4. 微信公众平台：配置《用户隐私保护指引》（头像、昵称用途）。
5. 微信开发者工具上传体验版，并把对方微信号加为体验成员。
6. 发布前在控制台导出一次数据库备份。
7. 真机看一眼：记账金额用数字键盘输入后换算是否正确（分/元）、切「TA 的」是否只读、月份往后翻到当前月是否停住、解绑三态文案是否清楚、首页提示条会不会挡到日子卡。

## 四、尚未完成的代码侧事项（按优先级）

1. **等用户真机验收反馈**：F1–F8 + 14.4 的 A/B 14 步 + `docs/M6-真机验收与发布.md` 第 2–4 节，以及本轮 F10 / F11 的验收标准（技术设计文档 2.5 节）。收到问题按 P0/P1 修。
2. 若继续做自动化加固（非阻塞）：`ledger.list` 的 `summary` 与按天分组由客户端算，页面级用例覆盖了但没做「同一秒两条账」的排序稳定性用例；解绑的并发边界（对方确认时自己正好撤回、两边同时确认）靠事务重读兜住，没有并发压测；`release-check` 客户端云访问边界只覆盖点号 / 括号普通字符串键。
3. 仍是 P1 的功能：订阅消息提醒（需模板与授权）、内容安全审核（公开传播前必须接 `msgSecCheck`）、账本的分类统计 / 月度趋势（当前只做合计）、导出。
4. 已实现功能的边界说明、已知偏差与手动项都记在 `docs/开发进度.md`，改功能时同步更新。

## 五、工作流约定（沿用）

- 文档先行：先改 `docs/技术设计文档.md`（字段表 / 接口契约 / 页面结构 / 错误码 / 集合表），再写代码，最后用契约测试把两边锁住。
- 每完成一个阶段或大功能：`node --test` 全量 + `node scripts/release-check.js` + `node scripts/check-secrets.js` 全绿 → 独立只读审查（只用读、不改仓）→ 修 P0/P1 → `git push origin hjj` → 更新 `docs/开发进度.md` 与 README 单测数。
- `docs/开发进度.md` 固定四处：`:4` 头部「当前完成」、单测合计与逐文件明细（在 M6 加固小节的测试段落里）、对应「一、已完成」bullet（本轮新增 M9 小节）、`六、变更记录` 顶部新条目；涉及 M6 计数时同步 `docs/M6-真机验收与发布.md`。
- commit：信息写入 `.git/yiyi-commit-rNN.txt`，`git commit -F`；push 前设 `HTTPS_PROXY=http://127.0.0.1:7890` / `HTTP_PROXY=http://127.0.0.1:7890`；push 后核对 `git rev-parse HEAD` 与 `git ls-remote origin hjj` 一致、工作区干净。
- 本机环境坑：跑 `node --test` / `release-check` 用 pwsh（run_code 内 PATH 缺 git 会让 check-secrets 用例 skip）；pwsh `*>` 重定向是 UTF-16LE；`scripts/release-check.js`、`cloudfunctions/api/handlers/hug.js`、`home.js` 是 CRLF，其余文档 / 测试是 LF；不要用 pwsh `Set-Content` 改文件（用 node:fs 并校验替换次数）；临时目录用显式 `D:/_yiyi_xxx`（bash 的 `/tmp` 与 Windows python 看到的 `/tmp` 不是同一个路径）。

## 六、关键文件索引

- 需求与验收：`docs/技术设计文档.md`（4200+ 行）、`docs/M6-真机验收与发布.md`。
- 进度与偏差：`docs/开发进度.md`（当前单测数、已完成功能、已知缺口、手动操作、变更记录）。
- 客户端入口：`miniprogram/utils/api.js`（唯一云函数调用入口）、`miniprogram/utils/constants.js`（`LIMITS` / `ROUTES` / `TAB_ROUTES` / `LEDGER_CATEGORIES` / `isTabRoute`）、`miniprogram/utils/tabbar.js`（tabBar 选中态同步）、`miniprogram/utils/format.js`（`formatYuan` / `parseYuan`，元↔分换算唯一实现）。
- 导航与样式：`miniprogram/app.json`（`tabBar.custom`）、`miniprogram/custom-tab-bar/`、`miniprogram/styles/tokens.wxss`、`miniprogram/app.wxss`（`dk-*` 公共类）。
- 记账本与解绑：`cloudfunctions/api/handlers/ledger.js`、`cloudfunctions/api/handlers/couple.js`（`*Unbind`）、`cloudfunctions/api/lib/relation.js`（`unbindView` / `coupleIdOf`）、`miniprogram/pages/ledger/`、`miniprogram/pages/profile/`（三态与入口）。
- 云函数入口：`cloudfunctions/api/index.js`，handler 在 `cloudfunctions/api/handlers/`。
- 测试夹具：`tests/helpers/cloud-entry.js`（云函数链路）、`tests/helpers/client-page.js`（页面 / 组件）、`tests/helpers/fake-db.js`（假库，含操作计数钩子）。
- 发布预检：`scripts/release-check.js`、`scripts/check-secrets.js`。
