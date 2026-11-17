# 交接说明（WorkBuddy 接手用）

> 更新时间：2026-11-17 15:20（Asia/Shanghai）
> 仓库：`D:/大学/YiyiTime`　分支：`hjj`　当前 HEAD：以 `git ls-remote origin hjj` 为准（最近一次代码提交 `d390555`，其后另有交接文档提交；接手时先 `git pull origin hjj`）
> 单测基线：535 pass / 0 fail / 0 skip；`release-check`：21 PASS + 5 TODO + 0 FAIL + 0 WARN；`check-secrets`：exit 0。

## 一、当前状态（M7 已在本地提交；推送状态以 `git ls-remote origin hjj` 为准）

- 代码侧 M0–M6 与 F1–F8 全部实现（历史轮次与每轮验证记录见 `docs/开发进度.md` → 六、变更记录）。
- 本轮交付 **M7 心情记录时间线**（P1 首个补齐功能）：新增只读 `mood.list`（按天倒序合并两人心情、以天为粒度分页、一次查询不 N+1、成员异常时不猜伴侣）+ 新页面 `pages/mood`（今天 / 昨天 / 月日、没说占位、空态、下拉刷新、翻页与底部重试、刷新与翻页并发用请求令牌互斥）+「我的」里的占位改成真入口；契约同步 7.2 / 7.6 / 8.2 / 8.3.6 / 8.3.7 / 16.3。
- 改动范围：云函数 `handlers/mood.js` / `handlers/index.js`；小程序端新增 `pages/mood/*`，改 `pages/profile/*`、`utils/constants.js`、`utils/time.js`、`app.json`、`components/empty-state/*`（按钮 88rpx + aria-role）；其余为测试与文档。
- 验证记录：`node --test` **535 pass / 0 fail**；`mood-list` 18、`client-mood` 19、`e2e-page` 10；`release-check` 21 PASS + 5 TODO + 0 FAIL（工作区未提交时多 1 条 WARN）；`check-secrets` exit 0。
- 独立只读审查：0 P0；1 条 P1 + 4 条 P2 + 17 条 P3。已修 P1（手工换绑残留 3 人时旧伴侣被当成 TA、分页提前结束 → 查询限定 `openid in [我, 伴侣]`，成员数 ≠ 2 时不猜伴侣）、P2-1（请求令牌 + `loadMore` 与刷新互斥 + 卸载守卫）、P2-2（8.3.7 的 `days` 结构改成实际的 `rows`）、P2-4（补 onShow / 连点 / 空列表静默失败 / 卸载 / 页面↔真实 handler 链路共 6+5 个用例）、P2-3（本节重写），以及低成本 P3：`shiftDateKey` 日历合法性、列表语义 role、空态按钮热区、`beforeDate` 夹取、`note` 类型归一、对比度注释、部署顺序。未做的 P3 已记入 `docs/开发进度.md` 偏差表（成员只有 1 人时页面仍渲染 TA 一行「没说」属同一类脏数据边界）。

## 二、接手第一步

```bash
cd D:/大学/YiyiTime
git pull origin hjj
node --test
node scripts/release-check.js
node scripts/check-secrets.js
```

然后按顺序读：`docs/开发进度.md`（一、已完成；二、已知缺口；三、手动操作；六、变更记录）、`docs/M6-真机验收与发布.md`、`docs/技术设计文档.md`（按需查章节）。

## 三、仍需用户手动完成的（卡真机验收）

1. 云开发控制台：按 `docs/M6-真机验收与发布.md` 建 8 个集合、配权限与索引。
2. 部署 `cloudfunctions/api`（上传并部署：云端安装依赖；超时 10s、内存 256MB）。之后每次改云函数都要重部署。
3. 微信公众平台：配置《用户隐私保护指引》（头像、昵称用途）。
4. 微信开发者工具上传体验版，并把对方微信号加为体验成员。
5. 发布前在控制台导出一次数据库备份。

