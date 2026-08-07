#!/bin/bash
# =============================================================================
# _shared/claude_env.sh —— 所有 cron 任务共用的环境准备（被 run.sh source）
#
# cron 不是登录 shell:不加载 .bashrc / .profile / Jupyter 启动脚本,
# 只给 HOME、SHELL、PATH=/usr/bin:/bin。于是两类东西同时消失:
#
#   ① claude 自己  —— PATH 里没有它、HOME 指错就读不到 ~/.claude
#   ② 大数据栈     —— JAVA_HOME / HADOOP_CONF_DIR / SPARK_HOME / HIVE_CONF_DIR /
#                      PYSPARK_PYTHON / PYTHONPATH 全没了,表现是
#                      "core-site.xml not found"、"import pyspark 失败"、
#                      "Spark worker 找不到 Python"
#
# ②这一层特别容易被忽略,因为链路是
#     cron → run.sh → claude → Bash 工具 → python3 → SparkSubmit
# 环境靠一路继承传下去,断在最上游就全断,而报错出现在最下游 —— 看起来像
# "Spark 挂了",其实是 cron 的锅。
#
# 加载顺序（后者覆盖前者）:
#   1. HOME / 基础 PATH / locale
#   2. runtime_env.sh    ← capture_env.sh 从交互 session 快照来的，广而全
#   3. bigdata_env.sh    ← 手工兜底/覆盖，窄而准（可选）
#   4. PATH 合并去重（claude 的目录永远在最前）
#   5. claude 绝对路径
#   6. 凭据
# =============================================================================

_SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------- 1. HOME / PATH / locale
# HOME 必须在一切之前定死:claude 读 ~/.claude/settings.json、~/.claude/skills、
# ~/.claude.json。crontab 装在 root 名下时 HOME=/root,上面这些全读不到 ——
# 表现就是"手动跑好好的,cron 一跑就说没权限 / 找不到 skill"。
export CLAUDE_TASK_HOME="${CLAUDE_TASK_HOME:-/home/jovyan}"
export HOME="$CLAUDE_TASK_HOME"
_CLAUDE_PATH="$HOME/.npm-global/bin:$HOME/.local/bin"     # claude 自己
_SYS_PATH="/usr/local/bin:/usr/bin:/bin"                  # 系统兜底，必须垫底
export LANG="${LANG:-C.UTF-8}"
export LC_ALL="${LC_ALL:-C.UTF-8}"

# ---------------------------------------------------------------- 2. 运行时环境快照
SCHEDULE_TASK_CAPTURED_PATH=""
SCHEDULE_TASK_EXTRA_PATH=""
if [ -f "$_SHARED_DIR/runtime_env.sh" ]; then
    . "$_SHARED_DIR/runtime_env.sh"
    _ENV_SRC="runtime_env.sh"
else
    _ENV_SRC="(无快照)"
fi

# ---------------------------------------------------------------- 3. 手工兜底/覆盖
if [ -f "$_SHARED_DIR/bigdata_env.sh" ]; then
    . "$_SHARED_DIR/bigdata_env.sh"
    _ENV_SRC="$_ENV_SRC + bigdata_env.sh"
fi

# ---------------------------------------------------------------- 4. PATH 合并去重
# 顺序:claude 自己的目录 → 手工补的大数据 bin → 快照 PATH → **系统目录垫底**。
# 系统目录必须垫底:/usr/bin 里常有一个"能用但版本不对"的 java,排在前面会把
# Hadoop 要的那个 JDK 挡掉 —— 而且不报错,只是 Spark 行为诡异。
# 去重也是必要的,快照 PATH 往往已含一部分,不去重会让 PATH 越滚越长。
PATH="$(printf '%s' "$_CLAUDE_PATH:$SCHEDULE_TASK_EXTRA_PATH:$SCHEDULE_TASK_CAPTURED_PATH:$_SYS_PATH" \
        | awk -v RS=: -v ORS=: '$0!="" && !seen[$0]++' | sed 's/:$//')"
export PATH
unset _CLAUDE_PATH _SYS_PATH SCHEDULE_TASK_CAPTURED_PATH SCHEDULE_TASK_EXTRA_PATH

