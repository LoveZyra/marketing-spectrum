"""Four-way attribution: every failure is assigned a responsible party first.

SkillEvo's central discipline is that only *repairable* signals enter the loop;
unrepairable ones misencoded as knowledge are the direct source of document
bloat and factual conflict. The same holds on the code side — treating an
environment fault as a code defect grows a thicket of pointless try/except.

The routing is:
    code_defect     -> fast loop   (has a stack frame inside scripts/)
    doc_defect      -> slow loop   (code behaved, the prose misled)
    contract_drift  -> atomic bundle (prose and code each fine, jointly wrong)
    isolate         -> nothing     (capability limit / eval noise / infra)

Most of it is decided deterministically. The LLM is consulted only for the
genuinely ambiguous residue, and its verdict is constrained to the four labels.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

from .backend import Backend, extract_json
from .contract import load_contract
from .evidence import ExecRecord, FailureCluster, TaskRecord, cluster_failures, test_targets
from .gates import ContractGate
from .gates.base import Candidate
from .types import FailureSignal, RootCause, Verdict

# Exception types that are essentially never the skill's fault.
_ENV_EXCEPTIONS = {
    "ConnectionError", "ConnectionRefusedError", "TimeoutError", "timeout",
    "PermissionError", "OSError", "ModuleNotFoundError", "ImportError",
    "MemoryError", "KeyboardInterrupt",
}


@dataclass
class Attribution:
    code_defect: list[FailureCluster] = field(default_factory=list)
    doc_defect: list[FailureSignal] = field(default_factory=list)
    contract_drift: list[FailureSignal] = field(default_factory=list)
    capability_gap: list[FailureSignal] = field(default_factory=list)
    isolate: list[FailureSignal] = field(default_factory=list)

    def actionable(self) -> bool:
        return bool(self.code_defect or self.doc_defect or self.contract_drift
                    or self.capability_gap)

    def summary(self) -> dict[str, int]:
        return {
            "code_defect": len(self.code_defect),
            "doc_defect": len(self.doc_defect),
            "contract_drift": len(self.contract_drift),
            "capability_gap": len(self.capability_gap),
            "isolate": len(self.isolate),
        }

    def to_dict(self) -> dict:
        return {
            "code_defect": [c.to_dict() for c in self.code_defect],
            "doc_defect": [s.to_dict() for s in self.doc_defect],
            "contract_drift": [s.to_dict() for s in self.contract_drift],
            "capability_gap": [s.to_dict() for s in self.capability_gap],
            "isolate": [s.to_dict() for s in self.isolate],
        }

    def gaps(self) -> list:
        """capability_gap signals as P3 `Gap`s, merged by module::symbol/summary.

        This is the producer P3 never had: `propose_capability` needs `Gap`s
        and nothing in the package built one (audit B13).
        """
        from .propose.p3_capability import Gap
        merged: dict[str, Gap] = {}
        for s in self.capability_gap:
            key = f"{s.module}::{s.symbol}" if s.module else s.summary[:80]
            g = merged.get(key)
            if g is None:
                merged[key] = Gap(id=f"gap:{abs(hash(key)) % 10**8}", description=s.summary,
                                  evidence=list(s.evidence), module=s.module,
                                  symbol=s.symbol, occurrences=max(1, s.count))
            else:
                g.occurrences += max(1, s.count)
                g.evidence = sorted(set(g.evidence + list(s.evidence)))
        return list(merged.values())


_SYSTEM = """You are a failure attributor for an agent-skill training loop.
Assign one root cause. The question is always WHO CAN FIX IT.

code_defect     the skill's Python code is wrong (crash, wrong result)
doc_defect      the code is correct; SKILL.md / references misled the agent,
                omitted a rule, or over-generalised a concrete value
contract_drift  prose and code each look right but disagree about the interface
capability_gap  nothing is wrong; the skill simply has no code path for what the
                task needs (missing function, unsupported input kind)
isolate         nobody can fix it here: missing permission or tool, infrastructure
                fault, or an evaluation false negative

