#!/bin/bash
# 方案B:同一份真实 CSV,换成「全程 Claude Code 编排」。
# 和 C 用同样的入参、同样的口径检查,差别只在中间那一段是谁在干活。
cd /home/ubuntu/demo/ma-api-mode || exit 1
CSV=$(ls /home/ubuntu/*.csv 2>/dev/null | head -1)
PORT=8093
KEY=ma-real-test-key
ACT=real_b_001

export MA_RUNTIME=csv
export MA_CSV="$CSV"
export MA_CSV_ENCODING=gb18030
export MA_API_PORT=$PORT
export MA_API_KEY=$KEY
# push_source 已从入参挪到服务端(2026-07-30 契约收窄),沿用之前实测的 both
export MA_PUSH_SOURCE=${MA_PUSH_SOURCE:-both}
# 默认 1500s 不够:2026-07-28 第一轮 B 就是卡在这上面,901s 时 claude 报
# 「API Error: The operation timed out.」,整单 error、出参全空。
# 跑通那一轮实测 594s,留一倍余量。这个值不要再往回调。
export MA_B_TIMEOUT=3000

echo "=== 0. 环境 ==="
date '+%F %T'
echo "CSV=$CSV"
md5sum ma_pipeline.py ma_api_b.py
free -m | head -2

echo
echo "=== 1. 起 方案B 服务 ==="
pkill -f "ma_api_[b].py" 2>/dev/null
sleep 1
nohup python3 ma_api_b.py > b_real.log 2>&1 &
OK=0
for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 3 "http://127.0.0.1:$PORT/healthz" > /tmp/hb.json 2>/dev/null; then OK=1; break; fi
done
if [ "$OK" != "1" ]; then
  echo "healthz 起不来,服务日志:"; tail -30 b_real.log; exit 1
fi
python3 -c "import json;print(json.dumps(json.load(open('/tmp/hb.json')),ensure_ascii=False,indent=2))" 2>/dev/null || cat /tmp/hb.json

echo
echo "=== 2. 下单 ==="
# 契约收窄:body 里不能再带 push_source(会被 400 拒单),由 MA_PUSH_SOURCE 决定
curl -s -m 10 -X POST "http://127.0.0.1:$PORT/api/ma/diagnose" \
  -H "content-type: application/json" -H "x-ma-api-key: $KEY" \
  -d "{\"activity_id\":\"$ACT\"}" > /tmp/postb.json
cat /tmp/postb.json; echo
JOB=$(python3 -c "import json;print(json.load(open('/tmp/postb.json')).get('job_id',''))" 2>/dev/null)
echo "JOB=$JOB"
if [ -z "$JOB" ]; then echo "下单失败,退出"; tail -30 b_real.log; exit 1; fi

echo
echo "=== 3. 轮询(最多 45 分钟)==="
T0=$(date +%s)
for i in $(seq 1 400); do
  sleep 10
  curl -s -m 5 "http://127.0.0.1:$PORT/api/ma/jobs/$JOB" -H "x-ma-api-key: $KEY" > /tmp/jobb.json 2>/dev/null
  ST=$(python3 -c "import json;d=json.load(open('/tmp/jobb.json'));print(d.get('state'),'/',d.get('phase'))" 2>/dev/null)
  MEM=$(free -m | awk '/Mem:/{printf "%s/%sMB", $3, $2}')
  echo "[$(( $(date +%s) - T0 ))s] $ST  used=$MEM"
  case "$ST" in
    done*|error*) break;;
  esac
done

echo
echo "=== 4. 任务状态全文 ==="
python3 -c "import json;print(json.dumps(json.load(open('/tmp/jobb.json')),ensure_ascii=False,indent=2))" 2>/dev/null || cat /tmp/jobb.json

echo
echo "=== 5. 结果出参 ==="
curl -s -m 15 "http://127.0.0.1:$PORT/api/ma/jobs/$JOB/result" -H "x-ma-api-key: $KEY" > b_real_result.json
python3 - <<'PY'
import json
try:
    d = json.load(open('b_real_result.json', encoding='utf-8'))
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
echo "--- 内部审计(degraded/warnings/push_sql 看 meta.json,不外发)---"
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
print("cli/llm =", json.dumps(r.get('cli') or r.get('llm'), ensure_ascii=False)[:200])
print("dropped = %d 条 / excluded = %d 条" % (
    len(cs.get('dropped_rules') or []), len(cs.get('excluded_rules') or [])))
print("--- push_sql(服务重算的)---")
print((cs.get('push_sql') or "")[:800])
for n in (cs.get('notes') or []):
    print(" *", n)
for w in (m.get('warnings') or []):
    print(" !", w)
PY

echo
echo "=== 6. 发布物 ==="
ls -l ~/html-server/staging | tail -5
curl -s -o /dev/null -w "报告页 HTTP %{http_code}, %{size_download} 字节\n" -m 10 \
  "http://127.0.0.1:8000/diagnosis-report-$ACT.html"

echo
echo "=== 7. 服务日志尾巴 ==="
tail -60 b_real.log

echo
echo "=== B REAL DONE ==="
date '+%F %T'
