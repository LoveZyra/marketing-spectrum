#!/bin/bash
# =============================================================================
# _shared/preflight.sh —— 上机体检。**配任何定时任务之前先跑这个。**
#
# 核心思路:cron 的失败几乎都是"手动跑好好的、到点自己跑就不行",
# 所以这里用 env -i 把环境剥干净,
# 在**和 cron 一模一样的空环境**里验一遍,而不是在你这个已经加载过
# .bashrc / Jupyter 启动脚本的交互 shell 里验 —— 后者验什么都通过。
#
#   bash _shared/preflight.sh            # 全套(含一次真实的最小 claude -p 调用)
#   bash _shared/preflight.sh --no-call  # 跳过真实调用,只查环境
#   bash _shared/preflight.sh --deep     # 再加一层:验环境能不能穿透到
#                                        #   claude 的 Bash 工具里(孙进程)
# =============================================================================
set -uo pipefail

SHARED_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$SHARED_DIR")"
TASK_HOME="${CLAUDE_TASK_HOME:-/home/jovyan}"
NO_CALL=0; DEEP=0
for a in "$@"; do
    case "$a" in
        --no-call) NO_CALL=1 ;;
        --deep)    DEEP=1 ;;
    esac
done

FATAL=0; WARN=0
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; FATAL=$((FATAL+1)); }
warn() { echo "  ⚠ $*"; WARN=$((WARN+1)); }

# 在"和 cron 一样的空环境 + 已加载 claude_env.sh"里执行一段命令
in_cron_env() {
    env -i PATH=/usr/bin:/bin SHELL=/bin/sh CLAUDE_TASK_HOME="$TASK_HOME" \
        /bin/bash -c ". '$SHARED_DIR/claude_env.sh' >/dev/null 2>&1 || exit 78
                      $1" 2>&1
}

echo "=== 定时任务环境体检 ($(date -Iseconds)) ==="

# ---------------------------------------------------------------- 1. 依赖
echo "[1] 基础命令"
for c in python3 flock timeout crontab; do
    if command -v "$c" >/dev/null 2>&1; then ok "$c: $(command -v $c)"
    else bad "缺 $c"; fi
done

# ---------------------------------------------------------------- 2. claude 绝对路径
echo "[2] claude 可执行文件"
CLAUDE_BIN="$(command -v claude 2>/dev/null)"
if [ -z "$CLAUDE_BIN" ]; then
    for p in "$TASK_HOME/.npm-global/bin/claude" "$TASK_HOME/.local/bin/claude" \
             /usr/local/bin/claude /opt/node*/bin/claude; do
        [ -x "$p" ] && { CLAUDE_BIN="$p"; break; }
    done
fi
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
    bad "找不到 claude。交互 shell 里跑 command -v claude，把路径写进 $SHARED_DIR/claude_bin.env"
else
    ok "claude: $CLAUDE_BIN  ($("$CLAUDE_BIN" --version 2>&1 | head -1))"
    printf 'CLAUDE_BIN=%s\n' "$CLAUDE_BIN" > "$SHARED_DIR/claude_bin.env"
    ok "已写入 $SHARED_DIR/claude_bin.env"
    command -v node >/dev/null 2>&1 && ok "node: $(command -v node) ($(node -v 2>&1))" \
        || warn "PATH 里没有 node（claude 若自带运行时可忽略）"
fi

# ---------------------------------------------------------------- 3. HOME 与配置
echo "[3] HOME 与 claude 配置"
[ -d "$TASK_HOME" ] && ok "HOME=$TASK_HOME 存在" || bad "HOME=$TASK_HOME 不存在（改 CLAUDE_TASK_HOME）"
[ -d "$TASK_HOME/.claude" ] && ok "$TASK_HOME/.claude 存在" \
    || bad "$TASK_HOME/.claude 不存在 —— cron 下 HOME 若指到 /root，登录态和 skill 全读不到"
if [ -d "$TASK_HOME/.claude/skills" ]; then
    ok "用户级 skills: $(ls "$TASK_HOME/.claude/skills" 2>/dev/null | tr '\n' ' ')"
