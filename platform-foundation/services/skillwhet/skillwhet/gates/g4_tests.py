"""G4/G5 — test gates.

G4 runs ``tests/unit`` (visible to the optimizer).
G5 runs ``tests/holdout`` (never shown to the optimizer, never editable by it).

Both are the same mechanism with a different directory and a different
contract with the optimizer, which is exactly the SpecBench point: the gap
between the two is the reward-hacking signal.
"""
from __future__ import annotations

from pathlib import Path

from .. import pytestio
from ..sandbox import SandboxPolicy, run_sandboxed
from ..types import GateResult, Verdict
from .base import BaseGate, Candidate, missing_tool_reason, tool_available


def _run_pytest(skill_dir: Path, subdir: str, *, tb: str, timeout_s: int,
                wall: int) -> tuple[int, str, bool]:
    """Sandboxed pytest. Returns (rc, combined output, degraded)."""
    args = pytestio.argv(subdir, tb=tb, timeout_s=timeout_s)
    res = run_sandboxed(args, Path(skill_dir), SandboxPolicy(wall_timeout_s=wall))
    out = (res.stdout or "") + "\n" + (res.stderr or "")
    if pytestio.rejected_timeout(out):
        res = run_sandboxed(pytestio.strip_timeout(args), Path(skill_dir),
                            SandboxPolicy(wall_timeout_s=wall))
        out = (res.stdout or "") + "\n" + (res.stderr or "")
    return res.returncode, out, bool(getattr(res, "degraded", False))


def collect_test_status(skill_dir: Path, subdir: str = "tests/unit",
                        timeout_s: int = 30) -> dict[str, bool]:
    """node id → passed, for the suite as it stands. Used as the gate baseline."""
    tdir = Path(skill_dir) / subdir
    if not tdir.is_dir():
        return {}
    _rc, out, _ = _run_pytest(skill_dir, subdir, tb="no", timeout_s=timeout_s, wall=300)
    return pytestio.status_map(out)


class PytestGate(BaseGate):
    cost = "cheap"

    def __init__(self, subdir: str, name: str, *, timeout_s: int = 30,
                 workers: str = "auto", overall_timeout: int = 300) -> None:
        self.subdir = subdir
        self.name = name
        self.timeout_s = timeout_s
        self.workers = workers
        self.overall_timeout = overall_timeout

    def run(self, cand: Candidate) -> GateResult:
        return self._timed(self._run, cand)

    def _baseline(self, cand: Candidate) -> dict[str, bool] | None:
        """Only this gate's own suite. Merging unit and hold-out baselines made
        G4 see every passing hold-out test as "regressed" (audit A1)."""
        if cand.baseline_tests is None:
            return None
        prefix = self.subdir.rstrip("/") + "/"
        return {t: ok for t, ok in cand.baseline_tests.items() if t.startswith(prefix)}

    def _run(self, cand: Candidate) -> GateResult:
        tdir = cand.skill_dir / self.subdir
        if not tdir.is_dir() or not any(tdir.rglob("test_*.py")):
            # hb:测试平铺在 tests/ 下的 skill(marketing-audit 就是)原来只看到一句"没有测试"
            flat = sorted(p.name for p in (cand.skill_dir / "tests").glob("test_*.py")) \
                if self.subdir == "tests/unit" and (cand.skill_dir / "tests").is_dir() else []
            if flat:
                return self.skip(f"no tests in {self.subdir}; {len(flat)} test file(s) sit directly in tests/ "
                                 f"— move them to tests/unit/ for G4 and the pytest runner to see them")
            return self.skip(f"no tests in {self.subdir}")
        if not tool_available("pytest"):
            # hl(动态 P2-19):缺 pytest 不是"通过",是"没查";detail 带 missing_tool 让整体不算 PASS
            return self.skip(missing_tool_reason("pytest"), missing_tools=["pytest"])

        # The candidate's tests run under the same sandbox as everything else in
        # the fast loop: no network, no inherited secrets, rlimits (audit A6).
        rc, out, degraded = _run_pytest(cand.skill_dir, self.subdir, tb="short",
                                        timeout_s=self.timeout_s,
                                        wall=self.overall_timeout)
        passed, failed, errors = pytestio.counts(out)
        verdicts = pytestio.parse_verbose(out)
        status = pytestio.status_map(out)
        detail = {
            "rc": rc, "passed": passed, "failed": failed, "errors": errors,
            "subdir": self.subdir, "sandbox_degraded": degraded,
        }

        # Collection errors / crashes: absolute failure regardless of mode.
        if not pytestio.collectable(rc, out):
            tail = out.strip().splitlines()[-5:]
            return self.fail([self.finding("pytest-crashed", " | ".join(tail)[:300])],
                             **detail)

        base = self._baseline(cand)
        if base is not None:
            # RELATIVE: reject only regressions. Still-red tests are for later
            # candidates; a suite that was 2/4 and is now 3/4 must land.
            regressed = [t for t, ok in base.items() if ok and not status.get(t, False)]
            repaired = [t for t, ok in base.items() if not ok and status.get(t, False)]
            # Every FAILED/ERROR the run reported must be a test we know about;
            # otherwise the parser missed something and "no regression" is a guess.
            unexplained = (failed + errors) - sum(1 for v in verdicts.values()
                                                  if v in ("FAILED", "ERROR"))
            detail.update({"mode": "relative", "regressed": regressed,
                           "repaired": repaired, "still_red": failed,
                           "unexplained_failures": max(0, unexplained)})
            if regressed:
                return self.fail([self.finding("test-regressed", t[:220]) for t in regressed],
                                 **detail)
            if unexplained > 0:
                return self.fail([self.finding(
                    "test-unaccounted",
                    f"{unexplained} failure(s) not attributable to a node id")], **detail)
            return GateResult(gate=self.name, verdict=Verdict.PASS, detail=detail)

        detail["mode"] = "absolute"
        if rc == 0:
            return GateResult(gate=self.name, verdict=Verdict.PASS, detail=detail)
        findings = [self.finding("test-failed", t[:220])
                    for t, ok in status.items() if not ok] or [
            self.finding("pytest-failed", " | ".join(out.strip().splitlines()[-5:])[:300])]
        return self.fail(findings, **detail)


def unit_gate(**kw) -> PytestGate:
    return PytestGate("tests/unit", "G4.unit", **kw)


def holdout_gate(**kw) -> PytestGate:
    return PytestGate("tests/holdout", "G5.holdout", **kw)
