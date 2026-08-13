#!/usr/bin/env bash
# 重启 Prism(顺带把营销诊断 MA 子进程一起换血)—— ma_server 专用。
# 用法:把本文件放在 /home/jovyan/prism/ 下:
#   bash restart_prism.sh              # 正常重启(不重新 build,Prism 代码没变就用这个)
#   REBUILD=1 bash restart_prism.sh    # Prism 自身代码变了,先 build 再起
#
# 为什么要有这个脚本:环境变量都在导入时读取,少 export 一个就是一次静默事故 ——
# 2026-07-30 那次就是重启时漏了 MA_RUNTIME,子进程按 stub 起、被环境闸门拒之门外。
# 从此所有该带的变量都写死在这里,密钥单独放 ma-env.local.sh,重启永远只有一条命令。
set -u
PRISM_DIR="$(cd "$(dirname "$0")" && pwd)"
MA_DIR="$PRISM_DIR/ma-api-mode"
cd "$PRISM_DIR" || exit 1

# ------------------------------------------------------------------ 1. 环境
# 非密钥的都写死在这儿;要临时覆盖就在命令行前缀里给(如 MA_PUSH_SOURCE=model bash ...)
export MA_RUNTIME=${MA_RUNTIME:-real}
export PRISM_MA_API_TARGET=${PRISM_MA_API_TARGET:-127.0.0.1:8092}
export PRISM_MA_API_AUTOSTART=${PRISM_MA_API_AUTOSTART:-$MA_DIR/ma_api_c.py}
# WebSocket 鉴权开关(2026-08-04 踩坑):浏览器 WS 升级请求设不了 Authorization 头,
# 只能走 ?token=<jwt> 传凭据;而服务端默认不读 query token,必须显式开这个开关 ——
# 不开就是 881 次失败 / 0 次成功,对话无响应、shell 永远"连接中"。
# 代价:JWT 进 URL,可能落到网关 access log;本部署走内网网关,可接受。
# 根治(前端改 ?ticket= 单次票据,JWT 不进 URL)见 Prism 启动加固文档 §3.2。
export PRISM_ALLOW_QUERY_TOKEN=${PRISM_ALLOW_QUERY_TOKEN:-1}
# fix9 的默认值已在代码里(push_source=both、超时 600/1800/2400、模型 sonnet/haiku),
# 只有要改掉默认时才需要在下面显式 export:
# export MA_PUSH_SOURCE=model
# export MA_AGENT_MODEL=sonnet MA_POLISH_MODEL=haiku
# export MA_POLISH_TIMEOUT=600 MA_POLISH_BUDGET=1800 MA_AGENT_TIMEOUT=2400

# 密钥不进脚本、不进备份、不进 tar:放在旁边的 ma-env.local.sh 里,内容一行:
#   export MA_API_KEY='一串随机值'
if [ -f "$PRISM_DIR/ma-env.local.sh" ]; then
  # shellcheck disable=SC1091
  . "$PRISM_DIR/ma-env.local.sh"
fi
if [ -z "${MA_API_KEY:-}" ]; then
  echo "✗ 没有 MA_API_KEY。在 $PRISM_DIR/ma-env.local.sh 里写一行:"
  echo "    export MA_API_KEY='一串随机值'"
  echo "  (这条路径经网关对外,裸跑等于把接口敞开,所以这里硬拦。)"
  exit 2
fi
if [ -n "${API_KEY:-}" ] && [ "$MA_API_KEY" = "$API_KEY" ]; then
  echo "✗ MA_API_KEY 和 API_KEY 同值 —— API_KEY 是模型 CLI 的凭据,两者撞名等于"
  echo "  让每个调接口的人都拿到模型密钥。换一个再来。"
  exit 2
fi
case "$MA_API_KEY" in
  *[![:ascii:]]*)
    echo "✗ MA_API_KEY 含非 ASCII 字符 —— 是不是把『你的口令』这类占位符原样抄进了"
    echo "  ma-env.local.sh?这种口令客户端带不上来,每个带鉴权的请求都会变 ECONNRESET"
    echo "  (2026-07-30 线上踩过)。生成真口令:openssl rand -hex 24,替换后再跑。"
    exit 2;;
esac

MA_PORT="${PRISM_MA_API_TARGET##*:}"

