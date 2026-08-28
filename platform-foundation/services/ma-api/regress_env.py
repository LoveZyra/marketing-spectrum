# -*- coding: utf-8 -*-
"""环境体检 + HTTP 长连接 + Prism 自启 三块的回归。

这三块有个共同点:**出事的时候不报错**。所以只能靠回归钉住。

  1) check_env 单测
     体检本身错了没人会发现 —— 它平时就该一句话不说。所以每条规则都用假输入
     正反各打一遍,顺带钉住"ma_server 的出厂默认值应当零告警"这条:那是判断
     "这份代码能不能直接上 ma_server"的唯一客观标准。

  2) HTTP 长连接不串包
     2026-07-29 修的那个 desync。症状是第三个请求莫名其妙 400,而病因是第一个
     请求留下的残渣。这个 bug 只在**同一条 keep-alive 连接上连发多个请求**时出现,
     curl 每次新开连接是测不出来的,所以这里直接用裸 socket 发。

  3) Prism 自启的拒绝阶梯
     preflight 里那串判断是照着 Prism 侧 ma-service.js 的 planAutostart() 抄的。
     两边只要有一边改了,就会变成"体检说没问题、Prism 说不挂载"—— 最难查的一类。
     这里把阶梯顺序和每一档的级别钉死,再顺手做一次和 JS 源码的字面对照。

用法:python3 regress_env.py
"""
import json
import os
import shutil
import socket
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
BASE = os.path.dirname(os.path.abspath(__file__))

# 硬设,不是 setdefault:这个脚本会被 install.sh 在**部署 shell** 里执行,而那个
# shell 上 MA_RUNTIME 多半已经是 real 了。回归的每条用例都自己造输入(check_env 的
# 参数、假的 runner),本来就与本机档位无关 —— 让 import 时的那次体检也无关,
# 免得哪天有人在 ma_pipeline 顶上加了点跟档位有关的东西,回归就开始看人下菜。
os.environ["MA_RUNTIME"] = "stub"

import ma_pipeline as P  # noqa: E402

OK, BAD = [], []


def check(name, cond, detail=""):
    (OK if cond else BAD).append(name)
    print("  [{}] {}{}".format("PASS" if cond else "FAIL", name,
                               ("  <- " + detail) if detail else ""))


def _exists(*present):
    """造一个假的 os.path.exists:只有点名的这些路径算存在。

    check_env 把 exists 做成参数就是为了这个 —— 回归不必真的去建 /home/jovyan。
    """
    have = set(present)
    return lambda p: p in have


# 一台"配置完全正确的 ma_server"长什么样。下面所有用例都是在它基础上改一处。
GOOD = dict(
    runtime="real",
    public_dir="/home/jovyan/prism/public",
    url_base="https://friday_deployment_14540_algo_agent.gw.friday.17usoft.com",
    on_ma_server=True,
    skill_dir="/home/jovyan/.claude/skills/marketing-audit",
    hdfs_get="/home/jovyan/.claude/skills/hdfs-data/hdfs_get.py",
    csv_path="",
    data_kind="hive",
    steps_kind="skill",
)
GOOD_FILES = (GOOD["public_dir"],
              GOOD["hdfs_get"],
              os.path.join(GOOD["skill_dir"], "cli.py"))


def env(**over):
    kw = dict(GOOD)
    kw.update(over)
    kw.setdefault("exists", _exists(*GOOD_FILES))
    return P.check_env(**kw)


# ================================================================= 1) check_env
print("\n=== 1) check_env 单测(假输入,不碰真文件系统)===")

fatal, warn = env()
check("ma_server 出厂默认值:零 fatal 零 warn", not fatal and not warn,
      "fatal={} warn={}".format(fatal, warn))

# 规则 1:报告链接还指着东京测试机。
fatal, _ = env(url_base="http://43.167.214.72:8000")
check("规则1 URL 指测试机 → fatal", any("测试机" in m for m in fatal), str(fatal))
fatal, _ = env(url_base="http://43.167.214.72:8000", on_ma_server=False)
check("规则1 不在 ma_server 上就不算事", not any("测试机" in m for m in fatal))

