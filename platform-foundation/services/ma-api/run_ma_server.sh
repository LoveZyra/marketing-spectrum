#!/bin/bash
# ------------------------------------------------------------------------------
# ma_server 上的正式跑法(方案 C 或 方案 B)。
#
# 用法:
#   ACT=你的真实活动ID ./run_ma_server.sh c
#   ACT=你的真实活动ID ./run_ma_server.sh b
#
# 和 run_real_c.sh / run_real_b.sh 的区别不是"改了几个变量"。那两个脚本是**东京测试机
# 专用**的,里面硬编码了 /home/ubuntu/demo/ma-api-mode、/home/ubuntu/*.csv、gb18030,
# 以及一个 0.0.0.0:8000 的静态服务。搬到 ma_server 上逐条都是错的:
#
#   1. runtime=real —— 走 hive 取数 + skill 诊断,不是拿一份 CSV 顶包
#   2. 报告发布到 /home/jovyan/prism/public,链接走公司网关,不是 IP:8000
#   3. 接口不自己对外,而是挂在 Prism 8080 的 /api/ma/* 反代后面
#      (公司网关只转发 8080,而 8080 是 Prism 的 —— 这是唯一能对外的口子)
#
# 这个脚本只起"诊断服务"这一半。另一半(Prism 侧的反代)必须在**启动 Prism 之前**
# 就把环境变量导好,脚本没法替你重启 Prism,所以第 2 步会去探一下、探不到就明说。
#
# 还有一条更省事的路子:让 Prism 自己把诊断服务也带起来。在起 Prism 的那个 shell 里
#   export PRISM_MA_API_TARGET=127.0.0.1:8092
#   export PRISM_MA_API_AUTOSTART=/绝对路径/ma_api_c.py
# 之后 npm start 一条命令两个进程,Prism 退出时子进程一并收掉。这时本脚本仍然能用 ——
# 第 3 步探到端口上已经有人在应答就直接复用,不会去抢(抢了会和 Prism 的重启策略打架)。
# ------------------------------------------------------------------------------
set -u

MODE=$(echo "${1:-c}" | tr 'A-Z' 'a-z')
case "$MODE" in
  c) APP=ma_api_c.py; DEF_PORT=8092; LOG=c_ma_server.log; RESULT=c_ma_server_result.json;;
  b) APP=ma_api_b.py; DEF_PORT=8093; LOG=b_ma_server.log; RESULT=b_ma_server_result.json;;
  *) echo "用法:$0 [c|b]   (给了「$1」,只认 c 或 b)"; exit 2;;
esac

# 定位脚本自己所在的目录。不写死路径:这份代码在 ma_server 上放哪儿由你决定,
# 写死了就等着某天有人挪个目录然后对着 "No such file" 发呆。
cd "$(cd "$(dirname "$0")" && pwd)" || exit 1

PORT=${MA_API_PORT:-$DEF_PORT}
ACT=${ACT:-}
CAMPAIGN=${CAMPAIGN:-}
PRODUCTS=${PRODUCTS:-}
# 2026-07-30 契约收窄:push_source 不再走请求体,改由 MA_PUSH_SOURCE 在服务端定。
# 默认跟服务端出厂值对齐(both = 模型规则和策略规则里要推的都给);
# 要只用模型规则,PUSH_SOURCE=model bash run_ma_server.sh c
PUSH_SOURCE=${PUSH_SOURCE:-both}
PRISM_PORT=${PRISM_PORT:-8080}
POLL_MIN=${POLL_MIN:-60}

if [ -z "$ACT" ]; then
  cat <<'EOF'
✗ 没给 ACT(活动ID)。

  runtime=real 是照着 activity_id 去 hive 里捞人的。随手编一个不会报错,
  只会捞回 0 行,然后一路顺利地产出一份"什么都没发现"的报告 —— 那种结果
  比报错更难发现问题出在哪。所以这里宁可拦住。

  用法:  ACT=真实活动ID ./run_ma_server.sh c
EOF
  exit 2
fi

# MA_API_KEY 不给默认值。默认口令等于没有口令,而这个接口挂在 Prism 8080 下面,
# 8080 是公司网关唯一转发的端口 —— 也就是说它是**对外**的。
if [ -z "${MA_API_KEY:-}" ]; then
  cat <<'EOF'
