"""Staging and adoption. The trainer never writes the user's live skill.

A round produces a proposal directory plus a human-readable report; a separate,
explicit ``adopt`` copies it over the live files after taking a backup. Every
target is pinned by sha256, so a skill edited by a human while the loop was
running is refused rather than silently clobbered.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

SCHEMA = "skillwhet-staging"
SCHEMA_VERSION = 1
_SKIP = {".evo", "__pycache__", ".pytest_cache", ".git"}
# hl(动态 P1-8):import.json 是 serve 的受管记录(来源 / 上传者 / 逐文件 sha),不是技能内容。
# 原来 stage 把它当技能文件进 manifest、adopt 原样拷回:采纳 A → 发布(rebase 重写 import.json)→
# 采纳 B 时把 A 时代的 import.json 盖回去,发布链路就死在 NO_IMPORT_RECORD / 全量 drift。
_SKIP_FILES = {"import.json"}


def _check_rel(rel: str) -> None:
    """A manifest file path must stay inside the skill copy."""
    parts = Path(rel).parts
    if not rel or Path(rel).is_absolute() or any(p in ("..", "") for p in parts) or rel.startswith(".evo/") or rel == ".evo":
        raise StagingError(f"unsafe path in manifest: {rel!r}")


class StagingError(ValueError):
    pass


def sha256_file(p: Path) -> str:
    return hashlib.sha256(Path(p).read_bytes()).hexdigest()


def _tracked(root: Path):
    for p in sorted(Path(root).rglob("*")):
        rel = p.relative_to(root)
        if p.is_file() and not (set(rel.parts) & _SKIP) and rel.as_posix() not in _SKIP_FILES:
            yield p


def _skill_files(man: Manifest) -> list[StagedFile]:
    """manifest 里真正属于技能的条目:旧 staging(0.5.1 及以前)的 manifest 可能含 import.json,采纳时忽略。"""
    return [f for f in man.files if f.rel not in _SKIP_FILES]


@dataclass
class StagedFile:
    rel: str
    sha256: str
    live_sha256: str = ""      # "" means the file did not exist on the live side

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Manifest:
    schema: str = SCHEMA
    schema_version: int = SCHEMA_VERSION
    created_at: str = ""
    live_root: str = ""
    accepted: bool = False
    files: list[StagedFile] = field(default_factory=list)
    report: dict = field(default_factory=dict)
    # ha S3-06 导出契约:这份产物由什么、在什么协议下、经过哪几道关得来。
    # base = 训练时副本(S₀ 侧)的逐文件 sha 合成哈希;candidate = proposed/ 的;
    # protocol = runner + 模型快照 + 门配置;三个 *_result 是三道关的结论
    # (review / release 由 adopt / release-eval 另写 adopted.json / release.json,这里留 None)。
    base_bundle_hash: str = ""
    candidate_bundle_hash: str = ""
    protocol_hash: str = ""
    search_result: dict = field(default_factory=dict)
    review_result: dict | None = None
    release_result: dict | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["files"] = [f.to_dict() for f in self.files]
        return d

    @classmethod
    def from_dict(cls, d: dict) -> Manifest:
        known = set(cls.__dataclass_fields__)
        m = cls(**{k: v for k, v in d.items() if k != "files" and k in known})
        m.files = [StagedFile(**f) for f in d.get("files", [])]
        return m


def bundle_hash(root: Path) -> str:
    """一棵技能树的合成哈希:排序后的 (相对路径, sha256) 再哈希一次;.evo / 缓存不算。"""
    root = Path(root)
    h = hashlib.sha256()
    if root.is_dir():
        for p in _tracked(root):
            rel = p.relative_to(root).as_posix()
            h.update(rel.encode()); h.update(b"\0"); h.update(sha256_file(p).encode()); h.update(b"\n")
    return h.hexdigest()


def protocol_hash(report: dict) -> str:
    """runner + 模型快照(用户写的别名)+ 训练 / 门配置 —— 两份产物协议一样才可比。"""
    snap = dict(report.get("model_snapshot") or {})
    snap.pop("claude_cli", None)
    for role in ("fast", "slow", "eval", "target"):
        if isinstance(snap.get(role), dict):
            snap[role] = {k: v for k, v in snap[role].items() if k != "resolved_model"}
    cfg = report.get("config") or {}
    blob = json.dumps({"snapshot": snap, "config": cfg}, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha256(blob.encode()).hexdigest()


def stage(
    candidate_dir: Path, live_dir: Path, *, staging_root: Path,
    report: dict, accepted: bool,
) -> Path:
    """Write a proposal directory. Nothing under *live_dir* is touched."""
    candidate_dir, live_dir = Path(candidate_dir), Path(live_dir)
    base = time.strftime("%Y%m%d-%H%M%S", time.gmtime())
    out = Path(staging_root) / base
    n = 2
    while out.exists():
        out = Path(staging_root) / f"{base}-{n}"      # 20260923-101500-2 / -3,不叠成 -2-3
        n += 1
    (out / "proposed").mkdir(parents=True)

    files: list[StagedFile] = []
    for p in _tracked(candidate_dir):
        rel = p.relative_to(candidate_dir).as_posix()
        dst = out / "proposed" / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(p, dst)
        live = live_dir / rel
        files.append(StagedFile(rel=rel, sha256=sha256_file(p),
                                live_sha256=sha256_file(live) if live.exists() else ""))
        # hd:把"训练开始时"的那一侧也留一份(只留改了的文件)—— 采纳 / 发布之后副本就等于 proposed,
        # 原来的 diff 拿副本当底,历史 staging 一律显示"没有改动",看不到当初改了什么
        if live.exists() and files[-1].sha256 != files[-1].live_sha256:
            keep = out / "base" / rel
            keep.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(live, keep)

    base_dir = live_dir / ".evo" / "baseline"
    man = Manifest(created_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                   live_root=str(live_dir.resolve()), accepted=accepted,
                   files=files, report=report,
                   base_bundle_hash=bundle_hash(live_dir),
                   candidate_bundle_hash=bundle_hash(out / "proposed"),
                   protocol_hash=protocol_hash(report),
                   search_result={k: report.get(k) for k in (
                       "baseline_score", "candidate_score", "improved", "stop_reason",
                       "total_cost_usd", "held_out_test_tasks")} | {"rounds": len(report.get("rounds") or []),
                                                                    "baseline_is_s0": base_dir.is_dir()})
    (out / "report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False),
        encoding="utf-8")
    (out / "report.md").write_text(render_report(report, accepted), encoding="utf-8")
    # manifest last: its presence is the publication marker
    (out / "manifest.json").write_text(
        json.dumps(man.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    if not accepted:
        prune_unaccepted(Path(staging_root), keep=KEEP_UNACCEPTED)
    return out


KEEP_UNACCEPTED = 3


def prune_unaccepted(staging_root: Path, *, keep: int = KEEP_UNACCEPTED) -> list[str]:
    """hl(动态 P3):每次 no_signal / 没超过 S₀ 的训练也落一份完整 staging(S₀ 本身,只为留记录),
    夜训几周下来副本里就堆满了。只保留最近 keep 份**没被接受**的;被接受 / 采纳过 / 评过留出集的一律不动,
    有留出集评估排着队的(`release.pending`,入队时由 serve 写)也不动。"""
    root = Path(staging_root)
    if not root.is_dir():
        return []
    cands = []
    for d in sorted(root.iterdir()):
        if not d.is_dir() or not (d / "manifest.json").exists():
            continue
        try:
            man = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if man.get("accepted") or (d / "adopted.json").exists() or (d / "release.json").exists() \
                or (d / CLAIM).exists() or (d / "backup").exists() or (d / "release.pending").exists():
            continue
        cands.append(d)
    gone = []
    for d in cands[:-keep] if keep > 0 else cands:
        shutil.rmtree(d, ignore_errors=True)
        gone.append(d.name)
    return gone


def latest(staging_root: Path) -> Path | None:
    root = Path(staging_root)
    if not root.is_dir():
        return None
    cands = [d for d in sorted(root.iterdir())
             if d.is_dir() and (d / "manifest.json").exists()]
    return cands[-1] if cands else None


def adopt(staging_dir: Path, *, force: bool = False, require_release: bool = False,
          allow_unreleased: bool = False, release_record: dict | None = None) -> list[str]:
    """Copy a staged proposal over the live skill, after backing it up.

    Refuses when a live file changed since staging: that means a human edited the
    skill while the loop ran, and overwriting would discard their work.
    """
    staging_dir = Path(staging_dir)
    mpath = staging_dir / "manifest.json"
    if not mpath.exists():
        raise StagingError(f"no manifest in {staging_dir}")
    man = Manifest.from_dict(json.loads(mpath.read_text(encoding="utf-8")))
    if man.schema != SCHEMA:
        raise StagingError(f"unknown manifest schema {man.schema!r}")

    live = Path(man.live_root)
    if not live.is_dir():
        raise StagingError(f"live root missing: {live}")
    # manifest.json 躺在副本的 .evo/staging/ 下,副本里的代码(测试)写得到它:
    # live_root 必须就是这份 staging 所属的副本,rel 必须是干净的相对路径
    expected_live = staging_dir.resolve().parent.parent.parent   # <copy>/.evo/staging/<sid>
    if live.resolve() != expected_live:
        raise StagingError(f"manifest live_root {live} is not this staging's skill copy")
    for f in man.files:
        _check_rel(f.rel)
    files = _skill_files(man)
    if require_release and not allow_unreleased:
        # ha S3-04 release-once:留出集(test)只在"打算发布这一份"时看一次;没看过就采纳 =
        # 没有独立证据说它更好。**与 force 分开**:force 管"未被接受 / 副本被人改过",
        # 跳过留出集是另一个显式开关(allow_unreleased),不能顺手把 drift 检查也关了。
        rec = release_record
        if rec is None and (staging_dir / "release.json").exists():
            try:
                rec = json.loads((staging_dir / "release.json").read_text(encoding="utf-8"))
            except ValueError:
                rec = None
        if not isinstance(rec, dict) or rec.get("missing"):
            raise StagingError("no release evaluation on the test split for this staging yet — "
                               "run `whet release-eval` once (or --no-release to adopt without it)")
        want = rec.get("candidate_bundle_hash")
        if want and want != bundle_hash(staging_dir / "proposed"):
            raise StagingError("the proposed files changed after the release evaluation — re-stage instead")
    if not man.accepted and not force:
        # A round that did not beat S0 stages S0 itself, for the record. Adopting
        # it would overwrite whatever the live skill has become since (audit B3).
        raise StagingError("this round was NOT accepted (no improvement over S0); "
                           "nothing to adopt — use --force to overwrite anyway")

    # Order matters: adopting rewrites the live files, so a second adopt would
    # see its own success as drift. Check "already adopted" first.
    backup = staging_dir / "backup"
    if backup.exists():
        raise StagingError("a backup already exists; this round was adopted before")

    drift = [
        f.rel for f in files
        if (sha256_file(live / f.rel) if (live / f.rel).exists() else "") != f.live_sha256
    ]
    if drift and not force:
        raise StagingError(
            "live skill changed since staging: " + ", ".join(drift[:5])
            + " — discard this round and re-run rather than overwriting"
        )
    backup.mkdir(parents=True)

    journal = staging_dir / ".adopt-transaction.json"
    journal.write_text(json.dumps({"started": time.time(),
                                   "files": [f.rel for f in files]}),
                       encoding="utf-8")
    os.chmod(journal, 0o600)

    written: list[str] = []
    for f in files:
        src, dst = staging_dir / "proposed" / f.rel, live / f.rel
        if sha256_file(src) != f.sha256:
            raise StagingError(f"staged file {f.rel} does not match its pin")
        if dst.exists():
            b = backup / f.rel
            b.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dst, b)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        written.append(f.rel)

    (staging_dir / "adopted.json").write_text(
        json.dumps({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "at_ns": time.time_ns(),
                    "files": written,
                    # hb:副本采纳后的内容指纹 —— "能不能发布"看副本是不是还是某次采纳的结果,
                    # 不再只看"最新那份 staging 采纳了没"
                    "copy_hash": bundle_hash(live)}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    journal.unlink()      # removing the journal is the commit point

    # The adopted skill is the new S0. Without this the next `train` paired the
    # live skill's score with the OLD baseline directory and a no-improvement
    # run staged — and could adopt — the old S0 over the repaired skill (audit B3).
    _refresh_baseline(live)
    return written


def _refresh_baseline(live: Path) -> None:
    from .contract import load_contract
    from .edits import snapshot
    from .ledger import Ledger
    evo = live / ".evo"
    if not evo.is_dir():
        return
    snapshot(live, evo / "baseline")
    try:
        Ledger.capture(live, load_contract(live)).save(evo / "ledger.yaml")
    except Exception:  # noqa: BLE001 - a ledger failure must not undo an adopt
        pass
    for stale in ("current", "prev"):
        d = evo / stale
        if d.is_dir():
            shutil.rmtree(d, ignore_errors=True)


def render_report(report: dict, accepted: bool) -> str:
    lines = [
        f"# SkillWhet round report — {'ACCEPTED' if accepted else 'NOT ACCEPTED'}",
        "",
        "| metric | value |", "|---|---|",
    ]
    for k in ("round", "baseline_score", "candidate_score", "bloat_ratio",
              "accepted_bundles", "rejected_bundles", "llm_calls"):
        if k in report:
            lines.append(f"| {k} | {report[k]} |")
    if report.get("gate"):
        lines += ["", "## Gate", "", "```", str(report["gate"].get("formula", "")), "```"]
    if report.get("edits"):
        lines += ["", "## Accepted edits", ""]
        for e in report["edits"]:
            lines.append(f"- `{e.get('origin','?')}` {e.get('what','')} — "
                         f"{e.get('rationale','')}")
    if report.get("violations"):
        lines += ["", "## Governance violations", ""]
        for v in report["violations"]:
            lines.append(f"- **{v.get('kind')}** `{v.get('key')}` — {v.get('message')}")
    lines += ["", "> Nothing above has been written to the live skill. "
                  "Run `whet adopt` to apply it."]
    return "\n".join(lines) + "\n"


# ── release-once (ha S3-04) ────────────────────────────────────────────────
#
# 训练时不看 test;一份 staging 打算发布时,对 S₀ 与候选各跑一次 test,结果写进
# `staging/<sid>/release.json`,并记进副本的 `.evo/test_consumed.json`。同一份
# staging 第二次评 test 被拒 —— 反复看 test 挑最好的那份,test 就成了第二个 val。

CONSUMED = "test_consumed.json"


def consumed_ledger(copy_dir: Path) -> dict:
    p = Path(copy_dir) / ".evo" / CONSUMED
    if not p.exists():
        return {}
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except ValueError:
        return {}


CLAIM = "release.claim"


def release_consumed(copy_dir: Path, staging_dir: Path) -> bool:
    staging_dir = Path(staging_dir)
    return (staging_dir.name in consumed_ledger(copy_dir) or (staging_dir / "release.json").exists()
            or (staging_dir / CLAIM).exists())


def claim_release(copy_dir: Path, staging_dir: Path, test_set_hash: str) -> None:
    """**开跑之前**原子地占住这份 staging 的那一次 test —— 跑到一半取消 / 崩溃也算用掉了
    (分数已经在进度里露过面)。两个并发的 release-eval 只有一个拿得到。"""
    staging_dir = Path(staging_dir)
    if release_consumed(copy_dir, staging_dir):
        raise StagingError(f"test split already consumed for staging {staging_dir.name}")
    try:
        fd = os.open(staging_dir / CLAIM, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError as exc:
        raise StagingError(f"test split already consumed for staging {staging_dir.name}") from exc
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "test_set_hash": test_set_hash}, fh)
    ledger = consumed_ledger(copy_dir)
    ledger[staging_dir.name] = {"claimed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                                "test_set_hash": test_set_hash}
    _write_ledger(copy_dir, ledger)


def looks_on_test_set(copy_dir: Path, test_set_hash: str) -> int:
    """同一套 test 已经被看过几次(跨 staging)。反复训练 → 新 staging → 再评 test,
    挑最好的那次,test 就退化成了第二个 val;这个数给人看,让它显眼。"""
    return sum(1 for v in consumed_ledger(copy_dir).values()
               if isinstance(v, dict) and v.get("test_set_hash") == test_set_hash)


def _write_ledger(copy_dir: Path, ledger: dict) -> None:
    lp = Path(copy_dir) / ".evo" / CONSUMED
    lp.parent.mkdir(parents=True, exist_ok=True)
    tmp = lp.with_suffix(".tmp")
    tmp.write_text(json.dumps(ledger, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, lp)


def record_release(copy_dir: Path, staging_dir: Path, result: dict) -> dict:
    staging_dir = Path(staging_dir)
    if (staging_dir / "release.json").exists():
        raise StagingError(f"test split already consumed for staging {staging_dir.name}")
    rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **result}
    tmp = staging_dir / "release.json.tmp"
    tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, staging_dir / "release.json")
    ledger = consumed_ledger(copy_dir)
    ledger[staging_dir.name] = {**(ledger.get(staging_dir.name) or {}), "at": rec["at"],
                                "test_tasks": result.get("test_tasks"), "test_set_hash": result.get("test_set_hash"),
                                "baseline": result.get("baseline"), "candidate": result.get("candidate")}
    _write_ledger(copy_dir, ledger)
    return rec