# 规则 2:出参链接是回环,调用方拿到手打不开。
for host in ("http://127.0.0.1:8080", "http://localhost:8080"):
    fatal, _ = env(url_base=host)
    check("规则2 {} → fatal".format(host), any("本机地址" in m for m in fatal), str(fatal))

# 规则 3:端口不在网关白名单。是 warn 不是 fatal —— 也许那个口真的通。
_, warn = env(url_base="https://gw.example.com:9000/x")
check("规则3 非网关端口 → warn", any("网关" in m for m in warn), str(warn))
_, warn = env(url_base="https://gw.example.com:8080/x")
check("规则3 8080 不告警", not any("网关目前只转发" in m for m in warn), str(warn))

# 规则 4:发布目录不在。两种措辞要分得开 —— 上级在不在决定了该怎么修。
fatal, _ = env(exists=_exists(GOOD["hdfs_get"],
                              os.path.join(GOOD["skill_dir"], "cli.py"),
                              "/home/jovyan/prism"))
check("规则4 发布目录缺、上级在 → 提示 mkdir",
      any("mkdir -p" in m for m in fatal), str(fatal))
fatal, _ = env(exists=_exists(GOOD["hdfs_get"],
                              os.path.join(GOOD["skill_dir"], "cli.py")))
check("规则4 连上级都没有 → 另一种措辞",
      any("连上级" in m for m in fatal), str(fatal))

# 规则 5:机器和档位对不上。两个方向都只该 warn。
_, warn = env(runtime="csv", data_kind="csv", csv_path=__file__,
              exists=_exists(__file__, *GOOD_FILES))
check("规则5 在 ma_server 上跑 csv → warn 不 fatal", any("不是 Hive 真数据" in m for m in warn))
f5, warn = env(runtime="csv", data_kind="csv", csv_path=__file__,
               exists=_exists(__file__, *GOOD_FILES))
check("规则5 那种情况没有 fatal", not f5, str(f5))
_, warn = env(on_ma_server=False)
check("规则5 反向:real 但不像 ma_server → warn", any("不像 ma_server" in m for m in warn))

# 规则 6:取数脚本不在,每一单都会在第一步倒下。
fatal, _ = env(exists=_exists(GOOD["public_dir"],
                              os.path.join(GOOD["skill_dir"], "cli.py")))
check("规则6 取数脚本缺 → fatal", any("取数脚本不在" in m for m in fatal), str(fatal))

# 规则 7:skill 不在只降级不致命 —— 这条最容易被写成 fatal,钉住。
fatal, warn = env(exists=_exists(GOOD["public_dir"], GOOD["hdfs_get"]))
check("规则7 skill 缺 → warn", any("cli.py" in m for m in warn), str(warn))
check("规则7 skill 缺不是 fatal", not any("cli.py" in m for m in fatal), str(fatal))

# 规则 8:csv 档的数据文件。MA_CSV 没有默认值是有意为之。
fatal, _ = env(runtime="csv", data_kind="csv", steps_kind="skill", csv_path="",
               on_ma_server=False)
check("规则8 csv 档没给 MA_CSV → fatal", any("MA_CSV 没配" in m for m in fatal), str(fatal))
check("规则8 报错里点名 MA_CSV(不是 MA_CSV_PATH)",
      any("MA_CSV=" in m for m in fatal), str(fatal))
fatal, _ = env(runtime="csv", data_kind="csv", csv_path="/nope/x.csv", on_ma_server=False)
check("规则8 文件不存在 → fatal", any("文件不存在" in m for m in fatal), str(fatal))
fatal, _ = env(runtime="csv", data_kind="csv", csv_path=__file__, on_ma_server=False,
               exists=_exists(__file__, *GOOD_FILES))
check("规则8 给对了就闭嘴", not fatal, str(fatal))

