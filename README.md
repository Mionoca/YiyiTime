# 小怡怡安（YiyiTime）

只属于两个人的微信小程序小屋：今天的心情、一个抱抱、到家报平安、第二天才解锁的日记、下次见面想做的事，都收在同一间屋子里。

## 技术栈

- 微信原生小程序（不引入 npm 依赖）
- 微信云开发：单云函数 `api` + 云数据库 + 云存储
- 本地测试：Node.js 18+（`node:test`）

## 目录结构

```text
YiyiTime/
├─ cloudfunctions/api/            # 唯一的业务云函数（action 路由）
│  ├─ index.js                    # 入口：鉴权、requestId、统一响应
│  ├─ handlers/                   # 按域拆分：system/user/bind/home（后续 diary/wish/...）
│  └─ lib/                        # ctx/errors/time/validate/db
├─ miniprogram/
│  ├─ pages/home|bind|profile/    # 三个页面（首页小屋 / 绑定 / 我的）
│  ├─ utils/                      # api（唯一云函数入口）、constants、time、format
│  ├─ styles/tokens.wxss          # 颜色/间距/字号设计变量
│  └─ images/avatars/             # 默认头像
├─ tests/                         # 云函数纯逻辑单测（time / validate）
├─ scripts/check-secrets.js       # 推送前扫描环境 ID / 密钥
└─ docs/                          # 技术设计文档、开发进度
```

## 本地开发

1. 环境：微信开发者工具，基础库 ≥ 2.32.3（`open-type="chooseAvatar"` 需 2.21.2+，隐私能力 `__usePrivacyCheck__` 需 2.32.3+）、Node.js ≥ 18（仅本地测试/脚本用）。
2. 配置云环境 ID：把 `miniprogram/config/env.example.js` 复制为 `miniprogram/config/env.js`，填入自己的环境 ID。
   该文件已被 `.gitignore` 忽略，**不要提交**。
3. 用微信开发者工具导入仓库根目录（appid 见 `project.config.json`）。
4. 云函数：右键 `cloudfunctions/api` →「上传并部署：云端安装依赖」。
5. 云数据库：手动创建 8 个集合（见下方「云开发控制台一次性配置」）。
6. 删除云端模板遗留的 `quickstartFunctions` 云函数（本地代码已清理，云端需手动删）。

## 云开发控制台一次性配置

- 集合：`users`、`couples`、`bind_invites`、`moods`、`hugs`、`safety_checkins`、`diaries`、`wishes`
- 权限：全部设置为「所有用户不可读写」（只允许云函数访问）
- 索引（`bind_invites`）：`creatorOpenid`+`status`、`applicantOpenid`+`status`、`expiresAt`
- 索引（`couples`）：`memberOpenids`（单字段）
- 存储：头像由前端上传到云存储 `avatars/` 目录，默认权限即可

## 测试

```bash
node tests/time.test.js
node tests/validate.test.js
# 或：node --test tests/
```

> 说明：在受限沙箱里 `node --test` 可能因无法 spawn 子进程报 `EPERM`，直接执行测试文件即可；普通本机环境两种方式都可用。

## 提交前检查

```bash
node scripts/check-secrets.js
```

会扫描 Git 跟踪/未忽略的文件，确认没有把云环境 ID、AppSecret、私钥提交上去。

## 开发约定

- 前端只能通过 `miniprogram/utils/api.js` 调云函数，不允许直接 `wx.cloud.database()`。
- action 用「域.动词」命名：`user.get`、`bind.create`、`home.get`。
- 所有时间规则（今天 / 第几天 / 纪念日 / 日记解锁）以云函数 `lib/time.js` 为准，客户端只做展示。
- 不信任客户端传来的 `openid` / `coupleId`，一律从上下文取。
- handler 只返回纯数据，不返回 `bindFailCount` / `lastActiveAt` 等内部字段。
- 日志不打日记正文、愿望备注、完整邀请码。

## 进度

- 技术设计文档：`docs/技术设计文档.md`
- 已完成功能与下一步：`docs/开发进度.md`
