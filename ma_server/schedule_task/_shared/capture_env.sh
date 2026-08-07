#!/bin/bash
# =============================================================================
# _shared/capture_env.sh —— **在交互式 Jupyter 终端里跑一次**，把当前环境快照下来
#
#   bash /home/jovyan/schedule_task/_shared/capture_env.sh
#
# 为什么要快照，而不是手写一份 export 清单:
#
#   cron 不加载 .bashrc/.profile，而 Jupyter 镜像里的 JAVA_HOME / HADOOP_HOME /
#   HADOOP_CONF_DIR / SPARK_HOME / HIVE_CONF_DIR / PYSPARK_PYTHON / PYTHONPATH /
#   PATH 全是启动脚本设好的。手写清单有两个毛病:一是漏(py4j 的 zip 版本号、
#   PYSPARK_DRIVER_PYTHON 这种最容易漏),二是会烂(运维换个 spark 版本,
#   清单里的路径就悄悄失效,而且**不报错** —— 只是 Spark 找不到 JDK)。
#
#   快照的口径是"交互式 session 里能跑通的那份环境，原样搬到 cron 里"。
#   镜像升级 / 路径变动之后重跑一次这个脚本即可，不用改任何脚本。
#
# 安全:凭据类变量(*KEY* *TOKEN* *SECRET* *PASSWORD* *CREDENTIAL* ANTHROPIC_*)
# **一律不写进快照文件** —— 它是明文落盘的。claude 的凭据由 claude_env.sh 单独
# 从 ~/.claude/settings.json 读。
# =============================================================================
set -uo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$SHARED_DIR/runtime_env.sh"

if [ ! -t 0 ] && [ -z "${FORCE_CAPTURE:-}" ]; then
    echo "⚠ 看起来不是交互式终端。快照必须在**环境正常的**交互 shell 里取，"
    echo "  否则就是把一份残缺环境固化下来。确认要继续请 FORCE_CAPTURE=1 重跑。"
    exit 2
fi

python3 - "$OUT" <<'PY'
import os, re, shlex, sys, datetime, socket

out = sys.argv[1]

# 明确不要的:易变的、shell 内部的、以及**任何看起来像凭据的**
DENY_EXACT = {
    "PWD", "OLDPWD", "SHLVL", "_", "TERM", "LINES", "COLUMNS", "HOSTNAME",
    "HOME", "SHELL", "USER", "LOGNAME", "MAIL", "LS_COLORS", "DISPLAY",
    "PATH",                      # 单独存成 SCHEDULE_TASK_CAPTURED_PATH，见下
    "CI", "PYTHONUNBUFFERED",
}
DENY_PREFIX = ("BASH_", "SSH_", "XDG_", "TMUX", "SUDO_", "npm_", "LESS",
               "CLAUDE", "ANTHROPIC", "AWS_", "GIT_ASKPASS")
DENY_PATTERN = re.compile(r"(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|PRIVATE|SESSION|COOKIE)",
                          re.IGNORECASE)

kept, skipped_secret = {}, []
for k, v in sorted(os.environ.items()):
    if k in DENY_EXACT or k.startswith(DENY_PREFIX):
        continue
    if DENY_PATTERN.search(k):
        skipped_secret.append(k)
        continue
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k):
        continue
    kept[k] = v

lines = [
    "#!/bin/bash",
    "# 自动生成，勿手改 —— 由 _shared/capture_env.sh 从交互式 session 快照而来。",
    "# 镜像升级或大数据组件路径变动后，重跑 capture_env.sh 覆盖本文件。",
    "# 采集于 %s @ %s" % (datetime.datetime.now().isoformat(timespec="seconds"),
                          socket.gethostname()),
    "# 已刻意排除的凭据类变量: %s" % (", ".join(skipped_secret) or "(无)"),
    "",
]
for k, v in kept.items():
    lines.append("export %s=%s" % (k, shlex.quote(v)))

# PATH 不直接 export:cron 侧要先保证 claude 自己的目录在最前面，
# 由 claude_env.sh 做合并去重，避免快照的 PATH 把 claude 挤掉。
lines.append("")
lines.append("SCHEDULE_TASK_CAPTURED_PATH=%s" % shlex.quote(os.environ.get("PATH", "")))

with open(out, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
os.chmod(out, 0o600)

print("✓ 已写入 %s（%d 个变量）" % (out, len(kept)))
CARE = ["JAVA_HOME", "HADOOP_HOME", "HADOOP_CONF_DIR", "SPARK_HOME",
        "HIVE_HOME", "HIVE_CONF_DIR", "PYSPARK_PYTHON",
        "PYSPARK_DRIVER_PYTHON", "PYTHONPATH", "YARN_CONF_DIR",
        "LD_LIBRARY_PATH", "HADOOP_USER_NAME"]
print("\n关键变量核对（缺的说明这个交互 session 本身就没有，别指望 cron 里会有）：")
missing = []
for k in CARE:
    v = kept.get(k)
    print("  %-24s %s" % (k, v if v else "—— 未设置"))
    if not v:
        missing.append(k)
if missing:
    print("\n⚠ 以下变量在当前 session 里就没有：%s" % ", ".join(missing))
    print("  如果任务要用到它们，说明你不是在那个能跑通 Spark/Hive 的终端里取的快照，")
    print("  换到那个终端重跑；或在 _shared/bigdata_env.sh 里手工补上。")
PY

echo
echo "下一步："
echo "  bash $SHARED_DIR/preflight.sh          # 会在 env -i 空环境里验一遍 java/hdfs/pyspark"
echo "  bash $SHARED_DIR/preflight.sh --deep   # 再验一层：环境能不能穿透到 claude 的 Bash 工具里"
