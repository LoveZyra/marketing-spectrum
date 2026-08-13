# Prism · Docker 部署

从源码构建 Prism 镜像并运行 Web 服务。适合自托管部署（等价于 systemctl 那套，只是容器化）。

镜像为**精简版**：只支持 Claude，走内置的 Claude Agent SDK（`node_modules` 内自带运行时，无需全局安装 CLI），用 `ANTHROPIC_API_KEY` 认证；镜像内置 `git` / `ripgrep` / `bash` / `tini`。

---

## 快速开始（docker compose，推荐）

在项目根目录（`Dockerfile` 与 `docker-compose.yml` 所在处）：

```bash
cp .env.docker.example .env      # 至少填 ANTHROPIC_API_KEY、JWT_SECRET
docker compose up -d --build
```

打开 `http://<服务器IP>:8080`，首次访问设置登录密码即可。

查看日志 / 状态 / 停止：

```bash
docker compose logs -f
docker compose ps                # STATUS 里会带 (healthy)，见下面「健康检查」
docker compose down              # 停止（数据卷保留）
```

---

## 仅用 Dockerfile（不使用 compose）

```bash
docker build -t prism:latest .

docker run -d --name prism -p 8080:8080 \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -v prism-data:/data \
  -v "$PWD/projects:/workspace" \
  prism:latest
```

`SERVER_PORT` / `HOST` / `WORKSPACES_ROOT` 已经写在镜像的 `ENV` 里（`8080` / `0.0.0.0` / `/workspace`），不传也是对的。要传更多变量时用 `--env-file .env`，效果和 compose 的 `env_file` 一致。

---

## 数据与目录

| 容器路径 | 用途 | 建议挂载 |
|---|---|---|
| `/data` | `auth.db`（登录）、checkpoint、`~/.claude` 会话、插件、上传附件 | 命名卷 `prism-data`（**务必持久化**，否则重启丢登录与历史） |
| `/workspace` | Agent 操作的代码项目（`WORKSPACES_ROOT`） | 绑定到你的真实代码目录，如 `/home/me/code:/workspace` |

镜像里 `HOME=/data`，而 Prism 的数据目录默认就是 `~/.prism`，所以**不需要设 `PRISM_DATA_DIR`**：数据库、checkpoint、插件自动落在 `/data/.prism`，Claude Code 自己的会话记录落在 `/data/.claude`，一个卷持久化全部状态。只有想把这个目录挪到别处时才需要设它——而且要指到 `/data` 里面，否则反而不再持久化。

`/workspace` 用绑定挂载时注意属主：容器以非 root 的 `prism` 用户运行（`uid 10001`，见 `Dockerfile` 的 `useradd`）。绑定挂载会沿用宿主机目录的属主，如果宿主目录不允许 `uid 10001` 写入，Agent 就只能读不能改。要么 `sudo chown -R 10001:10001 ./projects`，要么把目录权限放开。命名卷 `/data` 没有这个问题——Docker 初始化空卷时会带上镜像里的属主。

---

## 环境变量

`docker-compose.yml` 通过 `env_file` 把项目根目录下**整个 `.env` 一起注入容器**，所以 [`.env.docker.example`](../.env.docker.example) 里任何一行取消注释都会生效，注释掉的则回落到代码自身的默认值。完整清单和默认值都在那个文件里，这里不再重复一遍以免两处不同步；每个变量的详细说明见根目录 [`.env.example`](../.env.example)。

最少需要关心的两个：

| 变量 | 说明 | 默认 |
|---|---|---|
| `ANTHROPIC_API_KEY` | Claude（Agent SDK）认证 | 无 |
| `JWT_SECRET` | 登录令牌签名密钥，设为长随机串并保持不变（改了会让已有登录全部失效） | 自动生成并存库 |

有三个变量**固定写在 compose 的 `environment:` 里**，因为它们必须和 compose 文件里的别的东西对得上，写进 `.env` 不起作用（`environment:` 的优先级高于 `env_file`）：

| 变量 | 值 | 必须和谁一致 |
|---|---|---|
| `SERVER_PORT` | `8080` | `ports:` 里发布的端口 |
| `HOST` | `0.0.0.0` | 不绑全部接口，发布出去的端口就是死的 |
| `WORKSPACES_ROOT` | `/workspace` | `/workspace` 那条绑定挂载 |

容器内 `HOST=0.0.0.0` **不是**暴露面的决策点，compose 的 `ports:` 映射才是。要收紧就改那里（`"127.0.0.1:8080:8080"`，代价是手机和局域网其他设备访问不了）、加防火墙，或者前面挂反向代理 + TLS。

> `env_file` 用的是长语法（`path:` + `required: false`），需要 Compose **v2.24 以上**（`docker compose version` 可查）。旧版本会直接报解析错误，改成短语法 `env_file: [.env]` 即可，区别只是 `.env` 必须存在。

---

## 健康检查

镜像自带 `HEALTHCHECK`，探的是 `/api/ready` 而不是 `/health`：两者都挂在 API key 网关之前（探针不需要凭据），但 `/health` 只是存活探针，数据库已经用不了的进程它照样返回 200；`/api/ready` 会真的过一次 SQLite，没就绪时返回 503。

```bash
docker inspect --format '{{.State.Health.Status}}' prism
curl -fsS http://127.0.0.1:8080/api/ready
```

探针用的是 node 内置的 `fetch`——slim 基础镜像里既没有 `curl` 也没有 `wget`，node 是唯一保证存在的二进制。`--start-period=45s` 是留给首次启动建表和老数据目录迁移的时间，这段时间内探测失败不计入重启判定。

---

## 反向代理（可选）

生产环境建议在前面挂 Nginx/Caddy 终止 TLS，转发到 `127.0.0.1:8080`（此时可以把 compose 的 `ports:` 收成 `"127.0.0.1:8080:8080"`，只让代理能连）。

WebSocket 必须放行 `Upgrade` / `Connection` 头，且需要覆盖三条路径：`/ws`（主会话）、`/shell`（终端）、`/plugin-ws/`（插件自带的 websocket）。漏掉最后一条的症状是插件能加载、面板却一直不出数据。

子路径部署（如 `https://example.com/ai/`）直接用 [`docs/nginx-subpath-template.conf`](../docs/nginx-subpath-template.conf)，改开头两个变量即可。

挂了代理之后记得把 `PRISM_TRUST_PROXY=1` 加进 `.env`，否则限流器看到的每个客户端 IP 都是代理的，所有人共用一个桶。反过来，**没有**代理直接暴露时不要设它——那样任何客户端都能伪造 `X-Forwarded-For` 给自己换一个新桶，限流形同虚设。