注意：M7 同时改了云函数（`handlers/mood.js` / `handlers/index.js`）与小程序端（新页面、profile、constants、app.json、utils/time），**先「上传并部署：云端安装依赖」`cloudfunctions/api`，再上传小程序端**；顺序反了旧云函数没有 `mood.list`，心情页会报「这个操作还不存在」。

## 四、尚未完成的代码侧事项（按优先级）

1. **等用户真机验收反馈**：F1–F8 + 14.4 的 A/B 14 步 + `docs/M6-真机验收与发布.md` 第 2–4 节；重点核对心情记录页（今天 / 昨天文案、没说占位、翻页 / 下拉、读屏 role）、断网浮层项、夜间观感。收到问题按 P0/P1 修。
2. 若继续做自动化加固（非阻塞）：`home-layout.test.js` 未建模 `refresh-bar`（in-flow 卡片，失败态场景高度缩约 98rpx，四档模拟仍满足 9.9）；`release-check` 客户端云访问边界只覆盖点号 / 括号普通字符串键直接写法（可选链、别名、模板键只 WARN）；日志脱敏静态检查对 `*Tail` 键 + 裸变量不设防。
3. 仍是 P1 的功能：订阅消息提醒（需模板与授权）、见面基金（需新建 `fund_goals` / `fund_entries`）、应用内解绑（MVP 由控制台手工）、内容安全审核（公开传播前必须接 `msgSecCheck`）—— 见技术设计文档 :63 / :202 / :122；心情记录已在本轮补齐，不再是占位。
4. 已实现功能的边界说明、已知偏差（55 条）与手动项都记在 `docs/开发进度.md`，改功能时同步更新。

## 五、工作流约定（沿用）

- 每完成一个阶段或大功能：`node --test` 全量 + `node scripts/release-check.js` + `node scripts/check-secrets.js` 全绿 → 独立只读审查（只用读、不改仓）→ 修 P0/P1 → `git push origin hjj` → 更新 `docs/开发进度.md` 与 README 单测数。
- `docs/开发进度.md` 固定四处：`:4` 头部「当前完成」、`:145` 单测合计与逐文件明细、对应「一、已完成」bullet、`六、变更记录` 顶部新条目；涉及 M6 计数时同步 `docs/M6-真机验收与发布.md`。
- commit：信息写入 `.git/yiyi-commit-rNN.txt`，`git commit -F`；push 前在 pwsh 设 `$env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:HTTP_PROXY='http://127.0.0.1:7890'`；push 后核对 `git rev-parse HEAD` 与 `git ls-remote origin hjj` 一致、工作区干净。
- 本机环境坑：跑 `node --test` / `release-check` 用 pwsh（run_code 内 PATH 缺 git 会让 check-secrets 用例 skip）；pwsh `*>` 重定向是 UTF-16LE；`scripts/release-check.js`、`cloudfunctions/api/handlers/hug.js`、`home.js` 是 CRLF，其余文档 / 测试是 LF；不要用 pwsh `Set-Content` 改文件（用 node:fs 并校验替换次数）；临时目录用显式 `D:/_yiyi_xxx`。

## 六、关键文件索引

- 需求与验收：`docs/技术设计文档.md`（4179 行，v0.1.1）、`docs/M6-真机验收与发布.md`。
- 进度与偏差：`docs/开发进度.md`（当前单测数、已完成功能、已知缺口、手动操作、变更记录）。
- 客户端入口：`miniprogram/utils/api.js`（唯一云函数调用入口）、`miniprogram/utils/constants.js`（`LIMITS` / 路由）。
- 云函数入口：`cloudfunctions/api/index.js`，handler 在 `cloudfunctions/api/handlers/`。
- 测试夹具：`tests/helpers/cloud-entry.js`（云函数链路）、`tests/helpers/client-page.js`（页面 / 组件）、`tests/helpers/fake-db.js`（假库，含操作计数钩子）。
- 发布预检：`scripts/release-check.js`、`scripts/check-secrets.js`。
