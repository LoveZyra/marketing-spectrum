"""hb:测试环境浏览器实测(2026-09-24)找出来的问题的回归用例。"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from skillwhet.contract import DEFAULT_STDLIB_ALLOW, load_contract
from skillwhet.gates import build_fast_pyramid, run_pyramid
from skillwhet.gates.base import Candidate
from skillwhet.gates.g0_parse import ParseGate
from skillwhet.gates.g1_security import SecurityGate
from skillwhet.gates.g2_static import StaticGate
from skillwhet.gates.g4_tests import unit_gate
from skillwhet.gates.pyramid import finding_key
from skillwhet.types import Verdict

from tests.test_server import TOKEN, call, live_copy, srv  # noqa: F401 — fixture re-export


def _skill(tmp_path: Path, files: dict[str, str]) -> Path:
    root = tmp_path / "sk"
    for rel, text in {"SKILL.md": "---\nname: sk\n---\n# sk\n", **files}.items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return root


def _cand(root: Path) -> Candidate:
    return Candidate(skill_dir=root, contract=load_contract(root))


# ── gates see the whole bundle, not only scripts/ ─────────────────────────────

def test_security_gate_scans_code_outside_scripts(tmp_path):
    root = _skill(tmp_path, {"snippets/run.py": "import subprocess\n\ndef go(x):\n    return eval(x)\n"})
    res = SecurityGate(use_bandit=False).run(_cand(root))
    assert res.verdict is Verdict.FAIL, res
    rules = {f.rule for f in res.findings}
    assert {"import-not-allowed", "dangerous-call"} <= rules
    assert res.detail["modules"] == 1


def test_parse_gate_counts_every_module_and_g2_skips_without_scripts(tmp_path):
    root = _skill(tmp_path, {"snippets/a.py": "x = 1\n", "snippets/b.py": "def f(:\n", "cli.py": "y = 2\n"})
    res = ParseGate().run(_cand(root))
    assert res.verdict is Verdict.FAIL and res.detail["modules"] == 3
    g2 = StaticGate(use_pyright=False).run(_cand(root))
    assert g2.verdict is Verdict.SKIP and "scripts/" in g2.detail["reason"] and "3 other" in g2.detail["reason"]


def test_own_modules_and_harmless_stdlib_are_not_foreign_imports(tmp_path):
    root = _skill(tmp_path, {
        "snippets/__init__.py": "",
        "snippets/stats_utils.py": "import gc\nimport zlib\nimport fractions\n\ndef f() -> int:\n    return 1\n",
        "snippets/report.py": "import stats_utils\nfrom snippets import stats_utils as s2\n\nZ = 1\n",
    })
    res = SecurityGate(use_bandit=False).run(_cand(root))
    assert res.verdict is Verdict.PASS, [f.message for f in res.findings]
    assert {"gc", "zlib", "fractions"} <= DEFAULT_STDLIB_ALLOW
    assert not {"subprocess", "socket", "pickle", "ctypes"} & DEFAULT_STDLIB_ALLOW


def test_unit_gate_explains_flat_tests(tmp_path):
    root = _skill(tmp_path, {"tests/test_a.py": "def test_x():\n    assert True\n"})
    res = unit_gate().run(_cand(root))
    assert res.verdict is Verdict.SKIP and "tests/unit/" in res.detail["reason"] and "1 test file" in res.detail["reason"]


# ── candidates are judged on NEW findings only ────────────────────────────────

def test_preexisting_findings_do_not_reject_a_candidate(tmp_path):
    root = _skill(tmp_path, {"scripts/legacy.py": "import requests\n\ndef get() -> None:\n    pass\n"})
    gates = [SecurityGate(use_bandit=False)]
    parent = run_pyramid(root, load_contract(root), gates)
    assert not parent.passed
    base = {r.gate: [finding_key(f) for f in r.findings] for r in parent.results}
    same = run_pyramid(root, load_contract(root), gates, baseline_findings=base)
    assert same.passed and same.results[0].detail["preexisting"] == 1
    # a NEW foreign import still fails
    (root / "scripts" / "legacy.py").write_text("import requests\nimport paramiko\n\ndef get() -> None:\n    pass\n")
    worse = run_pyramid(root, load_contract(root), gates, baseline_findings=base)
    assert not worse.passed and [f.message for f in worse.results[0].findings] == [
        "module 'paramiko' is not in CONTRACT.allowed_imports nor the stdlib allowlist"]


def test_gate_baseline_is_cached_per_parent_hash(tmp_path):
    from skillwhet.bundle import gate_baseline
    root = _skill(tmp_path, {"scripts/legacy.py": "import requests\n\ndef get() -> None:\n    pass\n"})
    (root / ".evo").mkdir()
    gates = build_fast_pyramid()
    b1 = gate_baseline(root, gates)
    assert any("requests" in k for k in b1.get("G1.security", []))
    cache = json.loads((root / ".evo" / "gate_baseline.json").read_text(encoding="utf-8"))
    assert cache["findings"] == b1
    (root / "scripts" / "legacy.py").write_text("def get() -> None:\n    pass\n")
    assert "G1.security" not in gate_baseline(root, gates)       # parent changed → recomputed


# ── library bootstrap freezes S0's imports; uploads don't ─────────────────────

def test_bootstrap_freezes_s0_imports_for_library_copies_only(srv, tmp_path):
    base, home = srv
    live = live_copy(tmp_path)
    (live / "snippets").mkdir()
    (live / "snippets" / "load.py").write_text("import pandas\nimport subprocess\n\nX = 1\n", encoding="utf-8")
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    assert call(base, "POST", "/skills/textnorm/gate?no_pyright=1&no_tests=1", {})[0] == 200
    st, r = call(base, "POST", "/skills/textnorm/bootstrap", {})
    assert st == 200 and {"pandas", "subprocess"} <= set(r["data"]["frozen_imports"]), r
    assert {"pandas", "subprocess"} <= set(load_contract(home / "work" / "textnorm").allowed_imports)
    assert not (home / "work" / "textnorm" / ".evo" / "gate.json").exists()     # stale gate cache dropped


# ── rollback / adopt bookkeeping ──────────────────────────────────────────────

def test_rebase_pins_the_live_side_so_a_rollback_is_not_drift(tmp_path):
    from skillwhet.managed import ManagedStore
    live = live_copy(tmp_path)
    store = ManagedStore(tmp_path / "home")
    store.import_live("textnorm", live)
    first = store.record("textnorm").imported_at
    copy = store.dir("textnorm")
    (copy / "CONTRACT.yaml").write_text("version: 1\n", encoding="utf-8")   # bootstrap wrote a file live lacks
    store.rebase("textnorm", live_dir=live)                                # e.g. after a rollback
    assert store.live_drift("textnorm") == []
    assert store.record("textnorm").imported_at == first
    (live / "SKILL.md").write_text("edited by hand\n", encoding="utf-8")
    assert store.live_drift("textnorm") == ["SKILL.md"]


def test_adopting_an_older_staging_still_allows_publish(tmp_path):
    from skillwhet.managed import ManagedStore
    from skillwhet.staging import adopt, stage
    live = live_copy(tmp_path)
    store = ManagedStore(tmp_path / "home")
    store.import_live("textnorm", live)
    copy = store.dir("textnorm")
    subprocess.run([sys.executable, "-m", "skillwhet", "bootstrap", str(copy)], check=True, capture_output=True)
    root = copy / ".evo" / "staging"
    older = stage(copy, copy, staging_root=root, report={"improved": False}, accepted=False)
    stage(copy, copy, staging_root=root, report={"improved": False}, accepted=False)
    assert store.status("textnorm")["adopted"] is False
    adopt(older, force=True)
    assert store.status("textnorm")["adopted"] is True          # the copy IS an adopted result
    (copy / "SKILL.md").write_text((copy / "SKILL.md").read_text() + "\nhand edit\n", encoding="utf-8")
    assert store.status("textnorm")["adopted"] is False         # …until someone changes it


# ── harvest ──────────────────────────────────────────────────────────────────

def _session(dir_: Path, sid: str, prompt: str, *, skill: str | None = None, path_skill: str | None = None) -> None:
    content = [{"type": "text", "text": "done"}]
    if skill:
        content.insert(0, {"type": "tool_use", "name": "Skill", "input": {"skill": skill}})
    if path_skill:
        content.insert(0, {"type": "tool_use", "name": "Read",
                           "input": {"file_path": f"/home/u/.claude/skills/{path_skill}/SKILL.md"}})
    rows = [{"timestamp": "2026-09-20T00:00:00Z", "uuid": f"{sid}-u", "message": {"role": "user", "content": prompt}},
            {"timestamp": "2026-09-20T00:01:00Z", "uuid": f"{sid}-a", "type": "assistant",
             "message": {"role": "assistant", "content": content}}]
    dir_.mkdir(parents=True, exist_ok=True)
    (dir_ / f"{sid}.jsonl").write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows), encoding="utf-8")


def test_harvest_only_mines_sessions_that_used_the_skill(tmp_path):
    tr = tmp_path / "tr" / "-p"
    _session(tr, "a", "诊断转化率下滑", skill="marketing-audit")
    _session(tr, "b", "告诉我苏州明天的天气")
    _session(tr, "c", "按渠道拆流失", path_skill="marketing-audit")
    _session(tr, "d", "你好", skill="dataviz")
    out = tmp_path / "r.json"
    rc = subprocess.run([sys.executable, "-m", "skillwhet", "harvest", "--transcripts", str(tmp_path / "tr"),
                         "--skill", "marketing-audit", "--dry-run", "--out", "", "--json-out", str(out)],
                        capture_output=True, text=True)
    assert rc.returncode == 0, rc.stderr
    res = json.loads(out.read_text(encoding="utf-8"))
    assert sorted(s["session_id"] for s in res["sessions"]) == ["a", "c"]
    assert res["skipped_other_skill"] == 2
    rc = subprocess.run([sys.executable, "-m", "skillwhet", "harvest", "--transcripts", str(tmp_path / "tr"),
                         "--skill", "marketing-audit", "--any-skill", "--dry-run", "--out", "", "--json-out", str(out)],
                        capture_output=True, text=True)
    assert len(json.loads(out.read_text(encoding="utf-8"))["sessions"]) == 4


def test_harvest_drops_prism_hidden_context_and_ticket(tmp_path):
    from skillwhet.harvest import digest_transcript, redact
    prompt = ("我想设置一个定时任务。\n\n[系统随消息附带的技术说明,用户在页面上看不到这段;不要复述它,更不要把 ticket 展示出来]\n"
              "curl -s -X POST 'http://x/api/tasks/via-ticket' -H 'X-Prism-Task-Ticket: abcdef0123456789abcdef'")
    _session(tmp_path, "s", prompt, skill="x")
    d = digest_transcript(tmp_path / "s.jsonl")
    assert d.user_prompts == ["我想设置一个定时任务。"]
    assert "abcdef0123456789" not in redact("X-Prism-Task-Ticket: abcdef0123456789abcdef")


# ── ledger ───────────────────────────────────────────────────────────────────

def test_ledger_only_guards_editable_docs(tmp_path):
    from skillwhet.ledger import Ledger
    root = _skill(tmp_path, {"CHANGELOG.md": "## 0.04\nthreshold 89.8 → 0.719\n",
                             "references/rules.md": "阈值 0.35 以上算高风险\n"})
    led = Ledger.capture(root, load_contract(root))
    sources = {e.source for e in led.entries if e.kind == "value"}
    assert "CHANGELOG.md" not in sources and "references/rules.md" in sources
