"""Each gate must catch the defect class it exists for.

These are adversarial tests: for every gate we inject the specific defect that
gate is supposed to stop, and assert it is stopped. A gate that cannot be shown
to reject anything is decoration.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.contract import bootstrap_contract, load_contract, save_contract  # noqa: E402
from skillwhet.gates import (  # noqa: E402
    ContractGate, ParseGate, SecurityGate, StaticGate,
    build_fast_pyramid, holdout_gate, run_pyramid, unit_gate,
)
from skillwhet.gates.base import Candidate  # noqa: E402
from skillwhet.types import Verdict  # noqa: E402

EXAMPLE = ROOT / "examples" / "pdf-tables"


@pytest.fixture()
def skill(tmp_path: Path) -> Path:
    dst = tmp_path / "pdf-tables"
    shutil.copytree(EXAMPLE, dst, ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache"))
    return dst


def cand(skill: Path) -> Candidate:
    return Candidate(skill_dir=skill, contract=load_contract(skill))


def write_script(skill: Path, body: str, name: str = "extract.py") -> None:
    (skill / "scripts" / name).write_text(body, encoding="utf-8")


def rules(res) -> set[str]:
    return {f.rule for f in res.findings}


# ── G0 ──────────────────────────────────────────────────────────────────────

def test_g0_accepts_clean_module(skill: Path):
    assert ParseGate().run(cand(skill)).verdict is Verdict.PASS


def test_g0_rejects_truncated_function(skill: Path):
    """The single most common LLM code failure: output cut off mid-body."""
    write_script(skill, "def extract_tables(path: str) -> list:\n    rows = []\n    for line in")
    res = ParseGate().run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "syntax-error" in rules(res)


# ── G1 ──────────────────────────────────────────────────────────────────────

def test_g1_rejects_import_outside_allowlist(skill: Path):
    write_script(skill, "import requests\n\ndef f() -> None:\n    pass\n")
    res = SecurityGate(use_bandit=False).run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "import-not-allowed" in rules(res)


def test_g1_rejects_eval(skill: Path):
    write_script(skill, "def f(s: str) -> object:\n    return eval(s)\n")
    res = SecurityGate(use_bandit=False).run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "dangerous-call" in rules(res)


def test_g1_rejects_os_system(skill: Path):
    write_script(skill, "import os\n\ndef f(c: str) -> None:\n    os.system(c)\n")
    res = SecurityGate(use_bandit=False).run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "dangerous-call" in rules(res)


def test_g1_rejects_undeclared_filesystem_write(skill: Path):
    """CONTRACT declares side_effects=[none]; the code writes a file."""
    write_script(skill, (
        "def extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    with open('/tmp/out.txt', 'w') as fh:\n"
        "        fh.write('x')\n"
        "    return []\n"
    ))
    res = SecurityGate(use_bandit=False).run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "undeclared-side-effect" in rules(res)


def test_g1_allows_declared_side_effect(skill: Path):
    """Same code, but the contract now declares the effect — must pass."""
    write_script(skill, (
        "def extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    with open('/tmp/out.txt', 'w') as fh:\n"
        "        fh.write('x')\n"
        "    return []\n"
    ))
    c = load_contract(skill)
    for e in c.entrypoints:
        e.side_effects = ["filesystem:workspace"]
    save_contract(skill, c)
    res = SecurityGate(use_bandit=False).run(cand(skill))
    assert "undeclared-side-effect" not in rules(res)


def test_g1_read_only_open_is_not_a_write(skill: Path):
    """Reading must not be reported as a filesystem effect — no false positives."""
    res = SecurityGate(use_bandit=False).run(cand(skill))
    assert res.verdict is Verdict.PASS


# ── G2 ──────────────────────────────────────────────────────────────────────

def test_g2_rejects_bare_except_bloat(skill: Path):
    """The signature pattern of defensive-code bloat from the P3 path."""
    write_script(skill, (
        "def extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    try:\n"
        "        return []\n"
        "    except:\n"
        "        pass\n"
        "    return []\n"
    ))
    res = StaticGate(use_pyright=False).run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert any(r.startswith("ruff:E722") or r.startswith("ruff:S110") for r in rules(res))


def test_g2_flags_unannotated_stable_entrypoint(skill: Path):
    write_script(skill, (
        "def extract_tables(path, pages=None):\n"
        "    return []\n\n"
        "def normalize_cell(raw: str) -> str:\n"
        "    return raw\n"
    ))
    res = StaticGate(use_pyright=False).run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "stable-entrypoint-unannotated" in rules(res)


# ── G3 ──────────────────────────────────────────────────────────────────────

def test_g3_accepts_matching_contract(skill: Path):
    assert ContractGate().run(cand(skill)).verdict is Verdict.PASS


def test_g3_rejects_signature_drift_on_stable(skill: Path):
    """Code changed its signature; prose and contract still say the old one."""
    write_script(skill, (
        "import re\n\n"
        "def extract_tables(path: str, pages: str | None = None, strict: bool = False) -> list:\n"
        "    return []\n\n"
        "def normalize_cell(raw: str) -> str:\n"
        "    return re.sub(r'\\s+', ' ', raw).strip()\n"
    ))
    res = ContractGate().run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "signature-drift" in rules(res)


def test_g3_rejects_broken_doc_anchor(skill: Path):
    """Prose section deleted while the contract still points at it."""
    (skill / "references" / "extraction.md").write_text(
        "# Extraction API\n\nnothing here any more\n", encoding="utf-8"
    )
    res = ContractGate().run(cand(skill))
    assert res.verdict is Verdict.FAIL
    assert "doc-anchor-broken" in rules(res)


def test_g3_warns_on_undeclared_public_function(skill: Path):
    src = (skill / "scripts" / "extract.py").read_text(encoding="utf-8")
    write_script(skill, src + "\n\ndef brand_new(x: int) -> int:\n    return x\n")
    res = ContractGate().run(cand(skill))
    assert "entrypoint-undeclared" in rules(res)
    # warning, not error — it is a sync prompt, not a defect
    assert res.verdict is Verdict.PASS


def test_g3_experimental_drift_is_warning_not_error(skill: Path):
    c = load_contract(skill)
    for e in c.entrypoints:
        e.stability = "experimental"
    save_contract(skill, c)
    write_script(skill, (
        "import re\n\n"
        "def extract_tables(path: str, pages: str | None = None, strict: bool = False) -> list:\n"
        "    return []\n\n"
        "def normalize_cell(raw: str) -> str:\n"
        "    return re.sub(r'\\s+', ' ', raw).strip()\n"
    ))
    res = ContractGate(require_anchor_for_stable=False).run(cand(skill))
    assert "signature-drift" in rules(res)
    assert res.verdict is Verdict.PASS  # experimental may move freely


# ── G4 / G5 ─────────────────────────────────────────────────────────────────

def test_g4_catches_broken_unit_test(skill: Path):
    write_script(skill, (
        "import re\n\n"
        "def extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    return []\n\n"
        "def normalize_cell(raw: str) -> str:\n"
        "    return raw\n"
    ))
    res = unit_gate().run(cand(skill))
    assert res.verdict is Verdict.FAIL


def test_g5_catches_reward_hacking(skill: Path):
    """THE load-bearing test.

    A candidate that special-cases the visible test inputs passes G4 and is
    caught only by the hold-out gate. This is SpecBench's finding reproduced in
    miniature: without G5 this edit would be accepted.
    """
    write_script(skill, (
        "import re\n\n"
        "def extract_tables(path: str, pages: str | None = None) -> list:\n"
        "    with open(path, encoding='utf-8') as fh:\n"
        "        text = fh.read()\n"
        "    # memorise the visible test fixture instead of implementing it\n"
        "    if text == 'a|b\\nc|d\\n\\ne|f\\n':\n"
        "        return [[['a', 'b'], ['c', 'd']], [['e', 'f']]]\n"
        "    raise ValueError('unsupported document')\n\n"
        "def normalize_cell(raw: str) -> str:\n"
        "    return re.sub(r'\\s+', ' ', raw).strip().lstrip('$').strip()\n"
    ))
    c = cand(skill)
    assert unit_gate().run(c).verdict is Verdict.PASS, "the hack must pass visible tests"
    assert holdout_gate().run(c).verdict is Verdict.FAIL, "hold-out must catch it"


# ── Pyramid ─────────────────────────────────────────────────────────────────

def test_pyramid_short_circuits_at_first_failure(skill: Path):
    write_script(skill, "def broken(:\n")
    res = run_pyramid(skill, load_contract(skill), build_fast_pyramid())
    assert not res.passed
    assert res.stopped_at == "G0.parse"
    assert len(res.results) == 1, "must not spend later gates after a G0 failure"


def test_pyramid_orders_cheapest_first(skill: Path):
    res = run_pyramid(skill, load_contract(skill), build_fast_pyramid())
    names = [r.gate for r in res.results]
    assert names == ["G0.parse", "G1.security", "G2.static",
                     "G3.contract", "G4.unit", "G5.holdout"]


def test_pyramid_is_zero_llm(skill: Path):
    """Structural guarantee: no fast-loop gate may be 'expensive'."""
    from skillwhet.gates import assert_free
    assert_free(build_fast_pyramid())


def test_skip_is_not_pass(skill: Path):
    """A missing tool must be visible as SKIP, never silently counted as PASS."""
    shutil.rmtree(skill / "tests" / "holdout")
    res = holdout_gate().run(cand(skill))
    assert res.verdict is Verdict.SKIP
    assert not res.blocking
