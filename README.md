# 小怡怡安（YiyiTime）

只属于两个人的微信小程序：今天的心情、一叠能左右翻的纪念日卡、两个人一起变好的小任务、手帐风的日记（默认只有自己看得到，想给 TA 看的再手动打开，还能按「立即 / 明天 / 一周后」解锁）、下次见面想做的事，都收在同一间屋子里；各自还能记自己的小账本（底部常驻，**对方的账默认上锁，要申请并被同意才看得到**），到点还没写日记会提醒一下，不想用了可以自己在「我的」里注销。

## 技术栈

- 微信原生小程序（不引入 npm 依赖）
- 微信云开发：单云函数 `api` + 云数据库 + 云存储
- 本地测试：Node.js 18+（`node:test` 断言，逐文件执行）

## 目录结构

```text
YiyiTime/
├─ cloudfunctions/api/              # 唯一的业务云函数（action 路由）
│  ├─ index.js                      # 入口：鉴权、requestId、统一响应、错误码
│  ├─ package.json                  # 云函数依赖声明（wx-server-sdk）
│  ├─ handlers/                     # 按域拆分
│  │  ├─ index.js                   # action 路由表
│  │  ├─ system.js  user.js  bind.js  couple.js  home.js
│  │  ├─ mood.js  anniversary.js  diary.js  wish.js  ledger.js  ledger-access.js
│  │  ├─ reminder.js                # 订阅提醒（reminder.* + 定时任务 runTimer；grant 兼任务模板）
│  │  └─ growth.js                  # 一起变好（growth.*，M11：任务池 + 成长日志）
│  └─ lib/                          # ctx / errors / time / validate / db / db-util / relation / home-blocks / security
│     └─ growth-sub.js              # 成长任务订阅提醒（事件驱动即时发，失败绝不打断业务）
├─ miniprogram/
│  ├─ pages/
│  │  ├─ home/                      # 今天（纪念日堆叠卡 / 心情卡 / 四宫格入口）
│  │  ├─ bind/                      # 双人绑定与邀请码
│  │  ├─ profile/                   # 我的（昵称头像、开始日期、每日提醒、解绑、隐私保护指引 / 数据与隐私说明）
│  │  ├─ diary/                     # 手帐日记 + 心情日历 + 年度长图（默认私密）
│  │  ├─ wish/                      # 下次见面想做的事
│  │  ├─ mood/                      # 心情记录（两人按天倒序，只读时间线）
│  │  ├─ anniversary/               # 纪念日管理（添加 / 修改 / 删除自定义纪念日）
│  │  ├─ ledger/                    # 记账本（tab 页：我的 / TA 的，按天分组 + 合计；TA 的需授权）
│  │  └─ growth/                    # 一起变好（任务池 / 成长日志）
│  ├─ custom-tab-bar/               # 自定义 tabBar（三项：今天 / 记账本 / 我的）
│  ├─ components/                   # avatar-bubble / mood-picker / anniversary-stack / bottom-sheet /
│  │                                # diary-card / wish-item / growth-item / growth-log-item / mood-scale /
│  │                                # empty-state / privacy-guard
│  ├─ utils/                        # api（唯一云函数入口）、constants、tabbar、time、format（含元/分换算）、me、upload、haptics、privacy
│  ├─ styles/tokens.wxss            # 手绘涂鸦风设计变量（颜色 / 描边 / 硬阴影 / 间距 / 字号）
│  ├─ config/env.example.js         # 环境 ID 模板（env.js 不入库）
│  └─ images/avatars/               # 默认头像
├─ tests/                           # 云函数 / 页面 / 组件级单测 + WXML 绑定自检（helpers: fake-db / cloud-entry / client-page）
├─ scripts/
│  ├─ check-secrets.js              # 推送前扫描环境 ID / 密钥
│  └─ release-check.js              # M6 静态预检（页面/组件路径与作用域/隐私接线/敏感日志/密钥/部署配置/图片资源与包体/未处理 Promise/客户端云访问边界）
└─ docs/                            # 文档索引、技术设计文档、开发进度、真机验收清单、archive/ 归档
```

## 本地开发

1. 环境：微信开发者工具，基础库 ≥ 2.32.3（`open-type="chooseAvatar"` 需 2.21.2+，隐私能力 `__usePrivacyCheck__` 需 2.32.3+）、Node.js ≥ 18（仅本地测试/脚本用）。
2. 配置云环境 ID：把 `miniprogram/config/env.example.js` 复制为 `miniprogram/config/env.js`，填入自己的环境 ID。
   该文件已被 `.gitignore` 忽略，**不要提交**。
