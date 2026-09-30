"""Evidence layer: tasks in, splits, execution records, failure clustering.

Two rules from the literature are enforced here rather than left to discipline:

  * A task with no checkable reference is DISCARDED, never given a fabricated
    one. skillopt_sleep's heuristic miner produced ``reference_kind="none"``
    records and consequently had no gate signal at all.
  * Splits are assigned by a stable hash of the task id, so val/test membership
    cannot drift between rounds, and synthetic tasks are pinned to train so they
    can never pollute the held-out slices.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterable, Literal

Split = Literal["train", "val", "test"]
ReferenceKind = Literal["exact", "rubric", "rule", "none"]

# Judge operators, split by what they can actually detect.
SHAPE_OPS = {"section_present", "section_contains", "max_chars", "min_chars"}
OUTCOME_OPS = {"contains", "not_contains", "no_refusal", "regex", "tool_called"}
KNOWN_OPS = SHAPE_OPS | OUTCOME_OPS


@dataclass
class TaskRecord:
    id: str
    intent: str
    context_excerpt: str = ""
    system: str = ""
    outcome: Literal["success", "fail", "mixed", "unknown"] = "unknown"
    reference_kind: ReferenceKind = "none"
    reference: str = ""
    judge: dict = field(default_factory=dict)
    split: Split = "train"
    origin: Literal["real", "synthetic"] = "real"
    skill_hint: str = ""
    source_sessions: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    # ha:同一族的任务(同一会话的重试、同一模板的变体)永远落在同一个 split 里,
    # 免得 train 里见过的题换个数字就进了 val / test(ha S3-02)。空 = 自成一族。
    family_id: str = ""

    @property
    def checkable(self) -> bool:
        return self.reference_kind != "none"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> TaskRecord:
        known = {f for f in cls.__dataclass_fields__}
        return cls(**{k: v for k, v in d.items() if k in known})


def is_shape_only(judge: dict) -> bool:
    checks = judge.get("checks") or []
    ops = {c.get("op") for c in checks if isinstance(c, dict)}
    return bool(ops) and ops <= SHAPE_OPS


def validate_judge(judge: dict) -> list[str]:
    """Return warnings. A shape-only judge is legal but must be flagged."""
    warns: list[str] = []
    checks = judge.get("checks") or []
    if not checks:
        return ["judge has no checks"]
    for c in checks:
        op = c.get("op")
        if op not in KNOWN_OPS:
            warns.append(f"unknown op {op!r} — it always fails, so it tests nothing "
                         f"and the task can never pass")
        elif op in {"max_chars", "min_chars"}:
            try:
                int(c.get("arg"))
            except (TypeError, ValueError):
                warns.append(f"{op} needs an integer arg, got {c.get('arg')!r}")
        elif op == "regex":
            try:
                re.compile(str(c.get("arg", "")))
            except re.error as exc:
                warns.append(f"invalid regex {c.get('arg')!r}: {exc}")
    if is_shape_only(judge):
        warns.append(
            "judge is shape-only (formatting checks); it can be satisfied by "
            "reformatting rather than by a better answer"
        )
    return warns


# ── Splits ──────────────────────────────────────────────────────────────────


def assign_splits(
    tasks: list[TaskRecord], *, val_fraction: float = 0.25,
    test_fraction: float = 0.25, seed: int = 42,
) -> list[TaskRecord]:
    if not 0 <= val_fraction <= 1 or not 0 <= test_fraction <= 1:
        raise ValueError("fractions must lie in [0, 1]")
    if val_fraction + test_fraction >= 1:
        raise ValueError("val + test must leave room for train")

    val_cut = round(val_fraction * 100)
    test_cut = val_cut + round(test_fraction * 100)

    for t in tasks:
        if t.origin == "synthetic":
            t.split = "train"          # synthetic can never enter val/test
            continue
        key = t.family_id or t.id
        bucket = int(hashlib.sha256(f"{seed}:{key}".encode()).hexdigest(), 16) % 100
        t.split = "val" if bucket < val_cut else "test" if bucket < test_cut else "train"

    real = [t for t in tasks if t.origin == "real"]
    if len(real) >= 2 and not any(t.split == "val" for t in real):
        promo = next((t for t in real if t.split == "train"), None)
        if promo is not None:
            fam = promo.family_id
            for t in real:                      # 整族一起升,不拆家
                if t is promo or (fam and t.family_id == fam):
                    t.split = "val"
    # 按族分以后,小任务集可能一个 train 都不剩(一族全进了 test / val):挪一族回 train
    if real and not any(t.split == "train" for t in real):
        fams: dict[str, list[TaskRecord]] = {}
        for t in real:
            fams.setdefault(t.family_id or t.id, []).append(t)
        if len(fams) >= 2:
            val_fams = {k for k, v in fams.items() if v[0].split == "val"}
            pick = next((k for k, v in fams.items() if v[0].split == "test"), None)
            if pick is None and len(val_fams) >= 2:
                pick = sorted(val_fams)[0]
            for t in fams.get(pick, []):
                t.split = "train"
    return tasks


def split_counts(tasks: Iterable[TaskRecord]) -> dict[str, int]:
    return dict(Counter(t.split for t in tasks))


def load_tasks(path: Path) -> list[TaskRecord]:
    """Load a task file, dropping uncheckable records loudly."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    raw = data["tasks"] if isinstance(data, dict) else data
    tasks, dropped = [], 0
    for d in raw:
        t = TaskRecord.from_dict(d)
        if not t.checkable:
            dropped += 1
            continue
        tasks.append(t)
    if dropped:
        print(f"[evidence] dropped {dropped} task(s) with reference_kind=none "
              f"(no checkable signal; a fabricated reference is worse than none)")
    return tasks


