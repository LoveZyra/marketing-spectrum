#!/usr/bin/env bash
# Prism 进程管理。放在 prism 目录下,日常就用这一个文件。
#
#   bash prism.sh restart    重启(最常用)
#   bash prism.sh start      启动(已在跑则拒绝,不会起出第二个)
#   bash prism.sh stop       停止(连守护循环一起停)
#   bash prism.sh status     看守护循环、服务进程、端口、重启次数、就绪状态
#   bash prism.sh logs       跟踪日志(Ctrl+C 只退出跟踪,不影响服务)
#   bash prism.sh install    首次安装 / 升级后重建(转调 deploy.sh)
#
# 不带参数只打用法,不默认 restart:手滑敲一下就会把所有人的会话重启一遍。
#
# 几条关键约束:
#
#   1. 守护循环直接起 node,不经过 npm:经 npm 起时真正监听端口的是孙进程
#      (npm → sh -c → node),只杀 npm 那层,node 仍占着端口,紧接着的启动必然 EADDRINUSE。
#      停止时按 pid 文件点名,并且等到端口真的释放才继续。
#
#   2. HOST 可能绑在具体网卡地址(例如 10.195.27.109)而不是 0.0.0.0,这时
#      `curl localhost:8080` 连不上,服务好好的却看起来没起来。健康检查按 .env 里的 HOST 走。
#
#   3. 启动要 `env -u API_KEY`:pod 继承的模型凭据会让 Prism 自己的 REST 返回 401。
#
#   4. 启动耗时差别很大(首次要跑迁移和项目扫描),不用固定 sleep 去猜:轮询就绪端点
#      (/api/ready:数据库能应答才算 200,/health 只说明进程活着),并且用服务 pid 判断死活。
#
#   5. 探测端口占用不能只依赖 `ss`(精简镜像里常常没有):依次退到 lsof、fuser,
#      都没有就用健康端点兜底。
#
#   6. 生产机没有 systemd(jovyan 的 `systemd --user` 起不来),所以 `start` 起的是一个
#      守护循环(本脚本以 `__supervise` 再跑一份):服务进程不是 stop 触发的退出就退避重启
#      (1s → 2s → … 封顶 60s,稳定跑满 PRISM_SUPERVISOR_STABLE_SECS 秒后退避归零),
#      每次拉起都记进 prism.log。`stop` 先落 stop 标记再杀,守护循环看到标记就不再拉起。
#
#   7. Node 侧 shutdown 的硬退出窗口是 12 秒(两个受管子进程并行停,各有 4 秒 TERM 宽限),
#      所以 TERM 之后等 15 秒才 kill -9,保证数据库关闭那一步走得完。
#
#   8. prism.log 运行期按大小轮转(PRISM_LOG_ROTATE_MB,默认 50)。服务以 `>>` 追加方式
#      打开日志,所以"拷一份再截断"(copytruncate)之后进程从文件头继续写,不会留下空洞。
set -u

cd "$(dirname "$0")" || exit 1
APP_DIR="$(pwd)"
LOG_FILE="$APP_DIR/prism.log"
NODE_ENTRY="dist-server/server/index.js"
# 运行期状态都放这个目录:守护循环 pid、服务 pid、stop 标记、重启计数。
RUN_DIR="$APP_DIR/.run"
SUP_PID_FILE="$RUN_DIR/supervisor.pid"
SVC_PID_FILE="$RUN_DIR/service.pid"
STOP_FILE="$RUN_DIR/stop"
RESTARTS_FILE="$RUN_DIR/restarts"

