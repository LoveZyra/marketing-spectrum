"""``whet serve`` phase-1 surface: skills / tasks / status over loopback HTTP."""
from __future__ import annotations

import base64
import json
import os
import shutil
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from skillwhet.server import serve

EXAMPLES = Path(__file__).resolve().parent.parent / "examples"
TOKEN = "t-secret"


@pytest.fixture()
def srv(tmp_path):
    home = tmp_path / "home"
    s = serve("127.0.0.1", 0, home, TOKEN)
    t = threading.Thread(target=s.serve_forever, daemon=True)
    t.start()
    port = s.server_address[1]
    yield f"http://127.0.0.1:{port}", home
    s.shutdown()
    s.server_close()


def call(base: str, method: str, path: str, body=None, token=TOKEN):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token is not None:
        req.add_header("X-SkillWhet-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode())


def live_copy(tmp_path: Path, name: str = "textnorm") -> Path:
    dst = tmp_path / "live" / name
    shutil.copytree(EXAMPLES / name, dst, ignore=shutil.ignore_patterns(".evo", "__pycache__"))
    return dst


def test_healthz_needs_no_token_and_reports_tools(srv):
    base, home = srv
    st, r = call(base, "GET", "/healthz", token=None)
    assert st == 200 and r["ok"] and r["data"]["python"]
    assert set(r["data"]["tools"]) >= {"ruff", "bandit", "pyright", "unshare", "claude_cli"}
    # TMPDIR is redirected under the home with the platform marker
    assert os.environ["TMPDIR"].startswith(str(home)) and "prism-skillwhet" in os.environ["TMPDIR"]


def test_token_required(srv):
    base, _ = srv
    assert call(base, "GET", "/skills", token=None)[0] == 401
    assert call(base, "GET", "/skills", token="wrong")[0] == 401
    assert call(base, "GET", "/skills")[0] == 200


def test_import_bootstrap_gate_status(srv, tmp_path):
    base, home = srv
    live = live_copy(tmp_path)
    st, r = call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})
    assert st == 200, r
    assert r["data"]["imported"]["source"] == "live"
    assert r["data"]["status"]["python_files"] >= 1
    assert (home / "work" / "textnorm" / "SKILL.md").exists()
    # importing twice is a conflict
    assert call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})[0] == 409

    st, r = call(base, "POST", "/skills/textnorm/bootstrap", {})
    assert st == 200 and r["data"]["status"]["bootstrapped"]
    assert (home / "work" / "textnorm" / ".evo" / "baseline" / "SKILL.md").exists()
    assert not (live / ".evo").exists()          # the live tree is never touched

    # GET is read-only: nothing cached yet
    st, r = call(base, "GET", "/skills/textnorm/gate")
    assert st == 200 and r["data"]["cached"] is False and r["data"]["results"] == []
    # POST runs the pyramid and caches it
    st, r = call(base, "POST", "/skills/textnorm/gate", {})
    assert st == 200
    names = [g["gate"] for g in r["data"]["results"]]
    assert len(names) == 6
    st, r = call(base, "GET", "/skills/textnorm/gate")
    assert r["data"]["cached"] is True and [g["gate"] for g in r["data"]["results"]] == names
    assert all(g["verdict"] in ("pass", "fail", "skip") for g in r["data"]["results"])
    st, r = call(base, "GET", "/skills/textnorm/status")
    assert r["data"]["last_gate"]["results"][0]["gate"] == names[0]

    st, r = call(base, "GET", "/skills")
    assert [s["name"] for s in r["data"]["skills"]] == ["textnorm"]
    assert call(base, "GET", "/skills/textnorm/contract")[1]["data"]["exists"]
    assert call(base, "GET", "/skills/textnorm/facts")[0] == 200
    assert call(base, "GET", "/skills/textnorm/drift")[1]["data"]["drift"] == []


def test_import_refuses_live_tree_with_evo(srv, tmp_path):
    base, _ = srv
    live = live_copy(tmp_path)
    (live / ".evo").mkdir()
    st, r = call(base, "POST", "/skills/textnorm/import", {"live_dir": str(live)})
    assert st == 400 and r["error"] == "LIVE_HAS_EVO"


def test_upload_validation_and_package_tasks(srv, tmp_path):
    base, home = srv
    def files_of(root: Path, name_override: str | None = None):
        out = []
        for p in sorted(root.rglob("*")):
            if p.is_file() and "__pycache__" not in p.parts:
                text = p.read_text(encoding="utf-8")
                if p.name == "SKILL.md" and name_override:
                    text = text.replace("name: textnorm", f"name: {name_override}")
                out.append({"rel": p.relative_to(root).as_posix(), "content": text})
        return out
    src = EXAMPLES / "textnorm"
    files = files_of(src)
    files.append({"rel": "tasks.json", "content": json.dumps([
        {"task_id": "a", "input": "  Hello ", "expected_output": "hello"},
        {"task_id": "b", "input": "x", "rubric": "the answer must be lowercase and trimmed"},
    ])})
    # name mismatch with SKILL.md frontmatter
    st, r = call(base, "POST", "/skills/upload", {"name": "other", "files": files, "uploaded_by": "u1"})
    assert st == 400 and r["error"] == "NAME_MISMATCH"
    # path traversal
    bad = files + [{"rel": "../evil.py", "content": ""}]
    assert call(base, "POST", "/skills/upload", {"name": "textnorm", "files": bad})[1]["error"] == "BAD_PATH"
    # .evo inside
    bad = files + [{"rel": ".evo/x", "content": ""}]
    assert call(base, "POST", "/skills/upload", {"name": "textnorm", "files": bad})[1]["error"] == "HAS_EVO"
    # no SKILL.md
    assert call(base, "POST", "/skills/upload", {"name": "textnorm",
                "files": [f for f in files if f["rel"] != "SKILL.md"]})[1]["error"] == "NO_SKILL_MD"
    # good upload, with tasks.json inside the package
    st, r = call(base, "POST", "/skills/upload", {"name": "textnorm", "files": files, "uploaded_by": "u1"})
    assert st == 200, r
    assert r["data"]["imported"]["source"] == "upload" and r["data"]["imported"]["uploaded_by"] == "u1"
    assert r["data"]["tasks"]["passed"] == 2 and r["data"]["tasks"]["added"]["added"] == 2
    assert (home / "tasks" / "textnorm" / "all.json").exists()
    # duplicate name
    assert call(base, "POST", "/skills/upload", {"name": "textnorm", "files": files})[0] == 409
    # remove moves aside, never deletes
    st, r = call(base, "DELETE", "/skills/textnorm")
    assert st == 200 and Path(r["data"]["moved_to"]).exists()
    assert not (home / "work" / "textnorm").exists()


