"""gz: training jobs over ``whet serve`` — queue, progress, staging, diff, export, cancel."""
from __future__ import annotations

import io
import json
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path

import pytest

from skillwhet.jobs import Job, JobError, JobStore, build_argv
from skillwhet.progress import Progress, read_events

from tests.test_server import EXAMPLES, TOKEN, call, live_copy, srv  # noqa: F401 — fixture re-export


def _managed_with_tasks(base: str, tmp_path: Path, name: str = "textnorm") -> None:
    live = live_copy(tmp_path, name)
    st, r = call(base, "POST", f"/skills/{name}/import", {"live_dir": str(live)})
    assert st == 200, r
    st, r = call(base, "POST", f"/skills/{name}/bootstrap", {})
    assert st == 200, r
    # the tests ARE the tasks: derive them server-side, the way `whet train` does without --tasks
    st, r = call(base, "POST", "/tasks/derive", {"skill": name, "val_fraction": 0.34, "test_fraction": 0.0})
    assert st == 200 and r["data"]["derived"] > 0, r
    st, r = call(base, "GET", f"/tasks?skill={name}")
    assert r["data"]["summary"][0]["sources"] == {"tests": r["data"]["summary"][0]["total"]}


def _wait(base: str, job_id: str, timeout: float = 240.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st, r = call(base, "GET", f"/jobs/{job_id}")
        assert st == 200, r
        if r["data"]["job"]["state"] not in ("queued", "running"):
            return r["data"]["job"]
        time.sleep(0.5)
    raise AssertionError("job did not finish in time")


MOCK = {"rounds": 1, "fast_backend": "mock", "slow_backend": "mock", "eval_backend": "mock",
        "no_cache": True, "tests_every": 0}


def test_build_argv_whitelists_flags(tmp_path: Path):
    argv = build_argv("python3", tmp_path / "w", tmp_path / "t.json", tmp_path / "p.jsonl",
                      {"rounds": 2, "fast_backend": "mock", "no_slow_loop": True, "max_cost_usd": 0.5})
    assert argv[:4] == ["python3", "-m", "skillwhet", "train"]
    assert "--rounds" in argv and argv[argv.index("--rounds") + 1] == "2"
    assert "--no-slow-loop" in argv and "--max-cost-usd" in argv
    # gz UI 表单发的全套参数都得在白名单里(现场:'refine' 曾被拒)
    ui_args = {"rounds": 2, "runner": "pytest", "k": 4, "budget_p2": 6, "refine": 1, "workers": 2, "judge_samples": 1,
               "no_accept_rounds": 2, "fast_model": "haiku", "slow_model": "sonnet", "eval_model": "opus",
               "max_cost_usd": 5, "max_minutes": 120}
    argv = build_argv("python3", tmp_path / "w", tmp_path / "t.json", tmp_path / "p.jsonl", ui_args)
    assert "--refine" in argv and argv[argv.index("--refine") + 1] == "1"
    for bad in ({"rounds": 0}, {"fast_backend": "http://x"}, {"target_model": "a b"},
                {"evil": 1}, {"no_slow_loop": "yes"}, {"rounds": True}):
        with pytest.raises(JobError):
            build_argv("python3", tmp_path / "w", tmp_path / "t.json", tmp_path / "p.jsonl", bad)


def test_progress_sink_sequences_and_resumes(tmp_path: Path):
    p = tmp_path / "p.jsonl"
    a = Progress(p)
    a.emit("job_start", skill="x")
    a.emit("round_start", round=1)
    b = Progress(p)                       # a second writer continues the sequence
    b.emit("done", stop_reason="rounds")
    evs = read_events(p)
    assert [e["seq"] for e in evs] == [1, 2, 3] and evs[-1]["kind"] == "done"
    assert read_events(p, after=2)[0]["seq"] == 3
    assert Progress(None).emit("x")["seq"] == 1     # null sink still returns the event


def test_job_lifecycle_over_http(srv, tmp_path: Path):
    base, home = srv
    _managed_with_tasks(base, tmp_path)
    # preconditions → precise errors
    st, r = call(base, "POST", "/jobs", {"skill": "nope", "args": MOCK})
    assert st == 404 and r["error"] == "NOT_MANAGED"
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "args": {**MOCK, "rounds": 99}})
    assert st == 400 and r["error"] == "BAD_ARG"
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "eval"})
    assert st == 400 and r["error"] == "BAD_KIND"

    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "args": MOCK, "tags": ["user:1"]})
    assert st == 200, r
    job_id = r["data"]["job"]["id"]
    assert r["data"]["job"]["state"] == "queued" and r["data"]["job"]["tags"] == ["user:1"]
    # same skill again while live → 409 with the live job's id
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "args": MOCK})
    assert st == 409 and r["error"] == "JOB_DUPLICATE" and r["job_id"] == job_id

    job = _wait(base, job_id)
    assert job["state"] == "done", job
    assert job["stop_reason"] in ("rounds", "no_signal", "no_accept")
    assert job["pid"] and job["rc"] == 0 and job["cost_usd"] == 0
    st, r = call(base, "GET", f"/jobs/{job_id}/progress?after=0")
    kinds = [e["kind"] for e in r["data"]["events"]]
    assert kinds[0] == "job_start" and "tasks_split" in kinds and "round_start" in kinds and kinds[-1] == "done"
    assert r["data"]["state"] == "done"
    last = r["data"]["last_seq"]
    st, r = call(base, "GET", f"/jobs/{job_id}/progress?after={last}")
    assert r["data"]["events"] == []
    st, r = call(base, "GET", f"/jobs/{job_id}/log?tail=50")
    assert "baseline" in r["data"]["log"]
    st, r = call(base, "GET", "/jobs?skill=textnorm")
    assert [j["id"] for j in r["data"]["jobs"]] == [job_id]
    # done jobs cannot be cancelled
    assert call(base, "POST", f"/jobs/{job_id}/cancel", {})[0] == 409

    # staging: the run staged something (S0 itself when nothing improved)
    st, r = call(base, "GET", "/skills/textnorm/staging")
    assert st == 200 and len(r["data"]["staging"]) == 1
    sid = r["data"]["staging"][0]["id"]
    assert job["staging"] == sid
    st, r = call(base, "GET", f"/skills/textnorm/staging/{sid}")
    assert st == 200 and r["data"]["manifest"]["schema"] == "skillwhet-staging"
    assert isinstance(r["data"]["diffs"], list) and "stop_reason" in r["data"]["report"]
    assert r["data"]["report"]["model_snapshot"]["fast"]["backend"] == "mock"
    # export is a tar.gz of proposed/, rooted at <skill>/
    req = urllib.request.Request(f"{base}/skills/textnorm/staging/{sid}/export")
    req.add_header("X-SkillWhet-Token", TOKEN)
    with urllib.request.urlopen(req, timeout=30) as resp:
        assert resp.headers["Content-Type"] == "application/gzip"
        data = resp.read()
    names = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz").getnames()
    assert "textnorm/SKILL.md" in names and not any("/.evo/" in n for n in names)
    assert "textnorm/import.json" not in names  # 受管记录不进导出包
    # adopt: an unaccepted round is refused without force; force lands it
    st, r = call(base, "POST", f"/skills/textnorm/staging/{sid}/adopt", {})
    assert st in (200, 409), r
    if st == 409:
        assert r["error"] == "ADOPT_REFUSED"
        # ha:force 不再顺手跳过留出集;跳过要显式 skip_release
        st, r = call(base, "POST", f"/skills/textnorm/staging/{sid}/adopt", {"force": True})
        assert st == 409 and "release" in r["message"], r
        st, r = call(base, "POST", f"/skills/textnorm/staging/{sid}/adopt", {"force": True, "skip_release": True})
        assert st == 200 and r["data"]["adopted"]
    st, r = call(base, "GET", f"/skills/textnorm/staging/{sid}")
    assert r["data"]["adopted"] is True
    # a second job on the same skill is allowed now that the first is terminal
    assert call(base, "POST", "/jobs", {"skill": "textnorm", "args": MOCK})[0] == 200


