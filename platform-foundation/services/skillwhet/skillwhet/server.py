"""``whet serve`` — a loopback HTTP face for the platform (Prism) to talk to.

Deliberately thin: it knows nothing about users. The platform authenticates its
own users and forwards here with a shared token; every request carries
``X-SkillWhet-Token``. Binds 127.0.0.1 only.

Phase 1 surface (skills / tasks / status). Jobs (train / eval / harvest) come in
phase 2 and plug into the same dispatcher.

stdlib ``ThreadingHTTPServer`` on purpose — the sibling ma-api service uses the
same and this repo has no web framework dependency to add.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from . import __version__ as _pkg_version
from .contract import collect_facts, load_contract
from .gates import PyramidConfig, build_fast_pyramid, run_pyramid
from .jobs import JobError, JobStore
from .imports import ImportError_, TaskStore, parse_rows, validate_and_map
from .managed import ManagedError, ManagedStore, load_record_key, validate_name
from .trainer import bootstrap

MARKER = "prism-skillwhet"          # the platform ignores transcripts whose cwd carries this
_MODULE_RE = re.compile(r"[A-Za-z_][\w.]*")


def _int_query(query: dict, key: str, default: int) -> int:
    """hl(动态 P3):`?limit=x` / `?after=abc` 原来 int() 直接 500。"""
    raw = query.get(key, [None])[0]
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except (TypeError, ValueError) as exc:
        raise HttpError(400, "BAD_QUERY", f"{key} must be an integer") from exc
MAX_BODY = 48 * 1024 * 1024  # 30 MiB upload → ~40 MiB base64 + JSON envelope


class RawResponse:
    """A non-JSON body (tar.gz export). ``dispatch`` passes it through untouched."""

    def __init__(self, data: bytes, content_type: str, filename: str) -> None:
        self.data, self.content_type, self.filename = data, content_type, filename


class HttpError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra):
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def setup_tmpdir(home: Path) -> Path:
    """Every temp dir this process (and its children) makes lands under the home,
    under a path that carries the platform's internal marker."""
    tmp = home / "tmp" / MARKER
    tmp.mkdir(parents=True, exist_ok=True)
    for k in ("TMPDIR", "TEMP", "TMP"):
        os.environ[k] = str(tmp)
    import tempfile
    tempfile.tempdir = str(tmp)
    return tmp


def tool_status() -> dict:
    from .gates.base import tool_available
    from .sandbox import network_isolation_available
    return {
        # hl(复核 P2-4):与门里的调用方式一致(`python -m` 优先,其次 PATH)
        "ruff": tool_available("ruff"),
        "bandit": tool_available("bandit"),
        "pyright": tool_available("pyright"),
        "pytest": tool_available("pytest"),
        "unshare": network_isolation_available(),
        "claude_cli": shutil.which("claude") is not None,
    }


