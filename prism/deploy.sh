#!/usr/bin/env bash
# Prism 新服务器部署脚本。在解包后的 prism 目录里运行:bash deploy.sh
#
# 做四件事:环境体检 → 装依赖 → 生成 .env → 构建。**不会**自动起服务,
# 因为端口、反代、密钥这些得你确认过再启。
#
# 幂等:重复跑不会覆盖已有的 .env(会提示),依赖与构建照常刷新。
set -u
cd "$(dirname "$0")" || exit 1

echo "=== 1. 环境体检 ==="
command -v node >/dev/null || { echo "  !! 没有 node。需要 >= v22(见 .nvmrc)"; exit 1; }
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
echo "  node $(node -v)"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  !! Node 版本过低(需要 >= 22)。用 nvm 切:nvm install 22 && nvm use 22"
  exit 1
fi
command -v npm >/dev/null || { echo "  !! 没有 npm"; exit 1; }
echo "  npm $(npm -v)"
# 原生模块(better-sqlite3 等)要现场编译,缺工具链会在 npm ci 阶段炸得很难看
command -v python3 >/dev/null || echo "  ~ 没有 python3,若 npm ci 报 node-gyp 错误需先装"
command -v make >/dev/null   || echo "  ~ 没有 make,若 npm ci 报 node-gyp 错误需先装 build-essential"

echo "=== 2. 安装依赖(npm ci,按 package-lock 精确还原)==="
# 用 ci 不用 install:锁定版本,避免新机器装出一套跟老机器不同的依赖树。
npm ci || { echo "  !! 依赖安装失败。常见原因:网络不通仓库、缺 node-gyp 工具链"; exit 1; }

echo "=== 3. 配置 .env ==="
if [ -f .env ]; then
  echo "  .env 已存在,跳过生成(要重来就先备份删掉)"
else
  cp .env.example .env
  echo "  已从 .env.example 生成 .env —— 下面这几项**必须**过一遍:"
  echo "     SERVER_PORT     后端端口(默认 3001);若要走网关反代,与反代目标保持一致"
  echo "     HOST            监听地址。对外有反代时建议 127.0.0.1,别直接 0.0.0.0 裸奔"
  echo "     JWT_SECRET      不设会自动生成并存库;多实例/要可迁移就显式设一个长随机串"
  echo "   可选(要一起跑营销诊断服务时才需要):"
  echo "     PRISM_MA_API_TARGET / PRISM_MA_API_AUTOSTART / PRISM_MA_API_PYTHON"
  echo "     PRISM_ALLOW_QUERY_TOKEN=1   浏览器 WebSocket 只能用 ?token= 传凭据,不开则对话/shell 全挂"
fi

echo "=== 4. 构建(前后端)==="
# build = build:client(vite → dist) + build:server(tsc → dist-server)
npm run build || { echo "  !! 构建失败"; exit 1; }

echo
echo "=== 装完了。 ==="
echo "启动:"
echo "  npm run server              # 前台跑,先这样验一次"
echo "  # 或后台:nohup env -u API_KEY npm run server > prism.log 2>&1 &"
echo "  #   env -u API_KEY 是为了去掉 pod 继承的模型凭据,防 REST 401"
echo
echo "冒烟验证:"
echo "  curl -s localhost:\${SERVER_PORT:-3001}/health   # 应返回健康信息"
echo "  浏览器打开页面 → 注册/登录 → 新建项目 → 发一条消息"
echo "  上传:先传 <15MB 的文件,再传 ~20MB 的(走分片,F12 Network 应看到多个 chunk 请求)"
echo
echo "反代(网关/nginx)三件套,少一件大文件就会 413 或 504:"
echo "  client_max_body_size 512m;  proxy_request_buffering off;  proxy_read_timeout 1800s;"
echo
echo "数据落在 ~/.prism/(auth.db、上传的图片资源),首次启动自动创建。"
echo "换机器要保留账号就整体拷这个目录;想干净起步就别拷。"
