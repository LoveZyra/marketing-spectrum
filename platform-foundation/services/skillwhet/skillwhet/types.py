"""Core data types for SkillWhet.

Everything here is plain-dataclass + round-trippable to dict, so the whole
pipeline state can be persisted as JSON without custom encoders.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any, Literal

# ── Verdicts ────────────────────────────────────────────────────────────────


class Verdict(str, Enum):
    PASS = "pass"
    FAIL = "fail"
    SKIP = "skip"  # tool unavailable — must not be silently treated as PASS


@dataclass
class Finding:
    """One concrete problem found by a gate."""

    gate: str
    rule: str
    message: str
    path: str = ""
    line: int = 0
    severity: Literal["error", "warning"] = "error"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class GateResult:
    gate: str
    verdict: Verdict
    findings: list[Finding] = field(default_factory=list)
    elapsed_ms: float = 0.0
    detail: dict[str, Any] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.verdict is Verdict.PASS

    @property
    def blocking(self) -> bool:
        """SKIP does not block, but is reported so a missing tool is visible."""
        return self.verdict is Verdict.FAIL

    def to_dict(self) -> dict:
        return {
            "gate": self.gate,
            "verdict": self.verdict.value,
            "findings": [f.to_dict() for f in self.findings],
            "elapsed_ms": round(self.elapsed_ms, 2),
            "detail": self.detail,
        }


@dataclass
class PyramidResult:
    """Outcome of running a candidate through the gate pyramid."""

    passed: bool
    results: list[GateResult] = field(default_factory=list)
    stopped_at: str = ""
    total_ms: float = 0.0
    missing_tools: list[str] = field(default_factory=list)   # hl(动态 P2-19):没装、因此没查的工具

    @property
    def findings(self) -> list[Finding]:
        return [f for r in self.results for f in r.findings]

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "missing_tools": list(self.missing_tools),
            "stopped_at": self.stopped_at,
            "total_ms": round(self.total_ms, 2),
            "results": [r.to_dict() for r in self.results],
        }


# ── Side effects ────────────────────────────────────────────────────────────

SideEffect = Literal[
    "none",
    "filesystem:tmp",
    "filesystem:workspace",
    "network",
    "subprocess",
]

# Partial order: declaring a broader effect permits the narrower ones.
_EFFECT_IMPLIES: dict[str, set[str]] = {
    "none": set(),
    "filesystem:tmp": {"filesystem:tmp"},
    "filesystem:workspace": {"filesystem:tmp", "filesystem:workspace"},
    "network": {"network"},
    "subprocess": {"subprocess"},
}


def effects_satisfied(declared: set[str], observed: set[str]) -> set[str]:
    """Return observed effects NOT covered by the declared set."""
    permitted: set[str] = set()
    for d in declared:
        permitted |= _EFFECT_IMPLIES.get(d, {d})
    return observed - permitted


# ── Contract ────────────────────────────────────────────────────────────────

Stability = Literal["stable", "experimental", "deprecated"]


@dataclass
class Entrypoint:
    id: str
    module: str
    signature: str = ""
    doc_anchor: str = ""
    preconditions: list[str] = field(default_factory=list)
    postconditions: list[str] = field(default_factory=list)
    side_effects: list[str] = field(default_factory=lambda: ["none"])
    stability: Stability = "experimental"
    cost_class: str = "cpu_bound"
    # Machine-verifiable pre/postconditions. Natural-language pre/postconditions
    # stay for humans; these are what G3 can actually execute:
    #   {"never_raises": {"args": [...], "kwargs": {...}}}
    #   {"returns_type": "list" | "dict" | "str" | "int" | "bool" | "None"}
    #   {"pure": {"args": [...]}}            same input → same output, twice
    #   {"idempotent": {"args": [...]}}      f(f(x)) == f(x)   (unary)
    #   {"raises": {"args": [...], "exc": "ValueError"}}
    #   {"example": {"args": [...], "returns": ...}}   stated behaviour, pinned
    checks: list[dict] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: dict) -> Entrypoint:
        se = d.get("side_effects", ["none"])
        if isinstance(se, str):
            se = [se]
        return cls(
            id=str(d["id"]),
            module=str(d["module"]),
            signature=str(d.get("signature", "")),
            doc_anchor=str(d.get("doc_anchor", "")),
            preconditions=list(d.get("preconditions") or []),
            postconditions=list(d.get("postconditions") or []),
            side_effects=[str(x) for x in se],
            stability=d.get("stability", "experimental"),
            cost_class=str(d.get("cost_class", "cpu_bound")),
            checks=[c for c in (d.get("checks") or []) if isinstance(c, dict)],
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Contract:
    version: int = 1
    allowed_imports: list[str] = field(default_factory=list)
    entrypoints: list[Entrypoint] = field(default_factory=list)

    def by_id(self, eid: str) -> Entrypoint | None:
        return next((e for e in self.entrypoints if e.id == eid), None)

    def for_module(self, module: str) -> list[Entrypoint]:
        return [e for e in self.entrypoints if e.module == module]

    @classmethod
    def from_dict(cls, d: dict) -> Contract:
        return cls(
            version=int(d.get("version", 1)),
            allowed_imports=[str(x) for x in (d.get("allowed_imports") or [])],
            entrypoints=[Entrypoint.from_dict(e) for e in (d.get("entrypoints") or [])],
        )

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "allowed_imports": sorted(self.allowed_imports),
            "entrypoints": [e.to_dict() for e in self.entrypoints],
        }


# ── Edits ───────────────────────────────────────────────────────────────────

CodeOp = Literal[
    "replace_function",
    "add_function",
    "delete_function",
    "add_import",
    "rewrite_module",   # P1 only: deterministic tools legitimately touch whole files
]


@dataclass
class CodeEdit:
    """A structured, AST-addressed edit to one Python module.

    ``content`` is always a complete source unit (a whole function def, or a
    whole import statement) — never a line-level diff, so the result is either
    parseable or rejected at G0.
    """

    op: CodeOp
    module: str
    symbol: str = ""
    content: str = ""
    evidence: list[str] = field(default_factory=list)
    repro_test: str = ""
    rationale: str = ""

    @property
    def touches_signature(self) -> bool:
        return self.op in ("replace_function", "delete_function", "add_function")

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> CodeEdit:
        return cls(
            op=d["op"],
            module=d["module"],
            symbol=d.get("symbol", ""),
            content=d.get("content", ""),
            evidence=list(d.get("evidence") or []),
            repro_test=d.get("repro_test", ""),
            rationale=d.get("rationale", ""),
        )


@dataclass
class DocEdit:
    """SkillOpt's four atomic prose operations."""

    op: Literal["append", "insert_after", "replace", "delete"]
    path: str
    content: str = ""
    target: str = ""
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Bundle:
    """An atomic cross-carrier commit. All-or-nothing."""

    code_edits: list[CodeEdit] = field(default_factory=list)
    doc_edits: list[DocEdit] = field(default_factory=list)
    contract_delta: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    rationale: str = ""
    origin: Literal["P1", "P2", "P3", "drift", "doc"] = "P2"

    def is_empty(self) -> bool:
        return not (self.code_edits or self.doc_edits or self.contract_delta)

    def to_dict(self) -> dict:
        return {
            "code_edits": [e.to_dict() for e in self.code_edits],
            "doc_edits": [e.to_dict() for e in self.doc_edits],
            "contract_delta": self.contract_delta,
            "evidence": self.evidence,
            "rationale": self.rationale,
            "origin": self.origin,
        }

    def digest(self) -> str:
        blob = json.dumps(self.to_dict(), sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(blob.encode()).hexdigest()[:16]


# ── Attribution ─────────────────────────────────────────────────────────────


class RootCause(str, Enum):
    CODE_DEFECT = "code_defect"
    DOC_DEFECT = "doc_defect"
    CONTRACT_DRIFT = "contract_drift"
    CAPABILITY_GAP = "capability_gap"     # the code is not wrong, it is missing
    ISOLATE = "isolate"


@dataclass
class FailureSignal:
    id: str
    root_cause: RootCause
    summary: str
    evidence: list[str] = field(default_factory=list)
    module: str = ""
    symbol: str = ""
    exc_type: str = ""
    top_frame: str = ""
    count: int = 1

    def to_dict(self) -> dict:
        d = asdict(self)
        d["root_cause"] = self.root_cause.value
        return d


def skill_hash(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode())
        h.update(b"\x00")
    return h.hexdigest()[:16]