class App:
    """Route table + handlers. One instance per server; handlers are thread-safe
    at the granularity of a per-skill lock."""

    def __init__(self, home: Path, token: str) -> None:
        self.home = Path(home)
        self.token = token
        self.started_at = time.time()
        self.started_at_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        # hl(复核 P2-3):权威记录签名。密钥放 home/records/.key(跨重启稳定,与口令无关 —— Prism 没配口令时
        # 每次启动都随机生成一个,拿口令派生会让重启后所有记录验签失败)。密钥是新建的就把已有记录重签。
        record_key, fresh = load_record_key(self.home)
        self.store = ManagedStore(self.home, key=record_key, rekey=fresh)
        if getattr(self.store, "rekeyed", None):
            print(f"[serve] 记录签名密钥是新建的,已按权威记录重签 {len(self.store.rekeyed)} 份: "
                  f"{', '.join(self.store.rekeyed[:10])}", file=sys.stderr, flush=True)
        self.tasks = TaskStore(self.home)
        self._locks: dict[str, threading.Lock] = {}
        self._locks_guard = threading.Lock()
        self._gate_inflight: dict[str, tuple[threading.Event, dict]] = {}   # hl(动态 P3):同 skill 并发体检合并
        (self.home / "jobs").mkdir(parents=True, exist_ok=True)
        self.tmp = setup_tmpdir(self.home)
        # gz: one worker, FIFO; subprocesses inherit the TMPDIR marker set above
        job_env = {k: v for k, v in os.environ.items() if k != "SKILLWHET_TOKEN"}
        self.jobs = JobStore(self.home, work_root=self.store.work, tasks_root=self.tasks.root,
                             python=sys.executable, env=job_env)
        # 每个作业结束后把所有受管记录校正回 serve 自己最近一次写入的样子(同级副本也在内)
        self.jobs.after_run = self._resync_records
        # recover():上一代 serve 被 SIGKILL 时没来得及校正 —— 启动时整体校正一次
        touched = self.store.resync()
        if touched:
            print(f"[serve] managed records restored at startup: {', '.join(touched)}", file=sys.stderr, flush=True)

    def _resync_records(self) -> list[str]:
        touched = self.store.resync()
        return [f"managed record of {n!r} was modified outside serve and has been restored" for n in touched]

    def lock(self, skill: str) -> threading.Lock:
        with self._locks_guard:
            return self._locks.setdefault(skill, threading.Lock())

    # ── dispatch ────────────────────────────────────────────────────────
    ROUTES: list[tuple[str, re.Pattern, str]] = []

    @classmethod
    def route(cls, method: str, pattern: str):
        def deco(fn):
            cls.ROUTES.append((method, re.compile("^" + pattern + "$"), fn.__name__))
            return fn
        return deco

    def dispatch(self, method: str, path: str, query: dict, body: dict | None) -> tuple[int, dict]:
        for m, pat, name in self.ROUTES:
            if m != method:
                continue
            mt = pat.match(path)
            if mt:
                return 200, getattr(self, name)(query=query, body=body or {}, **mt.groupdict())
        raise HttpError(404, "NOT_FOUND", f"no route for {method} {path}")

    # ── health ──────────────────────────────────────────────────────────
    def healthz(self, **_) -> dict:
        return {
            "ok": True, "version": _pkg_version, "python": sys.version.split()[0],
            "home": str(self.home), "uptime_s": round(time.time() - self.started_at, 1),
            "tools": tool_status(), "tmpdir": str(self.tmp),
        }

    # ── skills ──────────────────────────────────────────────────────────
    def list_skills(self, **_) -> dict:
        return {"skills": self.store.list()}

    def skill_status(self, name: str, **_) -> dict:
        return self.store.status(name)

    def import_skill(self, name: str, body: dict, **_) -> dict:
        live = body.get("live_dir")
        if not isinstance(live, str) or not live:
            raise HttpError(400, "BAD_REQUEST", "live_dir is required")
        with self.lock(name):
            if body.get("replace"):
                self._assert_no_live_jobs(name, "reimport")      # hl(复核 P2-2):作业在跑时不许换掉副本
            rec = self.store.import_live(name, Path(live), replace=bool(body.get("replace")))
        return {"imported": rec.to_dict(), "status": self.store.status(name)}

    def upload_skill(self, body: dict, **_) -> dict:
        name = body.get("name")
        files = body.get("files")
        if not isinstance(name, str):
            raise HttpError(400, "BAD_REQUEST", "name is required")
        with self.lock(name):
            rec = self.store.import_upload(name, files, uploaded_by=str(body.get("uploaded_by") or ""))
            tasks_report = None
            # a tasks.json / tasks/tasks.json inside the package is a task set: validate and file it
            for rel in ("tasks.json", "tasks/tasks.json", "tasks.jsonl"):
                p = self.store.dir(name) / rel
                if p.exists():
                    fmt = "jsonl" if rel.endswith(".jsonl") else "json"
                    try:
                        rows = parse_rows(p.read_text(encoding="utf-8"), fmt)
                        rep = validate_and_map(rows, skill=name, fmt=fmt, tags=["origin:package"])
                        added = self.tasks.add(name, rep.tasks, source="package") if rep.tasks else None
                        tasks_report = {"file": rel, **rep.to_dict(), "added": added}
                    except ImportError_ as exc:
                        tasks_report = {"file": rel, "error": exc.code, "message": str(exc)}
                    break
        return {"imported": rec.to_dict(), "status": self.store.status(name), "tasks": tasks_report}

    def remove_skill(self, name: str, **_) -> dict:
        with self.lock(name):
            self._assert_no_live_jobs(name, "remove")
            moved = self.store.remove(name)
            # hl(动态 P2-13):任务集跟副本一起退场,不然同名重传者(任何人)继承前人的任务全文
            tasks_moved = self.tasks.retire(name, Path(moved))
        return {"removed": name, "moved_to": moved, "tasks_moved_to": tasks_moved}

    def _assert_no_live_jobs(self, name: str, what: str) -> None:
        """hl(动态 P2-20):训练 / 挖任务 / 留出集评估进行中,不能 re-bootstrap 或移除副本 ——
        作业随后死于 FileNotFoundError,还可能把半截 .evo 留在 _removed/ 里。"""
        live = [j for j in self.jobs.list(skill=name, limit=10_000) if j.state in ("queued", "running")]
        if live:
            raise HttpError(409, "JOB_ACTIVE",
                            f"cannot {what} {name!r}: job {live[0].id} is {live[0].state}",
                            job_id=live[0].id, state=live[0].state)

    def bootstrap_skill(self, name: str, body: dict, **_) -> dict:
        d = self._managed_dir(name)
        third = body.get("allow") or []
        if not isinstance(third, list):
            raise HttpError(400, "BAD_REQUEST", "allow must be a list")
        third = [str(x) for x in third]
        # hl(动态 P3):allow 是模块名,原样进 CONTRACT.yaml —— `yaml; rm -rf /` 这种不能放进去
        bad = [x for x in third if not _MODULE_RE.fullmatch(x)]
        if bad:
            raise HttpError(400, "BAD_ALLOW", f"allow entries must be module names: {bad[:3]!r}")
        frozen: list[str] = []
        if self.store.record(name).source == "live":
            # hb:技能库来源(root 导入的)冻结 S₀ 时把它**现有**的 import 一并写进 allowed_imports ——
            # allowlist 管的是优化器新加的依赖,不是 S₀ 本来就有的(否则 pandas / pyspark 这类 skill
            # 的每个候选都死在 G1)。上传来源不自动放行:那是非 root 的安全门,要作者在 CONTRACT 里自己声明。
            from .contract import DEFAULT_STDLIB_ALLOW, observed_imports
            from .gates.g1_security import own_module_names
            from .gates.base import Candidate
            from .contract import load_contract
            own = own_module_names(d, Candidate(skill_dir=d, contract=load_contract(d)).python_files())
            frozen = sorted(observed_imports(d) - DEFAULT_STDLIB_ALLOW - own)
        with self.lock(name):
            self._assert_no_live_jobs(name, "bootstrap")
            bootstrap(d, third_party=third + frozen)
            # 契约(allowed_imports / 入口点)变了,上一次体检的缓存不再代表这份副本 —— 作废,卡片回到"未跑"
            (d / ".evo" / "gate.json").unlink(missing_ok=True)
        return {"bootstrapped": True, "frozen_imports": frozen, "status": self.store.status(name)}

    def gate_cached(self, name: str, **_) -> dict:
        """GET side: the last pyramid result (``.evo/gate.json``) — never runs anything."""
        d = self._managed_dir(name)
        p = d / ".evo" / "gate.json"
        if not p.exists():
            return {"cached": False, "passed": None, "results": []}
        return {"cached": True, **json.loads(p.read_text(encoding="utf-8"))}

    def gate_skill(self, name: str, query: dict, **_) -> dict:
        d = self._managed_dir(name)
        cfg = PyramidConfig(use_bandit="no_bandit" not in query, use_pyright="no_pyright" not in query,
                            run_tests="no_tests" not in query)
        # hl(动态 P3):同一 skill 同一时刻只跑一次体检,后来者等这一次的结果(10 个并发原来串行跑 10 遍,
        # 末个等 27 秒)。同一种配置才合并;带 no_* 的少数请求各跑各的。
        key = f"{name}|{int(cfg.use_bandit)}{int(cfg.use_pyright)}{int(cfg.run_tests)}"
        with self._locks_guard:
            pending = self._gate_inflight.get(key)
            if pending is None:
                pending = (threading.Event(), {})
                self._gate_inflight[key] = pending
                leader = True
            else:
                leader = False
        if not leader:
            pending[0].wait()
            if not pending[1]:
                raise HttpError(500, "GATE_FAILED", "the shared gate run failed")
            return {**pending[1], "merged": True}
        try:
            out = self._gate_run(name, d, cfg)
            pending[1].update(out)
            return out
        finally:
            with self._locks_guard:
                self._gate_inflight.pop(key, None)
            pending[0].set()

    def _gate_run(self, name: str, d: Path, cfg: PyramidConfig) -> dict:
        with self.lock(name):
            try:
                res = run_pyramid(d, load_contract(d), build_fast_pyramid(cfg), short_circuit=False)
            finally:
                # 静态 P1-11:G4 / G5 在副本里跑测试,能改任何副本的 import.json —— 跑完以 serve 的记录为准校正
                touched = self._resync_records()
            out = res.to_dict()
            # hl(动态 P2-19):缺工具的门是 SKIP,整体也不能算通过 —— 生产 pip --user 装时很可能踩到
            out["passed"] = bool(res.passed and not res.missing_tools)
            out["ran_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            out["warnings"] = list(touched)
            for tool in res.missing_tools:
                from .gates.base import missing_tool_reason
                out["warnings"].append(missing_tool_reason(tool))
            evo = d / ".evo"
            evo.mkdir(exist_ok=True)
            (evo / "gate.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
        return out

    def facts_skill(self, name: str, **_) -> dict:
        d = self._managed_dir(name)
        return {
            m: {"imports": sorted(f.imports), "side_effects": sorted(f.side_effects),
                "functions": f.functions, "annotated": f.annotated,
                "dangerous": [{"name": n, "why": w, "line": ln} for n, w, ln in f.dangerous]}
            for m, f in collect_facts(d).items()
        }

    def contract_skill(self, name: str, **_) -> dict:
        d = self._managed_dir(name)
        c = load_contract(d)
        return {"exists": (d / "CONTRACT.yaml").exists(), "contract": c.to_dict()}

    def wiki_skill(self, name: str, **_) -> dict:
        d = self._managed_dir(name) / ".evo" / "wiki"
        pats = []
        if (d / "patterns").is_dir():
            for p in sorted((d / "patterns").glob("*.md")):
                pats.append({"id": p.stem, "text": p.read_text(encoding="utf-8")})
        logs = (d / "logs.md").read_text(encoding="utf-8") if (d / "logs.md").exists() else ""
        impact = (d / "impact.md").read_text(encoding="utf-8") if (d / "impact.md").exists() else ""
        # he:模式的结构化字段(状态 / 范围 / 反例 / 修订号),页面按状态筛
        index: list[dict] = []
        if d.is_dir():
            from .wiki import Wiki
            index = [p.to_dict() for p in Wiki(d).patterns.values()]
        return {"patterns": pats, "logs": logs, "impact": impact, "index": index}

    def checkpoint_skill(self, name: str, **_) -> dict:
        """he:这个副本有没有没跑完的训练可以续(`train --resume`)。"""
        from . import checkpoint
        d = self._managed_dir(name)
        # training loads all.json through load_tasks, which drops uncheckable records: hash the same set
        return checkpoint.info(d, [t for t in self.tasks.all(name) if t.checkable])

    def provenance_skill(self, name: str, **_) -> dict:
        p = self._managed_dir(name) / ".evo" / "provenance.jsonl"
        recs = []
        if p.exists():
            for line in p.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    try:
                        recs.append(json.loads(line))
                    except json.JSONDecodeError:
                        recs.append({"raw": line})
        return {"records": recs}

    def ledger_skill(self, name: str, **_) -> dict:
        p = self._managed_dir(name) / ".evo" / "ledger.yaml"
        return {"exists": p.exists(), "text": p.read_text(encoding="utf-8") if p.exists() else ""}

    def rebase_skill(self, name: str, body: dict, **_) -> dict:
        self._managed_dir(name)
        live = body.get("live_dir")
        event = body.get("event")
        with self.lock(name):
            # 发布:先记下"技能库现在是哪份 staging"(rebase 之前算,副本此刻就是被发布的内容)
            sid = self.store.current_adoption(name) if event == "publish" else None
            rec = self.store.rebase(name, live_dir=Path(str(live)) if live else None)
            if event in ("publish", "rollback"):
                entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event,
                         "by": str(body.get("by") or "")[:64], "staging": sid,
                         "to": str(body.get("to") or "")[:64] or None, "mode": str(body.get("mode") or "")[:16] or None}
                self._append_publish_log(name, entry)
        return {"rebased": rec.to_dict(), "status": self.store.status(name)}

    # hd:发布 / 回滚记录。放在 serve 自己的 home 里(副本里的代码写不到),一行一条
    def _publish_log_path(self, name: str) -> Path:
        return self.home / "publishes" / f"{validate_name(name)}.jsonl"

    def _publish_log(self, name: str) -> list[dict]:
        p = self._publish_log_path(name)
        if not p.exists():
            return []
        out = []
        for line in p.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if isinstance(row, dict):
                out.append(row)
        return out

    def _append_publish_log(self, name: str, entry: dict) -> None:
        p = self._publish_log_path(name)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def publish_history(self, name: str, **_) -> dict:
        self._managed_dir(name)
        return {"history": list(reversed(self._publish_log(name)))}

    def drift_skill(self, name: str, **_) -> dict:
        return {"drift": self.store.live_drift(name)}

    # ── tasks ───────────────────────────────────────────────────────────
    def validate_tasks(self, body: dict, **_) -> dict:
        skill, fmt, content = body.get("skill"), body.get("format", "json"), body.get("content")
        if not isinstance(skill, str) or not isinstance(content, str):
            raise HttpError(400, "BAD_REQUEST", "skill and content are required")
        try:
            rows = parse_rows(content, fmt)
            rep = validate_and_map(rows, skill=skill, fmt=fmt, tags=self._tags(body), assign=False)
        except ImportError_ as exc:
            raise HttpError(422, exc.code, str(exc)) from exc
        return rep.to_dict(with_tasks=False)

    def add_tasks(self, body: dict, **_) -> dict:
        skill, fmt, content = body.get("skill"), body.get("format", "json"), body.get("content")
        records = body.get("records")
        if not isinstance(skill, str):
            raise HttpError(400, "BAD_REQUEST", "skill is required")
        self._managed_dir(validate_name(skill))          # hl(动态 P3):未托管的 skill 不收任务
        try:
            if isinstance(records, list):
                if not all(isinstance(r, dict) for r in records):
                    raise ImportError_("BAD_ROW", "every record must be an object")
                rows, fmt = records, "records"
            elif isinstance(content, str):
                rows = parse_rows(content, fmt)
            else:
                raise HttpError(400, "BAD_REQUEST", "content or records is required")
            rep = validate_and_map(rows, skill=skill, fmt=fmt, tags=self._tags(body))
        except ImportError_ as exc:
            raise HttpError(422, exc.code, str(exc)) from exc
        if rep.failed and not body.get("keep_passing"):
            raise HttpError(422, "ROWS_INVALID", f"{rep.failed} row(s) invalid; fix them or pass keep_passing",
                            report=rep.to_dict())
        added = self.tasks.add(skill, rep.tasks, source=str(body.get("source") or "upload")) if rep.tasks else {"added": 0}
        return {"report": rep.to_dict(), **added}

    def derive_tasks(self, body: dict, **_) -> dict:
        """The tests ARE the tasks (gz): derive a task set from the managed copy's own
        ``tests/unit`` (or another suite), the way ``whet train`` does without ``--tasks``.
        Stored as a batch with ``source: "tests"``; re-deriving replaces ids in place."""
        from .cli import _tasks_from_pytest
        from .evidence import assign_splits
        skill = validate_name(str(body.get("skill") or ""))
        d = self._managed_dir(skill)
        subdir = str(body.get("test_dir") or "tests/unit")
        if subdir not in ("tests/unit", "tests/holdout", "tests/contract"):
            raise HttpError(400, "BAD_TEST_DIR", "test_dir must be tests/unit | tests/holdout | tests/contract")
        if not (d / subdir).is_dir():
            raise HttpError(409, "NO_TESTS", f"{skill!r} has no {subdir}/")
        with self.lock(skill):
            tasks = _tasks_from_pytest(d, subdir)
            if not tasks:
                raise HttpError(409, "NO_TESTS", f"no tests collected under {subdir}/")
            try:
                val = float(body.get("val_fraction", 0.25))
                test = float(body.get("test_fraction", 0.25))
            except (TypeError, ValueError) as exc:       # hl(动态 P3):"abc" 原来 500
                raise HttpError(400, "BAD_SPLIT", "val_fraction / test_fraction must be numbers within 0–0.5") from exc
            if not (0 <= val <= 0.5 and 0 <= test <= 0.5):
                raise HttpError(400, "BAD_SPLIT", "val_fraction / test_fraction must be within 0–0.5")
            assign_splits(tasks, val_fraction=val, test_fraction=test)
            for t in tasks:
                t.tags = list(dict.fromkeys([*t.tags, *self._tags(body), "source:tests"]))
            added = self.tasks.add(skill, tasks, source="tests")
        return {"derived": len(tasks), "test_dir": subdir, **added}

    def new_tasks(self, query: dict, **_) -> dict:
        """he(夜训门槛):某时刻以来新进库的可判分任务数。`since` 是 ISO 时间,空 = 全部。"""
        skill = validate_name(str(query.get("skill", [""])[0] or ""))
        raw = str(query.get("since", [""])[0] or "").strip()
        since: float | None = None
        if raw:
            from datetime import datetime, timezone
            try:
                at = datetime.fromisoformat(raw.replace(" ", "+").replace("Z", "+00:00"))
            except ValueError as exc:
                raise HttpError(400, "BAD_SINCE", "since must be an ISO time like 2026-09-24T02:00:00Z") from exc
            if at.tzinfo is None:
                at = at.replace(tzinfo=timezone.utc)      # Prism always sends UTC with a Z
            since = at.timestamp()
        return self.tasks.new_since(skill, since)

    def list_tasks(self, query: dict, **_) -> dict:
        skill = query.get("skill", [None])[0]
        # hl(动态 P2-13):总览只统计还在托管的 skill(移除时任务已随副本进 _removed/,这里再兜一层)
        out = {"summary": [row for row in self.tasks.summary(skill)
                           if skill or self.store.exists(row["skill"])]}
        if skill and "full" in query:
            out["tasks"] = [t.to_dict() for t in self.tasks.all(skill)]
        return out

    # ── jobs (gz) ───────────────────────────────────────────────────────
    def create_job(self, body: dict, **_) -> dict:
        skill = validate_name(str(body.get("skill") or ""))
        job, position = self.jobs.create(str(body.get("kind") or "train"), skill, body.get("args") or {},
                                         tags=self._tags(body), origin=str(body.get("origin") or "manual"))
        return {"job": job.to_dict(), "position": position}

    def list_jobs(self, query: dict, **_) -> dict:
        skill = query.get("skill", [None])[0]
        limit = _int_query(query, "limit", 100)
        since = str(query.get("since", [""])[0] or "").strip() or None
        if since and not re.fullmatch(r"\d{4}-\d{2}-\d{2}(T[0-9:.]+Z?)?", since):
            raise HttpError(400, "BAD_SINCE", "since must be an ISO time like 2026-09-24T00:00:00Z")
        jobs = self.jobs.list(skill=skill, limit=max(1, min(limit, 1000)), since=since)
        out = []
        for j in jobs:
            d = j.to_dict()
            d["position"] = self.jobs.queue_position(j.id) if j.state == "queued" else None
            d.update(self._job_scores(j.id))
            out.append(d)
        return {"jobs": out}

    def _job_scores(self, job_id: str) -> dict:
        """baseline / latest candidate val + rounds so far — for the list, without the whole event log."""
        base, cand, rounds = None, None, 0
        for e in self.jobs.progress(job_id, 0, 5000):
            k = e.get("kind")
            if k == "baseline":
                base = e.get("val_score")
            elif k == "gate":
                cand = e.get("val_candidate")
            elif k == "round_end":
                rounds += 1
        return {"val_baseline": base, "val_candidate": cand, "rounds_done": rounds}

    def get_job(self, job_id: str, **_) -> dict:
        job = self.jobs.get(job_id)
        d = job.to_dict()
        d["position"] = self.jobs.queue_position(job.id) if job.state == "queued" else None
        events = self.jobs.progress(job.id, 0, 5000)
        d["last_seq"] = events[-1]["seq"] if events else 0
        d["rounds"] = [e for e in events if e.get("kind") == "round_end"]
        d.update(self._job_scores(job.id))
        return {"job": d}

    def job_progress(self, job_id: str, query: dict, **_) -> dict:
        after = _int_query(query, "after", 0)
        events = self.jobs.progress(job_id, after=after, limit=500)
        job = self.jobs.get(job_id)
        return {"events": events, "state": job.state, "last_seq": events[-1]["seq"] if events else after}

    def job_log(self, job_id: str, query: dict, **_) -> dict:
        tail = _int_query(query, "tail", 200)
        return {"log": self.jobs.log_tail(job_id, tail)}

    def cancel_job(self, job_id: str, **_) -> dict:
        return {"job": self.jobs.cancel(job_id).to_dict()}

    # ── ha:harvest 结果 / 入库,release-eval 结果 ───────────────────────
    def job_result(self, job_id: str, **_) -> dict:
        job = self.jobs.get(job_id)
        data = self.jobs.result(job_id)
        imported = self.jobs.dir(job_id) / "imported.json"
        return {"kind": job.kind, "skill": job.skill, "result": data,
                "imported": json.loads(imported.read_text(encoding="utf-8")) if imported.exists() else None}

    def job_import(self, job_id: str, body: dict, **_) -> dict:
        """把一个 harvest 作业挖出来的任务(全部,或 `task_ids` 指定的那些)入库,来源记 harvest。"""
        from .evidence import TaskRecord
        job = self.jobs.get(job_id)
        if job.kind != "harvest" or job.state != "done":
            raise HttpError(409, "NOT_IMPORTABLE", f"job {job_id} is a {job.kind} job in state {job.state}")
        data = self.jobs.result(job_id)
        if data.get("dry_run"):
            raise HttpError(409, "NOT_IMPORTABLE", "a dry-run lists sessions only; run the harvest for real first")
        imported = self.jobs.dir(job_id) / "imported.json"
        if imported.exists():
            raise HttpError(409, "ALREADY_IMPORTED", f"job {job_id} was already imported")
        wanted = body.get("task_ids")
        rows = [r for r in data.get("tasks") or [] if isinstance(r, dict)]
        if isinstance(wanted, list):
            keep = {str(x) for x in wanted}
            rows = [r for r in rows if str(r.get("id")) in keep]
        tasks = [TaskRecord.from_dict(r) for r in rows if r.get("reference_kind") in ("exact", "rubric", "rule")]
        if not tasks:
            raise HttpError(409, "NOTHING_TO_IMPORT", "no checkable tasks selected")
        for t in tasks:
            t.tags = sorted(set(t.tags + self._tags(body)))
        with self.lock(job.skill):
            res = self.tasks.add(job.skill, tasks, source="harvest")
        rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "task_ids": [t.id for t in tasks], **res}
        imported.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
        return rec

    # ── staging (gz) ────────────────────────────────────────────────────
    def _staging_dir(self, name: str, sid: str) -> Path:
        d = self._managed_dir(name)
        if "/" in sid or sid in (".", "..") or not sid:
            raise HttpError(400, "BAD_STAGING", "bad staging id")
        p = d / ".evo" / "staging" / sid
        if not (p / "manifest.json").exists():
            raise HttpError(404, "STAGING_NOT_FOUND", f"no staging {sid!r} for {name!r}")
        return p

    def _staging_summary(self, p: Path) -> dict:
        man = json.loads((p / "manifest.json").read_text(encoding="utf-8"))
        rep = man.get("report") or {}
        out = {
            "id": p.name, "created_at": man.get("created_at"), "accepted": bool(man.get("accepted")),
            "adopted": (p / "adopted.json").exists(),
            # hl(动态 P1-8 / P3):老 staging 的 manifest 可能含 import.json,它不是技能文件,不计数
            "files": sum(1 for f in (man.get("files") or [])
                         if not (isinstance(f, dict) and f.get("rel") == "import.json")),
            "baseline_score": rep.get("baseline_score"), "candidate_score": rep.get("candidate_score"),
            "improved": rep.get("improved"), "stop_reason": rep.get("stop_reason"),
            "total_cost_usd": rep.get("total_cost_usd"), "rounds": len(rep.get("rounds") or []),
            "test_score_baseline": rep.get("test_score_baseline"), "test_score_best": rep.get("test_score_best"),
            "release": None, "contract": {k: man.get(k) for k in (
                "base_bundle_hash", "candidate_bundle_hash", "protocol_hash")},
            "published": [e.get("at") for e in self._publish_log(p.parent.parent.parent.name)
                          if e.get("event") == "publish" and e.get("staging") == p.name],
        }
        # 留出集记录以 serve 自己 home 里那份为准(副本里的 release.json 副本代码写得到)
        r = self.jobs.release_record(p.parent.parent.parent.name, p.name)
        if r is not None:
            if isinstance(r, dict):
                out["release"] = r
                # release-once 之后 test 分数以这一次为准(训练时不再看 test)
                out["test_score_baseline"], out["test_score_best"] = r.get("baseline"), r.get("candidate")
        return out

    def list_staging(self, name: str, **_) -> dict:
        d = self._managed_dir(name)
        root = d / ".evo" / "staging"
        items = []
        if root.is_dir():
            for p in sorted(root.iterdir(), reverse=True):
                if p.is_dir() and (p / "manifest.json").exists():
                    items.append(self._staging_summary(p))
        return {"staging": items}

    def get_staging(self, name: str, sid: str, **_) -> dict:
        import difflib
        p = self._staging_dir(name, sid)
        live = self._managed_dir(name)
        man = json.loads((p / "manifest.json").read_text(encoding="utf-8"))
        report = json.loads((p / "report.json").read_text(encoding="utf-8")) if (p / "report.json").exists() else {}
        report_md = (p / "report.md").read_text(encoding="utf-8") if (p / "report.md").exists() else ""
        diffs = []
        diff_base = "base" if (p / "base").is_dir() else "backup" if (p / "backup").is_dir() else "copy"
        from .staging import StagingError, _check_rel
        for f in man.get("files") or []:
            rel = f.get("rel") if isinstance(f, dict) else None
            if not isinstance(rel, str) or rel == "import.json":   # import.json:受管记录,不是技能内容
                continue
            try:
                _check_rel(rel)          # manifest 可能被副本里的代码改过:越界的 rel 不读
            except StagingError:
                continue
            prop = p / "proposed" / rel
            # hd:比对的"底"—— 优先用训练开始时留下的 base/(0.4.2 起),其次用采纳时的备份 backup/
            # (采纳前副本里的那份;备份里没有 = 采纳时新加的文件),都没有才拿副本当前内容比(老的未采纳 staging)
            if diff_base == "base":
                if f.get("sha256") == f.get("live_sha256"):
                    continue
                cur = p / "base" / rel
            elif diff_base == "backup":
                cur = p / "backup" / rel
            else:
                cur = live / rel
            try:
                a = cur.read_text(encoding="utf-8").splitlines(keepends=True) if cur.exists() else []
                b = prop.read_text(encoding="utf-8").splitlines(keepends=True) if prop.exists() else []
            except UnicodeDecodeError:
                diffs.append({"rel": rel, "binary": True, "changed": f.get("sha256") != f.get("live_sha256")})
                continue
            if a == b:
                continue
            ud = list(difflib.unified_diff(a, b, fromfile=f"{'before' if diff_base != 'copy' else 'live'}/{rel}",
                                           tofile=f"proposed/{rel}", n=3))
            diffs.append({"rel": rel, "binary": False, "added": sum(1 for x in ud[2:] if x.startswith("+")),
                          "removed": sum(1 for x in ud[2:] if x.startswith("-")), "diff": "".join(ud)[:200_000],
                          "new": not cur.exists()})
        adopted = json.loads((p / "adopted.json").read_text(encoding="utf-8")) if (p / "adopted.json").exists() else None
        return {**self._staging_summary(p), "manifest": man, "report": report, "report_md": report_md,
                "diffs": diffs, "diff_base": diff_base, "adopted_info": adopted}

    def adopt_staging(self, name: str, sid: str, body: dict, **_) -> dict:
        from .staging import StagingError, adopt
        p = self._staging_dir(name, sid)
        with self.lock(name):
            try:
                written = adopt(p, force=bool(body.get("force")), require_release=True,
                                allow_unreleased=bool(body.get("skip_release")),
                                release_record=self.jobs.release_record(name, sid) or {"missing": True})
            except StagingError as exc:
                raise HttpError(409, "ADOPT_REFUSED", str(exc)) from exc
        return {"adopted": True, "written": written, "status": self.store.status(name)}

    def export_staging(self, name: str, sid: str, **_):
        import io
        import tarfile
        p = self._staging_dir(name, sid)
        src = p / "proposed"
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as tar:
            for f in sorted(src.rglob("*")):
                rel = f.relative_to(src)
                # import.json 是受管记录(每文件 sha),不是技能的一部分;__pycache__ 同理
                if not f.is_file() or ".evo" in rel.parts or "__pycache__" in rel.parts or rel.as_posix() == "import.json":
                    continue
                tar.add(f, arcname=f"{name}/{rel.as_posix()}")
        return RawResponse(buf.getvalue(), "application/gzip", f"{name}-{sid}.tar.gz")

    # ── helpers ─────────────────────────────────────────────────────────
    def _managed_dir(self, name: str) -> Path:
        if not self.store.exists(name):
            raise HttpError(404, "NOT_MANAGED", f"no managed copy of {name!r}")
        return self.store.dir(name)

    @staticmethod
    def _tags(body: dict) -> list[str]:
        tags = body.get("tags") or []
        return [str(t) for t in tags if isinstance(t, (str, int))]


