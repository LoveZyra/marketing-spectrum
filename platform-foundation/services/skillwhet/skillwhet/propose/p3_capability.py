"""P3 — capability-driven change. The riskiest path; budgeted accordingly.

Without a failure to anchor on, a model will happily invent requirements and
pay for them in defensive-code bloat. Three constraints hold it down:

  1. test first — the test must be RED before any implementation is written
  2. one function per change; no cross-module refactors
  3. a new public entrypoint forces a contract update, hence an atomic bundle

If ΔBloat rises while Δpass stays flat, this is the path to switch off first.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from ..backend import Backend, extract_json
from ..types import Bundle, CodeEdit


@dataclass
class Gap:
    """A capability the skill is missing, as observed — not as imagined."""

    id: str
    description: str
    evidence: list[str]
    module: str = ""
    symbol: str = ""
    occurrences: int = 1

    def to_dict(self) -> dict:
        return {
            "id": self.id, "description": self.description,
            "evidence": self.evidence, "module": self.module,
            "symbol": self.symbol, "occurrences": self.occurrences,
        }


_TEST_SYSTEM = """You write a single failing pytest test for a missing capability
in an agent skill.

Rules:
- The test MUST fail against the current code. If the capability already works,
  reply {"already_supported": true} and nothing else.
- Test observable behaviour, not implementation details.
- Prefer an outcome assertion (a value, an exception) over a formatting
  assertion — a test that only checks shape can be satisfied by reformatting.
- Import from `scripts.<module>`.

Return JSON only:
{"test": "<complete pytest test function with imports>", "name": "<test function name>"}
or {"already_supported": true}"""

_IMPL_SYSTEM = """You implement the minimum change that makes a given failing test pass.

Rules:
- Change exactly ONE function. No cross-module refactors.
- No new dependencies.
- No bare `except:` and no `try/except/pass` — the static gate rejects both.
- Preserve the existing signature unless the test requires otherwise.

Return JSON only:
{"symbol": "<the function name exactly as written after `def` — Class.method for methods; NOT the module path>",
 "content": "<complete replacement function>",
 "signature_changed": true|false,
 "rationale": "<one sentence>"}"""


def propose_capability(
    skill_dir: Path,
    gaps: list[Gap],
    backend: Backend,
    *,
    k: int = 3,
    budget: int = 4,
    temperature: float = 0.7,
    known_failures: str = "",
) -> list[Bundle]:
    skill_dir = Path(skill_dir)
    out: list[Bundle] = []

    for gap in gaps[:budget]:
        module_src = ""
        if gap.module:
            p = skill_dir / gap.module
            if p.exists():
                module_src = p.read_text(encoding="utf-8")[:4000]

        # ── step 1: the test, before any implementation exists ──────────────
        try:
            raw = backend.complete(
                json.dumps({"gap": gap.description, "module": gap.module,
                            "symbol": gap.symbol, "source": module_src},
                           ensure_ascii=False),
                system=_TEST_SYSTEM, stage="p3.test", max_tokens=1200,
            )
        except Exception:  # noqa: BLE001
            continue
        tdata = extract_json(raw) or {}
        if tdata.get("already_supported"):
            continue
        test_src = str(tdata.get("test") or "").strip()
        if not test_src:
            continue

        # ── step 2: implementations against that fixed test ─────────────────
        try:
            impls = backend.sample(
                json.dumps({"failing_test": test_src, "module": gap.module,
                            "source": module_src,
                            "previously_rejected_directions": known_failures[:3000]},
                           ensure_ascii=False),
                k, system=_IMPL_SYSTEM, stage="p3.impl",
                max_tokens=2048, temperature=temperature,
            )
        except Exception:  # noqa: BLE001
            continue

        for i, reply in enumerate(impls):
            data = extract_json(reply)
            if not data:
                continue
            symbol = str(data.get("symbol") or gap.symbol).strip()
            content = str(data.get("content") or "").strip()
            if not symbol or not content:
                continue
            out.append(Bundle(
                code_edits=[CodeEdit(
                    op="replace_function", module=gap.module, symbol=symbol,
                    content=content, repro_test=test_src,
                    evidence=[f"gap:{gap.id}", *gap.evidence[:4]],
                    rationale=str(data.get("rationale", ""))[:300],
                )],
                evidence=[f"gap:{gap.id}"],
                origin="P3",
                contract_delta={"signature_changed": bool(data.get("signature_changed"))},
                rationale=f"[capability] {gap.description[:160]} (sample {i})",
            ))
    return out


def rank_gaps(gaps: list[Gap]) -> list[Gap]:
    """Frequency first: a gap seen once is far likelier to be imagined."""
    return sorted(gaps, key=lambda g: (-g.occurrences, g.id))
