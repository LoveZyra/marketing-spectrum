#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
上线前体检 —— 在 ma_server 上起服务之前跑一遍

为什么要有这个东西:这条链路的失败方式大多**不长在报错里**。
取数挂了会报错,那是好事;真正难查的是"接口 200、报告也生成了,只是那个 URL
公司网里谁都打不开",或者"门禁口令读的是 LLM 的密钥"。这类问题在运行时一点症状都没有,
只能在启动前把环境本身检一遍。

分三级,含义是固定的:
  ✗ FAIL —— 起了服务也是白起,每一单都会出坏结果。默认让脚本以退出码 1 收尾。
  ⚠ WARN —— 可能是有意为之(比如在 ma_server 上先跑一轮 csv 验证),只提醒。
  ✓ OK   —— 检过了,是对的。

用法:
  python3 preflight_ma_server.py              # 按当前环境变量体检
  python3 preflight_ma_server.py --json       # 机器可读,给启动脚本/CI 用
  python3 preflight_ma_server.py --no-network # 跳过要连端口的那几项

⚠ 只读:这个脚本不建目录、不改配置、不起服务、不写任何业务文件。
   唯一的写动作是往临时目录写一个探针文件测可写性,写完立刻删。
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

FAIL, WARN, OK = "FAIL", "WARN", "OK"
_MARK = {FAIL: "✗", WARN: "⚠", OK: "✓"}


def _wide(s):
    """终端显示宽度。东亚宽字符占两格,ljust 按码点补会把表格排歪。"""
    import unicodedata
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in s)


def _pad(s, width):
    return s + " " * max(0, width - _wide(s))


class Report(object):
    def __init__(self):
        self.rows = []

    def add(self, level, name, detail, fix=None):
        self.rows.append({"level": level, "name": name, "detail": detail, "fix": fix})
        return level

    # ok 也收 fix:有些项本身是对的,但顺带要告诉你"想换条路走的话开关在这儿"。
    # 那不是问题,不该占 WARN 的额度 —— 每次都亮黄灯的提醒,三次之后就没人看了。
    ok = lambda self, n, d, f=None: self.add(OK, n, d, f)       # noqa: E731
    warn = lambda self, n, d, f=None: self.add(WARN, n, d, f)   # noqa: E731
    fail = lambda self, n, d, f=None: self.add(FAIL, n, d, f)   # noqa: E731

    def counts(self):
        c = {FAIL: 0, WARN: 0, OK: 0}
        for r in self.rows:
            c[r["level"]] += 1
        return c


# --------------------------------------------------------------------------- 各项检查


def check_python(rep):
    v = sys.version_info
    s = "{}.{}.{}".format(v.major, v.minor, v.micro)
    if v < (3, 8):
        rep.fail("Python", "版本 {} 太老,本项目按 3.8+ 写的".format(s))
    else:
        rep.ok("Python", "{} @ {}".format(s, sys.executable))
    # 方案文档里写"fastapi/uvicorn/flask 均未装,需装一个" —— 其实不需要:
    # 服务侧走的是标准库 http.server。把这条写进体检,省得有人照着文档去装一堆东西。
    rep.ok("Web 框架", "不需要。服务侧用标准库 http.server,没有第三方依赖 "
                       "(方案文档 §1.6 说要装 fastapi/uvicorn/flask,可以不管)")


def check_pipeline_import(rep):
    """import ma_pipeline 本身就是一道检查:它在 import 时会做完整的环境体检。"""
    try:
        import ma_pipeline
    except Exception as exc:                                  # noqa: BLE001
        rep.fail("加载 ma_pipeline", "{}: {}".format(type(exc).__name__, exc),
                 "先解决 import 错误,其余检查都依赖它")
        return None
    data, steps = ma_pipeline.resolve_runtime()
    rep.ok("后端解析", "MA_RUNTIME={} → 数据源={} 诊断步骤={}".format(
        ma_pipeline.RUNTIME, data, steps))
    rep.ok("机器识别", "{}(地标 {})".format(
        "ma_server" if ma_pipeline.ON_MA_SERVER else "非 ma_server",
        ma_pipeline._MA_SERVER_MARK))
    for m in ma_pipeline.ENV_FATAL:
        rep.fail("环境体检", m)
    for m in ma_pipeline.ENV_WARN:
        rep.warn("环境体检", m)
    if not ma_pipeline.ENV_FATAL and not ma_pipeline.ENV_WARN:
        rep.ok("环境体检", "check_env() 无异常")
    if ma_pipeline.ALLOW_BAD_ENV:
        rep.warn("MA_ALLOW_BAD_ENV", "=1,致命问题会被放行 —— 只在明确知道自己在干什么时用")
    return ma_pipeline


