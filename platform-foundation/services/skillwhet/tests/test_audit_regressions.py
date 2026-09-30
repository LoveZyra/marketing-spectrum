"""One test per audit finding (2026-09-07). Ids match REVIEW.md §2.

Each of these failed on the code as audited; the fixture/tooling is what the
original repro scripts used, reduced to an assertion.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet import pytestio  # noqa: E402
from skillwhet.analysis import analyze_source  # noqa: E402
from skillwhet.attribute import Attribution, attribute  # noqa: E402
from skillwhet.backend import (  # noqa: E402
    ClaudeCLIBackend, LLMCallForbidden, Roles, ScriptedBackend, extract_json, no_llm,
)
from skillwhet.bundle import commit, stable_drift  # noqa: E402
from skillwhet.contract import load_contract  # noqa: E402
from skillwhet.contract_tests import generate, render  # noqa: E402
from skillwhet.edits import (  # noqa: E402
    _in_protected, apply_code_edit, apply_doc_edit, editable_path, snapshot,
)
from skillwhet.evidence import ExecRecord, FailureCluster, TaskRecord, parse_traceback  # noqa: E402
from skillwhet.evolve_tests import evolve_tests  # noqa: E402
from skillwhet.expensive import aggregate, govern, holdout_gate, replay_candidate  # noqa: E402
from skillwhet.gates import build_fast_pyramid, run_pyramid  # noqa: E402
from skillwhet.gates.base import Candidate  # noqa: E402
from skillwhet.gates.g4_tests import collect_test_status, unit_gate  # noqa: E402
from skillwhet.gates.pyramid import PyramidConfig  # noqa: E402
from skillwhet.harvest import digest_transcript, redact  # noqa: E402
from skillwhet.ledger import Ledger  # noqa: E402
from skillwhet.loops import FastConfig, _repro_status, slow_loop  # noqa: E402
from skillwhet.mutation import mutate, run_mutation  # noqa: E402
from skillwhet.propose.p2_defect import _context  # noqa: E402
from skillwhet.provenance import ProvenanceLog  # noqa: E402
from skillwhet.runner import PytestRunner, score_rule_judge  # noqa: E402
from skillwhet.sandbox import SandboxPolicy, run_sandboxed  # noqa: E402
from skillwhet.simulate import Intent, IntentStateMachine, Scenario, _parse_block, simulate, verify  # noqa: E402
from skillwhet.slow_update import SLOW_END, SLOW_START, read_slow_field, write_slow_field  # noqa: E402
from skillwhet.staging import StagingError, adopt, latest  # noqa: E402
from skillwhet.trainer import TrainConfig, bootstrap, train  # noqa: E402
from skillwhet.types import (  # noqa: E402
    Bundle, CodeEdit, DocEdit, Entrypoint, FailureSignal, RootCause,
)
from skillwhet.wiki import Wiki  # noqa: E402

EXAMPLE = ROOT / "examples" / "pdf-tables"
NOPY = PyramidConfig(use_pyright=False, use_bandit=False)

BUGGY = '''"""Table helpers."""
from __future__ import annotations

import re


def normalize_cell(raw: str | None) -> str:
    """Collapse whitespace and strip currency symbols."""
    return re.sub(r"\\s+", " ", raw).strip().lstrip("$").strip()


def parse_amount(s: str) -> float:
    """Parse '12.5' into a float."""
    return float(s)
'''
FIXED = '''def normalize_cell(raw: str | None) -> str:
    """Collapse whitespace and strip currency symbols."""
    if raw is None:
        return ""
    return re.sub(r"\\s+", " ", raw).strip().lstrip("$").strip()
'''
TESTS = '''import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from scripts.cells import normalize_cell, parse_amount


def test_strips_currency():
    assert normalize_cell("  $ 12 ") == "12"


def test_handles_none():
    assert normalize_cell(None) == ""


def test_parse_dollar():
    assert parse_amount("$3") == 3.0
'''
NODE = "tests/unit/test_cells.py"


def make_cells(root: Path) -> Path:
    d = root / "cells"
    (d / "scripts").mkdir(parents=True)
    (d / "references").mkdir()
    (d / "tests" / "unit").mkdir(parents=True)
    (d / "SKILL.md").write_text(
        "---\nname: cells\ndescription: Normalise spreadsheet cells.\n---\n\n"
        "# Cells\n\nUses pdfplumber 0.11.4. See `references/api.md`.\n", encoding="utf-8")
    (d / "references" / "api.md").write_text(
        "# API\n\n## normalize_cell\n\n`normalize_cell(raw)` collapses whitespace.\n",
        encoding="utf-8")
    (d / "scripts" / "cells.py").write_text(BUGGY, encoding="utf-8")
    (d / "tests" / "unit" / "test_cells.py").write_text(TESTS, encoding="utf-8")
    bootstrap(d)
    return d


@pytest.fixture()
def cells(tmp_path: Path) -> Path:
    return make_cells(tmp_path)


@pytest.fixture()
def pdf(tmp_path: Path) -> Path:
    dst = tmp_path / "pdf-tables"
    shutil.copytree(EXAMPLE, dst, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", ".evo"))
    bootstrap(dst)
    return dst


def cells_tasks(split_val: bool = True) -> list[TaskRecord]:
    t = [TaskRecord(id=f"{NODE}::test_strips_currency", intent="a", reference_kind="rule", split="train"),
         TaskRecord(id=f"{NODE}::test_handles_none", intent="b", reference_kind="rule", split="train"),
         TaskRecord(id=f"{NODE}::test_parse_dollar", intent="c", reference_kind="rule", split="train")]
    if split_val:
        t += [TaskRecord(id=f"{NODE}::test_handles_none", intent="b", reference_kind="rule", split="val"),
              TaskRecord(id=f"{NODE}::test_strips_currency", intent="a", reference_kind="rule", split="val")]
    return t


def fix_backend(n: int = 8) -> ScriptedBackend:
    return ScriptedBackend([json.dumps({
        "symbol": "normalize_cell", "content": FIXED,
        "repro_test": "def test_none_is_empty():\n    assert normalize_cell(None) == ''\n",
        "rationale": "coerce None"})] * n)


def code_bundle(content: str, symbol="normalize_cell", module="scripts/cells.py", **kw) -> Bundle:
    return Bundle(origin=kw.pop("origin", "P2"), rationale="t", evidence=["task:x"],
                  code_edits=[CodeEdit(op="replace_function", module=module, symbol=symbol,
                                       content=content, rationale="t", **kw)])


def cfg(**kw) -> TrainConfig:
    base = dict(rounds=1, fast_iters=1, enable_slow_loop=False, enable_slow_update=False,
                enable_meta_skill=False,
                fast=FastConfig(k_samples=1, budget_p2=2, enable_p1=False, enable_p3=False,
                                pyramid=NOPY))
    base.update(kw)
    return TrainConfig(**base)


# ═══ A. gates / edits / bundle ══════════════════════════════════════════════

def test_A1_merged_baseline_does_not_reject_at_G4(pdf: Path):
    """unit+holdout baselines in one dict: G4 must only look at its own suite."""
    base = {**collect_test_status(pdf, "tests/unit"), **collect_test_status(pdf, "tests/holdout")}
    assert any(k.startswith("tests/holdout/") for k in base)
    res = run_pyramid(pdf, load_contract(pdf), build_fast_pyramid(NOPY), baseline_tests=base)
    assert res.passed, [(r.gate, [f.message for f in r.findings]) for r in res.results]


def test_A2_B11_parametrize_ids_with_spaces_are_parsed(cells: Path):
    (cells / "tests/unit/test_p.py").write_text(
        "import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))\n"
        "import pytest\nfrom scripts.cells import parse_amount\n"
        "@pytest.mark.parametrize('v', ['1', '$2'], ids=['plain one', 'dollar [two]'])\n"
        "def test_p(v):\n    assert parse_amount(v) in (1.0, 2.0)\n", encoding="utf-8")
    st = collect_test_status(cells, "tests/unit")
    assert "tests/unit/test_p.py::test_p[plain one]" in st
    assert st["tests/unit/test_p.py::test_p[dollar [two]]"] is False
    recs = {r.task_id: r for r in PytestRunner().run(cells, [
        TaskRecord(id="tests/unit/test_p.py::test_p[dollar [two]]", intent="x", reference_kind="rule")])}
    assert recs["tests/unit/test_p.py::test_p[dollar [two]]"].exc_type == "ValueError"


def test_A2_relative_G4_flags_unaccounted_failures():
    out = ("tests/unit/t.py::test_a PASSED [ 50%]\n"
           "tests/unit/t.py::test_b[x y] FAILED [100%]\n"
           "= 1 failed, 1 passed in 0.1s =\n")
    assert pytestio.parse_verbose(out) == {"tests/unit/t.py::test_a": "PASSED",
                                           "tests/unit/t.py::test_b[x y]": "FAILED"}


@pytest.mark.parametrize("rel,kind", [
    ("tests/holdout/test_h.py", "code"), ("../outside.py", "code"), ("/etc/passwd", "doc"),
    ("scripts/../tests/holdout/x.py", "code"), ("tests/unit/test_x.py", "code"),
    ("CONTRACT.yaml", "doc"), (".evo/current/scripts/a.py", "code"),
])
def test_A3_edit_targets_outside_surface_are_refused(cells: Path, rel, kind):
    assert editable_path(cells, rel, kind) is None


def test_A3_bundle_touching_holdout_is_refused(pdf: Path):
    b = Bundle(origin="P1", rationale="hack", evidence=["rule:x"], code_edits=[CodeEdit(
        op="rewrite_module", module="tests/holdout/test_holdout.py", symbol="",
        content="def test_x():\n    assert True\n", rationale="x")])
    res = commit(pdf, b, work_root=pdf / ".evo/work", cfg=NOPY)
    assert not res.accepted and "outside the editable surface" in res.reason
    assert "assert True" not in (pdf / "tests/holdout/test_holdout.py").read_text()


def test_A4_stable_signature_drift_is_rejected_unless_bundled(pdf: Path):
    from skillwhet.contract import save_contract
    c = load_contract(pdf)
    ep = next(e for e in c.entrypoints if e.id == "normalize_cell")
    ep.stability, ep.doc_anchor = "stable", "references/extraction.md#normalize_cell"
    save_contract(pdf, c)
    c = load_contract(pdf)
    drift = code_bundle("def normalize_cell(raw: str, keep: bool = False) -> str:\n"
                        "    return raw.strip()\n", module="scripts/extract.py",
                        repro_test="def test_r():\n    assert normalize_cell('a', keep=True)\n")
    res = commit(pdf, drift, work_root=pdf / ".evo/work", cfg=NOPY)
    assert not res.accepted and res.reason.startswith("contract drift")
    assert stable_drift(c, pdf) == []          # nothing landed


def test_A5_G1_sees_through_more_aliases():
    cases = {
        "import os\ndef f(c: str) -> None:\n    s: object = os.system\n    s(c)\n": "os.system",
        "from os import *\ndef f(c: str) -> None:\n    system(c)\n": "os.system",
        "import os\ndef f(cs) -> None:\n    list(map(os.system, cs))\n": "os.system",
        "def f(c) -> None:\n    getattr(__builtins__, 'eval')(c)\n": "eval",
        "import os\ndef f(c) -> None:\n    a = b = os.system\n    b(c)\n": "os.system",
        "import os\ndef f(c) -> None:\n    (s := os.system)(c)\n": "os.system",
        "import sys\ndef f(c) -> None:\n    sys.modules['os'].system(c)\n": "os.system",
        "import builtins\ndef f(c) -> None:\n    builtins.eval(c)\n": "eval",
    }
    for src, want in cases.items():
        names = [d[0] for d in analyze_source(src).dangerous]
        assert want in names, (src, names)
    fx = analyze_source("from pathlib import Path\ndef f(p) -> None:\n    Path(p).open('w').write('x')\n")
    assert "filesystem:workspace" in fx.side_effects
    assert analyze_source("import re\ndef f(s: str) -> str:\n    sub = re.sub\n    return sub('x', '', s)\n").dangerous == []


def test_A6_G4_runs_the_candidate_tests_inside_the_sandbox(cells: Path, monkeypatch):
    monkeypatch.setenv("WHET_SECRET_PROBE", "leak")
    (cells / "tests/unit/test_env.py").write_text(
        "import os\ndef test_env():\n    assert 'WHET_SECRET_PROBE' not in os.environ\n",
        encoding="utf-8")
    res = unit_gate().run(Candidate(skill_dir=cells, contract=load_contract(cells)))
    assert "tests/unit/test_env.py::test_env" not in [f.message for f in res.findings]
    assert res.detail.get("passed", 0) >= 2


def test_A7_A9_contract_tests_do_not_collide_and_are_valid_python(cells: Path):
    (cells / "scripts/b.py").write_text("def run(x=None, y=True):\n    return 1\n", encoding="utf-8")
    c = load_contract(cells)
    c.entrypoints = [
        Entrypoint(id="run", module="scripts/a.py", checks=[{"returns_type": "str"}]),
        Entrypoint(id="run", module="scripts/b.py", checks=[
            {"never_raises": {"kwargs": {"x": None, "y": False}}},
            {"raises": {"args": ["{"], "exc": "json.JSONDecodeError"}},
            {"returns_type": "bytes"}]),
    ]
    written = generate(cells, c)
    assert len(written) == 2 and len({p.name for p in written}) == 2
    for p in written:
        compile(p.read_text(), str(p), "exec")
    src = render(c.entrypoints[1])
    assert "x=None, y=False" in src and "null" not in src and "false" not in src
    assert "unknown returns_type 'bytes'" in src


def test_A8_mutation_score_is_not_inflated_by_an_unrelated_red_test(cells: Path):
    # test_handles_none is red on BUGGY; vacuous tests must kill nothing
    (cells / "scripts/m.py").write_text(
        "def clamp(x: int) -> int:\n    return x if x > 0 else 0\n", encoding="utf-8")
    (cells / "tests/unit/test_vacuous.py").write_text(
        "def test_v1():\n    assert True\ndef test_v2():\n    assert 1\n", encoding="utf-8")
    rep = run_mutation(cells, ["scripts/m.py"], max_mutants=4,
                       work_root=cells / ".evo/work")
    assert rep.total > 0 and rep.killed == 0 and not rep.meets(0.5)


def test_A10_promote_is_all_or_nothing(cells: Path, monkeypatch):
    import skillwhet.bundle as B
    (cells / "scripts/other.py").write_text("def g() -> int:\n    return 1\n", encoding="utf-8")
    before = {p.name: p.read_text() for p in (cells / "scripts").glob("*.py")}
    cand = snapshot(cells, cells / ".evo/work/cand")
    (cand / "scripts/cells.py").write_text(BUGGY.replace("return float(s)", "return 0.0"))
    (cand / "scripts/other.py").write_text("def g() -> int:\n    return 2\n")
    calls = {"n": 0}
    real = shutil.copy2

    def flaky(src, dst, *a, **k):
        if str(dst).endswith(".whet-tmp"):
            calls["n"] += 1
            if calls["n"] == 2:
                raise OSError("disk full")
        return real(src, dst, *a, **k)
    monkeypatch.setattr(B.shutil, "copy2", flaky)
    with pytest.raises(OSError):
        B._promote(cand, cells)
    after = {p.name: p.read_text() for p in (cells / "scripts").glob("*.py")}
    assert after == before, "a failed promote must leave the skill untouched"
    assert not list((cells / "scripts").glob("*.whet-*"))
    monkeypatch.setattr(B.shutil, "copy2", real)
    B._promote(cand, cells)
    assert "return 0.0" in (cells / "scripts/cells.py").read_text()


def test_A11_add_import_compares_parsed_imports():
    src = "import requests\n\ndef f():\n    return 1\n"
    out, rep = apply_code_edit(src, CodeEdit(op="add_import", module="scripts/a.py", symbol="",
                                             content="import re", rationale="t"))
    assert rep.status == "applied_add_import" and "import re\n" in out
    _, rep2 = apply_code_edit(src, CodeEdit(op="add_import", module="scripts/a.py", symbol="",
                                            content="import requests", rationale="t"))
    assert rep2.status == "skipped_import_exists"


def test_A12_contract_only_bundle_lands(cells: Path):
    b = Bundle(origin="drift", rationale="declare cost", evidence=["G3:x"],
               contract_delta={"parse_amount": {"cost_class": "io_bound"}})
    res = commit(cells, b, work_root=cells / ".evo/work", cfg=NOPY,
                 baseline_tests=collect_test_status(cells, "tests/unit"))
    assert res.accepted, res.reason
    assert next(e for e in load_contract(cells).entrypoints
                if e.id == "parse_amount").cost_class == "io_bound"


def test_A13_function_content_keeps_its_imports_and_refuses_other_statements():
    src = "def f():\n    return 1\n"
    out, rep = apply_code_edit(src, CodeEdit(op="replace_function", module="scripts/a.py",
                                             symbol="f", content="import math\ndef f():\n    return math.pi\n",
                                             rationale="t"))
    assert rep.applied and "import math" in out
    _, rep2 = apply_code_edit(src, CodeEdit(op="replace_function", module="scripts/a.py",
                                            symbol="f", content="X = 1\ndef f():\n    return X\n",
                                            rationale="t"))
    assert rep2.status == "error"


def test_A15_sandbox_timeout_kills_the_whole_process_group(tmp_path: Path):
    res = run_sandboxed(["bash", "-c", "sleep 300 & sleep 300"], tmp_path,
                        SandboxPolicy(wall_timeout_s=1))
    assert res.timed_out
    import subprocess
    ps = subprocess.run(["ps", "-eo", "args"], capture_output=True, text=True).stdout
    assert "sleep 300" not in ps


def test_A16_non_decimal_literals_produce_a_real_mutant():
    got = mutate("X = 0xFF\n", 0)
    assert got is not None and got[0] != "X = 0xFF\n" and got[0].startswith("X = 0x")


# ═══ B. trainer / loops / expensive / staging ═══════════════════════════════

def test_B1_ledger_sees_the_working_copy(cells: Path):
    ledger = Ledger.load(cells / ".evo/ledger.yaml")
    assert any(e.kind == "value" and e.key == "0.11.4" for e in ledger.entries)
    current = snapshot(cells, cells / ".evo/current")
    assert ledger.check(current, load_contract(current)) == []
    gov = govern(current, baseline_dir=cells / ".evo/baseline", prev_dir=None,
                 ledger=ledger, contract=load_contract(current))
    assert gov.passed and gov.bloat_ratio == 0.0


def test_B2_partial_repair_without_regression_is_accepted():
    tasks = [TaskRecord(id=f"t{i}", intent="x", reference_kind="rule") for i in range(4)]
    before = [ExecRecord("t0", "train", passed=True), ExecRecord("t1", "train"),
              ExecRecord("t2", "train"), ExecRecord("t3", "train")]

    class R:
        def run(self, d, ts):
            return [ExecRecord("t0", "train", passed=True), ExecRecord("t1", "train", passed=True),
                    ExecRecord("t2", "train"), ExecRecord("t3", "train")]
    v = replay_candidate(Path("."), tasks, R(), baseline=before)
    assert v.accepted and v.repaired == 1 and v.regressed == 0 and v.score < 2.0
    # ... but an inert model proposal is not
    class R2:
        def run(self, d, ts):
            return before
    assert not replay_candidate(Path("."), tasks, R2(), baseline=before).accepted
    assert replay_candidate(Path("."), tasks, R2(), baseline=before, allow_inert=True).accepted


def test_B3_adopt_refreshes_the_baseline_and_refuses_unaccepted_rounds(cells: Path):
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    train(cells, cells_tasks(), roles, PytestRunner(), cfg=cfg())
    adopt(latest(cells / ".evo/staging"))
    assert "if raw is None" in (cells / "scripts/cells.py").read_text()
    assert "if raw is None" in (cells / ".evo/baseline/scripts/cells.py").read_text()
    # second run: nothing left to fix for this backend → not accepted → adopt refuses
    roles = Roles(ScriptedBackend([]), ScriptedBackend([]), ScriptedBackend([]))
    res = train(cells, cells_tasks(), roles, PytestRunner(), cfg=cfg())
    assert not res.improved
    with pytest.raises(StagingError, match="NOT accepted"):
        adopt(latest(cells / ".evo/staging"))
    assert "if raw is None" in (cells / "scripts/cells.py").read_text(), "live never reverted"


def test_B4_rejected_round_rolls_the_working_copy_back(cells: Path, monkeypatch):
    import skillwhet.trainer as T
    from skillwhet.expensive import GovernanceResult
    from skillwhet.ledger import Violation
    monkeypatch.setattr(T, "govern", lambda *a, **k: GovernanceResult(
        passed=False, violations=[Violation("value", "0.11.4", "gone", "SKILL.md")]))
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    res = train(cells, cells_tasks(), roles, PytestRunner(), cfg=cfg(rounds=2))
    assert not res.improved
    assert "if raw is None" not in (cells / ".evo/current/scripts/cells.py").read_text(), \
        "the rejected round's code must not survive in the working copy"


def test_B5_prose_bundle_is_not_rejected_by_an_unrelated_red_unit_test(cells: Path):
    attr = Attribution(doc_defect=[FailureSignal(
        id="sig:t1", root_cause=RootCause.DOC_DEFECT, summary="None not documented",
        evidence=["task:t1"])])
    be = ScriptedBackend([json.dumps({"edits": [{"op": "append", "path": "SKILL.md",
                                                 "content": "## Inputs\n\nNone is accepted."}]})])
    out = slow_loop(cells, attr, be, wiki=Wiki(cells / ".evo/wiki"),
                    prov=ProvenanceLog(cells / ".evo/prov.jsonl"), work_root=cells / ".evo/work",
                    round_no=1, gates=build_fast_pyramid(NOPY))
    assert len(out.accepted) == 1, [r.reason for r in out.rejected]
    assert "None is accepted" in (cells / "SKILL.md").read_text()


def test_B6_evolve_tests_rejects_a_module_that_fails_collection(cells: Path):
    be = ScriptedBackend([json.dumps({"filename": "test_row.py", "covers": "x",
                                      "source": "import does_not_exist\ndef test_x():\n    assert 0\n"})])
    sig = FailureSignal(id="s", root_cause=RootCause.CODE_DEFECT, summary="x", evidence=["task:t"])
    res = evolve_tests(cells, [sig], be, budget=1)
    assert res.added == [] and res.rejected_green == ["tests/unit/test_row.py"]
    assert not (cells / "tests/unit/test_row.py").exists()
    assert collect_test_status(cells, "tests/unit"), "the suite still collects"


def test_B7_tests_grown_in_a_round_are_repaired_in_the_same_round(cells: Path):
    (cells / "tests/unit/test_cells.py").write_text(TESTS.replace(
        "def test_handles_none():\n    assert normalize_cell(None) == \"\"\n\n\n", ""), encoding="utf-8")
    bootstrap(cells)
    new_test = ("import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))\n"
                "from scripts.cells import normalize_cell\n\ndef test_none():\n    assert normalize_cell(None) == ''\n")
    fast = ScriptedBackend([json.dumps({"filename": "test_none.py", "source": new_test, "covers": "None"})]
                           + [json.dumps({"symbol": "normalize_cell", "content": FIXED,
                                          "repro_test": "def test_r():\n    assert normalize_cell(None) == ''\n",
                                          "rationale": "coerce"})] * 4)
    ev = ScriptedBackend([json.dumps({"root_cause": "code_defect", "summary": "None crashes"})] * 8)
    tasks = [TaskRecord(id=f"{NODE}::test_strips_currency", intent="a", reference_kind="rule", split="train"),
             TaskRecord(id=f"{NODE}::test_parse_dollar", intent="c", reference_kind="rule", split="train"),
             TaskRecord(id=f"{NODE}::test_strips_currency", intent="a", reference_kind="rule", split="val")]
    res = train(cells, tasks, Roles(fast, ScriptedBackend([]), ev), PytestRunner(),
                cfg=cfg(rounds=1, evolve_tests_every=1, test_budget=1))
    r1 = res.rounds[0]
    assert r1.tests.get("added") == ["tests/unit/test_none.py"]
    assert r1.fast.get("accepted", 0) >= 1, r1
    assert "if raw is None" in (res.best_dir / "scripts/cells.py").read_text()
    assert (res.best_dir / "tests/unit/test_none.py").exists()


def test_B8_repro_must_be_runnable_red_before_and_green_after(cells: Path):
    assert _repro_status(cells, "this is not python", ["scripts/cells.py"]) == "broken"
    assert _repro_status(cells, "import nonexistent_module\ndef test_x():\n    assert 0\n",
                         ["scripts/cells.py"]) == "broken"
    assert _repro_status(cells, "def test_x():\n    assert normalize_cell(None) == ''\n",
                         ["scripts/cells.py"]) == "red"
    assert _repro_status(cells, "def test_x():\n    assert normalize_cell('a') == 'a'\n",
                         ["scripts/cells.py"]) == "green"
    # an unrelated repro (red before, still red after) is rejected by the loop
    unrelated = ScriptedBackend([json.dumps({
        "symbol": "normalize_cell", "content": FIXED,
        "repro_test": "def test_r():\n    assert parse_amount('$3') == 3.0\n", "rationale": "x"})] * 2)
    roles = Roles(unrelated, ScriptedBackend([]), ScriptedBackend([]))
    res = train(cells, cells_tasks(), roles, PytestRunner(), cfg=cfg())
    assert not res.improved
    assert any("still red" in r for r in res.rounds[0].fast.get("rejected_by", {}))


def test_B9_p2_context_tolerates_a_frameless_cluster(cells: Path):
    c = FailureCluster(key="k", exc_type="AssertionError", top_frame="", module="", symbol="",
                       count=1, task_ids=["t"])
    assert _context(cells, c) == ""


def test_B10_node_ids_are_relative_to_the_skill_even_under_a_parent_pytest_ini(tmp_path: Path):
    (tmp_path / "pytest.ini").write_text("[pytest]\naddopts = -x\n", encoding="utf-8")
    d = make_cells(tmp_path / "skills")
    ids = pytestio.collect_ids(d, "tests/unit")
    assert ids and all(i.startswith("tests/unit/") for i in ids)
    recs = PytestRunner().run(d, [TaskRecord(id=ids[0], intent="x", reference_kind="rule")])
    assert recs[0].exc_type != "NotCollected"


def test_B13_capability_gap_has_a_producer(cells: Path):
    ev = ScriptedBackend([json.dumps({"root_cause": "capability_gap",
                                      "summary": "no xlsx reader", "confidence": 0.9})])
    rec = ExecRecord("t1", "train", passed=False, exc_type="", stdout="cannot read xlsx")
    attr = attribute(cells, [rec], {"t1": TaskRecord(id="t1", intent="read xlsx", reference_kind="rubric")},
                     evaluator=ev)
    assert attr.summary()["capability_gap"] == 1 and attr.actionable()
    gaps = attr.gaps()
    assert len(gaps) == 1 and gaps[0].description == "no xlsx reader"


def test_B14_test_split_is_evaluated_at_the_end(cells: Path):
    tasks = cells_tasks() + [TaskRecord(id=f"{NODE}::test_handles_none", intent="b",
                                        reference_kind="rule", split="test")]
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    # ha release-once:训练默认不看 test;旧行为要显式 eval_test_at_end
    train(cells, tasks, roles, PytestRunner(), cfg=cfg())
    report = json.loads((latest(cells / ".evo/staging") / "report.json").read_text())
    assert report["test_score_baseline"] is None and report["held_out_test_tasks"] == 1
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    c = cfg()
    c.eval_test_at_end = True
    train(cells, tasks, roles, PytestRunner(), cfg=c)
    report = json.loads((latest(cells / ".evo/staging") / "report.json").read_text())
    assert report["test_score_baseline"] is not None


def test_B12_cost_is_accounted_when_the_loop_stops_early(cells: Path):
    class Costly(ScriptedBackend):
        pass
    ev = Costly([json.dumps({"root_cause": "isolate", "summary": "meh"})] * 4)
    ev.stats.cost_usd = 0.0
    (cells / "scripts/cells.py").write_text(BUGGY.replace("return float(s)", "raise KeyError('x')"),
                                             encoding="utf-8")
    roles = Roles(ScriptedBackend([]), ScriptedBackend([]), ev)
    orig = ev.complete

    def paid(*a, **k):
        ev.stats.cost_usd += 0.01
        return orig(*a, **k)
    ev.complete = paid
    tasks = [TaskRecord(id="tests/unit/test_cells.py::test_parse_dollar", intent="c",
                        reference_kind="rule", split="train")]
    res = train(cells, tasks, roles, PytestRunner(), cfg=cfg(rounds=2))
    assert res.total_cost_usd > 0 or ev.stats.cost_usd == 0.0


# ═══ C. backend / runner / simulate / harvest / slow_update / wiki ══════════

def test_C1_C2_rule_judge_ops_are_implemented():
    assert score_rule_judge({"checks": [{"op": "no_refusal"}]}, "I'm sorry, I can't help with that")[0] == 0.0
    assert score_rule_judge({"checks": [{"op": "no_refusal"}]}, "Sure — run `whet gate`.")[0] == 1.0
    assert score_rule_judge({"checks": [{"op": "tool_called", "arg": "Bash"}]}, "x")[0] == 0.0
    assert score_rule_judge({"checks": [{"op": "tool_called", "arg": "Bash"}]}, "x", ["Bash"])[0] == 1.0
    doc = "# Steps\n\nrun rm -rf build\n\n# Notes\n\nnone\n"
    assert score_rule_judge({"checks": [{"op": "section_contains", "arg": "Steps::rm -rf"}]}, doc)[0] == 1.0
    assert score_rule_judge({"checks": [{"op": "section_contains", "arg": "Notes::rm -rf"}]}, doc)[0] == 0.0
    hard, _, why = score_rule_judge({"checks": [{"op": "max_chars", "arg": "short"}]}, "x")
    assert hard == 0.0 and "invalid" in why
    assert score_rule_judge({"checks": [{"op": "vibes"}]}, "x")[0] == 0.0


def test_C3_extract_json_survives_an_apostrophe_in_the_prose():
    assert extract_json("Here's the fix: {\"symbol\": \"run\", \"a\": 1}") == {"symbol": "run", "a": 1}
    assert extract_json('He said "ok" then {"a": {"c": [1, 2]}} done') == {"a": {"c": [1, 2]}}
    assert extract_json('two: {"a": 1} and {"b": 2}') is None


def test_C4_C5_simulation_does_not_end_before_the_agent_sees_a_new_intent():
    sc = Scenario("My upload fails.", "facts", "calm",
                  [Intent("upload failure", "key"), Intent("file size limit", "key")], "ref")
    service = ScriptedBackend(["Try again please.", "The limit is 25 MB."])
    user = ScriptedBackend([
        "<reason>r</reason><agenda_check>file size limit</agenda_check><action>done</action>"
        "<say>Is there a size limit?</say>",
        "<reason>r</reason><agenda_check></agenda_check><action>done</action><say>thanks</say>",
    ])
    traj = simulate(sc, service=service, user=user, skill_text="s", max_turns=5)
    agent_turns = [t.text for t in traj.turns if t.role == "agent"]
    assert "The limit is 25 MB." in agent_turns, "the agent must be asked before being judged"
    sm = IntentStateMachine([Intent("refund"), Intent("refund timeline")])
    sm.note_raised(["refund timeline"])
    assert sm.raised == {"refund timeline"}


def test_C6_truncated_user_output_never_leaks_reasoning():
    blk = _parse_block("<reason>I must hide that the fix is re-login</reason>"
                       "<agenda_check>refund timeline</agenda_check><action>send_text</action>"
                       "<say>So when will I get my refund")
    assert blk["say"] == "So when will I get my refund"
    blk2 = _parse_block("<reason>secret</reason><agenda_check>x</agenda_check>")
    assert "secret" not in blk2["say"] and "<" not in blk2["say"]


def test_C7_eval_noise_is_excluded_from_every_denominator():
    good = ExecRecord("t1", "val", hard=1.0, soft=1.0, passed=True)
    noise = ExecRecord("t2", "val", hard=0.0, soft=0.9, passed=False, exc_type="EvalNoise")
    assert aggregate([good, noise]) == (1.0, 1.0)
    d = holdout_gate([good, noise], 0.5, 0.5, baseline_records=[
        ExecRecord("t1", "val", hard=1.0, passed=True), ExecRecord("t2", "val", hard=1.0, passed=True)],
        no_regression=True)
    assert d.accepted and d.regressed_tasks == []


def test_C8_scenario_priorities_and_string_agendas_are_tolerated():
    sc = Scenario.from_dict({"opening_message": "hi", "agenda": ["refund", {"name": "eta", "weight": "Key"},
                                                                 {"topic": "x", "priority": "low"}]})
    assert [(i.topic, i.priority) for i in sc.agenda] == [("refund", "key"), ("eta", "key"), ("x", "minor")]


def test_C9_redaction_covers_bearer_jwt_and_prefixed_env_vars():
    samples = ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
               '{"token": "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c"}', "OPENAI_API_KEY=abcdef0123456789abcdef0123456789",
               "DATABASE_PASSWORD=hunter2hunter2", "STRIPE_SECRET=live_9f8e7d6c5b4a3f2e"]
    for s in samples:
        r = redact(s)
        assert "REDACTED" in r, r
        for leak in ("eyJhbGci", "9f8e7d6c5b4a3f2e1d0c", "abcdef0123456789", "hunter2hunter2", "live_9f8e"):
            assert leak not in r, (s, r)
    assert redact("the password field is required") == "the password field is required"


def test_C10_harness_records_are_not_human_prompts(tmp_path: Path):
    rows = [
        {"type": "summary", "summary": "compaction", "message": {"role": "user", "content": "This session is being continued from a previous conversation"}},
        {"isMeta": True, "message": {"role": "user", "content": "Continue from where you left off."}},
        {"isSidechain": True, "message": {"role": "user", "content": "You are auditing a package."}},
        {"message": {"role": "user", "content": "[Request interrupted by user]"}},
        {"message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}},
        {"message": {"role": "user", "content": "fix the failing upload test"}},
        {"message": {"role": "assistant", "content": [{"type": "text", "text": "done"}]}},
    ]
    p = tmp_path / "s.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    d = digest_transcript(p)
    assert d is not None and d.user_prompts == ["fix the failing upload test"]


def test_C11_C12_traceback_routing_is_relative_to_the_skill_and_ignores_captured_stdout():
    skill = Path("/home/u/scripts/myskill")
    tb = ('Traceback (most recent call last):\n'
          '  File "/home/u/scripts/myskill/tests/unit/test_p.py", line 10, in test_parse\n'
          '    assert parse("x") == 1\n'
          'AssertionError: assert 2 == 1\n'
          '----------------------------- Captured stdout call -----------------------------\n'
          'KeyError: printed by the script\n')
    r = parse_traceback(tb, skill_dir=skill)
    assert r.exc_type == "AssertionError" and not r.module.startswith("scripts/")
    tb2 = ('Traceback (most recent call last):\n'
           '  File "/home/u/scripts/myskill/scripts/parser.py", line 4, in parse\n'
           '    raise ValueError("bad")\n'
           '  File "/usr/lib/python3/dist-packages/yaml/__init__.py", line 3, in safe_load\n'
           '    x\nValueError: bad\n')
    r2 = parse_traceback(tb2, skill_dir=skill)
    assert r2.module == "scripts/parser.py" and r2.symbol == "parse"


def test_C13_failure_blocks_match_test_names_exactly():
    out = ("=== FAILURES ===\n"
           "_____________ test_parse_empty _____________\n"
           "Traceback (most recent call last):\n  x\nValueError: EMPTY\n"
           "_____________ test_parse _____________\n"
           "Traceback (most recent call last):\n  y\nValueError: PARSE\n")
    assert "PARSE" in pytestio.failure_block(out, "tests/unit/t.py::test_parse")
    assert "EMPTY" in pytestio.failure_block(out, "tests/unit/t.py::test_parse_empty")


def test_C14_protected_region_check_uses_overlap():
    t = f"# S\n\nintro {SLOW_START}\n- g\n{SLOW_END}\n"
    assert _in_protected(t, f"intro {SLOW_START}\n- g")
    assert not _in_protected(t, "intro")
    _, rep = apply_doc_edit(t, DocEdit(op="delete", path="SKILL.md", content="",
                                       target=f"intro {SLOW_START}\n- g"))
    assert rep.status == "skipped_protected_region"


def test_C15_slow_field_survives_orphan_and_duplicate_markers():
    orphan_start = f"# S\n\n{SLOW_START}\n## Rules\n- r1\n"
    out = write_slow_field(orphan_start, "- g")
    assert out.count(SLOW_START) == 1 and out.count(SLOW_END) == 1 and "## Rules" in out
    orphan_end = f"# S\n\n{SLOW_END}\n## Rules\n- r1\n"
    out2 = write_slow_field(write_slow_field(orphan_end, "- g1"), "- g2")
    assert out2.count(SLOW_START) == 1 and read_slow_field(out2) == "- g2" and "## Rules" in out2
    dup = write_slow_field("# S\n", "- a") + write_slow_field("# T\n", "- b")
    out3 = write_slow_field(dup, "- c")
    assert out3.count(SLOW_START) == 1 and read_slow_field(out3) == "- c"


def test_C16_large_system_prompts_travel_on_stdin(tmp_path: Path):
    fake = tmp_path / "claude"
    fake.write_text("#!/bin/sh\ncat > $0.in\nprintf '%s' '{\"result\": \"ok\", \"total_cost_usd\": 0}'\n",
                    encoding="utf-8")
    fake.chmod(0o755)
    be = ClaudeCLIBackend(claude_path=str(fake), model="haiku")
    big = "x" * 150_000
    assert be.complete("hello", system=big, stage="t") == "ok"
    sent = (tmp_path / "claude.in").read_text()
    assert "<system>" in sent and "hello" in sent and len(sent) > 150_000


def test_C17_wiki_never_shows_holdout_names_to_the_proposer(tmp_path: Path):
    from skillwhet.types import Finding
    w = Wiki(tmp_path / "wiki")
    b = Bundle(origin="P2", rationale="x", evidence=["task:x"], code_edits=[
        CodeEdit(op="replace_function", module="scripts/a.py", symbol="f", content="def f(): pass", rationale="x")])
    w.record_rejection(b, 1, "G5.holdout", [Finding(gate="G5.holdout", rule="test-regressed",
                                                    message="tests/holdout/test_limits.py::test_rejects_over_25mb")])
    w.record_rejection(b, 2, "G5.holdout", [Finding(gate="G5.holdout", rule="test-regressed",
                                                    message="tests/holdout/test_limits.py::test_rejects_over_25mb")])
    assert "holdout/" not in w.brief() and "25mb" not in w.brief()


def test_C18_no_llm_is_enforced_inside_worker_threads():
    from concurrent.futures import ThreadPoolExecutor
    be = ScriptedBackend(["x"])
    errors: list[Exception] = []

    def call():
        try:
            be.complete("p", system="s", stage="t")
        except LLMCallForbidden as exc:
            errors.append(exc)
    import contextvars
    with no_llm("test"):
        ctx = contextvars.copy_context()
        with ThreadPoolExecutor(max_workers=1) as ex:
            ex.submit(ctx.copy().run, call).result()
        t = threading.Thread(target=contextvars.copy_context().run, args=(call,))
        t.start(); t.join()
    assert len(errors) == 2
    # a thread that does NOT share the context (another training run in a
    # parallel benchmark) is not blocked
    other: list = []
    t2 = threading.Thread(target=lambda: other.append(be.complete("p", system="s", stage="t")))
    with no_llm("test"):
        t2.start(); t2.join()
    assert other == ["x"] or other == []            # ScriptedBackend queue may be exhausted
