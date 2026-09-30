"""Counterfactual attribution over prose sections (REVIEW §1.5 / §1.7).

The evaluator that labels a failure "doc_defect" sees an answer, not the
prose that produced it. This module asks the only question that settles it:
does the outcome change when a section is removed?

  * a FAILING task that passes without section S  → S is harmful for it
  * a PASSING task that fails without section S   → S is load-bearing for it

Costs one roll-out per (task, section), so it is budgeted and off by
default; with a pytest runner prose has no effect and it is skipped.
"""
from __future__ import annotations

import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .edits import snapshot
from .evidence import ExecRecord, TaskRecord
from .fs import iter_skill_files

_HEADING = re.compile(r"^(#{1,6})\s+(.+?)\s*$", re.MULTILINE)


@dataclass
class Section:
    file: str            # relative path
    heading: str
    start: int           # char offsets in the file
    end: int

    @property
    def anchor(self) -> str:
        return f"{self.file}#{self.heading}"


def sections_of(skill_dir: Path) -> list[Section]:
    out: list[Section] = []
    for p in iter_skill_files(skill_dir, (".md",)):
        rel = p.relative_to(Path(skill_dir)).as_posix()
        text = p.read_text(encoding="utf-8")
        heads = list(_HEADING.finditer(text))
        for i, m in enumerate(heads):
            end = heads[i + 1].start() if i + 1 < len(heads) else len(text)
            out.append(Section(rel, m.group(2), m.start(), end))
    return out


@dataclass
class SectionEffect:
    anchor: str
    helpful: list[str] = field(default_factory=list)     # tasks that need it
    harmful: list[str] = field(default_factory=list)     # tasks that pass without it

    def to_dict(self) -> dict:
        return {"anchor": self.anchor, "helpful": self.helpful, "harmful": self.harmful}


def _without(skill_dir: Path, sec: Section, work: Path) -> Path:
    cand = snapshot(skill_dir, work)
    p = cand / sec.file
    text = p.read_text(encoding="utf-8")
    p.write_text(text[:sec.start] + text[sec.end:], encoding="utf-8")
    return cand


def section_effects(
    skill_dir: Path,
    tasks: list[TaskRecord],
    records: list[ExecRecord],
    runner,
    *,
    budget: int = 12,
    work_root: Path | None = None,
    only_sections: list[str] | None = None,
    confirm: bool = True,
) -> tuple[dict[str, SectionEffect], int]:
    """Per-section helpful/harmful task lists. Returns (effects, runs used).

    ``confirm``: a HARMFUL verdict (failing task passes without the section)
    is re-run once and kept only if it reproduces. The first real run marked
    the `extract_tables` section harmful for a whitespace question it had
    nothing to do with — one noisy roll-out — and that would have become a
    doc_defect signal telling the slow loop to rewrite a correct section.
    """
    if getattr(runner, "name", "") == "pytest":
        return {}, 0
    skill_dir = Path(skill_dir)
    work_root = Path(work_root or skill_dir / ".evo" / "work")
    outcome = {r.task_id: r for r in records if r.scored}
    secs = [s for s in sections_of(skill_dir)
            if only_sections is None or s.anchor in only_sections]
    effects = {s.anchor: SectionEffect(s.anchor) for s in secs}
    runs = 0
    # failing tasks first: a harmful section is the actionable finding
    ordered = sorted((t for t in tasks if t.id in outcome),
                     key=lambda t: (outcome[t.id].passed, t.id))
    for sec in secs:
        if runs >= budget:
            break
        work = work_root / f"cf-{abs(hash(sec.anchor)) % 10**8}"
        try:
            cand = _without(skill_dir, sec, work)
            batch = [t for t in ordered if runs + 1 <= budget]
            if not batch:
                break
            batch = batch[:max(1, budget - runs)]
            recs = {r.task_id: r for r in runner.run(cand, batch)}
            runs += len(batch)
            suspects = []
            for t in batch:
                before, after = outcome[t.id], recs.get(t.id)
                if after is None or not after.scored:
                    continue
                if not before.passed and after.passed:
                    suspects.append(t)
                elif before.passed and not after.passed:
                    effects[sec.anchor].helpful.append(t.id)
            if suspects and confirm and runs + len(suspects) <= budget:
                again = {r.task_id: r for r in runner.run(cand, suspects)}
                runs += len(suspects)
                suspects = [t for t in suspects
                            if again.get(t.id) is not None and again[t.id].scored and again[t.id].passed]
            elif suspects and confirm:
                suspects = []                       # unconfirmed within budget: not a finding
            effects[sec.anchor].harmful.extend(t.id for t in suspects)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    return {k: v for k, v in effects.items() if v.helpful or v.harmful}, runs