def save_tasks(path: Path, tasks: list[TaskRecord]) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(
        {"format": "skillwhet.tasks.v1", "tasks": [t.to_dict() for t in tasks]},
        ensure_ascii=False, indent=2,
    ), encoding="utf-8")
    return p


# ── Execution records ───────────────────────────────────────────────────────


@dataclass
class ExecRecord:
    """One task executed under one skill version."""

    task_id: str
    split: Split
    hard: float = 0.0
    soft: float = 0.0
    passed: bool = False
    exc_type: str = ""
    exc_message: str = ""
    top_frame: str = ""          # "module.py:func:line"
    module: str = ""
    symbol: str = ""
    stdout: str = ""
    duration_ms: float = 0.0
    # The evaluation itself failed (simulated user never raised a key intent,
    # judge call errored): the record says nothing about the skill and must be
    # excluded from every numerator AND denominator downstream (audit C7).
    noise: bool = False
    # What actually happened, for the attributor: [{role, text}, ...] — the
    # prompt the agent saw, its answer, the judge's reasoning, dialogue turns.
    trajectory: list = field(default_factory=list)

    @property
    def scored(self) -> bool:
        return not (self.noise or self.exc_type == "EvalNoise")

    def to_dict(self) -> dict:
        return asdict(self)


_FRAME = re.compile(r'File "(?P<file>[^"]+)", line (?P<line>\d+), in (?P<func>\S+)')
# pytest's own style, used as a fallback when --tb=native is unavailable
_PYTEST_FRAME = re.compile(
    r"^(?P<file>[\w./\\-]+\.py):(?P<line>\d+):(?:\s+in\s+(?P<func>\S+))?\s*$",
    re.MULTILINE,
)
# "TypeError: expected string or bytes-like object" — must be at column 0
_EXC_LINE = re.compile(
    r"^(?P<type>[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning))"
    r"(?::\s*(?P<msg>.*))?$",
    re.MULTILINE,
)


_CAPTURED = re.compile(r"^-{3,} Captured .* -{3,}\s*$", re.MULTILINE)


def _in_skill(path: str, skill_dir: Path | None) -> str:
    """'scripts/<rel>' when *path* is a script inside the skill, else ''.

    Decided relative to *skill_dir*, not by the substring "scripts/" anywhere
    in an absolute path — a skill checked out under ~/scripts/... made every
    test and site-packages frame look like skill code (audit C11).
    """
    p = path.replace("\\", "/")
    if skill_dir is not None:
        try:
            rel = Path(p).resolve().relative_to(Path(skill_dir).resolve())
        except (ValueError, OSError):
            rel = Path(p) if not Path(p).is_absolute() else None
        if rel is not None and rel.parts and rel.parts[0] == "scripts" \
                and not ({"site-packages", "dist-packages", ".venv"} & set(rel.parts)):
            return rel.as_posix()
        return ""
    # no skill_dir: best effort, but still refuse obvious third-party paths
    if "site-packages" in p or "dist-packages" in p or "/.venv/" in p:
        return ""
    return "scripts/" + p.split("/scripts/")[-1] if "/scripts/" in p else (
        p if p.startswith("scripts/") else "")


def parse_traceback(text: str, *, skill_dir: Path | None = None) -> ExecRecord:
    """Extract exception type, message and the deepest in-skill frame.

    The deepest frame *inside the skill* is what matters: the last frame overall
    is often inside the stdlib, which is not where the defect lives.
    """
    rec = ExecRecord(task_id="", split="train")
    # Captured stdout/stderr sections are not part of the traceback: a script
    # that PRINTS "KeyError: ..." must not override the real exception (C12).
    cap = _CAPTURED.search(text)
    body = text[:cap.start()] if cap else text
    frames = list(_FRAME.finditer(body)) or list(_PYTEST_FRAME.finditer(body))
    picked = None
    for m in frames:
        if _in_skill(m.group("file"), skill_dir):
            picked = m
    if picked is None and frames:
        picked = frames[-1]
    if picked is not None:
        path = picked.group("file").replace("\\", "/")
        inside = _in_skill(path, skill_dir)
        rec.module = inside or Path(path).name
        mod = inside.split("scripts/", 1)[-1] if inside else Path(path).name
        rec.symbol = picked.group("func") or ""
        rec.top_frame = f"{mod}:{rec.symbol}:{picked.group('line')}"
    # The exception line is the LAST one in the traceback body — after the
    # last frame, never one that merely appears earlier in a chained trace.
    tail = body[frames[-1].end():] if frames else body
    hits = list(_EXC_LINE.finditer(tail)) or list(_EXC_LINE.finditer(body))
    if hits:
        m = hits[-1] if not frames else hits[0]
        rec.exc_type = m.group("type").split(".")[-1]
        rec.exc_message = (m.group("msg") or "").strip()[:300]
    return rec


