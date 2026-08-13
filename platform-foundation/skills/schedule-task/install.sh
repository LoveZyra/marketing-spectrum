#!/bin/bash
# =============================================================================
# install.sh —— 解包之后跑这一条,把该做的一次性事情做完
#
#   tar xzf schedule-task-skill.tar.gz -C /home/jovyan/.claude/skills/
#   bash /home/jovyan/.claude/skills/schedule-task/install.sh
#
# 做四件事:
#   1) 补执行位(经 Windows / 对象存储中转后 x 位常常丢)
#   2) 确认任务根目录 /home/jovyan/schedule_task/ 存在
#   3) 装 cron + 起进程 + 恢复 crontab 条目
#   4) 跑一次体检,把 claude 绝对路径探出来
#
# 幂等:可以反复跑。已有的 <任务名>/ 目录、logs、crontab 条目一律不动。
# =============================================================================
set -uo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SHARED="$SKILL_DIR/_shared"
TASK_HOME="${CLAUDE_TASK_HOME:-/home/jovyan}"
TASK_ROOT="$TASK_HOME/schedule_task"

echo "=== 安装 schedule-task ==="
echo "  skill 目录:  $SKILL_DIR"
echo "  任务根目录:  $TASK_ROOT"
echo "  HOME:        $TASK_HOME"
echo

# ---------------------------------------------------------------- 1. 执行位
chmod +x "$SKILL_DIR"/install.sh "$SHARED"/*.sh "$SKILL_DIR"/_template/run.sh 2>/dev/null
# 已有任务的 run.sh 也一起补
for f in "$TASK_ROOT"/*/tasks/run.sh; do [ -f "$f" ] && chmod +x "$f"; done
echo "[1] ✓ 执行位已补"

# 顺带查 CRLF
if grep -qlU $'\r' "$SHARED"/*.sh "$SKILL_DIR"/_template/run.sh 2>/dev/null; then
    echo "[1] ⚠ 有脚本是 CRLF 换行,正在转成 LF"
    for f in "$SHARED"/*.sh "$SKILL_DIR"/_template/run.sh; do
        [ -f "$f" ] && sed -i 's/\r$//' "$f"
    done
    echo "[1] ✓ 已转换"
fi

# ---------------------------------------------------------------- 2. 任务根目录
mkdir -p "$TASK_ROOT"
echo "[2] ✓ 任务根目录 $TASK_ROOT"

# ---------------------------------------------------------------- 3. cron
if [ -x "$SHARED/setup_cron.sh" ]; then
    echo "[3] --- setup_cron ---"
    bash "$SHARED/setup_cron.sh" 2>&1 | sed 's/^/    /'
else
    echo "[3] ✗ 找不到 $SHARED/setup_cron.sh"
fi

# ---------------------------------------------------------------- 4. 体检
echo "[4] --- preflight(跳过真实调用,只查环境)---"
CLAUDE_TASK_HOME="$TASK_HOME" bash "$SHARED/preflight.sh" --no-call 2>&1 | sed 's/^/    /'

echo
echo "=== 还差这两步(本脚本做不了,得你来)==="
echo "  a) 任务要用 Spark / Hive / HDFS 的话,**在一个能跑通的交互式终端里**跑一次环境快照:"
echo "       bash $SHARED/capture_env.sh"
echo "     cron 拿不到 .bashrc / 启动脚本设的 JAVA_HOME / HADOOP_CONF_DIR / SPARK_HOME 等,"
echo "     全靠这一份快照。快照只能在环境正常的交互 session 里取,脚本代劳不了。"
echo "  b) 快照做完再跑一次完整体检(含一次真实的最小调用):"
echo "       bash $SHARED/preflight.sh --deep"
echo "     ✗ 项清零之后,再按 SKILL.md 的步骤 2a 配任务。"
exit 0
