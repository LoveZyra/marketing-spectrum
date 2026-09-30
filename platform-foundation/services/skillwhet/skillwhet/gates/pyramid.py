"""The gate pyramid: short-circuit evaluation, cheapest first.

The ordering is the whole architecture. A candidate reaching the expensive
gates has already survived every free one, so the rollout budget is spent on
candidates that are at least syntactically valid, safe, typed, contract-clean
and unit-tested.

Invariant enforced here: every gate in the fast loop must be zero-LLM. A gate
that needs a model call belongs in the slow loop, and ``assert_free`` will say
so loudly rather than letting the cost structure rot silently.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

from ..types import Contract, PyramidResult, Verdict
from .base import Candidate, Gate
from .g0_parse import ParseGate
from .g1_security import SecurityGate
from .g2_static import StaticGate
from .g3_contract import ContractGate
from .g4_tests import holdout_gate, unit_gate


@dataclass
class PyramidConfig:
    max_complexity: int = 10
    use_bandit: bool = True
    use_pyright: bool = True
    test_timeout_s: int = 30
    run_tests: bool = True


def build_fast_pyramid(cfg: PyramidConfig | None = None) -> list[Gate]:
    """G0-G5: everything a code candidate must pass. Zero LLM calls."""
    cfg = cfg or PyramidConfig()
    gates: list[Gate] = [
        ParseGate(),
        SecurityGate(use_bandit=cfg.use_bandit),
        StaticGate(max_complexity=cfg.max_complexity, use_pyright=cfg.use_pyright),
        ContractGate(),
    ]
    if cfg.run_tests:
        gates.append(unit_gate(timeout_s=cfg.test_timeout_s))
        gates.append(holdout_gate(timeout_s=cfg.test_timeout_s))
    return gates


def assert_free(gates: list[Gate]) -> None:
    """Fast-loop self-check: no gate may cost an LLM call.

    Design rule from the spec — if a fast-loop gate starts needing a model,
    it is misdesigned: make it deterministic or move it to the slow loop.
    """
    bad = [g.name for g in gates if getattr(g, "cost", "free") == "expensive"]
    if bad:
        raise AssertionError(
            f"fast loop must be zero-LLM, but these gates are expensive: {bad}"
        )


def run_pyramid(
    skill_dir: Path,
    contract: Contract,
    gates: list[Gate] | None = None,
    *,
    label: str = "",
    short_circuit: bool = True,
    baseline_tests: dict[str, bool] | None = None,
    baseline_findings: dict[str, list[str]] | None = None,
) -> PyramidResult:
    gates = gates if gates is not None else build_fast_pyramid()
    cand = Candidate(skill_dir=Path(skill_dir), contract=contract, label=label,
                     baseline_tests=baseline_tests)
    results = []
    t0 = time.perf_counter()
    stopped = ""
    passed = True

    for g in gates:
        res = g.run(cand)
        if baseline_findings and res.gate in baseline_findings:
            res = suppress_preexisting(res, baseline_findings[res.gate])
        results.append(res)
        if res.verdict is Verdict.FAIL:
            passed = False
            stopped = res.gate
            if short_circuit:
                break

    # hl(动态 P2-19):有门因为工具没装而没查 → missing_tools 记下来;serve 的体检接口据此把整体
    # 记成"未通过"(卡片上不能亮"六门通过")。这里的 passed 仍只看 FAIL:训练里的候选判定靠它,
    # 没装 bandit 的机器不能因此一个候选都收不了。
    missing = [str(t) for r in results for t in (r.detail.get("missing_tools") or [])]
    return PyramidResult(
        passed=passed,
        results=results,
        stopped_at=stopped,
        total_ms=(time.perf_counter() - t0) * 1000,
        missing_tools=missing,
    )


RELATIVE_GATES = ("G1.security", "G2.static")


def finding_key(f) -> str:
    """Line-free fingerprint: an edit above a pre-existing finding moves its line, not its identity."""
    return "\x1f".join((f.rule, f.path, f.message))


def suppress_preexisting(res, baseline: list[str]):
    """hb:G1 / G2 对候选只判**新增**问题 —— 与 G4 的"只拒回归"同一原则。

    S₀ 本来就有的 bandit / ruff / pyright 问题(真实 skill 常有:hdfs-data 的 B608、
    snippets 里的宽 except)原来让每个候选都死在同一道门上,训练永远 no_signal。
    父版本的问题按指纹(规则 + 文件 + 消息,不含行号)逐个抵消,剩下的才算。
    """
    from collections import Counter

    from ..types import GateResult, Verdict
    if res.verdict is not Verdict.FAIL:
        return res
    budget = Counter(baseline)
    kept, dropped = [], 0
    for f in res.findings:
        k = finding_key(f)
        if budget[k] > 0:
            budget[k] -= 1
            dropped += 1
        else:
            kept.append(f)
    blocking = kept if res.gate == "G1.security" else [f for f in kept if f.severity == "error"]
    detail = {**res.detail, "preexisting": dropped}
    return GateResult(gate=res.gate, verdict=Verdict.FAIL if blocking else Verdict.PASS,
                      findings=kept, detail=detail, elapsed_ms=res.elapsed_ms)


def format_report(res: PyramidResult, *, verbose: bool = False) -> str:
    """Human-readable one-screen summary."""
    icon = {Verdict.PASS: "PASS", Verdict.FAIL: "FAIL", Verdict.SKIP: "SKIP"}
    lines = []
    for r in res.results:
        n_err = sum(1 for f in r.findings if f.severity == "error")
        n_warn = len(r.findings) - n_err
        extra = ""
        if n_err or n_warn:
            extra = f"  ({n_err} error, {n_warn} warning)"
        lines.append(f"  [{icon[r.verdict]:4}] {r.gate:<14} {r.elapsed_ms:7.1f}ms{extra}")
        if r.verdict is Verdict.SKIP:
            lines[-1] += f"  — {r.detail.get('reason', '')}"
        show = r.findings if verbose else [f for f in r.findings if f.severity == "error"]
        for f in show[:12]:
            loc = f"{f.path}:{f.line}" if f.path else ""
            lines.append(f"         · {f.rule} {loc} — {f.message}")
        if len(show) > 12:
            lines.append(f"         · ... {len(show) - 12} more")
    head = "PASSED" if res.passed else f"FAILED at {res.stopped_at}"
    lines.append(f"  => {head}  ({res.total_ms:.1f}ms total)")
    return "\n".join(lines)
