# 交接说明（WorkBuddy 接手用）

> 更新时间：2026-11-18 22:40（Asia/Shanghai）
> 仓库：`D:/大学/YiyiTime`　分支：`hjj`　最新提交见 `git log -1 --oneline`（每轮都已推送，核对 `git rev-parse HEAD` 与 `git ls-remote origin hjj` 一致）
> 单测基线：741 pass / 0 fail / 0 skip；`release-check`：21 PASS + 7 TODO + 0 FAIL（工作区有未提交改动时多一条 WARN）；`check-secrets`：exit 0。

## 一、当前状态

- 代码侧 M0–M6 与 F1–F12 全部实现（历史轮次与每轮验证记录见 `docs/开发进度.md` → 六、变更记录）。
- 前几轮交付：**M7 心情记录时间线**（只读 `mood.list` + `pages/mood`）、**M8 前端改版**（手绘涂鸦风）、**M9 记账本 + 应用内解绑**、**M10 订阅提醒 + 内容安全**、**M11.0–M11.3**（主文档合并 v0.1.5 / v0.1.6、`pause` 服务端 + 首页便签客户端、`growth` 服务端九 action + 任务订阅提醒）。
- 本轮交付 **M12（文档 v0.1.4）**，三件事一起做（它们在首页与 tabBar 上互相牵连）：
  1. **抱一抱整体下线**：F5、`hugs` 集合、`hug.send|respond`、`hug-banner`、首页抱抱卡、心形上浮动画、头像心形角标、`hug_seen_ids` 本地记录、`HUG_*` 错误码一并删除。文档里相关段落是**直接删掉或重写**，只在 15.3 留一条决策记录说明为什么删（异步「打开时可见」让这个按钮点下去像没反应）。
  2. **自定义纪念日 + 卡片堆叠**：新集合 `anniversaries`（每对 8 条、允许未来日期、不落 `nextDate`/`daysLeft`）、`anniversary.add|update|remove|list`、`lib/time.js` 的 `yearlyOccurrence`（未来日期 `years=0`、2-29 平年按 2 月末）、`home.get` 的 `anniversary` 区块（查询预算 10 → 9 次）、新页面 `pages/anniversary`（增删改）、首页把「日子卡 + 抱抱卡」合并成一张**卡片堆叠**（`components/anniversary-stack`）。
  3. **记账本进 tabBar**：`app.json` / `custom-tab-bar` / `TAB_ROUTES` / `tabbar.INDEX` 四处同步成「今天 / 记账本 / 我的」，记账本页 `onShow` 同步选中态、底部留白 360rpx、「记一笔」抬到 tabBar 之上；「我的」里的重复入口与 `onOpenLedger` 删除。
- 堆叠的视觉约束（文档 9.4，改样式时别破坏）：偏移 ≤48rpx、缩放 ≥0.92、后置层同色不换底、只用 `transform`/`opacity`（400ms `cubic-bezier(0.22,1,0.36,1)`）、后置层 `pointer-events: none`、卡片数 ≤1 时不渲染箭头与圆点。
- 历史轮次 M10 的技术要点（仍然有效，改动提醒 / 审核时先看）：
  1. **订阅提醒（F9）**：语义从「提醒对方」改成**提醒自己** —— 微信订阅消息是一次性授权，用 A 的授权给 B 发消息，B 从没同意过，收到只会莫名其妙，模板还有被封风险。所以额度只用来提醒攒额度的那个人自己：到点还没报平安，就给他发一条「今天还没给 TA 报平安」。开关 / 时间 / 额度 / 最近发送日期都在 `users` 的 `reminder*` 五个字段里，**没有新建 `subscription_authorizations` 集合**（5.6 已删掉这条预留）—— `buildContext` 本来就读 `users`，放子字段让 `reminder.get` 零额外查询。三个 action：`reminder.get`（不要求绑定）、`reminder.set`（只有 `enabled: true` 才 `requireBound`）、`reminder.grant`（授权成功后 +1，封顶 7）。定时任务 `runTimer` 由 `config.json` 的 `reminder-tick`（每 10 分钟）触发，入口按 `event.Type === 'Timer'` 分流，**不注册成 action**（客户端传 `reminder.tick` 得到 `UNKNOWN_ACTION`）；判定顺序：模板未配 → 静默返回、没到点 / 今天已发 / 额度为 0 / 今天已报平安 → 跳过；发送成功扣额度写日期，43101（用户拒收）关开关清额度，其它错误不扣额度留到下一个窗口重试。不依赖 cron 时区，只比东八区 `HH:mm`。
  2. **内容安全（F12）**：新增 `lib/security.js` 的 `assertText`，七个自由文本字段在写库前送 `security.msgSecCheck` v2 —— 昵称（scene 1）、心情备注 / 日记 / 愿望备注 / 报平安备注 / 记账备注（4）、愿望标题（3）。`risky` 与 `review` 都抛 `CONTENT_RISKY`（这里没有人工复审环节，放过等于没人管）；**接口不可用时放行**（没有 `cloud.openapi`、`errCode` 非 0、1.5s 超时）并记 `[security]` 日志 —— 内容只在两个人之间可见、不是公开传播，审核服务抖动不能把写日记的路堵死。日志只记 `scene` / 长度 / `suggest` / `label`，不记原文。
  3. **页面**：「我的」页把「每日提醒（即将上线）」换成真实设置（`switch` + `time` picker + 剩余额度文案）。开启顺序严格是「先 `wx.requestSubscribeMessage` 拿授权 → `reminder.grant` 攒额度 → `reminder.set` 打开」，反了会出现「开关开着但永远发不出去」；拒绝授权开关回滚。`profile.load` 里 `reminder.get` 单独 `catch`，提醒设置挂了不影响整页。`couple.confirmUnbind` 事务内顺手关掉双方提醒开关。