# 体检本身不该有副作用:显式传参时一个环境变量都不该读。
_saved = dict(os.environ)
env()
check("check_env 不改环境变量", dict(os.environ) == _saved)

lines = P.format_env_report(["甲"], ["乙"], prefix="  ")
check("format_env_report 排版", lines == ["  ✗ [环境] 甲", "  ⚠ [环境] 乙"], str(lines))


# ============================================== 2) HTTP 长连接(desync 回归)
print("\n=== 2) 同一条 keep-alive 连接上连发多个请求 ===")

JOBS = tempfile.mkdtemp(prefix="regress_env_jobs_")
os.environ["MA_JOBS_DIR"] = JOBS
os.environ["MA_API_KEY"] = "regress-env-key-0123456789"

import ma_core  # noqa: E402

ma_core.API_KEY = "regress-env-key-0123456789"
ma_core.JOBS_DIR = JOBS
ma_core.STORE = ma_core.JobStore(JOBS)

# 源码级哨兵:这个 override 一旦被"清理"掉,_drain_body 就退化成只对每条连接的
# 第一个请求生效,而回归里那几个 assert 未必抓得住每一种排列。所以正面钉一次。
src = open(os.path.join(BASE, "ma_core.py"), encoding="utf-8").read()
check("哨兵 handle_one_request 还在", "def handle_one_request" in src)
check("哨兵 它确实重置了 _body_done",
      "def handle_one_request" in src
      and "self._body_done = False" in src.split("def handle_one_request", 1)[1][:1200])


def _runner(job_id, params):
    return {"ok": True, "activity_id": params["activity_id"]}


from http.server import ThreadingHTTPServer  # noqa: E402

SRV = ThreadingHTTPServer(("127.0.0.1", 0), ma_core.make_handler("t", _runner))
SRV.daemon_threads = True
PORT = SRV.server_address[1]
threading.Thread(target=SRV.serve_forever, daemon=True).start()
ma_core.log = lambda *a, **k: None


class Conn(object):
    """一条连接,手写请求、手写解析。用 http.client 会替你重开连接,那就测不到了。"""

    def __init__(self):
        self.s = socket.create_connection(("127.0.0.1", PORT), timeout=10)
        self.buf = b""

    def send(self, method, path, body=None, key=None, headers=None):
        h = ["{} {} HTTP/1.1".format(method, path), "Host: 127.0.0.1"]
        if key:
            h.append("{}: {}".format(ma_core.AUTH_HEADER, key))
        raw = (body or "").encode("utf-8")
        if body is not None:
            h.append("Content-Type: application/json")
            h.append("Content-Length: {}".format(len(raw)))
        for extra in (headers or []):
            h.append(extra)
        self.s.sendall(("\r\n".join(h) + "\r\n\r\n").encode("utf-8") + raw)

    def recv(self):
        """读一个完整响应,返回 (状态码, body 文本)。多余的字节留在 buf 里给下一次。"""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.s.recv(65536)
            if not chunk:
                return None, ""
            self.buf += chunk
        head, rest = self.buf.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        status = int(lines[0].split()[1])
        length = 0
        for ln in lines[1:]:
            if ln.lower().startswith("content-length:"):
                length = int(ln.split(":", 1)[1].strip())
        while len(rest) < length:
            chunk = self.s.recv(65536)
            if not chunk:
                break
            rest += chunk
        self.buf = rest[length:]
        return status, rest[:length].decode("utf-8", "replace")

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass


KEY = "regress-env-key-0123456789"
BODY = json.dumps({"activity_id": "REGRESS_DESYNC"})

# 关键序列:两个带请求体但会被 401 挡掉的 POST(服务端根本没读那个 body),
# 后面再跟正常请求。修之前第三个请求就会拿着上一个请求的残渣去解析。
c = Conn()
seq = []
c.send("POST", "/api/ma/diagnose", body=BODY)                    # 401,body 没人读
seq.append(c.recv()[0])
c.send("POST", "/api/ma/diagnose", body=BODY, key="wrong-key")   # 401,body 又没人读
seq.append(c.recv()[0])
c.send("POST", "/api/ma/diagnose", body=BODY, key=KEY)           # 202
st, txt = c.recv()
seq.append(st)
c.send("GET", "/healthz")                                        # 200
seq.append(c.recv()[0])
c.close()
check("401→401→202→200 全部按序解析", seq == [401, 401, 202, 200], str(seq))
check("202 的 body 是合法 job", (json.loads(txt).get("state") == "queued")
      if seq[2] == 202 else False, txt[:120])

