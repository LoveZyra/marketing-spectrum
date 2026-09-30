"""Search-side mechanics for the fast loop: fingerprints, refinement, tracking.

The gates are free, so the loop's economics are decided by three things this
module supplies:

  * ``fingerprint``  — two candidates that are the same program are not two
                       samples. Rejected fingerprints are remembered across
                       rounds so the proposer cannot re-walk a dead end.
  * ``refine``       — a candidate rejected at G2/G3/G4 comes back with
                       findings precise to the line. One more model call with
                       those findings usually clears the gate; a fresh sample
                       next round usually does not.
  * ``ClusterLedger``— how many rounds a defect cluster has resisted repair,
                       so a stubborn one can be escalated to a stronger model.
"""
from __future__ import annotations

import ast
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path

from .backend import Backend, extract_json
from .bundle import CommitResult
from .types import Bundle, CodeEdit

# ── fingerprints ────────────────────────────────────────────────────────────


def _strip_docstrings(tree: ast.AST) -> ast.AST:
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef, ast.Module)):
            body = getattr(node, "body", None)
            if body and isinstance(body[0], ast.Expr) and \
                    isinstance(getattr(body[0], "value", None), ast.Constant) and \
                    isinstance(body[0].value.value, str):
                node.body = body[1:] or [ast.Pass()]
    return tree


def _norm_code(src: str) -> str:
    try:
        return ast.dump(_strip_docstrings(ast.parse(src)), include_attributes=False)
    except SyntaxError:
        return "RAW:" + " ".join(src.split())


def fingerprint(bundle: Bundle) -> str:
    """Semantic identity of a bundle: AST of each code edit, text of each doc edit."""
    parts: list[str] = []
    for e in sorted(bundle.code_edits, key=lambda x: (x.module, x.symbol, x.op)):
        parts.append(f"code|{e.op}|{e.module}|{e.symbol}|{_norm_code(e.content)}")
    for d in sorted(bundle.doc_edits, key=lambda x: (x.path, x.op, x.target)):
        parts.append(f"doc|{d.op}|{d.path}|{' '.join(d.target.split())}|{' '.join(d.content.split())}")
    for k in sorted(bundle.contract_delta or {}):
        parts.append(f"contract|{k}|{json.dumps(bundle.contract_delta[k], sort_keys=True)}")
    return hashlib.sha256("\n".join(parts).encode("utf-8")).hexdigest()[:16]


# ── refinement ──────────────────────────────────────────────────────────────

REFINABLE_STAGES = ("G0.parse", "G2.static", "G3.contract", "G4.unit")

_REFINE_SYSTEM = """You previously proposed a fix to a Python function in an agent skill.
An automated gate rejected it. The findings below are exact — line-level lint,
type, contract or test failures. Produce a corrected version of the SAME
function that addresses every finding without changing its signature or
weakening any test.

Return JSON only:
{"symbol": "<function name as after `def`>",
 "content": "<the complete corrected function, imports it needs included>",
 "rationale": "<one line: what you changed and why>"}"""


def refinable(result: CommitResult) -> bool:
    if result.pyramid is not None and not result.pyramid.passed:
        return result.pyramid.stopped_at in REFINABLE_STAGES
    return result.reason.startswith("repro test is still")


def _findings_of(result: CommitResult) -> list[str]:
    out: list[str] = []
    if result.pyramid is not None:
        for r in result.pyramid.results:
            for f in r.findings:
                if f.severity == "error" or not r.ok:
                    where = f"{f.path}:{f.line}" if f.path else ""
                    out.append(f"[{r.gate}] {f.rule}: {f.message} {where}".strip())
    if not out and result.reason:
        out.append(result.reason)
    return out[:20]


def refine(bundle: Bundle, result: CommitResult, backend: Backend, *,
           skill_dir: Path, max_tokens: int = 2048) -> Bundle | None:
    """One corrected candidate from the gate findings; None if nothing usable."""
    edits = [e for e in bundle.code_edits if e.op in ("replace_function", "add_function")]
    if len(edits) != 1:
        return None
    e = edits[0]
    payload = {
        "module": e.module, "symbol": e.symbol,
        "rejected_content": e.content,
        "findings": _findings_of(result),
        "repro_test": e.repro_test,
    }
    try:
        raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                               system=_REFINE_SYSTEM, stage="p2.refine",
                               max_tokens=max_tokens)
    except Exception:  # noqa: BLE001
        return None
    data = extract_json(raw) or {}
    content = str(data.get("content") or "").strip()
    if not content or " ".join(content.split()) == " ".join(e.content.split()):
        return None
    new_edit = CodeEdit(**{**e.to_dict(), "content": content,
                           "symbol": str(data.get("symbol") or e.symbol).strip(),
                           "rationale": (str(data.get("rationale", ""))[:300] or e.rationale)})
    return Bundle(
        code_edits=[new_edit], doc_edits=list(bundle.doc_edits),
        contract_delta=dict(bundle.contract_delta or {}),
        evidence=[*bundle.evidence, f"refined_from:{bundle.digest()}"],
        origin=bundle.origin,
        rationale=f"{bundle.rationale} [refined: {str(data.get('rationale', ''))[:120]}]",
    )


# ── cluster ledger (for escalation) ─────────────────────────────────────────


@dataclass
class ClusterLedger:
    """Rounds in which each defect cluster was attempted and not repaired."""
    path: Path
    attempts: dict[str, list[int]] = field(default_factory=dict)

    @classmethod
    def load(cls, path: Path) -> ClusterLedger:
        path = Path(path)
        if path.exists():
            try:
                return cls(path, json.loads(path.read_text(encoding="utf-8")))
            except (json.JSONDecodeError, TypeError):
                pass
        return cls(path)

    def note(self, key: str, round_no: int, repaired: bool) -> None:
        rounds = self.attempts.setdefault(key, [])
        if repaired:
            self.attempts[key] = []
        elif round_no not in rounds:
            rounds.append(round_no)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self.attempts, indent=1), encoding="utf-8")

    def stubborn(self, key: str, threshold: int = 2) -> bool:
        return len(self.attempts.get(key, [])) >= threshold


def cluster_key(bundle: Bundle) -> str:
    for ev in bundle.evidence:
        if ev.startswith("cluster:"):
            return ev
    return f"bundle:{bundle.digest()}"