def check_auth(rep):
    """门禁口令。这一项是整个体检里最要紧的一条,原因见下面的注释。"""
    ma_key = os.environ.get("MA_API_KEY")
    llm_key = os.environ.get("API_KEY")

    if not ma_key:
        rep.fail("MA_API_KEY", "没设 —— 服务会**不鉴权**地对外开放 /api/ma/*",
                 "export MA_API_KEY=$(python3 -c \"import secrets;print(secrets.token_urlsafe(32))\")")
    elif len(ma_key) < 16:
        rep.warn("MA_API_KEY", "只有 {} 位,太短了".format(len(ma_key)), "换个 32 位以上的随机串")
    else:
        rep.ok("MA_API_KEY", "已设({} 位),请求需带 x-ma-api-key 头".format(len(ma_key)))

    # Claude Code CLI 的凭证就存在一个叫 API_KEY 的环境变量里,而且会被子进程继承。
    # 如果这两个值相等,等于把 LLM 的密钥当成了本服务的门禁口令 —— 任何调过一次接口的人
    # 都拿到了你的模型密钥。这不是理论风险,是"图省事直接复用"最容易犯的错。
    if ma_key and llm_key and ma_key == llm_key:
        rep.fail("口令复用", "MA_API_KEY 和环境里的 API_KEY 是同一个值 —— "
                             "那是 Claude Code CLI 的凭证,不能拿来当接口门禁",
                 "给 MA_API_KEY 换一个独立的随机串")
    elif llm_key:
        rep.ok("口令隔离", "环境里有 API_KEY(CLI 用),与 MA_API_KEY 不同值 —— 对的")

    # 反代那边同理:Prism 读的是 PRISM_API_KEY,绝不读 API_KEY。
    prism_key = os.environ.get("PRISM_API_KEY")
    if prism_key and llm_key and prism_key == llm_key:
        rep.fail("口令复用", "PRISM_API_KEY 和 API_KEY 同值", "给 Prism 换一个独立口令")


def check_claude_cli(rep, no_network=False):
    import ma_core
    binp = ma_core.CLAUDE_BIN
    path = shutil.which(binp) or (binp if os.path.exists(binp) else None)
    if not path:
        rep.fail("Claude CLI", "找不到可执行文件:{}".format(binp),
                 "export MA_CLAUDE_BIN=/usr/bin/claude")
        return
    if no_network:
        rep.ok("Claude CLI", "{}(--no-network,跳过实际调用)".format(path))
        return
    try:
        p = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as exc:
        rep.fail("Claude CLI", "起不来:{}".format(exc))
        return
    ver = (p.stdout or p.stderr or "").strip().splitlines()
    ver = ver[0] if ver else "(没输出)"
    if p.returncode == 0:
        rep.ok("Claude CLI", "{} → {}".format(path, ver))
    else:
        rep.fail("Claude CLI", "--version 退出码 {}:{}".format(p.returncode, ver))
    if not os.environ.get("ANTHROPIC_BASE_URL"):
        rep.warn("ANTHROPIC_BASE_URL", "没设。公司环境一般要走内网网关,不设可能连不上模型")


def check_skill(rep, mp):
    if mp is None:
        return
    data, steps = mp.resolve_runtime()
    if steps != "skill":
        rep.warn("marketing-audit", "当前诊断步骤是 {},不会真调 skill".format(steps))
        return
    cli = mp.MA_CLI
    if not os.path.exists(cli):
        rep.fail("marketing-audit", "cli.py 不在:{}".format(cli),
                 "export MA_SKILL_DIR=/绝对路径/marketing-audit")
        return
    try:
        p = subprocess.run([mp.SKILL_PY, cli, "--help"], capture_output=True, text=True,
                           timeout=120, cwd=os.path.dirname(cli))
        if p.returncode == 0:
            rep.ok("marketing-audit", "{} --help 正常".format(cli))
        else:
            rep.fail("marketing-audit", "cli.py --help 退出码 {}:{}".format(
                p.returncode, (p.stderr or "")[-200:]))
    except (OSError, subprocess.SubprocessError) as exc:
        rep.fail("marketing-audit", "调 cli.py 失败:{}".format(exc))

    if data == "hive":
        h = mp.HDFS_GET
        rep.ok("hdfs-data", h) if os.path.exists(h) else rep.fail(
            "hdfs-data", "取数脚本不在:{}".format(h), "export MA_HDFS_GET=/绝对路径/hdfs_get.py")


