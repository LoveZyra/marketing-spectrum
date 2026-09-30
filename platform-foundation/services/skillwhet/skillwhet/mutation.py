"""Mutation testing — a deterministic measure of whether tests test anything.

The four hard rules in test evolution stop the optimiser from *weakening* tests.
They do nothing about a subtler failure: tests that never tested anything to
begin with (assert-no-exception, assert-not-None). Mutation score answers that
without a single model call, and it is the code-side antidote to the shape-only
judge problem.

Used as an ADMISSION FLOOR, never as an objective. The moment mutation score is
something to maximise, the optimiser starts writing tests that exist only to
kill mutants.
"""
from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path

import libcst as cst

from .edits import snapshot
from .sandbox import SandboxPolicy, run_sandboxed

DEFAULT_FLOOR = 0.60


@dataclass
class Mutant:
    module: str
    symbol: str
    line: int
    kind: str
    killed: bool = False


@dataclass
class MutationReport:
    total: int = 0
    killed: int = 0
    survivors: list[Mutant] = field(default_factory=list)
    skipped: str = ""

    @property
    def score(self) -> float:
        return self.killed / self.total if self.total else 0.0

    def meets(self, floor: float = DEFAULT_FLOOR) -> bool:
        return self.total == 0 or self.score >= floor

    def to_dict(self) -> dict:
        return {
            "total": self.total, "killed": self.killed,
            "score": round(self.score, 4), "skipped": self.skipped,
            "survivors": [
                {"module": m.module, "symbol": m.symbol, "line": m.line,
                 "kind": m.kind} for m in self.survivors[:20]
            ],
        }


_COMPARISON_FLIP = {
    cst.GreaterThan: cst.LessThanEqual, cst.LessThan: cst.GreaterThanEqual,
    cst.GreaterThanEqual: cst.LessThan, cst.LessThanEqual: cst.GreaterThan,
    cst.Equal: cst.NotEqual, cst.NotEqual: cst.Equal,
}


class _Mutator(cst.CSTTransformer):
    """Apply exactly the n-th mutation found, leaving everything else intact."""

    def __init__(self, target_index: int) -> None:
        self.target = target_index
        self.seen = 0
        self.applied: tuple[str, int] | None = None

    def _take(self, kind: str) -> bool:
        hit = self.seen == self.target
        if hit:
            self.applied = (kind, 0)
        self.seen += 1
        return hit

    def leave_Comparison(self, orig: cst.Comparison, updated: cst.Comparison):
        if len(updated.comparisons) != 1:
            return updated
        op = type(updated.comparisons[0].operator)
        if op not in _COMPARISON_FLIP:
            return updated
        if not self._take(f"comparison:{op.__name__}"):
            return updated
        flipped = updated.comparisons[0].with_changes(operator=_COMPARISON_FLIP[op]())
        return updated.with_changes(comparisons=[flipped])

    def leave_Integer(self, orig: cst.Integer, updated: cst.Integer):
        raw = updated.value.replace("_", "")
        low = raw.lower()
        # Non-decimal literals are re-emitted in their own base; a mutant that
        # is byte-identical to the source would survive for free (audit A16).
        try:
            if low.startswith("0x"):
                new = f"0x{int(raw, 16) + 1:x}"
            elif low.startswith("0o"):
                new = f"0o{int(raw, 8) + 1:o}"
            elif low.startswith("0b"):
                new = f"0b{int(raw, 2) + 1:b}"
            else:
                new = str(int(raw) + 1)
        except ValueError:
            return updated
        if not self._take("integer"):
            return updated
        return cst.Integer(value=new)

    def leave_Name(self, orig: cst.Name, updated: cst.Name):
        if updated.value not in ("True", "False"):
            return updated
        if not self._take(f"boolean:{updated.value}"):
            return updated
        return cst.Name("False" if updated.value == "True" else "True")


def count_mutations(source: str) -> int:
    m = _Mutator(-1)
    cst.parse_module(source).visit(m)
    return m.seen


def mutate(source: str, index: int) -> tuple[str, str] | None:
    m = _Mutator(index)
    out = cst.parse_module(source).visit(m)
    if m.applied is None:
        return None
    return out.code, m.applied[0]


def run_mutation(
    skill_dir: Path,
    modules: list[str],
    *,
    tests_subdir: str = "tests/unit",
    work_root: Path | None = None,
    max_mutants: int = 24,
    policy: SandboxPolicy | None = None,
) -> MutationReport:
    """Sample mutants across *modules* and see how many the tests kill.

    Sampled, not exhaustive: this is the most expensive deterministic check in
    the system, so it runs only over the functions a round actually touched.
    """
    skill_dir = Path(skill_dir)
    work_root = Path(work_root or skill_dir / ".evo" / "work")
    policy = policy or SandboxPolicy(wall_timeout_s=120)
    rep = MutationReport()

    if not (skill_dir / tests_subdir).is_dir():
        rep.skipped = f"no tests in {tests_subdir}"
        return rep

    plan: list[tuple[str, int]] = []
    for mod in modules:
        p = skill_dir / mod
        if not p.exists():
            continue
        try:
            n = count_mutations(p.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        plan += [(mod, i) for i in range(n)]
    if not plan:
        rep.skipped = "no mutable constructs found"
        return rep

    # A mutant is "killed" only if a test that was GREEN on the unmutated code
    # turns red. Counting any non-zero exit made every mutant look caught the
    # moment the suite had one unrelated red test (audit A8).
    from . import pytestio
    base = run_sandboxed(pytestio.argv(tests_subdir, tb="no"), skill_dir, policy)
    base_out = (base.stdout or "") + "\n" + (base.stderr or "")
    if pytestio.rejected_timeout(base_out):
        base = run_sandboxed(pytestio.strip_timeout(pytestio.argv(tests_subdir, tb="no")),
                             skill_dir, policy)
        base_out = (base.stdout or "") + "\n" + (base.stderr or "")
    green = {t for t, ok in pytestio.status_map(base_out).items() if ok}
    if not pytestio.collectable(base.returncode, base_out) or not green:
        rep.skipped = "no green tests to kill mutants with"
        return rep

    step = max(1, len(plan) // max_mutants)
    for mod, idx in plan[::step][:max_mutants]:
        src = (skill_dir / mod).read_text(encoding="utf-8")
        got = mutate(src, idx)
        if got is None:
            continue
        mutated, kind = got
        try:
            ast.parse(mutated)
        except SyntaxError:
            continue

        work = work_root / f"mut-{abs(hash((mod, idx)))%10**8}"
        try:
            cand = snapshot(skill_dir, work)
            (cand / mod).write_text(mutated, encoding="utf-8")
            res = run_sandboxed(pytestio.argv(tests_subdir, tb="no"), cand, policy)
            out = (res.stdout or "") + "\n" + (res.stderr or "")
            if pytestio.rejected_timeout(out):
                res = run_sandboxed(pytestio.strip_timeout(pytestio.argv(tests_subdir, tb="no")),
                                    cand, policy)
                out = (res.stdout or "") + "\n" + (res.stderr or "")
            after = pytestio.status_map(out)
            killed = res.returncode in (0, 1) and any(not after.get(t, True) for t in green)
        finally:
            import shutil
            shutil.rmtree(work, ignore_errors=True)

        rep.total += 1
        if killed:
            rep.killed += 1
        else:
            rep.survivors.append(Mutant(module=mod, symbol="", line=idx, kind=kind))
    return rep