# 超大 body:服务端选择关连接而不是硬吃 —— 这条要能明确看出"连接被关了"。
c = Conn()
big = json.dumps({"activity_id": "X", "pad": "z" * (ma_core.MAX_BODY + 4096)})
c.send("POST", "/api/ma/diagnose", body=big, key=KEY)
st, _ = c.recv()
check("超大 body → 400", st == 400, str(st))
c.close()

# 未鉴权 + 超大 body:401 在读 body 之前就发了,drain 得能扛住这么大的残渣。
c = Conn()
c.send("POST", "/api/ma/diagnose", body=big)
st1, _ = c.recv()
c.send("GET", "/healthz")
st2, _ = c.recv()
check("401(带超大未读 body)之后连接仍可用或干净关闭",
      st1 == 401 and st2 in (200, None), "{} / {}".format(st1, st2))
c.close()

# 同一活动并发 → 409,而且 409 之后连接照样能用。
c = Conn()
c.send("POST", "/api/ma/diagnose", body=json.dumps({"activity_id": "BUSY_ONE"}), key=KEY)
a = c.recv()[0]
c.send("POST", "/api/ma/diagnose", body=json.dumps({"activity_id": "BUSY_ONE"}), key=KEY)
b = c.recv()[0]
c.send("GET", "/healthz")
d = c.recv()[0]
check("202→409→200(同活动并发被拦,连接不受影响)",
      (a, d) == (202, 200) and b in (202, 409), "{} {} {}".format(a, b, d))
c.close()

# 口令或请求头里带非 ASCII:必须干净地 401 收场,绝不能把连接炸成 RESET。
# 2026-07-30 线上事故:ma-env.local.sh 里被抄进了中文占位符「你的口令」,str 版
# compare_digest 撞非 ASCII 直接抛 TypeError,每个带鉴权的请求都成了 ECONNRESET,
# 而 healthz(免鉴权)一直是好的 —— 网关侧只看得到 E_MA_UNREACHABLE,极难定位。
_old_key = ma_core.API_KEY
ma_core.API_KEY = "中文口令-绝不该这么配"
c = Conn()
c.send("POST", "/api/ma/diagnose", body=BODY, key=KEY)
st_badkey, _ = c.recv()
c.send("GET", "/healthz")
st_after = c.recv()[0]
check("服务端口令含非 ASCII → 干净 401,不是连接重置", st_badkey == 401, str(st_badkey))
check("同一条连接后续请求照常(handler 没被炸死)", st_after == 200, str(st_after))
c.close()
ma_core.API_KEY = _old_key

c = Conn()
c.send("POST", "/api/ma/diagnose",
       body=json.dumps({"activity_id": "NONASCII_HDR"}), key="ké¥-带高位字节的头")
st_badhdr, _ = c.recv()
check("客户端请求头里带非 ASCII → 也是干净 401", st_badhdr == 401, str(st_badhdr))
c.close()

SRV.shutdown()
shutil.rmtree(JOBS, ignore_errors=True)


# ================================================= 3) Prism 自启的拒绝阶梯
print("\n=== 3) preflight 的 Prism 自启判断 ===")

import preflight_ma_server as PF  # noqa: E402

SCRIPT = os.path.join(BASE, "ma_api_c.py")


