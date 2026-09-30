"""hd:采纳 / 发布之后仍能看到每份 staging 当初改了什么;发布 / 回滚留记录。"""
from __future__ import annotations

import shutil
from pathlib import Path

from skillwhet.managed import ManagedStore
from skillwhet.staging import adopt, stage

from tests.test_server import call, live_copy, srv  # noqa: F401 — fixture re-export


def _stage_edit(copy: Path, tmp_path: Path, old: str, new: str) -> Path:
    cand = tmp_path / "cand"
    if cand.exists():
        shutil.rmtree(cand)
    shutil.copytree(copy, cand, ignore=shutil.ignore_patterns(".evo", "import.json"))
    p = cand / "scripts" / "norm.py"
    p.write_text(p.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")
    return stage(cand, copy, staging_root=copy / ".evo" / "staging",
                 report={"improved": True, "baseline_score": 0.5, "candidate_score": 1.0}, accepted=True)


def test_staging_keeps_its_own_diff_after_adoption(srv, tmp_path):
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    copy = home / "work" / "textnorm"
    sid = _stage_edit(copy, tmp_path, "max_len: int = 60", "max_len: int = 80").name
    assert (copy / ".evo" / "staging" / sid / "base" / "scripts" / "norm.py").exists()

    st, r = call(base, "GET", f"/skills/textnorm/staging/{sid}")
    assert st == 200 and r["data"]["diff_base"] == "base"
    before = r["data"]["diffs"]
    assert [d["rel"] for d in before] == ["scripts/norm.py"] and "+def slugify(text: str, max_len: int = 80)" in before[0]["diff"]

    adopt(copy / ".evo" / "staging" / sid, allow_unreleased=True)
    st, r = call(base, "GET", f"/skills/textnorm/staging/{sid}")
    assert r["data"]["adopted"] and r["data"]["diffs"] == before          # 采纳后照样看得到改了什么


def test_legacy_adopted_staging_diffs_against_its_backup(tmp_path):
    """0.4.1 及以前的 staging 没有 base/:已采纳的拿 backup/(采纳前的副本)当底。"""
    from skillwhet.server import App
    live = live_copy(tmp_path)
    app = App(tmp_path / "home", "t")
    app.store.import_live("textnorm", live)
    copy = app.store.dir("textnorm")
    sp = _stage_edit(copy, tmp_path, "max_len: int = 60", "max_len: int = 70")
    shutil.rmtree(sp / "base")                                             # 模拟老 staging
    adopt(sp, allow_unreleased=True)
    d = app.get_staging("textnorm", sp.name)
    assert d["diff_base"] == "backup"
    assert [x["rel"] for x in d["diffs"]] == ["scripts/norm.py"] and "max_len: int = 70" in d["diffs"][0]["diff"]


def test_publish_and_rollback_are_logged_with_the_published_staging(srv, tmp_path):
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    copy = home / "work" / "textnorm"
    sp = _stage_edit(copy, tmp_path, "max_len: int = 60", "max_len: int = 90")
    adopt(sp, allow_unreleased=True)
    assert ManagedStore(home).current_adoption("textnorm") == sp.name
    st, r = call(base, "POST", "/skills/textnorm/rebase", {"live_dir": str(live), "event": "publish", "by": "root", "mode": "replace"})
    assert st == 200
    st, r = call(base, "POST", "/skills/textnorm/rebase", {"live_dir": str(live), "event": "rollback", "by": "root", "to": "20260924T000000Z"})
    st, r = call(base, "GET", "/skills/textnorm/publishes")
    hist = r["data"]["history"]
    assert [h["event"] for h in hist] == ["rollback", "publish"]
    assert hist[1]["staging"] == sp.name and hist[1]["by"] == "root" and hist[0]["to"] == "20260924T000000Z"
    st, r = call(base, "GET", "/skills/textnorm/staging")
    row = [s for s in r["data"]["staging"] if s["id"] == sp.name][0]
    assert len(row["published"]) == 1
    assert (home / "publishes" / "textnorm.jsonl").exists()               # serve 自己的 home,副本写不到


def test_training_reports_each_step_task_and_candidate(tmp_path):
    """hd:进度文件里能看出"此刻在做什么" —— 每一步的起止、每条任务、每个候选。"""
    import json
    import subprocess
    import sys
    live = live_copy(tmp_path)
    p = live / "scripts" / "norm.py"
    p.write_text(p.read_text(encoding="utf-8").replace('re.search(r"[A-Za-z0-9]", tok)', 'tok'), encoding="utf-8")   # 埋一个 bug
    prog = tmp_path / "progress.jsonl"
    subprocess.run([sys.executable, "-m", "skillwhet", "bootstrap", str(live)], check=True, capture_output=True)
    rc = subprocess.run([sys.executable, "-m", "skillwhet", "train", str(live), "--rounds", "1",
                         "--fast-backend", "mock", "--slow-backend", "mock", "--eval-backend", "mock",
                         "--progress", str(prog)], capture_output=True, text=True, timeout=600)
    assert rc.returncode == 0, rc.stderr[-2000:]
    events = [json.loads(x) for x in prog.read_text(encoding="utf-8").splitlines() if x.strip()]
    steps = [(e["step"], e.get("why")) for e in events if e["kind"] == "step"]
    assert ("baseline", None) in steps and ("rollout", "measure") in steps and ("attribution", None) in steps, steps
    ends = [e for e in events if e["kind"] == "step_end"]
    assert ends and all("secs" in e and "llm_calls" in e for e in ends)
    tasks = [e for e in events if e["kind"] == "task" and e["step"] == "rollout"]
    assert tasks and all({"i", "n", "task", "passed"} <= e.keys() for e in tasks)
    assert any(not e["passed"] and e["why"] for e in tasks)                      # 失败的写了原因
    if any(e["kind"] == "step" and e["step"] == "fast_loop" for e in events):
        assert any(e["kind"] == "proposals" for e in events)
    # 每个 step 都成对出现
    assert len([e for e in events if e["kind"] == "step"]) == len(ends)