# --- 从 .env 读取配置(与 server/utils/dotenv-parse.js 的规则一致,见那里的注释) ---
#   · 取最后一次赋值;`export KEY=` 前缀允许;
#   · 值以引号开头:取到配对引号为止,后面的丢;
#   · 否则从"前面有空白的 #"起截断,再 trim。紧贴的 `abc#def` 不算注释。
# 环境里已经 export 的同名变量优先(与 load-env.js 一致)。
read_env() {
  local key="$1" fallback="$2" value="" raw=""
  if [ -n "${!key:-}" ]; then echo "${!key}"; return; fi
  if [ -f "$APP_DIR/.env" ]; then
    raw=$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$APP_DIR/.env" 2>/dev/null \
            | tail -1 | tr -d '\r' | sed -E 's/^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=//')
    value=$(printf '%s' "$raw" | sed -E '
      s/^[[:space:]]+//; s/[[:space:]]+$//
      /^"([^"]*)".*$/{ s/^"([^"]*)".*$/\1/; b }
      /^'"'"'([^'"'"']*)'"'"'.*$/{ s/^'"'"'([^'"'"']*)'"'"'.*$/\1/; b }
      s/[[:space:]]+#.*$//
      s/[[:space:]]+$//
    ')
  fi
  [ -n "${value}" ] && echo "$value" || echo "$fallback"
}

PORT="$(read_env SERVER_PORT 8080)"
HOST="$(read_env HOST 0.0.0.0)"
# 保留几代旧日志。0 表示不保留:每次启动截断,运行期超过 LOG_ROTATE_MB 也直接截断。
LOG_KEEP="$(read_env PRISM_LOG_KEEP 5)"
# 运行期按大小轮转的阈值(MB)。0 = 不按大小轮转。
LOG_ROTATE_MB="$(read_env PRISM_LOG_ROTATE_MB 50)"
# 服务连续跑满这么多秒算"稳定",退避归零。
STABLE_SECS="$(read_env PRISM_SUPERVISOR_STABLE_SECS 600)"
# 0.0.0.0 是"所有网卡",不能拿它当请求地址;绑具体 IP 时也不能用 localhost。
if [ "$HOST" = "0.0.0.0" ] || [ -z "$HOST" ]; then
  HEALTH_HOST="127.0.0.1"
else
  HEALTH_HOST="$HOST"
fi
HEALTH_URL="http://${HEALTH_HOST}:${PORT}/api/ready"

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

# pid 文件里的进程还活着吗。文件没有 / 空 / 进程不在 → 1。
pid_alive() {
  local file="$1" pid
  [ -f "$file" ] || return 1
  pid="$(tr -dc '0-9' < "$file")"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}
pid_of() { [ -f "$1" ] && tr -dc '0-9' < "$1"; }

# 守护循环:自己那份 pid 文件的进程活着,且命令行确实是本脚本的 __supervise
# (pid 被复用给别的进程时不算)。
supervisor_alive() {
  local pid
  pid_alive "$SUP_PID_FILE" || return 1
  pid="$(pid_of "$SUP_PID_FILE")"
  ps -p "$pid" -o args= 2>/dev/null | grep -q '__supervise'
}

service_alive() { pid_alive "$SVC_PID_FILE"; }

# 本目录起的服务进程(按绝对路径匹配 —— 同一台机上另一个目录的 Prism 不算)。
own_node_pids() { pgrep -f "node $APP_DIR/$NODE_ENTRY" 2>/dev/null; }

# 没有 pid 文件的实例(例如直接 `npm run server` 起的,命令行里是相对路径,own_node_pids 认不出):
# 按端口找。没有任何端口探测工具时才退到按进程名匹配,那一路可能误伤同机别的 Prism,所以放最后。
legacy_pids() {
  local pids
  pids="$(port_pids)"
  if [ -n "$pids" ]; then echo "$pids"; return; fi
  if ! command -v ss >/dev/null 2>&1 \
     && ! command -v lsof >/dev/null 2>&1 \
     && ! command -v fuser >/dev/null 2>&1; then
    pgrep -f " $NODE_ENTRY" 2>/dev/null
  fi
}

# 服务在跑:守护循环 / 服务 pid / 端口 / 本目录的 node 进程,任一命中。
running() {
  supervisor_alive && return 0
  service_alive && return 0
  port_busy && return 0
  [ -n "$(own_node_pids)" ]
}

sup_log() {
  printf '%s [supervisor] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG_FILE"
}