def autostart(**over):
    """在临时环境变量下跑 check_prism_autostart,返回 [(level, name, detail)]。"""
    saved = dict(os.environ)
    for k in ("PRISM_MA_API_AUTOSTART", "PRISM_MA_API_TARGET", "PRISM_MA_API_ALLOW_NO_KEY",
              "PRISM_MA_API_PYTHON", "MA_API_KEY", "API_KEY"):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in over.items() if v is not None})
    try:
        rep = PF.Report()
        PF.check_prism_autostart(rep, no_network=True)
        return [(r["level"], r["name"], r["detail"]) for r in rep.rows]
    finally:
        os.environ.clear()
        os.environ.update(saved)


rows = autostart()
check("没配自启 = ✓ 不是 ⚠(默认用法别报警)",
      len(rows) == 1 and rows[0][0] == PF.OK, str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, MA_API_KEY="k" * 20)
check("阶梯1 缺 TARGET → FAIL/no_target",
      rows[0][0] == PF.FAIL and "no_target" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, MA_API_KEY="k" * 20,
                 PRISM_MA_API_TARGET="10.195.43.111:8092")
check("阶梯2 TARGET 非回环 → FAIL/not_loopback",
      rows[0][0] == PF.FAIL and "not_loopback" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART="ma_api_c.py", MA_API_KEY="k" * 20,
                 PRISM_MA_API_TARGET="127.0.0.1:8092")
check("阶梯3 相对路径 → FAIL/not_absolute",
      rows[0][0] == PF.FAIL and "not_absolute" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART="/nope/ma_api_c.py", MA_API_KEY="k" * 20,
                 PRISM_MA_API_TARGET="127.0.0.1:8092")
check("阶梯4 文件不存在 → FAIL",
      rows[0][0] == PF.FAIL and "不存在" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, PRISM_MA_API_TARGET="127.0.0.1:8092")
check("阶梯5 没 MA_API_KEY → FAIL/no_key",
      rows[0][0] == PF.FAIL and "no_key" in rows[0][2], str(rows))
check("阶梯5 措辞点明是「不起」不是「警告」",
      "不起" in rows[0][2] or "拒绝自启" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, PRISM_MA_API_TARGET="127.0.0.1:8092",
                 MA_API_KEY="same-value-xyz", API_KEY="same-value-xyz")
check("阶梯6 口令复用 → FAIL/key_reuse",
      rows[0][0] == PF.FAIL and "key_reuse" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, PRISM_MA_API_TARGET="127.0.0.1:8092",
                 MA_API_KEY="ma-key-1", API_KEY="llm-key-2")
check("两个 key 不同值就放行", rows[0][0] == PF.OK, str(rows))
check("放行时说清端口是反推的(不读本 shell 的 MA_API_PORT)",
      "反推" in rows[0][2] and "127.0.0.1:8092" in rows[0][2], str(rows))

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, PRISM_MA_API_TARGET="127.0.0.1:8092",
                 PRISM_MA_API_ALLOW_NO_KEY="1")
check("ALLOW_NO_KEY=1 → 放行但 WARN",
      [r[0] for r in rows] == [PF.WARN, PF.OK], str([r[0] for r in rows]))

rows = autostart(PRISM_MA_API_AUTOSTART="/tmp/elsewhere/ma_api_c.py",
                 PRISM_MA_API_TARGET="127.0.0.1:8092", MA_API_KEY="k" * 20)
check("路径不存在优先于「目录不一致」报出来",
      rows[0][0] == PF.FAIL, str(rows))

os.makedirs("/tmp/regress_env_other", exist_ok=True)
shutil.copy(SCRIPT, "/tmp/regress_env_other/ma_api_c.py")
rows = autostart(PRISM_MA_API_AUTOSTART="/tmp/regress_env_other/ma_api_c.py",
                 PRISM_MA_API_TARGET="127.0.0.1:8092", MA_API_KEY="k" * 20)
check("自启指向另一份代码 → 额外 WARN",
      any(r[0] == PF.WARN and "不是同一份" in r[2] for r in rows), str(rows))
shutil.rmtree("/tmp/regress_env_other", ignore_errors=True)