Answer with JSON only: {"root_cause": "...", "summary": "<one line>", "confidence": 0.0-1.0}"""


def _env_fault(rec: ExecRecord) -> bool:
    if rec.exc_type in ("ImportError", "ModuleNotFoundError") and \
            rec.module.startswith("scripts/"):
        return False           # a broken import inside the skill is the skill's bug
    return rec.exc_type in _ENV_EXCEPTIONS


def attribute(
    skill_dir: Path,
    records: list[ExecRecord],
    tasks: dict[str, TaskRecord] | None = None,
    *,
    evaluator: Backend | None = None,
    ambiguous_budget: int = 8,
) -> Attribution:
    """Route every failed record. Deterministic first, model only for the residue."""
    out = Attribution()
    tasks = tasks or {}
    skill_dir = Path(skill_dir)

    # ── 1. contract drift is a property of the skill, not of any one task ──
    contract = load_contract(skill_dir)
    if contract.entrypoints:
        res = ContractGate().run(Candidate(skill_dir=skill_dir, contract=contract))
        if res.verdict is Verdict.FAIL:
            for f in res.findings:
                if f.severity != "error":
                    continue
                out.contract_drift.append(FailureSignal(
                    id=f"drift:{f.rule}:{f.path}",
                    root_cause=RootCause.CONTRACT_DRIFT,
                    summary=f.message,
                    evidence=[f"G3.contract:{f.rule}@{f.path}:{f.line}"],
                    module=f.path,
                ))

    failures = [r for r in records if not r.passed]

    # ── 2. deterministic routing ────────────────────────────────────────────
    code_records: list[ExecRecord] = []
    ambiguous: list[ExecRecord] = []
    for r in failures:
        # A wrong RESULT: the deepest frame is the test, and the test names
        # the skill symbol it exercises. Resolve it before any routing.
        if not r.module.startswith("scripts/") and "::" in r.task_id:
            targets = test_targets(skill_dir, r.task_id)
            if targets and len({m for m, _ in targets}) == 1:
                r.module, r.symbol = targets[0]
                r.top_frame = f"{Path(r.module).name}:{r.symbol}:0"
                if not r.exc_type:
                    r.exc_type = "WrongResult"
        if _env_fault(r):
            out.isolate.append(FailureSignal(
                id=f"iso:{r.task_id}", root_cause=RootCause.ISOLATE,
                summary=f"{r.exc_type}: {r.exc_message}"[:200],
                evidence=[f"task:{r.task_id}"], exc_type=r.exc_type,
            ))
        elif r.exc_type and r.module.startswith("scripts/"):
            # A stack frame inside the skill's own code: unambiguous.
            code_records.append(r)
        else:
            ambiguous.append(r)

    out.code_defect = cluster_failures(code_records)

    # ── 3. model consulted only on the residue, and only within budget ──────
    for r in ambiguous[:ambiguous_budget]:
        cause, summary = _ask(evaluator, r, tasks.get(r.task_id))
        sig = FailureSignal(
            id=f"sig:{r.task_id}", root_cause=cause, summary=summary,
            evidence=[f"task:{r.task_id}"], module=r.module, symbol=r.symbol,
            exc_type=r.exc_type,
        )
        if cause is RootCause.CODE_DEFECT:
            out.code_defect.extend(cluster_failures([r]))
        elif cause is RootCause.DOC_DEFECT:
            out.doc_defect.append(sig)
        elif cause is RootCause.CONTRACT_DRIFT:
            out.contract_drift.append(sig)
        elif cause is RootCause.CAPABILITY_GAP:
            out.capability_gap.append(sig)
        else:
            out.isolate.append(sig)

    # Anything past the budget is isolated rather than guessed at.
    for r in ambiguous[ambiguous_budget:]:
        out.isolate.append(FailureSignal(
            id=f"iso:{r.task_id}", root_cause=RootCause.ISOLATE,
            summary="beyond the attribution budget for this round",
            evidence=[f"task:{r.task_id}"],
        ))
    return out


def _ask(
    evaluator: Backend | None, rec: ExecRecord, task: TaskRecord | None
) -> tuple[RootCause, str]:
    """Default is ISOLATE: without evidence we do not let a signal into the loop."""
    if evaluator is None:
        return RootCause.ISOLATE, "no evaluator configured; not admitted to the loop"

    prompt = json.dumps({
        "intent": (task.intent if task else "")[:800],
        "reference": (task.reference if task else "")[:800],
        "observed_output": rec.stdout[:1200],
        "exception": f"{rec.exc_type}: {rec.exc_message}" if rec.exc_type else "",
        "module": rec.module, "symbol": rec.symbol,
        # what the agent actually saw and did — the prose it was given, the
        # turns, the judge's reasoning — not just the final text (REVIEW §1.5)
        "trajectory": [{k: (v[:1200] if isinstance(v, str) else v) for k, v in step.items()}
                       for step in (rec.trajectory or [])[:12]],
    }, ensure_ascii=False)

    try:
        raw = evaluator.complete(prompt, system=_SYSTEM, stage="attribute",
                                 max_tokens=400)
    except Exception:  # noqa: BLE001 - a backend failure must not stop the round
        return RootCause.ISOLATE, "attribution call failed"

    data = extract_json(raw) or {}
    try:
        cause = RootCause(str(data.get("root_cause", "")).strip())
    except ValueError:
        return RootCause.ISOLATE, "unparseable attribution verdict"
    return cause, str(data.get("summary", ""))[:200]