# 把 prism.log 挪成 prism.log.1,旧的依次后移,超出 LOG_KEEP 的丢掉;LOG_KEEP=0 不留旧日志,直接截断。
# 用 mv 而不是 cp+truncate:mv 是原子的,不会出现"拷到一半又被写"的半截文件。
# 只在没有进程在写的时候用(启动前)。
rotate_logs() {
  [ -f "$LOG_FILE" ] || return 0
  if [ "$LOG_KEEP" -le 0 ] 2>/dev/null; then : > "$LOG_FILE"; return 0; fi
  shift_old_logs
  mv -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null
}

shift_old_logs() {
  local i
  i="$LOG_KEEP"
  rm -f "${LOG_FILE}.${i}" 2>/dev/null
  while [ "$i" -gt 1 ]; do
    if [ -f "${LOG_FILE}.$((i - 1))" ]; then
      mv -f "${LOG_FILE}.$((i - 1))" "${LOG_FILE}.${i}" 2>/dev/null
    fi
    i=$((i - 1))
  done
}

# 运行期轮转(copytruncate):有进程正往 prism.log 里写,不能 mv —— 进程会跟着 inode
# 继续写到 prism.log.1 里,新的 prism.log 一直是空的。拷一份再截断;服务以 O_APPEND
# 打开,截断后写指针自动回到文件头,不会留空洞。cp 与截断之间写进来的几行会丢,认了 ——
# 这是 logrotate copytruncate 同样的取舍。LOG_KEEP=0 不留旧日志:超过阈值直接截断。
rotate_log_by_size() {
  [ -f "$LOG_FILE" ] || return 0
  if [ "$LOG_ROTATE_MB" -le 0 ] 2>/dev/null; then return 0; fi
  local size
  size=$(stat -c %s "$LOG_FILE" 2>/dev/null || stat -f %z "$LOG_FILE" 2>/dev/null || echo 0)
  [ "$size" -ge $((LOG_ROTATE_MB * 1024 * 1024)) ] || return 0
  if [ "$LOG_KEEP" -le 0 ] 2>/dev/null; then
    : > "$LOG_FILE"
    sup_log "prism.log 超过 ${LOG_ROTATE_MB}MB,已截断(PRISM_LOG_KEEP=0,不留旧日志)"
    return 0
  fi
  shift_old_logs
  cp -f "$LOG_FILE" "${LOG_FILE}.1" 2>/dev/null && : > "$LOG_FILE"
  sup_log "prism.log 超过 ${LOG_ROTATE_MB}MB,已轮转到 prism.log.1"
}

# ---------------------------------------------------------------------------
# 守护循环本体。由 do_start 以 `setsid bash prism.sh __supervise` 起在后台,
# 不直接从命令行调。
# ---------------------------------------------------------------------------
# 服务退出后收掉它进程组里的残留子进程(见 do_supervise 里的说明)。
# 只在那个组确实是服务自己的(≠ 守护循环自己的组)时才动,防止误杀自己。
sweep_service_group() {
  local pgid="$1" own i
  [ -n "$pgid" ] || return 0
  own=$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')
  [ "$pgid" != "$own" ] || return 0
  kill -0 -- "-$pgid" 2>/dev/null || return 0
  sup_log "收掉服务进程组 ${pgid} 里的残留子进程"
  kill -TERM -- "-$pgid" 2>/dev/null
  for i in 1 2 3 4 5 6 7 8 9 10; do
    kill -0 -- "-$pgid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 -- "-$pgid" 2>/dev/null
}

