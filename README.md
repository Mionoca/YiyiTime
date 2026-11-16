# 小怡怡安（YiyiTime）

只属于两个人的微信小程序小屋：今天的心情、一个抱抱、到家报平安、第二天才解锁的日记、下次见面想做的事，都收在同一间屋子里。

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
│  │  └─ mood.js  hug.js  safety.js  diary.js  wish.js
│  └─ lib/                          # ctx / errors / time / validate / db / db-util / relation / home-blocks
├─ miniprogram/
│  ├─ pages/
│  │  ├─ home/                      # 小屋首页（场景、门口信封、两个入口页脚）
│  │  ├─ bind/                      # 双人绑定与邀请码
│  │  ├─ profile/                   # 我的（昵称头像、开始日期、隐私入口）
│  │  ├─ safety/                    # 报平安（我到家了 + 时间线）
│  │  ├─ diary/                     # 台灯下的日记（当天上锁，次日解锁）
│  │  └─ wish/                      # 下次见面想做的事
│  ├─ components/                   # avatar-bubble / mood-picker / hug-banner / bottom-sheet /
│  │                                # timeline-item / diary-card / wish-item / empty-state / privacy-guard
│  ├─ utils/                        # api（唯一云函数入口）、constants、time、format、me、upload
│  ├─ styles/tokens.wxss            # 颜色/间距/字号设计变量
│  ├─ config/env.example.js         # 环境 ID 模板（env.js 不入库）
│  └─ images/avatars/               # 默认头像
├─ tests/                           # 云函数与页面逻辑单测（含 tests/helpers/fake-db.js）
├─ scripts/
│  ├─ check-secrets.js              # 推送前扫描环境 ID / 密钥
│  └─ release-check.js              # M6 静态预检（页面/组件/隐私接线/敏感日志/密钥）
└─ docs/                            # 技术设计文档、开发进度、M6 真机验收与发布
```

## 本地开发

1. 环境：微信开发者工具，基础库 ≥ 2.32.3（`open-type="chooseAvatar"` 需 2.21.2+，隐私能力 `__usePrivacyCheck__` 需 2.32.3+）、Node.js ≥ 18（仅本地测试/脚本用）。
2. 配置云环境 ID：把 `miniprogram/config/env.example.js` 复制为 `miniprogram/config/env.js`，填入自己的环境 ID。
   该文件已被 `.gitignore` 忽略，**不要提交**。
3. 用微信开发者工具导入仓库根目录（appid 见 `project.config.json`）。
4. 云函数：右键 `cloudfunctions/api` →「上传并部署：云端安装依赖」。**每次云函数代码有改动都要重新部署。**
5. 云数据库：手动创建 8 个集合（见下方「云开发控制台一次性配置」）。
6. 删除云端模板遗留的 `quickstartFunctions` 云函数（本地代码已清理，云端需手动删）。
7. 隐私：微信公众平台 →「设置 - 服务内容声明 - 用户隐私保护指引」声明头像、昵称用途，否则隐私接口会被拦截。

## 云开发控制台一次性配置

- 集合：`users`、`couples`、`bind_invites`、`moods`、`hugs`、`safety_checkins`、`diaries`、`wishes`
- 权限：全部设置为「所有用户不可读写」（只允许云函数访问）
- 索引：
  - `bind_invites`：`creatorOpenid`+`status`、`applicantOpenid`+`status`、`expiresAt`
  - `couples`：`memberOpenids`（单字段）
  - `moods`：`coupleId`+`date`
  - `hugs`：`coupleId`+`toOpenid`+`status`+`createdAt`（倒序）、`coupleId`+`fromOpenid`+`createdAt`
  - `safety_checkins`：`coupleId`+`date`、`coupleId`+`createdAt`
  - `diaries`：`coupleId`+`date`
  - `wishes`：`coupleId`+`done`+`createdAt`、`coupleId`+`createdAt`
- 存储：头像由前端上传到云存储 `avatars/` 目录，默认权限即可

## 测试

```bash
node --test                       # 自动发现 tests/*.test.js（Node 22 实测 128 个用例）
# 或只跑一个文件：node tests/hug.test.js
```

PowerShell 逐文件跑全部用例（Git Bash 可用 `for f in tests/*.test.js; do node "$f" || exit 1; done`）：

```powershell
Get-ChildItem tests/*.test.js | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { exit 1 } }
```

> 说明：`node --test tests/` 在 Node 22 会把目录当 glob，报 `Cannot find module ...\tests`，请用上面的写法；受限沙箱若无法 spawn 子进程，逐文件执行即可。

## 提交 / 发布前检查

```bash
node scripts/check-secrets.js   # 环境 ID / AppSecret / 私钥扫描（需要 git）
node scripts/release-check.js   # 页面与组件路径、模板残留、默认头像、隐私接线、敏感 console、env.js 是否被跟踪
```

`release-check.js` 会额外打印云开发控制台待办（集合/索引/部署/隐私指引/真机验收），手动项清单见
[docs/M6-真机验收与发布.md](docs/M6-真机验收与发布.md)。

## 开发约定

- 前端只能通过 `miniprogram/utils/api.js` 调云函数，不允许直接 `wx.cloud.database()`。
- action 用「域.动词」命名：`user.get`、`bind.create`、`home.get`、`mood.set`、`hug.send`、`safety.checkin`、`diary.save`、`wish.add`。
- 所有时间规则（今天 / 第几天 / 纪念日 / 日记解锁）以云函数 `lib/time.js` 为准，客户端只做展示。
- 不信任客户端传来的 `openid` / `coupleId`，一律从上下文取。
- handler 只返回纯数据，不返回 `bindFailCount` / `lastActiveAt` 等内部字段。
- 日志不打日记正文、愿望备注、完整邀请码；客户端 `console` 不打 openid/coupleId/邀请码。
- 文字对比度按 8.9：正文 `--ink`/`--muted`，白字按钮底色用 `--accent-strong`，`--ink-faint` 只做装饰。

## 进度

- 技术设计文档：`docs/技术设计文档.md`
- 已完成功能、已知偏差、手动操作与下一步：`docs/开发进度.md`
- M6 双人真机验收与发布清单：`docs/M6-真机验收与发布.md`