- 改动范围（M12）：**云函数**（删 `handlers/hug.js`、新增 `handlers/anniversary.js`、`handlers/index.js` 36 个 action、`lib/time.js` 加 `yearlyOccurrence`、`lib/home-blocks.js` 换 `loadAnniversary`、`handlers/home.js` 字段换 `anniversary`、`scripts/release-check.js` 集合白名单）；**小程序端**（`app.json` 三 tab + 新页面、`custom-tab-bar`、`constants` / `tabbar`、`pages/home`、`pages/ledger`、`pages/profile`、`pages/anniversary`、`components/anniversary-stack` 新增、`components/hug-banner` 删除、`components/avatar-bubble` 去角标）；**文档**（技术设计文档 1.3 / 2.3–2.5 / 3.3–3.5 / 4.1 / 4.5 / 4.8 / 5.1–5.7 / 6.1 / 6.4–6.7 / 6.10 / 7.1 / 7.2 / 7.7 / 7.8 / 8.2–8.5 / 第 9 章 / 10.3 / 10.5 / 11.2 / 11.4 / 11.7 / 11.9 / 12.3 / 12.5 / 12.6 / 13.2 / 13.6 / 14.3 / 14.4 / 14.9 / 15.1–15.5 / 16.1–16.4 / 16.8，版本 v0.1.4）。
- 验证记录：`node --test tests/*.test.js` **662 pass / 0 fail**（删 `hug.test.js`、新增 `anniversary.test.js` 13 个 + `client-anniversary.test.js` 9 个；`components` / `home-derive` / `client-home` 里 15 个抱抱用例改写为堆叠与纪念日用例；15 个测试文件随动）；`release-check` 21 PASS + 7 TODO + 0 FAIL；`check-secrets` exit 0。
- 已知边界（不阻断）：订阅消息「攒授权」是微信能力的硬限制，用户只点一次授权就只够发一条，所以额度为 0 时不会发；`runTimer` 单批最多 100 人（云函数单次 `get` 上限），用户量大起来要补 `skip` 分页；模板关键词（默认 `thing1` / `time2`）必须和公众平台上选的模板一致，否则 47003，失败只记日志不扣额度；内容安全是 fail-open，微信接口整体挂掉时等于没审（靠日志发现）。M12 新增：纪念日 8 条上限是「先 count 再写」的软上限，两台设备同时提交可能多出 1 条；`hugs` 历史数据不再展示，需要的话自己导出。

## 二、接手第一步

```bash
cd D:/大学/YiyiTime
git pull origin hjj
node --test
node scripts/release-check.js
node scripts/check-secrets.js
```

