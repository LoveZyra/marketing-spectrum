"""he (0.5.0): resume an interrupted run · lessons with a status · the nightly threshold."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet import checkpoint  # noqa: E402
from skillwhet.backend import Roles, ScriptedBackend  # noqa: E402
from skillwhet.evidence import TaskRecord  # noqa: E402
from skillwhet.imports import TaskStore  # noqa: E402
from skillwhet.jobs import build_argv  # noqa: E402
from skillwhet.progress import Progress  # noqa: E402
from skillwhet.runner import PytestRunner  # noqa: E402
from skillwhet.trainer import train  # noqa: E402
from skillwhet.types import Bundle, CodeEdit, Finding  # noqa: E402
from skillwhet.wiki import RETIRE_AFTER_RUNS, Wiki  # noqa: E402

from tests.test_end_to_end import cfg, scripted_fix, skill, tasks  # noqa: E402,F401 — fixture re-export


class _Crash(RuntimeError):
    pass


class CrashAt(Progress):
    """Progress sink that dies when round ``at`` starts — a serve restart mid-run."""

    def __init__(self, path: Path, at: int) -> None:
        super().__init__(path)
        self.at = at

    def emit(self, kind: str, **fields) -> dict:
        if kind == "round_start" and fields.get("round") == self.at:
            raise _Crash("killed")
        return super().emit(kind, **fields)


def _events(p: Path) -> list[dict]:
    return [json.loads(x) for x in p.read_text(encoding="utf-8").splitlines() if x.strip()]


def _two_rounds():
    c = cfg()
    c.rounds = 2
    return c


def test_resume_continues_after_the_last_completed_round(skill: Path, tmp_path: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    first = tmp_path / "p1.jsonl"
    with pytest.raises(_Crash):
        train(skill, tasks(), roles, PytestRunner(), cfg=_two_rounds(), progress=CrashAt(first, 2))
    ck = checkpoint.load(skill / ".evo")
    assert ck and ck["round"] == 1 and ck["accepted_rounds"] == [1]
    assert checkpoint.info(skill, tasks())["matches"] is True
    assert not list((skill / ".evo" / "staging").glob("*")) if (skill / ".evo" / "staging").exists() else True

    c = _two_rounds()
    c.resume = True
    second = tmp_path / "p2.jsonl"
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    result = train(skill, tasks(), roles, PytestRunner(), cfg=c, progress=Progress(second))
    ev = _events(second)
    kinds = [e["kind"] for e in ev]
    assert "resumed" in kinds and [e for e in ev if e["kind"] == "resumed"][0]["from_round"] == 1
    assert not any(e["kind"] == "step" and e["step"] == "baseline" for e in ev), "S0 is not re-measured"
    assert not any(e["kind"] == "round_start" and e["round"] == 1 for e in ev), "round 1 is not re-run"
    replayed = [e for e in ev if e["kind"] == "gate" and e.get("replayed")]
    assert [e["round"] for e in replayed] == [1] and replayed[0]["accepted"] is True
    assert result.improved and result.rounds[0].round == 1           # round 1's win is kept
    assert "if raw is None" in (result.best_dir / "scripts" / "cells.py").read_text()
    assert checkpoint.load(skill / ".evo") is None                     # a finished run leaves none
    done = [e for e in ev if e["kind"] == "done"][0]
    assert done["resumed_from"] == 1 and done["total_cost_usd"] >= done["cost_usd"]


def test_resume_falls_back_to_a_fresh_run_when_the_task_set_changed(skill: Path, tmp_path: Path):
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    with pytest.raises(_Crash):
        train(skill, tasks(), roles, PytestRunner(), cfg=_two_rounds(), progress=CrashAt(tmp_path / "a.jsonl", 2))
    changed = tasks() + [TaskRecord(id="tests/unit/test_cells.py::test_extra", intent="x",
                                    reference_kind="rule", split="train")]
    assert checkpoint.info(skill, changed)["matches"] is False
    c = _two_rounds()
    c.resume = True
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    p = tmp_path / "b.jsonl"
    train(skill, changed, roles, PytestRunner(), cfg=c, progress=Progress(p))
    ev = _events(p)
    un = [e for e in ev if e["kind"] == "resume_unavailable"]
    assert un and "task set" in un[0]["reason"]
    assert any(e["kind"] == "step" and e["step"] == "baseline" for e in ev)


def test_resume_flag_is_whitelisted_for_jobs(tmp_path: Path):
    argv = build_argv("python3", tmp_path, tmp_path / "t.json", tmp_path / "p.jsonl", {"resume": True, "rounds": 2})
    assert "--resume" in argv
    assert "--resume" not in build_argv("python3", tmp_path, tmp_path / "t.json", tmp_path / "p.jsonl", {"resume": False})


# ── wiki: lessons with a status ─────────────────────────────────────────────

def _bundle(sym: str, body: str) -> Bundle:
    return Bundle(code_edits=[CodeEdit(op="replace_function", module="scripts/cells.py", symbol=sym, content=body)],
                  rationale=f"try {body}", origin="P2")


def test_wiki_status_moves_with_the_evidence(tmp_path: Path):
    w = Wiki(tmp_path / "wiki")
    w.begin_run()
    f = [Finding(gate="G4", rule="regression", message="broke test_strips_currency")]
    p = w.record_rejection(_bundle("normalize_cell", "a"), 1, "G4", f)
    assert p.status == "hypothesis" and p.scope == ["scripts/cells.py::normalize_cell"]
    p = w.record_rejection(_bundle("normalize_cell", "b"), 1, "G4", f)
    assert p.status == "supported" and p.revision == 2
    # accepted by G4-G6 alone is not evidence yet: only a round G7 accepted counts
    w.record_acceptance(_bundle("normalize_cell", "c"), 2)
    assert w.patterns[p.id].status == "supported"
    # an accepted round changing the same place contradicts "changes there break behaviour"
    w.record_round_accepted([_bundle("normalize_cell", "c")], 2)
    p = w.patterns[p.id]
    assert p.counterexamples and p.status == "disputed"
    assert "BUT:" in w.brief() and "disputed" in w.brief()
    # the acceptance itself became a success lesson; the next-round comparison disputes it
    succ = [x for x in w.patterns.values() if x.kind == "success"]
    assert len(succ) == 1 and succ[0].status == "hypothesis"
    assert w.record_longitudinal(2, ["t1", "t2"], []) == [succ[0].id]
    assert w.patterns[succ[0].id].status == "disputed"
    assert "status: disputed" in (tmp_path / "wiki" / "patterns" / f"{succ[0].id}.md").read_text()
    # a comparison without regressions disputes nothing
    assert w.record_longitudinal(2, [], ["t1"]) == []


def test_wiki_retires_lessons_not_seen_for_several_runs(tmp_path: Path):
    w = Wiki(tmp_path / "wiki")
    w.begin_run()
    p = w.record_rejection(_bundle("f", "a"), 1, "G2", [Finding(gate="G2", rule="ruff", message="E501")])
    for _ in range(RETIRE_AFTER_RUNS):
        w = Wiki(tmp_path / "wiki")
        w.begin_run()
    assert w.patterns[p.id].status == "retired"
    assert w.brief() == ""                                     # not shown to the proposer
    w.record_rejection(_bundle("f", "z"), 1, "G2", [Finding(gate="G2", rule="ruff", message="E501")])
    assert w.patterns[p.id].status != "retired"                # seen again: back in play


def test_wiki_reads_a_0_4_index_without_status(tmp_path: Path):
    d = tmp_path / "wiki"
    (d / "patterns").mkdir(parents=True)
    (d / "index.json").write_text(json.dumps([{"id": "g4-regression", "title": "G4: regression", "kind": "gate-rejection",
                                                "observations": 3, "gates_that_rejected": ["G4"] * 3, "workaround": "",
                                                "evidence": ["bundle:a", "bundle:b"], "first_seen_round": 1,
                                                "last_seen_round": 2}]), encoding="utf-8")
    w = Wiki(d)
    assert w.patterns["g4-regression"].status == "supported"


# ── nightly threshold: new checkable tasks since a time ─────────────────────

def test_new_tasks_since_counts_first_appearance_only(tmp_path: Path):
    store = TaskStore(tmp_path)
    a = [TaskRecord(id=f"t{i}", intent="x", reference_kind="exact", reference="y", split="train") for i in range(3)]
    store.add("demo", a + [TaskRecord(id="nocheck", intent="x", split="train")])
    assert store.new_since("demo", None)["new_checkable"] == 3
    time.sleep(1.1)
    cut = time.time()
    time.sleep(1.1)
    store.add("demo", [a[0]] + [TaskRecord(id="t9", intent="x", reference_kind="exact", reference="y", split="val")])
    got = store.new_since("demo", cut)
    assert got["new_checkable"] == 1 and got["new_by_split"]["val"] == 1 and got["checkable"] == 4


def test_serve_exposes_new_tasks_checkpoint_and_wiki_index(tmp_path: Path):
    import threading
    from skillwhet.server import serve
    from tests.test_server import TOKEN, call, live_copy
    home = tmp_path / "home"
    s = serve("127.0.0.1", 0, home, TOKEN)
    threading.Thread(target=s.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{s.server_address[1]}"
    try:
        live = live_copy(tmp_path)
        assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
        st, r = call(base, "POST", "/tasks", {"skill": "textnorm", "records": [
            {"id": f"t{i}", "input": "x", "expected_output": "y"} for i in range(4)]})
        assert st == 200, r
        st, r = call(base, "GET", "/tasks/new?skill=textnorm&since=")
        assert st == 200 and r["data"]["new_checkable"] == 4
        st, r = call(base, "GET", "/tasks/new?skill=textnorm&since=2999-01-01T00:00:00Z")
        assert r["data"]["new_checkable"] == 0
        assert call(base, "GET", "/tasks/new?skill=textnorm&since=yesterday")[0] == 400
        st, r = call(base, "GET", "/skills/textnorm/checkpoint")
        assert st == 200 and r["data"] == {"exists": False}
        st, r = call(base, "GET", "/skills/textnorm/wiki")
        assert st == 200 and r["data"]["index"] == []
    finally:
        s.shutdown()
        s.server_close()


def test_lint_lessons_are_not_disputed_by_an_accepted_change_nearby(tmp_path: Path):
    w = Wiki(tmp_path / "wiki")
    w.begin_run()
    f = [Finding(gate="G2", rule="ruff", message="E501 line too long")]
    p = w.record_rejection(_bundle("f", "a"), 1, "G2", f)
    w.record_rejection(_bundle("f", "b"), 1, "G2", f)
    w.record_round_accepted([_bundle("f", "c")], 1)
    assert w.patterns[p.id].status == "supported" and not w.patterns[p.id].counterexamples


def test_retired_status_survives_reload_without_revision_churn(tmp_path: Path):
    w = Wiki(tmp_path / "wiki")
    w.begin_run()
    p = w.record_rejection(_bundle("f", "a"), 1, "G4", [Finding(gate="G4", rule="regression", message="x")])
    for _ in range(RETIRE_AFTER_RUNS):
        w = Wiki(tmp_path / "wiki")
        w.begin_run()
    rev = w.patterns[p.id].revision
    for _ in range(3):
        w = Wiki(tmp_path / "wiki")
        assert w.patterns[p.id].status == "retired"          # plain read keeps it retired
        w.begin_run()
    assert w.patterns[p.id].revision == rev


def test_resume_does_not_start_a_round_the_previous_run_had_decided_to_skip(skill: Path, tmp_path: Path):
    """The run stopped (no_accept) after round 1 and died while staging: resume stages, no round 2."""
    ck_dir = skill / ".evo"
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    c = _two_rounds()
    c.no_accept_rounds = 1

    import skillwhet.trainer as tr
    orig = tr.stage

    def die(*_a, **_k):
        raise _Crash("killed while staging")
    tr.stage = die
    try:
        with pytest.raises(_Crash):
            train(skill, tasks(), Roles(ScriptedBackend([]), ScriptedBackend([]), ScriptedBackend([])),
                  PytestRunner(), cfg=c, progress=Progress(tmp_path / "a.jsonl"))
    finally:
        tr.stage = orig
    ck = checkpoint.load(ck_dir)
    assert ck and ck["stopped"] == "no_accept" and ck["round"] == 1
    c2 = _two_rounds()
    c2.no_accept_rounds = 1
    c2.resume = True
    p = tmp_path / "b.jsonl"
    result = train(skill, tasks(), Roles(ScriptedBackend([]), ScriptedBackend([]), ScriptedBackend([])),
                   PytestRunner(), cfg=c2, progress=Progress(p))
    assert result.stop_reason == "no_accept"
    assert not any(e["kind"] == "round_start" for e in _events(p))


def test_checkpoint_does_not_match_another_runner_or_model(skill: Path, tmp_path: Path):
    from skillwhet.checkpoint import cfg_key
    from skillwhet.trainer import _run_identity
    roles = Roles(scripted_fix(), ScriptedBackend([]), ScriptedBackend([]))
    a = cfg_key(cfg(), _run_identity(PytestRunner(), roles))
    b = cfg_key(cfg(), _run_identity(PytestRunner(subdir="tests/holdout"), roles))
    assert a != b


# ── hf: the budget is checked inside a round too ───────────────────────────

class _Paid(ScriptedBackend):
    """A scripted proposer that costs $1 a call, like a real model would."""

    def _call(self, prompt, *, system, max_tokens, temperature):
        self.stats.cost_usd += 1.0
        return super()._call(prompt, system=system, max_tokens=max_tokens, temperature=temperature)


def test_budget_stops_further_proposal_passes_inside_a_round(skill: Path, tmp_path: Path):
    # a second, independent defect keeps the fast loop "actionable" after the first fix
    cells = skill / "scripts" / "cells.py"
    cells.write_text(cells.read_text() + '''

def shout(text: str) -> str:
    return text.lower()
''', encoding="utf-8")
    t = skill / "tests" / "unit" / "test_cells.py"
    t.write_text(t.read_text().replace("from scripts.cells import normalize_cell",
                                       "from scripts.cells import normalize_cell, shout") + '''

def test_shout():
    assert shout("a") == "A"
''', encoding="utf-8")
    from skillwhet.trainer import bootstrap
    import shutil as _sh
    _sh.rmtree(skill / ".evo", ignore_errors=True)
    bootstrap(skill)
    node = "tests/unit/test_cells.py"
    ts = tasks() + [TaskRecord(id=f"{node}::test_shout", intent="shout", reference_kind="rule", split="train"),
                    TaskRecord(id=f"{node}::test_shout", intent="shout", reference_kind="rule", split="val")]
    proposer = _Paid(list(scripted_fix().queue))
    c = cfg()
    c.fast_iters = 3
    c.max_cost_usd = 0.5
    p = tmp_path / "p.jsonl"
    result = train(skill, ts, Roles(proposer, ScriptedBackend([]), ScriptedBackend([])), PytestRunner(),
                   cfg=c, progress=Progress(p))
    ev = _events(p)
    reached = [e for e in ev if e["kind"] == "budget_reached"]
    assert reached and reached[0]["skipped"].startswith("fast loop pass 2"), [e["kind"] for e in ev]
    assert sum(1 for e in ev if e["kind"] == "step" and e["step"] == "fast_loop") == 1
    assert result.stop_reason == "budget"
