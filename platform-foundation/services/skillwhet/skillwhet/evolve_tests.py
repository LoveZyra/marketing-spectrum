"""Test evolution, with the constraints that stop it from being reward hacking.

Code optimisation uses tests as its judge; tests also have to grow. If the same
optimiser could touch both in the same step it would discover that weakening a
test is far cheaper than fixing code — that is how SpecBench's 2,900-line
hash-table "compiler" that memorised its inputs came to exist.

Four rules, three of them enforced deterministically here:

  1. tests and code never move in the same STEP: the test phase runs with the
     code frozen, and the code optimizer cannot write under tests/ at all
     (edits.editable_path) — enforced structurally, not by schedule
  2. tests only grow: removing or weakening an assertion is a HARD reject
  3. a new test is admitted only if it is RED on the current code — red meaning
     collected and failed, not "pytest exited non-zero"
  4. hold-out tests are never touched by this module at all
"""
from __future__ import annotations

import ast
import json
from dataclasses import dataclass, field
from pathlib import Path

from . import pytestio
from .backend import Backend, extract_json
from .sandbox import SandboxPolicy, run_sandboxed
from .types import FailureSignal


# ── Rule 2: monotonicity check (deterministic) ──────────────────────────────

@dataclass
class TestShape:
    """What a test file asserts, in a form that can be compared across versions."""

    functions: dict[str, int] = field(default_factory=dict)   # test name -> assert count
    raises: dict[str, int] = field(default_factory=dict)      # test name -> pytest.raises count


class _Counter(ast.NodeVisitor):
    def __init__(self) -> None:
        self.asserts = 0
        self.raises = 0

    def visit_Assert(self, node: ast.Assert) -> None:
        self.asserts += 1
        self.generic_visit(node)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            src = ast.unparse(item.context_expr)
            if "raises(" in src:
                self.raises += 1
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        # unittest-style self.assert* counts too
        f = node.func
        if isinstance(f, ast.Attribute) and f.attr.startswith("assert"):
            self.asserts += 1
        self.generic_visit(node)


def test_shape(source: str) -> TestShape:
    shape = TestShape()
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return shape
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and \
                node.name.startswith("test"):
            c = _Counter()
            c.visit(node)
            shape.functions[node.name] = c.asserts
            shape.raises[node.name] = c.raises
    return shape


@dataclass
class Weakening:
    file: str
    test: str
    kind: str          # removed | fewer-asserts | fewer-raises
    before: int
    after: int

    def __str__(self) -> str:
        return f"{self.file}::{self.test} {self.kind} ({self.before} -> {self.after})"


def check_monotonic(before_dir: Path, after_dir: Path,
                    subdir: str = "tests/unit") -> list[Weakening]:
    """Every test that existed must still exist with at least as many assertions.

    This is the whole anti-reward-hacking guarantee for the test side, so it is
    an AST comparison rather than a prompt instruction.
    """
    out: list[Weakening] = []
    bdir = Path(before_dir) / subdir
    if not bdir.is_dir():
        return out
    for bp in sorted(bdir.rglob("test_*.py")):
        rel = bp.relative_to(Path(before_dir)).as_posix()
        ap = Path(after_dir) / rel
        before = test_shape(bp.read_text(encoding="utf-8"))
        if not ap.exists():
            for name, n in before.functions.items():
                out.append(Weakening(rel, name, "removed", n, 0))
            continue
        after = test_shape(ap.read_text(encoding="utf-8"))
        for name, n in before.functions.items():
            if name not in after.functions:
                out.append(Weakening(rel, name, "removed", n, 0))
            elif after.functions[name] < n:
                out.append(Weakening(rel, name, "fewer-asserts", n, after.functions[name]))
            elif after.raises.get(name, 0) < before.raises.get(name, 0):
                out.append(Weakening(rel, name, "fewer-raises",
                                     before.raises[name], after.raises.get(name, 0)))
    return out


