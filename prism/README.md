# Prism

Prism 是一个多人共用的 Claude Code 工作台:在浏览器里和 Claude Code 对话,同时使用终端、文件树与编辑器、Notebook、定时任务和技能优化。一台服务器部署一份,团队成员各自登录使用。

对话由随包的 Claude Code CLI 执行(经 `@anthropic-ai/claude-agent-sdk` 驱动,每个会话一个常驻进程)。只支持浏览器访问。

## 功能

- **对话**:常驻会话(断线重放、排队续发、回合中插话)、工具执行与子代理过程可视化、权限审批与 Plan 模式、进度时间轴(任务清单)、产出文件面板、后台任务面板、上下文用量圆环、`/` 命令与 `@` 文件引用、会话内查找、会话导出 / 归档 / 最近删除。
- **撤销**:git 仓库里每轮自动存档,可整轮回滚或逐文件撤销;非 git 目录用 CLI 的文件检查点撤销本轮改动。
- **附件与文档**:图片(发给模型前自动缩图,磁盘原图不动)、PDF / Word / PPT / Excel / CSV / 文本解析、URL 正文抓取(带 SSRF 防护)、大文件分片上传。
- **工作区**:多标签终端(可接管会话)、文件树与多标签编辑器(全局内容搜索、拖放上传)、内置 JupyterLab。
- **模型**:模型目录(上下文窗口、思考档位、厂商图标、一致性实测)、多个模型网关与个人 key、私有模型、按人限定可用模型。
- **定时任务**:服务端调度,到点把指令发给 Claude,结果写进指定会话。
- **技能优化(SkillWhet)**:技能资产、任务集、训练 / 评测 / 版本发布、夜训。
- **多用户**:注册审批;项目分个人 / 公共 / 指定成员三种可见性;外部 API(API Key + 会话号);用量与费用记录;安全审计日志。
- **界面**:默认中文,完整支持中英文,另有 8 种语言的部分翻译;三套界面主题。

## 快速开始

要求 Node.js ≥ 22,以及编译原生模块用的工具链(python3、make、g++)。

```bash
npm install
npm run dev                              # 开发:后端 :8080 + Vite :5173
npm run build && bash prism.sh start     # 生产
```

Claude 的认证与网关在 `~/.claude/settings.json` 里配置(也可以在 `.env` 里设 `ANTHROPIC_API_KEY`);Prism 启动时会自检这份配置,并在日志里说明缺什么。

- 新服务器部署:[新服务器部署说明.md](新服务器部署说明.md)
- Docker 部署:[docker/README.md](docker/README.md)
- 挂在子路径下的反向代理模板:[docs/nginx-subpath-template.conf](docs/nginx-subpath-template.conf)
- 日常运维:`bash prism.sh start | stop | restart | status | logs`

## 安全须知

Prism 默认监听 `0.0.0.0`,这样局域网内其他机器的浏览器可以直接打开。代价是任何能连到这个端口的人都可以尝试登录,而登录之后就能驱动一个有完整文件系统访问权限的 agent。

因此默认开着两道限流:

- 所有 `/api` 路由按 IP 滑动窗口限流(默认每分钟 600 次),挂在 API key 校验之前,未认证的请求一样被挡。
- 登录失败按账号计数并锁定(默认 15 分钟内失败 5 次锁 15 分钟),重复锁定时长翻倍,上限 24 小时。

在不可信网络上至少再做一件事:改绑 `HOST=127.0.0.1`、用防火墙挡住端口,或者放到反向代理 + TLS 后面。放在反向代理后面时必须设 `PRISM_TRUST_PROXY=1`,否则限流器看到的每个请求都来自代理的 IP,所有人共用一个配额;直接暴露的服务器上不要设它,否则任何客户端都能伪造 `X-Forwarded-For` 换一个新配额。

所有用户共用服务进程的系统账号:有终端权限的人读得到数据库、`.env` 和 `~/.claude/settings.json`。只把终端开给可信的人。

### API key 网关(`PRISM_API_KEY`)

除了登录 + JWT,还可以在所有 `/api` 路由前面加一道共享密钥:

```bash
PRISM_API_KEY=<随机串>        # 服务端校验 x-prism-api-key 请求头
VITE_PRISM_API_KEY=<同一个值>  # 前端构建时打进 bundle
```

