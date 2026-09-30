"""P2 — defect-driven repair, anchored on a real stack trace.

The highest signal-to-noise path in the whole system, because it has the one
thing prose optimisation can never obtain: an error located to a line.

Two non-negotiables, both enforced in code rather than asked for in a prompt:
  * every fix ships a reproduction test
  * that test must be RED before the fix. A "repro" that already passes is
    evidence the model invented the defect, and the proposal is discarded.
"""
from __future__ import annotations

import json
from pathlib import Path

from ..analysis import analyze_source
from ..backend import Backend, extract_json
from ..evidence import FailureCluster, test_source
from ..types import Bundle, CodeEdit

_SYSTEM = """You repair Python defects in an agent skill, from a stack trace.

Rules:
- Fix the ROOT CAUSE at the reported frame. Do not wrap the call site in
  try/except to make the symptom disappear — silent swallowing is rejected by
  the static gate.
- Change exactly one function.
- Keep the signature identical unless the trace proves the signature is the bug.
- Write a pytest reproduction that FAILS on the current code and passes after
  your fix. Import from `scripts.<module>`.
- Do not add dependencies.

Return JSON only:
{"symbol": "<the function name exactly as written after `def` — Class.method for methods; NOT the module path>",
 "content": "<the complete replacement function, including its def line>",
 "repro_test": "<a complete pytest test function, including imports>",
 "rationale": "<one sentence>"}"""


STRATEGIES = (
    "MINIMAL — the smallest change that makes the failing test pass; touch no other line",
    "DEFENSIVE — validate and normalise inputs at the top of the function, then the "
    "original logic; never widen the signature",
    "RESTRUCTURE — rewrite the function body cleanly so the failure class cannot recur; "
    "keep the signature and every existing behaviour the tests rely on",
)


def _context(skill_dir: Path, cluster: FailureCluster) -> str:
    # A cluster without a frame inside scripts/ (module == "" or a test file)
    # has nothing P2 can edit; reading `skill_dir / ""` was a directory read
    # that crashed the round (audit B9).
    if not cluster.module or not cluster.module.startswith("scripts/"):
        return ""
    path = skill_dir / cluster.module
    if not path.is_file():
        return ""
    src = path.read_text(encoding="utf-8")
    try:
        facts = analyze_source(src)
    except SyntaxError:
        return src[:4000]
    if cluster.symbol in facts.functions:
        lines = src.splitlines()
        start = max(0, facts.func_lines.get(cluster.symbol, 1) - 1)
        end = min(len(lines), start + 80)
        return "\n".join(lines[start:end])
    return src[:4000]


def propose_defect_fixes(
    skill_dir: Path,
    clusters: list[FailureCluster],
    backend: Backend,
    *,
    k: int = 4,
    budget: int = 6,
    temperature: float = 0.7,
    known_failures: str = "",
) -> list[Bundle]:
    """K candidates per cluster. Verification is free, so sample generously.

    This is the fast loop's economics: the gates cost nothing, so the right move
    is many cheap proposals filtered hard — the opposite of the slow loop, where
    one expensive verification forces one carefully merged proposal.
    """
    skill_dir = Path(skill_dir)
    out: list[Bundle] = []

    for cluster in clusters[:budget]:
        prompt = json.dumps({
            "module": cluster.module,
            "symbol": cluster.symbol,
            "exception": f"{cluster.exc_type}: {cluster.sample_message}",
            "frame": cluster.top_frame,
            "occurrences": cluster.count,
            "failing_task_ids": cluster.task_ids[:8],
            "failing_tests": [t for t in (test_source(skill_dir, tid)
                                          for tid in cluster.task_ids[:3]) if t][:3],
            "source": _context(skill_dir, cluster),
            # The persistent wiki: directions already tried and rejected. Without
            # this the proposer re-walks the same dead ends every round.
            "previously_rejected_directions": known_failures[:3000],
        }, ensure_ascii=False)

        # K samples from ONE prompt at one temperature tend to collapse onto
        # the same patch. Each sample is steered toward a different repair
        # strategy instead, so the best-of-K selection has something to select.
        replies: list[str] = []
        for i in range(k):
            strategy = STRATEGIES[i % len(STRATEGIES)]
            salted = f"{prompt}\n\nRepair strategy for THIS attempt: {strategy}\n<!-- sample:{i} -->"
            try:
                replies.append(backend.complete(
                    salted, system=_SYSTEM, stage="p2.defect", max_tokens=2048,
                    temperature=temperature if k > 1 else 0.0))
            except Exception:  # noqa: BLE001 - one bad sample must not kill the cluster
                continue
        if not replies:
            continue

        for i, raw in enumerate(replies):
            data = extract_json(raw)
            if not data:
                continue
            symbol = str(data.get("symbol") or cluster.symbol).strip()
            content = str(data.get("content") or "").strip()
            repro = str(data.get("repro_test") or "").strip()
            if not symbol or not content or not repro:
                continue
            out.append(Bundle(
                code_edits=[CodeEdit(
                    op="replace_function", module=cluster.module, symbol=symbol,
                    content=content, repro_test=repro,
                    evidence=[f"cluster:{cluster.key}", f"frame:{cluster.top_frame}",
                              *[f"task:{t}" for t in cluster.task_ids[:5]]],
                    rationale=str(data.get("rationale", ""))[:300],
                )],
                evidence=[f"cluster:{cluster.key}"],
                origin="P2",
                rationale=f"[{cluster.exc_type} x{cluster.count}] "
                          f"{str(data.get('rationale', ''))[:200]} (sample {i})",
            ))
    return out


def repro_is_red(skill_dir: Path, bundle: Bundle, runner) -> bool:
    """A reproduction that already passes disproves the defect it claims to fix.

    ``runner`` is injected so this stays testable without a live pytest run.
    """
    for e in bundle.code_edits:
        if not e.repro_test:
            continue
        if runner(skill_dir, e.repro_test):   # True == the test passed already
            return False
    return True