rows = autostart(PRISM_MA_API_AUTOSTART=SCRIPT, PRISM_MA_API_TARGET="http://localhost:8093",
                 MA_API_KEY="k" * 20, PRISM_MA_API_PYTHON="/usr/bin/python3.11")
check("带 scheme 的 TARGET + 自定义解释器都认",
      rows[0][0] == PF.OK and "localhost:8093" in rows[0][2]
      and "/usr/bin/python3.11" in rows[0][2], str(rows))

# _parse_target 要和 JS 的 parseUpstream 同规则。
for raw, want in (("127.0.0.1:8092", True), ("localhost:8092", True),
                  ("http://127.0.0.1:8092", True), ("[::1]:8092", True),
                  ("10.0.0.5:8092", False), ("https://127.0.0.1:8092", False),
                  ("", False), ("127.0.0.1:99999", False)):
    got = PF._parse_target(raw)["ok"]
    check("_parse_target({!r}) → {}".format(raw, want), got == want, str(PF._parse_target(raw)))


# ---- 「反代目标」这一项:纯读环境变量,一个包都不发,所以 --no-network 下也必须照常报。
# 它早先跟着网络探测一起被提前 return 掉了。而 --no-network 恰恰是上了不出网的机器
# 才会用的模式 —— 在那种时候把唯一一条纯配置检查关掉,正好关反了。所以这里钉住。
import ma_core as _mc  # noqa: E402


def proxy(port=8092, **over):
    """在临时环境下跑 check_prism_proxy(no_network=True),返回 [(level, name, detail)]。"""
    saved, saved_port = dict(os.environ), _mc.PORT
    for k in ("PRISM_MA_API_TARGET", "PRISM_MA_API_AUTOSTART"):
        os.environ.pop(k, None)
    os.environ.update({k: v for k, v in over.items() if v is not None})
    _mc.PORT = port          # 本服务监听哪个端口,由这里说了算,不看跑回归的这台机器
    try:
        rep = PF.Report()
        PF.check_prism_proxy(rep, no_network=True)
        return [(r["level"], r["name"], r["detail"]) for r in rep.rows]
    finally:
        _mc.PORT = saved_port
        os.environ.clear()
        os.environ.update(saved)


rows = proxy()
check("--no-network 下「反代目标」照样报",
      len(rows) == 1 and rows[0][1] == "反代目标" and rows[0][0] == PF.WARN, str(rows))
check("没配 TARGET 时点明它该配在起 Prism 的那个 shell 里",
      "Prism" in rows[0][2] and "shell" in rows[0][2], str(rows))

rows = proxy(PRISM_MA_API_TARGET="10.195.43.111:8092")
check("TARGET 非回环 → FAIL 而不是 WARN(Prism 是整条反代都不挂载)",
      rows[0][0] == PF.FAIL and "404" in rows[0][2], str(rows))

rows = proxy(PRISM_MA_API_TARGET="http://127.0.0.1:8092")
check("带 scheme 的 TARGET 不该被报成端口不一致(比端口,不比字面)",
      rows[0][0] == PF.OK, str(rows))

rows = proxy(PRISM_MA_API_TARGET="127.0.0.1:8099")
check("端口真对不上 → WARN", rows[0][0] == PF.WARN and "8099" in rows[0][2], str(rows))

rows = proxy(PRISM_MA_API_TARGET="127.0.0.1:8099", PRISM_MA_API_AUTOSTART=SCRIPT)
check("开了自启就不比端口(比了只会指挥人把 TARGET 改成一个用不上的值)",
      rows[0][0] == PF.OK and "反推" in rows[0][2], str(rows))


# ---- 和 Prism 侧 JS 的字面对照(找得到源码才做,找不到就跳过)
print("\n--- 与 ma-service.js 的口径对照 ---")
js = None
for cand in (os.environ.get("MA_PRISM_DIR"), "/home/jovyan/prism",
             os.path.expanduser("~/prism"), "/home/claude/prism-work"):
    if not cand:
        continue
    p = os.path.join(cand, "server", "services", "ma-service.js")
    if os.path.exists(p):
        js = open(p, encoding="utf-8").read()
        print("  对照源:{}".format(p))
        break
