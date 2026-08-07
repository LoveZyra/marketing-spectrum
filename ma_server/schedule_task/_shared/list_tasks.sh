#!/bin/bash
# 列出所有定时任务（crontab + 各任务目录汇总）
set -uo pipefail
SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_ROOT="$(dirname "$SHARED_DIR")"

echo "=== 定时任务汇总 ==="
echo

echo "[cron 进程]"
if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then
    echo "  在跑 PID=$(pgrep -x cron 2>/dev/null | head -1 || pgrep -x crond | head -1)"
else
    echo "  ❌ 没起 —— bash $SHARED_DIR/setup_cron.sh"
fi
echo

echo "[System Cron]"
if crontab -l >/dev/null 2>&1; then
    crontab -l | grep -E '^[^#[:space:]]' | sed 's/^/  /'
else
    echo "  (crontab 不可读或为空)"
fi
echo

echo "[任务目录状态]"
for task_dir in "$TASK_ROOT"/*/; do
    [ -d "$task_dir" ] || continue
    task_name="$(basename "$task_dir")"
    case "$task_name" in _*) continue;; esac
    python3 - "$task_dir" "$task_name" <<'PY'
import json, os, sys, datetime
task_dir, task = sys.argv[1], sys.argv[2]
st = os.path.join(task_dir, "logs", "last_status.json")
meta = os.path.join(task_dir, "meta.json")
cron = "?"
if os.path.exists(meta):
    try: cron = json.load(open(meta)).get("cron", "?")
    except Exception: pass
if not os.path.exists(st):
    print("  %-24s cron=%-14s (尚未运行)" % (task, cron)); raise SystemExit
try:
    d = json.load(open(st, encoding="utf-8"))
except Exception as e:
    print("  %-24s cron=%-14s status 读不出来: %s" % (task, cron, e)); raise SystemExit
age = ""
try:
    last = datetime.datetime.strptime(d["last_run"], "%Y%m%d_%H%M%S")
    age = " (%.1fh 前)" % ((datetime.datetime.now() - last).total_seconds() / 3600.0)
except Exception:
    pass
print("  %-24s cron=%-14s %s%s  %s  %ss  turns=%s  cost=%s%s" % (
    task, cron, d.get("last_run", "?"), age,
    "✓" if d.get("success") else "✗ " + str(d.get("fail_reason")),
    d.get("elapsed_sec", "?"), d.get("num_turns", "?"), d.get("cost_usd", "?"),
    "  ⚠工具被拒" if (d.get("permission_denials") or []) else ""))
PY
done
echo

echo "[Session Cron]"
echo "  (在 Claude session 内运行 CronList 工具查看)"
