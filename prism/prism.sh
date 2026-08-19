#!/usr/bin/env bash
# Prism 进程管理。放在 prism 目录下,日常就用这一个文件。
#
#   bash prism.sh restart    重启 —— 最常用
#   bash prism.sh start      启动(已在跑则拒绝,不会起出第二个)
#   bash prism.sh stop       停止
#   bash prism.sh status     看进程、端口、健康
#   bash prism.sh logs       跟踪日志(Ctrl+C 只退出跟踪,不影响服务)
#   bash prism.sh install    首次安装/升级后重建(转调 deploy.sh)
#
# 这个脚本存在的理由,是几个踩过的坑:
#
#   1. `pkill -f "npm run server"` 只杀掉 npm 那一层。真正监听端口的是它的孙进程
#      (npm → sh -c → node),npm 死了 node 还在占着端口,紧接着的启动必然
#      EADDRINUSE。这里三层一起杀,并且**等到端口真的释放**才继续。
#
#   2. HOST 可能绑在具体网卡地址(例如 10.195.27.109)而不是 0.0.0.0。那种情况下
#      `curl localhost:8080` 永远连不上 —— 服务其实好好的,却看起来没起来。
#      健康检查按 .env 里的 HOST 走。
#
#   3. 启动要 `env -u API_KEY`:pod 继承的模型凭据会让 Prism 自己的 REST 返回 401。
#
#   4. 固定 sleep 猜启动时间不可靠(首次要跑迁移和项目扫描,快慢差很多)。这里轮询
#      健康端点,并且用 nohup 拿到的 pid 判断死活 —— 不能靠 pgrep 子进程,因为
#      npm 要过一会儿才把 node 孙进程拉起来,启动头一两秒查不到它并不代表失败。
#
#   5. 探测端口占用不能只依赖 `ss`:精简镜像里常常没有。依次退到 lsof、fuser,
#      都没有就用健康端点兜底。
set -u

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
LOG_FILE="$APP_DIR/prism.log"
NODE_ENTRY="dist-server/server/index.js"

# --- 从 .env 读取端口与监听地址(与 load-env.js 的取值口径一致) ---
read_env() {
  local key="$1" fallback="$2" value=""
  if [ -f "$APP_DIR/.env" ]; then
    value=$(grep -E "^[[:space:]]*${key}[[:space:]]*=" "$APP_DIR/.env" 2>/dev/null \
            | tail -1 | cut -d= -f2- | tr -d '\r' | xargs)
  fi
  [ -n "${value}" ] && echo "$value" || echo "$fallback"
}

PORT="$(read_env SERVER_PORT 8080)"
HOST="$(read_env HOST 0.0.0.0)"
# 0.0.0.0 是"所有网卡",不能拿它当请求地址;绑具体 IP 时也不能用 localhost。
if [ "$HOST" = "0.0.0.0" ] || [ -z "$HOST" ]; then
  HEALTH_HOST="127.0.0.1"
else
  HEALTH_HOST="$HOST"
fi
HEALTH_URL="http://${HEALTH_HOST}:${PORT}/health"

health() { curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null; }

# 占用 PORT 的 pid 列表。三种工具依次退让,一个都没有就返回空。
port_pids() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH 2>/dev/null | awk -v p=":${PORT}\$" '$4 ~ p' \
      | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null | sort -u
    return
  fi
  if command -v fuser >/dev/null 2>&1; then
    fuser "${PORT}/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$' | sort -u
    return
  fi
}

# 端口是否被占用。没有任何探测工具时退到健康端点 —— 它只能说明"Prism 在跑",
# 不能说明"端口空着",所以这一路只用于避免重复启动,不用于判断停止成功。
port_busy() {
  [ -n "$(port_pids)" ] && return 0
  if ! command -v ss >/dev/null 2>&1 \
     && ! command -v lsof >/dev/null 2>&1 \
     && ! command -v fuser >/dev/null 2>&1; then
    health >/dev/null && return 0
  fi
  return 1
}

running() {
  port_busy && return 0
  pgrep -f "$NODE_ENTRY" >/dev/null 2>&1
}

