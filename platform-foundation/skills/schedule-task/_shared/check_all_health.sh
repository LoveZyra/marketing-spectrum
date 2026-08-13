#!/bin/bash
# =============================================================================
# _shared/check_all_health.sh —— 健康检查。正常静默，异常才出声。
#
# 重点是三样"不报错的故障"：
#   · 任务该跑却没跑（crontab 条目被 pod 重启抹掉 / cron 没起）—— 看 last_run 陈旧度
#   · 任务跑了但工具被拒（permission_denials 非空）—— 表现是"成功了但什么也没做"
#   · 任务脚本在、crontab 里却没有对应条目
# =============================================================================
set -uo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TASK_ROOT="$(dirname "$SHARED_DIR")"
HAS_ISSUE=0

# 1. cron 进程
if ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1; then
    echo "❌ cron 进程不存在，需重启: bash $SHARED_DIR/setup_cron.sh"
    HAS_ISSUE=1
fi

# 2. crontab 条目
CRONTAB="$(crontab -l 2>/dev/null || true)"
if [ -z "$CRONTAB" ]; then
    echo "❌ crontab 为空（pod 重启后条目会丢）。恢复: bash $SHARED_DIR/setup_cron.sh"
    HAS_ISSUE=1
fi

# 3. 逐任务
for task_dir in "$TASK_ROOT"/*/; do
    [ -d "$task_dir" ] || continue
    task_name="$(basename "$task_dir")"
    case "$task_name" in _*) continue;; esac

    run_sh="$task_dir/tasks/run.sh"
    [ -f "$run_sh" ] || continue

    # 3a. 脚本在，crontab 里却没有它
    if ! printf '%s\n' "$CRONTAB" | grep -qF "$run_sh"; then
        echo "❌ 任务 $task_name 的脚本存在，但 crontab 里没有对应条目（不会被触发）"
        HAS_ISSUE=1
    fi

    # 3b. 上次运行结果 + 陈旧度
    OUT="$(python3 - "$task_dir" "$task_name" <<'PY'
import json, os, sys, datetime
task_dir, task = sys.argv[1], sys.argv[2]
st_path = os.path.join(task_dir, "logs", "last_status.json")
meta_path = os.path.join(task_dir, "meta.json")
max_age = 26.0
if os.path.exists(meta_path):
    try:
        max_age = float(json.load(open(meta_path)).get("max_age_hours", 26))
    except Exception:
        pass
if not os.path.exists(st_path):
    print("WARN|从未运行过（配好后先手动跑一轮验证）")
    raise SystemExit
try:
    st = json.load(open(st_path, encoding="utf-8"))
except Exception as e:
    print("FAIL|last_status.json 读不出来: %s" % e); raise SystemExit
msgs = []
if not st.get("success"):
    msgs.append("FAIL|上次失败 reason=%s exit=%s 日志=%s" % (
        st.get("fail_reason"), st.get("exit_code"), st.get("log_file")))
den = st.get("permission_denials") or []
if den:
    msgs.append("FAIL|有工具被权限拒绝(把它们加进 ALLOWED_TOOLS): %s"
                % json.dumps(den[:3], ensure_ascii=False))
try:
    last = datetime.datetime.strptime(st["last_run"], "%Y%m%d_%H%M%S")
    age = (datetime.datetime.now() - last).total_seconds() / 3600.0
    if age > max_age:
        msgs.append("FAIL|已经 %.1f 小时没跑（阈值 %.0fh）——多半是 crontab 条目丢了或 cron 没起" % (age, max_age))
except Exception:
    pass
print("\n".join(msgs))
PY
)"
    [ -z "$OUT" ] && continue
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        case "$line" in
            FAIL\|*) echo "❌ 任务 $task_name: ${line#FAIL|}"; HAS_ISSUE=1 ;;
            WARN\|*) echo "⚠️ 任务 $task_name: ${line#WARN|}" ;;
        esac
    done <<< "$OUT"
done

exit $HAS_ISSUE
