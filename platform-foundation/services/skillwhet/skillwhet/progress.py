"""Progress events for a training run — one JSON object per line, appended as it happens.

The platform (Prism) tails this file to draw the "optimisation in progress" page;
``whet train --progress <path>`` turns it on, and without the flag the trainer
behaves byte-for-byte as before (the sink is a no-op).

Every event carries a monotonically increasing ``seq`` and an ISO ``ts``; the
``kind`` vocabulary is fixed (see the implementation plan, appendix B):

    job_start · tasks_split · round_start · attribution · fast_loop · slow_loop
    · gate · governance · round_end · done · error
    hd 加:step / step_end(每一步的起止、耗时、累计调用与费用)· task(每条任务跑完)
    · proposals / candidate(提议了几个候选、每个候选过门的结果)

Bundles are summarised per phase (accepted / rejected counts + the rejecting
gates) rather than one event per candidate: a round with k=4 samples over six
clusters would otherwise emit a hundred lines nobody reads.
"""
from __future__ import annotations

import json
import os
import threading
import time
from pathlib import Path


class Progress:
    """Append-only JSONL sink. Thread-safe; never raises into the trainer."""

    def __init__(self, path: Path | None) -> None:
        self.path = Path(path) if path else None
        self.seq = 0
        self._lock = threading.Lock()
        if self.path is not None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            # resume: continue the sequence after whatever is already there
            try:
                for line in self.path.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        self.seq = max(self.seq, int(json.loads(line).get("seq", 0)))
            except (OSError, ValueError):
                self.seq = 0

    @property
    def enabled(self) -> bool:
        return self.path is not None

    def emit(self, kind: str, **fields) -> dict:
        with self._lock:
            self.seq += 1
            event = {"seq": self.seq, "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                     "kind": kind, **fields}
            if self.path is not None:
                try:
                    with self.path.open("a", encoding="utf-8") as fh:
                        fh.write(json.dumps(event, ensure_ascii=False, default=str) + "\n")
                        fh.flush()
                        os.fsync(fh.fileno())
                except OSError:
                    pass
            return event


NULL = Progress(None)


def read_events(path: Path, after: int = 0, limit: int = 500) -> list[dict]:
    """Events with ``seq > after``, oldest first, at most ``limit``."""
    p = Path(path)
    if not p.exists():
        return []
    out: list[dict] = []
    try:
        for line in p.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            # 进度文件躺在 jobs/<id>/ 下,训练子进程(以及它跑的技能代码)写得到:
            # 不是 dict、seq 不是整数的行一律跳过,别让一行坏数据把 worker 线程掀翻
            if not isinstance(ev, dict) or not isinstance(ev.get("seq"), int):
                continue
            if ev["seq"] > after:
                out.append(ev)
                if len(out) >= limit:
                    break
    except OSError:
        return []
    return out


# ── hd:训练过程里"此刻在做什么" ─────────────────────────────────────────────
# 原来一轮只有 round_start / attribution / fast_loop … 几条汇总事件,两条之间可能隔五分钟,
# 页面上只能写"训练中"。这里给训练里的每一步(跑哪批任务、归因、提议、逐个候选过门、G7 评估)
# 发 step / step_end,给每条跑完的任务发 task,给每个候选发 candidate —— 都走同一个进度文件。
# 用 ContextVar 挂在当前上下文上:runner 的线程池会复制上下文(AgentRunner 里 ctx.copy().run),
# 所以线程里跑完的任务也能上报;没绑定(CLI 不带 --progress、单测)时全部是空操作。
import contextlib
import contextvars

_CURRENT: contextvars.ContextVar = contextvars.ContextVar("skillwhet_progress", default=None)
_STEP: contextvars.ContextVar = contextvars.ContextVar("skillwhet_step", default=None)
_STEP_LOCK = threading.Lock()


def bind(progress: Progress | None, usage=None):
    """Make *progress* the sink for ``note`` / ``step`` in this context; returns a reset token.
    *usage* (optional) is a callable returning (model calls, cost_usd) so far."""
    if progress is None or not progress.enabled:
        return None
    return _CURRENT.set((progress, usage))


def unbind(token) -> None:
    if token is not None:
        _CURRENT.reset(token)


def note(kind: str, **fields) -> None:
    cur = _CURRENT.get()
    if cur is None:
        return
    try:
        cur[0].emit(kind, **fields)
    except Exception:  # noqa: BLE001 — progress must never break training
        pass


def _usage() -> dict:
    cur = _CURRENT.get()
    if cur is None or cur[1] is None:
        return {}
    try:
        calls, cost = cur[1]()
        return {"llm_calls": int(calls), "cost_usd": round(float(cost), 4)}
    except Exception:  # noqa: BLE001
        return {}


@contextlib.contextmanager
def step(name: str, **fields):
    """One visible step of the run: ``step`` when it starts, ``step_end`` (with duration,
    task tallies and running model usage) when it finishes — even if it raises."""
    if _CURRENT.get() is None:
        yield None
        return
    state = {"name": name, "n": fields.get("n"), "done": 0, "passed": 0, "round": fields.get("round")}
    token = _STEP.set(state)
    t0 = time.monotonic()
    note("step", step=name, **fields)
    try:
        yield state
    finally:
        _STEP.reset(token)
        note("step_end", step=name, round=state["round"], secs=round(time.monotonic() - t0, 1),
             done=state["done"], passed=state["passed"], **_usage())


def task_done(record) -> None:
    """Runners call this after every task roll-out (no-op outside a bound step)."""
    st = _STEP.get()
    if st is None or _CURRENT.get() is None:
        return
    with _STEP_LOCK:
        st["done"] += 1
        st["passed"] += 1 if getattr(record, "passed", False) else 0
        i = st["done"]
    why = "" if getattr(record, "passed", False) else (getattr(record, "exc_message", "") or getattr(record, "exc_type", ""))
    note("task", step=st["name"], round=st["round"], i=i, n=st["n"],
         task=str(getattr(record, "task_id", ""))[-120:], passed=bool(getattr(record, "passed", False)),
         noise=bool(getattr(record, "noise", False)), why=str(why)[:160],
         ms=int(getattr(record, "duration_ms", 0) or 0))
