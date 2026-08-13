#!/bin/bash
# =============================================================================
# _shared/add_task.sh —— 幂等地把一个任务挂上 crontab，并同步备份
#
#   bash add_task.sh <任务名> "<cron表达式>" [max_age_hours]
#   例：bash add_task.sh daily_report "0 9 * * *" 26
#
# 除了挂 crontab，还做三件容易漏掉的事：
#   1) crontab 行强制带 /bin/bash 和 >>日志 2>&1（cron 默认 SHELL=/bin/sh；
#      不重定向的话输出被拿去发邮件，pod 里没 MTA = 日志直接丢）
#   2) 写 meta.json 记下 cron 表达式和"多久没跑就算异常"，供 check_all_health 判定
#   3) 同步写 _shared/crontab.txt，pod 重启后 setup_cron.sh 能一键灌回去
# =============================================================================
set -uo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${SCHEDULE_TASK_ROOT:-/home/jovyan/schedule_task}"
BACKUP="$SHARED_DIR/crontab.txt"

TASK_NAME="${1:-}"
CRON_EXPR="${2:-}"
MAX_AGE_H="${3:-26}"

if [ -z "$TASK_NAME" ] || [ -z "$CRON_EXPR" ]; then
    echo "用法: bash add_task.sh <任务名> \"<cron表达式>\" [max_age_hours]" >&2
    exit 2
fi

RUN_SH="$ROOT/$TASK_NAME/tasks/run.sh"
LOG_DIR="$ROOT/$TASK_NAME/logs"
if [ ! -f "$RUN_SH" ]; then
    echo "✗ 找不到 $RUN_SH，先生成任务脚本再挂 crontab" >&2
    exit 2
fi
if [ ! -s "$ROOT/$TASK_NAME/tasks/prompt.md" ]; then
    echo "✗ 找不到 $ROOT/$TASK_NAME/tasks/prompt.md（提示词必须落盘）" >&2
    exit 2
fi
mkdir -p "$LOG_DIR"
chmod +x "$RUN_SH"

# cron 行里的 % 是"此处换行 + 后续内容作为 stdin"，路径里有 % 会静默截断
case "$RUN_SH$LOG_DIR" in *%*) echo "✗ 路径里有 % ，cron 会把它当换行符" >&2; exit 2;; esac

LINE="$CRON_EXPR /bin/bash $RUN_SH >> $LOG_DIR/cron.log 2>&1"

# 幂等替换：先滤掉这个任务的旧行，再追加新行
( crontab -l 2>/dev/null | grep -v -F "$RUN_SH"; echo "$LINE" ) | crontab -
crontab -l > "$BACKUP" 2>/dev/null && echo "✓ 已备份 crontab → $BACKUP"

python3 - "$ROOT/$TASK_NAME/meta.json" "$TASK_NAME" "$CRON_EXPR" "$MAX_AGE_H" <<'PY'
import json, sys, datetime
json.dump({"task": sys.argv[2], "cron": sys.argv[3],
           "max_age_hours": float(sys.argv[4]),
           "updated_at": datetime.datetime.now().isoformat()},
          open(sys.argv[1], "w"), ensure_ascii=False, indent=2)
PY

echo "✓ 已挂上: $LINE"
echo "  下一步（强烈建议，别等到点了才发现不通）："
echo "    bash $RUN_SH        # 手动跑一轮"
echo "    bash $SHARED_DIR/preflight.sh   # 空环境体检"
