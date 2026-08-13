#!/bin/bash
# =============================================================================
# 任务执行脚本(由 schedule-task skill 从 _template/run.sh 生成)
#
# crontab 行必须长这样(注意 /bin/bash 和重定向,cron 默认 shell 是 /bin/sh,
# 且不重定向的话输出会被拿去发邮件 —— pod 里没有 MTA,等于直接丢掉):
#   0 9 * * *  /bin/bash /home/jovyan/schedule_task/<任务名>/tasks/run.sh >> /home/jovyan/schedule_task/<任务名>/logs/cron.log 2>&1
# =============================================================================

# === 任务配置(生成时填入)===
TASK_NAME="{{TASK_NAME}}"
MODEL="{{MODEL}}"                              # sonnet=全量活 / haiku=轻量文本活;空=网关默认
TIMEOUT="{{TIMEOUT}}"                          # 秒。带工具的活给 1800~2400,轻量活 300~600
ALLOWED_TOOLS="{{ALLOWED_TOOLS}}"              # 逗号或空格分隔;默认见下方兜底
MAX_TURNS="{{MAX_TURNS}}"                      # 留空=不限
REQUIRE_BIGDATA="{{REQUIRE_BIGDATA}}"          # 1=任务要用 Spark/Hive/HDFS,开跑前先验环境

set -uo pipefail

# 路径推导:run.sh 在 <task_root>/<任务名>/tasks/run.sh,
# _shared/ 在 skill 目录(~/.claude/skills/schedule-task/_shared/)——两者分离。
_SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_ROOT="$(dirname "$(dirname "$_SELF")")"        # /home/jovyan/schedule_task
BASE="$TASK_ROOT/$TASK_NAME"
SKILL_SHARED="/home/jovyan/.claude/skills/schedule-task/_shared"
LOG_DIR="$BASE/logs"
TASK_DIR="$BASE/tasks"
WORKDIR="$BASE/work"                           # claude 的固定 cwd,见下方说明
mkdir -p "$LOG_DIR" "$WORKDIR"

TS=$(date +%Y%m%d_%H%M%S)
LOG_FILE="$LOG_DIR/${TASK_NAME}_${TS}.log"
STATUS_FILE="$LOG_DIR/last_status.json"
PROMPT_FILE="$TASK_DIR/prompt.md"              # 提示词单独落盘,见下方说明
LOCK_FILE="/tmp/schedule_task_${TASK_NAME}.lock"

: "${MODEL:=sonnet}"
: "${TIMEOUT:=1800}"
# Skill 一定要给 —— 这类任务十有八九是"让 claude 去跑另一个 skill";
# Glob/Grep 不给它连找文件都费劲。
: "${ALLOWED_TOOLS:=Bash,Read,Write,Edit,Glob,Grep,Skill}"

exec >> "$LOG_FILE" 2>&1
ln -sfn "$LOG_FILE" "$LOG_DIR/latest.log"      # 早早建好:提前退出的分支也要能 tail latest
echo "=== 开始 $(date -Iseconds) task=$TASK_NAME ==="

# ---------------------------------------------------------------- 1. 防重入
# 上一轮没跑完就跳过。claude -p 带工具是十几分钟量级的活,cron 到点照发,
# 不拦就会越堆越多,最后一起抢 CPU / 抢 rate limit。
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    echo "⚠ 上一轮仍在运行,本轮跳过"
    echo "=== 结束 $(date -Iseconds) exit=0 (skipped) ==="
    exit 0
fi

# ---------------------------------------------------------------- 2. 环境
# PATH / HOME / 凭据全在这一步定死。失败就直接判死,不往下走。
if ! . "$SKILL_SHARED/claude_env.sh"; then
    echo "✗ 环境准备失败(见上方 [claude_env] 行)"
    python3 - "$STATUS_FILE" "$TS" "$LOG_FILE" <<'PY'
