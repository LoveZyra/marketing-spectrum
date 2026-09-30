"""Preserve Ledger — an explicit, typed record of what must not break.

SkillRevise (2606.01139) measures this: removing the preserve ledger costs
-12.79% on SkillsBench. SkillOpt protects passing behaviour only implicitly,
through the aggregate held-out score, which cannot say *what* was lost.

Entries are facts about the skill that a later round is forbidden to destroy:
tests that pass today, entrypoints that exist today, concrete values in the
prose (versions, limits, links) that must not decay into "see the docs".
"""
from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path

import yaml

from .fs import iter_skill_files
from .contract import iter_scripts, module_key
from .types import Contract

# Concrete values whose disappearance is knowledge loss, not concision.
_VALUE_PATTERNS = [
    (re.compile(r"https?://\S+"), "url"),
    (re.compile(r"\bv?\d+\.\d+(?:\.\d+)?\b"), "version"),
    (re.compile(r"\b\d+\s?(?:GB|MB|KB|TB|ms|s|分钟|小时|天)\b", re.I), "quantity"),
    (re.compile(r"[$€£¥]\s?\d[\d,.]*"), "money"),
    # A constant looks like MAX_PAGES or HTTP2, not like an emphasised English
    # word: "keeping the LAST occurrence" put LAST in the ledger, and the doc
    # fix that changed it to FIRST was blocked as knowledge loss (benchmark
    # case tn-doc-wrong). Require an underscore or a digit.
    (re.compile(r"\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b|\b[A-Z]+[0-9]+[A-Z0-9_]*\b"), "constant"),
]


@dataclass
class LedgerEntry:
    kind: str            # test | entrypoint | value
    key: str
    detail: str = ""
    source: str = ""
    retired_by: str = ""  # bundle digest that removed it WITH a measured improvement

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Violation:
    kind: str
    key: str
    message: str
    source: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


class Ledger:
    def __init__(self, entries: list[LedgerEntry] | None = None) -> None:
        self.entries = entries or []

    # -- persistence -------------------------------------------------------
    @classmethod
    def load(cls, path: Path) -> Ledger:
        p = Path(path)
        if not p.exists():
            return cls()
        data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
        return cls([LedgerEntry(**e) for e in data.get("entries", [])])

    def save(self, path: Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(yaml.safe_dump(
            {"entries": [e.to_dict() for e in self.entries]},
            sort_keys=False, allow_unicode=True), encoding="utf-8")
        return p

    # -- construction ------------------------------------------------------
    @classmethod
    def capture(cls, skill_dir: Path, contract: Contract,
                passing_tests: list[str] | None = None) -> Ledger:
        """Snapshot what currently works. Run this on the frozen baseline S0."""
        skill_dir = Path(skill_dir)
        entries: list[LedgerEntry] = []

        for t in passing_tests or []:
            entries.append(LedgerEntry(kind="test", key=t, source="baseline"))

        for e in contract.entrypoints:
            if e.stability in ("stable", "experimental"):
                entries.append(LedgerEntry(
                    kind="entrypoint", key=f"{e.module}::{e.id}",
                    detail=e.signature, source="contract",
                ))

        for md in iter_skill_files(skill_dir, (".md",)):
            rel = md.relative_to(skill_dir).as_posix()
            # hb:只护优化器改得到的文档(SKILL.md、references/*.md);CHANGELOG 之类的版本号
            # 原来全被当成"要保住的值"塞满台账,又永远不会被改到
            if rel != "SKILL.md" and not rel.startswith("references/"):
                continue
            text = md.read_text(encoding="utf-8")
            seen: set[str] = set()
            for rx, label in _VALUE_PATTERNS:
                for m in rx.finditer(text):
                    v = m.group(0)
                    if v in seen or len(v) < 3:
                        continue
                    seen.add(v)
                    entries.append(LedgerEntry(
                        kind="value", key=v, detail=label, source=rel))
        return cls(entries)

    def retire_values(self, keys: list[str], by: str) -> list[str]:
        """Values a MEASURED prose improvement removed stop being violations.

        The ledger protects concrete values against silent over-generalisation;
        it must not protect a wrong value against its correction. Retirement
        requires evidence (the caller passes it only after the doc bundle's own
        val measurement improved) and leaves an audit trail.
        """
        done = []
        for e in self.entries:
            if e.kind == "value" and e.key in keys and not e.retired_by:
                e.retired_by = by
                done.append(e.key)
        return done

    # -- checking ----------------------------------------------------------
    def check(self, skill_dir: Path, contract: Contract,
              passing_tests: list[str] | None = None) -> list[Violation]:
        """What in the ledger is no longer true?"""
        skill_dir = Path(skill_dir)
        out: list[Violation] = []

        now_tests = set(passing_tests or [])
        have_tests = passing_tests is not None
        now_eps = {f"{e.module}::{e.id}" for e in contract.entrypoints}
        prose = "\n".join(
            md.read_text(encoding="utf-8") for md in iter_skill_files(skill_dir, (".md",))
        )
        modules = {module_key(skill_dir, p) for p in iter_scripts(skill_dir)}

        for e in self.entries:
            if e.kind == "test" and have_tests and e.key not in now_tests:
                out.append(Violation("test", e.key,
                                     "a test that passed on the baseline no longer passes",
                                     e.source))
            elif e.kind == "entrypoint" and e.key not in now_eps:
                mod = e.key.split("::")[0]
                if mod in modules:
                    out.append(Violation("entrypoint", e.key,
                                         "entrypoint present on the baseline is gone",
                                         e.source))
            elif e.kind == "value" and not e.retired_by and e.key not in prose:
                out.append(Violation(
                    "value", e.key,
                    f"concrete {e.detail} present on the baseline is gone from the "
                    f"prose — over-generalisation is knowledge loss, not concision",
                    e.source,
                ))
        return out

    def add(self, entry: LedgerEntry) -> None:
        if not any(e.kind == entry.kind and e.key == entry.key for e in self.entries):
            self.entries.append(entry)

    def to_json(self) -> str:
        return json.dumps([e.to_dict() for e in self.entries],
                          ensure_ascii=False, indent=2)

    def __len__(self) -> int:
        return len(self.entries)
