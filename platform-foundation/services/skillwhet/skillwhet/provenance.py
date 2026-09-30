"""Provenance chain — every accepted change traces back to its evidence.

This exists because of SkillJack (arXiv 2608.03509): safety detection collapses
from 98.5% on poisoned *trajectories* to 11.4% on the *skills* extracted from
them, and 80% of attacks survive deletion of the original poisoned records. The
extraction step is itself a detection-evasion device.

The countermeasure is not a better classifier, it is refusing to accept a change
that cannot say where it came from. ``require_provenance`` is a hard gate.
"""
from __future__ import annotations

import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .types import Bundle


@dataclass
class ProvenanceRecord:
    ts: str
    round: int
    bundle_digest: str
    origin: str                       # P1 | P2 | P3 | drift | doc
    evidence: list[str]               # trace ids, test ids, contract diffs
    source_sessions: list[str] = field(default_factory=list)
    modules: list[str] = field(default_factory=list)
    symbols: list[str] = field(default_factory=list)
    gates_passed: list[str] = field(default_factory=list)
    accepted: bool = False
    rationale: str = ""
    edits: list[dict] = field(default_factory=list)     # per-edit status (applied/skipped/…)
    reason: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class ProvenanceLog:
    """Append-only JSONL. A failed write must never break a run."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, rec: ProvenanceRecord) -> None:
        try:
            line = json.dumps(rec.to_dict(), ensure_ascii=False, allow_nan=False)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
                fh.flush()
                os.fsync(fh.fileno())
        except (OSError, ValueError):
            pass  # provenance must never break a night

    def read(self) -> list[dict]:
        if not self.path.exists():
            return []
        out = []
        for line in self.path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return out


class MissingProvenance(ValueError):
    pass


def require_provenance(bundle: Bundle) -> None:
    """Hard gate: no evidence, no acceptance.

    P1 (rule-driven, deterministic tool output) is exempt because the tool
    invocation *is* the evidence and is reproducible from the source alone.
    """
    if bundle.origin == "P1":
        return
    if not bundle.evidence and not any(e.evidence for e in bundle.code_edits):
        raise MissingProvenance(
            f"bundle {bundle.digest()} (origin={bundle.origin}) carries no evidence; "
            f"unattributed changes are refused"
        )
    if bundle.origin in ("P2", "P3"):
        missing = [
            e.symbol or e.module for e in bundle.code_edits if not e.repro_test
        ]
        if missing:
            raise MissingProvenance(
                f"bundle {bundle.digest()}: defect/capability edits require a repro "
                f"test; missing for {missing}"
            )


def record(
    log: ProvenanceLog,
    bundle: Bundle,
    *,
    round_no: int,
    gates_passed: list[str],
    accepted: bool,
    edits: list[dict] | None = None,
    reason: str = "",
) -> ProvenanceRecord:
    rec = ProvenanceRecord(
        ts=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        round=round_no,
        bundle_digest=bundle.digest(),
        origin=bundle.origin,
        evidence=list(bundle.evidence) or [
            ev for e in bundle.code_edits for ev in e.evidence
        ],
        modules=sorted({e.module for e in bundle.code_edits}),
        symbols=sorted({e.symbol for e in bundle.code_edits if e.symbol}),
        gates_passed=gates_passed,
        accepted=accepted,
        rationale=bundle.rationale[:500],
        edits=list(edits or []),
        reason=reason[:300],
    )
    log.append(rec)
    return rec