else
    warn "$TASK_HOME/.claude/skills 不存在（任务若要调 skill 会失败）"
fi
if [ -f "$TASK_HOME/.claude/settings.json" ]; then
    python3 -c "import json,sys;json.load(open(sys.argv[1]))" "$TASK_HOME/.claude/settings.json" 2>/dev/null \
        && ok "settings.json 是合法 JSON" || bad "settings.json 不是合法 JSON"
else
    warn "没有 settings.json（要靠环境变量或已登录态提供凭据）"
fi
ok "当前用户: $(id -un) (uid=$(id -u))，cron 任务将以同一用户身份运行"

# ---------------------------------------------------------------- 4. 环境快照
echo "[4] 运行时环境快照"
if [ -f "$SHARED_DIR/runtime_env.sh" ]; then
    CAP_AT="$(grep -m1 '^# 采集于' "$SHARED_DIR/runtime_env.sh" | sed 's/^# //')"
    ok "有 runtime_env.sh（$CAP_AT）"
    N_VAR="$(grep -c '^export ' "$SHARED_DIR/runtime_env.sh" || true)"
    ok "快照变量 $N_VAR 个"
else
    warn "没有 runtime_env.sh —— 任务若要用 Spark/Hive/HDFS，先在**能跑通的交互终端**里跑一次：
        bash $SHARED_DIR/capture_env.sh"
fi
[ -f "$SHARED_DIR/bigdata_env.sh" ] && ok "有手工覆盖 bigdata_env.sh" \
    || warn "没有 bigdata_env.sh（可选，从 bigdata_env.sh.example 复制）"
if ( . "$SHARED_DIR/claude_env.sh" >/dev/null 2>&1 ); then
    ok "claude_env.sh 加载通过"
else
    bad "claude_env.sh 加载失败：bash -c '. $SHARED_DIR/claude_env.sh'"
fi

# ---------------------------------------------------------------- 5. 大数据栈（空环境里验）
# cron 只给 PATH=/usr/bin:/bin，JAVA_HOME/HADOOP_CONF_DIR/SPARK_HOME/HIVE_CONF_DIR/
# PYSPARK_PYTHON/PYTHONPATH 全没有 —— 表现是 "core-site.xml not found"、
# "import pyspark 失败"、"Spark worker 找不到 Python"。这一节就是在空环境里
# 把这些逐条验掉，而不是在你这个已经加载过 Jupyter 启动脚本的 shell 里验。
echo "[5] 大数据栈（在 env -i 空环境里验）"
BD="$(in_cron_env '
for v in JAVA_HOME HADOOP_HOME HADOOP_CONF_DIR SPARK_HOME HIVE_CONF_DIR PYSPARK_PYTHON; do
    eval "val=\${$v:-}"
    if [ -z "$val" ]; then echo "MISS|$v|未设置"
    elif [ ! -e "$val" ]; then echo "BAD|$v|$val (路径不存在)"
    else echo "OK|$v|$val"; fi
done
[ -n "${HADOOP_CONF_DIR:-}" ] && { [ -f "$HADOOP_CONF_DIR/core-site.xml" ] \
    && echo "OK|core-site.xml|$HADOOP_CONF_DIR/core-site.xml" \
    || echo "BAD|core-site.xml|$HADOOP_CONF_DIR/core-site.xml 不存在"; }
[ -n "${HIVE_CONF_DIR:-}" ] && { [ -f "$HIVE_CONF_DIR/hive-site.xml" ] \
    && echo "OK|hive-site.xml|$HIVE_CONF_DIR/hive-site.xml" \
    || echo "BAD|hive-site.xml|$HIVE_CONF_DIR/hive-site.xml 不存在"; }
for c in java hadoop hdfs spark-submit hive beeline; do
    p="$(command -v $c 2>/dev/null)"
    [ -n "$p" ] && echo "OK|cmd:$c|$p" || echo "MISS|cmd:$c|PATH 里找不到"
done
python3 -c "import pyspark,sys;print(pyspark.__version__)" >/dev/null 2>&1 \
    && echo "OK|import pyspark|$(python3 -c "import pyspark;print(pyspark.__version__)" 2>/dev/null)" \
    || echo "BAD|import pyspark|失败（PYTHONPATH 缺 spark/python 或 py4j）"
