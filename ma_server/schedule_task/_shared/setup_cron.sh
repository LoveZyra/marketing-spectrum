#!/bin/bash
# =============================================================================
# _shared/setup_cron.sh —— 装 cron + 起进程 + **恢复 crontab 条目**
#
# 只恢复 cron 进程是不够的：pod 一重启，crontab 条目也会一起消失，
# 而且**不报错**——cron 在跑、脚本还在，就是再也不触发了。这类"出事的时候
# 没有任何动静"的故障最难发现。
#
# 所以条目也要备份：add_task.sh 每次改 crontab 都会同步写
# _shared/crontab.txt，本脚本装完 cron 就把它灌回去。
# =============================================================================
set -uo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="$SHARED_DIR/crontab.txt"

# ---------------------------------------------------------------- 1. 装 cron
if ! command -v crond >/dev/null 2>&1 && ! command -v cron >/dev/null 2>&1; then
    echo "[setup_cron] cron 未安装，开始安装..."
    apt-get update -qq 2>&1 | tail -1
    apt-get install -y cron 2>&1 | tail -3
else
    echo "[setup_cron] cron 已安装"
fi

# ---------------------------------------------------------------- 2. 起进程
if ! pgrep -x cron >/dev/null 2>&1 && ! pgrep -x crond >/dev/null 2>&1; then
    echo "[setup_cron] cron 进程未运行，启动中..."
    service cron start 2>/dev/null || service crond start 2>/dev/null || (cron -f &)
    sleep 1
else
    echo "[setup_cron] cron 进程已在运行"
fi

if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then
    echo "[setup_cron] ✅ cron 已就绪 PID=$(pgrep -x cron 2>/dev/null | head -1 || pgrep -x crond | head -1)"
else
    echo "[setup_cron] ❌ cron 启动失败，请手动检查"
    exit 1
fi

# ---------------------------------------------------------------- 3. 恢复条目
if [ -s "$BACKUP" ]; then
    CUR="$(crontab -l 2>/dev/null | grep -cE '^[^#[:space:]]' || true)"
    WANT="$(grep -cE '^[^#[:space:]]' "$BACKUP" || true)"
    if [ "${CUR:-0}" -lt "${WANT:-0}" ]; then
        echo "[setup_cron] 当前 $CUR 条 < 备份 $WANT 条，从 crontab.txt 恢复"
        crontab "$BACKUP" && echo "[setup_cron] ✅ crontab 已恢复 $WANT 条"
    else
        echo "[setup_cron] crontab 条目已在（$CUR 条），不覆盖"
    fi
else
    echo "[setup_cron] ⚠ 没有 $BACKUP，无法恢复条目。用 add_task.sh 加任务会自动生成备份。"
fi

# ---------------------------------------------------------------- 4. 顺手体检
echo "[setup_cron] --- 建议接着跑一次体检 ---"
echo "[setup_cron]   bash $SHARED_DIR/preflight.sh"