if js is None:
    print("  (没找到 ma-service.js,跳过这组。要做就 export MA_PRISM_DIR=/home/jovyan/prism)")
else:
    for reason in ("no_target", "not_absolute", "not_found", "no_key", "key_reuse"):
        check("JS 里有 reason:{}".format(reason), "'{}'".format(reason) in js)
    check("JS 读的是 MA_API_KEY", "env.MA_API_KEY" in js)
    check("JS 认 PRISM_MA_API_ALLOW_NO_KEY", "PRISM_MA_API_ALLOW_NO_KEY" in js)
    check("JS 把 MA_API_PORT 按 plan.port 覆写(端口不会跑偏)",
          "MA_API_PORT" in js and "plan.port" in js)
    check("JS 把 MA_API_HOST 按 plan.host 覆写",
          "MA_API_HOST" in js and "plan.host" in js)


# ================================================= 4) 报告发布:一单一链接
print("\n=== 4) 报告发布:链接一单一份,不再互相覆盖 ===")
# 2026-08-17 之前发布文件名是 diagnosis-report-{activity_id}.html —— 同一活动复诊
# 会把上一单原地盖掉:先前发出去的链接全部改指最新内容(最坏是指到一份带降级
# 横幅的半成品),历史版本再也找不回来。现在名字带 job_id,一单一份。

_PUB = tempfile.mkdtemp()
_JOBS = tempfile.mkdtemp()
_OLD_PUB, _OLD_URL, _OLD_KEEP = P.PUBLIC_DIR, P.URL_BASE, P.REPORT_KEEP
P.PUBLIC_DIR, P.URL_BASE = _PUB, "http://host/pub"


def _publish(aid, jid, keep=None):
    """造一单标准形状的 rundir(<jobs>/<job_id>/run)并发布,返回 url。"""
    rd = os.path.join(_JOBS, jid, "run")
    os.makedirs(rd, exist_ok=True)
    html = os.path.join(rd, "diagnosis_report.html")
    with open(html, "w", encoding="utf-8") as f:
        f.write("<html><body>" + jid + "</body></html>")
    ctx = P.Ctx({"activity_id": aid}, rd, log=lambda _s: None)
    if keep is not None:
        P.REPORT_KEEP = keep
    return ctx, P.publish_html(ctx, html)


_c1, _u1 = _publish("ACT9", "job_20260817_161200_aaaaaa", keep=0)
_c2, _u2 = _publish("ACT9", "job_20260817_161300_bbbbbb", keep=0)
_c3, _u3 = _publish("ACT9", "job_20260817_161400_cccccc", keep=0)

check("同一活动连下三单 → 三个不同链接", len({_u1, _u2, _u3}) == 3,
      "\n    ".join([_u1 or "", _u2 or "", _u3 or ""]))
check("job_id 从 rundir 推得出来", _c1.job_id == "job_20260817_161200_aaaaaa", str(_c1.job_id))
check("文件名带活动号(运维一眼看出是哪个活动)", "diagnosis-report-ACT9-" in (_u1 or ""), _u1 or "")
check("三份内容各自留在盘上,没被后来的单覆盖",
      sorted(open(os.path.join(_PUB, os.path.basename(u)), encoding="utf-8").read()
             .count(j) for u, j in
             ((_u1, "aaaaaa"), (_u2, "bbbbbb"), (_u3, "cccccc"))) == [1, 1, 1])
check("URL 前缀仍取 MA_URL_BASE", (_u1 or "").startswith("http://host/pub/"), _u1 or "")

# 显式传 job_id 优先于从 rundir 推(方案 B 的 Ctx 就是这么用的)
_ctx_x = P.Ctx({"activity_id": "ACT9"}, os.path.join(_JOBS, "不是标准形状"),
               job_id="job_20260817_170000_dddddd")
check("显式给的 job_id 说了算", _ctx_x.job_id == "job_20260817_170000_dddddd", str(_ctx_x.job_id))

