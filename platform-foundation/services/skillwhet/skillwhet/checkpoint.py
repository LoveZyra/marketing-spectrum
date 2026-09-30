"""he (0.5.0): round-boundary checkpoints so an interrupted run can continue.

A run writes ``.evo/checkpoint.json`` at the end of every *completed* round: the
baseline it measured, the answers of the last accepted state, the candidate list,
the anchor (last accepted snapshot) and the round reports so far. A crash, a
cancel or a serve restart in the middle of round r loses round r only — ``train
--resume`` restores the working copy from the anchor and continues at r.

A checkpoint only applies to the same run: same task set, same managed copy, same
S0, same training configuration (rounds and the platform stops may differ — they
bound the run, they do not change what a round does). Anything else and the
resume falls back to a fresh run, and says why in the progress stream. A run that
reaches staging deletes its checkpoint.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import asdict
from pathlib import Path

from .cache import _task_digest, skill_digest
from .evidence import TaskRecord

VERSION = 1
FILE = "checkpoint.json"
# Bounds of the run, not its behaviour: a resume may change these.
_CFG_FREE = {"rounds", "max_cost_usd", "max_minutes", "no_accept_rounds", "resume"}


def data_key(tasks: list[TaskRecord], live_dir: Path, baseline_dir: Path) -> str:
    h = hashlib.sha256()
    for t in sorted(tasks, key=lambda x: x.id):
        h.update(f"{_task_digest(t)}:{t.split}\n".encode("utf-8"))
    h.update(skill_digest(live_dir).encode("utf-8"))
    if Path(baseline_dir).exists():
        h.update(skill_digest(baseline_dir).encode("utf-8"))
    return h.hexdigest()[:24]


def cfg_key(cfg, extra: dict | None = None) -> str:
    d = {k: v for k, v in asdict(cfg).items() if k not in _CFG_FREE}
    d["_run"] = extra or {}
    return hashlib.sha256(json.dumps(d, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:24]


def path(evo: Path) -> Path:
    return Path(evo) / FILE


def save(evo: Path, state: dict) -> None:
    p = path(evo)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"version": VERSION, "saved_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                               **state}, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def load(evo: Path) -> dict | None:
    p = path(evo)
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and d.get("version") == VERSION else None


def clear(evo: Path) -> None:
    try:
        path(evo).unlink()
    except FileNotFoundError:
        pass


def why_not(ck: dict | None, *, data: str, cfg: str, evo: Path) -> str:
    """Empty string when ``ck`` can be resumed; otherwise the reason it cannot."""
    if ck is None:
        return "no checkpoint (the previous run did not finish a round)"
    if ck.get("data_key") != data:
        return "the task set, the managed copy or S0 changed since the checkpoint"
    if ck.get("cfg_key") != cfg:
        return "the training configuration changed since the checkpoint"
    for name in [ck.get("anchor"), *[c[1] for c in ck.get("candidates", [])]]:
        if name and not (Path(evo) / name).is_dir():
            return f"snapshot {name} of the checkpointed run is gone"
    return ""


def info(skill_dir: Path, tasks: list[TaskRecord]) -> dict:
    """For the platform: is there a checkpoint, from which round, and does it still
    match the copy and the task set (the configuration is checked at resume time)."""
    evo = Path(skill_dir) / ".evo"
    ck = load(evo)
    if ck is None:
        return {"exists": False}
    matches = ck.get("data_key") == data_key(tasks, skill_dir, evo / "baseline")
    return {"exists": True, "round": ck.get("round"), "saved_at": ck.get("saved_at"),
            "job_rounds": ck.get("rounds_planned"), "matches": matches}
