"""Component-level tests for everything the end-to-end run does not pin down."""
from __future__ import annotations

import math
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.backend import (  # noqa: E402
    LLMCallForbidden, MockBackend, Roles, ScriptedBackend, extract_json, no_llm,
)
from skillwhet.evidence import (  # noqa: E402
    ExecRecord, TaskRecord, assign_splits, cluster_failures, is_shape_only,
    parse_traceback, validate_judge,
)
from skillwhet.expensive import (  # noqa: E402
    TRANSITION_SCORES, GovernanceResult, holdout_gate, select_score,
)
from skillwhet.ledger import Ledger, LedgerEntry  # noqa: E402
from skillwhet.mutation import count_mutations, mutate  # noqa: E402
from skillwhet.sandbox import SandboxPolicy, network_isolation_available, run_sandboxed  # noqa: E402
from skillwhet.types import Contract, Entrypoint  # noqa: E402


# ── Sandbox ─────────────────────────────────────────────────────────────────

def test_sandbox_runs_and_captures(tmp_path: Path):
    r = run_sandboxed(["python3", "-c", "print('hi')"], tmp_path)
    assert r.ok and "hi" in r.stdout


def test_sandbox_enforces_wall_timeout(tmp_path: Path):
    r = run_sandboxed(["python3", "-c", "import time; time.sleep(30)"], tmp_path,
                      SandboxPolicy(wall_timeout_s=2))
    assert r.timed_out and not r.ok


def test_sandbox_caps_memory(tmp_path: Path):
    r = run_sandboxed(["python3", "-c", "x = bytearray(400 * 1024 * 1024)"],
                      tmp_path, SandboxPolicy(memory_mb=64, wall_timeout_s=30))
    assert not r.ok, "a 400MB allocation must fail under a 64MB cap"


@pytest.mark.skipif(not network_isolation_available(), reason="needs unshare -n")
def test_sandbox_blocks_network(tmp_path: Path):
    code = ("import socket;"
            "socket.setdefaulttimeout(3);"
            "socket.create_connection(('1.1.1.1', 53))")
    r = run_sandboxed(["python3", "-c", code], tmp_path,
                      SandboxPolicy(network=False, wall_timeout_s=20))
    assert r.network_isolated
    assert not r.ok, "skill code must not reach the network"


def test_sandbox_reports_degradation_instead_of_pretending(tmp_path: Path):
    r = run_sandboxed(["python3", "-c", "pass"], tmp_path, SandboxPolicy(network=True))
    assert not r.network_isolated       # asked for network, so no namespace
    assert r.degraded == []