然后按顺序读：`docs/开发进度.md`（一、已完成 → M12 小节；二、已知缺口；三、手动操作；六、变更记录顶部）、`docs/M6-真机验收与发布.md`、`docs/技术设计文档.md`（5.3.5 `anniversaries`、7.7 纪念日接口、7.8 `home.get`、8.3.9 纪念日管理页、9.4 卡片堆叠规格、8.2 三个 tab）。

## 三、仍需用户手动完成的（卡真机验收）

1. 云开发控制台：共 **11 个集合**——`users`、`couples`、`bind_invites`、`moods`、`anniversaries`、`safety_checkins`、`diaries`、`wishes`、`ledger_entries`、**`pauses`**、**`growth_tasks`**（全部「所有用户不可读写」；`pauses` 索引 `coupleId + status + startedAt` 倒序，`growth_tasks` 索引 `coupleId + status + createdAt`、`coupleId + status + archivedAt` 倒序）；**删除已下线的 `hugs`**（先导出备份）。**先建集合，再部署云函数** —— 云函数写不存在的集合会直接报错。
2. **部署顺序：先云函数、再小程序端。** `cloudfunctions/api` →「上传并部署：云端安装依赖」（超时 10s、内存 256MB）。本轮云函数改了（新增 `handlers/anniversary.js`、删 `handlers/hug.js`、`home.get` 返回 `anniversary`），不重部署会看到「这个操作还不存在」或首页缺纪念日区块。
3. **配订阅消息模板（可选，不配也能跑）**：两个模板 —— 报平安用 `YIYI_REMINDER_TEMPLATE_ID`，成长任务用 `YIYI_GROWTH_TEMPLATE_ID`（关键词分别对齐 `handlers/reminder.js` 与 `lib/growth-sub.js` 的 `templateData`，默认都是 `thing1` + `time2`，不一致微信返回 47003）。没配时「我的」页提醒开关是禁用态、定时任务与任务提醒都静默跳过（`growth.list` 的 `subConfigured` 为 false）。
4. **小程序端要重新上传**：`app.json`（三 tab + 新页面）、`custom-tab-bar`、`pages/home` / `ledger` / `profile`、新增的 `pages/anniversary` 与 `components/anniversary-stack` 都要传；漏传会出现「Component is not found」或底部只有两个 tab。
5. 微信公众平台：配置《用户隐私保护指引》（头像、昵称用途）。
6. 微信开发者工具上传体验版，并把对方微信号加为体验成员；发布前导出一次数据库备份。
7. 真机看一眼：提醒开关点开会弹订阅授权、拒绝后开关是否回弹、时间 picker 改完是否马上生效、到点是否真能收到消息（需要模板已配）、发一句明显违规的文本看是否被拦（`CONTENT_RISKY`）。

## 四、尚未完成的代码侧事项（按优先级）

1. **等用户真机验收反馈**：F1–F12 + 14.4 的 A/B 14 步 + `docs/M6-真机验收与发布.md` 第 2–4 节。收到问题按 P0/P1 修。
2. **M11 先停一下 + 一起变好（成长任务池）**：M11.0（主文档合并到 v0.1.7）、M11.1（`pause` 服务端）、M11.2（pause 客户端）、M11.3（`growth` 服务端九 action + 订阅提醒）、M11.4（`pages/growth` + 两个组件 + 首页成长卡 + 授权时机）**全部完成**；**只剩 M11.5 收尾回归**：`e2e-page` 扩展、真机 F13 / F14（`docs/M6-真机验收与发布.md` 的清单要补 F13 / F14 两段），以及 release-check 的真机项文案从 F1–F12 改成 F1–F14。
3. 唯一还剩的 P1 功能是 `diary.calendar`（心情 / 日记日历，7.12 的预留项），属于「可做可不做」的视觉增强。
4. 若继续做自动化加固（非阻塞）：`runTimer` 没有并发压测（同一分钟两个实例同时跑到同一个用户，靠 `reminderLastSentDate` 事后去重，理论上可能发两条）；`ledger.list` 的 `summary` 与按天分组由客户端算，「同一秒两条账」的排序稳定性没锁；解绑的并发边界靠事务重读兜住，没有压测。
5. 已实现功能的边界说明、已知偏差与手动项都记在 `docs/开发进度.md`，改功能时同步更新。

## 五、工作流约定（沿用）