# ------------------------------------------------------------------ 2. 起服务前先体检
# 环境闸门在这儿就拦,别等起完了才发现子进程退出码 2。有 ✗ 行会直接打印原因。
echo "=== 1. 环境体检(ma_api_c.py --check)==="
if ! python3 "$MA_DIR/ma_api_c.py" --check >/tmp/ma_check.json 2>/tmp/ma_check.err; then
  echo "✗ 体检不过,拒绝重启。体检原话:"
  cat /tmp/ma_check.err
  echo "  (确认全部有意为之才 export MA_ALLOW_BAD_ENV=1;排查用 python3 $MA_DIR/preflight_ma_server.py)"
  exit 2
fi
grep -E '"runtime"|"push_source"|"public_dir"|"url_base"|"polish_timeout"' /tmp/ma_check.json | head -6

# ------------------------------------------------------------------ 3. 停旧的
echo "=== 2. 停 Prism(MA 子进程由它顺带收掉,不单独 pkill)==="
pkill -f 'dist-server/server/index.js' 2>/dev/null
pkill -f 'tsx.*server/index.js' 2>/dev/null
OK=0
for i in $(seq 1 15); do
  sleep 1
  if ! (ss -lnt 2>/dev/null || netstat -lnt) | grep -qE ":(8080|$MA_PORT) "; then OK=1; break; fi
done
if [ "$OK" != "1" ]; then
  echo "✗ 等了 15 秒,8080/$MA_PORT 还有进程占着:"
  (ss -lptn 2>/dev/null || netstat -lptn 2>/dev/null) | grep -E ":(8080|$MA_PORT) "
  echo "  多半是 Prism 在 tmux/screen 里前台跑着 —— 去那个会话里 Ctrl+C,再回来重跑本脚本。"
  echo "  这里宁可停下,也不起第二个实例跟它抢端口(两个进程互相顶,谁的单都下不出去)。"
  exit 1
fi
echo "  端口已释放。"

# ------------------------------------------------------------------ 4. 起新的
echo "=== 3. 起 Prism ==="
# env -u API_KEY:去掉 pod 继承的模型 CLI 凭据(不是 Prism 自己的密钥)。不去掉的话
# Prism REST 鉴权会拿它比对,报 401 Invalid API key(2026-07-29 踩过,记忆锚点
# prism-api-key-env-conflict;上面的撞值检查只防"同值",防不了"存在即冲突")。
# 只影响这一条命令的进程子树,不改当前 shell,也不影响 MA_API_KEY(独立变量)。
# ⚠ 装完验一把 report agent(claude 走 ~/.claude 配置/网关的不受影响;
#   若某环境的 claude 凭据恰好只靠 API_KEY 环境变量,这里会把它切断,及时能发现)。
if [ "${REBUILD:-0}" = "1" ]; then
  echo "  REBUILD=1:npm start(先 build 再起,慢)"
  nohup env -u API_KEY npm start > "$PRISM_DIR/prism.log" 2>&1 &
else
  nohup env -u API_KEY npm run server > "$PRISM_DIR/prism.log" 2>&1 &
fi
echo "  pid=$! 日志=$PRISM_DIR/prism.log(MA 子进程的输出带 [ma-service] 前缀)"

# ------------------------------------------------------------------ 5. 验活
echo "=== 4. 验活(最多等 60 秒)==="
UP=0
for i in $(seq 1 60); do
  sleep 1
  if curl -s -m 2 "http://127.0.0.1:$MA_PORT/healthz" >/tmp/ma_h.json 2>/dev/null; then UP=1; break; fi
done
if [ "$UP" != "1" ]; then
  echo "✗ 60 秒内 MA 服务没起来。prism.log 里 ma-service 的最后几句:"
  grep 'ma-service' "$PRISM_DIR/prism.log" | tail -8
  echo "  (一句都没有的话,看 prism.log 头部 —— 可能是 Prism 本体没起来。)"
  exit 1
fi
python3 - <<'PY'
import json
d = json.load(open("/tmp/ma_h.json"))
row = lambda k, v: print("  {:16s} = {}".format(k, v))
row("runtime", d.get("runtime"))
row("push_source", d.get("push_source"))
row("models", json.dumps(d.get("models"), ensure_ascii=False))
row("polish_timeout", d.get("polish_timeout"))
row("url_base", d.get("url_base"))
bad = []
if d.get("runtime") != "real":
    bad.append("runtime 不是 real")
if (d.get("models") or {}).get("polish") != "haiku":
    bad.append("润色模型不是 haiku")
print("  " + ("✗ " + ";".join(bad) if bad else "✓ 关键配置都对(fix9 + real 档)"))
PY
grep 'ma-service' "$PRISM_DIR/prism.log" | tail -3
echo "版本锚点:"; md5sum "$MA_DIR/ma_pipeline.py"
echo "=== 重启完成 ==="