do_supervise() {
  mkdir -p "$RUN_DIR"
  echo $$ > "$SUP_PID_FILE"
  echo 0 > "$RESTARTS_FILE"
  rm -f "$STOP_FILE"

  local child=""
  # 守护循环自己被 TERM/INT(比如有人直接 kill 它):落 stop 标记、把服务一起收掉再退。
  # 不然服务成孤儿还在跑,而 status 会说"守护循环不在"。
  on_signal() {
    : > "$STOP_FILE"
    if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then kill -TERM "$child" 2>/dev/null; fi
  }
  trap on_signal TERM INT
  trap '' HUP
  # 没有 setsid 时,守护循环与 `bash prism.sh start` 在同一个前台进程组里:start 等就绪期间
  # 按 Ctrl-C,INT 也会发给守护循环,被 on_signal 当成 stop 把服务收掉。这种 INT 只可能来自终端,
  # 不是停止意图(停止走 `prism.sh stop` / TERM),所以忽略。
  # 服务进程由下面的 `set -m` 放进自己的进程组,同样收不到终端的 INT。
  if ! command -v setsid >/dev/null 2>&1; then
    trap '' INT
    set -m
  fi

  # libuv 线程池:默认 4 太小,单进程多用户下所有 fs 操作互相排队。在 node 启动
  # 前 export 一定生效(load-env.js 里也设了一份作为 npm run server 直跑时的兜底)。
  # 外部已设则尊重外部。
  : "${UV_THREADPOOL_SIZE:=16}"
  export UV_THREADPOOL_SIZE
  # 直接起 node 不经过 npm,补上 npm run 会加的 .bin 路径。
  export PATH="$APP_DIR/node_modules/.bin:$PATH"

  local backoff=1 restarts=0 started lived code tick=0 svc_pgid=""
  while :; do
    [ -f "$STOP_FILE" ] && break
    started=$(date +%s)
    if [ "$restarts" -gt 0 ]; then sup_log "第 ${restarts} 次拉起服务"; else sup_log "起服务(守护循环 pid $$)"; fi
    # env -u API_KEY:见文件头第 3 条。
    # 服务单独一个进程组(setsid)。node 被 kill -9 / OOM 时,它拉起的子进程(SkillWhet serve、
    # 营销诊断、claude CLI 一次性进程)不会跟着死:孤儿 serve 占着端口,新服务再起 serve 会一直
    # EADDRINUSE;孤儿 claude 进程还可能继续花钱。所以服务退出后先按进程组收掉残留再拉起。
    # 脚本非交互、无作业控制,后台子进程不是组长,setsid 直接 exec,$! 就是 node。
    if command -v setsid >/dev/null 2>&1; then
      env -u API_KEY setsid node "$APP_DIR/$NODE_ENTRY" >> "$LOG_FILE" 2>&1 &
    else
      # 没有 setsid:上面 `set -m` 打开了作业控制,后台作业自成一组(pgid = 它自己的 pid)。
      env -u API_KEY node "$APP_DIR/$NODE_ENTRY" >> "$LOG_FILE" 2>&1 &
    fi
    child=$!
    echo "$child" > "$SVC_PID_FILE"
    # 进程组号直接取 $child,不用 ps 去读:`&` 之后 setsid 未必已经执行,读到的可能还是守护循环
    # 自己的组,sweep 就会被跳过。两条分支里服务都是自己那一组的组长(setsid 直接 exec / set -m),
    # 组号必然等于它的 pid。
    svc_pgid="$child"

    # 等子进程退出。不用 `wait` 死等:每 2 秒醒一次,顺带看要不要轮转日志。
    tick=0
    while kill -0 "$child" 2>/dev/null; do
      sleep 2
      tick=$((tick + 1))
      if [ $((tick % 15)) -eq 0 ]; then rotate_log_by_size; fi
    done
    wait "$child" 2>/dev/null; code=$?
    child=""
    sweep_service_group "$svc_pgid"
    rm -f "$SVC_PID_FILE"
    lived=$(( $(date +%s) - started ))

    if [ -f "$STOP_FILE" ]; then
      sup_log "服务已退出(code=${code}),是 stop 要求的,不再拉起"
      break
    fi
    # 稳定跑满一段时间再崩,算"新的一次事故",退避从头来。
    if [ "$lived" -ge "$STABLE_SECS" ]; then backoff=1; fi
    restarts=$((restarts + 1))
    echo "$restarts" > "$RESTARTS_FILE"
    sup_log "服务意外退出(code=${code},活了 ${lived}s),${backoff}s 后第 ${restarts} 次拉起"
    # 退避期间也要能被 stop 打断。
    local waited=0
    while [ "$waited" -lt "$backoff" ]; do
      [ -f "$STOP_FILE" ] && break
      sleep 1; waited=$((waited + 1))
    done
    backoff=$((backoff * 2)); [ "$backoff" -gt 60 ] && backoff=60
  done
  sup_log "守护循环退出"
  rm -f "$SUP_PID_FILE"
}