def test_queue_is_fifo_and_queued_jobs_cancel_instantly(tmp_path: Path):
    home = tmp_path / "home"
    store = JobStore(home, work_root=home / "work", tasks_root=home / "tasks", start_worker=False)
    for name in ("a", "b"):
        (home / "work" / name / ".evo" / "baseline").mkdir(parents=True)
        (home / "work" / name / "SKILL.md").write_text("---\nname: x\n---\n")
        (home / "tasks" / name).mkdir(parents=True)
        (home / "tasks" / name / "all.json").write_text(json.dumps({"tasks": [{"id": "t", "intent": "i", "reference_kind": "rule"}]}))
    ja, pa = store.create("train", "a", {})
    time.sleep(1.1)                                    # ids are second-resolution
    jb, pb = store.create("train", "b", {})
    assert (pa, pb) == (0, 1) and store.queue_position(jb.id) == 1
    assert store._next().id == ja.id
    assert store.cancel(ja.id).state == "cancelled"
    assert store._next().id == jb.id and store.queue_position(jb.id) == 0
    with pytest.raises(JobError) as ei:
        store.create("train", "b", {})
    assert ei.value.code == "JOB_DUPLICATE"
    with pytest.raises(JobError) as ei:
        store.create("train", "c", {})
    assert ei.value.code == "NOT_MANAGED"