✗ 没给 MA_API_KEY。

  这个接口最终挂在 Prism 8080 的 /api/ma/* 下面,而 8080 是公司网关唯一转发
  的端口 —— 它是对外的。没有口令 = 谁都能下单跑诊断、谁都能读走人群规则。

  先想一个,再跑:
    export MA_API_KEY='换成你自己的一串随机值'

  注意别拿 Claude Code CLI 的 API_KEY 直接复用 —— 那是模型密钥,
  调过一次本接口的人就等于拿到了它。preflight 会专门查这一条。
EOF
  exit 2
fi

export MA_RUNTIME=${MA_RUNTIME:-real}
export MA_API_PORT=$PORT
export MA_API_HOST=${MA_API_HOST:-127.0.0.1}
export MA_PUSH_SOURCE="$PUSH_SOURCE"
# 模型侧超时(2026-07-30 按 356352 单 transcript 实测重定)。这台机器的后端是
# glm-5.2(思考型):单次静默思考实测最长 358.8s,agent 上一单 1197.45s 干完全部活
# 却被 1200s 擦边杀掉。三个值联动 —— 只调大单次、不调预算,润色补漏轮反而消失。
# 代码默认值已同步改成这三个数,这里显式 export 是为了让配置在启动现场可见可改。
export MA_AGENT_TIMEOUT=${MA_AGENT_TIMEOUT:-2400}
export MA_POLISH_TIMEOUT=${MA_POLISH_TIMEOUT:-600}
export MA_POLISH_BUDGET=${MA_POLISH_BUDGET:-1800}
# 按调用分模型:agent 全量活走强模型,润色/schema/质检/渠道等轻量调用走快模型。
# 名字经网关按名分发(已在服务器上实测网关认这两个别名);设成空串=不传 --model 走网关默认。
export MA_AGENT_MODEL=${MA_AGENT_MODEL:-sonnet}
export MA_POLISH_MODEL=${MA_POLISH_MODEL:-haiku}
# MA_PUBLIC_DIR / MA_URL_BASE 故意不在这里 export:runtime=real 的默认值
# (/home/jovyan/prism/public + 公司网关域名)本来就是 ma_server 的正确值。
# 在这儿再写一遍只会多一处将来会跟代码不同步的地方。要覆盖就在外面 export。

if [ "$MODE" = "b" ]; then
  # 默认 1500s 不够:2026-07-28 那轮 B 卡在 901s 报 "API Error: The operation
  # timed out.",整单 error、出参全空。跑通那次实测 594s,留一倍余量。
  # real 模式还要多一段 hive 取数,只会更慢,所以这里比测试机再放宽。
  export MA_B_TIMEOUT=${MA_B_TIMEOUT:-4200}
fi

BAR() { printf '\n=== %s ===\n' "$1"; }

BAR "0. 基本信息"
date '+%F %T'
echo "模式        : 方案 ${MODE^^}  ($APP)"
echo "目录        : $(pwd)"
echo "监听        : ${MA_API_HOST}:${PORT}(回环。对外靠 Prism 反代,不直接暴露)"
echo "runtime     : $MA_RUNTIME"
echo "activity_id : $ACT"
command -v md5sum >/dev/null && md5sum ma_pipeline.py "$APP" ma_core.py
free -m 2>/dev/null | head -2

# ------------------------------------------------------------------------------
BAR "1. 环境体检(不过就不往下走)"
# preflight 退出码:0=没有 FAIL。有 FAIL 还硬跑,后面每一单都会在同一个地方栽,
# 只是栽的位置离病因隔了十几分钟的 hive 取数,查起来贵得多。
if [ ! -f preflight_ma_server.py ]; then
  echo "⚠ 找不到 preflight_ma_server.py,跳过体检(建议补上,这一步很便宜)"
else
  python3 preflight_ma_server.py --no-network
  RC=$?
  if [ "$RC" != "0" ]; then
    echo
    echo "✗ 体检没过(退出码 $RC),停在这里。"
    echo "  确实想带病上路的话:MA_ALLOW_BAD_ENV=1,但那些问题会逐条进每一单的 warnings。"
    [ "${MA_ALLOW_BAD_ENV:-0}" = "1" ] || exit 1
    echo "  (检测到 MA_ALLOW_BAD_ENV=1,继续)"
  fi
fi

# ------------------------------------------------------------------------------
BAR "2. Prism 反代状态"
# 这一步只读不写。反代是 Prism 进程启动时读环境变量决定挂不挂的,
# 脚本没法替你重启 Prism —— 能做的是把结论说清楚。
PROXY_URL="http://127.0.0.1:${PRISM_PORT}/api/ma/healthz"
PCODE=$(curl -s -o /tmp/ma_proxy_probe.json -w '%{http_code}' -m 5 "$PROXY_URL" 2>/dev/null)
case "$PCODE" in
  200)
    echo "✓ 反代已挂载,而且后面的诊断服务也通了($PROXY_URL → 200)"
    PROXY_OK=1;;
  502|504)
    echo "✓ 反代已挂载,只是后面还没起服务(HTTP $PCODE)—— 现在这个阶段是正常的"
    PROXY_OK=1;;
  404)
    PROXY_OK=0
    cat <<EOF
⚠ 反代没挂载($PROXY_URL → 404)。

  两种可能,都得回到 Prism 那边处理:
    a) PRISM_MA_API_TARGET 没配 —— 没配时反代整个不挂,Prism 行为和以前一模一样
    b) 配了,但 Prism 是在配之前起的 —— 环境变量是进程启动时读的,改完必须重启

  正确顺序(在跑 Prism 的那个 shell 里):
    export PRISM_MA_API_TARGET=127.0.0.1:${PORT}
    # 然后重启 Prism

  顺带一提,同一个 shell 里再加一行,就不用本脚本单独起服务了 ——
  Prism 起来的时候会把诊断服务一并拉起,退出时一并收掉:
    export PRISM_MA_API_AUTOSTART=$(pwd)/${APP}
  (子进程的监听端口由 PRISM_MA_API_TARGET 反推,两边不可能配歪。
   MA_* 那一堆变量要 export 在 Prism 的 shell 里,子进程继承的是它的环境。)

  本脚本会继续,只是最后一段"走反代验一遍"会跳过 —— 服务本身照跑不误。
EOF
    ;;
  000|"")
    PROXY_OK=0
    echo "⚠ Prism 的 ${PRISM_PORT} 端口连不上。Prism 没起?或者不在这台机器上?"
    echo "  诊断服务本身不依赖它,继续跑;但外部调用方目前没有入口。";;
  *)
    PROXY_OK=0
    echo "⚠ $PROXY_URL 返回了 HTTP $PCODE,不在预期内。内容:"
    head -c 300 /tmp/ma_proxy_probe.json 2>/dev/null; echo;;
esac

# ------------------------------------------------------------------------------
BAR "3. 起 方案 ${MODE^^} 服务"
# 先看看这个端口上是不是已经有服务在跑了。这一步不是礼貌,是防事故:
# 如果 Prism 那边开了 PRISM_MA_API_AUTOSTART,端口上那个进程是**Prism 的子进程**。
# 直接 pkill 掉,Prism 会按退避策略把它再拉起来,而本脚本同时也起了一个 ——
# 两个进程抢同一个端口,后起的那个 bind 失败退出,然后再被拉起、再失败……
# 日志会很热闹,但你要的那一单一直下不出去。所以:有人在跑就复用,别硬抢。
ALREADY=0
curl -s -m 3 "http://127.0.0.1:$PORT/healthz" > /tmp/ma_h.json 2>/dev/null && ALREADY=1

if [ "$ALREADY" = "1" ] && [ "${FORCE_RESTART:-0}" != "1" ]; then
  echo "✓ ${PORT} 上已经有服务在应答 healthz,直接复用,不重起。"
  echo "  —— 可能是 Prism 自启拉起的(PRISM_MA_API_AUTOSTART),也可能是上一次留下的。"
  echo "  要换成本脚本自己起(比如刚更新了代码要让新代码生效):FORCE_RESTART=1 $0 $MODE"
  echo "  注意:如果它确实是 Prism 的子进程,那就该去重启 Prism,而不是在这儿 kill ——"
  echo "        kill 掉它 Prism 会自动再拉起来,两边会打架。"
else
  if [ "$ALREADY" = "1" ]; then
    echo "⚠ FORCE_RESTART=1:${PORT} 上原本有服务,先杀再起。"
    echo "  如果它是 Prism 自启的子进程,Prism 会把它再拉起来 —— 请改为重启 Prism。"
  fi
  # 方括号是故意的:pkill -f 'ma_api_c.py' 会匹配到**本脚本自己**的命令行然后自杀,
  # 表现是整段命令莫名其妙消失、退出码 144。'ma_api_[c].py' 这个正则匹配得到目标进程,
  # 却匹配不到脚本自己那行字面量。
  pkill -f "ma_api_[${MODE}].py" 2>/dev/null
  sleep 1
  nohup python3 "$APP" > "$LOG" 2>&1 &
  SRV_PID=$!
  OK=0
  for i in $(seq 1 30); do
    sleep 1
    if curl -s -m 3 "http://127.0.0.1:$PORT/healthz" > /tmp/ma_h.json 2>/dev/null; then OK=1; break; fi
  done
  if [ "$OK" != "1" ]; then
    echo "✗ healthz 起不来。服务日志尾巴:"
    tail -40 "$LOG"
    exit 1
  fi
  # healthz 通了 ≠ 通的是我刚起的这个。端口被别的进程占着的话,我起的这个会
  # bind 失败、立刻退出,而 curl 照样从**那个占着端口的旧进程**拿到 200 ——
  # 于是后面整轮跑的都是旧代码,还查不出所以然。所以这里再确认一次它还活着。
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "✗ healthz 是通的,但我刚起的进程(pid=$SRV_PID)已经没了。"
    echo "  最常见的原因:${PORT} 被另一个进程占着,bind 失败。"
    echo "  也就是说现在应答的是那个旧进程,不是新代码。日志尾巴:"
    tail -40 "$LOG"
    echo
    echo "  查一下占端口的是谁:  ss -lptn 'sport = :${PORT}'  (或 lsof -i :${PORT})"
    exit 1
  fi
fi
python3 -c "import json,sys;print(json.dumps(json.load(open('/tmp/ma_h.json')),ensure_ascii=False,indent=2))" \
  2>/dev/null || cat /tmp/ma_h.json

# ------------------------------------------------------------------------------
BAR "4. 下单"
META_PARTS=""
[ -n "$CAMPAIGN" ] && META_PARTS="\"campaign_name\":\"$CAMPAIGN\""
if [ -n "$PRODUCTS" ]; then
  # target_products 是「品类名」。不给就走默认(--auto-meta 从数据的
  # activity_product_name 取),不给不算降级 —— 出参 notes 里会写清取到了什么。
  [ -n "$META_PARTS" ] && META_PARTS="$META_PARTS,"
  META_PARTS="$META_PARTS\"target_products\":$PRODUCTS"
  echo "品类:显式指定 $PRODUCTS"
else
  echo "品类:走默认(从数据的 activity_product_name 取,取到什么见出参 notes)"
fi
# 契约收窄后入参只有 activity_id / date / meta(campaign_type 放 meta 里);
# push_source 已 export 成 MA_PUSH_SOURCE,写进 body 会被 400 拒单。
BODY="{\"activity_id\":\"$ACT\",\"meta\":{$META_PARTS}}"
echo "请求体:$BODY(push_source=$PUSH_SOURCE 走的是服务端环境变量)"

# 先直连回环下单。这一单是给"服务本身通不通"做结论的,不该被反代那一层的问题干扰。
curl -s -m 15 -X POST "http://127.0.0.1:$PORT/api/ma/diagnose" \
  -H "content-type: application/json" -H "x-ma-api-key: $MA_API_KEY" \
  -d "$BODY" > /tmp/ma_post.json
cat /tmp/ma_post.json; echo
JOB=$(python3 -c "import json;print(json.load(open('/tmp/ma_post.json')).get('job_id',''))" 2>/dev/null)
echo "JOB=$JOB"
if [ -z "$JOB" ]; then
  echo "✗ 下单失败,退出"
  # 同上:服务不是本脚本起的就没有这个日志文件,别在报错之上再叠一条 tail 的报错。
  [ -f "$LOG" ] && tail -40 "$LOG" || echo "  (服务是复用的,日志不在 $LOG;Prism 自启的话 grep '[ma-service]')"
  exit 1
fi

# ------------------------------------------------------------------------------
BAR "5. 轮询(最多 ${POLL_MIN} 分钟)"
T0=$(date +%s)
LOOPS=$(( POLL_MIN * 6 ))
for i in $(seq 1 "$LOOPS"); do
  sleep 10
  curl -s -m 8 "http://127.0.0.1:$PORT/api/ma/jobs/$JOB" \
    -H "x-ma-api-key: $MA_API_KEY" > /tmp/ma_job.json 2>/dev/null
  ST=$(python3 -c "import json;d=json.load(open('/tmp/ma_job.json'));print(d.get('state'),'/',d.get('phase'))" 2>/dev/null)
  MEM=$(free -m 2>/dev/null | awk '/Mem:/{printf "%s/%sMB", $3, $2}')
  echo "[$(( $(date +%s) - T0 ))s] $ST  used=$MEM"
  case "$ST" in
    done*|error*) break;;
  esac
done

BAR "6. 任务状态全文"
python3 -c "import json;print(json.dumps(json.load(open('/tmp/ma_job.json')),ensure_ascii=False,indent=2))" \
  2>/dev/null || cat /tmp/ma_job.json

# ------------------------------------------------------------------------------
BAR "7. 结果出参"
curl -s -m 20 "http://127.0.0.1:$PORT/api/ma/jobs/$JOB/result" \
  -H "x-ma-api-key: $MA_API_KEY" > "$RESULT"
python3 - "$RESULT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception as e:
    print("结果解析失败:", e); raise SystemExit
print("--- /result 出参(收窄后的对外契约,就这六个字段)---")
for k in ("job_id", "state", "activity_id", "mode", "report_url"):
    print("%-12s = %s" % (k, d.get(k)))
rules = d.get('rules') or []
print("%-12s = %d 条" % ("rules", len(rules)))
for r in rules:
    print(" -", r.get('finding_id'), "|", (r.get('direction') or ""), "|",
          (r.get('name') or "")[:24], "|", (r.get('sql_filter') or "")[:80])
extra = [k for k in d if k not in ("job_id", "state", "activity_id", "mode",
                                   "report_url", "rules")]
print("契约外字段  =", extra if extra else "无(干净)")
PY

echo
echo "--- 内部审计(收窄砍的是出参不是记录,细账在 jobs/<job>/meta.json)---"
python3 - "jobs/$JOB/meta.json" <<'PY'
import json, sys
try:
    m = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception as e:
    print("meta.json 读不出来:", e)
    print("(服务不是本脚本起的话,jobs/ 在那个进程的工作目录下,按它的 MA_JOBS_DIR 找)")
    raise SystemExit
r = m.get('result') or {}
cs = r.get('crowd_spec') or {}
print("degraded=%s  runtime=%s  size.push=%s  push_source=%s" % (
    r.get('degraded'), r.get('runtime'),
    (r.get('size') or {}).get('push'), cs.get('push_source')))
print("backend =", json.dumps(r.get('backend'), ensure_ascii=False)[:220])
print("dropped = %d 条 / excluded = %d 条" % (
    len(cs.get('dropped_rules') or []), len(cs.get('excluded_rules') or [])))
print("--- push_sql ---")
print((cs.get('push_sql') or "")[:800])
for n in (cs.get('notes') or []):
    print(" *", n)
for w in (m.get('warnings') or []):
    print(" !", w)
PY

# ------------------------------------------------------------------------------
BAR "8. 发布物核对"
# 用出参里真实的 report_url 反推本地文件,别自己拼路径 —— 拼错了只会得到一个假的
# "文件不存在",让人以为是发布失败,其实是这几行猜错了前缀。
python3 - "$RESULT" <<'PY'
import json, os, sys
try:
    from urllib.parse import urlsplit
except ImportError:
    from urlparse import urlsplit
import importlib
sys.path.insert(0, os.path.dirname(os.path.abspath(sys.argv[1])) or ".")
try:
    mp = importlib.import_module("ma_pipeline")
    pub = mp.PUBLIC_DIR
except Exception:
    pub = os.environ.get("MA_PUBLIC_DIR") or "/home/jovyan/prism/public"
d = {}
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    pass
url = d.get("report_url") or ""
print("发布目录  :", pub, "(存在)" if os.path.isdir(pub) else "(不存在 ← 这就是 report_url 为 null 的原因)")
print("report_url:", url or "(空)")
if not url:
    print("  出参里没有链接。多半是发布目录不存在 —— publish_html 不会替你 mkdir,")
    print("  它只是警告一声然后返回 None。先把目录建出来再重跑。")
    raise SystemExit
path = urlsplit(url).path or "/"
local = os.path.join(pub, os.path.basename(path))
if os.path.isfile(local):
    n = os.path.getsize(local)
    print("本地文件  :", local, "(%d 字节)" % n)
    try:
        b = open(local, encoding="utf-8", errors="replace").read()
    except Exception as e:
        print("  读不出来:", e); raise SystemExit
    print("  是 skill 正版模板  :", ("ma-official-template" in b) or ("ma-report" in b))
    print("  [待润色] 残留      :", b.count("[待润色]"))
    print("  「补充」开头的骨架句:", b.count(">补充") + b.count("补充现象") + b.count("补充业务"))
else:
    print("本地文件  :", local, "← 不存在。链接和落盘位置对不上,先查 MA_URL_BASE / MA_PUBLIC_DIR")
PY
echo
echo "报告链接要在**公司网内**打开验证。这台机器上 curl 得通不代表网关转发得到,"
echo "反过来也一样 —— 别拿本机 curl 的结果给业务方下结论。"

# ------------------------------------------------------------------------------
BAR "9. 走反代再验一遍(这才是调用方真正走的路)"
if [ "${PROXY_OK:-0}" != "1" ]; then
  echo "跳过:第 2 步已经说明反代没挂上。"
else
  PB="http://127.0.0.1:${PRISM_PORT}/api/ma"
  chk() {
    name="$1"; want="$2"; shift 2
    code=$(curl -s -o /tmp/ma_pchk.out -w '%{http_code}' -m 20 "$@")
    [ "$code" = "$want" ] && r="OK" || r="不符预期"
    printf '  %-26s -> %s (期望 %s) %s\n' "$name" "$code" "$want" "$r"
  }
  chk "healthz(免鉴权)"      200 "$PB/healthz"
  chk "jobs 带 key"            200 "$PB/jobs" -H "x-ma-api-key: $MA_API_KEY"
  chk "jobs 无 key"            401 "$PB/jobs"
  chk "本单结果"               200 "$PB/jobs/$JOB/result" -H "x-ma-api-key: $MA_API_KEY"
  chk "白名单外路径"           404 "$PB/debug"
  chk "方法不对(GET diagnose)" 405 "$PB/diagnose"
  echo
  echo "  对外的完整地址(网关只转 8080,所以就是 Prism 的地址后面加 /api/ma):"
  echo "    https://<你的网关域名>/api/ma/diagnose"
fi

# ------------------------------------------------------------------------------
BAR "10. 服务日志尾巴"
# 复用别人起的服务时,$LOG 根本不存在 —— 尤其是 Prism 自启的情况:子进程的
# stdout/stderr 是被 Prism 逐行转写进**Prism 自己的日志**的,前缀 [ma-service] |。
# 这里如果直接 tail 一个不存在的文件,就变成了脚本最后一行报错,很吓人也很没用。
if [ -f "$LOG" ]; then
  tail -50 "$LOG"
else
  echo "(本次没有由本脚本起服务,所以没有 $LOG)"
  echo " 服务是复用的现成进程。如果是 Prism 自启拉起的,日志在 Prism 那边,"
  echo " 每行带 [ma-service] | 前缀,grep 这个就行。"
fi

BAR "DONE"
date '+%F %T'
echo "结果出参已存:$(pwd)/$RESULT"
if [ -f "$LOG" ]; then
  echo "服务日志    :$(pwd)/$LOG"
else
  echo "服务日志    :本次复用了现成进程,日志不在这里(Prism 自启的话 grep '[ma-service]')"
fi