import json, sys, datetime
json.dump({"last_run": sys.argv[2], "success": False, "exit_code": 78,
           "fail_reason": "env_not_ready", "log_file": sys.argv[3],
           "checked_at": datetime.datetime.now().isoformat()},
          open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
    exit 78
fi

# ---------------------------------------------------------------- 2b. 大数据栈预检
# cron 不加载 Jupyter 启动脚本,JAVA_HOME / HADOOP_CONF_DIR / SPARK_HOME /
# HIVE_CONF_DIR / PYSPARK_PYTHON / PYTHONPATH 全都不会有。这些由 claude_env.sh
# 从 runtime_env.sh(capture_env.sh 的快照)+ bigdata_env.sh 恢复。
# 这里在**开跑之前**卡一道 —— 否则任务会先花十几分钟走到 pull 那一步,
# 才在 Spark 侧炸出一句 "core-site.xml not found",白烧一轮 token 和一个 cron 槽。
if [ "${REQUIRE_BIGDATA:-0}" = "1" ]; then
    BD_MISS=""
    for v in JAVA_HOME HADOOP_CONF_DIR SPARK_HOME PYSPARK_PYTHON; do
        eval "val=\${$v:-}"
        [ -z "$val" ] && BD_MISS="$BD_MISS $v(未设)" && continue
        [ -e "$val" ] || BD_MISS="$BD_MISS $v(路径不存在:$val)"
    done
    [ -n "${HADOOP_CONF_DIR:-}" ] && [ ! -f "$HADOOP_CONF_DIR/core-site.xml" ] \
        && BD_MISS="$BD_MISS core-site.xml(不存在)"
    case "${PYSPARK_PYTHON:-/}" in /*) : ;; *) BD_MISS="$BD_MISS PYSPARK_PYTHON(非绝对路径)" ;; esac
    if [ -n "$BD_MISS" ]; then
        echo "✗ 大数据环境不完整:$BD_MISS"
        echo "  在**能跑通 Spark 的交互终端**里跑一次快照,cron 才拿得到这些变量:"
        echo "    bash $SKILL_SHARED/capture_env.sh"
        echo "    bash $SKILL_SHARED/preflight.sh"
        python3 - "$STATUS_FILE" "$TS" "$LOG_FILE" "$BD_MISS" <<'PY'
import json, sys, datetime
json.dump({"last_run": sys.argv[2], "success": False, "exit_code": 78,
           "fail_reason": "bigdata_env_missing:" + sys.argv[4].strip(),
           "log_file": sys.argv[3],
           "checked_at": datetime.datetime.now().isoformat()},
          open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY
        exit 78
    fi
    echo "✓ 大数据环境就绪 JAVA_HOME=$JAVA_HOME HADOOP_CONF_DIR=$HADOOP_CONF_DIR SPARK_HOME=$SPARK_HOME"
fi

# ---------------------------------------------------------------- 3. 提示词
# 不再用 PROMPT='...' 内联:提示词里出现一个单引号,整个脚本就语法错。
# 落盘还有两个好处 —— 出问题能原样复盘,改提示词不用动脚本。
if [ ! -s "$PROMPT_FILE" ]; then
    echo "✗ 找不到提示词文件 $PROMPT_FILE"
    exit 78
fi

# ---------------------------------------------------------------- 4. 调用
# ▸ --permission-mode dontAsk:非交互专用模式,永不弹提示,不在 allow 名单里的
#   直接拒绝并继续。不设的话默认是 manual —— -p 模式下遇到要确认的工具会静默
#   拒掉,你只会看到"任务跑完了但什么也没做",这是最难查的一类故障。
#   刻意不用 --dangerously-skip-permissions:要什么工具就点名什么。
# ▸ cwd 固定成 $WORKDIR:Claude Code 按工作目录建"项目",每次换 cwd 会让会话
#   散成一堆同名项目;固定下来还能让目录信任状态稳定复用。
# ▸ timeout 默认把子进程放进独立进程组并对整组发信号 —— claude 带 Bash 会拉起
#   孙进程,只杀它自己的话管道不 EOF,脚本会一直挂着。-k 10 = 宽限 10 秒后 KILL。
# ▸ stream-json 全程落盘:最后一行是结构化结论,判定就靠它(见第 5 步)。
ARGS=( "$CLAUDE_BIN" -p "$(cat "$PROMPT_FILE")"
       --permission-mode dontAsk
       --allowedTools "$ALLOWED_TOOLS"
       --output-format stream-json --verbose )
[ -n "$MODEL" ]     && ARGS+=( --model "$MODEL" )
[ -n "$MAX_TURNS" ] && ARGS+=( --max-turns "$MAX_TURNS" )

echo "--- claude -p: model=${MODEL} tools=${ALLOWED_TOOLS} timeout=${TIMEOUT}s cwd=$WORKDIR"
STREAM="$LOG_DIR/${TASK_NAME}_${TS}.stream.jsonl"
T0=$(date +%s)
( cd "$WORKDIR" && timeout -k 10 "$TIMEOUT" "${ARGS[@]}" ) > "$STREAM"
RC=$?
ELAPSED=$(( $(date +%s) - T0 ))
tail -c 4000 "$STREAM"
echo "--- exit=$RC elapsed=${ELAPSED}s"

# ---------------------------------------------------------------- 5. 判定
# exit 0 ≠ 成功。真正的结论在 stream-json 最后一条 result 事件里:
#   {"type":"result","subtype":"success","is_error":false,"result":"...",
#    "permission_denials":[...],"num_turns":N,"total_cost_usd":...}
# permission_denials 非空 = 有工具被拒 —— 这就是"跑了但没干成"的直接证据,
# 比退出码灵得多,专治 allowedTools 配漏。
python3 - "$STREAM" "$STATUS_FILE" "$TS" "$LOG_FILE" "$RC" "$ELAPSED" "$TASK_NAME" <<'PY'
import json, sys, datetime, os

stream, status_file, ts, log_file, rc, elapsed, task = sys.argv[1:8]
rc = int(rc); elapsed = int(elapsed)

result = None
if os.path.exists(stream):
    with open(stream, encoding="utf-8", errors="replace") as f:
        for line in f:                       # 取最后一条 type=result
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            if ev.get("type") == "result":
                result = ev

denials = (result or {}).get("permission_denials") or []
timed_out = rc in (124, 137)

if result is None:
    ok, reason = False, ("timeout" if timed_out else "no_result_event")
elif result.get("is_error") or result.get("subtype") != "success":
    ok, reason = False, "model_error:{}".format(result.get("subtype"))
elif denials:
    ok, reason = False, "permission_denied"   # 工具被拒 = 这一轮不算数
else:
    ok, reason = True, ""

json.dump({
    "task": task,
    "last_run": ts,
    "success": ok,
    "fail_reason": reason,
    "exit_code": rc,
    "timed_out": timed_out,
    "elapsed_sec": elapsed,
    "num_turns": (result or {}).get("num_turns"),
    "cost_usd": (result or {}).get("total_cost_usd"),
    "permission_denials": denials[:10],
    "result_head": ((result or {}).get("result") or "")[:500],
    "log_file": log_file,
    "stream_file": stream,
    "checked_at": datetime.datetime.now().isoformat(),
}, open(status_file, "w"), ensure_ascii=False, indent=2)

if denials:
    print("✗ 有工具被权限拒绝(把它们加进 ALLOWED_TOOLS):", json.dumps(denials[:5], ensure_ascii=False))
print(("✓ 成功" if ok else "✗ 失败:" + reason) + "  turns={} cost={}".format(
    (result or {}).get("num_turns"), (result or {}).get("total_cost_usd")))
sys.exit(0 if ok else 1)
PY
VERDICT=$?

# ---------------------------------------------------------------- 6. 留存
find "$LOG_DIR" -maxdepth 1 -name "${TASK_NAME}_*" -mtime +14 -delete 2>/dev/null

echo "=== 结束 $(date -Iseconds) exit=$RC verdict=$VERDICT ==="
exit $VERDICT
