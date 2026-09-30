"""Task-set import: validate user-supplied JSON / JSONL / CSV and map rows to ``TaskRecord``.

The upload schema is the one the workbench page speaks (``input`` / ``expected_output`` …);
``TaskRecord`` is what the trainer speaks. The mapping is deliberately explicit —
a row with no checkable reference is refused here, not silently dropped later.

Rules (mirrored by the browser-side validator, re-applied here because the
client's "passed" flag is never trusted):
  * ≤ 5 MiB, ≤ 5,000 rows;
  * ``input`` (alias ``prompt``) required;
  * a reference: ``expected_output`` (alias ``output``; ``0``, ``false`` and
    ``null`` are legitimate expected values — presence of the key is what counts),
    or a non-empty ``rubric`` string;
  * ``task_id`` unique within the file (generated from the input when absent);
  * ``split`` if given must be train / val / test (``learn``→train, ``dev``→val,
    ``release``/``critical``→test are accepted aliases).
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .evidence import TaskRecord, assign_splits, validate_judge

MAX_BYTES = 5 * 1024 * 1024
MAX_ROWS = 5000
SPLIT_ALIASES = {"train": "train", "learn": "train", "val": "val", "dev": "val",
                 "test": "test", "release": "test", "critical": "test", "holdout": "test"}
CSV_JSON_COLUMNS = ("input", "prompt", "expected_output", "output", "checks", "context", "metadata")


class ImportError_(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass
class RowResult:
    row: int
    task_id: str
    ok: bool
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    reference_kind: str = ""
    family: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ImportReport:
    format: str
    rows: list[RowResult]
    passed: int
    failed: int
    tasks: list[TaskRecord]

    def to_dict(self, *, with_tasks: bool = False) -> dict:
        d = {"format": self.format, "passed": self.passed, "failed": self.failed,
             "rows": [r.to_dict() for r in self.rows]}
        if with_tasks:
            d["tasks"] = [t.to_dict() for t in self.tasks]
        return d


# ── parsing ─────────────────────────────────────────────────────────────────

def parse_rows(content: str, fmt: str) -> list[dict]:
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise ImportError_("TOO_BIG", f"file exceeds {MAX_BYTES // (1024 * 1024)} MiB")
    fmt = (fmt or "json").lower()
    rows: list[dict]
    if fmt == "json":
        try:
            data = json.loads(content)
        except json.JSONDecodeError as exc:
            raise ImportError_("BAD_JSON", f"invalid JSON at line {exc.lineno}: {exc.msg}") from exc
        if isinstance(data, dict) and isinstance(data.get("tasks"), list):
            data = data["tasks"]
        if not isinstance(data, list):
            raise ImportError_("BAD_JSON", "top level must be a JSON array (or {\"tasks\": [...]})")
        rows = data
    elif fmt == "jsonl":
        rows = []
        for n, line in enumerate(content.splitlines(), 1):
            if not line.strip():
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise ImportError_("BAD_JSONL", f"line {n}: {exc.msg}") from exc
    elif fmt == "csv":
        reader = csv.DictReader(io.StringIO(content))
        rows = []
        for raw in reader:
            row: dict = {}
            for k, v in raw.items():
                if k is None:
                    continue
                k = k.strip()
                # hl(动态 P2-16):可选列留空(CSV 里就是空串)当缺省,不能让 split '' / checks '' 判整行失败
                if v is None or (isinstance(v, str) and v.strip() == "" and k not in ("input", "prompt")):
                    continue
                if k in CSV_JSON_COLUMNS and isinstance(v, str) and v[:1] in "{[":
                    try:
                        v = json.loads(v)
                    except json.JSONDecodeError:
                        pass
                elif k in ("expected_output", "output") and isinstance(v, str):
                    low = v.strip().lower()
                    if low in ("0", "false", "null", "true") or _is_number(v):
                        v = json.loads(low if low in ("false", "null", "true") else v.strip())
                row[k] = v
            rows.append(row)
    else:
        raise ImportError_("BAD_FORMAT", f"unknown format {fmt!r} (json | jsonl | csv)")
    if len(rows) > MAX_ROWS:
        raise ImportError_("TOO_MANY_ROWS", f"more than {MAX_ROWS} rows")
    if not all(isinstance(r, dict) for r in rows):
        raise ImportError_("BAD_ROW", "every row must be an object")
    return rows


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


# ── validation + mapping ───────────────────────────────────────────────────

def _text(v) -> str:
    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False, sort_keys=True)


def _gen_id(skill: str, intent: str, n: int) -> str:
    return "u_" + hashlib.sha256(f"{skill}::{n}::{intent}".encode()).hexdigest()[:12]


def validate_and_map(rows: list[dict], *, skill: str, fmt: str, tags: list[str] | None = None,
                     assign: bool = True) -> ImportReport:
    results: list[RowResult] = []
    tasks: list[TaskRecord] = []
    seen_ids: dict[str, int] = {}
    provided_split = False
    for n, row in enumerate(rows, 1):
        errs, warns = [], []
        raw_input = row.get("input", row.get("prompt"))
        if raw_input is None or (isinstance(raw_input, str) and not raw_input.strip()):
            errs.append("缺 input / prompt")
        has_expected = "expected_output" in row or "output" in row
        rubric = row.get("rubric")
        rubric_ok = isinstance(rubric, str) and len(rubric.strip()) >= 8
        if not has_expected and not rubric_ok:
            errs.append("缺 expected_output(0 / false / null 都算合法值)或 rubric(≥ 8 字)")
        tid = row.get("task_id") or row.get("id")
        if tid is not None and not isinstance(tid, str):
            tid = str(tid)
        if tid and tid in seen_ids:
            errs.append(f"task_id 重复(与第 {seen_ids[tid]} 行相同)")
        split = row.get("split")
        if split is not None:
            provided_split = True
            if not isinstance(split, str) or split.lower() not in SPLIT_ALIASES:
                errs.append(f"split 只能是 train / val / test(收到 {split!r})")
        judge: dict = {}
        checks = row.get("checks")
        if checks is not None:
            if not isinstance(checks, list) or not all(isinstance(c, dict) for c in checks):
                errs.append("checks 必须是对象数组")
            else:
                judge = {"kind": "rule", "checks": checks}
                warns.extend(validate_judge(judge))
        family = row.get("group_id") or row.get("family_id") or ""
        if family and not isinstance(family, str):
            family = str(family)
        # hl(动态 P3):记录自带的 tags(反馈→任务带的 project: / user: / source:feedback)原来被丢掉
        row_tags = [t for t in (row.get("tags") or []) if isinstance(t, str) and t] if isinstance(row.get("tags"), list) else []
        intent = _text(raw_input) if raw_input is not None else ""
        if tid:
            seen_ids.setdefault(tid, n)
        else:
            tid = _gen_id(skill, intent, n)
        ref_kind = ""
        if not errs:
            if has_expected:
                expected = row["expected_output"] if "expected_output" in row else row["output"]
                ref_kind, reference = "exact", _text(expected)
            else:
                ref_kind, reference = "rubric", rubric.strip()
            ctx = row.get("context")
            t = TaskRecord(
                id=tid, intent=intent,
                context_excerpt=_text(ctx) if ctx is not None else "",
                outcome=row.get("outcome") if row.get("outcome") in ("success", "fail", "mixed", "unknown") else "unknown",
                reference_kind=ref_kind, reference=reference, judge=judge,
                split=SPLIT_ALIASES[split.lower()] if isinstance(split, str) else "train",
                origin="real", skill_hint=skill,
                source_sessions=list(row.get("source_sessions") or []),
                tags=list(dict.fromkeys([*(tags or []), *row_tags, *([f"family:{family}"] if family else []), f"import:{fmt}"])),
                family_id=family,
            )
            tasks.append(t)
        results.append(RowResult(row=n, task_id=tid, ok=not errs, errors=errs, warnings=warns,
                                 reference_kind=ref_kind, family=family))
    if assign and tasks and not provided_split:
        assign_splits(tasks)
    return ImportReport(format=fmt, rows=results, passed=sum(1 for r in results if r.ok),
                        failed=sum(1 for r in results if not r.ok), tasks=tasks)


# ── storage: <home>/tasks/<skill>/ ─────────────────────────────────────────

class TaskStore:
    def __init__(self, home: Path) -> None:
        self.root = Path(home) / "tasks"

    def dir(self, skill: str) -> Path:
        from .managed import validate_name
        return self.root / validate_name(skill)

    def add(self, skill: str, tasks: list[TaskRecord], *, source: str = "upload") -> dict:
        """Append a batch and rebuild ``all.json`` (dedup by id; later batches win)."""
        import time
        d = self.dir(skill)
        d.mkdir(parents=True, exist_ok=True)
        # 同一族以前已经在库里:沿用它的 split,不能这批进 train、上批在 test(ha 审计 #8)
        known: dict[str, str] = {}
        if (d / "all.json").exists():
            try:
                for row in json.loads((d / "all.json").read_text(encoding="utf-8")).get("tasks", []):
                    if row.get("family_id") and row.get("split"):
                        known.setdefault(row["family_id"], row["split"])
            except (OSError, ValueError):
                known = {}
        for t in tasks:
            if t.family_id and t.family_id in known and t.origin != "synthetic":
                t.split = known[t.family_id]  # type: ignore[assignment]
        # hl(动态 P2-17):同一秒内两批,原来 batch-…-2.json 排在 batch-….json 前面,rebuild 按字典序
        # "后者胜"就反了。批名带微秒 + 两位补零序号,字典序 = 时间序;新批一定排在老批之后
        p = self._next_batch_path(d)
        p.write_text(json.dumps({"format": "skillwhet.tasks.v1", "source": source,
                                 "tasks": [t.to_dict() for t in tasks]}, ensure_ascii=False, indent=2),
                     encoding="utf-8")
        merged = self.rebuild(skill)
        return {"batch": p.name, "added": len(tasks), "total": len(merged)}

    @staticmethod
    def _next_batch_path(d: Path) -> Path:
        now = time.time()
        stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(now)) + f".{int((now % 1) * 1_000_000):06d}"
        n = 1
        while True:
            p = d / f"batch-{stamp}-{n:02d}.json"
            if not p.exists():
                return p
            n += 1

    @staticmethod
    def _batch_order(p: Path) -> tuple:
        """批文件的稳定排序键:老格式 batch-YYYYmmdd-HHMMSS[-n] 与新格式 batch-…-HHMMSS.ffffff-nn 混排时
        按 (秒级时间戳, 微秒, 序号) 比,序号按整数比(-2 与 -10 不再按字符串错序)。"""
        import re
        m = re.match(r"batch-(\d{8}-\d{6})(?:\.(\d{1,6}))?(?:-(\d+))?\.json$", p.name)
        if not m:
            return ("", 0, 0, p.name)
        return (m.group(1), int(m.group(2) or 0), int(m.group(3) or 0), p.name)

    def batches(self, skill: str) -> list[Path]:
        return sorted(self.dir(skill).glob("batch-*.json"), key=self._batch_order)

    def retire(self, skill: str, beside: Path) -> str | None:
        """hl(动态 P2-13):副本移除时任务集一起搬走(放到退役副本旁边 `<moved>.tasks/`),不删。"""
        d = self.dir(skill)
        if not d.is_dir():
            return None
        target = Path(beside).with_name(Path(beside).name + ".tasks")
        n = 2
        while target.exists():
            target = Path(beside).with_name(f"{Path(beside).name}.tasks-{n}")
            n += 1
        import shutil
        shutil.move(str(d), str(target))
        return str(target)

    def rebuild(self, skill: str) -> list[TaskRecord]:
        d = self.dir(skill)
        by_id: dict[str, TaskRecord] = {}
        for p in self.batches(skill):
            data = json.loads(p.read_text(encoding="utf-8"))
            for row in data.get("tasks", []):
                t = TaskRecord.from_dict(row)
                by_id[t.id] = t
        merged = list(by_id.values())
        (d / "all.json").write_text(json.dumps({"format": "skillwhet.tasks.v1",
                                                "tasks": [t.to_dict() for t in merged]},
                                               ensure_ascii=False, indent=2), encoding="utf-8")
        return merged

    def all(self, skill: str) -> list[TaskRecord]:
        p = self.dir(skill) / "all.json"
        if not p.exists():
            return []
        data = json.loads(p.read_text(encoding="utf-8"))
        return [TaskRecord.from_dict(r) for r in data.get("tasks", [])]

    def new_since(self, skill: str, since: float | None) -> dict:
        """he(夜训门槛):自 ``since``(epoch 秒,UTC)以来**新进库**的可判分任务有几条。

        一条任务的"进库时间"是它**第一次**出现的那一批(``batch-YYYYmmdd-HHMMSS``,UTC);
        同一 id 后来被重新导入 / 重新派生不算新。``since`` 为空 = 全部可判分任务都算新。"""
        import calendar
        import re
        first: dict[str, float] = {}
        for b in self.batches(skill):
            m = re.match(r"batch-(\d{8}-\d{6})", b.name)
            if not m:
                continue
            at = float(calendar.timegm(time.strptime(m.group(1), "%Y%m%d-%H%M%S")))
            try:
                rows = json.loads(b.read_text(encoding="utf-8")).get("tasks", [])
            except (OSError, ValueError):
                continue
            for r in rows:
                tid = str((r or {}).get("id", "")) if isinstance(r, dict) else ""
                if tid:
                    first.setdefault(tid, at)
        checkable = [t for t in self.all(skill) if t.checkable]
        # batch names have whole seconds: a batch written in the same second as ``since`` counts as new
        fresh = [t for t in checkable if since is None or first.get(t.id, 0.0) >= int(since)]
        return {"skill": skill, "checkable": len(checkable), "new_checkable": len(fresh),
                "new_by_split": {s: sum(1 for t in fresh if t.split == s) for s in ("train", "val", "test")}}

    def summary(self, skill: str | None = None) -> list[dict]:
        skills = [skill] if skill else sorted(p.name for p in self.root.iterdir() if p.is_dir()) if self.root.is_dir() else []
        out = []
        for s in skills:
            ts = self.all(s)
            batches = self.batches(s)
            # 按**现存的去重后任务**记来源(同一 id 被多批导入时,以最早那批为准);
            # 逐批累加会把重复导入算好几遍(ha:同一批会话挖两次 → harvest 翻倍)
            origin: dict[str, str] = {}
            for b in batches:
                data = json.loads(b.read_text(encoding="utf-8"))
                src = data.get("source", "upload")
                for r in data.get("tasks", []):
                    tid = str((r or {}).get("id", "")) if isinstance(r, dict) else ""
                    if tid:
                        origin.setdefault(tid, src)
            sources: dict[str, int] = {}
            for t in ts:
                src = origin.get(t.id, "upload")
                sources[src] = sources.get(src, 0) + 1
            splits = {"train": 0, "val": 0, "test": 0}
            for t in ts:
                splits[t.split] = splits.get(t.split, 0) + 1
            out.append({"skill": s, "total": len(ts), "splits": splits, "sources": sources,
                        "batches": len(batches),
                        "updated_at": max((b.stat().st_mtime for b in batches), default=0)})
        return out