def test_running_job_is_killed_as_a_group_and_restart_marks_interrupted(tmp_path: Path):
    home = tmp_path / "home"
    store = JobStore(home, work_root=home / "work", tasks_root=home / "tasks", start_worker=False)
    job = Job(id="job_x", kind="train", skill="a", args={}, state="running", created_at="t", started_at="t")
    store._write(job)
    proc = subprocess.Popen(["sh", "-c", "sleep 30 & sleep 30"], start_new_session=True)  # noqa: S603,S607
    store._procs[job.id] = proc
    job.pid = proc.pid
    store._write(job)
    t0 = time.monotonic()
    assert store.cancel(job.id).state == "cancelled"
    assert proc.poll() is not None and time.monotonic() - t0 < 6
    # a serve restart finds a "running" job whose process is gone → interrupted
    job2 = Job(id="job_y", kind="train", skill="b", args={}, state="running", created_at="t")
    store._write(job2)
    again = JobStore(home, work_root=home / "work", tasks_root=home / "tasks", start_worker=False)
    assert again.get("job_y").state == "interrupted" and again.get("job_x").state == "cancelled"


def test_manifest_and_task_names_are_not_trusted(srv, tmp_path: Path):
    """gz 审计:manifest.json 躺在副本里(副本代码写得到),task store 的 skill 名来自反馈 skill_hint。"""
    from skillwhet.staging import StagingError, _check_rel
    base, home = srv
    for bad in ("../x", "/etc/passwd", ".evo/gate.json", "a/../../b", ""):
        with pytest.raises(StagingError):
            _check_rel(bad)
    _check_rel("scripts/a.py")
    # task store refuses path-ish skill names (400, nothing written outside tasks/)
    st, r = call(base, "POST", "/tasks", {"skill": "../../escape", "format": "records",
                                            "records": [{"task_id": "t", "input": "x", "expected_output": "y"}]})
    assert st == 400, r
    assert not (home.parent / "escape").exists() and not (home / "escape").exists()
    st, r = call(base, "POST", "/tasks", {"skill": "/tmp/abs", "format": "records",
                                            "records": [{"task_id": "t", "input": "x", "expected_output": "y"}]})
    assert st == 400, r


def test_worker_survives_bad_progress_and_records_cost_on_cancel(tmp_path: Path):
    from skillwhet.progress import read_events
    p = tmp_path / "p.jsonl"
    p.write_text('{"seq": 1, "kind": "round_end", "cost_usd": 0.5}\n[]\n{"seq": "x"}\n{"seq": 2, "kind": "round_end", "cost_usd": 0.25}\nnot json\n')
    evs = read_events(p)
    assert [e["seq"] for e in evs] == [1, 2]
    home = tmp_path / "home"
    store = JobStore(home, work_root=home / "work", tasks_root=home / "tasks", start_worker=False)
    (home / "jobs" / "job_x").mkdir(parents=True)
    (home / "jobs" / "job_x" / "progress.jsonl").write_text(p.read_text())
    assert store._cost_so_far("job_x") == 0.75
    assert store._cost_so_far("job_none") is None


# ── ha:harvest / release_eval 作业,G8 泄漏检查,导出契约 ─────────────────

@pytest.fixture()
def srv_ha(tmp_path, monkeypatch):
    from skillwhet.server import serve
    import threading
    tr = tmp_path / "transcripts" / "-proj-a"
    tr.mkdir(parents=True)
    for sid in ("sess-1", "sess-2"):
        rows = [
            {"timestamp": "2026-09-20T00:00:00Z", "cwd": "/proj/a", "uuid": f"{sid}-u1",
             "message": {"role": "user", "content": "normalise these cells: '  $12 ', '  7'"}},
            {"timestamp": "2026-09-20T00:01:00Z", "uuid": f"{sid}-a1", "type": "assistant",
             "message": {"role": "assistant", "content": [
                 {"type": "tool_use", "name": "Skill", "input": {"skill": "textnorm"}},
                 {"type": "text", "text": "12 and 7"}]}},
        ]
        (tr / f"{sid}.jsonl").write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    monkeypatch.setenv("SKILLWHET_TRANSCRIPTS", str(tmp_path / "transcripts"))
    home = tmp_path / "home"
    s = serve("127.0.0.1", 0, home, TOKEN)
    t = threading.Thread(target=s.serve_forever, daemon=True)
    t.start()
    yield f"http://127.0.0.1:{s.server_address[1]}", home
    s.shutdown()
    s.server_close()