def test_upload_base64_and_size_limit(srv):
    base, _ = srv
    files = [{"rel": "SKILL.md", "content": "---\nname: tiny\n---\n# tiny"},
             {"rel": "scripts/a.py", "content_b64": base64.b64encode(b"x = 1\n").decode()}]
    assert call(base, "POST", "/skills/upload", {"name": "tiny", "files": files})[0] == 200
    big = [{"rel": "SKILL.md", "content": "---\nname: big\n---\n"},
           {"rel": "blob.bin", "content": "a" * (5 * 1024 * 1024 + 1)}]
    st, r = call(base, "POST", "/skills/upload", {"name": "big", "files": big})
    assert st == 400 and r["error"] == "FILE_TOO_BIG"


def test_tasks_validate_and_add(srv):
    base, home = srv
    # hl(动态 P3):未托管的 skill 不再收任务(404)—— 先给 "s" 建一份最小副本
    st, r = call(base, "POST", "/skills/upload", {"name": "s", "files": [{"rel": "SKILL.md", "content": "---\nname: s\n---\n"}]})
    assert st == 200, r
    content = json.dumps([
        {"task_id": "case-001", "group_id": "rate-a", "input": {"visits": 100, "conversions": 8},
         "expected_output": {"rate": 0.08}},
        {"task_id": "case-002", "input": {"visits": 0}, "expected_output": 0},
        {"task_id": "case-003", "input": {"visits": 50}},
        {"task_id": "case-001", "input": "dup", "expected_output": "x"},
        {"task_id": "case-005", "input": "false ok", "expected_output": False},
        {"task_id": "case-006", "input": "null ok", "expected_output": None},
        {"task_id": "case-007", "input": "split", "expected_output": 1, "split": "dev"},
        {"task_id": "case-008", "input": "bad split", "expected_output": 1, "split": "prod"},
    ])
    st, r = call(base, "POST", "/tasks/validate", {"skill": "s", "format": "json", "content": content})
    assert st == 200
    rows = {x["row"]: x for x in r["data"]["rows"]}
    assert rows[1]["ok"] and rows[1]["reference_kind"] == "exact" and rows[1]["family"] == "rate-a"
    assert rows[2]["ok"] and rows[5]["ok"] and rows[6]["ok"]           # 0 / false / null are legal
    assert not rows[3]["ok"] and "expected_output" in rows[3]["errors"][0]
    assert not rows[4]["ok"] and "重复" in rows[4]["errors"][0]
    assert rows[7]["ok"] and not rows[8]["ok"]
    assert r["data"]["passed"] == 5 and r["data"]["failed"] == 3
    # add refuses invalid rows unless keep_passing
    st, r = call(base, "POST", "/tasks", {"skill": "s", "format": "json", "content": content})
    assert st == 422 and r["error"] == "ROWS_INVALID"
    st, r = call(base, "POST", "/tasks", {"skill": "s", "format": "json", "content": content,
                                          "keep_passing": True, "tags": ["project:p1", "user:7"]})
    assert st == 200 and r["data"]["added"] == 5 and r["data"]["total"] == 5
    st, r = call(base, "GET", "/tasks?skill=s&full=1")
    assert r["data"]["summary"][0]["total"] == 5
    t = {x["id"]: x for x in r["data"]["tasks"]}
    assert t["case-007"]["split"] == "val"
    assert "project:p1" in t["case-001"]["tags"] and "family:rate-a" in t["case-001"]["tags"]
    # jsonl and csv
    st, r = call(base, "POST", "/tasks/validate", {"skill": "s", "format": "jsonl",
                 "content": '{"input":"a","expected_output":"b"}\n{"input":"c"}\n'})
    assert r["data"]["passed"] == 1 and r["data"]["failed"] == 1
    st, r = call(base, "POST", "/tasks/validate", {"skill": "s", "format": "csv",
                 "content": 'task_id,input,expected_output\nc1,hello,0\nc2,"{""a"":1}","{""b"":2}"\n'})
    assert r["data"]["passed"] == 2, r
    st, r = call(base, "POST", "/tasks/validate", {"skill": "s", "format": "json", "content": "{bad"})
    assert st == 422 and r["error"] == "BAD_JSON"


def test_unknown_route_and_bad_json(srv):
    base, _ = srv
    assert call(base, "GET", "/nope")[0] == 404
    req = urllib.request.Request(base + "/tasks", data=b"{not json", method="POST")
    req.add_header("X-SkillWhet-Token", TOKEN)
    try:
        urllib.request.urlopen(req)
    except urllib.error.HTTPError as e:
        assert e.code == 400
