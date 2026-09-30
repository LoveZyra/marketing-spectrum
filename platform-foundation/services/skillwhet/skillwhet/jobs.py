"""Training jobs for ``whet serve`` (gz, second phase).

One worker, one job at a time, FIFO. A job is a subprocess ``python -m skillwhet
train <work/skill> --tasks <tasks/skill/all.json> --progress <jobs/id/progress.jsonl> …``
whose stdout/stderr go to ``jobs/<id>/stdout.log``. The queue is the directory:
``jobs/<id>/state.json`` is the single source of truth, rewritten on every
transition, so a restarted serve can list history and mark what it lost.

Why a subprocess and not a thread: the trainer imports and runs skill code
through the sandbox; a crash, an ``os._exit`` in a test, an RLIMIT hit — none of
that may take the HTTP face down with it. Cancel is ``SIGTERM`` → 4 s →
``SIGKILL`` on the whole process group.

Rules that are policy, not mechanics (and therefore live here, not in Prism):
  * the same skill cannot have two live jobs of the same kind (queued or running) → JOB_DUPLICATE;
  * ha: kinds are ``train``, ``harvest`` (mine tasks from transcripts, optionally
    with Prism's feedback overlay and a session whitelist) and ``release_eval``
    (the one look at the test split a staging gets before release);
  * only a whitelisted set of ``whet train`` flags can be set through the API, each
    type-checked, so a caller cannot smuggle ``--fast-backend http://…`` or a path;
  * the managed copy must exist and be bootstrapped, and have ≥ 1 checkable task.
"""
from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .progress import read_events

LIVE_STATES = ("queued", "running")
TERMINAL_STATES = ("done", "failed", "cancelled", "interrupted")
TERM_GRACE_S = 4.0

# API arg → (flag, type, validator).  Anything not listed is rejected.
ARG_SPEC: dict[str, tuple[str, type, object]] = {
    "rounds": ("--rounds", int, lambda v: 1 <= v <= 20),
    "fast_iters": ("--fast-iters", int, lambda v: 1 <= v <= 10),
    "k": ("-k", int, lambda v: 1 <= v <= 8),
    "budget_p2": ("--budget-p2", int, lambda v: 1 <= v <= 20),
    "budget_p3": ("--budget-p3", int, lambda v: 0 <= v <= 20),
    "refine": ("--refine", int, lambda v: 0 <= v <= 5),
    "tests_every": ("--tests-every", int, lambda v: 0 <= v <= 10),
    "workers": ("--workers", int, lambda v: 1 <= v <= 8),
    "judge_samples": ("--judge-samples", int, lambda v: 1 <= v <= 5),
    "max_cost_usd": ("--max-cost-usd", float, lambda v: 0 <= v <= 500),
    "max_minutes": ("--max-minutes", float, lambda v: 0 <= v <= 24 * 60),
    "no_accept_rounds": ("--no-accept-rounds", int, lambda v: 0 <= v <= 20),
    "runner": ("--runner", str, lambda v: v in ("pytest", "agent", "simulate", "mixed")),
    "gate_metric": ("--gate-metric", str, lambda v: v in ("hard", "soft", "mixed")),
    "test_dir": ("--test-dir", str, lambda v: v in ("tests/unit", "tests/holdout", "tests/contract")),
    "fast_backend": ("--fast-backend", str, lambda v: v in ("claude", "mock")),
    "slow_backend": ("--slow-backend", str, lambda v: v in ("claude", "mock")),
    "eval_backend": ("--eval-backend", str, lambda v: v in ("claude", "mock")),
    "fast_model": ("--fast-model", str, lambda v: 0 < len(v) <= 80 and _model_ok(v)),
    "slow_model": ("--slow-model", str, lambda v: 0 < len(v) <= 80 and _model_ok(v)),
    "eval_model": ("--eval-model", str, lambda v: 0 < len(v) <= 80 and _model_ok(v)),
    "target_model": ("--target-model", str, lambda v: 0 < len(v) <= 80 and _model_ok(v)),
}
FLAG_SPEC: dict[str, str] = {   # booleans → bare flags
    "no_slow_loop": "--no-slow-loop", "no_p1": "--no-p1", "no_p3": "--no-p3",
    "no_replay": "--no-replay", "no_cache": "--no-cache", "pairwise_judge": "--pairwise-judge",
    "first_wins": "--first-wins", "no_bandit": "--no-bandit", "no_pyright": "--no-pyright",
    "allow_regression": "--allow-regression",
    "resume": "--resume",          # he: continue from the last completed round
}