do_stop() {
  echo "=== 停止 ==="
  if ! running; then
    echo "  没有在跑"
    rm -f "$SUP_PID_FILE" "$SVC_PID_FILE" "$STOP_FILE"
    return 0
  fi

  # 先落标记再动手:守护循环看到它就不再拉起。
  mkdir -p "$RUN_DIR"
  : > "$STOP_FILE"

  # 先礼后兵:TERM 给进程收尾的机会(关数据库连接、回收子进程)。
  # 按 pid 文件点名;老脚本起的实例没有 pid 文件,退到按进程名。
  local svc pid
  svc="$(pid_of "$SVC_PID_FILE" 2>/dev/null)"
  if [ -n "$svc" ] && kill -0 "$svc" 2>/dev/null; then
    kill -TERM "$svc" 2>/dev/null
  else
    for pid in $(own_node_pids) $(legacy_pids); do kill -TERM "$pid" 2>/dev/null; done
  fi

  # 最多等 15 秒:Node 侧硬退出窗口是 12 秒(其中子进程并行停,各有 4 秒 TERM 宽限),
  # 提前 kill -9 会让数据库关闭那一步走不完。
  local i
  for i in $(seq 1 75); do
    if ! service_alive && ! port_busy && [ -z "$(own_node_pids)" ]; then
      break
    fi
    sleep 0.2
  done

  if service_alive || port_busy || [ -n "$(own_node_pids)" ]; then
    echo "  TERM 之后 15 秒仍在运行,升级到 KILL"
    [ -n "$svc" ] && kill -9 "$svc" 2>/dev/null
    for pid in $(own_node_pids) $(legacy_pids); do kill -9 "$pid" 2>/dev/null; done
    command -v fuser >/dev/null 2>&1 && fuser -k "${PORT}/tcp" 2>/dev/null
    for _ in $(seq 1 25); do
      service_alive || port_busy || break
      sleep 0.2
    done
  fi

  # 守护循环看到 stop 标记会自己退;给它几秒,不退就杀。
  for _ in $(seq 1 25); do
    supervisor_alive || break
    sleep 0.2
  done
  if supervisor_alive; then
    kill -TERM "$(pid_of "$SUP_PID_FILE")" 2>/dev/null
    sleep 1
    supervisor_alive && kill -9 "$(pid_of "$SUP_PID_FILE")" 2>/dev/null
  fi
  rm -f "$SUP_PID_FILE" "$SVC_PID_FILE"

  if port_busy; then
    echo "  !! 端口 ${PORT} 仍被占用。占用者:"
    port_pids | while read -r pid; do ps -p "$pid" -o pid=,cmd= 2>/dev/null; done
    return 1
  fi
  echo "  已停止"
  return 0
}

