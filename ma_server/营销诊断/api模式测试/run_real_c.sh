#!/bin/bash
# 方案C:用真实的 105MB / gb18030 / 221列 CSV 跑完整流程。
# 设计成后台跑 + 一路打点,浏览器那头只要读这个 out 文件就能看见进度。
cd /home/ubuntu/demo/ma-api-mode || exit 1
CSV=$(ls /home/ubuntu/*.csv 2>/dev/null | head -1)
PORT=8092
KEY=ma-real-test-key
ACT=real_c_001

# target_products 是「品类名」。默认取数据里的 activity_product_name(--auto-meta),
# 也可以在这里显式指定 —— 两条路都正常,不指定不算降级。
# 留空 = 走默认。驱动会在 prepare 之后回读实际取到的值:取出来像页面名
# (「特价机票业务总览」这种)才会在 warnings 里吵一声,让人先确认再采信
# 「跨品类推送错配」那类结论。要覆盖就取消下面这行的注释,按品类名填。
# PRODUCTS='["机票"]'
PRODUCTS=${PRODUCTS:-}
CAMPAIGN='特价机票'

export MA_RUNTIME=csv
export MA_CSV="$CSV"
export MA_CSV_ENCODING=gb18030
export MA_API_PORT=$PORT
export MA_API_KEY=$KEY
# push_source 已从入参挪到服务端(2026-07-30 契约收窄),这轮沿用之前实测的 both
export MA_PUSH_SOURCE=${MA_PUSH_SOURCE:-both}

echo "=== 0. 环境 ==="
date '+%F %T'
echo "CSV=$CSV"
ls -l "$CSV" | awk '{print $5, $9}'
md5sum ma_pipeline.py
free -m | head -2

echo
echo "=== 1. 静态发布位(让 report_url 真能打开)==="
mkdir -p ~/html-server/staging
if (ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -q ":8000 "; then
  echo "8000 已在监听,不重复拉起"
else
  nohup python3 -m http.server 8000 --bind 0.0.0.0 -d ~/html-server/staging > http8000.log 2>&1 &
  sleep 2
  echo "已拉起 8000 静态服务(注意:staging 目录会对公网可读)"
fi
(ss -lnt 2>/dev/null || netstat -lnt 2>/dev/null) | grep -E ":(8000|8092) " || echo "端口没起来?"

echo
echo "=== 2. 起 方案C 服务 ==="
pkill -f "ma_api_[c].py" 2>/dev/null
sleep 1
nohup python3 ma_api_c.py > c_real.log 2>&1 &
OK=0
for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 3 "http://127.0.0.1:$PORT/healthz" > /tmp/h.json 2>/dev/null; then OK=1; break; fi
done
if [ "$OK" != "1" ]; then
  echo "healthz 起不来,服务日志:"
  tail -30 c_real.log
  exit 1
fi
python3 -c "import json;print(json.dumps(json.load(open('/tmp/h.json')),ensure_ascii=False,indent=2))" 2>/dev/null || cat /tmp/h.json

echo
echo "=== 3. 下单 ==="
if [ -n "$PRODUCTS" ]; then
  META="{\"campaign_name\":\"$CAMPAIGN\",\"target_products\":$PRODUCTS}"
  echo "品类:显式指定 $PRODUCTS"
else
  META="{\"campaign_name\":\"$CAMPAIGN\"}"
  echo "品类:走默认(--auto-meta 从数据的 activity_product_name 取,取到什么见 meta.json 的 notes)"
fi
# 契约收窄后入参只有 activity_id / date / meta(campaign_type 放 meta 里);
# push_source 由上面的 MA_PUSH_SOURCE 决定,写进 body 会被 400 拒单。
BODY="{\"activity_id\":\"$ACT\",\"meta\":$META}"
echo "请求体:$BODY"
curl -s -m 10 -X POST "http://127.0.0.1:$PORT/api/ma/diagnose" \
  -H "content-type: application/json" -H "x-ma-api-key: $KEY" \
  -d "$BODY" > /tmp/post.json
cat /tmp/post.json; echo
JOB=$(python3 -c "import json;print(json.load(open('/tmp/post.json')).get('job_id',''))" 2>/dev/null)
echo "JOB=$JOB"
if [ -z "$JOB" ]; then echo "下单失败,退出"; tail -30 c_real.log; exit 1; fi

echo
echo "=== 4. 轮询(最多 40 分钟)==="
T0=$(date +%s)
for i in $(seq 1 240); do
  sleep 10
  curl -s -m 5 "http://127.0.0.1:$PORT/api/ma/jobs/$JOB" -H "x-ma-api-key: $KEY" > /tmp/job.json 2>/dev/null
  ST=$(python3 -c "import json;d=json.load(open('/tmp/job.json'));print(d.get('state'),'/',d.get('phase'))" 2>/dev/null)
  MEM=$(free -m | awk '/Mem:/{printf "%s/%sMB", $3, $2}')
  echo "[$(( $(date +%s) - T0 ))s] $ST  used=$MEM"
  case "$ST" in
    done*|error*) break;;
  esac
done

echo
echo "=== 5. 任务状态全文 ==="
python3 -c "import json;print(json.dumps(json.load(open('/tmp/job.json')),ensure_ascii=False,indent=2))" 2>/dev/null || cat /tmp/job.json

echo
echo "=== 6. 结果出参 ==="
curl -s -m 15 "http://127.0.0.1:$PORT/api/ma/jobs/$JOB/result" -H "x-ma-api-key: $KEY" > c_real_result.json
python3 - <<'PY'
import json
try:
    d = json.load(open('c_real_result.json', encoding='utf-8'))
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
    print("meta.json 读不出来:", e); raise SystemExit
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

echo
echo "=== 7. 发布物 ==="
ls -l ~/html-server/staging | tail -5
# 用出参里真实的 report_url 去验,别自己拼路径 —— 拼错了只会得到一个假的 404,
# 让人以为是发布失败,其实是这行猜错了前缀。
RURL=$(python3 -c "import json;print(json.load(open('c_real_result.json',encoding='utf-8')).get('report_url') or '')" 2>/dev/null)
echo "report_url = $RURL"
if [ -n "$RURL" ]; then
  LOCAL=$(python3 -c "
import sys
try:
    from urllib.parse import urlsplit
except ImportError:
    from urlparse import urlsplit
print('http://127.0.0.1:8000' + (urlsplit(sys.argv[1]).path or '/'))" "$RURL" 2>/dev/null)
  curl -s -o /dev/null -w "报告页(本机验) $LOCAL -> HTTP %{http_code}, %{size_download} 字节\n" \
    -m 10 "$LOCAL"
else
  echo "出参里没有 report_url,跳过页面验活"
fi
echo "--- 正文自检:还有没有草稿句 ---"
python3 - "$RURL" <<'PY'
import glob, io, os, sys
d = os.path.expanduser("~/html-server/staging")
fs = sorted(glob.glob(os.path.join(d, "*.html")), key=os.path.getmtime, reverse=True)
if not fs:
    print("  staging 里没有 html"); raise SystemExit
p = fs[0]
try:
    b = io.open(p, encoding="utf-8", errors="replace").read()
except Exception as e:
    print("  读不出来:", e); raise SystemExit
print("  最新页面 %s (%d 字节)" % (os.path.basename(p), len(b)))
print("  是 skill 正版模板 :", "ma-official-template" in b or "ma-report" in b)
print("  [待润色] 残留     :", b.count("[待润色]"))
print("  「补充」开头的骨架句:", b.count(">补充") + b.count("补充现象") + b.count("补充业务"))
PY

echo
echo "=== 8. 服务日志尾巴 ==="
tail -45 c_real.log

echo
echo "=== C REAL DONE ==="
date '+%F %T'
