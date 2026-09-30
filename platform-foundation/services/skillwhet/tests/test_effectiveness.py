"""The mechanisms added for REVIEW §1 (training effectiveness), one test each."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.attribute import Attribution  # noqa: E402
from skillwhet.backend import Roles, ScriptedBackend  # noqa: E402
from skillwhet.bundle import Evaluation, evaluate  # noqa: E402
from skillwhet.cache import CachedRunner, RunCache, skill_digest  # noqa: E402
from skillwhet.counterfactual import section_effects, sections_of  # noqa: E402
from skillwhet.evidence import ExecRecord, TaskRecord  # noqa: E402
from skillwhet.expensive import replay_candidate  # noqa: E402
from skillwhet.gates.pyramid import PyramidConfig  # noqa: E402
from skillwhet.loops import FastConfig, fast_loop  # noqa: E402
from skillwhet.provenance import ProvenanceLog  # noqa: E402
from skillwhet.runner import AgentRunner, PytestRunner  # noqa: E402
from skillwhet.search import ClusterLedger, cluster_key, fingerprint, refine, refinable  # noqa: E402
from skillwhet.slow_update import (  # noqa: E402
    SLOW_START, cap_guidance, enforce_citations, retire_guidance, write_slow_field,
)
from skillwhet.synthesize import synthesize_tasks  # noqa: E402
from skillwhet.trainer import TrainConfig, _TaskState, bootstrap, train  # noqa: E402
from skillwhet.types import Bundle, CodeEdit, FailureSignal, RootCause  # noqa: E402
from skillwhet.wiki import Wiki  # noqa: E402

from test_audit_regressions import (  # noqa: E402
    BUGGY, FIXED, NODE, NOPY, cells, cells_tasks, cfg, fix_backend, make_cells,
)

_ = cells  # fixture re-export


def _fixed_bundle(content: str = FIXED, rationale: str = "fix", symbol: str = "normalize_cell") -> Bundle:
    return Bundle(origin="P2", rationale=rationale, evidence=["cluster:c1", "task:x"],
                  code_edits=[CodeEdit(op="replace_function", module="scripts/cells.py",
                                       symbol=symbol, content=content,
                                       repro_test="def test_r():\n    assert normalize_cell(None) == ''\n",
                                       rationale=rationale)])


# ── §1.3 fingerprints, refine, strategies ───────────────────────────────────

def test_fingerprint_ignores_docstrings_comments_and_whitespace():
    a = _fixed_bundle(FIXED)
    b = _fixed_bundle(FIXED.replace('"""Collapse whitespace and strip currency symbols."""',
                                    '"""Other docstring."""  # comment') + "\n\n")
    c = _fixed_bundle(FIXED.replace('return ""', 'return " "'))
    assert fingerprint(a) == fingerprint(b) != fingerprint(c)


def test_duplicate_candidates_are_not_gated_twice(cells: Path):
    be = fix_backend(4)              # 4 identical samples for one cluster
    wiki = Wiki(cells / ".evo/wiki")
    attr = Attribution(code_defect=[])
    from skillwhet.attribute import attribute
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    out = fast_loop(cells, attr, be, wiki=wiki, prov=ProvenanceLog(cells / ".evo/p.jsonl"),
                    work_root=cells / ".evo/work", round_no=1,
                    cfg=FastConfig(k_samples=4, enable_p1=False, enable_p3=False, pyramid=NOPY),
                    runner=PytestRunner(), train_tasks=cells_tasks(False))
    assert len(out.accepted) == 1 and out.deduped >= 2
    assert wiki.rejected_fingerprints() == {} or all(isinstance(v, dict) for v in wiki.rejected_fingerprints().values())


def test_rejected_fingerprints_are_remembered_across_rounds(cells: Path):
    bad = Bundle(origin="P2", rationale="bad", evidence=["cluster:c1"], code_edits=[CodeEdit(
        op="replace_function", module="scripts/cells.py", symbol="normalize_cell",
        content="def normalize_cell(raw):\n    return eval(raw)\n",
        repro_test="def test_r():\n    assert normalize_cell(None) == ''\n", rationale="x")])
    be = ScriptedBackend([json.dumps({"symbol": "normalize_cell", "content": bad.code_edits[0].content,
                                      "repro_test": bad.code_edits[0].repro_test, "rationale": "x"})] * 4)
    wiki = Wiki(cells / ".evo/wiki")
    from skillwhet.attribute import attribute
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    c = FastConfig(k_samples=1, enable_p1=False, enable_p3=False, refine_rounds=0, pyramid=NOPY)
    out1 = fast_loop(cells, attr, be, wiki=wiki, prov=ProvenanceLog(cells / ".evo/p.jsonl"),
                     work_root=cells / ".evo/work", round_no=1, cfg=c)
    assert out1.rejected and fingerprint(bad) in wiki.rejected_fingerprints()
    out2 = fast_loop(cells, attr, be, wiki=wiki, prov=ProvenanceLog(cells / ".evo/p.jsonl"),
                     work_root=cells / ".evo/work", round_no=2, cfg=c)
    assert out2.deduped >= 1 and not out2.rejected, "the same dead end is not gated again"


def test_refine_uses_gate_findings(cells: Path):
    broken = FIXED.replace('return ""', 'return undefined_name')     # G2/G4 will reject
    ev = evaluate(cells, _fixed_bundle(broken), work_root=cells / ".evo/work", cfg=NOPY)
    assert not ev.viable and refinable(ev.result)
    be = ScriptedBackend([json.dumps({"symbol": "normalize_cell", "content": FIXED,
                                      "rationale": "defined the name"})])
    better = refine(_fixed_bundle(broken), ev.result, be, skill_dir=cells)
    assert better is not None and "refined_from:" in " ".join(better.evidence)
    assert "undefined_name" not in better.code_edits[0].content
    from skillwhet.gates.g4_tests import collect_test_status
    ev2 = evaluate(cells, better, work_root=cells / ".evo/work", cfg=NOPY,
                   baseline_tests=collect_test_status(cells, "tests/unit"))
    assert ev2.viable, ev2.result.reason
    ev2.discard()


def test_fast_loop_refines_then_lands(cells: Path):
    broken = FIXED.replace('return ""', 'return undefined_name')
    be = ScriptedBackend([
        json.dumps({"symbol": "normalize_cell", "content": broken,
                    "repro_test": "def test_r():\n    assert normalize_cell(None) == ''\n", "rationale": "x"}),
        json.dumps({"symbol": "normalize_cell", "content": FIXED, "rationale": "fixed name"}),
    ])
    from skillwhet.attribute import attribute
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    attr.code_defect = [c for c in attr.code_defect if c.symbol == "normalize_cell"]
    out = fast_loop(cells, attr, be, wiki=Wiki(cells / ".evo/wiki"),
                    prov=ProvenanceLog(cells / ".evo/p.jsonl"), work_root=cells / ".evo/work",
                    round_no=1, cfg=FastConfig(k_samples=1, enable_p1=False, enable_p3=False,
                                               refine_rounds=1, pyramid=NOPY),
                    runner=PytestRunner(), train_tasks=cells_tasks(False))
    assert out.refined == 1 and len(out.accepted) == 1
    assert "if raw is None" in (cells / "scripts/cells.py").read_text()


def test_p2_samples_carry_distinct_strategies(cells: Path):
    from skillwhet.propose.p2_defect import STRATEGIES, propose_defect_fixes
    from skillwhet.attribute import attribute
    be = fix_backend(3)
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    propose_defect_fixes(cells, attr.code_defect[:1], be, k=3)
    prompts = [pr for _sys, pr in be.seen]
    assert len(prompts) == 3
    assert all(any(s.split(" — ")[0] in p for s in STRATEGIES) for p in prompts)
    assert len({p.split("Repair strategy for THIS attempt: ")[-1][:12] for p in prompts}) == 3


# ── §1.4 best of K ──────────────────────────────────────────────────────────

def test_best_of_k_lands_the_smallest_viable_diff(cells: Path):
    bloated = FIXED.replace('    return re.sub', '    _unused = [1, 2, 3]\n    _also = "x" * 3\n    return re.sub')
    be = ScriptedBackend([
        json.dumps({"symbol": "normalize_cell", "content": bloated,
                    "repro_test": "def test_r():\n    assert normalize_cell(None) == ''\n", "rationale": "big"}),
        json.dumps({"symbol": "normalize_cell", "content": FIXED,
                    "repro_test": "def test_r():\n    assert normalize_cell(None) == ''\n", "rationale": "small"}),
    ])
    from skillwhet.attribute import attribute
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    attr.code_defect = [c for c in attr.code_defect if c.symbol == "normalize_cell"]
    out = fast_loop(cells, attr, be, wiki=Wiki(cells / ".evo/wiki"),
                    prov=ProvenanceLog(cells / ".evo/p.jsonl"), work_root=cells / ".evo/work",
                    round_no=1, cfg=FastConfig(k_samples=2, enable_p1=False, enable_p3=False,
                                               refine_rounds=0, pyramid=NOPY),
                    runner=PytestRunner(), train_tasks=cells_tasks(False))
    assert len(out.accepted) == 1 and out.viable_not_selected == 1
    assert out.accepted[0].rationale.endswith("(sample 1)") or "small" in out.accepted[0].rationale
    assert "_unused" not in (cells / "scripts/cells.py").read_text()


def test_first_wins_mode_is_still_available(cells: Path):
    from skillwhet.attribute import attribute
    be = fix_backend(2)
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    attr.code_defect = [c for c in attr.code_defect if c.symbol == "normalize_cell"]
    out = fast_loop(cells, attr, be, wiki=Wiki(cells / ".evo/wiki"),
                    prov=ProvenanceLog(cells / ".evo/p.jsonl"), work_root=cells / ".evo/work",
                    round_no=1, cfg=FastConfig(k_samples=2, enable_p1=False, enable_p3=False,
                                               best_of_k=False, dedup=False, pyramid=NOPY),
                    runner=PytestRunner(), train_tasks=cells_tasks(False))
    assert len(out.accepted) == 1


# ── §1.10 escalation ────────────────────────────────────────────────────────

def test_stubborn_clusters_escalate_to_the_strong_model(tmp_path: Path):
    led = ClusterLedger.load(tmp_path / "c.json")
    led.note("cluster:k", 1, repaired=False)
    assert not led.stubborn("cluster:k", 2)
    led.note("cluster:k", 2, repaired=False)
    assert led.stubborn("cluster:k", 2)
    led2 = ClusterLedger.load(tmp_path / "c.json")
    assert led2.stubborn("cluster:k", 2)
    led2.note("cluster:k", 3, repaired=True)
    assert not led2.stubborn("cluster:k", 2)


def test_fast_loop_routes_stubborn_cluster_to_strong_backend(cells: Path):
    from skillwhet.attribute import attribute
    weak = ScriptedBackend([])                       # never answers
    strong = fix_backend(2)
    led = ClusterLedger.load(cells / ".evo/clusters.json")
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    attr.code_defect = [c for c in attr.code_defect if c.symbol == "normalize_cell"]
    key = f"cluster:{attr.code_defect[0].key}"
    led.note(key, 1, False); led.note(key, 2, False)
    out = fast_loop(cells, attr, weak, wiki=Wiki(cells / ".evo/wiki"),
                    prov=ProvenanceLog(cells / ".evo/p.jsonl"), work_root=cells / ".evo/work",
                    round_no=3, cfg=FastConfig(k_samples=2, enable_p1=False, enable_p3=False, pyramid=NOPY),
                    runner=PytestRunner(), train_tasks=cells_tasks(False),
                    strong_backend=strong, clusters=led)
    assert out.escalated == 1 and len(out.accepted) == 1


# ── §1.2 frontier + synthesis ───────────────────────────────────────────────

def test_task_state_frontier_and_weights(tmp_path: Path):
    st = _TaskState.load(tmp_path / "s.json")
    t_stable = TaskRecord(id="a", intent="a", reference_kind="rule")
    t_flip = TaskRecord(id="b", intent="b", reference_kind="rule")
    t_fail = TaskRecord(id="c", intent="c", reference_kind="rule")
    for passed_b in (True, False, True, False):
        st.observe([ExecRecord("a", "train", passed=True), ExecRecord("b", "train", passed=passed_b),
                    ExecRecord("c", "train", passed=False)])
    recs = [ExecRecord("a", "train", passed=True), ExecRecord("b", "train", passed=False),
            ExecRecord("c", "train", passed=False)]
    active = st.active([t_stable, t_flip, t_fail], recs, window=3, minimum=1)
    assert [t.id for t in active] == ["b", "c"], "the stable task leaves the active set"
    w = st.weights([t_stable, t_flip, t_fail], window=3)
    assert w["b"] > w["a"] == 1.0
    assert len(st.active([t_stable, t_flip, t_fail], recs, window=3, minimum=3)) == 3
    st.save()
    assert _TaskState.load(tmp_path / "s.json").streak("a") == 4


def test_replay_weights_change_the_ranking_mean_not_the_verdict():
    tasks = [TaskRecord(id=f"t{i}", intent="x", reference_kind="rule") for i in range(2)]
    before = [ExecRecord("t0", "train"), ExecRecord("t1", "train", passed=True)]

    class R:
        def run(self, d, ts):
            return [ExecRecord("t0", "train", passed=True), ExecRecord("t1", "train", passed=True)]
    plain = replay_candidate(Path("."), tasks, R(), baseline=before)
    weighted = replay_candidate(Path("."), tasks, R(), baseline=before, weights={"t0": 3.0})
    # repairing a frontier task (weight 3) counts more in the ranking mean
    assert plain.accepted and weighted.accepted and weighted.score > plain.score
    assert weighted.repaired == plain.repaired == 1


def test_synthesis_produces_train_only_rubric_tasks():
    seed = TaskRecord(id="t1", intent="convert the table on page 3 to CSV", reference_kind="rubric",
                      reference="produces valid CSV with the header row", split="val")
    be = ScriptedBackend([json.dumps({"variants": [
        {"intent": "convert the table on page 12 to CSV, it has merged headers",
         "context_excerpt": "", "rubric": "handles merged headers", "checks": [{"op": "no_refusal"}]},
        {"intent": "something", "rubric": ""},
    ]})])
    out, stats = synthesize_tasks([seed], [ExecRecord("t1", "val", passed=False)], be, per_seed=2)
    assert len(out) == 1 and out[0].split == "train" and out[0].origin == "synthetic"
    assert out[0].reference_kind == "rubric" and stats["dropped_no_rubric"] == 1
    assert "seed:t1" in out[0].tags


def test_synthesis_drops_variants_naming_functions_the_skill_lacks(cells: Path):
    seed = TaskRecord(id="t1", intent="does normalize_cell strip $?", reference_kind="rubric",
                      reference="yes", split="train")
    be = ScriptedBackend([json.dumps({"variants": [
        {"intent": "what does parse_invoice() return for an empty PDF?", "rubric": "an empty list"},
        {"intent": "does normalize_cell(' ¥1,200 ') drop the yen sign?", "rubric": "yes, and whitespace"},
    ]})])
    out, stats = synthesize_tasks([seed], [], be, per_seed=2, skill_dir=cells)
    assert [t.intent for t in out] == ["does normalize_cell(' ¥1,200 ') drop the yen sign?"]
    assert stats["dropped_unknown_symbol"] == 1
    sent = json.loads(be.seen[0][1])
    assert "normalize_cell" in sent["skill_functions"] and "FILE: SKILL.md" in sent["skill_prose"]


def test_neighbour_check_drops_variants_on_the_wrong_side(cells: Path):
    from skillwhet.synthesize import neighbour_check
    seed_fail = TaskRecord(id="f", intent="x", reference_kind="rubric", reference="r")
    v_pass = TaskRecord(id="syn1", intent="passes now", reference_kind="rubric", reference="truth",
                        origin="synthetic", tags=["seed:f"])
    v_fail = TaskRecord(id="syn2", intent="fails now", reference_kind="rubric", reference="truth",
                        origin="synthetic", tags=["seed:f"])
    v_defer = TaskRecord(id="syn3", intent="q", reference_kind="rubric", origin="synthetic",
                         reference="answer consistent with the documentation", tags=["seed:f"])

    class R:
        name = "agent"

        def run(self, skill_dir, tasks):
            return [ExecRecord(t.id, t.split, hard=1.0 if t.id == "syn1" else 0.0,
                               passed=t.id == "syn1") for t in tasks]
    keep, stats = neighbour_check([v_pass, v_fail, v_defer], {"f": False}, R(), cells)
    assert [t.id for t in keep] == ["syn2"]
    assert stats["dropped_wrong_side"] == 1 and stats["dropped_defers_to_docs"] == 1


def test_synthesis_skips_pytest_tasks():
    seed = TaskRecord(id="tests/unit/t.py::test_x", intent="x", reference_kind="rule")
    out, stats = synthesize_tasks([seed], [], ScriptedBackend([]))
    assert out == [] and stats["seeds"] == 0


# ── §1.5 counterfactual sections ────────────────────────────────────────────

class _ProseRunner:
    """Passes a task iff the section named in the task intent is present."""
    name = "prose"

    def run(self, skill_dir, tasks):
        text = "\n".join(p.read_text() for p in Path(skill_dir).rglob("*.md"))
        out = []
        for t in tasks:
            needs, poison = t.intent.split("|")
            ok = (needs in text) and (poison not in text)
            out.append(ExecRecord(t.id, t.split, hard=1.0 if ok else 0.0, passed=ok))
        return out


def test_harmful_section_verdicts_must_reproduce(cells: Path):
    (cells / "SKILL.md").write_text("# Cells\n\n## Bad\n\nnever call normalize\n")

    class Flaky:
        """The failing task passes WITHOUT the section only every other call."""
        name = "prose"
        n = 0

        def run(self, skill_dir, tasks):
            self.n += 1
            text = (Path(skill_dir) / "SKILL.md").read_text()
            ok = "never call normalize" not in text and self.n % 2 == 0
            return [ExecRecord(t.id, t.split, hard=1.0 if ok else 0.0, passed=ok) for t in tasks]
    tasks = [TaskRecord(id="f", intent="x", reference_kind="rubric")]
    r = Flaky()
    recs = r.run(cells, tasks)                                   # n=1: fails on the original
    effects, runs = section_effects(cells, tasks, recs, r, budget=10, work_root=cells / ".evo/work")
    assert effects == {} and runs == 4, "one lucky pass is not a harmful verdict"  # 2 sections + 1 confirm + baseline-of-the-flaky
    steady = _ProseRunner()                                      # passes iff the section is gone
    tasks2 = [TaskRecord(id="f", intent="Cells|never call normalize", reference_kind="rubric")]
    recs2 = steady.run(cells, tasks2)
    effects2, _ = section_effects(cells, tasks2, recs2, steady, budget=10,
                                  work_root=cells / ".evo/work")
    assert effects2["SKILL.md#Bad"].harmful == ["f"], "a reproducible verdict is kept"


def test_section_effects_find_helpful_and_harmful_sections(cells: Path):
    (cells / "SKILL.md").write_text("# Cells\n\n## Good\n\nuse normalize\n\n## Bad\n\nnever call normalize\n")
    tasks = [TaskRecord(id="p", intent="use normalize|zzz", reference_kind="rubric"),
             TaskRecord(id="f", intent="use normalize|never call normalize", reference_kind="rubric")]
    runner = _ProseRunner()
    recs = runner.run(cells, tasks)
    effects, runs = section_effects(cells, tasks, recs, runner, budget=10, work_root=cells / ".evo/work")
    assert effects["SKILL.md#Bad"].harmful == ["f"]
    assert "p" in effects["SKILL.md#Good"].helpful
    assert runs <= 10 and section_effects(cells, tasks, recs, PytestRunner(), budget=10)[0] == {}


# ── §1.6 successes + separate doc measurement ───────────────────────────────

def test_slow_loop_receives_successes(cells: Path, monkeypatch):
    import skillwhet.loops as L
    seen = {}

    def fake_propose(skill_dir, signals, successes, backend, **kw):
        seen["successes"] = successes
        return Bundle(origin="doc", rationale="", evidence=[])
    monkeypatch.setattr(L, "propose_doc_edits", fake_propose)
    attr = Attribution(doc_defect=[FailureSignal(id="s", root_cause=RootCause.DOC_DEFECT,
                                                 summary="x", evidence=["task:t"])])
    L.slow_loop(cells, attr, ScriptedBackend([]), wiki=Wiki(cells / ".evo/wiki"),
                prov=ProvenanceLog(cells / ".evo/p.jsonl"), work_root=cells / ".evo/work",
                round_no=1, successes=["PASSED t1: intent"])
    assert seen["successes"] == ["PASSED t1: intent"]


# ── §1.7 guidance hygiene ───────────────────────────────────────────────────

def test_guidance_requires_citations_and_is_capped():
    g = "- When X do Y [task:t1]\n- vague advice with no citation\n- Z [task:nope]"
    assert enforce_citations(g, known_ids={"t1"}) == "- When X do Y [task:t1]"
    long = "\n".join(f"- line {i} [task:t]" for i in range(30))
    capped = cap_guidance(long)
    assert capped.count("\n") + 1 == 12 and capped.endswith("- line 29 [task:t]")


def test_retire_guidance_drops_lines_that_do_nothing(cells: Path):
    md = "# Cells\n\n## Good\n\nuse normalize\n"
    md = write_slow_field(md, "- keep this [task:p]\n- useless line [task:p]")
    (cells / "SKILL.md").write_text(md)

    class R:
        name = "prose"

        def run(self, skill_dir, tasks):
            text = (Path(skill_dir) / "SKILL.md").read_text()
            return [ExecRecord(t.id, t.split, hard=1.0, passed="keep this" in text) for t in tasks]
    tasks = [TaskRecord(id="p", intent="x", reference_kind="rubric")]
    retired, runs = retire_guidance(cells, R(), tasks, budget=8, work_root=cells / ".evo/work")
    assert retired == ["- useless line [task:p]"]
    assert "keep this" in (cells / "SKILL.md").read_text()
    assert "useless" not in (cells / "SKILL.md").read_text()
    assert (cells / ".evo/retired_guidance.md").read_text().strip() == "- useless line [task:p]"
    assert retire_guidance(cells, PytestRunner(), tasks, budget=8) == ([], 0)


# ── §1.8 judge median, gap monitor, val guard ───────────────────────────────

def test_rubric_judge_uses_the_median_of_n_verdicts():
    target = ScriptedBackend(["an answer"])
    judge = ScriptedBackend([json.dumps({"score": 0.95, "reason": "a"}),
                             json.dumps({"score": 0.1, "reason": "b"}),
                             json.dumps({"score": 0.9, "reason": "c"})])
    r = AgentRunner(target, judge, judge_samples=3, workers=1)
    rec = r.run(Path("."), [TaskRecord(id="t", intent="q", reference_kind="rubric", reference="r")])[0]
    assert rec.soft == 0.9 and rec.passed
    assert rec.trajectory and rec.trajectory[-1]["role"] == "judge"


def test_gap_monitor_stops_when_train_outruns_val(cells: Path, monkeypatch):
    import skillwhet.trainer as T
    # every round "accepts" with train rising and val flat → widening gap
    calls = {"n": 0, "val": 0.6}

    def fake_gate(*a, **k):
        calls["val"] -= 0.1                       # val slides while train stays at 1.0
        return T.GateDecision("accept", calls["val"], calls["val"], 0.6)
    monkeypatch.setattr(T, "holdout_gate", fake_gate)
    roles = Roles(fix_backend(20), ScriptedBackend([]), ScriptedBackend([]))
    c = cfg(rounds=6, gap_patience=2, gap_delta=0.0)
    # force round_changed every round by re-breaking the code after each acceptance
    orig_snapshot = T.snapshot

    def spy_snapshot(src, dst):
        out = orig_snapshot(src, dst)
        if Path(dst).name.startswith("round-"):
            (cells / ".evo/current/scripts/cells.py").write_text(BUGGY)
            calls["n"] += 1
        return out
    monkeypatch.setattr(T, "snapshot", spy_snapshot)
    res = train(cells, cells_tasks(), roles, PytestRunner(), cfg=c)
    assert any(r.gate.get("stopped") for r in res.rounds), [r.gate for r in res.rounds]


def test_small_val_slice_is_flagged(cells: Path):
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    res = train(cells, cells_tasks(), roles, PytestRunner(), cfg=cfg(min_val=4))
    assert "warning" in res.rounds[0].gate
    assert "WARNING" in (cells / ".evo/wiki/logs.md").read_text()


# ── §1.10 cache ─────────────────────────────────────────────────────────────

def test_cached_runner_reuses_results_for_identical_skill_and_task(cells: Path):
    class Counting:
        name = "agent"
        calls = 0

        def run(self, skill_dir, tasks):
            self.calls += len(tasks)
            return [ExecRecord(t.id, t.split, hard=1.0, passed=True) for t in tasks]
    inner = Counting()
    r = CachedRunner(inner, RunCache(cells / ".evo/cache.json"))
    tasks = [TaskRecord(id="t1", intent="q", reference_kind="rubric", reference="r")]
    r.run(cells, tasks); r.run(cells, tasks)
    assert inner.calls == 1 and r.cache.hits == 1
    (cells / "SKILL.md").write_text("changed\n")
    r.run(cells, tasks)
    assert inner.calls == 2, "a changed skill is a different key"
    r2 = CachedRunner(Counting(), RunCache(cells / ".evo/cache.json"))
    r2.run(cells, tasks)
    assert r2.inner.calls == 0, "the cache persists on disk"


def test_cache_never_stores_noise(cells: Path):
    class Noisy:
        name = "agent"
        calls = 0

        def run(self, skill_dir, tasks):
            self.calls += 1
            return [ExecRecord(t.id, t.split, passed=False, exc_type="EvalNoise") for t in tasks]
    r = CachedRunner(Noisy(), RunCache(cells / ".evo/cache.json"))
    tasks = [TaskRecord(id="t1", intent="q", reference_kind="rubric", reference="r")]
    r.run(cells, tasks); r.run(cells, tasks)
    assert r.inner.calls == 2


def test_skill_digest_ignores_internal_dirs(cells: Path):
    d1 = skill_digest(cells)
    (cells / ".evo").mkdir(exist_ok=True)
    (cells / ".evo" / "junk").write_text("x")
    (cells / "__pycache__").mkdir(exist_ok=True)
    (cells / "__pycache__" / "a.pyc").write_bytes(b"\0")
    assert skill_digest(cells) == d1
    (cells / "scripts/cells.py").write_text(BUGGY + "\n# touched\n")
    assert skill_digest(cells) != d1


# ── the reflector sees every prose file, with file markers ──────────────────

def test_doc_reflector_sees_references_and_fuzzy_targets_land(cells: Path):
    from skillwhet.propose.doc import prose_of, propose_doc_edits
    text = prose_of(cells)
    assert "===== FILE: SKILL.md =====" in text and "===== FILE: references/api.md =====" in text
    assert "collapses whitespace" in text            # content of references/api.md
    be = ScriptedBackend([json.dumps({"batch_size": 1, "patterns": ["x"], "edits": [
        {"op": "replace", "path": "references/api.md",
         "target": "normalize_cell(raw) collapses whitespace.",          # backticks dropped
         "content": "`normalize_cell(raw)` collapses whitespace and accepts None."}]})])
    sig = FailureSignal(id="s", root_cause=RootCause.DOC_DEFECT, summary="x", evidence=["task:t"])
    b = propose_doc_edits(cells, [sig], [], be, edit_budget=2)
    assert b.doc_edits and b.doc_edits[0].path == "references/api.md"
    from skillwhet.edits import apply_doc_edit
    out, rep = apply_doc_edit((cells / "references/api.md").read_text(), b.doc_edits[0])
    assert rep.status == "applied_replace" and "fuzzily" in rep.detail
    assert "accepts None" in out and out.count("collapses whitespace") == 1



# ── whet eval / whet bench ──────────────────────────────────────────────────

def test_evaluate_repeated_reports_spread_and_unstable_tasks(cells: Path):
    from skillwhet.bench import evaluate_repeated

    class Flaky:
        name = "agent"
        n = 0

        def run(self, skill_dir, tasks):
            self.n += 1
            return [ExecRecord(t.id, t.split, hard=1.0 if (t.id == "a" or self.n % 2) else 0.0,
                               soft=1.0 if (t.id == "a" or self.n % 2) else 0.0,
                               passed=(t.id == "a" or bool(self.n % 2))) for t in tasks]
    tasks = [TaskRecord(id="a", intent="x", reference_kind="rubric"),
             TaskRecord(id="b", intent="y", reference_kind="rubric")]
    res = evaluate_repeated(cells, tasks, Flaky(), repeat=4)
    d = res.to_dict()
    assert d["spread"] == 0.5 and d["unstable_tasks"] == ["b"] and len(d["scores"]) == 4
    assert evaluate_repeated(cells, cells_tasks(False)[:1], PytestRunner(), repeat=2).spread == 0.0


def test_bench_runs_cases_in_scratch_and_tabulates(tmp_path: Path):
    from skillwhet.bench import load_cases, run_bench
    case = tmp_path / "cases" / "c1"
    make_cells(case)                                  # creates case/cells
    (case / "cells").rename(case / "skill")
    import shutil as _sh
    _sh.rmtree(case / "skill" / ".evo", ignore_errors=True)
    (case / "tasks.json").write_text(json.dumps({"format": "skillwhet.tasks.v1",
                                                 "tasks": [t.to_dict() for t in cells_tasks()]}))
    (case / "case.json").write_text(json.dumps({"runner": "pytest"}))
    assert [c.name for c in load_cases(tmp_path / "cases")] == ["c1"]
    before = (case / "skill" / "scripts" / "cells.py").read_text()
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    rep = run_bench(tmp_path / "cases", configs={"full": lambda meta: cfg()}, roles=roles,
                    make_runner=lambda meta, r: PytestRunner(), work_root=tmp_path / "work")
    assert len(rep.results) == 1 and rep.results[0].improved and not rep.results[0].error
    assert rep.results[0].best > rep.results[0].baseline
    assert (case / "skill" / "scripts" / "cells.py").read_text() == before, "cases are never touched"
    md = rep.markdown()
    assert "| full | c1 |" in md and "mean Δ val" in md


def test_training_aborts_instead_of_measuring_a_baseline_during_an_outage(cells: Path):
    class Down:
        name = "agent"

        def run(self, skill_dir, tasks):
            return [ExecRecord(t.id, t.split, passed=False, exc_type="BackendError",
                               exc_message="session limit", noise=True) for t in tasks]
    tasks = [TaskRecord(id="a", intent="x", reference_kind="rubric", reference="r", split="train"),
             TaskRecord(id="b", intent="y", reference_kind="rubric", reference="r", split="val")]
    roles = Roles(ScriptedBackend([]), ScriptedBackend([]), ScriptedBackend([]))
    with pytest.raises(RuntimeError, match="backend unavailable"):
        train(cells, tasks, roles, Down(), cfg=cfg(cache=False))


# ── pairwise judge ──────────────────────────────────────────────────────────

def test_pairwise_judge_swaps_positions_and_treats_disagreement_as_tie():
    from skillwhet.expensive import pairwise_judge
    consistent = ScriptedBackend([json.dumps({"winner": "B"}), json.dumps({"winner": "A"})])
    assert pairwise_judge(consistent, "r", "q", "old answer", "new answer") == "candidate"
    biased = ScriptedBackend([json.dumps({"winner": "A"}), json.dumps({"winner": "A"})])
    assert pairwise_judge(biased, "r", "q", "old", "new") == "tie", "first-position bias cancels out"
    payload = json.loads(biased.seen[0][1])
    assert payload["A"] == "old" and payload["B"] == "new"
    payload2 = json.loads(biased.seen[1][1])
    assert payload2["A"] == "new" and payload2["B"] == "old"


def test_pairwise_gate_is_a_sign_test_over_tasks():
    from skillwhet.expensive import pairwise_gate
    tasks = [TaskRecord(id=f"t{i}", intent="q", reference_kind="rubric", reference="r") for i in range(3)]
    tasks.append(TaskRecord(id="e", intent="q", reference_kind="exact", reference="x"))
    cur = [ExecRecord(f"t{i}", "val", stdout=f"old{i}", hard=0.0, soft=0.3, passed=False) for i in range(3)]
    cur.append(ExecRecord("e", "val", hard=0.0, passed=False))
    cand = [ExecRecord(f"t{i}", "val", stdout=f"new{i}", hard=1.0, soft=0.9, passed=True) for i in range(3)]
    cand.append(ExecRecord("e", "val", hard=1.0, passed=True))
    # t0: candidate wins (B then A), t1: tie, t2: current wins (A then B)
    judge = ScriptedBackend([json.dumps({"winner": "B"}), json.dumps({"winner": "A"}),
                             json.dumps({"winner": "tie"}), json.dumps({"winner": "tie"}),
                             json.dumps({"winner": "A"}), json.dumps({"winner": "B"})])
    d = pairwise_gate(cand, cur, tasks, judge)
    assert d.per_task == {"t0": "candidate", "t1": "tie", "t2": "current", "e": "candidate"}
    assert d.wins == 2 and d.losses == 1 and d.accepted and d.action == "accept_new_best"
    d2 = pairwise_gate(cur, cur, tasks, ScriptedBackend([]))       # identical answers: all ties
    assert d2.ties == 4 and not d2.accepted
    assert pairwise_gate(cur, cur, tasks, ScriptedBackend([]), tie_ok=True).accepted


def test_trainer_uses_pairwise_gate_for_rubric_val_when_enabled(cells: Path, monkeypatch):
    import skillwhet.trainer as T
    seen = {}

    class Agentish:
        name = "agent"

        def run(self, skill_dir, tasks):
            fixed = "if raw is None" in (Path(skill_dir) / "scripts/cells.py").read_text()
            return [ExecRecord(t.id, t.split, hard=1.0 if fixed else 0.0, soft=0.9 if fixed else 0.2,
                               passed=fixed, stdout="new" if fixed else "old") for t in tasks]

    def fake_pairwise(cand, cur, tasks, judge, **kw):
        seen["called"] = (len(cand), len(cur), [t.id for t in tasks])
        from skillwhet.expensive import PairwiseDecision
        return PairwiseDecision("accept_new_best", 2, 0, 0, {}, "f")
    monkeypatch.setattr(T, "pairwise_gate", fake_pairwise)
    tasks = [TaskRecord(id=f"{NODE}::test_handles_none", intent="b", reference_kind="rule", split="train"),
             TaskRecord(id="v1", intent="q", reference_kind="rubric", reference="r", split="val"),
             TaskRecord(id="v2", intent="q", reference_kind="rubric", reference="r", split="val")]
    roles = Roles(fix_backend(), ScriptedBackend([]), ScriptedBackend([]))
    from skillwhet.runner import MixedRunner
    runner = MixedRunner(PytestRunner(), Agentish())
    res = train(cells, tasks, roles, runner, cfg=cfg(pairwise_judge=True, cache=False))
    assert seen["called"] == (2, 2, ["v1", "v2"])
    assert res.improved and res.rounds[0].gate["action"] == "accept_new_best"
    assert "absolute_score" in res.rounds[0].gate


# ── G1 inter-procedural + impact map ────────────────────────────────────────

def test_g1_resolves_callables_returned_by_helpers():
    from skillwhet.analysis import analyze_source
    src = "import os\ndef run(c: str) -> None:\n    get()(c)\ndef get():\n    return os.system\n"
    assert "os.system" in [d[0] for d in analyze_source(src).dangerous]
    benign = "import re\ndef run(s: str) -> str:\n    return get()('x', '', s)\ndef get():\n    return re.sub\n"
    assert analyze_source(benign).dangerous == []


def test_impact_map_limits_replay_to_reaching_tests(cells: Path):
    from skillwhet.impact import bundle_symbols, call_graph, tasks_touching
    (cells / "scripts/cells.py").write_text(BUGGY + "\n\ndef total(xs):\n    return sum(parse_amount(x) for x in xs)\n")
    (cells / "tests/unit/test_more.py").write_text(
        "import sys, pathlib\nsys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))\n"
        "from scripts.cells import total\n\ndef test_total():\n    assert total(['1', '2']) == 3.0\n")
    g = call_graph(cells)
    assert "scripts/cells.py::parse_amount" in g.reach("scripts/cells.py::total")
    tasks = cells_tasks(False) + [TaskRecord(id="tests/unit/test_more.py::test_total", intent="t",
                                             reference_kind="rule"),
                                  TaskRecord(id="agent-1", intent="q", reference_kind="rubric")]
    hit = tasks_touching(cells, tasks, {("scripts/cells.py", "parse_amount")})
    ids = [t.id for t in hit]
    assert f"{NODE}::test_parse_dollar" in ids and "tests/unit/test_more.py::test_total" in ids
    assert "agent-1" in ids, "agent tasks are always replayed"
    assert f"{NODE}::test_strips_currency" not in ids and f"{NODE}::test_handles_none" not in ids
    assert len(tasks_touching(cells, tasks, {("scripts/cells.py", "*")})) == len(tasks)
    assert bundle_symbols(_fixed_bundle()) == {("scripts/cells.py", "normalize_cell")}


def test_fast_loop_records_how_many_tasks_it_replayed(cells: Path):
    from skillwhet.attribute import attribute
    be = fix_backend(2)
    recs = PytestRunner().run(cells, cells_tasks(False))
    attr = attribute(cells, recs, {t.id: t for t in cells_tasks(False)})
    attr.code_defect = [c for c in attr.code_defect if c.symbol == "normalize_cell"]
    out = fast_loop(cells, attr, be, wiki=Wiki(cells / ".evo/wiki"),
                    prov=ProvenanceLog(cells / ".evo/p.jsonl"), work_root=cells / ".evo/work",
                    round_no=1, cfg=FastConfig(k_samples=1, enable_p1=False, enable_p3=False, pyramid=NOPY),
                    runner=PytestRunner(), train_tasks=cells_tasks(False))
    assert len(out.accepted) == 1
    rows = [json.loads(l) for l in (cells / ".evo/p.jsonl").read_text().splitlines() if l.strip()]
    assert rows[-1]["accepted"]


# ── ledger: emphasised words are not constants; measured fixes retire values ─

def test_ledger_constants_need_underscore_or_digit():
    from skillwhet.ledger import _VALUE_PATTERNS
    rx = next(r for r, label in _VALUE_PATTERNS if label == "constant")
    found = [m.group(0) for m in rx.finditer("keep the LAST one; MAX_PAGES=3; HTTP2; NEVER; API_KEY")]
    assert found == ["MAX_PAGES", "HTTP2", "API_KEY"]


def test_measured_doc_improvement_retires_the_values_it_removed(cells: Path):
    from skillwhet.ledger import Ledger
    (cells / "SKILL.md").write_text("# Cells\n\nRequires pdfplumber 0.11.4.\nUse API_KEY_V1 for auth.\n")
    from skillwhet.contract import load_contract
    led = Ledger.capture(cells, load_contract(cells))
    assert {e.key for e in led.entries if e.kind == "value"} >= {"0.11.4", "API_KEY_V1"}
    (cells / "SKILL.md").write_text("# Cells\n\nRequires pdfplumber 0.11.4.\nUse API_KEY_V2 for auth.\n")
    assert [v.key for v in led.check(cells, load_contract(cells))] == ["API_KEY_V1"]
    assert led.retire_values(["API_KEY_V1"], by="abc") == ["API_KEY_V1"]
    assert led.check(cells, load_contract(cells)) == []
    led.save(cells / ".evo/ledger.yaml")
    assert Ledger.load(cells / ".evo/ledger.yaml").check(cells, load_contract(cells)) == []


def test_g1_resolves_dangerous_callables_across_modules(cells: Path):
    from skillwhet.gates.g1_security import SecurityGate
    from skillwhet.gates.base import Candidate
    from skillwhet.contract import load_contract
    (cells / "scripts/helpers.py").write_text("import os\n\ndef get():\n    return os.system\n")
    (cells / "scripts/run.py").write_text("from scripts.helpers import get\n\ndef run(c: str) -> None:\n    get()(c)\n")
    res = SecurityGate(use_bandit=False).run(Candidate(skill_dir=cells, contract=load_contract(cells)))
    msgs = " ".join(f.message for f in res.findings)
    assert "os.system" in msgs and any("run.py" in f.path for f in res.findings)


# ── §9.4 contract examples: making generality visible to a zero-LLM ranking ──

def _with_currency_example(skill_dir: Path):
    """Add a stated example the seeded skill fails: € is not stripped."""
    from skillwhet.contract import load_contract, save_contract
    c = load_contract(skill_dir)
    e = next(x for x in c.entrypoints if x.id == "normalize_cell")
    e.checks = [{"example": {"args": ["  € 12 "], "returns": "12"}}]
    save_contract(skill_dir, c)
    return c


def test_contract_example_check_renders_an_equality_test():
    from skillwhet.contract_tests import render
    from skillwhet.types import Entrypoint
    src = render(Entrypoint(id="normalize_cell", module="scripts/cells.py",
                            checks=[{"example": {"args": ["  € 12 "], "returns": "12"}},
                                    {"example": {"args": ["x"]}}]))
    assert "assert normalize_cell('  € 12 ') == '12'" in src
    assert "needs a 'returns' value" in src          # malformed check fails loudly
    compile(src, "<gen>", "exec")


def test_contract_check_red_before_does_not_reject_an_unrelated_candidate(cells: Path):
    from skillwhet.contract import load_contract
    from skillwhet.gates.base import Candidate
    from skillwhet.gates.g3_contract import ContractGate
    from skillwhet.loops import _baseline_tests
    _with_currency_example(cells)
    base = _baseline_tests(cells)
    red = [t for t, ok in base.items() if t.startswith("tests/contract/") and not ok]
    assert red, "the seeded skill must fail the stated example"
    cand = Candidate(skill_dir=cells, contract=load_contract(cells), baseline_tests=base)
    res = ContractGate().run(cand)
    assert res.verdict.name == "PASS"                       # already red ⇒ warning, not error
    assert [f.severity for f in res.findings if f.rule == "contract-check-failed"] == ["warning"]
    assert res.detail["contract_checks_repaired"] == 0
    # Without a baseline the same gate is absolute — the old, deadlocking behaviour.
    strict = ContractGate().run(Candidate(skill_dir=cells, contract=load_contract(cells)))
    assert strict.verdict.name == "FAIL"


def test_a_contract_example_outranks_the_smaller_diff(cells: Path):
    """The §9.4 finding, closed: minimality is anti-correlated with generality.

    Two candidates repair the same failing task. The smaller one keeps
    ``lstrip("$")``; the larger one strips any currency symbol and so repairs
    the stated example. Before the contract term in the rank key the smaller
    one won every time — and the generalisation probe went to 0.
    """
    from skillwhet.loops import _baseline_tests
    minimal = FIXED
    general = '''def normalize_cell(raw: str | None) -> str:
    """Collapse whitespace and strip currency symbols."""
    if raw is None:
        return ""
    stripped = re.sub(r"[$€£¥]", "", raw)
    return re.sub(r"\\s+", " ", stripped).strip()
'''
    _with_currency_example(cells)
    base = _baseline_tests(cells)
    evs = []
    for content in (minimal, general):
        ev = evaluate(cells, _fixed_bundle(content), work_root=cells / ".evo/work",
                      cfg=NOPY, baseline_tests=base)
        assert ev.viable, ev.result.reason
        evs.append(ev)
    small, big = evs
    assert small.rank_key[1] == 0 and big.rank_key[1] == 1     # contract checks repaired
    assert small.diff_lines < big.diff_lines                   # and yet the big one wins
    assert max(evs, key=lambda e: e.rank_key) is big
    for ev in evs:
        ev.discard()


def test_bootstrap_preserves_an_authored_contract(tmp_path: Path):
    """§9.5: `whet bootstrap` must not discard the semantic half of CONTRACT.yaml.

    It used to derive from a BLANK base, so every entrypoint looked new and
    postconditions / doc_anchor / stability / checks were silently dropped —
    the half the AST cannot regenerate. A whole benchmark campaign measured
    nothing because the `example` checks never survived into the run.
    """
    from skillwhet.contract import load_contract
    from skillwhet.trainer import bootstrap
    skill = make_cells(tmp_path)
    _with_currency_example(skill)
    c = load_contract(skill)
    e = next(x for x in c.entrypoints if x.id == "normalize_cell")
    e.postconditions = ["strips any currency symbol"]
    e.stability = "stable"
    e.doc_anchor = "references/api.md#normalize_cell"
    from skillwhet.contract import save_contract
    save_contract(skill, c)

    bootstrap(skill)

    got = next(x for x in load_contract(skill).entrypoints if x.id == "normalize_cell")
    assert got.checks == [{"example": {"args": ["  € 12 "], "returns": "12"}}]
    assert got.postconditions == ["strips any currency symbol"]
    assert got.stability == "stable"
    assert got.doc_anchor == "references/api.md#normalize_cell"
    assert "re" in load_contract(skill).allowed_imports      # still seeded from the AST