do_start() {
  echo "=== 启动 ==="
  if supervisor_alive; then
    echo "  !! 守护循环已经在跑(pid $(pid_of "$SUP_PID_FILE")),拒绝启动。要重启用:bash prism.sh restart"
    return 1
  fi
  if running; then
    echo "  !! 已经在跑了(端口 ${PORT}),拒绝启动。要重启用:bash prism.sh restart"
    return 1
  fi
  if [ ! -d "$APP_DIR/dist-server" ]; then
    echo "  !! 没有 dist-server,先跑一次:bash prism.sh install"
    return 1
  fi

  mkdir -p "$RUN_DIR"
  rm -f "$STOP_FILE" "$SUP_PID_FILE" "$SVC_PID_FILE"
  # 重启计数必须在起守护循环之前清零:下面的就绪轮询很快就会读它,守护循环那时多半还没来得及
  # 写 0,上一轮残留的 ≥3 会让 start / restart 误报「服务反复退出」。
  echo 0 > "$RESTARTS_FILE"

  # 启动前轮转旧日志,不截断:"服务挂了、重启一下"是最常见的操作,截断会把查原因要用的日志抹掉。
  # 只有 PRISM_LOG_KEEP=0(明确不要旧日志)时 rotate_logs 才截断。
  rotate_logs
  : >> "$LOG_FILE"

  # 起守护循环:自己的会话(setsid),不吃终端的 HUP;stdio 全部脱离终端。
  if command -v setsid >/dev/null 2>&1; then
    setsid bash "$APP_DIR/prism.sh" __supervise < /dev/null > /dev/null 2>&1 &
  else
    nohup bash "$APP_DIR/prism.sh" __supervise < /dev/null > /dev/null 2>&1 &
  fi
  local sup_pid=$!
  echo "  守护循环 pid ${sup_pid},日志 ${LOG_FILE}"

  # 轮询就绪端点。死活以 pid 文件为准:守护循环起 node 要一两秒,pid 文件出现前的
  # 空窗不算失败;守护循环自己没了(没有 dist-server 之类)才是失败。
  local i svc
  for i in $(seq 1 90); do
    if health >/dev/null; then
      svc="$(pid_of "$SVC_PID_FILE" 2>/dev/null)"
      echo "  就绪(约 ${i} 秒),服务 pid ${svc:-?}"
      echo "  ${HEALTH_URL} -> $(health)"
      return 0
    fi
    if ! kill -0 "$sup_pid" 2>/dev/null && ! supervisor_alive; then
      echo "  !! 守护循环已退出。日志尾部:"
      tail -30 "$LOG_FILE"
      return 1
    fi
    # 服务起来又立刻死、守护循环在退避重试:把这个状态说出来,别让人干等 90 秒。
    if [ "$(cat "$RESTARTS_FILE" 2>/dev/null || echo 0)" -ge 3 ]; then
      echo "  !! 服务反复退出(守护循环已拉起 $(cat "$RESTARTS_FILE") 次)。它会继续退避重试;日志尾部:"
      tail -30 "$LOG_FILE"
      return 1
    fi
    sleep 1
  done

  echo "  !! 90 秒内没等到就绪响应(守护循环仍在,会继续等/重试)。日志尾部:"
  tail -30 "$LOG_FILE"
  return 1
}

do_status() {
  echo "目录       ${APP_DIR}"
  echo "监听       ${HOST}:${PORT}"
  echo "就绪检查   ${HEALTH_URL}"

  if supervisor_alive; then
    echo "守护循环   pid $(pid_of "$SUP_PID_FILE"),已拉起 $(cat "$RESTARTS_FILE" 2>/dev/null || echo 0) 次"
  else
    echo "守护循环   (不在)"
  fi
  if service_alive; then
    echo "服务进程   pid $(pid_of "$SVC_PID_FILE")"
  elif [ -n "$(own_node_pids)" ]; then
    echo "服务进程   (没有 pid 文件,但进程在:$(own_node_pids | tr '\n' ' '))"
  else
    echo "服务进程   (无)"
  fi

  local pids body
  pids="$(port_pids | tr '\n' ' ')"
  if [ -n "${pids// /}" ]; then
    echo "占用端口   ${pids}"
  else
    echo "占用端口   (无)"
  fi

  body="$(health)"
  if [ -n "$body" ]; then
    echo "就绪       ${body}"
  else
    echo "就绪       无响应"
  fi
}

case "${1:-}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop && do_start ;;
  status)  do_status ;;
  logs)    tail -f "$LOG_FILE" ;;
  install) bash "$APP_DIR/deploy.sh" ;;
  __supervise) do_supervise ;;
  *)
    echo "用法: bash prism.sh {start|stop|restart|status|logs|install}"
    exit 1
    ;;
esac