def test_sandbox_does_not_leak_credentials(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-should-not-be-visible")
    r = run_sandboxed(
        ["python3", "-c", "import os; print(os.environ.get('OPENAI_API_KEY', 'ABSENT'))"],
        tmp_path)
    assert "ABSENT" in r.stdout


# ── The zero-LLM invariant ──────────────────────────────────────────────────

def test_no_llm_region_raises_on_a_model_call():
    b = MockBackend()
    with no_llm("G2.static"), pytest.raises(LLMCallForbidden, match="G2.static"):
        b.complete("anything", stage="sneaky")


def test_no_llm_region_restores_previous_state():
    b = MockBackend()
    with no_llm("region"):
        pass
    b.complete("fine now", stage="after")     # must not raise
    assert b.stats.calls == 1


def test_sampling_salts_each_draw():
    """Without a per-sample salt every draw collapses to one cached response."""
    b = ScriptedBackend(["a", "b", "c"])
    b.sample("same prompt", 3, stage="p2")
    prompts = [p for _, p in b.seen]
    assert len(set(prompts)) == 3, "K samples must be K distinct requests"


def test_generator_must_differ_from_evaluator():
    shared = MockBackend()
    with pytest.raises(ValueError, match="Generator == Evaluator"):
        Roles(MockBackend(), shared, shared).validate()
    Roles.all_mock().validate()


def test_extract_json_refuses_to_guess_between_candidates():
    assert extract_json('{"a": 1}')["a"] == 1
    assert extract_json('```json\n{"b": 2}\n```')["b"] == 2
    assert extract_json('{"a": 1} and then {"b": 2}') is None
    assert extract_json("no json here") is None


# ── Evidence ────────────────────────────────────────────────────────────────

def test_traceback_picks_the_deepest_in_skill_frame():
    tb = textwrap.dedent('''\
        Traceback (most recent call last):
          File "/x/tests/unit/test_a.py", line 4, in test_a
            normalize(None)
          File "/x/scripts/cells.py", line 12, in normalize
            return re.sub(r"\\s+", " ", raw)
          File "/usr/lib/python3.11/re/__init__.py", line 185, in sub
            return _compile(pattern, flags).sub(repl, string, count)
        TypeError: expected string or bytes-like object
        ''')
    rec = parse_traceback(tb, skill_dir=Path("/x"))
    assert rec.exc_type == "TypeError"
    assert rec.module == "scripts/cells.py", "not the stdlib frame"
    assert rec.symbol == "normalize"


def test_clustering_groups_by_frame_and_ranks_by_frequency():
    recs = [
        ExecRecord("t1", "train", exc_type="TypeError", top_frame="c.py:f:9",
                   module="scripts/c.py"),
        ExecRecord("t2", "train", exc_type="TypeError", top_frame="c.py:f:9",
                   module="scripts/c.py"),
        ExecRecord("t3", "train", exc_type="KeyError", top_frame="c.py:g:20",
                   module="scripts/c.py"),
        ExecRecord("t4", "train", passed=True),
    ]
    cl = cluster_failures(recs)
    assert [c.count for c in cl] == [2, 1]
    assert cl[0].exc_type == "TypeError"
    assert "t4" not in [t for c in cl for t in c.task_ids]


def test_splits_are_stable_and_synthetic_never_leaves_train():
    a = [TaskRecord(id=f"t{i}", intent="x", reference_kind="rule") for i in range(40)]
    b = [TaskRecord(id=f"t{i}", intent="x", reference_kind="rule") for i in range(40)]
    assign_splits(a, seed=7)
    assign_splits(b, seed=7)
    assert [t.split for t in a] == [t.split for t in b], "splits must be stable"

    syn = [TaskRecord(id="s1", intent="x", reference_kind="rule", origin="synthetic")]
    assign_splits(syn + a, seed=7)
    assert syn[0].split == "train"


def test_shape_only_judge_is_flagged():
    shape = {"checks": [{"op": "section_present", "arg": "## Result"},
                        {"op": "max_chars", "arg": 500}]}
    assert is_shape_only(shape)
    assert any("reformatting" in w for w in validate_judge(shape))
    real = {"checks": [{"op": "contains", "arg": "42"}]}
    assert not is_shape_only(real)


def test_unknown_judge_op_is_reported_as_testing_nothing():
    warns = validate_judge({"checks": [{"op": "vibes", "arg": "good"}]})
    assert any("tests nothing" in w for w in warns)


# ── G6 / G7 ─────────────────────────────────────────────────────────────────

def test_transition_scores_penalise_regression_hardest():
    assert TRANSITION_SCORES[("pass", "fail")] == 0.0
    assert TRANSITION_SCORES[("fail", "pass")] == 3.0
    assert TRANSITION_SCORES[("pass", "fail")] < TRANSITION_SCORES[("fail", "fail")]


def test_holdout_gate_rejects_a_tie():
    recs = [ExecRecord("t1", "val", hard=1.0, soft=1.0, passed=True)]
    d = holdout_gate(recs, current_score=1.0, best_score=1.0)
    assert d.action == "reject", "strictly greater: a tie must not move the skill"


def test_holdout_gate_accepts_a_real_gain():
    recs = [ExecRecord("t1", "val", hard=1.0, soft=1.0, passed=True)]
    d = holdout_gate(recs, current_score=0.5, best_score=0.5)
    assert d.action == "accept_new_best" and d.candidate_score == 1.0
    assert "candidate =" in d.formula


def test_no_regression_mode_blocks_a_mixed_candidate():
    base = [ExecRecord("a", "val", hard=1.0, soft=1.0, passed=True),
            ExecRecord("b", "val", hard=0.0, soft=0.0)]
    cand = [ExecRecord("a", "val", hard=0.0, soft=0.0),          # regressed
            ExecRecord("b", "val", hard=1.0, soft=1.0, passed=True)]
    d = holdout_gate(cand, 0.5, 0.5, baseline_records=base, no_regression=True)
    assert d.action == "reject" and d.regressed_tasks == ["a"]


def test_nan_counts_as_a_regression():
    base = [ExecRecord("a", "val", hard=1.0, soft=1.0, passed=True)]
    cand = [ExecRecord("a", "val", hard=math.nan, soft=math.nan)]
    d = holdout_gate(cand, 0.0, 0.0, baseline_records=base, no_regression=True)
    assert d.action == "reject", "+inf/NaN must never look like an improvement"


def test_select_score_metrics():
    assert select_score(1.0, 0.0, "hard") == 1.0
    assert select_score(1.0, 0.0, "soft") == 0.0
    assert select_score(1.0, 0.0, "mixed", 0.5) == 0.5
    with pytest.raises(ValueError):
        select_score(1.0, 1.0, "vibes")


# ── Preserve Ledger ─────────────────────────────────────────────────────────

def _skill_with_prose(tmp_path: Path, prose: str) -> Path:
    d = tmp_path / "s"
    (d / "references").mkdir(parents=True)
    (d / "SKILL.md").write_text("# S\n", encoding="utf-8")
    (d / "references" / "api.md").write_text(prose, encoding="utf-8")
    return d


def test_ledger_catches_over_generalisation(tmp_path: Path):
    """Turning a concrete value into 'see the docs' is knowledge loss."""
    d = _skill_with_prose(tmp_path, "Quota is 200 GB and resets at v2.1.\n")
    contract = Contract()
    led = Ledger.capture(d, contract)
    assert any(e.key == "200 GB" for e in led.entries)

    (d / "references" / "api.md").write_text(
        "Quota depends on your plan; see the official documentation.\n", encoding="utf-8")
    v = led.check(d, contract)
    assert any(x.key == "200 GB" for x in v)
    assert any("over-generalisation" in x.message for x in v)


def test_ledger_catches_a_vanished_entrypoint(tmp_path: Path):
    d = _skill_with_prose(tmp_path, "text\n")
    (d / "scripts").mkdir()
    (d / "scripts" / "m.py").write_text("def f() -> None:\n    pass\n", encoding="utf-8")
    c = Contract(entrypoints=[Entrypoint(id="f", module="scripts/m.py",
                                         stability="stable")])
    led = Ledger.capture(d, c)
    gone = Contract(entrypoints=[])
    assert any(x.kind == "entrypoint" for x in led.check(d, gone))


def test_ledger_catches_a_test_that_stopped_passing(tmp_path: Path):
    d = _skill_with_prose(tmp_path, "text\n")
    led = Ledger([LedgerEntry(kind="test", key="tests/unit/t.py::test_a")])
    v = led.check(d, Contract(), passing_tests=[])
    assert v and v[0].kind == "test"


# ── Mutation testing ────────────────────────────────────────────────────────

def test_mutation_finds_and_applies_one_change_at_a_time():
    src = "def f(x: int) -> bool:\n    return x > 3\n"
    n = count_mutations(src)
    assert n >= 2                              # the comparison and the integer
    variants = {mutate(src, i) for i in range(n)}
    assert all(v is not None for v in variants)
    assert len({v[0] for v in variants}) == n, "each index yields a distinct mutant"
    assert src not in {v[0] for v in variants}
    kinds = {v[1].split(":")[0] for v in variants}
    assert {"comparison", "integer"} <= kinds


def test_mutation_report_floor_is_an_admission_not_an_objective():
    from skillwhet.mutation import MutationReport
    r = MutationReport(total=10, killed=6)
    assert r.score == 0.6 and r.meets(0.6) and not r.meets(0.7)
    assert MutationReport().meets(), "no mutants: nothing to say, not a failure"