def _model_ok(v: str) -> bool:
    import re
    # 不能以 - 开头:否则 argparse 会把它当成下一个 flag
    return re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*", v) is not None


class JobError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400, **extra) -> None:
        super().__init__(message)
        self.code, self.status, self.extra = code, status, extra


@dataclass
class Job:
    id: str
    kind: str
    skill: str
    args: dict
    tags: list[str] = field(default_factory=list)
    state: str = "queued"
    created_at: str = ""
    started_at: str | None = None
    finished_at: str | None = None
    pid: int | None = None
    rc: int | None = None
    stop_reason: str | None = None
    improved: bool | None = None
    cost_usd: float | None = None
    staging: str | None = None
    error: str | None = None
    origin: str = "manual"
    warnings: list[str] = field(default_factory=list)   # hl:非致命的异常(如副本代码改了 import.json)

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}

    @classmethod
    def from_dict(cls, d: dict) -> Job:
        return cls(**{k: d.get(k) for k in cls.__dataclass_fields__ if k in d})


# ha:另外两种作业。harvest(从会话里挖任务)与 release_eval(一次性的留出集评估)。
KINDS = ("train", "harvest", "release_eval")
RELEASE_KEYS = ("runner", "test_dir", "judge_samples", "workers", "gate_metric",
                "fast_backend", "slow_backend", "eval_backend", "fast_model", "slow_model", "eval_model", "target_model")
_ID_RE = __import__("re").compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_SID_RE = __import__("re").compile(r"\d{8}-\d{6}(-\d+)?")
_ISO_RE = __import__("re").compile(r"\d{4}-\d{2}-\d{2}([T ][0-9:.]+Z?)?")
MAX_OVERLAY_BYTES = 20 * 1024 * 1024
MAX_SESSIONS = 20_000


def _typed(key: str, value, typ, ok):
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise JobError("BAD_ARG", f"{key}: wrong type")
    try:
        cast = typ(value)
    except (TypeError, ValueError) as exc:
        raise JobError("BAD_ARG", f"{key}: {exc}") from exc
    if not ok(cast):
        raise JobError("BAD_ARG", f"{key}={value!r} is out of range")
    return cast


def check_harvest_args(args: dict) -> dict:
    """harvest 作业的参数(白名单 + 类型)。返回规范化后的副本;大块(白名单 / 叠加层)原样带着。"""
    out: dict = {}
    for key, value in (args or {}).items():
        if key == "project":
            if not isinstance(value, str) or len(value) > 300:
                raise JobError("BAD_ARG", "project must be a string ≤ 300 chars")
            out[key] = value
        elif key == "since":
            if not isinstance(value, str) or (value and not _ISO_RE.fullmatch(value)):
                raise JobError("BAD_ARG", "since must be an ISO date/time")
            out[key] = value
        elif key == "sessions":
            if not isinstance(value, list) or len(value) > MAX_SESSIONS or not all(
                    isinstance(x, str) and _ID_RE.fullmatch(x) for x in value):
                raise JobError("BAD_ARG", f"sessions must be ≤ {MAX_SESSIONS} session ids")
            out[key] = value
        elif key == "feedback_overlay":
            if not isinstance(value, dict) or len(json.dumps(value, ensure_ascii=False).encode()) > MAX_OVERLAY_BYTES:
                raise JobError("BAD_ARG", "feedback_overlay must be an object ≤ 20 MiB")
            out[key] = value
        elif key == "dry_run":
            if not isinstance(value, bool):
                raise JobError("BAD_ARG", "dry_run must be true/false")
            out[key] = value
        elif key == "max_tasks":
            out[key] = _typed(key, value, int, lambda v: 1 <= v <= 200)
        elif key == "limit":
            out[key] = _typed(key, value, int, lambda v: 1 <= v <= 5000)
        elif key == "backend":
            out[key] = _typed(key, value, str, lambda v: v in ("claude", "mock"))
        elif key == "model":
            out[key] = _typed(key, value, str, lambda v: 0 < len(v) <= 80 and _model_ok(v))
        else:
            raise JobError("BAD_ARG", f"unknown harvest argument {key!r}")
    if "sessions" not in out:
        # 白名单必须显式给:不给 = 读服务器上所有人的 transcript,API 上不允许这样失败放开
        raise JobError("BAD_ARG", "sessions (the whitelist of readable session ids) is required")
    return out