3. 用微信开发者工具导入仓库根目录（appid 见 `project.config.json`）。
4. 云函数：右键 `cloudfunctions/api` →「上传并部署：云端安装依赖」。**每次云函数代码有改动都要重新部署。**
5. 云数据库：手动创建 10 个集合（见下方「云开发控制台一次性配置」）。
6. 删除云端模板遗留的 `quickstartFunctions` 云函数（本地代码已清理，云端需手动删）。
7. 隐私：微信公众平台 →「设置 - 服务内容声明 - 用户隐私保护指引」声明头像、昵称用途，否则隐私接口会被拦截。**没声明时的表现是「点头像完全没反应」**：渲染层报 `chooseAvatar:fail api scope is not declared in the privacy agreement`（errno 112），昵称输入框每敲一个字报 `showNicknameAccessory:fail ... errno:112`。声明要选「收集你的昵称、头像」，提交后等审核通过才生效；本地调试临时把 `app.json` 的 `__usePrivacyCheck__` 改 `false` 可以绕过，**但不要随版本发布**（真机与审核都要求它是 `true`）。
8. 订阅提醒（可选，不配也能跑）：公众平台「订阅消息」里选一个「打卡 / 待办提醒」类模板，把模板 ID 配到云函数环境变量 `YIYI_REMINDER_TEMPLATE_ID`；模板关键词要和 `cloudfunctions/api/handlers/reminder.js` 的 `templateData` 对齐（默认 `thing1` + `time2`），字段名不一致微信返回 47003。没配时「我的」页的提醒开关是禁用态，定时任务静默跳过。
   云调用权限（`security.msgSecCheck`、`subscribeMessage.send`）与定时触发器（`reminder-tick`）都写在 `cloudfunctions/api/config.json` 里，随「上传并部署」一起生效，不用在控制台另配。
9. 任务提醒模板（M11.3 起用，可选，不配也能跑）：公众平台「订阅消息」再选一个「任务 / 待办提醒」类模板，模板 ID 配到云函数环境变量 `YIYI_GROWTH_TEMPLATE_ID`（关键词默认 `thing1` + `time2`，同 `handlers/growth.js` 的 `templateData`）。不配时成长任务的订阅提醒整体静默，页面不出现订阅入口；**先停一下（F13）不需要任何模板**——它没有推送，靠打开首页看到便签。

## 云开发控制台一次性配置

- 集合（10 个）：`users`、`couples`、`bind_invites`、`moods`、`anniversaries`、`diaries`、`wishes`、`ledger_entries`、`growth_tasks`、`ledger_view_grants`（`safety_checkins` / `pauses` 已于 M14 下线，不必新建）
  - M12 起 `hugs` 已下线：如果控制台还留着这个集合，先导出备份再删除（代码不再读它）
  - `growth_tasks` 是 M11 新增、`ledger_view_grants`（账本查看授权）是 M13 新增：云函数写不存在的集合会报错，**先建集合再部署**（同 `ledger_entries` 先例）；缺 `ledger_view_grants` 时账本的「申请查看」点不动
- 权限：全部设置为「所有用户不可读写」（只允许云函数访问）
- 索引：
  - `bind_invites`：`creatorOpenid`+`status`、`applicantOpenid`+`status`、`expiresAt`
  - `couples`：`memberOpenids`（单字段）
  - `moods`：`coupleId`+`date`（心情记录按 `openid in [我, TA]` 过滤，两人数据量极小可先用这条；若真机翻页监控显示慢，再加 `coupleId`+`openid`+`date`）
  - `anniversaries`：`coupleId`、`coupleId`+`date`（一次取全部 ≤8 条，排序在内存里做）
  - `diaries`：`coupleId`+`date`
  - `wishes`：`coupleId`+`done`+`createdAt`、`coupleId`+`createdAt`
  - `ledger_entries`：`openid`+`month`+`date`+`createdAt`（我的账本按月查）、`openid`+`coupleId`+`month`+`date`+`createdAt`（伴侣视角按月查；后两位是同一天内的时间倒序）
  - `growth_tasks`：`coupleId`+`status`+`createdAt`（任务池列表）、`coupleId`+`status`+`archivedAt`（倒序，成长日志复合游标）
  - `ledger_view_grants`（M13）：**只建一条** `coupleId`+`updatedAt`（`updatedAt` 倒序）。账本页 `viewRequests`、首页 `ledgerAccess`、`ledger.list` 的权限判定全都走 `loadGrants`——一次取本关系的 ≤20 条再在内存里按 owner / viewer / status 分组，所以 `status` / `ownerOpenid` / `viewerOpenid` 不进索引（`status` 插在中间还会让排序用不上索引）
  - `diaries` 原有 `coupleId`+`date` 索引继续够用：M13 的 `diary.calendar`（按 `openid`+`month` 前缀）与 `diary.archive`（按 `openid`+`date` 区间）都落在同一索引前缀上，单对情侣量级（一年 ≤366 条）无需新增索引
- 存储：头像由前端上传到云存储 `avatars/` 目录，日记配图上传到 `diary/{coupleId}/{date}/` 目录，默认权限即可；客户端上传前校验格式（头像 JPG / PNG、配图 JPG / PNG / WebP）与单张大小（头像 ≤2MB、配图 ≤5MB，文档 11.9），格式不符或超限直接提示、不发起上传

## 测试

```bash
node --test tests/*.test.js       # 自动发现 tests/*.test.js（Node 22 实测 734 个用例）
# 或只跑一个文件：node tests/anniversary.test.js
```

PowerShell 逐文件跑全部用例（Git Bash 可用 `for f in tests/*.test.js; do node "$f" || exit 1; done`）：

```powershell
Get-ChildItem tests/*.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { exit 1 } }
```

> 说明：`node --test tests/` 在 Node 22 会把目录当 glob，报 `Cannot find module ...\tests`，请用上面的写法；受限沙箱若无法 spawn 子进程，逐文件执行即可。

## 提交 / 发布前检查

```bash
node scripts/check-secrets.js   # 环境 ID / AppSecret / 私钥扫描（需要 git）
node scripts/release-check.js   # 页面/组件路径与注册（`usingComponents` 按页面/组件作用域校验：跨页注册判红、`app.json` 全局注册放行、内置组件（`view` / `scroll-view` / `rich-text` 等）放行、注册域取同目录同名 json、wxml 注释（含跨行）忽略）、require 可解析、模板残留、默认头像、隐私接线、敏感 console、密钥、集合白名单、云函数 package.json/config.json、project.config.json 根目录 / appid / 基础库（≥ 2.32.3，允许 latest / trial 符号值）、图片资源与包体（图片位置 / 单张 ≤100KB / 包体 <2MB / 默认头像 200×200）、客户端 api.call 不能悬空（必须 await / return / .then / .catch）、客户端不直连数据库（`wx.cloud.database` 点号 / 括号写法都拦，动态键告警）且 `wx.cloud.callFunction` 只经 `utils/api.js`（文档 11.9 + 架构约定；静态检查只覆盖 `wx.cloud` 点号 / 括号普通字符串键直接写法，含 `\uXXXX` 转义键还原，可选链 / 括号化 / 别名 / 模板键不覆盖，动态键与无法解析的键只 `[WARN]` 不阻断发布）、env.js / project.private.config.json 是否被跟踪
```

`release-check.js` 会额外打印云开发控制台待办（集合/索引/部署/超时与内存/隐私指引/真机验收），手动项清单见
[docs/M6-真机验收与发布.md](docs/M6-真机验收与发布.md)。

## 开发约定

- 前端只能通过 `miniprogram/utils/api.js` 调云函数，不允许直接 `wx.cloud.database()`。
- action 用「域.动词」命名：`user.get`、`user.deleteAccount`、`bind.create`、`home.get`、`mood.set` / `mood.list`、`anniversary.add` / `list`、`diary.save`、`wish.add`、`growth.add`、`ledger.add`。
- 所有时间规则（今天 / 第几天 / 纪念日 / 日记解锁）以云函数 `lib/time.js` 为准，客户端只做展示。
- 不信任客户端传来的 `openid` / `coupleId`，一律从上下文取。
- handler 只返回纯数据，不返回 `bindFailCount` / `lastActiveAt` 等内部字段。
- 日志不打日记正文、愿望备注、完整邀请码；客户端 `console` 不打 openid/coupleId/邀请码。
- 文字对比度按 8.9：正文 `--ink`、次要文字 `--muted`（两者在 `--paper` / `--card` 上都 ≥4.5:1）；`--marker-red` / `--marker-teal` / `--marker-yellow` 只做底块与描边，不当正文色；`--ink-faint` 只做装饰。
- 视觉按 8.7「手绘涂鸦风（hand-drawn-doodle）」：3rpx 虚线描边 + 4/6rpx 小圆角 + 彩色硬阴影（`8rpx 8rpx 0`）、150ms linear、`:active` 位移 3rpx 且阴影归零；禁渐变、禁 999rpx 胶囊、不引网络字体（字体栈本地降级）。
- 导航：`pages/home`（今天）、`pages/ledger`（记账本）、`pages/profile`（我的）是 tab 页，一律 `wx.switchTab` 并按 `utils/constants.js` 的 `TAB_ROUTES` 判断；`diary` / `wish` / `mood` / `growth` / `anniversary` / `bind` 都是普通页，用 `wx.navigateTo`（日记 / 愿望 / 一起变好 / 心情记录从首页四宫格进，纪念日管理从首页堆叠卡的「管理 ›」进）；三个 tab 页 `onShow` 首行 `tabbar.sync(this, ROUTES.x)` 维持自定义 tabBar 选中态。

## 进度与文档

- 文档索引（哪份看什么）：[`docs/README.md`](docs/README.md)
- 技术设计文档（契约唯一真相，v0.2.0）：`docs/技术设计文档.md`
- 开发进度与项目现状（**做到哪了 / 还剩什么 / 已知偏差**）：`docs/开发进度.md`
- 双人真机验收与发布清单（边做边打勾）：`docs/M6-真机验收与发布.md`
- 2026-11-18 合并前的旧文档（逐轮明细、M11 增补稿、旧交接说明）：`docs/archive/2026-11-18/`