def test_harvest_job_dry_run_then_mine_then_import(srv_ha, tmp_path: Path):
    base, home = srv_ha
    _managed_with_tasks(base, tmp_path)
    overlay = {"sess-2": [{"message_uuid": "sess-2-a1", "verdict": -1, "category": "wrong_result",
                           "note": "dollar sign kept", "expected_output": "12"}]}
    # 白名单只放 sess-2:sess-1 不可见,一条都不能被读
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "harvest",
                                         "args": {"sessions": ["sess-2"], "feedback_overlay": overlay,
                                                  "dry_run": True, "backend": "mock"}})
    assert st == 200, r
    job = _wait(base, r["data"]["job"]["id"])
    assert job["state"] == "done" and job["args"]["sessions_count"] == 1, job
    st, r = call(base, "GET", f"/jobs/{job['id']}/result")
    sessions = r["data"]["result"]["sessions"]
    assert [x["session_id"] for x in sessions] == ["sess-2"] and sessions[0]["votes"] == 1
    assert r["data"]["result"]["tasks"] == []
    assert call(base, "POST", f"/jobs/{job['id']}/import", {})[0] == 409          # dry-run 不能入库
    # 真挖(mock 挖掘器 + 叠加层里的期望结果 → 一条 exact + 一条 rubric)
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "harvest",
                                         "args": {"sessions": ["sess-2"], "feedback_overlay": overlay, "backend": "mock"}})
    job = _wait(base, r["data"]["job"]["id"])
    assert job["state"] == "done", job
    res = call(base, "GET", f"/jobs/{job['id']}/result")[1]["data"]["result"]
    kinds = sorted(t["reference_kind"] for t in res["tasks"])
    assert kinds == ["exact", "rubric"], res
    assert all(t["family_id"] == "sess-2" for t in res["tasks"])
    assert len({t["split"] for t in res["tasks"]}) == 1                    # 同一会话不跨 split
    assert all("outcome:voted" in t["tags"] and t["outcome"] == "fail" for t in res["tasks"])
    st, r = call(base, "POST", f"/jobs/{job['id']}/import", {"tags": ["accepted_by:root"]})
    assert st == 200 and r["data"]["added"] == 2, r
    assert call(base, "POST", f"/jobs/{job['id']}/import", {})[0] == 409          # 只入一次
    st, r = call(base, "GET", "/tasks?skill=textnorm")
    assert r["data"]["summary"][0]["sources"].get("harvest") == 2
    # 参数白名单
    assert call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "harvest",
                                        "args": {"sessions": ["../../etc"]}})[0] == 400
    assert call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "harvest",
                                        "args": {"transcripts": "/"}})[0] == 400