def check_release_args(args: dict) -> dict:
    out: dict = {}
    for key, value in (args or {}).items():
        if key == "staging":
            if not isinstance(value, str) or not _SID_RE.fullmatch(value):
                raise JobError("BAD_ARG", "staging must be a staging id like 20260923-101500")
            out[key] = value
        elif key in RELEASE_KEYS or key == "max_minutes":
            _flag, typ, ok = ARG_SPEC[key]
            out[key] = _typed(key, value, typ, ok)
        else:
            raise JobError("BAD_ARG", f"unknown release-eval argument {key!r}")
    if "staging" not in out:
        raise JobError("BAD_ARG", "staging is required")
    return out


def build_argv(python: str, work_dir: Path, tasks_file: Path, progress_file: Path, args: dict) -> list[str]:
    """Validate the API args and turn them into a ``whet train`` command line."""
    argv = [python, "-m", "skillwhet", "train", str(work_dir), "--tasks", str(tasks_file),
            "--progress", str(progress_file)]
    for key, value in (args or {}).items():
        if key in FLAG_SPEC:
            if not isinstance(value, bool):
                raise JobError("BAD_ARG", f"{key} must be true/false")
            if value:
                argv.append(FLAG_SPEC[key])
            continue
        if key not in ARG_SPEC:
            raise JobError("BAD_ARG", f"unknown training argument {key!r}")
        flag, typ, ok = ARG_SPEC[key]
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise JobError("BAD_ARG", f"{key}: wrong type")
        try:
            cast = typ(value)
        except (TypeError, ValueError) as exc:
            raise JobError("BAD_ARG", f"{key}: {exc}") from exc
        if not ok(cast):  # type: ignore[operator]
            raise JobError("BAD_ARG", f"{key}={value!r} is out of range")
        argv += [flag, str(cast)]
    return argv


