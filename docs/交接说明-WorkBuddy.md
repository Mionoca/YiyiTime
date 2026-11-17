# 交接说明（WorkBuddy 接手用）

> 更新时间：2026-11-17 16:10（Asia/Shanghai）
> 仓库：`D:/大学/YiyiTime`　分支：`hjj`　当前 HEAD：以 `git ls-remote origin hjj` 为准（最近一次代码提交 `a000369`；接手时先 `git pull origin hjj`）
> 单测基线：544 pass / 0 fail / 0 skip；`release-check`：21 PASS + 5 TODO + 0 FAIL + 0 WARN；`check-secrets`：exit 0。

## 一、当前状态

- 代码侧 M0–M6 与 F1–F8 全部实现（历史轮次与每轮验证记录见 `docs/开发进度.md` → 六、变更记录）。
- 上一轮交付 **M7 心情记录时间线**（只读 `mood.list` + `pages/mood`）。
- 本轮交付 **M8 前端改版**（用户反馈驱动，只改客户端）：
  1. **导航**：`app.json` 注册 **2 项** `tabBar`（`custom: true`：今天 / 我的），新建 `custom-tab-bar/` 组件（虚线顶边、100rpx + 安全区、每项 88rpx 热区、`aria-role="tablist"`）；`utils/constants.js` 新增 `TAB_ROUTES` / `isTabRoute`，`utils/tabbar.js` 提供空值安全的 `tabbar.sync`；两个 tab 页在 `onShow` 首行同步选中态；日记 / 愿望 / 心情 / 报平安 / 绑定都是普通页，`wx.navigateTo` 进入（第一版铺过 5 个 tab，用户反馈「第一个 tab 都能跳转，底部不需要这么多」，第二版收成 2 个）。
  2. **首页**：删掉「台灯 / 冰箱 / 门 / 昼夜」场景逻辑，改成功能型卡片面板（刷新浮层 → 日子卡 → 抱抱卡 → 心情卡 → 四宫格 → 邀请卡），抱抱状态机、庆祝动画去重、心情选择器、改开始日期、分享带码、隐私守卫、静默刷新失败浮层、`_loadSeq` 全部保留。
  3. **视觉**：`tokens.wxss` / `app.wxss` 整体重写为 StyleKit「hand-drawn-doodle」（米黄纸底、墨黑字、马克笔红 / 青 / 黄、3rpx 虚线描边、4 / 6rpx 小圆角、彩色硬阴影、150ms linear、`:active` 位移），7 页 + 9 组件的 wxss 逐个改；去渐变、去 999rpx 胶囊、正文不用 marker 色（对比度）、热区 ≥88rpx、`prefers-reduced-motion` 关全部动效。
- 改动范围：`app.json` / `app.wxss` / `styles/tokens.wxss` / 6 个页面 json（导航底色统一 `#FFFEF5`）/ 7 个页面（home 的 js+wxml+wxss+json 重写，profile 的 js 加 `tabbar.sync`、心情入口改 `navigateTo`，diary / wish / mood 去掉 tab 同步，全部 wxss 改写）/ 9 个组件 wxss / 新增 `custom-tab-bar/*` 与 `utils/tabbar.js` / `utils/constants.js`；云函数**零改动**。
- 验证记录：`node --test` **540 pass / 0 fail**；`home-layout` 14（完全重写）、`home-derive` 19（重写）、`client-home` 26、`client-mood` 19、`contrast` 7、`pull-down` 2、`ui-standards` 8、`e2e-page` 10、`tabbar` 4（新增）；`release-check` 21 PASS + 5 TODO + 0 FAIL + 0 WARN；`check-secrets` exit 0。
- 已知边界（不阻断）：自定义 tabBar 的选中态靠两个 tab 页 `onShow` 里的 `tabbar.sync` 维持，从分享冷启动落到子页再返回时可能有一帧未选中；Baloo 2 未引入（不发网络字体），真机走系统手写体，字形与设计稿有差异；`home-layout` 未建模 `refresh-bar` 的高度占位。

## 二、接手第一步

```bash
cd D:/大学/YiyiTime
git pull origin hjj
node --test
node scripts/release-check.js
node scripts/check-secrets.js
```

然后按顺序读：`docs/开发进度.md`（一、已完成 → M8 小节；二、已知缺口；三、手动操作；六、变更记录顶部）、`docs/M6-真机验收与发布.md`、`docs/技术设计文档.md`（8.2 路由与 tabBar、8.7 视觉规范、第 9 章首页）。

## 三、仍需用户手动完成的（卡真机验收）

1. 云开发控制台：按 `docs/M6-真机验收与发布.md` 建 8 个集合、配权限与索引。
2. 部署 `cloudfunctions/api`（上传并部署：云端安装依赖；超时 10s、内存 256MB）。**若上一轮已部署过 M7 的云函数，本轮不用重部署**（M8 云函数零改动）；不确定就重传一次。
3. **小程序端要重新上传**：M8 新增了 `miniprogram/custom-tab-bar/` 目录，漏传会出现 tabBar 白屏（页面正常但底部空白）。
4. 微信公众平台：配置《用户隐私保护指引》（头像、昵称用途）。
5. 微信开发者工具上传体验版，并把对方微信号加为体验成员。
6. 发布前在控制台导出一次数据库备份。
7. 真机看一眼：两个 tab 切换是否跟手、选中态是否同步、日记 / 愿望 / 心情 / 报平安从首页四宫格进得去且能返回、卡片虚线 / 硬阴影在低端机上是否清晰、小屏（iPhone SE）最后一张卡是否被 tabBar 压住。

## 四、尚未完成的代码侧事项（按优先级）

1. **等用户真机验收反馈**：F1–F8 + 14.4 的 A/B 14 步 + `docs/M6-真机验收与发布.md` 第 2–4 节；M8 之后重点看首页四宫格能否一眼认出四个功能、副文案是否够用、涂鸦风在真机的字体与描边观感。收到问题按 P0/P1 修。
2. 若继续做自动化加固（非阻塞）：`custom-tab-bar` 的选中态有 `tests/tabbar.test.js` 4 个用例（下标映射 / 未被选中的普通页跳过 / 空实例不抛 / `isTabRoute` 只认两项）+ `home-layout` 静态断言，但没有「冷启动 → 子页 → 返回」的页面级时序用例；`home-layout` 未建模 `refresh-bar` 的高度（失败态缩约 88rpx，四档模拟仍满足 9.9）；`release-check` 客户端云访问边界只覆盖点号 / 括号普通字符串键，可选链 / 别名 / 模板键只 WARN。
3. 仍是 P1 的功能：订阅消息提醒（需模板与授权）、见面基金（需新建 `fund_goals` / `fund_entries`）、应用内解绑（MVP 由控制台手工）、内容安全审核（公开传播前必须接 `msgSecCheck`）。
4. 已实现功能的边界说明、已知偏差（55 条，另有 2 条 M8 新增记在「二、已知缺口」）与手动项都记在 `docs/开发进度.md`，改功能时同步更新。

## 五、工作流约定（沿用）

- 每完成一个阶段或大功能：`node --test` 全量 + `node scripts/release-check.js` + `node scripts/check-secrets.js` 全绿 → 独立只读审查（只用读、不改仓）→ 修 P0/P1 → `git push origin hjj` → 更新 `docs/开发进度.md` 与 README 单测数。
- `docs/开发进度.md` 固定四处：`:4` 头部「当前完成」、`:145` 单测合计与逐文件明细、对应「一、已完成」bullet（本轮新增 M8 小节）、`六、变更记录` 顶部新条目；涉及 M6 计数时同步 `docs/M6-真机验收与发布.md`。
- commit：信息写入 `.git/yiyi-commit-rNN.txt`，`git commit -F`；push 前设 `HTTPS_PROXY=http://127.0.0.1:7890` / `HTTP_PROXY=http://127.0.0.1:7890`；push 后核对 `git rev-parse HEAD` 与 `git ls-remote origin hjj` 一致、工作区干净。
- 本机环境坑：跑 `node --test` / `release-check` 用 pwsh（run_code 内 PATH 缺 git 会让 check-secrets 用例 skip）；pwsh `*>` 重定向是 UTF-16LE；`scripts/release-check.js`、`cloudfunctions/api/handlers/hug.js`、`home.js` 是 CRLF，其余文档 / 测试是 LF；不要用 pwsh `Set-Content` 改文件（用 node:fs 并校验替换次数）；临时目录用显式 `D:/_yiyi_xxx`。

## 六、关键文件索引

- 需求与验收：`docs/技术设计文档.md`（4125 行）、`docs/M6-真机验收与发布.md`。
- 进度与偏差：`docs/开发进度.md`（当前单测数、已完成功能、已知缺口、手动操作、变更记录）。
- 客户端入口：`miniprogram/utils/api.js`（唯一云函数调用入口）、`miniprogram/utils/constants.js`（`LIMITS` / `ROUTES` / `TAB_ROUTES` / `isTabRoute`）、`miniprogram/utils/tabbar.js`（tabBar 选中态同步）。
- 导航与样式：`miniprogram/app.json`（`tabBar.custom`）、`miniprogram/custom-tab-bar/`、`miniprogram/styles/tokens.wxss`、`miniprogram/app.wxss`（`dk-*` 公共类）。
- 云函数入口：`cloudfunctions/api/index.js`，handler 在 `cloudfunctions/api/handlers/`。
- 测试夹具：`tests/helpers/cloud-entry.js`（云函数链路）、`tests/helpers/client-page.js`（页面 / 组件）、`tests/helpers/fake-db.js`（假库，含操作计数钩子）。
- 发布预检：`scripts/release-check.js`、`scripts/check-secrets.js`。
