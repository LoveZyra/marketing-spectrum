#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
营销诊断 API 模式 —— 方案 B / 方案 C 共用的底座

这一层是从冒烟版 ma_api_min.py 原样抽出来的(那份在服务器上跑过 46/46 全绿),
两个方案共用它,好处是:B 与 C 的差别被限制在"谁来编排"这一件事上,
接口路径、鉴权、入参校验、任务模型、并发闸门、出参外壳全都一模一样,
同一份 full_test.sh 指向哪个端口都能跑,对比才是干净的。

  方案 B(ma_api_b.py)—— 全程交给 Claude Code:一次 claude -p,让它自己按提示词跑完整条链路。
  方案 C(ma_api_c.py)—— 驱动器编排:取数/诊断/圈人由确定性代码做,只有润色那一步调模型。

HTTP 契约(两者完全一致;2026-07-30 收窄过一轮,见下)
  GET  /healthz                      免鉴权,探活
  GET  /api/ma/jobs                  任务列表
  GET  /api/ma/jobs/{id}             任务状态 + 日志尾巴(轮询/运维用,字段不收窄)
  GET  /api/ma/jobs/{id}/result      出参(没跑完 409 E_NOT_READY,失败 409 + 错误码)
  POST /api/ma/diagnose              下单,202 返回 job_id

对外契约(2026-07-30 定稿,只有这么多,别往回加):
  入参  activity_id(必填)/ date(选填)/ meta(选填,campaign_type 放这里面)
        —— push_source 挪到服务端环境变量,pull_partition 与 note 取消;
        多给的键 400 拒单,不静默忽略(静默会让老调用方以为字段还生效)。
  下单  202:job_id / state / activity_id / mode
  出参  200:job_id / state / activity_id / mode / report_url / rules
        rules 逐条只有 name / finding_id / sql_filter / direction / suggestion
        (suggestion 于 2026-08-07 新增:该人群的建议动作,与报告「可落地人群包」
         第三列同源;纯增字段,老调用方不受影响)。
  完整的内部账(crowd_spec 全量、push_sql、size、warnings、degraded、backend、
  polish、steps)照旧写在 jobs/<id>/meta.json,砍的是对外出参,不是审计记录。