# ── Failure clustering (deterministic, zero LLM) ────────────────────────────


@dataclass
class FailureCluster:
    key: str
    exc_type: str
    top_frame: str
    module: str
    symbol: str
    count: int
    task_ids: list[str] = field(default_factory=list)
    sample_message: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def cluster_failures(records: Iterable[ExecRecord]) -> list[FailureCluster]:
    """Group by (exc_type, top_frame, module), ranked by frequency.

    No embeddings and no model call: a stack trace already carries a precise,
    machine-comparable identity. This is the credit-assignment advantage code
    has over prose, and spending an LLM call here would throw it away.
    """
    buckets: dict[tuple[str, str, str], list[ExecRecord]] = {}
    for r in records:
        if r.passed:
            continue
        buckets.setdefault((r.exc_type, r.top_frame, r.module), []).append(r)

    out = []
    for (exc, frame, module), rs in buckets.items():
        out.append(FailureCluster(
            key=hashlib.sha256(f"{exc}|{frame}|{module}".encode()).hexdigest()[:12],
            exc_type=exc, top_frame=frame, module=module,
            symbol=rs[0].symbol, count=len(rs),
            task_ids=[r.task_id for r in rs][:20],
            sample_message=rs[0].exc_message,
        ))
    out.sort(key=lambda c: (-c.count, c.key))
    return out


# ── Test → skill-symbol resolution (deterministic) ──────────────────────────
#
# A "wrong result" defect surfaces as an AssertionError whose deepest frame is
# the TEST, not the script: the traceback names nobody in scripts/. The first
# real-model run on a skill with such defects routed them to the evaluator,
# which said "code_defect" — and P2 then tried to edit the test file. The test
# itself says which skill function it exercises; read it.

def _test_function(skill_dir: Path, node_id: str):
    """(source text, ast.FunctionDef, module ast) for a pytest node id, or None."""
    import ast as _ast
    parts = node_id.split("::")
    if len(parts) < 2:
        return None
    path = Path(skill_dir) / parts[0]
    if not path.is_file():
        return None
    try:
        src = path.read_text(encoding="utf-8")
        tree = _ast.parse(src)
    except (OSError, SyntaxError):
        return None
    name = parts[-1].split("[")[0]
    for node in _ast.walk(tree):
        if isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)) and node.name == name:
            return src, node, tree
    return None


def test_source(skill_dir: Path, node_id: str) -> str:
    """Source of the test function behind a node id ('' if unknown)."""
    import ast as _ast
    got = _test_function(skill_dir, node_id)
    if got is None:
        return ""
    src, node, _tree = got
    return _ast.get_source_segment(src, node) or ""


def test_targets(skill_dir: Path, node_id: str) -> list[tuple[str, str]]:
    """Skill symbols a test calls, as (module rel path, symbol), in call order."""
    import ast as _ast
    got = _test_function(skill_dir, node_id)
    if got is None:
        return []
    _src, node, tree = got
    bound: dict[str, tuple[str, str]] = {}          # local name -> (module, symbol)
    mod_alias: dict[str, str] = {}                  # local name -> module rel path
    for n in _ast.walk(tree):
        if isinstance(n, _ast.ImportFrom) and n.module and n.module.startswith("scripts"):
            rel = n.module.replace(".", "/") + ".py"
            for a in n.names:
                if a.name == "*":
                    continue
                bound[a.asname or a.name] = (rel, a.name)
        elif isinstance(n, _ast.Import):
            for a in n.names:
                if a.name.startswith("scripts."):
                    mod_alias[a.asname or a.name] = a.name.replace(".", "/") + ".py"
    out: list[tuple[str, str]] = []
    for call in _ast.walk(node):
        if not isinstance(call, _ast.Call):
            continue
        f = call.func
        if isinstance(f, _ast.Name) and f.id in bound:
            hit = bound[f.id]
        elif isinstance(f, _ast.Attribute) and isinstance(f.value, _ast.Name) \
                and f.value.id in mod_alias:
            hit = (mod_alias[f.value.id], f.attr)
        else:
            continue
        if hit not in out:
            out.append(hit)
    return out