两个变量必须同时设置且值相同,只设服务端那个会把自带前端一起挡在外面。`VITE_PRISM_API_KEY` 编译进 JS bundle,浏览器里看得到:它是私有部署的一道门槛,不是客户端密钥。

### 其他

- `PRISM_ENCRYPTION_KEY`:数据库里存的第三方令牌与网关 key 用 AES-256-GCM 加密。不设时自动生成一个密钥存在同一个数据库里,挡得住只拷走 `.db` 文件的人,挡不住拷走整个数据目录的人。多机部署、以及可能恢复到另一台机器上的备份,都应该显式设置。
- 审计日志:登录、令牌签发、权限变更、删除等操作记在数据库里,root 在「设置 → 账号」里查看,默认保留 5000 条。
- WebSocket 连接用 `POST /api/auth/ws-ticket` 签发的一次性票据鉴权。旧式的 `?token=<jwt>` 查询参数默认关闭,因为查询串会原样落进代理日志和浏览器历史。

## 配置

全部配置项、默认值和取舍说明见 [.env.example](.env.example)(Docker 版见 [.env.docker.example](.env.docker.example))。部署时最常改的几项:

| 变量 | 默认 | 说明 |
|---|---|---|
| `SERVER_PORT` / `HOST` | `8080` / `0.0.0.0` | 监听端口与地址,见上面的安全须知 |
| `PRISM_ROOT_USERS` | 无 | 管理员用户名,逗号分隔;先用这个名字注册,账号才拿到 root |
| `PRISM_PUBLIC_WORKSPACE` | 无 | 公共工作目录,其下的项目对所有登录用户可见 |
| `JWT_SECRET` | 自动生成 | 签发登录令牌的密钥,改动会让已有登录全部失效 |
| `PRISM_ENCRYPTION_KEY` | 自动生成 | 令牌与 key 的加密密钥 |
| `PRISM_TRUST_PROXY` | `0` | 在自己控制的反向代理后面时置 `1` |
| `PRISM_DATA_DIR` | `~/.prism` | 数据目录(数据库、备份、附件、检查点) |
| `PRISM_MAX_RUNTIMES` | `20` | 全服务器常驻 Claude 进程上限 |
| `PRISM_RUNTIME_IDLE_MS` | `1800000` | 常驻进程空闲回收时间 |
| `PRISM_TASK_APPROVAL` | `deny` | 定时任务里需要审批的工具调用:`deny` 直接拒,`wait` 等人批 |

## 开发

```bash
npm run lint       # eslint
npm run typecheck  # 前后端两套 tsconfig
npm test           # vitest(server + client 两个 project)
npm run build      # 构建前自检(退役文件、i18n 键)+ vite build + tsc
```

提交前 husky 跑 lint-staged,push 前跑 typecheck + test;CI(`.github/workflows/ci.yml`)跑同样四项,外加构建 Docker 镜像并等容器 `/api/ready` 返回 200。

存活探针 `GET /health`(不查数据库),就绪探针 `GET /api/ready`(查一次数据库,未就绪返回 503)。

## 版本号

版本号是 `package.json` 的 `version`,只用「主.次.修」三个数字,按部署方要付出的代价跳号:要人工介入的升级跳主版本号;可回滚的迁移、依赖变化、新增可选配置或用户看得见的新功能跳次版本号;只改代码跳修订号。

```bash
node scripts/release.mjs check                 # 按上一个 v* 标签检查跳号是否合规
node scripts/release.mjs pack --out <目录>      # 从 HEAD 打包,生成包、逐文件清单和 RELEASE.json
```

运行中的版本、发布日期与提交号显示在「设置 → 关于」、`/status`、`prism status`、启动日志和 `GET /health` 里。

## 许可与署名

Prism 以 GNU Affero General Public License v3.0 or later(AGPL-3.0-or-later)发布,全文及第 7 条附加条款见 [LICENSE](LICENSE)。

Prism 是在 CloudCLI UI (https://github.com/siteboon/claudecodeui) 基础上修改而来的版本,不是 CloudCLI UI 原版软件。部分文件含有源自 Claude Code Web(https://github.com/heng1234/claude-web,Apache License 2.0)的实现,已修改。版权与许可声明见 [NOTICE](NOTICE),Apache License 2.0 全文见 [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt)。