# ── Rule 3: a new test must be red ──────────────────────────────────────────

def _is_red(skill_dir: Path, rel_path: str) -> bool:
    """Red = pytest COLLECTED the module and at least one test FAILED.

    A module that errors at import used to count as red, and once admitted it
    broke collection for the whole suite on every later run (audit B6).
    """
    res = run_sandboxed(
        pytestio.argv(rel_path, tb="line"),
        skill_dir, SandboxPolicy(wall_timeout_s=60),
    )
    out = (res.stdout or "") + "\n" + (res.stderr or "")
    if not pytestio.collectable(res.returncode, out):
        return False
    return any(v == "FAILED" for v in pytestio.parse_verbose(out).values())


# ── Proposal ────────────────────────────────────────────────────────────────

_SYSTEM = """You add ONE pytest test to an agent skill's test suite, covering an
observed failure mode that the suite does not yet exercise.

Rules:
- The test must FAIL on the current code (it documents a real, unfixed defect).
  If the failure mode is already covered, reply {"already_covered": true}.
- Assert an OUTCOME (a value, an exception, a side effect), not formatting.
- Import from `scripts.<module>` via
  `sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))`.
- Do not modify or reference any existing test.

Return JSON only:
{"filename": "test_<short_name>.py",
 "source": "<complete test module, imports included>",
 "covers": "<one line: which failure mode>"}
or {"already_covered": true}"""


@dataclass
class TestEvolutionResult:
    added: list[str] = field(default_factory=list)
    rejected_green: list[str] = field(default_factory=list)
    rejected_weakening: list[str] = field(default_factory=list)
    skipped: int = 0

    def to_dict(self) -> dict:
        return {"added": self.added, "rejected_green": self.rejected_green,
                "rejected_weakening": self.rejected_weakening, "skipped": self.skipped}


def evolve_tests(
    skill_dir: Path,
    signals: list[FailureSignal],
    backend: Backend,
    *,
    budget: int = 3,
    subdir: str = "tests/unit",
    code_frozen: bool = True,
) -> TestEvolutionResult:
    """Grow the visible suite by up to *budget* red tests. Never touches hold-out.

    ``code_frozen`` is asserted by the caller's schedule (rule 1); it is taken as
    a parameter so the intent is visible at the call site.
    """
    assert code_frozen, "tests and code must not evolve in the same round"
    skill_dir = Path(skill_dir)
    tdir = skill_dir / subdir
    tdir.mkdir(parents=True, exist_ok=True)
    out = TestEvolutionResult()

    existing = "\n\n".join(
        p.read_text(encoding="utf-8")[:1500] for p in sorted(tdir.glob("test_*.py"))
    )[:6000]

    for sig in signals[:budget]:
        payload = {"failure": sig.to_dict(), "existing_tests": existing}
        try:
            raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                                   system=_SYSTEM, stage="tests.propose", max_tokens=1500)
        except Exception:  # noqa: BLE001
            out.skipped += 1
            continue
        data = extract_json(raw) or {}
        if data.get("already_covered"):
            out.skipped += 1
            continue
        fname = str(data.get("filename") or "").strip()
        src = str(data.get("source") or "").strip()
        if not fname.startswith("test_") or not fname.endswith(".py") or not src:
            out.skipped += 1
            continue
        if "/" in fname or "\\" in fname or ".." in fname:
            out.skipped += 1
            continue
        try:
            ast.parse(src)
        except SyntaxError:
            out.skipped += 1
            continue

        target = tdir / fname
        if target.exists():
            fname = fname[:-3] + f"_{abs(hash(src)) % 10_000}.py"
            target = tdir / fname
        rel = target.relative_to(skill_dir).as_posix()
        target.write_text(src + "\n", encoding="utf-8")

        # Rule 3: it has to be red, or it carries no information.
        if not _is_red(skill_dir, rel):
            target.unlink()
            out.rejected_green.append(rel)
            continue
        out.added.append(rel)
    return out