if [ -n "${PYSPARK_PYTHON:-}" ]; then
    case "$PYSPARK_PYTHON" in
        /*) [ -x "$PYSPARK_PYTHON" ] && echo "OK|PYSPARK_PYTHON可执行|$PYSPARK_PYTHON" \
                                     || echo "BAD|PYSPARK_PYTHON|$PYSPARK_PYTHON 不可执行" ;;
        *)  echo "BAD|PYSPARK_PYTHON|不是绝对路径($PYSPARK_PYTHON) —— cron 的 cwd 下解析不出来，worker 侧才炸" ;;
    esac
fi
')"
if [ "$BD" = "" ] || printf '%s' "$BD" | head -1 | grep -q '^$'; then
    warn "大数据栈检查没有输出（claude_env.sh 可能加载失败）"
else
    while IFS='|' read -r st key val; do
        [ -z "${st:-}" ] && continue
        case "$st" in
            OK)   ok "$key = $val" ;;
            BAD)  bad "$key: $val" ;;
            MISS) warn "$key: $val" ;;
            *)    echo "  · $st$key$val" ;;
        esac
    done <<< "$BD"
    if printf '%s' "$BD" | grep -q '^MISS|JAVA_HOME'; then
        echo "      ↑ 关键变量成片「未设置」= 还没做环境快照。"
        echo "        在**能跑通 Spark 的交互终端**里跑一次：bash $SHARED_DIR/capture_env.sh"
    fi
fi

# ---------------------------------------------------------------- 6. 空环境实调 claude
echo "[6] 模拟 cron 空环境实调 claude -p"
if [ "$NO_CALL" -eq 1 ]; then
    warn "--no-call：跳过"
elif [ -z "${CLAUDE_BIN:-}" ]; then
    bad "没有 claude，跳过实调"
else
    PROBE_DIR="$(mktemp -d)"
    OUT="$PROBE_DIR/probe.jsonl"
    in_cron_env "cd '$PROBE_DIR' && timeout -k 5 120 \"\$CLAUDE_BIN\" -p '回答两个字：就绪' \
                   --permission-mode dontAsk --allowedTools Read \
                   --output-format stream-json --verbose" > "$OUT" 2>"$PROBE_DIR/err"
    RC=$?
    VERDICT="$(python3 - "$OUT" <<'PY'
import json, sys, os
r = None
if os.path.exists(sys.argv[1]):
    for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
        line = line.strip()
        if line.startswith("{"):
            try: ev = json.loads(line)
            except ValueError: continue
            if ev.get("type") == "result": r = ev
print("NO_RESULT" if r is None
      else ("ERROR:%s" % r.get("subtype")) if (r.get("is_error") or r.get("subtype") != "success")
      else "OK:" + (r.get("result") or "")[:40])
PY
)"
    case "$VERDICT" in
        OK:*) ok "实调通过 → ${VERDICT#OK:}  (exit=$RC)" ;;
        *)    bad "实调失败 exit=$RC verdict=$VERDICT"
              echo "      stderr: $(tail -c 500 "$PROBE_DIR/err" 2>/dev/null)"
              echo "      401/unauthorized→凭据；command not found→PATH；卡住不返回→HOME 指错" ;;
    esac
    rm -rf "$PROBE_DIR"
fi

# ---------------------------------------------------------------- 7. 深检：环境穿透到 Bash 工具
# 真实链路是 cron → run.sh → claude → Bash 工具 → python3 → SparkSubmit。
# 前面六节只验到 run.sh 这一层；这一节让 claude 自己用 Bash 工具把
# JAVA_HOME / pyspark 打出来，确认环境确实传到了孙进程。
echo "[7] 深检：环境是否穿透到 claude 的 Bash 工具"
if [ "$DEEP" -eq 0 ]; then
    echo "  · 跳过（要跑加 --deep；会真实消耗一次调用）"
elif [ -z "${CLAUDE_BIN:-}" ]; then
    bad "没有 claude，跳过深检"
else
    PROBE_DIR="$(mktemp -d)"
    OUT="$PROBE_DIR/deep.jsonl"
    DEEP_PROMPT='无人值守调用。用 Bash 工具执行这一条命令，然后把它的原样输出作为你的最终回复，不要加任何解释：printf "JAVA=%s HADOOP_CONF=%s PYSPARK=%s " "$JAVA_HOME" "$HADOOP_CONF_DIR" "$PYSPARK_PYTHON"; python3 -c "import pyspark;print(\"pyspark=\"+pyspark.__version__)" 2>&1 | tail -1'
    in_cron_env "cd '$PROBE_DIR' && timeout -k 10 240 \"\$CLAUDE_BIN\" -p $(printf '%q' "$DEEP_PROMPT") \
                   --permission-mode dontAsk --allowedTools Bash --max-turns 4 \
                   --output-format stream-json --verbose" > "$OUT" 2>"$PROBE_DIR/err"
    RC=$?
    python3 - "$OUT" <<'PY'
import json, sys, os
r = None
if os.path.exists(sys.argv[1]):
    for line in open(sys.argv[1], encoding="utf-8", errors="replace"):
        line = line.strip()
        if line.startswith("{"):
            try: ev = json.loads(line)
            except ValueError: continue
            if ev.get("type") == "result": r = ev
if r is None:
    print("  ✗ 深检没拿到 result 事件"); raise SystemExit
den = r.get("permission_denials") or []
if den:
    print("  ✗ Bash 工具被拒（--allowedTools 没给对）:", json.dumps(den[:2], ensure_ascii=False))
    raise SystemExit
out = (r.get("result") or "").strip()
print("  · Bash 工具里看到的环境：" + (out[:300] or "(空)"))
bad = []
if "JAVA=" in out and out.split("JAVA=")[1].split()[0:1] in ([], [""]): bad.append("JAVA_HOME")
for k, label in (("JAVA=", "JAVA_HOME"), ("HADOOP_CONF=", "HADOOP_CONF_DIR"), ("PYSPARK=", "PYSPARK_PYTHON")):
    seg = out.split(k)[1].split()[0] if k in out and len(out.split(k)) > 1 and out.split(k)[1].split() else ""
    if not seg: bad.append(label)
if "pyspark=" not in out: bad.append("import pyspark")
print(("  ✗ 没传下去的：" + ", ".join(bad)) if bad else "  ✓ 环境完整穿透到 Bash 工具")
PY
    rm -rf "$PROBE_DIR"
fi

# ---------------------------------------------------------------- 8. cron 本体
echo "[8] cron 服务与条目"
if pgrep -x cron >/dev/null 2>&1 || pgrep -x crond >/dev/null 2>&1; then
    ok "cron 进程在跑"
else
    bad "cron 进程没起 —— bash $SHARED_DIR/setup_cron.sh"
fi
if crontab -l >/dev/null 2>&1; then
    N=$(crontab -l 2>/dev/null | grep -cE '^[^#[:space:]]' || true)
    ok "crontab 可读，有效条目 $N 条"
    crontab -l 2>/dev/null | grep -E 'schedule_task' | while IFS= read -r l; do
        case "$l" in *">>"*|*"> "*) : ;; *) echo "  ⚠ 这条没重定向输出（cron 会去发邮件，pod 里等于丢日志）: $l" ;; esac
        case "$l" in *"/bin/bash "*) : ;; *) echo "  ⚠ 这条没用 /bin/bash 显式调用（cron 默认 SHELL=/bin/sh）: $l" ;; esac
    done
else
    warn "crontab 为空或不可读"
fi
[ -f "$SHARED_DIR/crontab.txt" ] && ok "有 crontab.txt 备份（pod 重启可一键恢复）" \
    || warn "没有 crontab.txt 备份 —— pod 重启后条目会全丢，跑 add_task.sh 会自动生成"

# ---------------------------------------------------------------- 结论
echo
echo "=== 体检结论：✗ $FATAL 条  ⚠ $WARN 条 ==="
[ "$FATAL" -gt 0 ] && { echo "有致命项，先修完再配任务。"; exit 2; }
echo "可以配任务了。"
exit 0
