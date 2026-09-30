"""Provenance is a hard gate, not a log.

SkillJack (2608.03509): safety detection collapses 98.5% -> 11.4% between the
poisoned trajectory and the skill extracted from it, and 80% of attacks survive
deletion of the poisoned source. So the defence cannot be a classifier applied
after extraction; it has to be a refusal to accept changes that cannot say
where they came from.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.provenance import (  # noqa: E402
    MissingProvenance, ProvenanceLog, record, require_provenance,
)
from skillwhet.types import Bundle, CodeEdit  # noqa: E402


def mk(op="replace_function", **kw) -> CodeEdit:
    kw.setdefault("module", "scripts/m.py")
    kw.setdefault("symbol", "f")
    kw.setdefault("content", "def f() -> None:\n    pass\n")
    return CodeEdit(op=op, **kw)


def test_unattributed_change_is_refused():
    b = Bundle(code_edits=[mk()], origin="P2")
    with pytest.raises(MissingProvenance):
        require_provenance(b)


def test_defect_edit_requires_a_repro_test():
    b = Bundle(
        code_edits=[mk(evidence=["trace:run_1#L4"])],
        evidence=["trace:run_1#L4"], origin="P2",
    )
    with pytest.raises(MissingProvenance, match="repro"):
        require_provenance(b)


def test_well_attributed_edit_is_accepted():
    b = Bundle(
        code_edits=[mk(evidence=["trace:run_1#L4"], repro_test="def test_x(): ...")],
        evidence=["trace:run_1#L4"], origin="P2",
    )
    require_provenance(b)  # must not raise


def test_rule_driven_path_is_exempt():
    """P1 output is reproducible from the source alone; the tool run is the evidence."""
    require_provenance(Bundle(code_edits=[mk()], origin="P1"))


def test_capability_path_also_requires_repro():
    b = Bundle(code_edits=[mk(evidence=["gap:missing-empty-handling"])],
               evidence=["gap:x"], origin="P3")
    with pytest.raises(MissingProvenance):
        require_provenance(b)


def test_log_is_append_only_and_readable(tmp_path: Path):
    log = ProvenanceLog(tmp_path / ".evo" / "provenance.jsonl")
    b = Bundle(
        code_edits=[mk(evidence=["trace:1"], repro_test="t")],
        evidence=["trace:1"], origin="P2", rationale="fix empty input",
    )
    record(log, b, round_no=1, gates_passed=["G0", "G1"], accepted=True)
    record(log, b, round_no=2, gates_passed=["G0"], accepted=False)
    rows = log.read()
    assert len(rows) == 2
    assert rows[0]["accepted"] is True and rows[1]["accepted"] is False
    assert rows[0]["modules"] == ["scripts/m.py"]
    assert rows[0]["bundle_digest"] == rows[1]["bundle_digest"]


def test_log_write_failure_never_breaks_a_run(tmp_path: Path):
    log = ProvenanceLog(tmp_path / "p.jsonl")
    log.path = tmp_path  # a directory — writing must fail internally
    log.append.__self__  # sanity
    from skillwhet.provenance import ProvenanceRecord
    log.append(ProvenanceRecord(ts="t", round=1, bundle_digest="d",
                                origin="P2", evidence=[]))  # must not raise


def test_bundle_digest_is_stable_and_content_addressed():
    a = Bundle(code_edits=[mk(evidence=["e"])], origin="P2")
    b = Bundle(code_edits=[mk(evidence=["e"])], origin="P2")
    c = Bundle(code_edits=[mk(evidence=["different"])], origin="P2")
    assert a.digest() == b.digest()
    assert a.digest() != c.digest()
