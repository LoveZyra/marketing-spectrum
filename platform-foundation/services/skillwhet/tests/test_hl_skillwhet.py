"""hl 修复轮(2026-09-29)—— 切片 C:SkillWhet 引擎(0.5.2)。

每条对应动态检测报告(hk_20260928)或静态审计(hi_20260924)的一条;
关键几条对着 0.5.1 反向验证会红。测试不真跑沙箱、不调模型。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path

import pytest

from skillwhet.jobs import Job, JobError, JobStore
from skillwhet.staging import Manifest, StagedFile, adopt, prune_unaccepted, sha256_file, stage
from tests.test_server import EXAMPLES, TOKEN, call, live_copy, srv  # noqa: F401 — fixture re-export


def _copy(tmp_path: Path, name: str = "textnorm") -> Path:
    d = tmp_path / "work" / name
    shutil.copytree(EXAMPLES / name, d, ignore=shutil.ignore_patterns(".evo", "__pycache__"))
    (d / "import.json").write_text(json.dumps({"name": name, "source": "upload", "uploaded_by": "alice",
                                               "imported_at": "t", "imported_from": "", "files": {}}))
    (d / ".evo" / "baseline").mkdir(parents=True)
    return d


# ── P1-8:采纳不再把 import.json 写回 ─────────────────────────────────────────

def test_stage_skips_import_json_and_adopt_ignores_legacy_entries(tmp_path: Path):
    live = _copy(tmp_path)
    cand = tmp_path / "cand"
    shutil.copytree(live, cand, ignore=shutil.ignore_patterns(".evo"))
    (cand / "SKILL.md").write_text((cand / "SKILL.md").read_text() + "\nmore\n")
    (cand / "import.json").write_text('{"source": "live", "uploaded_by": "mallory"}')   # 训练副本里的旧记录
    out = stage(cand, live, staging_root=live / ".evo" / "staging", report={}, accepted=True)
    man = json.loads((out / "manifest.json").read_text())
    assert "import.json" not in [f["rel"] for f in man["files"]]
    assert not (out / "proposed" / "import.json").exists()

    # 0.5.1 留下的 staging:manifest 里含 import.json —— 采纳时忽略它,副本里的记录不动
    before = (live / "import.json").read_text()
    legacy = Manifest.from_dict(man)
    legacy.files.append(StagedFile(rel="import.json", sha256=sha256_file(cand / "import.json"),
                                   live_sha256="deadbeef"))          # 与副本现状不符 → 老代码会报 drift
    (out / "manifest.json").write_text(json.dumps(legacy.to_dict()))
    (out / "proposed" / "import.json").write_bytes((cand / "import.json").read_bytes())
    written = adopt(out, allow_unreleased=True)
    assert "import.json" not in written and "SKILL.md" in written
    assert (live / "import.json").read_text() == before


# ── P1-9:刚创建就取消不能照跑 ───────────────────────────────────────────────

def _fake_python(tmp_path: Path, body: str) -> str:
    p = tmp_path / "fake-python"
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(0o755)
    return str(p)


def _store(tmp_path: Path, python: str) -> JobStore:
    home = tmp_path / "home"
    (home / "work" / "a" / ".evo" / "baseline").mkdir(parents=True)
    (home / "work" / "a" / "SKILL.md").write_text("---\nname: a\n---\n")
    (home / "tasks" / "a").mkdir(parents=True)
    (home / "tasks" / "a" / "all.json").write_text(json.dumps({"tasks": [{"id": "t", "intent": "i", "reference_kind": "rule"}]}))
    return JobStore(home, work_root=home / "work", tasks_root=home / "tasks", python=python, start_worker=False)


def test_cancel_racing_with_spawn_kills_the_process(tmp_path: Path, monkeypatch):
    marker = tmp_path / "ran-to-the-end"
    store = _store(tmp_path, _fake_python(tmp_path, f"sleep 3; touch {marker}"))
    job, _ = store.create("train", "a", {})
    real_popen = subprocess.Popen

    def popen_then_cancel(*a, **kw):
        proc = real_popen(*a, **kw)
        store.cancel(job.id)          # 取消恰好落在 Popen 之后、_procs 登记之前(旧代码的窗口)
        return proc

    monkeypatch.setattr(subprocess, "Popen", popen_then_cancel)
    t0 = time.monotonic()
    store._run(job)
    cur = store.get(job.id)
    assert cur.state == "cancelled" and cur.rc is not None and cur.rc < 0
    assert time.monotonic() - t0 < 2.5 and not marker.exists()
    assert cur.cost_usd == 0.0                           # 复核 P3:Popen 后立刻被杀的一分钱没花


def test_cancel_right_after_the_child_exits_is_not_overwritten_by_done(tmp_path: Path, monkeypatch):
    """复核 P3:worker 最后一次写在锁内并尊重已 cancelled —— 子进程刚退出时来的取消不会被 done 盖掉。"""
    store = _store(tmp_path, _fake_python(tmp_path, "exit 0"))
    job, _ = store.create("train", "a", {})
    real_progress = store.progress

    def progress_then_cancel(job_id, *a, **kw):
        out = real_progress(job_id, *a, **kw)
        if store.get(job_id).state == "running":
            store.cancel(job_id)                         # 子进程已退出、worker 正在收尾
        return out

    monkeypatch.setattr(store, "progress", progress_then_cancel)
    store._run(job)
    assert store.get(job.id).state == "cancelled"


def test_queued_release_eval_pins_its_staging_against_pruning(tmp_path: Path):
    """复核 P3:排队中的留出集评估要评的 staging 不能被「只留 3 份无收益」清掉。"""
    store = _store(tmp_path, "python3")
    root = tmp_path / "home" / "work" / "a" / ".evo" / "staging"
    for i in range(5):
        d = root / f"2026010{i}-000000"
        (d / "proposed").mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps({"accepted": False}))
    (tmp_path / "home" / "tasks" / "a" / "all.json").write_text(json.dumps(
        {"tasks": [{"id": "t", "intent": "i", "reference_kind": "rule", "split": "test"}]}))
    job, _ = store.create("release_eval", "a", {"staging": "20260100-000000"})
    assert (root / "20260100-000000" / "release.pending").exists()
    prune_unaccepted(root, keep=3)
    assert (root / "20260100-000000").is_dir() and not (root / "20260101-000000").exists()
    store.cancel(job.id)
    assert not (root / "20260100-000000" / "release.pending").exists()


def test_cancel_while_queued_costs_nothing_and_never_runs(tmp_path: Path):
    marker = tmp_path / "ran"
    store = _store(tmp_path, _fake_python(tmp_path, f"touch {marker}"))
    job, _ = store.create("train", "a", {})
    assert store.cancel(job.id).cost_usd == 0.0          # 静态 P2-23:从未 running 的按 0 计
    store._run(job)
    assert store.get(job.id).state == "cancelled" and not marker.exists()


def test_stop_marks_running_job_interrupted_not_cancelled(tmp_path: Path):
    store = _store(tmp_path, "python3")
    job = Job(id="job_x", kind="train", skill="a", args={}, state="running", created_at="t", started_at="t")
    store._write(job)
    proc = subprocess.Popen(["sh", "-c", "sleep 30"], start_new_session=True)  # noqa: S603,S607
    store._procs[job.id] = proc
    store.stop()
    assert proc.poll() is not None
    assert store.get("job_x").state == "interrupted"


# ── 静态 P1-10:target 模型费用进预算 ────────────────────────────────────────

def test_cost_includes_target_backend():
    from skillwhet.backend import MockBackend, Roles
    from skillwhet.trainer import _calls_and_cost
    fast, slow, ev, target = MockBackend(), MockBackend(), MockBackend(), MockBackend()
    for b, c in ((fast, 1.0), (slow, 2.0), (ev, 4.0), (target, 8.0)):
        b.stats.cost_usd = c        # type: ignore[attr-defined]
    assert _calls_and_cost(Roles(fast, slow, ev, target=target))[1] == 15.0
    assert _calls_and_cost(Roles(fast, slow, ev))[1] == 7.0
    assert _calls_and_cost(Roles(fast, slow, ev, target=fast))[1] == 7.0   # 同一对象不重复计


# ── 静态 P1-11:副本里的代码改不了 import.json 的授权字段 ──────────────────

def _upload(ms, name: str, who: str) -> None:
    ms.import_upload(name, [{"rel": "SKILL.md", "content": f"---\nname: {name}\n---\n"}], uploaded_by=who)


def test_authority_survives_tampering_of_own_and_sibling_records(tmp_path: Path):
    """复核 P2-3:作业代码改自己的、也改同级副本 `../b/import.json`(连权威文件一起改),resync 以 serve 的记录为准改回。"""
    from skillwhet.managed import ManagedStore
    ms = ManagedStore(tmp_path / "home", key=b"k" * 32)
    _upload(ms, "a", "alice")
    _upload(ms, "b", "bob")
    for name, who in (("a", "mallory"), ("b", "alice")):
        for p in (ms.record_path(name), ms.authority_path(name)):
            d = json.loads(p.read_text()); d["uploaded_by"] = who; p.write_text(json.dumps(d))
    assert ms.record("b").uploaded_by == "bob"            # 权限判断读的是 serve 的记录,不是磁盘上被改的
    assert sorted(ms.resync()) == ["a", "b"]
    for name, who in (("a", "alice"), ("b", "bob")):
        assert json.loads(ms.record_path(name).read_text())["uploaded_by"] == who
        assert json.loads(ms.authority_path(name).read_text())["uploaded_by"] == who
    assert ms.resync() == []


def test_serve_writes_during_a_job_are_not_reverted(tmp_path: Path):
    """复核 P2-1:作业期间「发布为新技能」(rebase 写 imported_from)与「从技能库更新」(imported_at)是 serve 的合法写入。"""
    from skillwhet.managed import ManagedStore
    ms = ManagedStore(tmp_path / "home", key=b"k" * 32)
    _upload(ms, "a", "alice")
    live = tmp_path / "live" / "a"
    shutil.copytree(ms.dir("a"), live, ignore=shutil.ignore_patterns("import.json", ".evo"))
    ms.rebase("a", live_dir=live)                          # 作业还在跑
    assert ms.resync() == []                               # 作业结束时的校正:没有假 tampered
    assert ms.record("a").imported_from == str(live.resolve())
    live2 = tmp_path / "lib" / "b"
    live2.mkdir(parents=True)
    (live2 / "SKILL.md").write_text("---\nname: b\n---\n")
    first = ms.import_live("b", live2)
    time.sleep(1.1)
    second = ms.import_live("b", live2, replace=True)
    assert ms.resync() == [] and ms.record("b").imported_at == second.imported_at != first.imported_at


def test_sigkilled_serve_restart_detects_forgery_and_migrates_old_homes(tmp_path: Path):
    """复核 P2-3:serve 被 SIGKILL 期间记录被改 —— 重启时验签,伪造的不认;旧 home 只有 import.json 的迁移成权威记录。"""
    from skillwhet.managed import ManagedError, ManagedStore
    home = tmp_path / "home"
    ms = ManagedStore(home, key=b"k" * 32)
    _upload(ms, "a", "alice")
    good = ms.authority_path("a").read_text()
    # 作业代码两份都改(伪造不出签名)
    for p in (ms.record_path("a"), ms.authority_path("a")):
        d = json.loads(p.read_text()); d["uploaded_by"] = "mallory"; p.write_text(json.dumps(d))
    again = ManagedStore(home, key=b"k" * 32)
    with pytest.raises(ManagedError) as ei:
        again.record("a")
    assert ei.value.code == "RECORD_TAMPERED" and again.list() == []
    # 只改了镜像:权威验签通过,启动校正把镜像改回
    ms.authority_path("a").write_text(good)
    third = ManagedStore(home, key=b"k" * 32)
    assert third.record("a").uploaded_by == "alice" and third.resync() == ["a"]
    assert json.loads(ms.record_path("a").read_text())["uploaded_by"] == "alice"
    # 旧 home(0.5.1):没有 records/,只有 work/<n>/import.json
    old = tmp_path / "old"
    (old / "work" / "x").mkdir(parents=True)
    (old / "work" / "x" / "SKILL.md").write_text("---\nname: x\n---\n")
    (old / "work" / "x" / "import.json").write_text(json.dumps({"name": "x", "source": "upload", "uploaded_by": "carol"}))
    migrated = ManagedStore(old, key=b"k" * 32)
    assert migrated.record("x").uploaded_by == "carol" and (old / "records" / "x.json").exists()


def test_gate_endpoint_restores_tampered_records(srv, tmp_path: Path):
    base, home = srv
    live = live_copy(tmp_path)
    (live / "tests" / "unit" / "test_evil.py").write_text(
        "import json, pathlib\n"
        "def test_evil():\n"
        "    for p in (pathlib.Path('import.json'), pathlib.Path('../../records/textnorm.json')):\n"
        "        d = json.loads(p.read_text()); d['source'] = 'upload'; d['uploaded_by'] = 'mallory'\n"
        "        p.write_text(json.dumps(d))\n")
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    assert call(base, "POST", "/skills/textnorm/bootstrap", {})[0] == 200
    st, r = call(base, "POST", "/skills/textnorm/gate?no_bandit&no_pyright")
    assert st == 200, r
    assert any("textnorm" in w and "restored" in w for w in r["data"]["warnings"]), r["data"]
    for p in (home / "work" / "textnorm" / "import.json", home / "records" / "textnorm.json"):
        rec = json.loads(p.read_text())
        assert rec["source"] == "live" and rec["uploaded_by"] == ""
    st, r = call(base, "GET", "/skills/textnorm")
    assert r["data"]["source"] == "live"


def test_reimport_refused_while_a_job_is_live(srv, tmp_path: Path):
    """复核 P2-2:从技能库更新副本(replace)也要查活跃作业。"""
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    (home / "jobs" / "job_live").mkdir(parents=True)
    (home / "jobs" / "job_live" / "state.json").write_text(json.dumps(
        Job(id="job_live", kind="train", skill="textnorm", args={}, state="queued", created_at="t").to_dict()))
    st, r = call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live), "replace": True})
    assert st == 409 and r["error"] == "JOB_ACTIVE", r


def test_job_env_has_no_serve_token(tmp_path: Path, monkeypatch):
    from skillwhet.server import App
    monkeypatch.setenv("SKILLWHET_TOKEN", "secret-token")
    app = App(tmp_path / "home", "secret-token")
    assert "SKILLWHET_TOKEN" not in app.jobs.env
    app.jobs.stop()


# ── P2-13 / P2-20:移除副本带走任务集;有活跃作业时 409 ───────────────────────

def test_remove_takes_tasks_along_and_overview_forgets_it(srv, tmp_path: Path):
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    st, r = call(base, "POST", "/tasks", {"skill": "textnorm", "format": "records",
                                            "records": [{"task_id": "t1", "input": "x", "expected_output": "y"}]})
    assert st == 200, r
    assert (home / "tasks" / "textnorm" / "all.json").exists()
    st, r = call(base, "DELETE", "/skills/textnorm")
    assert st == 200 and r["data"]["tasks_moved_to"], r
    assert not (home / "tasks" / "textnorm").exists() and Path(r["data"]["tasks_moved_to"]).is_dir()
    assert Path(r["data"]["tasks_moved_to"]).parent == home / "_removed"
    st, r = call(base, "GET", "/tasks")
    assert r["data"]["summary"] == []
    # 同名重传者拿不到前人的任务
    live2 = live_copy(tmp_path / "again")
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live2)})[0] == 200
    st, r = call(base, "GET", "/tasks?skill=textnorm")
    assert r["data"]["summary"][0]["total"] == 0


def test_bootstrap_and_delete_refused_while_a_job_is_live(srv, tmp_path: Path):
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    (home / "jobs" / "job_live").mkdir(parents=True)
    (home / "jobs" / "job_live" / "state.json").write_text(json.dumps(
        Job(id="job_live", kind="train", skill="textnorm", args={}, state="running", created_at="t").to_dict()))
    st, r = call(base, "POST", "/skills/textnorm/bootstrap", {})
    assert st == 409 and r["error"] == "JOB_ACTIVE" and r["job_id"] == "job_live", r
    st, r = call(base, "DELETE", "/skills/textnorm")
    assert st == 409 and r["error"] == "JOB_ACTIVE", r
    assert (home / "work" / "textnorm" / "SKILL.md").exists()


# ── P2-16 / P2-17 / P3:导入 ────────────────────────────────────────────────

def test_csv_blank_optional_columns_are_defaults():
    from skillwhet.imports import parse_rows, validate_and_map
    rows = parse_rows("input,expected_output,split,checks,context\nhello,world,,,\n", "csv")
    assert rows == [{"input": "hello", "expected_output": "world"}]
    rep = validate_and_map(rows, skill="s", fmt="csv")
    assert rep.passed == 1 and rep.failed == 0


def test_two_batches_in_the_same_second_keep_the_later_one(tmp_path: Path):
    from skillwhet.evidence import TaskRecord
    from skillwhet.imports import TaskStore
    ts = TaskStore(tmp_path)
    mk = lambda ref: [TaskRecord(id="t", intent="i", reference_kind="exact", reference=ref)]  # noqa: E731
    a = ts.add("s", mk("first"))
    b = ts.add("s", mk("second"))
    assert a["batch"] < b["batch"] and b["total"] == 1
    assert ts.all("s")[0].reference == "second"
    # 老格式与新格式混排:老的 -2 不再排到无后缀那份前面
    d = ts.dir("s")
    for name, ref in (("batch-20260101-000000.json", "old1"), ("batch-20260101-000000-2.json", "old2"),
                      ("batch-20260101-000000-10.json", "old10")):
        (d / name).write_text(json.dumps({"tasks": [{"id": "o", "intent": "i", "reference_kind": "exact", "reference": ref}]}))
    ts.rebuild("s")
    assert {t.id: t.reference for t in ts.all("s")}["o"] == "old10"


def test_row_tags_from_feedback_survive_mapping():
    from skillwhet.imports import validate_and_map
    rep = validate_and_map([{"task_id": "fb_1", "input": "x", "expected_output": "y",
                             "tags": ["project:p1", "user:7", "source:feedback"]}],
                           skill="s", fmt="records", tags=["accepted_by:root"])
    assert {"project:p1", "user:7", "source:feedback", "accepted_by:root"} <= set(rep.tasks[0].tags)


def test_bad_inputs_are_400_not_500(srv, tmp_path: Path):
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    st, r = call(base, "POST", "/skills/textnorm/bootstrap", {"allow": ["yaml; rm -rf /"]})
    assert st == 400 and r["error"] == "BAD_ALLOW", r
    assert call(base, "POST", "/skills/textnorm/bootstrap", {"allow": ["yaml", "pkg.sub_mod"]})[0] == 200
    st, r = call(base, "POST", "/tasks", {"skill": "textnorm", "records": [1, 2]})
    assert st == 422 and r["error"] == "BAD_ROW", r
    st, r = call(base, "POST", "/tasks", {"skill": "nope", "records": [{"input": "x", "expected_output": "y"}]})
    assert st == 404, r
    st, r = call(base, "POST", "/tasks/derive", {"skill": "textnorm", "val_fraction": "abc"})
    assert st == 400 and r["error"] == "BAD_SPLIT", r
    assert call(base, "GET", "/jobs?limit=x")[0] == 400
    (home / "jobs" / "job_q").mkdir(parents=True)
    (home / "jobs" / "job_q" / "state.json").write_text(json.dumps(
        Job(id="job_q", kind="train", skill="textnorm", args={}, state="done", created_at="t").to_dict()))
    assert call(base, "GET", "/jobs/job_q/progress?after=abc")[0] == 400
    assert call(base, "GET", "/jobs/job_q/log?tail=")[0] == 200


# ── P2-18:脱敏 ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("text,gone", [
    ("postgres://alice:hunter2@db.local/x", "hunter2"),
    ("password=ab12", "ab12"),
    ("密码:abcd", "abcd"),
    ("数据库密码 = Passw0rd", "Passw0rd"),
    ('{"密码": "abcd1234"}', "abcd1234"),
    ("api_key:abcdef", "abcdef"),
])
def test_redaction_covers_url_creds_short_passwords_chinese_keys(text: str, gone: str):
    from skillwhet.harvest import redact
    out = redact(text)
    assert gone not in out and "REDACTED" in out


def test_redaction_spares_numbers_and_enum_values():
    """复核 P3:`max_tokens: 4096`、`credential_type: oauth` 不是密钥;口令类的键取值是数字仍脱敏。"""
    from skillwhet.harvest import redact
    for keep in ("max_tokens: 4096", "credential_type: oauth", '{"max_tokens": "4096"}', "auth token=bearer"):
        assert redact(keep) == keep, keep
    for gone in ("password: 1234", "密码: 123456", "token: abcd"):
        assert "REDACTED" in redact(gone), gone


def test_feedback_overlay_is_redacted_before_it_lands(tmp_path: Path):
    from skillwhet.harvest import redact_obj
    store = _store(tmp_path, "python3")
    job, _ = store.create("harvest", "a", {"sessions": ["s1"], "backend": "mock",
                                          "feedback_overlay": {"s1": [{"note": "密码:abcd 记得改", "expected_output": "sk-ant-abcdefghijklmnop"}]}})
    raw = (store.dir(job.id) / "feedback_overlay.json").read_text()
    assert "abcd" not in raw and "sk-ant-" not in raw and "REDACTED" in raw
    assert redact_obj({"a": ["token: secretvalue", 1, None]}) == {"a": ["token=[REDACTED]", 1, None]}


# ── P2-19:工具不在 PATH 时不算通过 ──────────────────────────────────────────

def test_missing_tools_skip_their_gate_and_fail_the_health_check(tmp_path: Path, monkeypatch):
    from skillwhet.contract import load_contract
    from skillwhet.gates import PyramidConfig, build_fast_pyramid, run_pyramid
    from skillwhet.gates import g1_security, g2_static, g4_tests
    d = _copy(tmp_path)
    for mod in (g1_security, g2_static):
        monkeypatch.setattr(mod, "tool_command", lambda name: None)
    monkeypatch.setattr(g4_tests, "tool_available", lambda name: False)
    res = run_pyramid(d, load_contract(d), build_fast_pyramid(PyramidConfig(use_pyright=False)), short_circuit=False)
    by = {r.gate: r for r in res.results}
    assert by["G4.unit"].verdict.value == "skip" and "pip install pytest" in by["G4.unit"].detail["reason"]
    assert by["G2.static"].verdict.value == "skip" and by["G2.static"].detail["missing_tools"] == ["ruff"]
    assert by["G1.security"].verdict.value == "skip" and by["G1.security"].detail["missing_tools"] == ["bandit"]
    assert res.passed is True                       # 训练里的候选判定不变:SKIP 不拦
    assert set(res.missing_tools) == {"bandit", "ruff", "pytest"}


def test_g2_without_ruff_still_checks_the_rest(tmp_path: Path, monkeypatch):
    """复核 P3:缺 ruff 只跳过 ruff 这一项;入口点注解等照查,有阻断问题仍是 FAIL。"""
    from skillwhet.gates import g2_static
    from skillwhet.gates.base import Candidate
    from skillwhet.types import Contract, Entrypoint
    d = tmp_path / "s"
    (d / "scripts").mkdir(parents=True)
    (d / "scripts" / "m.py").write_text("def f(x):\n    return x\n")
    monkeypatch.setattr(g2_static, "tool_command", lambda name: None)
    contract = Contract(entrypoints=[Entrypoint(id="f", module="scripts/m.py", stability="stable")])
    res = g2_static.StaticGate(use_pyright=False).run(Candidate(skill_dir=d, contract=contract))
    assert res.verdict.value == "fail" and any(f.rule == "stable-entrypoint-unannotated" for f in res.findings)
    assert res.detail["missing_tools"] == ["ruff"]


def test_gate_endpoint_is_not_passed_without_tools(srv, tmp_path: Path, monkeypatch):
    from skillwhet.gates import g2_static
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    assert call(base, "POST", "/skills/textnorm/bootstrap", {})[0] == 200
    monkeypatch.setattr(g2_static, "tool_command", lambda name: None)
    st, r = call(base, "POST", "/skills/textnorm/gate?no_bandit&no_pyright&no_tests")
    assert st == 200, r
    assert r["data"]["passed"] is False and r["data"]["missing_tools"] == ["ruff"]
    assert any("ruff" in w for w in r["data"]["warnings"])
    st, r = call(base, "GET", "/skills/textnorm")
    assert r["data"]["last_gate"]["passed"] is False


def test_tools_probe_the_module_in_the_current_interpreter(monkeypatch):
    """复核 P2-4:pip --user 装的 bandit / ruff 脚本常不在 PATH —— 用 `<当前解释器> -m` 调。"""
    import sys
    from skillwhet.gates import base as gb
    gb._probe_cache.clear()
    monkeypatch.setattr(gb.shutil, "which", lambda name: "/usr/bin/python3" if name == "python3" else None)
    try:
        assert gb.tool_available("pytest") is True         # PATH 上没有 pytest 脚本,模块却装了
        assert gb.tool_command("bandit") == [sys.executable, "-m", "bandit"]
        assert gb.tool_command("ruff") == [sys.executable, "-m", "ruff"]
        assert gb.tool_command("nonexistent-tool") is None
    finally:
        gb._probe_cache.clear()


# ── P3:同 skill 并发体检合并 ─────────────────────────────────────────────────

def test_concurrent_gate_runs_are_merged(srv, tmp_path: Path, monkeypatch):
    from skillwhet import server as sv
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    assert call(base, "POST", "/skills/textnorm/bootstrap", {})[0] == 200
    runs = []

    def slow_pyramid(*a, **kw):
        runs.append(1)
        time.sleep(0.6)
        from skillwhet.types import PyramidResult
        return PyramidResult(passed=True, results=[])

    monkeypatch.setattr(sv, "run_pyramid", slow_pyramid)
    results: list = []
    ths = [threading.Thread(target=lambda: results.append(call(base, "POST", "/skills/textnorm/gate?no_bandit&no_pyright&no_tests")))
           for _ in range(5)]
    for t in ths:
        t.start()
    for t in ths:
        t.join()
    assert len(runs) == 1 and all(st == 200 for st, _ in results)
    assert sum(1 for _, r in results if r["data"].get("merged")) == 4


# ── P3:无收益 staging 只留最近 3 份 ─────────────────────────────────────────

def test_unaccepted_stagings_are_pruned_to_three(tmp_path: Path):
    root = tmp_path / "staging"
    for i in range(6):
        d = root / f"2026010{i}-000000"
        (d / "proposed").mkdir(parents=True)
        (d / "manifest.json").write_text(json.dumps({"accepted": i == 1}))
    (root / "20260100-000000" / "adopted.json").write_text("{}")
    gone = prune_unaccepted(root, keep=3)
    assert gone == ["20260102-000000"]
    assert sorted(p.name for p in root.iterdir()) == ["20260100-000000", "20260101-000000", "20260103-000000",
                                                     "20260104-000000", "20260105-000000"]


def test_claude_backend_scratch_dir_is_removed(tmp_path: Path):
    from skillwhet.backend import ClaudeCLIBackend
    b = ClaudeCLIBackend(model="x", claude_path="/nonexistent/claude")
    scratch = Path(b._scratch)
    assert scratch.is_dir()
    del b
    import gc
    gc.collect()
    assert not scratch.exists()


def test_staging_summary_file_count_excludes_import_json(tmp_path: Path):
    from skillwhet.server import App
    app = App(tmp_path / "home", "t")
    d = tmp_path / "s"
    d.mkdir()
    (d / "manifest.json").write_text(json.dumps({"files": [{"rel": "SKILL.md"}, {"rel": "import.json"}], "report": {}}))
    (tmp_path / "home" / "work" / "x" / ".evo" / "staging").mkdir(parents=True)
    p = tmp_path / "home" / "work" / "x" / ".evo" / "staging" / "20260101-000000"
    shutil.move(str(d), str(p))
    assert app._staging_summary(p)["files"] == 1
    app.jobs.stop()


def test_version_is_052():
    import skillwhet
    assert skillwhet.__version__ == "0.5.2"
    assert 'version = "0.5.2"' in (Path(__file__).resolve().parent.parent / "pyproject.toml").read_text()


def test_record_key_is_stable_across_tokens_and_restarts(tmp_path: Path):
    """复核:签名密钥原由 SKILLWHET_TOKEN 派生,Prism 没配口令时每次启动随机生成 → 重启后所有记录验签失败、
    技能全部消失。现在密钥落在 home/records/.key,与口令无关。"""
    import os, stat
    from skillwhet.server import App
    home = tmp_path / "home"
    a = App(home, "token-one")
    _upload(a.store, "keep", "alice")
    key_path = home / "records" / ".key"
    assert stat.S_IMODE(os.stat(key_path).st_mode) == 0o600 and len(key_path.read_bytes()) == 32
    b = App(home, "token-two-completely-different")
    assert [s["name"] for s in b.store.list()] == ["keep"]
    assert b.store.record("keep").uploaded_by == "alice"


def test_lost_record_key_resigns_from_authority_records(tmp_path: Path):
    """密钥文件丢了:按工作树外的权威记录重签(不判篡改、不丢技能),镜像同步改回。"""
    from skillwhet.managed import ManagedStore, load_record_key
    home = tmp_path / "home"
    key, fresh = load_record_key(home)
    assert fresh
    ms = ManagedStore(home, key=key)
    _upload(ms, "k2", "bob")
    (home / "records" / ".key").unlink()
    key2, fresh2 = load_record_key(home)
    assert fresh2 and key2 != key
    ms2 = ManagedStore(home, key=key2, rekey=fresh2)
    assert ms2.rekeyed == ["k2"] and ms2.record("k2").uploaded_by == "bob"
    again = ManagedStore(home, key=load_record_key(home)[0])
    assert again.record("k2").uploaded_by == "bob"
