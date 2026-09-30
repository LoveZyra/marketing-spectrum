"""Result cache for expensive runners (REVIEW §1.10).

Every accepted bundle triggers a full re-run of the train tasks; with an agent
runner that is one model call per task per acceptance. The outcome of a task
under a skill is a pure function of (skill content, task, runner), so it is
memoised on exactly that key. pytest runs are cheap and never cached — their
outcome also depends on the sandbox, which the key does not capture.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from pathlib import Path

from .evidence import ExecRecord, TaskRecord
from .fs import iter_skill_files


def skill_digest(skill_dir: Path) -> str:
    """Content hash of everything that can influence a roll-out."""
    h = hashlib.sha256()
    for p in iter_skill_files(skill_dir):
        rel = p.relative_to(Path(skill_dir)).as_posix()
        if rel.startswith(("tests/contract/",)) or rel.endswith((".pyc",)):
            continue
        h.update(rel.encode("utf-8"))
        h.update(b"\0")
        h.update(p.read_bytes())
        h.update(b"\0")
    return h.hexdigest()[:20]


def _task_digest(t: TaskRecord) -> str:
    body = json.dumps({"id": t.id, "intent": t.intent, "context": t.context_excerpt,
                       "system": t.system, "ref": t.reference, "kind": t.reference_kind,
                       "judge": t.judge}, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


class RunCache:
    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.hits = 0
        self.misses = 0
        try:
            self._data: dict[str, dict] = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._data = {}

    def key(self, skill: str, runner: str, t: TaskRecord) -> str:
        return f"{runner}|{skill}|{_task_digest(t)}"

    def get(self, key: str) -> ExecRecord | None:
        d = self._data.get(key)
        if d is None:
            return None
        known = ExecRecord.__dataclass_fields__
        return ExecRecord(**{k: v for k, v in d.items() if k in known})

    def put(self, key: str, rec: ExecRecord) -> None:
        self._data[key] = asdict(rec)

    def flush(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, ensure_ascii=False), encoding="utf-8")


class CachedRunner:
    """Wrap any runner; identical (skill, task) pairs are answered from disk.

    Evaluation noise is never cached — a noisy verdict must not become a
    permanent one.
    """

    def __init__(self, inner, cache: RunCache) -> None:
        self.inner = inner
        self.cache = cache
        self.name = getattr(inner, "name", "runner")

    def run(self, skill_dir: Path, tasks: list[TaskRecord]) -> list[ExecRecord]:
        digest = skill_digest(skill_dir)
        keys = {t.id: self.cache.key(digest, self.name, t) for t in tasks}
        got: dict[str, ExecRecord] = {}
        todo: list[TaskRecord] = []
        for t in tasks:
            rec = self.cache.get(keys[t.id])
            if rec is None:
                todo.append(t)
            else:
                rec.task_id, rec.split = t.id, t.split
                got[t.id] = rec
                self.cache.hits += 1
                from .progress import task_done
                task_done(rec)                    # hd:命中缓存的也算"跑完了一条"
        if todo:
            self.cache.misses += len(todo)
            for rec in self.inner.run(skill_dir, todo):
                got[rec.task_id] = rec
                if rec.scored:
                    self.cache.put(keys[rec.task_id], rec)
            self.cache.flush()
        return [got[t.id] for t in tasks if t.id in got]