环境变量
  MA_API_HOST          监听地址,默认 127.0.0.1(只回环,对外由反代接)
  MA_API_PORT          监听端口,默认 8091(8080 归 Prism,别抢)
  MA_API_KEY           设置后所有 /api/* 需带 x-ma-api-key 头;不设则不鉴权
  MA_CLAUDE_BIN        claude 可执行文件,默认 "claude"
  MA_CLAUDE_TIMEOUT    单次 CLI 调用超时秒数,默认 120
  MA_JOBS_DIR          任务目录,默认 ./jobs
  MA_MAX_CONCURRENCY   全局并发上限,默认 2
  MA_PUSH_SOURCE       圈人取哪路规则 model/rule/both,默认 both
                       (原入参 push_source,调用方不再能选,产品口径是"要推的都给")

⚠ 这里刻意读 MA_API_KEY,绝不读通用的 API_KEY。
   Claude Code CLI 的凭证就存在一个名叫 API_KEY 的环境变量里,而且会被子进程继承。
   如果本服务去读 API_KEY,等于把 LLM 的密钥当成了本服务的门禁口令,既会误放行也会泄露语义。
   Prism 里 PRISM_API_KEY 的处理是同一个理由,保持一致。
"""

import hmac
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def _env_int(name, default):
    raw = os.environ.get(name)
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


HOST = os.environ.get("MA_API_HOST", "127.0.0.1")
PORT = _env_int("MA_API_PORT", 8091)
API_KEY = os.environ.get("MA_API_KEY") or None
AUTH_HEADER = "x-ma-api-key"
CLAUDE_BIN = os.environ.get("MA_CLAUDE_BIN", "claude")
CLAUDE_TIMEOUT = _env_int("MA_CLAUDE_TIMEOUT", 120)
JOBS_DIR = os.environ.get("MA_JOBS_DIR") or os.path.join(BASE_DIR, "jobs")
MAX_CONCURRENCY = _env_int("MA_MAX_CONCURRENCY", 2)
MAX_BODY = 64 * 1024

ACTIVITY_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
JOB_RE = re.compile(r"^job_[0-9]{8}_[0-9]{6}_[0-9a-f]{6}$")
PART_RE = re.compile(r"^[A-Za-z0-9_]{1,32}=[A-Za-z0-9_\-]{1,64}$")
PUSH_SOURCES = ("model", "rule", "both")


def now_iso():
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(msg):
    sys.stderr.write("[{}] {}\n".format(now_iso(), msg))
    sys.stderr.flush()


def _env_push_source():
    """push_source 从入参挪到服务端后的取值。配错了按 both 跑,但要在启动日志里吵一声,
    不能静默 —— 圈人口径悄悄变是这个项目里最忌讳的一类错。"""
    raw = (os.environ.get("MA_PUSH_SOURCE") or "both").strip().lower()
    if raw not in PUSH_SOURCES:
        log("MA_PUSH_SOURCE={!r} 不认识(只认 {}),按 both 跑".format(
            raw, "/".join(PUSH_SOURCES)))
        return "both"
    return raw


PUSH_SOURCE = _env_push_source()


class JobError(Exception):
    """带错误码的任务失败。code 会原样出现在接口的 error.code 里。"""

    def __init__(self, code, message, detail=None):
        Exception.__init__(self, message)
        self.code = code
        self.message = message
        self.detail = detail


# --------------------------------------------------------------------------- 任务存储
# 用文件存,不用内存 dict:进程重启后任务还在,而且能直接 cat 出来排查。
# 与 私域平台诊断/ 下 runs/<aid>/run.log 的习惯保持一致。


class JobStore(object):
    def __init__(self, root):
        self.root = root
        self._lock = threading.Lock()
        os.makedirs(self.root, exist_ok=True)

    def _dir(self, job_id):
        return os.path.join(self.root, job_id)

    def _meta_path(self, job_id):
        return os.path.join(self._dir(job_id), "meta.json")

    def rundir(self, job_id):
        p = os.path.join(self._dir(job_id), "run")
        os.makedirs(p, exist_ok=True)
        return p

    def new_id(self):
        return "job_{}_{}".format(
            datetime.now().strftime("%Y%m%d_%H%M%S"), uuid.uuid4().hex[:6])

    def create(self, params):
        job_id = self.new_id()
        os.makedirs(self._dir(job_id), exist_ok=True)
        meta = {
            "job_id": job_id,
            "state": "queued",
            "phase": None,
            "params": params,
            "created_at": now_iso(),
            "updated_at": now_iso(),
            "finished_at": None,
            "error": None,
            "result": None,
            "warnings": [],
        }
        self._write(job_id, meta)
        return meta

    def _write(self, job_id, meta):
        path = self._meta_path(job_id)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def get(self, job_id):
        if not JOB_RE.match(job_id or ""):
            return None
        try:
            with open(self._meta_path(job_id), "r", encoding="utf-8") as f:
                return json.load(f)
        except (IOError, OSError, ValueError):
            return None

    def update(self, job_id, **fields):
        with self._lock:
            meta = self.get(job_id)
            if meta is None:
                return None
            meta.update(fields)
            meta["updated_at"] = now_iso()
            self._write(job_id, meta)
            return meta

    def append_log(self, job_id, text):
        path = os.path.join(self._dir(job_id), "run.log")
        with open(path, "a", encoding="utf-8") as f:
            f.write("[{}] {}\n".format(now_iso(), text))

    def log_tail(self, job_id, lines=40):
        path = os.path.join(self._dir(job_id), "run.log")
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return f.read().splitlines()[-lines:]
        except (IOError, OSError):
            return []

    def list_ids(self, limit=50):
        try:
            names = [n for n in os.listdir(self.root) if JOB_RE.match(n)]
        except (IOError, OSError):
            return []
        names.sort(reverse=True)
        return names[:limit]


STORE = JobStore(JOBS_DIR)

# --------------------------------------------------------------------------- 并发闸门
# 两道闸,职责不同:
#   同活动在飞守卫 —— 拒单(409),因为同一活动跑两遍没有意义,还会互相覆盖产物
#   全局信号量     —— 只压 worker 的并发执行,不拒单。下单永远收下,排队慢慢跑。

_SEM = threading.Semaphore(MAX_CONCURRENCY)
_INFLIGHT = set()
_INFLIGHT_LOCK = threading.Lock()


def try_claim(activity_id):
    with _INFLIGHT_LOCK:
        if activity_id in _INFLIGHT:
            return False
        _INFLIGHT.add(activity_id)
        return True


def release(activity_id):
    with _INFLIGHT_LOCK:
        _INFLIGHT.discard(activity_id)


# --------------------------------------------------------------------------- CLI 调用


def call_claude(argv, timeout, cwd=None):
    """调起 Claude Code CLI。argv 形式,不过 shell,不拼字符串。

    刻意不传 --allow-dangerously-skip-permissions:方案文档的示例代码里带了这个参数,
    但这是一台有数据访问能力的机器,给模型无限制工具权限的代价太高。
    需要工具权限时用 --allowedTools 精确点名,而不是一把全开。

    用 Popen + start_new_session 而不是 subprocess.run,超时杀**整个进程组**:
    agent 带 Bash 工具,可能拉起继承了 stdout/stderr 管道的孙进程。subprocess.run
    超时只杀 claude 本身,然后在 communicate() 里等管道 EOF —— 孙进程不退,
    worker 线程就永远卡死,全局并发额度和该活动的在飞锁一起漏,后续同活动请求
    全部 409 直到重启(356352 复盘挂账的隐患)。killpg 全组之后收尾最多再等 10s,
    收不齐宁可丢部分输出也不卡线程。
    """
    started = time.time()

    def _done(exit_code, out, err, timed_out):
        return {"argv": argv, "exit_code": exit_code,
                "stdout": (out or "")[-20000:], "stderr": (err or "")[-4000:],
                "elapsed_sec": round(time.time() - started, 2), "timed_out": timed_out}

    try:
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, cwd=cwd, env=os.environ.copy(),
                                start_new_session=True)
    except (OSError, ValueError) as exc:
        return _done(None, "", "{}: {}".format(type(exc).__name__, exc), False)
    try:
        out, err = proc.communicate(timeout=timeout)
        return _done(proc.returncode, out, err, False)
    except subprocess.TimeoutExpired:
        # 杀进程组;万一组没建起来(极端环境),退回只杀直接子进程
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            proc.kill()
        try:
            out, err = proc.communicate(timeout=10)
        except (subprocess.TimeoutExpired, ValueError, OSError):
            out, err = "", ""          # 管道还被谁占着 —— 不等了,线程比输出金贵
        # 被杀前已经写出来的部分输出不能丢(356352 教训:三轮润色全是 stdout=0 字,
        # 分不清"没吐"还是"吐了被丢")
        return _done(None, out,
                     ((err or "")[-3500:] + "\ntimeout after {}s".format(timeout)).strip(),
                     True)
    except (OSError, ValueError) as exc:
        return {"argv": argv, "exit_code": None, "stdout": "",
                "stderr": "{}: {}".format(type(exc).__name__, exc),
                "elapsed_sec": round(time.time() - started, 2), "timed_out": False}


_FENCE_RE = re.compile(r"```[A-Za-z0-9_+-]*[ \t]*\r?\n(.*?)```", re.S)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def _balanced_spans(text, limit=6):
    """按 JSON 的字符串字面量规则扫括号,返回若干个配平的 {...} 片段。

    老版本只数 { 和 } 不认字符串:文案里出现一个花括号就把深度带偏,
    整段 JSON 从此再也配不平,最后静悄悄返回 None。这里进了字符串就不再计数,
    并且认 \\ 转义。
    """
    spans = []
    n = len(text)
    i = text.find("{")
    while i != -1 and len(spans) < limit:
        depth = 0
        in_str = False
        esc = False
        end = -1
        for j in range(i, n):
            ch = text[j]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = j
                    break
        if end == -1:
            break  # 这个 { 之后再也配不平了,后面的更不可能,不用继续找
        spans.append(text[i:end + 1])
        i = text.find("{", i + 1)
    return spans


def _repair_json(s):
    """补模型最常犯的两种毛病:尾逗号、字符串里的裸换行/制表符。"""
    s = _TRAILING_COMMA_RE.sub(r"\1", s)
    out = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            elif ch == "\n":
                out.append("\\n")
                continue
            elif ch == "\r":
                out.append("\\r")
                continue
            elif ch == "\t":
                out.append("\\t")
                continue
        elif ch == '"':
            in_str = True
        out.append(ch)
    return "".join(out)


def _close_truncated(text):
    """输出被截断时,把最后一条没写完的丢掉,再把括号补齐。

    截断是长回答的常态失败,而已经写完的那些条目其实是好的 —— 整段判废太亏。
    """
    i = text.find("{")
    if i == -1:
        return None
    s = text[i:]
    stack = []
    in_str = False
    esc = False
    last_safe = -1  # 最近一个"顶层之下、刚写完一条"的位置
    for j, ch in enumerate(s):
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
        elif ch == "," and stack:
            last_safe = j
    if not stack:
        return None  # 没被截断,轮不到这条路
    if in_str or last_safe == -1:
        if last_safe == -1:
            return None
        s = s[:last_safe]
    else:
        s = s[:last_safe]
    # 重新数一遍余下部分该补哪些右括号
    stack = []
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
        elif ch == '"':
            in_str = True
        elif ch in "{[":
            stack.append(ch)
        elif ch in "}]":
            if stack:
                stack.pop()
    return s + "".join("}" if c == "{" else "]" for c in reversed(stack))


def _json_candidates(text):
    """先看代码块里的内容,再看整段 —— 模型十有八九会套 ```json。"""
    seen = set()
    for m in _FENCE_RE.finditer(text):
        blk = m.group(1).strip()
        if blk and blk not in seen:
            seen.add(blk)
            yield blk
    if text not in seen:
        yield text


def extract_json(text):
    """从 CLI 输出里抠出第一个 JSON 对象。抠不到就返回 None,不抛。

    三层:原样解析 → 小修(尾逗号/裸换行)后解析 → 按截断处理补齐括号再解析。
    """
    if not text:
        return None
    for chunk in _json_candidates(text):
        for span in _balanced_spans(chunk):
            for cand in (span, _repair_json(span)):
                try:
                    obj = json.loads(cand)
                except ValueError:
                    continue
                if isinstance(obj, (dict, list)):
                    return obj
        cut = _close_truncated(chunk)
        if cut:
            for cand in (cut, _repair_json(cut)):
                try:
                    obj = json.loads(cand)
                except ValueError:
                    continue
                if isinstance(obj, (dict, list)):
                    return obj
    return None


# CLI 起得来、参数传得进、输出收得到,但模型这一段没凭证 —— 这属于"链路通、鉴权缺",
# 和"CLI 根本调不动"是两回事,必须分开判,否则一个没登录就把接口链路也判死了。
AUTH_HINTS = (
    "not logged in",
    "please run /login",
    "invalid api key",
    "authentication_error",
    "oauth token has expired",
    "credit balance is too low",
    "unauthorized",
)


def looks_like_auth_problem(call):
    """认出"没鉴权"这一类失败,返回命中的关键词;不是鉴权问题就返回 None。"""
    blob = ((call.get("stdout") or "") + "\n" + (call.get("stderr") or "")).lower()
    for hint in AUTH_HINTS:
        if hint in blob:
            return hint
    return None


def probe_cli(job_id):
    """跑一次 claude --version。版本号进出参,调不动就直接判死这一单。"""
    probe = call_claude([CLAUDE_BIN, "--version"], 30)
    STORE.append_log(job_id, "claude --version -> exit={} out={!r}".format(
        probe["exit_code"], (probe["stdout"] or "").strip()[:120]))
    if probe["exit_code"] != 0:
        raise JobError("E_CLI_NOT_AVAILABLE", "调不起 Claude Code CLI", probe)
    return (probe["stdout"] or "").strip()


# --------------------------------------------------------------------------- worker 外壳


def _run_job(job_id, runner):
    """worker 线程的统一外壳:并发闸、状态机、异常兜底都在这儿,两个方案不用各写一遍。"""
    meta = STORE.get(job_id)
    params = meta["params"]
    activity_id = params["activity_id"]
    t0 = time.time()
    try:
        _SEM.acquire()
        STORE.update(job_id, state="running", phase="start")
        STORE.append_log(job_id, "任务开始 activity_id={} push_source={}".format(
            activity_id, params.get("push_source")))

        result = runner(job_id, params)

        warnings = result.pop("warnings", []) if isinstance(result, dict) else []
        result["job_id"] = job_id
        result["elapsed_sec"] = round(time.time() - t0, 2)
        STORE.update(job_id, state="done", phase="done", finished_at=now_iso(),
                     degraded=bool(result.get("degraded")), result=result, warnings=warnings)
        STORE.append_log(job_id, "任务完成 耗时 {}s{}".format(
            result["elapsed_sec"], "(降级)" if result.get("degraded") else ""))
    except JobError as exc:
        STORE.append_log(job_id, "失败 {}: {}".format(exc.code, exc.message))
        STORE.update(job_id, state="error", finished_at=now_iso(),
                     error={"code": exc.code, "message": exc.message, "detail": exc.detail})
    except Exception as exc:  # noqa: BLE001 —— 兜底,worker 线程不能把异常吞掉
        import traceback
        STORE.append_log(job_id, "未捕获异常: {}: {}".format(type(exc).__name__, exc))
        STORE.append_log(job_id, traceback.format_exc()[-2000:])
        STORE.update(job_id, state="error", finished_at=now_iso(),
                     error={"code": "E_INTERNAL",
                            "message": "{}: {}".format(type(exc).__name__, exc)})
    finally:
        _SEM.release()
        release(activity_id)


# --------------------------------------------------------------------------- 入参校验


def parse_params(data):
    """返回 (params, err_code, err_message)。

    2026-07-30 契约收窄:入参只收 activity_id / date / meta 三个键,
    campaign_type 挪进 meta;push_source 变成服务端配置(MA_PUSH_SOURCE);
    pull_partition 和 note 取消(特征表按约定是固定表、无分区,没有分区可传;
    本接口对表只读不写)。
    多给的键一律 400 拒单 —— 静默忽略的话,老调用方会以为 push_source 还生效着,
    圈出来的人悄悄变了没人知道,那比报错难查得多。
    params 的内部形状保持原样(键一个不少),流水线和方案 B 一行都不用改。
    """
    unknown = sorted(k for k in data if k not in ("activity_id", "date", "meta"))
    if unknown:
        return None, "E_BAD_PARAM", (
            "入参只收 activity_id / date / meta,不认识:{}。"
            "campaign_type 请放进 meta 里;push_source 已改为服务端配置"
            "(MA_PUSH_SOURCE);pull_partition 和 note 已取消".format(
                ", ".join(unknown[:8])))

    activity_id = str(data.get("activity_id") or "").strip()
    if not ACTIVITY_RE.match(activity_id):
        return None, "E_BAD_ACTIVITY_ID", "activity_id 必填,且只允许字母数字下划线连字符,长度 1-64"

    date = data.get("date")
    if date is not None and not DATE_RE.match(str(date)):
        return None, "E_BAD_DATE", "date 格式必须是 YYYY-MM-DD"

    meta = data.get("meta")
    if meta is not None and not isinstance(meta, dict):
        return None, "E_BAD_META", "meta 必须是 JSON 对象(campaign_type 也放在这里面)"

    campaign_type = None
    if meta:
        campaign_type = str(meta.get("campaign_type") or "")[:64] or None

    return {
        "activity_id": activity_id,
        "date": str(date) if date else None,
        "push_source": PUSH_SOURCE,   # 服务端定,不再来自入参
        "meta": json.dumps(meta, ensure_ascii=False) if meta else None,
        "campaign_type": campaign_type,          # 提自 meta.campaign_type,给流水线/Agent 提示词用
        "note": None,                            # 字段已取消;保键是为了下游不用改
    }, None, None


# --------------------------------------------------------------------------- HTTP


# ── /result 的公开契约投影 ──────────────────────────────────────────────
# 抽成模块级函数是为了能离线回归 —— 这段逻辑此前埋在 handler 里,
# 加字段全靠人眼盯,fix18.1 的 suggestion 就没有任何用例守着。
PUBLIC_RULE_KEYS = ("name", "finding_id", "sql_filter", "filter_zh", "direction", "suggestion")


def public_rules(spec):
    """crowd_spec.rules[] → 对外只给六个字段,顺序固定。

    白名单而不是黑名单:skill 侧随时可能新增内部键(pandas_filter、_signal_type、
    suggestion_source、direction_fixed…),它们一律留在 meta.json,不进公开契约。
    """
    out = []
    for r in (spec or {}).get("rules") or []:
        if not isinstance(r, dict):
            continue
        out.append({"name": r.get("name"),
                    "finding_id": r.get("finding_id"),
                    "sql_filter": r.get("sql_filter"),
                    # 中文口径:给运营看的,翻不动是空串。**执行仍以 sql_filter 为准**
                    "filter_zh": r.get("filter_zh") or "",
                    "direction": r.get("direction"),
                    "suggestion": r.get("suggestion")})
    return out


def make_handler(mode, runner, extra_health=None):
    class Handler(BaseHTTPRequestHandler):
        server_version = "MaDiagnoseAPI/1.0-{}".format(mode)
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log("{} {}".format(self.address_string(), fmt % args))

        # 一次最多帮客户端"吃掉"多少没读的请求体。超过就不吃了,改成关连接。
        _MAX_DRAIN = 1 << 20

        def handle_one_request(self):
            """每个请求开工前把"请求体已消费"的标记清掉。

            这一行看着多余,少了它 _drain_body 就是个摆设:BaseHTTPRequestHandler 是
            **一个连接 new 一个 Handler 实例**,然后在 handle() 里循环 handle_one_request()
            处理这条连接上的所有请求 —— self 是跨请求共用的。所以第一个请求把
            _body_done 置 True 之后,同一条长连接上后面每个请求的 _drain_body 都直接
            return,残留字节照样堆在 socket 里,desync 原样复发。

            症状还特别具有迷惑性:前两个请求(401/401)看着好好的,第三个才炸,
            因为炸的是"上一个请求留下的残渣",跟当前请求本身没关系。
            """
            self._body_done = False
            return BaseHTTPRequestHandler.handle_one_request(self)

        def _drain_body(self):
            """把还没读的请求体消费掉,消费不了就把连接关了。

            protocol_version = HTTP/1.1 意味着默认长连接。如果某个分支(401/400/413/404)
            在**没读请求体**的情况下就把响应发了,那些字节会原封不动留在 socket 里,
            下一个请求就从这堆残渣开始解析 —— 表现是莫名其妙的
            `Unsupported method ('{"activity_id":"..."}POST')`,而且报错落在**下一个**
            请求头上,跟真正的肇事者隔了一整个请求,极难查。

            用 requests.Session()、curl 复用连接、或者走反向代理时都会踩到。
            HTTP 只给了两个正当收场:要么读完,要么关连接。这里两条都实现。
            """
            if getattr(self, "_body_done", False):
                return
            self._body_done = True
            if (self.headers.get("Transfer-Encoding") or "").strip():
                self.close_connection = True      # chunked:长度不可信,不猜
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                self.close_connection = True      # 长度都读不出来,更不能猜
                return
            if length <= 0:
                return
            if length > self._MAX_DRAIN:
                self.close_connection = True      # 太大,吃不划算
                return
            try:
                left = length
                while left > 0:
                    chunk = self.rfile.read(min(left, 65536))
                    if not chunk:                 # 客户端半路跑了,剩下的对不上
                        self.close_connection = True
                        return
                    left -= len(chunk)
            except OSError:
                self.close_connection = True

        def _send(self, code, payload):
            # 先清干净再回话。放在这里而不是各个分支里,是因为漏一个分支就等于留一个雷,
            # 而所有响应最后都会走到 _send。
            self._drain_body()
            body = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _err(self, code, err_code, message, **extra):
            self._send(code, {"error": dict({"code": err_code, "message": message}, **extra)})

        def _authed(self):
            if not API_KEY:
                return True
            # 必须用 bytes 比较:str 版 compare_digest 撞上任何非 ASCII 字符会直接抛
            # TypeError,把连接炸成 ECONNRESET(2026-07-30 线上事故:口令文件里被抄进了
            # 中文占位符「你的口令」,每个带鉴权的请求全灭,healthz 却是好的,极具迷惑性)。
            # bytes 比较永不抛 —— 口令或请求头再奇怪,顶多不相等,干净地 401 收场。
            got = self.headers.get(AUTH_HEADER) or ""
            try:
                return hmac.compare_digest(got.encode("utf-8", "surrogateescape"),
                                           API_KEY.encode("utf-8", "surrogateescape"))
            except Exception:                                      # noqa: BLE001
                return False

        def _read_json(self):
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return None, "Content-Length 不合法"
            if length <= 0:
                return None, "请求体为空"
            if length > MAX_BODY:
                return None, "请求体过大(上限 {} 字节)".format(MAX_BODY)
            raw = self.rfile.read(length)
            self._body_done = True                # 读完了,_drain_body 不用再动手
            if len(raw) != length:                # 短读:剩下的字节位置对不上,只能关连接
                self.close_connection = True
                return None, "请求体不完整(声明 {} 字节,实收 {})".format(length, len(raw))
            try:
                data = json.loads(raw.decode("utf-8"))
            except (ValueError, UnicodeDecodeError) as exc:
                return None, "JSON 解析失败: {}".format(exc)
            if not isinstance(data, dict):
                return None, "请求体必须是 JSON 对象"
            return data, None

        # ---- 路由 ----

        def do_GET(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"

            if path == "/healthz":
                payload = {"ok": True, "service": "ma-diagnose-api", "mode": mode,
                           "auth": bool(API_KEY), "claude_bin": CLAUDE_BIN,
                           "max_concurrency": MAX_CONCURRENCY, "time": now_iso()}
                if extra_health:
                    payload.update(extra_health())
                self._send(200, payload)
                return

            if not path.startswith("/api/"):
                self._err(404, "E_NOT_FOUND", "没有这个路径")
                return
            if not self._authed():
                self._err(401, "E_UNAUTHORIZED", "缺少或错误的 {} 头".format(AUTH_HEADER))
                return

            if path == "/api/ma/jobs":
                items = []
                for jid in STORE.list_ids():
                    m = STORE.get(jid)
                    if m:
                        items.append({"job_id": m["job_id"], "state": m["state"],
                                      "phase": m.get("phase"),
                                      "activity_id": m["params"].get("activity_id"),
                                      "created_at": m["created_at"]})
                self._send(200, {"jobs": items, "count": len(items)})
                return

            m = re.match(r"^/api/ma/jobs/([^/]+)$", path)
            if m:
                meta = STORE.get(m.group(1))
                if meta is None:
                    self._err(404, "E_JOB_NOT_FOUND", "没有这个任务")
                    return
                self._send(200, {
                    "job_id": meta["job_id"], "state": meta["state"], "phase": meta.get("phase"),
                    "activity_id": meta["params"].get("activity_id"),
                    "created_at": meta["created_at"], "updated_at": meta["updated_at"],
                    "finished_at": meta.get("finished_at"), "error": meta.get("error"),
                    "warnings": meta.get("warnings", []),
                    "log_tail": STORE.log_tail(meta["job_id"], 20),
                })
                return

            m = re.match(r"^/api/ma/jobs/([^/]+)/result$", path)
            if m:
                meta = STORE.get(m.group(1))
                if meta is None:
                    self._err(404, "E_JOB_NOT_FOUND", "没有这个任务")
                    return
                if meta["state"] == "error":
                    err = meta.get("error") or {}
                    self._err(409, err.get("code", "E_FAILED"), err.get("message", "任务失败"),
                              detail=err.get("detail"))
                    return
                if meta["state"] != "done":
                    self._err(409, "E_NOT_READY", "任务还没跑完,当前状态 {}".format(meta["state"]),
                              state=meta["state"], phase=meta.get("phase"))
                    return
                # 2026-07-30 契约收窄:/result 只给六个字段,rules 逐条只给四个
                # (后续 08-07 加 suggestion、08-12 加 filter_zh,现为六个)。
                # degraded / warnings / size / push_sql / notes 这些内部账没有丢 ——
                # 全在 jobs/<id>/meta.json 里,轮询接口 /api/ma/jobs/{id} 也照报 warnings。
                result = meta.get("result") or {}
                spec = result.get("crowd_spec") or {}
                # 2026-08-07 加第五个字段 suggestion(该人群的建议动作,与报告
                # 「可落地人群包」第三列同源)。这里是**唯一**对外出口,不加这一行的话
                # ma_pipeline 回填的 suggestion 只躺在 meta.json 里,调用方永远看不到。
                # suggestion_source(index/sql/name/default)是排查用的内部账,
                # 留在 meta.json 的 crowd_spec 里,不进这份收窄过的公开契约。
                # 2026-08-12 加第六个字段 filter_zh(该人群筛选条件的中文口径,与报告
                # 附录「筛选条件（中文）」同源,由 skill 侧 crowd_translator 产出)。
                # 只是把 sql_filter 讲成人话给运营看 —— **执行仍以 sql_filter 为准**,
                # 中文不保证可解析、翻不动时是空串,下游不要拿它做任何判断。
                # 同样只加在这份收窄过的公开契约里;skill 侧还带 pandas_filter,
                # 那是原始 pandas 口径,属内部账,留在 meta.json。
                rules = public_rules(spec)
                self._send(200, {
                    "job_id": meta["job_id"],
                    "state": meta["state"],
                    "activity_id": meta["params"].get("activity_id"),
                    "mode": mode,
                    "report_url": result.get("report_url"),
                    "rules": rules,
                })
                return

            self._err(404, "E_NOT_FOUND", "没有这个路径")

        def do_POST(self):
            path = self.path.split("?", 1)[0].rstrip("/") or "/"
            if not self._authed():
                self._err(401, "E_UNAUTHORIZED", "缺少或错误的 {} 头".format(AUTH_HEADER))
                return
            if path != "/api/ma/diagnose":
                self._err(404, "E_NOT_FOUND", "没有这个路径")
                return

            data, err = self._read_json()
            if err:
                self._err(400, "E_BAD_REQUEST", err)
                return

            params, code, msg = parse_params(data)
            if params is None:
                self._err(400, code, msg)
                return

            if not try_claim(params["activity_id"]):
                self._err(409, "E_ACTIVITY_BUSY", "该活动已有任务在跑,同一活动不允许并发")
                return

            meta = STORE.create(params)
            threading.Thread(target=_run_job, args=(meta["job_id"], runner),
                             daemon=True).start()
            # 契约收窄:202 也只给四个字段。轮询和取结果的路径是固定的
            # (/api/ma/jobs/{job_id} 与 .../result),不再回显。
            self._send(202, {
                "job_id": meta["job_id"], "state": "queued",
                "activity_id": params["activity_id"], "mode": mode,
            })

    return Handler


def sweep_stale_jobs():
    """启动时把上一个进程留下的 queued/running 任务判成明确终态。

    worker 是内存线程,进程一死它们就永远停在 running —— 按文档轮询的调用方
    会无限收到 409 E_NOT_READY,悬案比失败难受得多。这里统一判 E_INTERRUPTED,
    让调用方拿到明确失败、重新下单。
    注意:B/C 两个服务若共用同一个 MA_JOBS_DIR 同时跑,互相重启会误伤对方
    在飞的任务 —— 那种部署要给两边配不同的任务目录。
    """
    n = 0
    for jid in STORE.list_ids(limit=1000):
        m = STORE.get(jid)
        if m and m.get("state") in ("queued", "running"):
            STORE.update(jid, state="error", finished_at=now_iso(),
                         error={"code": "E_INTERRUPTED",
                                "message": "服务重启,任务在「{}」阶段被中断;请重新下单".format(
                                    m.get("phase") or m.get("state"))})
            STORE.append_log(jid, "服务重启扫描:任务仍处 {} 态,判为 E_INTERRUPTED".format(
                m.get("state")))
            n += 1
    if n:
        log("重启扫描:{} 个残留任务已判 E_INTERRUPTED(轮询方将收到明确失败,不再无限等)".format(n))
    return n


def serve(mode, runner, extra_health=None, banner=None):
    os.makedirs(JOBS_DIR, exist_ok=True)
    sweep_stale_jobs()
    # 非 ASCII 口令 = 客户端根本带不上来的口令(HTTP 头按 latin-1 解),等于起一个
    # 谁都调不通的服务 —— 按环境闸门的老规矩,这种错拦在启动时,不留到线上变成
    # 每个请求 ECONNRESET 的悬案(2026-07-30:占位符「你的口令」被原样抄进口令文件)。
    if API_KEY and not API_KEY.isascii():
        log("✗ MA_API_KEY 含非 ASCII 字符 —— 是不是把『你的口令』这类占位符原样抄进了口令文件?")
        log("  生成真口令:openssl rand -hex 24,写进 ma-env.local.sh 再起。拒绝启动。")
        raise SystemExit(2)
    log("方案 {} 服务启动,监听 http://{}:{}".format(mode, HOST, PORT))
    log("鉴权: {}".format("开(需 {} 头)".format(AUTH_HEADER) if API_KEY else "关(未设 MA_API_KEY)"))
    log("claude 可执行文件: {} / 单次超时 {}s".format(CLAUDE_BIN, CLAUDE_TIMEOUT))
    log("任务目录: {} / 并发上限 {}".format(JOBS_DIR, MAX_CONCURRENCY))
    log("圈人口径 push_source: {}(服务端 MA_PUSH_SOURCE 定,入参已不收)".format(PUSH_SOURCE))
    for line in (banner or []):
        log(line)
    srv = ThreadingHTTPServer((HOST, PORT), make_handler(mode, runner, extra_health))
    srv.daemon_threads = True
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断,退出")
    finally:
        srv.server_close()
