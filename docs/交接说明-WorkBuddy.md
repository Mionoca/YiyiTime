# 交接说明（WorkBuddy 接手用）

> 更新时间：2026-11-17 13:00（Asia/Shanghai）
> 仓库：`D:/大学/YiyiTime`　分支：`hjj`　当前 HEAD：`7d9c25c`（= `origin/hjj`，工作区干净）
> 单测基线：497 pass / 0 fail / 0 skip；`release-check`：21 PASS + 5 TODO + 0 FAIL + 0 WARN；`check-secrets`：exit 0。

## 一、当前状态（已全部推送）

- 代码侧 M0–M6 与 F1–F8 全部实现，多轮加固已推送；本轮 `7d9c25c` 交付「首页静默刷新失败保留场景 + 底部浮层『小屋的门卡住了』/『再试一次』」（技术设计文档 9.12 / 10.3）。
- 生产代码只改 `miniprogram/pages/home/index.js` / `index.wxml` / `index.wxss`，云函数无改动。
- `tests/client-home.test.js` 23→26；文档同步 `README.md`、`docs/开发进度.md`、`docs/M6-真机验收与发布.md`。
- 本轮验证记录：`node --test` 497 pass；`node --test tests/client-home.test.js` 26 pass；`node scripts/release-check.js` 21 PASS + 5 TODO + 0 FAIL + 1 WARN（仅因当时工作区未提交）；`node scripts/check-secrets.js` exit 0。
- 审查：功能代码独立审查 PASS（0 阻断）；文档一致性审查 FAIL（3 条 P2 + 6 条 P3）已按要求全部修复；加固变异 M9–M13（不清 `_retryingRefresh`、浮层挪到场景前、删 aria、删 88rpx 热区、删夜间降亮）全部拦红。

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

注意：本轮只改小程序端，云函数不用重部署、小程序端需重新上传。

## 四、尚未完成的代码侧事项（按优先级）

1. **等用户真机验收反馈**：F1–F8 + 14.4 的 A/B 14 步 + `docs/M6-真机验收与发布.md` 第 2–4 节；重点核对本轮新增的断网浮层项、夜间观感、读屏 aria。收到问题按 P0/P1 修。
2. 若继续做自动化加固（非阻塞）：`home-layout.test.js` 未建模 `refresh-bar`（in-flow 卡片，失败态场景高度缩约 98rpx，四档模拟仍满足 9.9）；`release-check` 客户端云访问边界只覆盖点号 / 括号普通字符串键直接写法（可选链、别名、模板键只 WARN）；日志脱敏静态检查对 `*Tail` 键 + 裸变量不设防。
3. P1 明确不在当前范围：订阅消息提醒、见面基金、应用内解绑（MVP 由控制台手工）、内容安全审核 —— 见技术设计文档 :63 / :202 / :122。
4. 已实现功能的边界说明、已知偏差（52 条）与手动项都记在 `docs/开发进度.md`，改功能时同步更新。

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