def check_dirs(rep, mp):
    if mp is None:
        return
    for label, path, need in (("发布目录", mp.PUBLIC_DIR, True),
                              ("运行目录", os.environ.get("MA_JOBS_DIR")
                               or os.path.join(BASE_DIR, "jobs"), True)):
        if not path:
            continue
        if not os.path.isdir(path):
            (rep.fail if need else rep.warn)(
                label, "不存在:{}".format(path), "mkdir -p {}".format(path))
            continue
        try:
            fd, probe = tempfile.mkstemp(dir=path, prefix=".preflight-")
            os.close(fd)
            os.unlink(probe)
        except OSError as exc:
            rep.fail(label, "存在但写不进去:{}({})".format(path, exc))
            continue
        free_gb = shutil.disk_usage(path).free / (1 << 30)
        msg = "{} 可写,剩余 {:.1f}G".format(path, free_gb)
        rep.warn(label, msg + " —— 偏少,报告和中间产物会越积越多") if free_gb < 2 \
            else rep.ok(label, msg)


def _port_busy(host, port, timeout=1.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, int(port))) == 0
    finally:
        s.close()


def check_listen(rep, no_network=False):
    import ma_core
    host, port = ma_core.HOST, ma_core.PORT
    if host not in ("127.0.0.1", "localhost", "::1"):
        rep.warn("监听地址", "{}:{} 不是回环 —— 走 Prism 反代的话不需要对外监听".format(host, port),
                 "unset MA_API_HOST(默认就是 127.0.0.1)")
    else:
        rep.ok("监听地址", "{}:{}(回环,只经 Prism 反代对外)".format(host, port))
    if ma_core.MAX_CONCURRENCY > 2:
        rep.warn("并发", "MA_MAX_CONCURRENCY={} —— 方案文档建议 Spark+LLM 并发 ≤2".format(
            ma_core.MAX_CONCURRENCY))
    else:
        rep.ok("并发", "MA_MAX_CONCURRENCY={}".format(ma_core.MAX_CONCURRENCY))
    if no_network:
        return
    if _port_busy("127.0.0.1", port):
        rep.warn("端口占用", "{} 已经有东西在听了 —— 可能是上一次没退干净".format(port),
                 "pkill -f 'ma_api_[bc].py' ; sleep 1")
    else:
        rep.ok("端口占用", "{} 空闲".format(port))


def check_prism_proxy(rep, no_network=False):
    """Prism 那头的反代到底挂没挂上 —— 这个能从返回码上直接看出来。

      404          反代没挂载(PRISM_MA_API_TARGET 没配,或者配了但 Prism 没重启)
      502/E_MA_UNREACHABLE  反代挂上了,只是后面的诊断服务还没起 —— 这在体检阶段是**正常**的
      200          两头都通了
    """
    import ma_core
    # 注意这一段在 --no-network 下也要跑:它读的全是环境变量,一个包都不发。
    # 早先这里跟着探测一起被 no_network 提前 return 掉了 —— 而 --no-network 恰恰是
    # 上了没有出网的机器才会用的模式,把唯一一条纯配置检查在那种时候关掉,正好关反了。
    target = (os.environ.get("PRISM_MA_API_TARGET") or "").strip()
    if not target:
        rep.warn("反代目标", "这个 shell 里没有 PRISM_MA_API_TARGET —— "
                             "注意它要配在**启动 Prism 的那个 shell** 里,不是这里",
                 "起 Prism 前:export PRISM_MA_API_TARGET=127.0.0.1:{}".format(ma_core.PORT))
    else:
        up = _parse_target(target)
        if not up["ok"]:
            # 这里是 ✗ 不是 ⚠:Prism 遇到解析不了/非回环的目标是**整条反代都不挂载**,
            # 表现为 /api/ma/* 一律 404。不是"配得不太好",是这个接口对外根本不存在。
            hint = {"not_loopback": "只认回环地址。反代要是能转到任意主机,"
                                    "Prism 就成了现成的 SSRF 跳板",
                    "protocol_not_http": "只认 http://",
                    "bad_port": "端口不在 1-65535",
                    "unparsable": "解析不了"}.get(up["reason"], up["reason"])
            rep.fail("反代目标", "PRISM_MA_API_TARGET={} 不合法({}):{} —— "
                                 "Prism 会整条反代都不挂载,/api/ma/* 一律 404".format(
                                     target, up["reason"], hint),
                     "export PRISM_MA_API_TARGET=127.0.0.1:{}".format(ma_core.PORT))
        elif os.environ.get("PRISM_MA_API_AUTOSTART"):
            # 开了自启就没有"两边端口对不对得上"这回事:子进程的 MA_API_PORT 是 Prism
            # 从 TARGET 反推后强行注入的,本 shell 里的 MA_API_PORT 根本不参与。
            # 这时候再按本进程解析出的 PORT 去比,只会指挥人把 TARGET 改成一个用不上的值。
            rep.ok("反代目标", "PRISM_MA_API_TARGET={}(已开自启,子进程监听由它反推,"
                               "与本 shell 的 MA_API_PORT={} 无关)".format(target, ma_core.PORT))
        elif up["port"] != ma_core.PORT:
            # 比端口,不比字符串:http://127.0.0.1:8092 和 127.0.0.1:8092 是同一个地方,
            # 按字面比会把对的配置报成错的,然后指挥人把对的改成另一个对的。
            rep.warn("反代目标", "PRISM_MA_API_TARGET={} 指向 {} 端口,但本服务监听 {}".format(
                target, up["port"], ma_core.PORT),
                     "export PRISM_MA_API_TARGET=127.0.0.1:{}".format(ma_core.PORT))
        else:
            rep.ok("反代目标", "PRISM_MA_API_TARGET={} 与本服务端口一致".format(target))

    if no_network:
        return

    prism_port = int(os.environ.get("PRISM_PORT") or 8080)
    if not _port_busy("127.0.0.1", prism_port):
        rep.warn("Prism", "{} 端口没在听 —— Prism 没起,反代自然也不通".format(prism_port))
        return
    import urllib.error
    import urllib.request
    url = "http://127.0.0.1:{}/api/ma/healthz".format(prism_port)
    try:
        with urllib.request.urlopen(url, timeout=5) as r:      # noqa: S310 只连本机回环
            rep.ok("Prism 反代", "{} → {} 通了".format(url, r.status))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:200]
        except Exception:                                      # noqa: BLE001
            pass
        if e.code == 404:
            rep.fail("Prism 反代", "{} 返回 404 —— 反代没挂载".format(url),
                     "起 Prism 的 shell 里 export PRISM_MA_API_TARGET=127.0.0.1:{},再重启 Prism"
                     .format(int(os.environ.get("MA_API_PORT") or 8092)))
        elif e.code == 502:
            rep.ok("Prism 反代", "已挂载(502 E_MA_UNREACHABLE = 诊断服务还没起,现在这样是对的)")
        else:
            rep.warn("Prism 反代", "{} 返回 {}:{}".format(url, e.code, body))
    except (urllib.error.URLError, OSError) as exc:
        rep.warn("Prism 反代", "连不上 {}:{}".format(url, exc))


_LOOPBACK = ("127.0.0.1", "localhost", "::1", "[::1]")


def _parse_target(raw):
    """解析 PRISM_MA_API_TARGET。规则照抄 Prism 侧 ma-proxy.js 的 parseUpstream()。

    两边必须是同一套规则,否则体检说"没问题"、Prism 说"不挂载",最难查的就是这种。
    """
    text = (raw or "").strip()
    if not text:
        return {"ok": False, "reason": "empty"}
    import re
    import urllib.parse
    with_scheme = text if re.match(r"^[a-z][a-z0-9+.\-]*://", text, re.I) else "http://" + text
    try:
        u = urllib.parse.urlsplit(with_scheme)
        hostname, port = u.hostname, u.port
    except ValueError:
        return {"ok": False, "reason": "unparsable"}
    if u.scheme.lower() != "http":
        return {"ok": False, "reason": "protocol_not_http"}
    if not hostname or hostname.lower() not in _LOOPBACK:
        return {"ok": False, "reason": "not_loopback"}
    port = port or 80
    if not (1 <= port <= 65535):
        return {"ok": False, "reason": "bad_port"}
    return {"ok": True, "host": hostname.lower(), "port": port,
            "label": "{}:{}".format(hostname.lower(), port)}


def check_prism_autostart(rep, no_network=False):
    """Prism 自启:配了 PRISM_MA_API_AUTOSTART,起 Prism 就顺带把本服务拉起来。

    这一项做的事很朴素 —— 把 Prism 侧那串"拒绝自启"的判断在这儿先跑一遍。
    宁可在体检里读到"会被拒,原因是 no_key",也别等 Prism 起来之后再去日志里翻。
    判断顺序和 ma-service.js 的 planAutostart() 完全一致,而且**只报第一条**:
    它就是这么早退的,一次修一条,修完再跑一遍,比一口气列五条更省事。
    """
    raw = (os.environ.get("PRISM_MA_API_AUTOSTART") or "").strip()
    target = (os.environ.get("PRISM_MA_API_TARGET") or "").strip()

    if not raw:
        # 不配是默认,也是完全正常的用法(手工起服务)。所以这里是 ✓ 不是 ⚠ ——
        # 把"你没开可选功能"报成警告,只会训练人忽略警告。
        rep.ok("Prism 自启", "没配 PRISM_MA_API_AUTOSTART = 手工起服务(本脚本/run_ma_server.sh 走的就是这条)",
               "想让 Prism 起的时候顺带拉起本服务,在**起 Prism 的那个 shell** 里:"
               "export PRISM_MA_API_AUTOSTART={}/ma_api_c.py".format(BASE_DIR))
        return

    # 1. 没有 TARGET 就没有监听地址 —— 子进程听哪个端口是从 TARGET 反推的。
    if not target:
        rep.fail("Prism 自启", "配了 PRISM_MA_API_AUTOSTART 却没配 PRISM_MA_API_TARGET,"
                               "Prism 会拒绝自启(no_target)。子进程的 MA_API_PORT 就是从 "
                               "TARGET 反推出来的,没有它不知道让服务听哪儿",
                 "export PRISM_MA_API_TARGET=127.0.0.1:8092")
        return
    up = _parse_target(target)
    if not up["ok"]:
        hint = {"not_loopback": "只认回环地址。反代要是能转到任意主机,Prism 就成了现成的 SSRF 跳板",
                "protocol_not_http": "只认 http://",
                "bad_port": "端口不在 1-65535",
                "unparsable": "解析不了"}.get(up["reason"], up["reason"])
        rep.fail("Prism 自启", "PRISM_MA_API_TARGET={} 不合法({}):{}".format(
            target, up["reason"], hint), "export PRISM_MA_API_TARGET=127.0.0.1:8092")
        return

    # 2. 路径。必须绝对 —— Prism 的工作目录不一定是你以为的那个。
    if not os.path.isabs(raw):
        rep.fail("Prism 自启", "PRISM_MA_API_AUTOSTART={} 不是绝对路径,Prism 会拒绝自启"
                               "(not_absolute)".format(raw),
                 "export PRISM_MA_API_AUTOSTART={}/ma_api_c.py".format(BASE_DIR))
        return
    if not os.path.exists(raw):
        rep.fail("Prism 自启", "PRISM_MA_API_AUTOSTART 指的文件不存在:{}".format(raw),
                 "确认路径,或 export PRISM_MA_API_AUTOSTART={}/ma_api_c.py".format(BASE_DIR))
        return

    # 3. 门禁口令。自启 = 这个接口挂在 8080 底下,而 8080 是网关唯一转发的端口。
    ma_key = (os.environ.get("MA_API_KEY") or "").strip()
    allow_no_key = (os.environ.get("PRISM_MA_API_ALLOW_NO_KEY") or "").strip() == "1"
    if not ma_key and not allow_no_key:
        rep.fail("Prism 自启", "没设 MA_API_KEY,Prism 会拒绝自启(no_key)—— "
                               "注意这是**不起**,不是起了之后警告一声",
                 "export MA_API_KEY=$(python3 -c \"import secrets;print(secrets.token_urlsafe(32))\")"
                 " ;真要裸跑(本机调试)才用 PRISM_MA_API_ALLOW_NO_KEY=1")
        return
    llm_key = (os.environ.get("API_KEY") or "").strip()
    if ma_key and llm_key and ma_key == llm_key:
        rep.fail("Prism 自启", "MA_API_KEY 与 API_KEY 同值,Prism 会拒绝自启(key_reuse)",
                 "给 MA_API_KEY 换一个独立随机串")
        return

    if not ma_key and allow_no_key:
        rep.warn("Prism 自启", "PRISM_MA_API_ALLOW_NO_KEY=1 —— 会起,但接口**不鉴权**。"
                               "在 ma_server 上这条路径是经网关对外的,别这么放着")

    # 4. 会起。剩下的是两个真会咬人的细节。
    py = (os.environ.get("PRISM_MA_API_PYTHON") or "python3").strip()
    rep.ok("Prism 自启", "会拉起 {} {}(cwd={},监听 {} —— 由 TARGET 反推,不读本 shell 的 "
                         "MA_API_PORT)".format(py, os.path.basename(raw),
                                               os.path.dirname(raw), up["label"]),
           "MA_* 那一堆变量要 export 在**起 Prism 的 shell** 里:子进程继承的是 Prism 的环境,"
           "不是这个 shell 的")

    # 拉起的是哪一份代码 —— 你在 A 目录体检,Prism 从 B 目录起服务,这事没有任何报错。
    child_dir = os.path.dirname(os.path.realpath(raw))
    if child_dir != os.path.realpath(BASE_DIR):
        rep.warn("自启代码位置", "自启拉起的是 {},而本次体检检的是 {} —— 两份代码"
                                 "不是同一份,体检结论未必适用".format(child_dir, BASE_DIR),
                 "要么改 PRISM_MA_API_AUTOSTART 指到这里,要么去那个目录再跑一遍体检")

    if no_network:
        return
    # 端口已经有人听 = Prism 会走 external 分支:不重复拉起、退出时也不收 —— 意味着
    # 真正在跑的是**上一次**留下的进程,你刚更新的代码根本没生效。
    if _port_busy("127.0.0.1", up["port"]):
        rep.warn("自启端口", "{} 已经有进程在听 —— Prism 不会重复拉起(external),"
                             "在跑的还是那个旧进程".format(up["label"]),
                 "确认是不是上次没退干净:pkill -f 'ma_api_[bc].py' ; sleep 1")