# ---------------------------------------------------------------- 5. claude 绝对路径
# preflight.sh 会把探到的路径写进 claude_bin.env。有它就用它,不靠 PATH 碰运气。
[ -f "$_SHARED_DIR/claude_bin.env" ] && . "$_SHARED_DIR/claude_bin.env"
CLAUDE_BIN="${CLAUDE_BIN:-$(command -v claude 2>/dev/null)}"
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
    echo "[claude_env] ✗ 找不到 claude 可执行文件。" >&2
    echo "[claude_env]   跑 bash $_SHARED_DIR/preflight.sh 让它自己探，" >&2
    echo "[claude_env]   或手写 $_SHARED_DIR/claude_bin.env: CLAUDE_BIN=/绝对/路径/claude" >&2
    return 1 2>/dev/null || exit 1
fi
export CLAUDE_BIN

# ---------------------------------------------------------------- 6. 凭据
# 取值顺序:已有环境变量 → ~/.claude/settings.json 的 env 段 → 依赖本地登录态。
# 必须用 .get() 链取值 + 显式判空:如果写成下标
# json.load(...)['env']['ANTHROPIC_AUTH_TOKEN'],键不存在时 python 抛 KeyError、
# $( ) 拿到空串,而脚本没有 set -e,于是带着空 token 一路跑到 claude 报 401 ——
# 日志里只剩一句 API error,根因看不出来。空串也要 unset:空串比不设更糟,
# CLI 会当成"显式设了一个空凭据"。
# ⚠ 凭据只从 settings.json 走,绝不进 runtime_env.sh 这种明文快照。
_SETTINGS="$HOME/.claude/settings.json"
_read_setting() {
    [ -f "$_SETTINGS" ] || return 0
    python3 - "$_SETTINGS" "$1" <<'PY' 2>/dev/null
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding="utf-8"))
except Exception:
    sys.exit(0)
print((d.get("env") or {}).get(sys.argv[2], "") or "")
PY
}
[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] || export ANTHROPIC_AUTH_TOKEN="$(_read_setting ANTHROPIC_AUTH_TOKEN)"
[ -n "${ANTHROPIC_BASE_URL:-}" ]   || export ANTHROPIC_BASE_URL="$(_read_setting ANTHROPIC_BASE_URL)"
[ -n "${ANTHROPIC_API_KEY:-}" ]    || export ANTHROPIC_API_KEY="$(_read_setting ANTHROPIC_API_KEY)"
[ -n "${ANTHROPIC_AUTH_TOKEN:-}" ] || unset ANTHROPIC_AUTH_TOKEN
[ -n "${ANTHROPIC_BASE_URL:-}" ]   || unset ANTHROPIC_BASE_URL
[ -n "${ANTHROPIC_API_KEY:-}" ]    || unset ANTHROPIC_API_KEY

if [ -z "${ANTHROPIC_AUTH_TOKEN:-}${ANTHROPIC_API_KEY:-}" ]; then
    echo "[claude_env] ⚠ 环境和 settings.json 里都没有 token，将依赖 $HOME/.claude 的登录态"
fi

# ---------------------------------------------------------------- 7. 卫生
export DISABLE_AUTOUPDATER=1               # cron 下别自动更新:写盘、变慢、版本漂移
export DISABLE_TELEMETRY=1
export PYTHONUNBUFFERED=1                  # 被 kill 时日志留得住最后一行
export CI=1

# ⚠ 只报"有没有"，绝不 echo 凭据本身。
echo "[claude_env] HOME=$HOME  CLAUDE_BIN=$CLAUDE_BIN  env来源=$_ENV_SRC"
echo "[claude_env] token=${ANTHROPIC_AUTH_TOKEN:+已设(${#ANTHROPIC_AUTH_TOKEN}位)}${ANTHROPIC_AUTH_TOKEN:-未设}  base_url=${ANTHROPIC_BASE_URL:-(默认)}"
echo "[claude_env] JAVA_HOME=${JAVA_HOME:-未设}  HADOOP_CONF_DIR=${HADOOP_CONF_DIR:-未设}  SPARK_HOME=${SPARK_HOME:-未设}  HIVE_CONF_DIR=${HIVE_CONF_DIR:-未设}"
echo "[claude_env] PYSPARK_PYTHON=${PYSPARK_PYTHON:-未设}"
unset _ENV_SRC _SETTINGS