# 非标准 rundir(命令行自测 runs/<activity_id>):兜底造尾巴,同秒两次也不撞
_ctx_cli = P.Ctx({"activity_id": "ACT9"}, os.path.join(_JOBS, "runs", "ACT9"))
check("非标准 rundir 不猜假 job_id", _ctx_cli.job_id is None, str(_ctx_cli.job_id))
_n1, _n2 = P.report_filename(_ctx_cli), P.report_filename(_ctx_cli)
check("兜底文件名同秒两次也不撞(纯时间戳会撞)", _n1 != _n2, _n1 + " / " + _n2)
check("兜底文件名形状与正常单一致(清理认得出来)",
      P._REPORT_TAIL_RE.match(_n1[len("diagnosis-report-ACT9-"):-len(".html")]) is not None, _n1)

# ---- 保留策略:只动本活动,别人的和历史遗留的一概不碰
_legacy = os.path.join(_PUB, "diagnosis-report-ACT9.html")
with open(_legacy, "w", encoding="utf-8") as f:
    f.write("2026-08-17 之前那个固定名")
# ACT9-B 是**另一个活动**,名字恰好以 ACT9- 开头 —— 裸 startswith 会把它误删
_cb, _ub = _publish("ACT9-B", "job_20260817_161500_eeeeee", keep=0)
_c4, _u4 = _publish("ACT9", "job_20260817_161600_ffffff", keep=1)

_left = sorted(os.listdir(_PUB))
check("保留上限生效:同一活动只剩最近 1 份",
      len([f for f in _left if f.startswith("diagnosis-report-ACT9-job")]) == 1, str(_left))
check("留下的是最新那一份",
      os.path.basename(_u4 or "") in _left, str(_left))
check("另一个活动(名字以本活动 id 开头)没被误删",
      "diagnosis-report-ACT9-B-job_20260817_161500_eeeeee.html" in _left, str(_left))
check("2026-08-17 之前的固定名不碰(老链接照样打得开)",
      "diagnosis-report-ACT9.html" in _left, str(_left))

P.REPORT_KEEP = 0
_c5, _u5 = _publish("ACT9", "job_20260817_161700_999999")
check("MA_REPORT_KEEP=0 → 一份都不清",
      len([f for f in os.listdir(_PUB) if f.startswith("diagnosis-report-ACT9-job")]) == 2,
      str(sorted(os.listdir(_PUB))))

# 清理炸了不能让整单红
_c6, _u6 = _publish("ACT9", "job_20260817_161800_888888", keep=2)
P.PUBLIC_DIR = os.path.join(_PUB, "这个目录不存在")
check("清理目录都没了也只是 0,不抛", P.prune_reports(_c6, keep=1) == 0)
P.PUBLIC_DIR = _PUB

# 发布目录不存在时的老行为不变:告警 + report_url=None
P.PUBLIC_DIR = os.path.join(_PUB, "缺席的发布目录")
_c7 = P.Ctx({"activity_id": "ACT9"}, os.path.join(_JOBS, "job_20260817_161900_777777", "run"),
            log=lambda _s: None)
_html7 = _c7.path("diagnosis_report.html")
os.makedirs(_c7.rundir, exist_ok=True)
with open(_html7, "w", encoding="utf-8") as f:
    f.write("<html><body>x</body></html>")
check("发布目录不存在 → 仍是告警降级,不抛也不给假链接",
      P.publish_html(_c7, _html7) is None and any("发布目录不存在" in w for w in _c7.warnings),
      str(_c7.warnings)[:80])

P.PUBLIC_DIR, P.URL_BASE, P.REPORT_KEEP = _OLD_PUB, _OLD_URL, _OLD_KEEP
shutil.rmtree(_PUB, ignore_errors=True)
shutil.rmtree(_JOBS, ignore_errors=True)


print("\n=== 汇总:{} 过 / {} 挂 ===".format(len(OK), len(BAD)))
for b in BAD:
    print("  挂: {}".format(b))
sys.exit(1 if BAD else 0)
