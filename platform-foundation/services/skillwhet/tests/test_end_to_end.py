"""The proof that matters: a broken skill goes in, a repaired skill comes out.

Uses ScriptedBackend so the loop is deterministic and offline. What is being
tested is the ORCHESTRATION — attribution routing, proposal, gating, promotion,
provenance, staging — not the model's ability to write Python.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.backend import Roles, ScriptedBackend  # noqa: E402
from skillwhet.evidence import TaskRecord  # noqa: E402
from skillwhet.runner import PytestRunner  # noqa: E402
from skillwhet.trainer import TrainConfig, bootstrap, train  # noqa: E402
from skillwhet.gates.pyramid import PyramidConfig  # noqa: E402
from skillwhet.loops import FastConfig  # noqa: E402
from skillwhet.staging import StagingError, adopt, latest  # noqa: E402

# A real defect: normalize_cell explodes on None instead of coercing.
BUGGY = '''"""Table helpers."""
from __future__ import annotations

import re


def normalize_cell(raw: str | None) -> str:
    """Collapse whitespace and strip currency symbols."""
    return re.sub(r"\\s+", " ", raw).strip().lstrip("$").strip()
'''

FIXED = '''def normalize_cell(raw: str | None) -> str:
    """Collapse whitespace and strip currency symbols."""
    if raw is None:
        return ""
    return re.sub(r"\\s+", " ", raw).strip().lstrip("$").strip()
'''

TESTS = '''import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.cells import normalize_cell


def test_strips_currency():
    assert normalize_cell("  $ 12 ") == "12"


def test_handles_none():
    assert normalize_cell(None) == ""
'''


@pytest.fixture()
def skill(tmp_path: Path) -> Path:
    d = tmp_path / "cells"
    (d / "scripts").mkdir(parents=True)
    (d / "references").mkdir()
    (d / "tests" / "unit").mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\nname: cells\ndescription: Normalise spreadsheet cells.\n---\n\n"
        "# Cells\n\nSee `references/api.md`.\n", encoding="utf-8")
    (d / "references" / "api.md").write_text(
        "# API\n\n## normalize_cell\n\n`normalize_cell(raw)` collapses whitespace.\n",
        encoding="utf-8")
    (d / "scripts" / "cells.py").write_text(BUGGY, encoding="utf-8")
    (d / "tests" / "unit" / "test_cells.py").write_text(TESTS, encoding="utf-8")
    bootstrap(d)
    return d


def tasks() -> list[TaskRecord]:
    node = "tests/unit/test_cells.py"
    return [
        TaskRecord(id=f"{node}::test_strips_currency", intent="strip currency",
                   reference_kind="rule", split="train"),
        TaskRecord(id=f"{node}::test_handles_none", intent="handle None",
                   reference_kind="rule", split="train"),
        # val must contain the task the repair is supposed to move, otherwise the
        # strictly-greater gate correctly sees no improvement and rejects.
        TaskRecord(id=f"{node}::test_strips_currency", intent="strip currency",
                   reference_kind="rule", split="val"),
        TaskRecord(id=f"{node}::test_handles_none", intent="handle None",
                   reference_kind="rule", split="val"),
    ]


def scripted_fix() -> ScriptedBackend:
    return ScriptedBackend([json.dumps({
        "symbol": "normalize_cell",
        "content": FIXED,
        "repro_test": "def test_none_is_empty():\n    assert normalize_cell(None) == ''\n",
        "rationale": "coerce None to the empty string before the regex",
    })] * 8)


def cfg() -> TrainConfig:
    return TrainConfig(
        rounds=1, fast_iters=1, enable_slow_loop=False,
        fast=FastConfig(k_samples=1, budget_p2=2, enable_p1=False, enable_p3=False,
                        pyramid=PyramidConfig(use_pyright=False, use_bandit=False)),
    )


# ── The loop ────────────────────────────────────────────────────────────────

def test_loop_repairs_a_real_defect(skill: Path):
    runner = PytestRunner()
    before = {r.task_id: r.passed for r in runner.run(skill, tasks())}
    assert before["tests/unit/test_cells.py::test_handles_none"] is False
    assert before["tests/unit/test_cells.py::test_strips_currency"] is True

    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    result = train(skill, tasks(), roles, runner, cfg=cfg())

    after = runner.run(result.best_dir, tasks())
    assert all(r.passed for r in after), "the defect must be repaired"
    assert "if raw is None" in (result.best_dir / "scripts" / "cells.py").read_text()
    assert result.improved
    assert result.best_score > result.baseline_score


def test_live_skill_is_never_written_by_training(skill: Path):
    """Whatever training does, adoption stays an explicit, separate act."""
    original = (skill / "scripts" / "cells.py").read_text(encoding="utf-8")
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    result = train(skill, tasks(), roles, PytestRunner(), cfg=cfg())

    staged = latest(skill / ".evo" / "staging")
    assert staged is not None and (staged / "manifest.json").exists()
    assert (staged / "proposed" / "scripts" / "cells.py").exists()
    # the improvement exists in staging, and only there
    assert "if raw is None" in (staged / "proposed" / "scripts" / "cells.py").read_text()
    assert (skill / "scripts" / "cells.py").read_text(encoding="utf-8") == original, \
        "training must not write the live skill; only adopt may"
    assert result.improved


def test_adopt_applies_and_backs_up(skill: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    train(skill, tasks(), roles, PytestRunner(), cfg=cfg())
    staged = latest(skill / ".evo" / "staging")

    written = adopt(staged)
    assert any("cells.py" in w for w in written)
    assert "if raw is None" in (skill / "scripts" / "cells.py").read_text()
    assert (staged / "backup" / "scripts" / "cells.py").exists()
    assert not (staged / ".adopt-transaction.json").exists(), "journal removed on commit"


def test_adopt_refuses_when_a_human_edited_the_skill(skill: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    train(skill, tasks(), roles, PytestRunner(), cfg=cfg())
    staged = latest(skill / ".evo" / "staging")

    (skill / "scripts" / "cells.py").write_text(
        BUGGY + "\n# a human touched this while the loop ran\n", encoding="utf-8")
    with pytest.raises(StagingError, match="changed since staging"):
        adopt(staged)


def test_adopt_is_not_repeatable(skill: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    train(skill, tasks(), roles, PytestRunner(), cfg=cfg())
    staged = latest(skill / ".evo" / "staging")
    adopt(staged)
    with pytest.raises(StagingError, match="adopted before"):
        adopt(staged)


# ── Bookkeeping ─────────────────────────────────────────────────────────────

def test_provenance_records_every_attempt(skill: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    train(skill, tasks(), roles, PytestRunner(), cfg=cfg())
    rows = [json.loads(x) for x in
            (skill / ".evo" / "provenance.jsonl").read_text().splitlines() if x.strip()]
    assert rows, "every bundle attempt is recorded"
    assert any(r["accepted"] for r in rows)
    for r in rows:
        assert r["evidence"], "no change is admitted without evidence"


def test_wiki_survives_rejection(skill: Path):
    """A rejected candidate rolls the skill back; the knowledge stays."""
    bad = ScriptedBackend([json.dumps({
        "symbol": "normalize_cell",
        "content": "def normalize_cell(raw):\n    try:\n        return raw\n    except:\n        pass\n",
        "repro_test": "def test_x():\n    assert True\n",
        "rationale": "swallow everything",
    })] * 4)
    roles = Roles(bad, ScriptedBackend([]), ScriptedBackend([]))
    train(skill, tasks(), roles, PytestRunner(), cfg=cfg())

    src = (skill / "scripts" / "cells.py").read_text(encoding="utf-8")
    assert "except:" not in src, "the bare-except candidate must be rejected"
    index = json.loads((skill / ".evo" / "wiki" / "index.json").read_text())
    assert index, "the wiki retains why that direction failed"
    assert any(p["kind"] == "gate-rejection" for p in index)


def test_baseline_is_frozen(skill: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    train(skill, tasks(), roles, PytestRunner(), cfg=cfg())
    base = (skill / ".evo" / "baseline" / "scripts" / "cells.py").read_text()
    assert "if raw is None" not in base, "S0 must never move"


def test_candidate_set_contains_s0(skill: Path):
    """With no usable proposal the run must return the starting point, not worse."""
    roles = Roles(ScriptedBackend(["not json at all"] * 4),
                  ScriptedBackend([]), ScriptedBackend([]))
    result = train(skill, tasks(), roles, PytestRunner(), cfg=cfg())
    assert not result.improved
    assert result.best_score >= result.baseline_score, "never worse than S0"