def test_release_eval_is_once_and_gates_adopt(srv, tmp_path: Path):
    base, home = srv
    live = live_copy(tmp_path)
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 200
    assert call(base, "POST", "/skills/textnorm/bootstrap", {})[0] == 200
    st, r = call(base, "POST", "/tasks/derive", {"skill": "textnorm", "val_fraction": 0.34, "test_fraction": 0.34})
    assert st == 200, r
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "args": MOCK})
    job = _wait(base, r["data"]["job"]["id"])
    sid = job["staging"]
    man = json.loads((home / "work" / "textnorm" / ".evo" / "staging" / sid / "manifest.json").read_text())
    assert len(man["base_bundle_hash"]) == 64 and len(man["protocol_hash"]) == 64
    assert man["search_result"]["rounds"] >= 1
    # 训练不看 test
    st, r = call(base, "GET", f"/skills/textnorm/staging/{sid}")
    assert r["data"]["test_score_baseline"] is None and r["data"]["release"] is None
    # 没有 release-eval,不带 force 采纳被拒
    st, r = call(base, "POST", f"/skills/textnorm/staging/{sid}/adopt", {})
    assert st == 409 and "release" in r["message"]
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "release_eval", "args": {"staging": sid}})
    assert st == 200, r
    rj = _wait(base, r["data"]["job"]["id"])
    assert rj["state"] == "done", rj
    st, r = call(base, "GET", f"/jobs/{rj['id']}/result")
    rel = r["data"]["result"]
    assert rel["test_tasks"] >= 1 and rel["baseline"] is not None and rel["candidate"] is not None
    st, r = call(base, "GET", f"/skills/textnorm/staging/{sid}")
    assert r["data"]["release"]["test_tasks"] == rel["test_tasks"]
    assert r["data"]["test_score_best"] == rel["candidate"]
    assert rel["test_set_hash"] and rel["candidate_bundle_hash"] and rel["looks_on_test_set"] == 1
    assert (home / "releases" / "textnorm" / f"{sid}.json").exists()      # serve 自己那份才算数
    # 第二次看 test:拒
    st, r = call(base, "POST", "/jobs", {"skill": "textnorm", "kind": "release_eval", "args": {"staging": sid}})
    assert st == 409 and r["error"] == "TEST_CONSUMED"
    # 副本里伪造的 release.json 不算:serve 只认自己 home 里那份
    other = home / "work" / "textnorm" / ".evo" / "staging" / "20990101-000000"
    other.mkdir()
    (other / "release.json").write_text('{"baseline": 0, "candidate": 1}')
    # 评过之后,未被接受的 staging 仍要 force;accepted 的直接可采
    st, r = call(base, "POST", f"/skills/textnorm/staging/{sid}/adopt", {"force": True})
    assert st == 200


def test_g8_flags_doc_lines_that_memorise_task_data(tmp_path: Path):
    from skillwhet.expensive import leak_suspects
    base = tmp_path / "s0"; cur = tmp_path / "s1"
    for d in (base, cur):
        d.mkdir()
        (d / "SKILL.md").write_text("---\nname: x\n---\n# X\nNormalise cells.\n", encoding="utf-8")
    (cur / "SKILL.md").write_text("---\nname: x\n---\n# X\nNormalise cells.\n"
                                  "For store 4471 the Q3 revenue was 1,338,000 yuan.\n"
                                  "Always strip currency symbols before parsing numbers.\n", encoding="utf-8")
    src = ["compare store 4471 the Q3 revenue was 1,338,000 against Q2"]
    hits = leak_suspects(cur, base, src)
    assert len(hits) == 1 and "4471" in hits[0][1]
    assert leak_suspects(base, base, src) == []                         # S₀ 里本来就有的行不算
    assert leak_suspects(cur, base, ["strip currency symbols please"]) == []   # 泛泛的短重合不算


def test_g8_ignores_ordinary_doc_edits(tmp_path: Path):
    from skillwhet.expensive import LeakIndex, leak_suspects
    base = tmp_path / "s0"; cur = tmp_path / "s1"
    for d in (base, cur):
        d.mkdir()
    (base / "SKILL.md").write_text("# X\n超时时间为 30 秒,超过就放弃。\n", encoding="utf-8")
    (cur / "SKILL.md").write_text("# X\n超时时间为 30 秒(可配置),超过就放弃。\n## Step 1 of the process\n"
                                  "如果用户没有提供订单号,先询问订单号。\nUse sha256 and utf8 everywhere.\n", encoding="utf-8")
    idx = LeakIndex(["超时时间为 30 秒,超过就放弃", "Step 1 of the process is to ask", "用户没有提供订单号时怎么查退款",
                     "use sha256 and utf8 everywhere please"])
    assert leak_suspects(cur, base, idx) == []


def test_family_split_keeps_a_train_family_and_reuses_known_splits(tmp_path: Path):
    from skillwhet.evidence import TaskRecord, assign_splits
    from skillwhet.imports import TaskStore
    for seed in range(20):
        tasks = [TaskRecord(id=f"{f}-{i}", intent="x", reference_kind="rubric", reference="r", family_id=f)
                 for f in ("fa", "fb") for i in range(3)]
        assign_splits(tasks, seed=seed)
        assert any(t.split == "train" for t in tasks), seed
    store = TaskStore(tmp_path)
    first = [TaskRecord(id="a1", intent="x", reference_kind="rubric", reference="r", family_id="fam", split="test")]
    store.add("sk", first)
    later = [TaskRecord(id="a2", intent="y", reference_kind="rubric", reference="r", family_id="fam", split="train")]
    store.add("sk", later)
    assert {t.split for t in store.rebuild("sk")} == {"test"}
