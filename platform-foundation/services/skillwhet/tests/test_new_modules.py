"""Tests for the modules added in the completion pass."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from skillwhet.analysis import analyze_source  # noqa: E402
from skillwhet.backend import ScriptedBackend  # noqa: E402
from skillwhet.evolve_tests import check_monotonic  # noqa: E402
from skillwhet.evolve_tests import test_shape as shape_of  # noqa: E402
from skillwhet.harvest import digest_transcript, mine, redact  # noqa: E402
from skillwhet.simulate import (  # noqa: E402
    Intent, IntentStateMachine, Scenario, simulate, verify,
)
from skillwhet.slow_update import (  # noqa: E402
    Longitudinal, read_slow_field, run_slow_update, write_slow_field,
)


# ── G1 dataflow ─────────────────────────────────────────────────────────────

@pytest.mark.parametrize("src,expect,dangerous", [
    ("def f(p: str) -> None:\n    w = open\n    w(p, 'w').write('x')\n", "filesystem:workspace", False),
    ("import os\ndef f(c: str) -> None:\n    s = os.system\n    s(c)\n", "subprocess", True),
    ("import os\ndef f() -> None:\n    getattr(os, 'sys'+'tem')('ls')\n", "subprocess", True),
    ("def f() -> None:\n    m = __import__('o'+'s')\n    m.system('ls')\n", "subprocess", True),
])
def test_g1_sees_through_aliases(src, expect, dangerous):
    facts = analyze_source(src)
    assert expect in facts.side_effects, "the effect must be seen through the alias"
    if dangerous:
        assert facts.dangerous, "the underlying dangerous call must be named"


def test_g1_flags_dynamic_getattr():
    facts = analyze_source("import os\ndef f(n: str) -> None:\n    getattr(os, n)('ls')\n")
    assert any(d[0] == "getattr(dynamic)" for d in facts.dangerous)


def test_g1_no_false_positive_on_benign_alias():
    facts = analyze_source("import re\ndef f(s: str) -> str:\n    sub = re.sub\n    return sub('x', '', s)\n")
    assert not facts.dangerous and facts.side_effects == {"none"}


# ── test evolution: monotonicity ────────────────────────────────────────────

def _suite(tmp: Path, name: str, body: str) -> Path:
    d = tmp / name / "tests" / "unit"
    d.mkdir(parents=True)
    (d / "test_a.py").write_text(body, encoding="utf-8")
    return tmp / name


def test_shape_counts_asserts_and_raises():
    s = shape_of("import pytest\ndef test_x():\n    assert 1\n    assert 2\n"
                   "    with pytest.raises(ValueError):\n        int('x')\n")
    assert s.functions["test_x"] == 2 and s.raises["test_x"] == 1


def test_monotonic_accepts_growth(tmp_path):
    before = _suite(tmp_path, "b", "def test_x():\n    assert 1\n")
    after = _suite(tmp_path, "a", "def test_x():\n    assert 1\n    assert 2\n"
                                   "def test_y():\n    assert 3\n")
    assert check_monotonic(before, after) == []


def test_monotonic_rejects_removed_test(tmp_path):
    before = _suite(tmp_path, "b", "def test_x():\n    assert 1\ndef test_y():\n    assert 2\n")
    after = _suite(tmp_path, "a", "def test_x():\n    assert 1\n")
    w = check_monotonic(before, after)
    assert len(w) == 1 and w[0].kind == "removed" and w[0].test == "test_y"


def test_monotonic_rejects_weakened_assert(tmp_path):
    before = _suite(tmp_path, "b", "def test_x():\n    assert 1\n    assert 2\n")
    after = _suite(tmp_path, "a", "def test_x():\n    assert 1\n")
    w = check_monotonic(before, after)
    assert w and w[0].kind == "fewer-asserts"


def test_monotonic_rejects_dropped_raises(tmp_path):
    before = _suite(tmp_path, "b", "import pytest\ndef test_x():\n"
                                    "    with pytest.raises(ValueError):\n        int('x')\n")
    after = _suite(tmp_path, "a", "def test_x():\n    int('1')\n")
    assert any(w.kind in ("fewer-raises", "fewer-asserts") for w in check_monotonic(before, after))


# ── slow update ─────────────────────────────────────────────────────────────

def test_slow_field_round_trip():
    md = "# S\n\nbody\n"
    out = write_slow_field(md, "- When X, do Y")
    assert read_slow_field(out) == "- When X, do Y"
    out2 = write_slow_field(out, "- replaced")
    assert out2.count("<!-- SLOW_UPDATE_START -->") == 1
    assert read_slow_field(out2) == "- replaced"
    assert "body" in out2


def test_slow_update_says_nothing_when_nothing_changed():
    lon = Longitudinal(stable_success=["a", "b"])
    assert run_slow_update(ScriptedBackend([]), prev_skill_md="", curr_skill_md="",
                           lon=lon) is None


def test_slow_update_writes_guidance_on_regression():
    lon = Longitudinal(regressed=["t1"], detail={"t1": {"why": "KeyError"}})
    b = ScriptedBackend([json.dumps({"reasoning": "r",
                                     "guidance": "- When t1, check keys [task:t1]\n- vague, uncited"})])
    g = run_slow_update(b, prev_skill_md="", curr_skill_md="", lon=lon)
    assert g and "check keys" in g and "uncited" not in g, "bullets must cite the task they are for"


# ── simulation ──────────────────────────────────────────────────────────────

def test_intent_state_machine_gates_termination():
    sm = IntentStateMachine([Intent("refund rule", "key"), Intent("timing", "minor")])
    assert not sm.may_terminate()
    sm.note_raised(["refund rule"]); sm.note_addressed(["refund rule"])
    assert not sm.may_terminate(), "minor intents must be raised too"
    sm.note_raised(["timing"]); sm.note_addressed(["timing"])
    assert sm.may_terminate() and sm.coverage() == 1.0


def test_simulation_runs_and_verifies_dual_sided():
    sc = Scenario(
        opening_message="Does renewal take effect immediately?",
        behavior_facts="Holds one 200 GB package expiring July 27.",
        emotion_trajectory="worried",
        agenda=[Intent("renewal timing", "key"), Intent("suspension", "minor")],
        expected_solution="Renewal extends validity; no suspension; pay-as-you-go after.",
    )
    service = ScriptedBackend(["Renewal extends the validity period.",
                               "No, service is not suspended; it switches to pay-as-you-go."])
    user = ScriptedBackend([
        "<reason>ask</reason><agenda_check>suspension</agenda_check>"
        "<action>send_text</action><say>Will it be suspended?</say>",
        "<reason>done</reason><agenda_check></agenda_check><action>done</action><say>thanks</say>",
        json.dumps({"score": 92, "knowledge_error": False,
                    "per_intent": {"renewal timing": 1, "suspension": 1}, "reasoning": "ok"}),
    ])
    traj = simulate(sc, service=service, user=user, skill_text="# skill", max_turns=5)
    assert traj.coverage == 1.0 and traj.terminated == "normal"
    v = verify(traj, sc, user)
    assert v.passed and v.exposed_accuracy == 1.0 and not v.eval_noise


def test_knowledge_error_is_capped_at_59():
    sc = Scenario("q", "f", "e", [Intent("x", "key")], "ref")
    service = ScriptedBackend(["wrong rule"])
    user = ScriptedBackend([
        "<action>done</action><say>ok</say>",
        json.dumps({"score": 95, "knowledge_error": True, "per_intent": {"x": 0},
                    "reasoning": "opposite rule"}),
    ])
    traj = simulate(sc, service=service, user=user, skill_text="s", max_turns=3)
    v = verify(traj, sc, user)
    assert v.score <= 59 and not v.passed


# ── harvest ─────────────────────────────────────────────────────────────────

def test_redaction_covers_common_secrets():
    s = ("key sk-abcdefghijklmnop AKIAABCDEFGHIJKLMNOP ghp_" + "x" * 30
         + ' api_key=supersecretvalue "password": "hunter2hunter"')
    r = redact(s)
    for leak in ("sk-abcdefghijklmnop", "AKIAABCDEFGHIJKLMNOP", "supersecretvalue", "hunter2hunter"):
        assert leak not in r
    assert "[REDACTED" in r


def _transcript(tmp_path: Path, first_user: str) -> Path:
    p = tmp_path / "s1.jsonl"
    rows = [
        {"timestamp": "2026-09-01T00:00:00Z", "cwd": "/proj",
         "message": {"role": "user", "content": first_user}},
        {"timestamp": "2026-09-01T00:01:00Z",
         "message": {"role": "assistant", "content": [
             {"type": "text", "text": "done, token=abcdefghijkl"},
             {"type": "tool_use", "name": "Skill", "input": {"skill": "pdf"}}]}},
        {"timestamp": "2026-09-01T00:02:00Z",
         "message": {"role": "user", "content": "thanks, works now"}},
    ]
    p.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    return p


def test_digest_redacts_and_extracts(tmp_path):
    d = digest_transcript(_transcript(tmp_path, "please fix the pdf parser"))
    assert d is not None
    assert d.skills_used == ["pdf"] and "Skill" in d.tools_used
    assert any(f.startswith("pos:") for f in d.feedback)
    assert "abcdefghijkl" not in " ".join(d.assistant_finals)


def test_digest_drops_our_own_sessions(tmp_path):
    assert digest_transcript(_transcript(
        tmp_path, "You repair Python defects in an agent skill, from a stack trace.")) is None


def test_mine_drops_tasks_without_rubric(tmp_path):
    d = digest_transcript(_transcript(tmp_path, "please fix the pdf parser"))
    b = ScriptedBackend([json.dumps({"tasks": [
        {"intent": "fix pdf parser crash on empty file", "rubric": "handles empty file gracefully",
         "checks": [{"op": "not_contains", "arg": "Traceback"}], "satisfied": True},
        {"intent": "something with no rubric", "rubric": None},
    ]})])
    tasks, stats = mine([d], b)
    assert len(tasks) == 1 and tasks[0].reference_kind == "rubric"
    assert stats["dropped_uncheckable"] == 1


# ── ha · harvest 反馈叠加层 / 家族 / 白名单 ───────────────────────────────

def _transcript_with_uuids(tmp_path: Path, name: str = "s1") -> Path:
    p = tmp_path / f"{name}.jsonl"
    rows = [
        {"timestamp": "2026-09-01T00:00:00Z", "cwd": "/proj/a", "uuid": "u-1",
         "message": {"role": "user", "content": "按等长日窗比较两段销售额,给我环比"}},
        {"timestamp": "2026-09-01T00:01:00Z", "uuid": "a-1", "type": "assistant",
         "message": {"role": "assistant", "content": [
             {"type": "tool_use", "name": "Skill", "input": {"skill": "marketing-audit"}},
             {"type": "text", "text": "A 段 1,240,000,B 段 1,338,000,环比 +7.9%"}]}},
        {"timestamp": "2026-09-01T00:02:00Z", "cwd": "/proj/a", "uuid": "u-2",
         "message": {"role": "user", "content": "访问 0 次时转化率是多少"}},
        {"timestamp": "2026-09-01T00:02:30Z", "uuid": "a-2", "type": "assistant",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "会除零报错"}]}},
    ]
    p.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")
    return p


def test_overlay_votes_beat_keyword_guesses_and_expected_output_becomes_exact(tmp_path):
    from skillwhet.harvest import exact_tasks_from_feedback, harvest, load_overlay
    _transcript_with_uuids(tmp_path)
    ov = tmp_path / "overlay.json"
    ov.write_text(json.dumps({"s1": [
        {"message_uuid": "a-1", "verdict": -1, "category": "wrong_result", "note": "B 段多算了一天"},
        {"message_uuid": "a-2", "verdict": 0, "note": "零访问要回 0", "expected_output": "{\"rate\": 0.0}"},
        {"message_uuid": "nope", "verdict": 1},
    ]}), encoding="utf-8")
    ds = harvest(tmp_path, overlay=load_overlay(ov))
    assert len(ds) == 1
    d = ds[0]
    assert d.feedback[:2] == ["user:mixed", "user:neg:wrong_result"] or d.feedback[0].startswith("user:")
    assert {fb["uuid"] for fb in d.user_feedback} == {"a-1", "a-2"}
    assert d.user_feedback[0]["prompt"].startswith("按等长日窗")
    exact = exact_tasks_from_feedback(d, skill_hint="marketing-audit")
    assert len(exact) == 1 and exact[0].reference_kind == "exact" and exact[0].outcome == "mixed"
    assert exact[0].family_id == "s1" and "outcome:voted" in exact[0].tags
    # 模型挖出来的任务:satisfied 取投票(有一条差评 → fail),不听模型的 true
    b = ScriptedBackend([json.dumps({"tasks": [
        {"intent": "compare two equal-length windows and report the ratio", "rubric": "uses equal-length windows",
         "satisfied": True}]})])
    tasks, stats = mine([d], b, skill_hint="marketing-audit")
    mined = [t for t in tasks if t.reference_kind == "rubric"]
    assert mined and mined[0].outcome == "fail" and "outcome:voted" in mined[0].tags
    assert mined[0].family_id == "s1"
    assert "user_feedback" in b.prompts[0] if hasattr(b, "prompts") else True


def test_session_whitelist_and_family_split(tmp_path):
    from skillwhet.evidence import TaskRecord, assign_splits
    from skillwhet.harvest import harvest, load_session_whitelist
    _transcript_with_uuids(tmp_path, "s1")
    _transcript_with_uuids(tmp_path, "s2")
    wl = tmp_path / "allowed.json"
    wl.write_text(json.dumps(["s2"]), encoding="utf-8")
    ds = harvest(tmp_path, sessions=load_session_whitelist(wl))
    assert [d.session_id for d in ds] == ["s2"]
    assert harvest(tmp_path, sessions=set()) == []          # 空白名单 = 一条都不看
    # 同族任务永远同一个 split
    fam = [TaskRecord(id=f"t{i}", intent="x", reference_kind="rubric", reference="r", family_id="fam-A") for i in range(6)]
    assign_splits(fam, val_fraction=0.5, test_fraction=0.25)
    assert len({t.split for t in fam}) == 1
    solo = [TaskRecord(id=f"s{i}", intent="x", reference_kind="rubric", reference="r") for i in range(40)]
    assign_splits(solo, val_fraction=0.25, test_fraction=0.25)
    assert len({t.split for t in solo}) == 3


def test_task_summary_counts_sources_once_per_unique_task(tmp_path):
    """同一批任务被导入几次(同一批会话挖两次),来源计数不能翻倍:按去重后的现存任务记,最早那批为准。"""
    from skillwhet.evidence import TaskRecord
    from skillwhet.imports import TaskStore
    store = TaskStore(tmp_path)
    base = [TaskRecord(id=f"u{i}", intent="x", reference_kind="exact", reference="1") for i in range(4)]
    mined = [TaskRecord(id=f"h{i}", intent="y", reference_kind="rubric", reference="r", family_id="s1") for i in range(3)]
    store.add("demo", base, source="upload")
    store.add("demo", mined, source="harvest")
    store.add("demo", mined, source="harvest")
    store.add("demo", mined[:1], source="feedback")
    row = store.summary("demo")[0]
    assert row["total"] == 7
    assert row["sources"] == {"upload": 4, "harvest": 3}
    assert sum(row["sources"].values()) == row["total"]
