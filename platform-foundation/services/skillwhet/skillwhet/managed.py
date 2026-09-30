"""Managed skill copies — the working trees ``whet serve`` trains on.

A managed copy lives under ``<home>/work/<name>/``. It is either an import of a
live skill directory (``~/.claude/skills/<name>/``) or an upload. Training only
ever touches the copy; the live directory is replaced by the platform's own
"publish" step, never by us.

Why a copy at all: ``.evo/`` (baseline, staging, wiki …) contains SKILL.md
files of its own, and both the CLI and the platform discover skills by walking
directories — an ``.evo/`` grown inside a live skill can be loaded as a skill.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .fs import iter_skill_files

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
MAX_FILES = 500
MAX_BYTES = 30 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024 * 1024


class ManagedError(ValueError):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.status = code, status


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def validate_name(name: str) -> str:
    if not isinstance(name, str) or not NAME_RE.match(name) or name in (".", ".."):
        raise ManagedError("BAD_NAME", f"invalid skill name: {name!r}")
    return name


def skill_md_name(text: str) -> str | None:
    """``name:`` from SKILL.md frontmatter, if any."""
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    for line in text[3:end].splitlines():
        m = re.match(r"^\s*name\s*:\s*(.+?)\s*$", line)
        if m:
            return m.group(1).strip().strip("'\"")
    return None


@dataclass
class ImportRecord:
    name: str
    source: str                      # "live" | "upload"
    imported_from: str = ""          # live dir, or "" for uploads
    imported_at: str = ""
    uploaded_by: str = ""
    files: dict[str, str] = field(default_factory=dict)   # rel → sha256 at import time
    python_files: int = 0
    has_unit_tests: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


def load_record_key(home: Path) -> tuple[bytes, bool]:
    """权威记录的签名密钥:``<home>/records/.key``,32 字节随机数,0600,首次用时原子创建。
    返回 (密钥, 是否本次新建)。

    hl 复核:原先由 SKILLWHET_TOKEN 派生 —— 但 Prism 没配 PRISM_SKILLWHET_TOKEN 时**每次启动随机生成口令**,
    重启后所有记录验签失败、技能全部消失。密钥必须与口令无关、跨重启稳定。
    威胁模型说明:同一系统用户下,副本里的代码理论上读得到这个文件(与读 /proc/<serve>/environ 同级,
    没有文件系统隔离时防不住);签名防的是「绕过 serve 直接改记录」的随手篡改,不是隔离边界。"""
    records = Path(home) / "records"
    records.mkdir(parents=True, exist_ok=True)
    path = records / ".key"
    for _ in range(3):
        try:
            key = path.read_bytes()
            if len(key) == 32:
                return key, False
            # 长度不对:坏文件(半截写入等),挪开重建
            os.replace(path, records / f".key.bad-{int(time.time())}")
        except FileNotFoundError:
            pass
        tmp = records / f".key.tmp-{os.getpid()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, os.urandom(32))
            os.fsync(fd)
        finally:
            os.close(fd)
        try:
            os.link(tmp, path)          # 原子且不覆盖:并发起两个 serve 时只有一个的密钥生效
            os.unlink(tmp)
            return path.read_bytes(), True
        except FileExistsError:
            os.unlink(tmp)              # 别人先建好了,回头读它的
    raise ManagedError("RECORD_KEY", f"cannot establish record key at {path}", 500)


class ManagedStore:
    """受管副本 + 它们的**权威记录**。

    hl(静态 P1-11 / 复核 P2-1、P2-3):`import.json`(来源 / 上传者 / 逐文件 sha)是 Prism 判
    「谁能动这份副本」的唯一依据。原来它只躺在副本工作树里,副本里的测试代码能改自己的、也能改
    同级副本 `../b/import.json` 的;快照-恢复式的保护又会把 serve 自己在作业期间的合法写入(发布
    rebase、从技能库更新)当篡改改回去。现在:

      * 权威记录在工作树**外** `<home>/records/<name>.json`,serve 进程内另有一份内存副本(`_cache`);
        每次 serve 自己写记录(导入 / 上传 / rebase)同时更新内存、权威文件与工作树里的镜像 `import.json`;
      * 给了 `key`(serve 用口令派生,子进程环境里不带口令)就给记录签名 —— 重启后从磁盘加载时验签,
        副本代码伪造不出能过验签的记录;
      * `resync()` 以内存(最新一次 serve 写入)为准把权威文件与所有镜像改回来,返回被动过的名字 ——
        每次体检 / 作业结束、serve 启动(recover)与停机时各做一次,覆盖同级副本;
      * 旧 home 升级:没有权威记录、只有工作树里 `import.json` 的,首次启动时迁移过来。
    """

    def __init__(self, home: Path, *, key: bytes | None = None, rekey: bool = False) -> None:
        self.home = Path(home)
        self.work = self.home / "work"
        self.removed = self.home / "_removed"
        self.records = self.home / "records"
        self.work.mkdir(parents=True, exist_ok=True)
        self.records.mkdir(parents=True, exist_ok=True)
        self._key = key
        self._cache: dict[str, dict] = {}
        self._tampered_at_load: set[str] = set()
        if rekey:
            self._rekey()
        self._migrate()

    # ── paths ────────────────────────────────────────────────────────────
    def dir(self, name: str) -> Path:
        return self.work / validate_name(name)

    def record_path(self, name: str) -> Path:
        """工作树里的镜像(给人看、给老工具兼容);**不是**权威。"""
        return self.dir(name) / "import.json"

    def authority_path(self, name: str) -> Path:
        return self.records / f"{validate_name(name)}.json"

    def exists(self, name: str) -> bool:
        validate_name(name)
        return name in self._cache or self.authority_path(name).exists()

    def record_data(self, name: str) -> dict:
        validate_name(name)
        if name in self._cache:
            return dict(self._cache[name])
        data = self._load(name)
        if data is None:
            if name in self._tampered_at_load:
                raise ManagedError("RECORD_TAMPERED", f"the managed record of {name!r} failed verification — "
                                   "remove the copy and import / upload it again", 409)
            raise ManagedError("NOT_MANAGED", f"no managed copy of {name!r}", 404)
        self._cache[name] = data
        return dict(data)

    def record(self, name: str) -> ImportRecord:
        d = self.record_data(name)
        return ImportRecord(**{k: v for k, v in d.items() if k in ImportRecord.__dataclass_fields__})

    # ── 权威记录:签名 / 读 / 写 / 校正 ──────────────────────────────────
    def _sig(self, data: dict) -> str:
        blob = json.dumps({k: v for k, v in data.items() if k != "sig"}, sort_keys=True, ensure_ascii=False)
        return hmac.new(self._key or b"", blob.encode("utf-8"), hashlib.sha256).hexdigest()

    def _valid(self, name: str, data: object) -> bool:
        if not isinstance(data, dict) or data.get("name") != name:
            return False
        return self._key is None or hmac.compare_digest(str(data.get("sig") or ""), self._sig(data))

    def _load(self, name: str) -> dict | None:
        """磁盘上的权威记录(验签);权威坏了但镜像验签通过就用镜像(两份都被改才判篡改)。"""
        for p in (self.authority_path(name), self.record_path(name)):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if self._valid(name, data):
                return {k: v for k, v in data.items() if k != "sig"}
            self._tampered_at_load.add(name)
        return None

    def _payload(self, data: dict) -> bytes:
        body = dict(data)
        if self._key is not None:
            body["sig"] = self._sig(body)
        return json.dumps(body, ensure_ascii=False, indent=2).encode("utf-8")

    @staticmethod
    def _atomic_write(p: Path, data: bytes) -> None:
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)

    def _store(self, name: str, data: dict) -> None:
        data = {k: v for k, v in data.items() if k != "sig"}
        self._cache[name] = data
        self._tampered_at_load.discard(name)
        payload = self._payload(data)
        self._atomic_write(self.authority_path(name), payload)
        if self.dir(name).is_dir():
            self._atomic_write(self.record_path(name), payload)

    def _rekey(self) -> None:
        """签名密钥是新生成的(首次启动,或密钥文件丢了):已有的权威记录按原内容用新密钥重签。
        取工作树**外**的权威文件(副本代码够不着的那份优先),没有才退回镜像;记一条告警由调用方打印。"""
        self.rekeyed: list[str] = []
        for p in sorted(self.records.glob("*.json")):
            name = p.stem
            if not NAME_RE.match(name):
                continue
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and data.get("name") == name:
                self._store(name, data)
                self.rekeyed.append(name)

    def _migrate(self) -> None:
        """旧 home(0.5.1 及以前)只有工作树里的 import.json:首次启动时把它收成权威记录并签名。"""
        for d in sorted(self.work.iterdir()) if self.work.is_dir() else []:
            if not d.is_dir() or not NAME_RE.match(d.name) or self.authority_path(d.name).exists():
                continue
            try:
                data = json.loads((d / "import.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            if isinstance(data, dict) and data.get("name", d.name) == d.name:
                data["name"] = d.name
                self._store(d.name, data)

    def resync(self) -> list[str]:
        """以 serve 自己最近一次写入(内存)为准,把权威文件与副本里的镜像改回来;返回被动过的名字。
        没进过内存的(还没被读过的)先从磁盘加载验签 —— 验签不过的记下,等人处理。"""
        names = {p.stem for p in self.records.glob("*.json") if NAME_RE.match(p.stem)} | set(self._cache)
        touched: list[str] = []
        for name in sorted(names):
            try:
                want = self.record_data(name)
            except ManagedError:
                touched.append(name)
                continue
            payload = self._payload(want)
            changed = False
            targets = [self.authority_path(name)] + ([self.record_path(name)] if self.dir(name).is_dir() else [])
            for p in targets:
                try:
                    same = p.read_bytes() == payload
                except OSError:
                    same = False
                if not same:
                    changed = True
                    self._atomic_write(p, payload)
            if changed:
                touched.append(name)
        return touched

    # ── listing ─────────────────────────────────────────────────────────
    def list(self) -> list[dict]:
        out = []
        for p in sorted(self.records.glob("*.json")):
            name = p.stem
            if not NAME_RE.match(name) or not self.dir(name).is_dir():
                continue
            try:
                out.append(self.status(name))
            except ManagedError:
                continue          # 验签不过的不出现在列表里(单查回 409 RECORD_TAMPERED)
        return out

    def status(self, name: str) -> dict:
        d = self.dir(name)
        rec = self.record(name)
        evo = d / ".evo"
        staging_root = evo / "staging"
        stagings = sorted(x.name for x in staging_root.iterdir()) if staging_root.is_dir() else []
        latest = staging_root / stagings[-1] if stagings else None
        wiki = evo / "wiki" / "patterns"
        prov = evo / "provenance.jsonl"
        contract = d / "CONTRACT.yaml"
        gate_cache = evo / "gate.json"
        adopted_sid = self.current_adoption(name)
        return {
            "name": name,
            "source": rec.source,
            "imported_from": rec.imported_from,
            "imported_at": rec.imported_at,
            "uploaded_by": rec.uploaded_by,
            "file_count": len(rec.files),
            "python_files": rec.python_files,
            "has_unit_tests": rec.has_unit_tests,
            "has_holdout_tests": (d / "tests" / "holdout").is_dir(),
            "has_contract": contract.exists(),
            "bootstrapped": (evo / "baseline").exists(),
            "latest_staging": latest.name if latest else None,
            "staging_count": len(stagings),
            "adopted": adopted_sid is not None,
            # hd:副本当前内容来自哪份 staging(发布记录、版本页"已发布"标记都按它)
            "adopted_staging": adopted_sid,
            "wiki_patterns": len(list(wiki.glob("*.md"))) if wiki.is_dir() else 0,
            "provenance_records": sum(1 for _ in prov.read_text(encoding="utf-8").splitlines()) if prov.exists() else 0,
            "last_gate": json.loads(gate_cache.read_text(encoding="utf-8")) if gate_cache.exists() else None,
        }

    def current_adoption(self, name: str) -> str | None:
        """副本当前内容来自哪一份 staging 的采纳(最近一次采纳且副本没被改过);没有就 None。"""
        d = self.dir(name)
        root = d / ".evo" / "staging"
        stagings = sorted(x.name for x in root.iterdir()) if root.is_dir() else []
        last = self._last_adoption(d, stagings)
        if last is None:
            return None
        sid, info = last
        if info.get("copy_hash"):
            from .staging import bundle_hash
            return sid if bundle_hash(d) == info["copy_hash"] else None
        return sid if stagings and stagings[-1] == sid else None

    @staticmethod
    def _last_adoption(d: Path, stagings: list[str]) -> tuple[str, dict] | None:
        root = d / ".evo" / "staging"
        found = []
        for sid in stagings:
            p = root / sid / "adopted.json"
            if not p.exists():
                continue
            try:
                info = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                info = {}
            found.append((int(info.get("at_ns") or 0), str(info.get("at") or ""), sid, info))
        if not found:
            return None
        best = max(found)
        return best[2], best[3]

    # ── import from a live directory ────────────────────────────────────
    def import_live(self, name: str, live_dir: Path, *, replace: bool = False) -> ImportRecord:
        validate_name(name)
        live = Path(live_dir)
        if not live.is_dir():
            raise ManagedError("LIVE_MISSING", f"live skill directory not found: {live}")
        if (live / ".evo").exists():
            raise ManagedError("LIVE_HAS_EVO",
                               f"{live} already contains .evo/ — a training state inside a live "
                               f"skill would be discovered as a skill; move it out first")
        if not (live / "SKILL.md").exists():
            raise ManagedError("NO_SKILL_MD", f"{live} has no SKILL.md")
        dest = self.dir(name)
        if dest.exists() and not replace:
            raise ManagedError("ALREADY_MANAGED", f"{name!r} already has a managed copy", 409)
        if dest.exists():
            self._retire(name)
        shutil.copytree(live, dest, ignore=shutil.ignore_patterns(".evo", "__pycache__", "*.pyc"),
                        symlinks=False)
        return self._write_record(name, "live", imported_from=str(live.resolve()))

    # ── upload ──────────────────────────────────────────────────────────
    def import_upload(self, name: str, files: list[dict], *, uploaded_by: str = "") -> ImportRecord:
        """``files``: ``[{"rel": "SKILL.md", "content": "…"} | {"rel": …, "content_b64": "…"}]``."""
        import base64
        validate_name(name)
        if not isinstance(files, list) or not files:
            raise ManagedError("NO_FILES", "upload has no files")
        if len(files) > MAX_FILES:
            raise ManagedError("TOO_MANY_FILES", f"a skill folder can contain up to {MAX_FILES} files")
        dest = self.dir(name)
        if dest.exists():
            raise ManagedError("ALREADY_MANAGED", f"{name!r} already has a managed copy — remove it first", 409)
        decoded: list[tuple[str, bytes]] = []
        total = 0
        seen: set[str] = set()
        for f in files:
            rel = f.get("rel") if isinstance(f, dict) else None
            if not isinstance(rel, str) or not rel:
                raise ManagedError("BAD_PATH", "every file needs a relative path")
            norm = rel.replace("\\", "/")
            parts = norm.split("/")
            if norm.startswith("/") or any(p in ("", ".", "..") for p in parts):
                raise ManagedError("BAD_PATH", f"refusing path {rel!r}")
            if parts[0] == ".evo":
                raise ManagedError("HAS_EVO", "upload must not contain .evo/")
            if norm in seen:
                raise ManagedError("DUP_PATH", f"duplicate path {rel!r}")
            seen.add(norm)
            if "content_b64" in f:
                try:
                    data = base64.b64decode(f["content_b64"], validate=True)
                except Exception as exc:  # noqa: BLE001
                    raise ManagedError("BAD_B64", f"{rel}: invalid base64") from exc
            else:
                content = f.get("content", "")
                if not isinstance(content, str):
                    raise ManagedError("BAD_CONTENT", f"{rel}: content must be a string")
                data = content.encode("utf-8")
            if len(data) > MAX_FILE_BYTES:
                raise ManagedError("FILE_TOO_BIG", f"{rel}: over {MAX_FILE_BYTES // (1024 * 1024)} MiB")
            total += len(data)
            if total > MAX_BYTES:
                raise ManagedError("TOO_BIG", f"upload exceeds {MAX_BYTES // (1024 * 1024)} MiB")
            decoded.append((norm, data))
        if "SKILL.md" not in seen:
            raise ManagedError("NO_SKILL_MD", "upload has no SKILL.md at its root")
        skill_md = next(d for r, d in decoded if r == "SKILL.md").decode("utf-8", "replace")
        declared = skill_md_name(skill_md)
        if declared and declared != name:
            raise ManagedError("NAME_MISMATCH",
                               f"SKILL.md declares name {declared!r} but the folder is {name!r}")
        try:
            dest.mkdir(parents=True)
        except FileExistsError:
            raise ManagedError("ALREADY_MANAGED", f"{name!r} already has a managed copy — remove it first", 409) from None
        try:
            for rel, data in decoded:
                p = dest / rel
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_bytes(data)
        except Exception:
            shutil.rmtree(dest, ignore_errors=True)
            raise
        return self._write_record(name, "upload", uploaded_by=uploaded_by)

    # ── removal (never delete: move aside) ──────────────────────────────
    def remove(self, name: str) -> str:
        if not self.exists(name) and name not in self._tampered_at_load:
            raise ManagedError("NOT_MANAGED", f"no managed copy of {name!r}", 404)
        return self._retire(name)

    def _retire(self, name: str) -> str:
        self.removed.mkdir(parents=True, exist_ok=True)
        target = self.removed / f"{name}-{time.strftime('%Y%m%d-%H%M%S', time.gmtime())}"
        n = 2
        while target.exists():
            target = target.with_name(f"{target.name}-{n}")
            n += 1
        shutil.move(str(self.dir(name)), str(target))
        # 权威记录随副本退场(留一份在退役目录旁边,便于追查)
        auth = self.authority_path(name)
        if auth.exists():
            shutil.move(str(auth), str(target) + ".record.json")
        self._cache.pop(name, None)
        self._tampered_at_load.discard(name)
        return str(target)

    # ── record ──────────────────────────────────────────────────────────
    def _write_record(self, name: str, source: str, *, imported_from: str = "",
                      uploaded_by: str = "", imported_at: str = "", extra: dict | None = None) -> ImportRecord:
        d = self.dir(name)
        files = {}
        py = 0
        for p in iter_skill_files(d):
            rel = p.relative_to(d).as_posix()
            if rel == "import.json":
                continue
            files[rel] = sha256_file(p)
            if rel.endswith(".py"):
                py += 1
        rec = ImportRecord(name=name, source=source, imported_from=imported_from,
                           imported_at=imported_at or _now(), uploaded_by=uploaded_by, files=files,
                           python_files=py, has_unit_tests=(d / "tests" / "unit").is_dir())
        self._store(name, {**(extra or {}), **rec.to_dict()})
        return rec

    def rebase(self, name: str, *, live_dir: Path | None = None) -> ImportRecord:
        """After the platform published (or rolled back) the live tree: re-pin the per-file
        shas **from the live side** (and, for an upload published as a new skill, remember
        where its live side lives). ``.evo/`` is untouched.

        hb:原来从副本算 sha —— 发布时副本 = live 没问题;但回滚后 live 回到旧版、副本没动,
        钉进去的是副本的 sha,马上就报"技能库被改过"(CONTRACT.yaml 等),再也发布不了。
        """
        rec = self.record(name)
        imported_from = str(Path(live_dir).resolve()) if live_dir else rec.imported_from
        live = Path(imported_from) if imported_from else None
        extra: dict = {}
        if live is not None and live.is_dir():
            extra = {"live_files": {p.relative_to(live).as_posix(): sha256_file(p) for p in iter_skill_files(live)
                                    if p.relative_to(live).as_posix() != "import.json"},
                     "rebased_at": _now()}
        return self._write_record(name, rec.source, imported_from=imported_from, uploaded_by=rec.uploaded_by,
                                  imported_at=rec.imported_at, extra=extra)

    def live_drift(self, name: str) -> list[str]:
        """Files whose live copy no longer matches the import-time sha (for the platform's publish check)."""
        rec = self.record(name)
        if not rec.imported_from:          # uploads have no live side until published-as-new
            return []
        live = Path(rec.imported_from)
        drift = []
        raw = self.record_data(name)
        pins = raw.get("live_files") if isinstance(raw.get("live_files"), dict) else rec.files
        for rel, sha in pins.items():
            p = live / rel
            if not p.exists() or sha256_file(p) != sha:
                drift.append(rel)
        return drift