- 文档先行：先改 `docs/技术设计文档.md`（字段表 / 接口契约 / 页面结构 / 错误码 / 集合表），再写代码，最后用契约测试把两边锁住。
- 每完成一个阶段或大功能：`node --test` 全量 + `node scripts/release-check.js` + `node scripts/check-secrets.js` 全绿 → 独立只读审查（只用读、不改仓）→ 修 P0/P1 → `git push origin hjj` → 更新 `docs/开发进度.md` 与 README 单测数。
- `docs/开发进度.md` 固定四处：`:4` 头部「当前完成」、单测合计与逐文件明细（在 M6 加固小节的测试段落里）、对应「一、已完成」bullet（本轮新增 M10 小节）、`六、变更记录` 顶部新条目。
- commit：信息写入 `.git/yiyi-commit-rNN.txt`，`git commit -F`；push 前设 `HTTPS_PROXY=http://127.0.0.1:7890` / `HTTP_PROXY=http://127.0.0.1:7890`；push 后核对 `git rev-parse HEAD` 与 `git ls-remote origin hjj` 一致、工作区干净。
- 本机环境坑：跑单测用 `node --test tests/*.test.js`（`node --test tests/` 在 Node 22 会把目录当模块，报 `Cannot find module`）；`release-check` / `check-secrets` 依赖 git（受限 PATH 下 check-secrets 用例会 skip）；`scripts/release-check.js`、`cloudfunctions/api/handlers/home.js` 是 CRLF，其余文档 / 测试是 LF（用 python 批量替换时要按文件判断换行符，否则多行锚点匹配不到）；临时目录用显式 `D:/_yiyi_xxx`。

## 六、关键文件索引

- 纪念日与堆叠（M12）：`cloudfunctions/api/handlers/anniversary.js`、`lib/time.js`（`yearlyOccurrence`）、`lib/home-blocks.js`（`loadAnniversary`）、`miniprogram/components/anniversary-stack/`、`miniprogram/pages/anniversary/`、`miniprogram/pages/home/index.js`（`buildCards` / `onCardChange`）。
- 需求与验收：`docs/技术设计文档.md`（4500+ 行）、`docs/M6-真机验收与发布.md`。
- M11 新功能规格：`docs/技术设计增补-M11-先停一下与成长任务池.md`（`pause` / `growth` 的字段表、action 契约、状态机、验收 F13 / F14；合并清单在其第 9 节）。
- 进度与偏差：`docs/开发进度.md`（当前单测数、已完成功能、已知缺口、手动操作、变更记录）。
- 客户端入口：`miniprogram/utils/api.js`（唯一云函数调用入口）、`miniprogram/utils/constants.js`（`LIMITS` / `ROUTES` / `TAB_ROUTES` / `LEDGER_CATEGORIES` / `isTabRoute`）、`miniprogram/utils/tabbar.js`、`miniprogram/utils/format.js`（元↔分换算唯一实现）。
- 订阅提醒：`cloudfunctions/api/handlers/reminder.js`（`get` / `set` / `grant` / `runTimer` / `templateData`）、`cloudfunctions/api/index.js`（Timer 分流）、`cloudfunctions/api/config.json`（openapi + triggers）、`miniprogram/pages/profile/index.js`（`onToggleReminder` / `onReminderTimeChange` / `requestReminderSubscribe`）。
- 内容安全：`cloudfunctions/api/lib/security.js`（`assertText` / `SCENE`）。
- 记账本与解绑（M9）：`cloudfunctions/api/handlers/ledger.js`、`handlers/couple.js`（`*Unbind`）、`lib/relation.js`（`unbindView` / `coupleIdOf`）、`miniprogram/pages/ledger/`、`miniprogram/pages/profile/`。
- 导航与样式：`miniprogram/app.json`、`miniprogram/custom-tab-bar/`、`miniprogram/styles/tokens.wxss`、`miniprogram/app.wxss`。
- 测试夹具：`tests/helpers/cloud-entry.js`（云函数链路 + 云调用桩 `setOpenapi` / `openapiCalls`）、`tests/helpers/client-page.js`（页面 / 组件）、`tests/helpers/fake-db.js`（假库，含操作计数钩子）。
- 发布预检：`scripts/release-check.js`、`scripts/check-secrets.js`。