# --------------------------------------------------------------------------- 入口


def run_all(no_network=False):
    rep = Report()
    check_python(rep)
    mp = check_pipeline_import(rep)
    check_auth(rep)
    check_claude_cli(rep, no_network)
    check_skill(rep, mp)
    check_dirs(rep, mp)
    check_listen(rep, no_network)
    check_prism_proxy(rep, no_network)
    check_prism_autostart(rep, no_network)
    return rep


def main():
    ap = argparse.ArgumentParser(description="ma_server 上线前体检(只读)")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    ap.add_argument("--no-network", action="store_true", help="跳过要连端口/起进程的检查")
    ap.add_argument("--warn-ok", action="store_true", help="只有 FAIL 才算失败(默认就是这样)")
    args = ap.parse_args()

    rep = run_all(no_network=args.no_network)
    c = rep.counts()

    if args.json:
        print(json.dumps({"rows": rep.rows, "counts": c,
                          "passed": c[FAIL] == 0}, ensure_ascii=False, indent=2))
        return 0 if c[FAIL] == 0 else 1

    # 中文在终端里占两格,而 str.ljust 按码点数补 —— 直接用会歪成一片。
    width = max(_wide(r["name"]) for r in rep.rows) if rep.rows else 8
    print("=" * 78)
    print("ma_server 上线前体检")
    print("=" * 78)
    for r in rep.rows:
        print("{} {}  {}".format(_MARK[r["level"]], _pad(r["name"], width), r["detail"]))
        if r["fix"]:
            print("  {}  ↳ {}".format(" " * width, r["fix"]))
    print("-" * 78)
    print("{} 项:✓{} ⚠{} ✗{}".format(len(rep.rows), c[OK], c[WARN], c[FAIL]))
    if c[FAIL]:
        print("有 {} 项必须先解决,现在起服务等于每一单都出坏结果。".format(c[FAIL]))
    elif c[WARN]:
        print("没有致命问题。{} 条提醒确认一下是不是有意为之,就可以起服务了。".format(c[WARN]))
    else:
        print("全过。可以起服务了。")
    return 0 if c[FAIL] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