# route table (method, path pattern → handler name)
App.route("GET", r"/healthz")(App.healthz)
App.route("GET", r"/skills")(App.list_skills)
App.route("POST", r"/skills/upload")(App.upload_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)")(App.skill_status)
App.route("GET", r"/skills/(?P<name>[^/]+)/status")(App.skill_status)
App.route("DELETE", r"/skills/(?P<name>[^/]+)")(App.remove_skill)
App.route("POST", r"/skills/(?P<name>[^/]+)/import")(App.import_skill)
App.route("POST", r"/skills/(?P<name>[^/]+)/bootstrap")(App.bootstrap_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/gate")(App.gate_cached)
App.route("POST", r"/skills/(?P<name>[^/]+)/gate")(App.gate_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/facts")(App.facts_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/contract")(App.contract_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/wiki")(App.wiki_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/provenance")(App.provenance_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/ledger")(App.ledger_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/drift")(App.drift_skill)
App.route("POST", r"/skills/(?P<name>[^/]+)/rebase")(App.rebase_skill)
App.route("GET", r"/skills/(?P<name>[^/]+)/publishes")(App.publish_history)
App.route("POST", r"/jobs")(App.create_job)
App.route("GET", r"/jobs")(App.list_jobs)
App.route("GET", r"/jobs/(?P<job_id>[^/]+)")(App.get_job)
App.route("GET", r"/jobs/(?P<job_id>[^/]+)/progress")(App.job_progress)
App.route("GET", r"/jobs/(?P<job_id>[^/]+)/log")(App.job_log)
App.route("POST", r"/jobs/(?P<job_id>[^/]+)/cancel")(App.cancel_job)
App.route("GET", r"/jobs/(?P<job_id>[^/]+)/result")(App.job_result)
App.route("POST", r"/jobs/(?P<job_id>[^/]+)/import")(App.job_import)
App.route("GET", r"/skills/(?P<name>[^/]+)/staging")(App.list_staging)
App.route("GET", r"/skills/(?P<name>[^/]+)/staging/(?P<sid>[^/]+)")(App.get_staging)
App.route("POST", r"/skills/(?P<name>[^/]+)/staging/(?P<sid>[^/]+)/adopt")(App.adopt_staging)
App.route("GET", r"/skills/(?P<name>[^/]+)/staging/(?P<sid>[^/]+)/export")(App.export_staging)
App.route("POST", r"/tasks/validate")(App.validate_tasks)
App.route("POST", r"/tasks/derive")(App.derive_tasks)
App.route("POST", r"/tasks")(App.add_tasks)
App.route("GET", r"/tasks/new")(App.new_tasks)
App.route("GET", r"/tasks")(App.list_tasks)
App.route("GET", r"/skills/(?P<name>[^/]+)/checkpoint")(App.checkpoint_skill)


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"skillwhet/{_pkg_version}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quieter default log, one line per request
            sys.stderr.write("[serve] %s %s\n" % (self.address_string(), fmt % args))

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _handle(self, method: str) -> None:
            try:
                parts = urlsplit(self.path)
                if parts.path != "/healthz":
                    got = self.headers.get("X-SkillWhet-Token", "")
                    if not app.token or not hmac.compare_digest(got, app.token):
                        raise HttpError(401, "UNAUTHORIZED", "bad or missing X-SkillWhet-Token")
                body = None
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    if length > MAX_BODY:
                        raise HttpError(413, "TOO_LARGE", "request body too large")
                    raw = self.rfile.read(length)
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                        raise HttpError(400, "BAD_JSON", f"body is not valid JSON: {exc}") from exc
                    if not isinstance(body, dict):
                        raise HttpError(400, "BAD_JSON", "body must be a JSON object")
                # 保留空值:`?no_bandit&no_pyright` 这类开关原来被 parse_qs 丢掉、从没生效过(hl 复核顺带发现)
                status, payload = app.dispatch(method, parts.path, parse_qs(parts.query, keep_blank_values=True), body)
                if isinstance(payload, RawResponse):
                    self.send_response(status)
                    self.send_header("Content-Type", payload.content_type)
                    self.send_header("Content-Length", str(len(payload.data)))
                    self.send_header("Content-Disposition", f'attachment; filename="{payload.filename}"')
                    self.send_header("Cache-Control", "no-store")
                    self.end_headers()
                    self.wfile.write(payload.data)
                    return
                self._send(status, {"ok": True, "data": payload})
            except HttpError as exc:
                self._send(exc.status, {"ok": False, "error": exc.code, "message": exc.message, **exc.extra})
            except ManagedError as exc:
                self._send(exc.status, {"ok": False, "error": exc.code, "message": str(exc)})
            except JobError as exc:
                self._send(exc.status, {"ok": False, "error": exc.code, "message": str(exc), **exc.extra})
            except Exception as exc:  # noqa: BLE001
                traceback.print_exc()
                self._send(500, {"ok": False, "error": "INTERNAL", "message": f"{type(exc).__name__}: {exc}"})

        def do_GET(self): self._handle("GET")          # noqa: E704
        def do_POST(self): self._handle("POST")        # noqa: E704
        def do_DELETE(self): self._handle("DELETE")    # noqa: E704

    return Handler


def _tighten_home(home: Path) -> None:
    """已经存在的 home:顶层目录与状态文件收紧到 0700 / 0600(只动 home 自己与 jobs/ tasks/ 两层,不递归整棵工作树)。"""
    try:
        os.chmod(home, 0o700)
    except OSError:
        return
    for sub in ("jobs", "tasks", "releases", "publishes", "_removed", "work"):
        d = home / sub
        if d.is_dir():
            try:
                os.chmod(d, 0o700)
            except OSError:
                continue
    for pattern in ("jobs/*/state.json", "jobs/*/*.json", "tasks/*/*.json", "releases/*/*.json", "publishes/*.jsonl"):
        for f in home.glob(pattern):
            try:
                os.chmod(f, 0o600)
            except OSError:
                pass
    for d in list(home.glob("jobs/*")) + list(home.glob("tasks/*")):
        if d.is_dir():
            try:
                os.chmod(d, 0o700)
            except OSError:
                pass


def serve(host: str, port: int, home: Path, token: str) -> ThreadingHTTPServer:
    if host not in ("127.0.0.1", "localhost", "::1"):
        raise SystemExit("whet serve binds loopback only (refusing %r)" % host)
    if not token:
        raise SystemExit("SKILLWHET_TOKEN is required (set the env var or pass --token)")
    # hl(动态 P3):home 里有任务全文(all.json)、作业状态、发布记录 —— 同机其他用户不该读得到。
    # 进程 umask 0077:serve 与它起的训练子进程新建的文件 0600 / 目录 0700;已有的 home 顶层也收紧。
    os.umask(0o077)
    app = App(home, token)
    _tighten_home(app.home)
    srv = ThreadingHTTPServer((host, port), make_handler(app))
    srv.daemon_threads = True
    srv.app = app  # type: ignore[attr-defined]
    return srv


def main_serve(a) -> int:
    home = Path(a.home).expanduser()
    token = a.token or os.environ.get("SKILLWHET_TOKEN", "")
    srv = serve(a.host, a.port, home, token)
    print(f"[serve] skillwhet {_pkg_version} listening on http://{a.host}:{a.port}  home={home}",
          flush=True)
    recovered = srv.app.jobs.list(limit=50)  # type: ignore[attr-defined]
    live = [j.id for j in recovered if j.state == "interrupted" and j.finished_at and j.finished_at >= srv.app.started_at_iso]  # type: ignore[attr-defined]
    if live:
        print(f"[serve] marked {len(live)} job(s) interrupted by the previous serve: {', '.join(live)}", flush=True)

    # SIGTERM (Prism stopping) → kill the running training job's process group, then exit;
    # a training subprocess must not outlive the serve that owns its queue.
    import signal as _signal

    def _term(_sig, _frm):
        raise KeyboardInterrupt

    _signal.signal(_signal.SIGTERM, _term)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.app.jobs.stop()  # type: ignore[attr-defined]
        srv.app.store.resync()  # type: ignore[attr-defined]
        srv.server_close()
    return 0