do_stop() {
  echo "=== 停止 ==="
  if ! running; then
    echo "  没有在跑"
    return 0
  fi

  # 先礼后兵:TERM 给进程收尾的机会(关数据库连接、回收子进程)。
  # 三层都要点名,顺序无所谓,pkill 不会因为没匹配就中断。
  pkill -f "$NODE_ENTRY" 2>/dev/null
  pkill -f "npm run server" 2>/dev/null

  for _ in $(seq 1 30); do
    running || { echo "  已停止"; return 0; }
    sleep 0.2
  done

  echo "  TERM 之后仍在运行,升级到 KILL"
  for pid in $(port_pids); do kill -9 "$pid" 2>/dev/null; done
  pkill -9 -f "$NODE_ENTRY" 2>/dev/null
  command -v fuser >/dev/null 2>&1 && fuser -k "${PORT}/tcp" 2>/dev/null

  for _ in $(seq 1 25); do
    running || { echo "  已停止"; return 0; }
    sleep 0.2
  done

  echo "  !! 端口 ${PORT} 仍被占用。占用者:"
  port_pids | while read -r pid; do ps -p "$pid" -o pid=,cmd= 2>/dev/null; done
  return 1
}

do_start() {
  echo "=== 启动 ==="
  if running; then
    echo "  !! 已经在跑了(端口 ${PORT}),拒绝启动。要重启用:bash prism.sh restart"
    return 1
  fi
  if [ ! -d "$APP_DIR/dist-server" ]; then
    echo "  !! 没有 dist-server,先跑一次:bash prism.sh install"
    return 1
  fi

  # libuv 线程池:默认 4 太小,单进程多用户下所有 fs 操作互相排队。在 node 启动
  # 前 export 一定生效(load-env.js 里也设了一份作为 npm run server 直跑时的兜底)。
  # 外部已设则尊重外部。
  : "${UV_THREADPOOL_SIZE:=16}"
  export UV_THREADPOOL_SIZE

  # env -u API_KEY:见文件头第 3 条。
  nohup env -u API_KEY npm run server > "$LOG_FILE" 2>&1 &
  local start_pid=$!
  echo "  pid ${start_pid} ,日志 ${LOG_FILE}"

  # 轮询健康端点。死活以 nohup 自己的 pid 为准 —— node 孙进程要过一会儿才出现,
  # 用它判断会在启动头一两秒误报失败(第一版就栽在这里)。
  for i in $(seq 1 90); do
    if health >/dev/null; then
      echo "  就绪(约 ${i} 秒)"
      echo "  ${HEALTH_URL} -> $(health)"
      return 0
    fi
    if ! kill -0 "$start_pid" 2>/dev/null; then
      echo "  !! 进程已退出。日志尾部:"
      tail -30 "$LOG_FILE"
      return 1
    fi
    sleep 1
  done

  echo "  !! 90 秒内没等到健康响应。日志尾部:"
  tail -30 "$LOG_FILE"
  return 1
}

do_status() {
  echo "目录       ${APP_DIR}"
  echo "监听       ${HOST}:${PORT}"
  echo "健康检查   ${HEALTH_URL}"

  local pids body
  pids="$(port_pids | tr '\n' ' ')"
  if [ -n "${pids// /}" ]; then
    echo "占用端口   ${pids}"
  elif pgrep -f "$NODE_ENTRY" >/dev/null 2>&1; then
    echo "占用端口   (没有探测工具,但进程在:$(pgrep -f "$NODE_ENTRY" | tr '\n' ' '))"
  else
    echo "占用端口   (无)"
  fi

  body="$(health)"
  if [ -n "$body" ]; then
    echo "健康       ${body}"
  else
    echo "健康       无响应"
  fi
}

case "${1:-restart}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop && do_start ;;
  status)  do_status ;;
  logs)    tail -f "$LOG_FILE" ;;
  install) bash "$APP_DIR/deploy.sh" ;;
  *)
    echo "用法: bash prism.sh {start|stop|restart|status|logs|install}"
    exit 1
    ;;
esac
