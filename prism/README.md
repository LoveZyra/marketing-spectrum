# Prism

Prism 是一个 Claude Code 的 Web UI，基于 [claudecodeui (CloudCLI)](https://github.com/siteboon/claudecodeui) 构建，并移植了 [claude-web](https://github.com/heng1234/claude-web) 2.0 的三大核心增强能力。

只支持 Claude Code CLI，只支持浏览器访问。上游自带的 Cursor / Codex / OpenCode 多 provider、PWA / 移动端推送、Electron 桌面端均已从本分支移除，代码与依赖一并删除，不是隐藏开关。

基座能力（继承自 claudecodeui）：WebSocket 可靠流（断线重放）、工具执行可视化、权限审批、Plan 模式、MCP 管理、Git 面板、Slash 命令、`@` 文件引用、语音输入/朗读、10 种语言、插件系统。上游完整文档见 [README.upstream.md](README.upstream.md)（其中涉及其他 provider 与桌面端的章节对本分支不再适用）。

## 移植自 claude-web 的增强能力

### 1. SDK 持久会话 + 上下文圆环 + 自动 /compact

- **常驻会话内核**：每个对话持有一个常驻的 Agent SDK `query()`（流式输入队列），每轮只发送本轮消息，不再每轮重建进程 + resume。会话历史由 SDK 原生维护，原生 Session ID 全程稳定。
- **精确上下文用量**：每轮结束后调用 SDK 原生 `getContextUsage()`，输入区显示上下文圆环（绿 → 琥珀 ≥60% → 红 ≥80%）与精确百分比。
- **自动压缩**：上下文达到 80% 高水位时，下一轮发送前自动执行原生 `/compact`，Session ID 保持不变；也可随时手动输入 `/compact`。
- 模型与权限模式切换走 SDK 原生 `setModel()` / `setPermissionMode()` 动态控制，无需重建；不支持时自动重建并 resume 同一原生会话。
- 实现：`server/claude-sdk.js`（持久 runtime 层）。空闲 30 分钟回收，常驻上限 8 个（可配）。

### 2. Git checkpoint 事务式回滚

- **每轮自动存档**：每次发送前用 `git stash create` + 专用 ref（防 GC）+ untracked 文件快照，完整捕获 staged / unstaged / untracked 三态，全程不动工作区。
- **事务式回滚**：回滚前先给当前现场建 safety checkpoint；任何一步失败自动恢复点击回滚时的现场。
- **改动摘要卡片**：每轮结束后输入框上方显示本轮文件改动（+/- 行数、彩色 diff 展开），支持整轮回滚与逐文件撤销（`git apply --reverse --check` 预检）。
- 实现：`server/services/git-checkpoint.js`、`server/routes/checkpoints.js`、`src/components/chat/view/subcomponents/ChangedFilesCard.tsx`。存档位于 `~/.prism/checkpoints`（7 天 / 每会话 40 个自动清理）。

### 3. 文档解析 + URL 正文抓取

- **文档附件**：聊天输入框支持上传 PDF / DOCX / PPTX / XLSX / XLS / CSV / TXT / MD 等文档（≤20MB），服务端提取文本（分页 / 分 Slide / 分 Sheet 标记）后随消息发送。
- **URL 抓取**：输入 URL 一键抓取网页正文作为上下文，内置 SSRF 防护（私网地址拒绝、逐跳重定向校验、2MB 上限）。
- 实现：`server/routes/documents.js` + 输入框文档芯片 UI。

## 快速开始

```bash
npm install
npm run dev        # 开发模式（后端 :8080 + Vite :5173）
# 或
npm run build && npm run server   # 生产模式
```

要求 Node.js ≥ 22，且本机已安装并登录 [Claude Code CLI](https://docs.claude.com/claude-code)。

Docker 部署见 [docker/README.md](docker/README.md)。反向代理（子路径部署）模板见 [docs/nginx-subpath-template.conf](docs/nginx-subpath-template.conf)。

## 安全须知

**Prism 默认监听 `0.0.0.0`**，这样手机、平板和局域网内其他机器的浏览器才能直接打开。代价是：任何能连到这个端口的人都可以尝试登录，而登录成功之后就能驱动一个有完整文件系统访问权限的 agent。

因此默认启用了两道限流，这也是保留 `0.0.0.0` 的前提：

- 所有 `/api` 路由按 IP 滑动窗口限流（默认 600 次 / 分钟），挂在 API key 校验之前，未认证的洪水一样被挡。
- 登录失败按账号计数并锁定（默认 15 分钟内失败 5 次锁 15 分钟），重复锁定时长翻倍，上限 24 小时——这样即使被别人的脚本锁住，当天也还能进得去。

在不可信网络上还应至少做一件事：改绑 `HOST=127.0.0.1`、用防火墙挡住端口，或者放到反向代理 + TLS 后面。放在反向代理后面时**必须**设 `PRISM_TRUST_PROXY=1`，否则限流器看到的每个请求都来自代理的 IP，所有人共用一个桶。反过来，直接暴露的服务器上**不要**设它，否则任何客户端都能伪造 `X-Forwarded-For` 给自己换一个新桶。

### API key 网关（`PRISM_API_KEY`）

除了内置的登录 + JWT，还可以在所有 `/api` 路由前面加一道共享密钥：

```bash
PRISM_API_KEY=<随机串>        # 服务端校验 x-prism-api-key 请求头
VITE_PRISM_API_KEY=<同一个值>  # 前端构建时打进 bundle
```

两个变量必须同时设置且值相同，只设服务端的那个会把自带前端一起挡在外面。

变量名特意用 `PRISM_` 前缀而不是通用的 `API_KEY`：Prism 会把自己的环境变量继承给它拉起的 Claude Code CLI 子进程，用 `API_KEY` 这种通用名字会和用户环境里已有的同名变量互相覆盖。

注意 `VITE_PRISM_API_KEY` 是编译进 JS bundle 的，浏览器里能直接看到。它是私有部署的一道门槛，不是客户端密钥。

### 其他

- `PRISM_ENCRYPTION_KEY`：数据库里存的第三方令牌（GitHub PAT、provider key）用 AES-256-GCM 加密。不设时会自动生成一个密钥并存在同一个数据库里——这挡得住只拷走 `.db` 文件的人，挡不住拷走整个数据目录的人。多机部署、以及任何可能恢复到另一台机器上的备份，都应该显式设置。
- 审计日志：登录尝试、令牌签发、权限授予记录在数据库里，通过 `GET /api/auth/audit-log` 读取，默认保留 5000 条。
- WebSocket 升级默认用 `POST /api/auth/ws-ticket` 签发的一次性 ticket，或者 `Authorization` 头。老式的 `?token=<jwt>` 查询参数默认关闭（`PRISM_ALLOW_QUERY_TOKEN=1` 可打开），因为查询串会原样落进代理日志和浏览器历史。

## 配置项（环境变量）

完整清单、默认值和每一项的取舍说明见 [.env.example](.env.example)（Docker 版见 [.env.docker.example](.env.docker.example)）。所有默认值都是从代码里读出来的，不是估的。下面是按用途分组的索引：

### 服务与网络

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_PORT` | `8080` | 后端端口（`PORT` 是兼容别名） |
| `HOST` | `0.0.0.0` | 监听地址，见上面的安全须知 |
| `PRISM_CORS_ORIGINS` | 不限 | 允许的 CORS 源，逗号分隔 |
| `PRISM_TRUST_PROXY` | `0` | 置 `1` 让限流器读 `X-Forwarded-For`，仅在自己控制的代理后面开 |

### 认证与限流

| 变量 | 默认 | 说明 |
|---|---|---|
| `JWT_SECRET` | 自动生成 | 签发 auth token 的密钥，改动会让已有登录全部失效 |
| `PRISM_API_KEY` / `VITE_PRISM_API_KEY` | 关闭 | `/api` 共享密钥网关，必须成对设置 |
| `PRISM_ALLOW_QUERY_TOKEN` | `0` | 置 `1` 接受老式 `?token=` WebSocket 认证 |
| `PRISM_RATE_LIMIT` | `1` | 置 `0` 关闭全部限流器，仅限开发 |
| `PRISM_RATE_LIMIT_WINDOW_MS` / `PRISM_RATE_LIMIT_MAX` | `60000` / `600` | `/api` 总配额（每 IP 每窗口） |
| `PRISM_AUTH_RATE_WINDOW_MS` / `PRISM_AUTH_RATE_MAX` | `900000` / `50` | 认证路由的更紧配额 |
| `PRISM_LOGIN_MAX_ATTEMPTS` / `PRISM_LOGIN_WINDOW_MS` / `PRISM_LOGIN_LOCKOUT_MS` | `5` / `900000` / `900000` | 按账号锁定，重复锁定翻倍，上限 24 小时 |
| `PRISM_ENCRYPTION_KEY` | 自动生成 | 存量第三方令牌的加密密钥 |
| `PRISM_AUDIT_LOG_MAX_ROWS` | `5000` | 审计日志保留条数 |

### Agent 运行时

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 用 CLI 登录态 | 显式指定 API key（不设则复用 Claude Code CLI 的登录） |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI 可执行文件路径 |
| `PRISM_PERSISTENT_SESSIONS` | `1` | 置 `0` 回退为每轮重建的一次性模式 |
| `PRISM_AUTO_COMPACT` | `1` | 置 `0` 关闭高水位自动 /compact |
| `PRISM_AUTO_COMPACT_RATIO` | `0.8` | 自动压缩阈值（0–1） |
| `PRISM_MAX_RUNTIMES` | `8` | 常驻会话上限 |
| `PRISM_RUNTIME_IDLE_MS` | `1800000` | 常驻会话空闲回收时间 |
| `PRISM_MAX_ONESHOT_OVERFLOW` | `2` | 常驻池之外的一次性溢出槽位 |
| `PRISM_TURN_TIMEOUT_MS` | `3600000` | 单轮看门狗，`0` 关闭 |

### 数据、备份与文件

| 变量 | 默认 | 说明 |
|---|---|---|
| `PRISM_DATA_DIR` | `~/.prism` | 数据目录（auth.db、附件、标记）；首次启动会从旧的 `~/.cloudcli` 迁移一次 |
| `DATABASE_PATH` | 数据目录内 | 单独指定 auth.db 路径 |
| `PRISM_DB_BACKUP` / `_INTERVAL_MS` / `_KEEP` | `1` / `86400000` / `7` | 周期性 SQLite 快照 |
| `PRISM_CHECKPOINTS` | `1` | 置 `0` 关闭 Git checkpoint |
| `PRISM_CHECKPOINT_DIR` | `~/.prism/checkpoints` | checkpoint 存储目录 |
| `PRISM_CHECKPOINT_INCLUDE_IGNORED` | `0` | 置 `1` 连 gitignore 的文件一起快照（慢，且会把 .env 收进去） |
| `PRISM_WATCH_POLL` / `_INTERVAL_MS` | `0` / `6000` | 用轮询代替 inotify，NFS/SMB 和部分容器挂载上需要 |
| `PRISM_FILETREE_MAX_ENTRIES` | `5000` | 单次文件树请求的条目上限 |

### 文档摄取

| 变量 | 默认 | 说明 |
|---|---|---|
| `PRISM_DOC_MAX_CHARS` | `200000` | 单个文档保留的提取文本字数 |
| `PRISM_DOC_MAX_UNCOMPRESSED` | `209715200` | 解压总量上限（zip 炸弹防护） |
| `PRISM_PDF_TIMEOUT_MS` / `PRISM_URL_FETCH_TIMEOUT_MS` | `30000` / `20000` | PDF 解析 / URL 抓取超时 |

## 新增 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/checkpoints?sessionId=` | 会话 checkpoint 列表 |
| GET | `/api/checkpoints/:id/changes` | 相对 checkpoint 的文件改动 + diff |
| POST | `/api/checkpoints/:id/restore` | 事务式整轮回滚 |
| POST | `/api/checkpoints/:id/revert-file` | 逐文件撤销 |
| POST | `/api/documents/parse` | 文档上传解析（multipart `document`） |
| POST | `/api/documents/fetch-url` | URL 正文抓取（`{ url }`） |
| GET | `/api/claude/context-usage?sessionId=` | 常驻会话精确上下文用量 |
| GET | `/api/providers/sessions/:id/export?format=md\|json` | 导出整段会话记录 |
| POST | `/api/auth/ws-ticket` | 签发一次性 WebSocket 升级 ticket |
| GET | `/api/auth/audit-log` | 读取安全审计日志 |
| GET | `/api/ready` | 就绪探针（会真的查一次数据库，未就绪返回 503） |
| GET | `/health` | 存活探针（不查数据库） |

## 开发

```bash
npm run lint       # eslint
npm run typecheck  # 前后端两套 tsconfig
npm test           # vitest（server + client 两个 project）
npm run build      # vite build + tsc
```

提交前 husky 会跑 lint-staged，push 前会跑 typecheck + test；CI（`.github/workflows/ci.yml`）跑同样四项，外加构建 Docker 镜像并等容器 `/api/ready` 返回 200。

## 许可

基于上游项目的开源许可（见 LICENSE / NOTICE）。Prism 的改造部分同样遵循相同许可发布。