class JobStore:
    def __init__(self, home: Path, *, work_root: Path, tasks_root: Path,
                 python: str | None = None, env: dict[str, str] | None = None,
                 start_worker: bool = True, transcripts: Path | None = None) -> None:
        self.home = Path(home)
        self.transcripts = Path(transcripts or os.environ.get("SKILLWHET_TRANSCRIPTS")
                                or Path.home() / ".claude" / "projects").expanduser()
        self.root = self.home / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.work_root, self.tasks_root = Path(work_root), Path(tasks_root)
        self.python = python or sys.executable
        self.env = dict(env or os.environ)
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._procs: dict[str, subprocess.Popen] = {}
        self._stopping = False
        # 作业结束后的收尾钩子(serve 用它校正受管记录),返回要记进 job.warnings 的话
        self.after_run = None
        self.recover()
        self._worker = threading.Thread(target=self._loop, name="whet-jobs", daemon=True)
        if start_worker:
            self._worker.start()

    # ── persistence ────────────────────────────────────────────────────
    def dir(self, job_id: str) -> Path:
        return self.root / job_id

    def _write(self, job: Job) -> None:
        d = self.dir(job.id)
        d.mkdir(parents=True, exist_ok=True)
        tmp = d / "state.json.tmp"
        tmp.write_text(json.dumps(job.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, d / "state.json")

    def get(self, job_id: str) -> Job:
        p = self.dir(job_id) / "state.json"
        if not p.exists() or "/" in job_id or job_id in (".", ".."):
            raise JobError("JOB_NOT_FOUND", f"no job {job_id!r}", 404)
        return Job.from_dict(json.loads(p.read_text(encoding="utf-8")))

    def list(self, skill: str | None = None, limit: int = 100, since: str | None = None) -> list[Job]:
        """最新的在前。``since``(ISO,UTC)只要创建时间不早于它的 —— 目录按 id(= 创建时间)倒序,
        走到更早的就停,当日额度这类按日期的统计不再受 limit 截断(hl,静态 P3)。"""
        out: list[Job] = []
        if not self.root.is_dir():
            return out
        for d in sorted(self.root.iterdir(), reverse=True):
            p = d / "state.json"
            if not p.exists():
                continue
            try:
                job = Job.from_dict(json.loads(p.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
            if since and (job.created_at or "") < since:
                break
            if skill and job.skill != skill:
                continue
            out.append(job)
            if len(out) >= limit:
                break
        return out

    def recover(self) -> list[str]:
        """A serve restart orphans whatever was running: mark it, never re-run it."""
        marked: list[str] = []
        for job in self.list(limit=10_000):
            if job.state == "running":
                job.state = "interrupted"
                job.finished_at = _now()
                job.error = "serve restarted while the job was running"
                job.cost_usd = self._cost_so_far(job.id)
                if job.pid:
                    _kill_pid_if_ours(job.pid)
                self._write(job)
                marked.append(job.id)
        return marked

    def _cost_so_far(self, job_id: str) -> float | None:
        """没跑到 done 的作业(取消 / 失败 / 中断)花了多少:把各轮 round_end 的 cost_usd 加起来。
        没有任何一轮结束就是 None(调用方按预算上限保守计)。"""
        try:
            rounds = [e for e in read_events(self.dir(job_id) / "progress.jsonl", 0, 5000) if e.get("kind") == "round_end"]
        except Exception:  # noqa: BLE001
            return None
        if not rounds:
            return None
        return round(sum(float(e.get("cost_usd") or 0) for e in rounds), 4)

    # ── API ─────────────────────────────────────────────────────────────
    def create(self, kind: str, skill: str, args: dict | None, *, tags: list[str] | None = None,
               origin: str = "manual") -> tuple[Job, int]:
        if kind not in KINDS:
            raise JobError("BAD_KIND", f"kind must be one of {', '.join(KINDS)}")
        work_dir = self.work_root / skill
        if not (work_dir / "SKILL.md").exists():
            raise JobError("NOT_MANAGED", f"no managed copy of {skill!r}", 404)
        if kind == "harvest":
            return self._enqueue(kind, skill, check_harvest_args(args or {}), tags, origin)
        if kind == "release_eval":
            ra = check_release_args(args or {})
            from .staging import release_consumed
            sdir = work_dir / ".evo" / "staging" / ra["staging"]
            if not (sdir / "manifest.json").exists():
                raise JobError("STAGING_NOT_FOUND", f"no staging {ra['staging']!r} for {skill!r}", 404)
            if (sdir / "adopted.json").exists():
                raise JobError("ALREADY_ADOPTED", f"staging {ra['staging']} is already adopted; nothing to compare", 409)
            if release_consumed(work_dir, sdir) or (self.home / "releases" / skill / f"{ra['staging']}.json").exists():
                raise JobError("TEST_CONSUMED", f"the test split was already used for staging {ra['staging']}", 409)
            tasks_file = self.tasks_root / skill / "all.json"
            try:
                n_test = sum(1 for t in json.loads(tasks_file.read_text(encoding="utf-8")).get("tasks", [])
                             if t.get("split") == "test")
            except (OSError, ValueError):
                n_test = 0
            if n_test == 0:
                raise JobError("NO_TEST_TASKS", f"{skill!r} has no test-split tasks to release-evaluate on", 409)
            return self._enqueue(kind, skill, ra, tags, origin)
        if not (work_dir / ".evo" / "baseline").exists():
            raise JobError("NOT_BOOTSTRAPPED", f"{skill!r} is not bootstrapped — freeze S0 first", 409)
        tasks_file = self.tasks_root / skill / "all.json"
        if not tasks_file.exists():
            raise JobError("NO_TASKS", f"{skill!r} has no task set — import one first", 409)
        try:
            n_tasks = len(json.loads(tasks_file.read_text(encoding="utf-8")).get("tasks", []))
        except (OSError, ValueError):
            n_tasks = 0
        if n_tasks == 0:
            raise JobError("NO_TASKS", f"{skill!r} has an empty task set", 409)
        # validate now, so a bad arg is a 400 at submit time, not a failed job later
        build_argv(self.python, work_dir, tasks_file, self.root / "_validate" / "progress.jsonl", args or {})
        return self._enqueue(kind, skill, dict(args or {}), tags, origin)

    def _enqueue(self, kind: str, skill: str, args: dict, tags: list[str] | None,
                 origin: str) -> tuple[Job, int]:
        job_id = f"job_{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}_{secrets.token_hex(2)}"
        # 大块参数(会话白名单、反馈叠加层)落文件,state.json 里只留个数
        blobs: dict[str, object] = {}
        for key in ("sessions", "feedback_overlay"):
            if key in args:
                blobs[key] = args.pop(key)
                args[f"{key}_count"] = len(blobs[key])  # type: ignore[arg-type]
        with self._lock:
            # 同一 skill、同一种作业不能同时有两个活的(训练和挖任务可以并存排队)
            live = [j for j in self.list(skill=skill, limit=10_000)
                    if j.state in LIVE_STATES and (j.kind or "train") == kind]
            if live:
                raise JobError("JOB_DUPLICATE", f"{skill!r} already has {kind} job {live[0].id} ({live[0].state})",
                               409, job_id=live[0].id)
            job = Job(id=job_id, kind=kind, skill=skill, args=args, tags=list(tags or []),
                      created_at=_now(), origin=origin)
            d = self.dir(job_id)
            d.mkdir(parents=True, exist_ok=True)
            for key, value in blobs.items():
                if key == "feedback_overlay":
                    # hl(动态 P2-18):叠加层(用户的备注 / 期望输出)原文落盘 —— 落盘前先脱敏,
                    # 与 harvest 读 transcript 时同一套规则
                    from .harvest import redact_obj
                    value = redact_obj(value)
                (d / f"{key}.json").write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
            self._write(job)
            self._mark_pending(job)
            position = sum(1 for j in self.list(limit=10_000) if j.state == "queued" and j.id < job_id)
        self._wake.set()
        return job, position

    def result(self, job_id: str) -> dict:
        """harvest:挖出来的会话清单与任务;release_eval:那份 staging 的 release.json。"""
        job = self.get(job_id)
        if job.kind == "harvest":
            p = self.dir(job_id) / "result.json"
        elif job.kind == "release_eval":
            rec = self.release_record(job.skill, str(job.args.get("staging")))
            if rec is None:
                raise JobError("NO_RESULT", f"job {job_id} has no result yet ({job.state})", 409)
            return rec
        else:
            raise JobError("NO_RESULT", f"{job.kind} jobs have no result document; see /progress and staging", 409)
        if not p.exists():
            raise JobError("NO_RESULT", f"job {job_id} has no result yet ({job.state})", 409)
        return json.loads(p.read_text(encoding="utf-8"))

    def release_record(self, skill: str, sid: str) -> dict | None:
        """serve 自己的留出集记录(在 serve 的 home 里,副本里的代码摸不到那一层 —— 采纳时认这一份)。"""
        p = self.home / "releases" / skill / f"{sid}.json"
        if not p.exists():
            return None
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def _keep_release(self, job: Job) -> None:
        sid = str(job.args.get("staging") or "")
        src = self.work_root / job.skill / ".evo" / "staging" / sid / "release.json"
        try:
            data = json.loads(src.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        if not isinstance(data, dict):
            return
        dst = self.home / "releases" / job.skill
        dst.mkdir(parents=True, exist_ok=True)
        (dst / f"{sid}.json").write_text(json.dumps({**data, "job_id": job.id}, ensure_ascii=False, indent=2),
                                         encoding="utf-8")

    def _argv(self, job: Job) -> tuple[list[str], Path]:
        d = self.dir(job.id)
        work_dir = self.work_root / job.skill
        tasks_file = self.tasks_root / job.skill / "all.json"
        if job.kind == "harvest":
            a = job.args
            argv = [self.python, "-m", "skillwhet", "harvest", "--transcripts", str(self.transcripts),
                    "--skill", job.skill, "--out", "", "--json-out", str(d / "result.json"),
                    "--progress", str(d / "progress.jsonl"),
                    "--limit", str(a.get("limit", 200)), "--max-tasks", str(a.get("max_tasks", 40)),
                    "--backend", str(a.get("backend", "claude"))]
            if a.get("model"):
                argv += ["--model", str(a["model"])]
            if a.get("project"):
                argv.append(f"--project={a['project']}")      # = 形式:以 - 开头的值不会被当成 flag
            if a.get("since"):
                argv.append(f"--since={a['since']}")
            if "sessions_count" in a:
                if not (d / "sessions.json").exists():
                    raise JobError("BAD_ARG", "the session whitelist file of this job is missing — refusing to read everything")
                argv += ["--sessions", str(d / "sessions.json")]
            if (d / "feedback_overlay.json").exists():
                argv += ["--feedback", str(d / "feedback_overlay.json")]
            if a.get("dry_run"):
                argv.append("--dry-run")
            return argv, d
        if job.kind == "release_eval":
            argv = [self.python, "-m", "skillwhet", "release-eval", str(work_dir), "--staging", str(job.args["staging"]),
                    "--tasks", str(tasks_file), "--progress", str(d / "progress.jsonl")]
            for key in RELEASE_KEYS:
                if key in job.args:
                    argv.append(f"{ARG_SPEC[key][0]}={job.args[key]}")
            return argv, work_dir
        return build_argv(self.python, work_dir, tasks_file, d / "progress.jsonl", job.args), work_dir

    def cancel(self, job_id: str) -> Job:
        # hl(动态 P1-9):取消全程持 _lock。原来排队态取消不拿锁,worker 拿锁改 running 后又用旧对象
        # 把 cancelled 盖回 running;_procs 在写 pid 之后才登记,cancel 找不到进程就跳过 kill ——
        # 刚创建就取消的作业 4 次里 3 次照跑到 done。现在:状态翻转与 kill 都在锁内,worker 在
        # Popen 之后先登记 _procs 再重读 state,已 cancelled 就立即 kill(见 _run)。
        with self._lock:
            job = self.get(job_id)
            if job.state == "queued":
                job.state, job.finished_at = "cancelled", _now()
                job.cost_usd = 0.0          # 从未跑起来:不占额度(静态 P2-23)
                self._write(job)
                self._release_pending(job)
                return job
            if job.state != "running":
                raise JobError("JOB_NOT_LIVE", f"job {job_id} is {job.state}", 409)
            # 先落 cancelled 再杀:worker 收尾时以 state.json 为准,不会把它改回 running / done
            job.state, job.finished_at = "cancelled", _now()
            self._write(job)
            proc = self._procs.get(job_id)
        if proc is not None:
            _kill(proc)
        return self.get(job_id)

    def progress(self, job_id: str, after: int = 0, limit: int = 500) -> list[dict]:
        self.get(job_id)
        return read_events(self.dir(job_id) / "progress.jsonl", after=after, limit=limit)

    def log_tail(self, job_id: str, lines: int = 200) -> str:
        self.get(job_id)
        p = self.dir(job_id) / "stdout.log"
        if not p.exists():
            return ""
        data = p.read_bytes()[-256 * 1024:]
        return "\n".join(data.decode("utf-8", "replace").splitlines()[-max(1, min(lines, 2000)):])

    def queue_position(self, job_id: str) -> int | None:
        job = self.get(job_id)
        if job.state != "queued":
            return None
        return sum(1 for j in self.list(limit=10_000) if j.state == "queued" and j.id < job_id)

    def stop(self) -> None:
        """serve 停机(SIGTERM / Ctrl-C):杀掉运行中的作业进程组,并把它记成 interrupted。

        hl(动态 P3):原来只杀进程,worker 收尾时看到 rc=-SIGTERM 记成 cancelled ——
        和用户主动取消混在一起,续跑提示也就不对。stop 本身在锁内直接落 interrupted,
        worker 线程是 daemon,来不及写也无妨。"""
        self._stopping = True
        self._wake.set()
        with self._lock:
            procs = dict(self._procs)
            for job_id in procs:
                try:
                    job = self.get(job_id)
                except JobError:
                    continue
                if job.state == "running":
                    job.state, job.finished_at = "interrupted", _now()
                    job.error = "serve stopped while the job was running"
                    job.cost_usd = self._cost_so_far(job.id)
                    self._write(job)
        for proc in procs.values():
            _kill(proc)

    # ── worker ──────────────────────────────────────────────────────────
    def _next(self) -> Job | None:
        queued = [j for j in self.list(limit=10_000) if j.state == "queued"]
        queued.sort(key=lambda j: j.id)
        return queued[0] if queued else None

    def _loop(self) -> None:
        while not self._stopping:
            job = self._next()
            if job is None:
                self._wake.wait(timeout=2.0)
                self._wake.clear()
                continue
            try:
                self._run(job)
            except Exception as exc:  # noqa: BLE001 — 一个作业出错不能把整条队伍卡死
                try:
                    cur = self.get(job.id)
                    if cur.state in ("queued", "running"):
                        cur.state, cur.finished_at, cur.error = "failed", _now(), f"worker error: {exc}"
                        cur.cost_usd = self._cost_so_far(job.id)
                        self._write(cur)
                except Exception:  # noqa: BLE001
                    pass

    def _run(self, job: Job) -> None:
        d = self.dir(job.id)
        d.mkdir(parents=True, exist_ok=True)
        argv, work_dir = self._argv(job)
        (d / "args.json").write_text(json.dumps({"argv": argv, "args": job.args}, ensure_ascii=False, indent=2),
                                     encoding="utf-8")
        with self._lock:
            # 排队期间可能已被取消:拿锁再看一眼,别把 cancelled 盖成 running
            if self.get(job.id).state != "queued":
                return
            job.state, job.started_at = "running", _now()
            self._write(job)
        # 墙钟兜底:训练器只在轮末检查 --max-minutes,一个卡住的后端调用会占住唯一的 worker
        max_minutes = float(job.args.get("max_minutes") or 0) or 24 * 60
        deadline_s = max_minutes * 60 * 1.5 + 300
        with (d / "stdout.log").open("ab") as log:
            try:
                proc = subprocess.Popen(  # noqa: S603 — argv built from a whitelist above
                    argv, cwd=str(work_dir), stdout=log, stderr=subprocess.STDOUT,
                    env=self.env, start_new_session=True,
                )
            except OSError as exc:
                with self._lock:
                    cur = self.get(job.id)
                    if cur.state == "running":
                        cur.state, cur.finished_at, cur.error, cur.cost_usd = "failed", _now(), f"spawn failed: {exc}", 0.0
                        self._write(cur)
                self._release_pending(job)
                return
            with self._lock:
                # hl(动态 P1-9):先登记进程、再以 state.json 为准写 pid —— 不能用本地旧对象覆盖
                # (cancel 可能已经在锁内把它翻成 cancelled);翻了就立即杀,不让训练器跑下去
                self._procs[job.id] = proc
                current = self.get(job.id)
                current.pid = job.pid = proc.pid
                self._write(current)
                cancelled_early = current.state == "cancelled"
            if cancelled_early:
                _kill(proc)
            timed_out = False
            try:
                try:
                    rc = proc.wait(timeout=deadline_s)
                except subprocess.TimeoutExpired:
                    timed_out = True
                    _kill(proc)
                    rc = proc.wait()
            finally:
                self._procs.pop(job.id, None)
        # 静态 P1-11 / 复核 P2-1:作业代码能改任何副本的 import.json —— 以 serve 的记录为准校正(钩子由 serve 装)
        warnings: list[str] = []
        if self.after_run is not None:
            try:
                warnings = list(self.after_run() or [])
            except Exception as exc:  # noqa: BLE001 — 校正失败不能让作业状态停在 running
                warnings = [f"record resync failed: {exc}"]
        self._release_pending(job)
        # 进度文件在锁外读(可能几 MB);判定 + 最后一次写在锁内,且尊重锁内看到的最新状态(复核 P3:
        # 原来最后一次写不在锁内,子进程刚退出时来的取消先回 cancelled、随后被 done 盖掉)
        events = self.progress(job.id, 0, 5000)
        done = next((e for e in reversed(events) if e.get("kind") == "done"), None)
        err = next((e for e in reversed(events) if e.get("kind") == "error"), None)
        with self._lock:
            current = self.get(job.id)
            if warnings:
                current.warnings = [*(current.warnings or []), *warnings]
            current.rc, current.finished_at = rc, _now()
            if current.state in ("cancelled", "interrupted"):
                # cancel / stop 已经在锁内落了终态:只补 rc 与费用,不改状态;Popen 后立刻被杀的一分钱没花
                current.cost_usd = 0.0 if cancelled_early else self._cost_so_far(job.id)
                self._write(current)
                return
            if timed_out:
                current.state, current.error = "failed", f"wall-clock limit hit ({deadline_s:.0f}s); killed"
                current.cost_usd = self._cost_so_far(job.id)
                self._write(current)
                return
            if done is not None:
                current.stop_reason = done.get("stop_reason")
                current.improved = bool(done.get("improved"))
                current.cost_usd = done.get("cost_usd")
                current.staging = done.get("staging")
            if rc == 0 and done is not None:
                current.state = "done"
                if current.kind == "harvest":
                    current.improved = None
                    current.staging = None
                if current.kind == "release_eval":
                    self._keep_release(current)
            elif rc == -signal.SIGTERM or rc == -signal.SIGKILL:
                current.state = "cancelled"
            else:
                current.state = "failed"
                current.error = (err or {}).get("message") or f"exit code {rc}; see stdout.log"
            if current.cost_usd is None:
                current.cost_usd = self._cost_so_far(job.id)
            self._write(current)

    # ── 复核 P3:排队中的留出集评估占住它要评的那份 staging(未接受 staging 的清理会跳过它)──
    PENDING = "release.pending"

    def _staging_dir(self, job: Job) -> Path | None:
        sid = str((job.args or {}).get("staging") or "")
        return self.work_root / job.skill / ".evo" / "staging" / sid if sid else None

    def _mark_pending(self, job: Job) -> None:
        sdir = self._staging_dir(job)
        if job.kind == "release_eval" and sdir is not None and sdir.is_dir():
            (sdir / self.PENDING).write_text(job.id, encoding="utf-8")

    def _release_pending(self, job: Job) -> None:
        sdir = self._staging_dir(job)
        if job.kind == "release_eval" and sdir is not None:
            try:
                if (sdir / self.PENDING).read_text(encoding="utf-8") == job.id:
                    (sdir / self.PENDING).unlink()
            except OSError:
                pass

def _kill_pid_if_ours(pid: int) -> None:
    """serve 重启后收拾上一代留下的训练进程组:只杀 cmdline 里确实是 skillwhet train 的。"""
    try:
        cmd = Path(f"/proc/{pid}/cmdline").read_bytes().replace(b"\0", b" ")
    except OSError:
        return
    parts = cmd.split()
    if b"skillwhet" not in parts or not ({b"train", b"harvest", b"release-eval"} & set(parts)):
        return
    try:
        os.killpg(pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        pass


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _kill(proc: subprocess.Popen) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        return
    deadline = time.monotonic() + TERM_GRACE_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.1)
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass
