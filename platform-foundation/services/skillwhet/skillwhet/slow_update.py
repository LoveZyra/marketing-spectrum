"""Round-boundary learning: the slow update and the optimizer-side meta skill.

Step-level edits learn from this round's batch. These two learn from ADJACENT
rounds, by running the same tasks under the previous and current skill and
sorting them into improved / regressed / persistent-fail / stable-success.

  * slow update  — writes a short guidance block into a PROTECTED region of
                   SKILL.md that step-level edits cannot touch. Ships with the
                   skill. (SkillOpt §3.6; removing it plus the meta skill cost
                   SpreadsheetBench 22.5 points in their ablation.)
  * meta skill   — optimizer-side memory: which kinds of edits helped or hurt
                   HERE. Prepended to proposer prompts. Never shipped.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .backend import Backend, extract_json
from .evidence import ExecRecord, TaskRecord
from .runner import Runner

SLOW_START = "<!-- SLOW_UPDATE_START -->"
SLOW_END = "<!-- SLOW_UPDATE_END -->"


@dataclass
class Longitudinal:
    improved: list[str] = field(default_factory=list)
    regressed: list[str] = field(default_factory=list)
    persistent_fail: list[str] = field(default_factory=list)
    stable_success: list[str] = field(default_factory=list)
    detail: dict[str, dict] = field(default_factory=dict)

    def counts(self) -> dict[str, int]:
        return {"improved": len(self.improved), "regressed": len(self.regressed),
                "persistent_fail": len(self.persistent_fail),
                "stable_success": len(self.stable_success)}

    def worth_updating(self) -> bool:
        return bool(self.regressed or self.persistent_fail)

    def render(self, limit: int = 8) -> str:
        lines = [f"Adjacent-round comparison on {sum(self.counts().values())} tasks: "
                 f"{self.counts()}"]
        for label, ids in (("REGRESSED", self.regressed),
                           ("PERSISTENT FAILURE", self.persistent_fail),
                           ("IMPROVED", self.improved)):
            for t in ids[:limit]:
                d = self.detail.get(t, {})
                lines.append(f"- [{label}] {t}: {d.get('why', '')[:160]}")
        return "\n".join(lines)


def compare_rounds(
    runner: Runner, prev_dir: Path, curr_dir: Path, tasks: list[TaskRecord],
    *, sample: int = 20, seed: int = 0,
) -> Longitudinal:
    """Same tasks, two skill versions. Deterministic; the only cost is two runs."""
    import random
    picked = list(tasks)
    if len(picked) > sample:
        random.Random(seed).shuffle(picked)
        picked = picked[:sample]
    prev = {r.task_id: r for r in runner.run(prev_dir, picked)}
    curr = {r.task_id: r for r in runner.run(curr_dir, picked)}

    lon = Longitudinal()
    for t in picked:
        p, c = prev.get(t.id), curr.get(t.id)
        pp, cp = bool(p and p.passed), bool(c and c.passed)
        why = (c.exc_message or c.exc_type) if c else ""
        lon.detail[t.id] = {"prev": pp, "curr": cp, "why": why}
        if pp and not cp:
            lon.regressed.append(t.id)
        elif not pp and cp:
            lon.improved.append(t.id)
        elif not pp and not cp:
            lon.persistent_fail.append(t.id)
        else:
            lon.stable_success.append(t.id)
    return lon


# ── protected region I/O ────────────────────────────────────────────────────

_BLOCK = re.compile(re.escape(SLOW_START) + r"(?P<body>.*?)" + re.escape(SLOW_END), re.DOTALL)


def _well_formed(skill_md: str) -> bool:
    """Exactly one START, exactly one END, START before END."""
    return (skill_md.count(SLOW_START) == 1 and skill_md.count(SLOW_END) == 1
            and skill_md.find(SLOW_START) < skill_md.find(SLOW_END))


def _strip_markers(skill_md: str) -> tuple[str, str]:
    """Remove every block/orphan marker; return (clean text, salvaged guidance).

    Salvaged = the body of the FIRST well-paired block, if any. Orphan markers
    (an END with no START, a START with no END) are dropped rather than paired
    with a distant partner — that pairing is how a previous round deleted the
    skill body between them (audit C15).
    """
    m = _BLOCK.search(skill_md)
    salvaged = m.group("body").strip() if m else ""
    text = _BLOCK.sub("", skill_md)
    text = text.replace(SLOW_START, "").replace(SLOW_END, "")
    return re.sub(r"\n{3,}", "\n\n", text).rstrip() + "\n", salvaged


def read_slow_field(skill_md: str) -> str:
    if not _well_formed(skill_md):
        return _strip_markers(skill_md)[1]
    m = _BLOCK.search(skill_md)
    return m.group("body").strip() if m else ""


def write_slow_field(skill_md: str, guidance: str) -> str:
    """Replace (or append) the protected block. Exactly one block survives,
    whatever state the markers were in before."""
    block = f"{SLOW_START}\n{guidance.strip()}\n{SLOW_END}" if guidance.strip() \
        else f"{SLOW_START}\n{SLOW_END}"
    if _well_formed(skill_md):
        return _BLOCK.sub(lambda _m: block, skill_md, count=1)
    clean, _ = _strip_markers(skill_md)
    return clean.rstrip() + "\n\n" + block + "\n"


# ── the two LLM steps ───────────────────────────────────────────────────────

_SLOW_SYSTEM = """You are the strategic advisor for an agent-skill training loop.
The per-step analyst sees single batches; YOU see how the skill changed across
a whole round by comparing the SAME tasks under two consecutive versions.

Write (or rewrite) a short guidance block for the skill. Priorities:
  1. prevent the regressions listed
  2. address persistent failures
  3. keep what improved

Rules: 2-5 bullets, addressed to the agent that uses the skill ("When X, do Y").
Do not repeat what the main skill body already says. Keep any concrete values.
If previous guidance is given, keep what worked and drop what did not.
EVERY bullet must end with the task ids it is for, verbatim from the
comparison, in the form `[task:<id>, task:<id>]` — a bullet without a citation
is discarded.

Return JSON only: {"reasoning": "...", "guidance": "<bullet list as one string>"}"""

_META_SYSTEM = """You are the optimizer's coach, not the agent's.
Write a compact optimizer-side memory from the adjacent-round comparison: which
KINDS of edits helped here, which were vague, brittle or harmful, what level of
abstraction works, what regression risks to guard against.

Address the FUTURE OPTIMIZER. Do not write agent-facing task instructions.
Keep it to a few durable principles; revise or drop previous memory that did not
help.

Return JSON only: {"reasoning": "...", "meta_skill": "<compact guidance>"}"""


def run_slow_update(
    backend: Backend, *, prev_skill_md: str, curr_skill_md: str,
    lon: Longitudinal, prev_guidance: str = "",
) -> str | None:
    """Return new guidance, or None when there is nothing to say."""
    if not lon.worth_updating() and not prev_guidance:
        return None
    payload = {
        "previous_skill_excerpt": prev_skill_md[:3000],
        "current_skill_excerpt": curr_skill_md[:3000],
        "comparison": lon.render(),
        "previous_guidance": prev_guidance,
    }
    try:
        raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                               system=_SLOW_SYSTEM, stage="slow_update", max_tokens=800)
    except Exception:  # noqa: BLE001
        return None
    data = extract_json(raw) or {}
    g = str(data.get("guidance") or "").strip()
    g = enforce_citations(g, known_ids={*lon.regressed, *lon.improved,
                                        *lon.persistent_fail, *lon.stable_success})
    g = cap_guidance(g)
    return g or None


# ── guidance hygiene: citations, cap, retirement (REVIEW §1.7) ──────────────

MAX_GUIDANCE_LINES = 12
MAX_GUIDANCE_CHARS = 1800
_CITE = re.compile(r"\[(task:[^\]]+)\]\s*$")


def guidance_lines(g: str) -> list[str]:
    return [ln.rstrip() for ln in g.splitlines() if ln.strip()]


def citations(line: str) -> list[str]:
    m = _CITE.search(line)
    if not m:
        return []
    return [c.strip()[len("task:"):] for c in m.group(1).split(",") if c.strip().startswith("task:")]


def enforce_citations(g: str, *, known_ids: set[str] | None = None) -> str:
    """Drop bullets without a citation (or citing tasks that do not exist)."""
    keep = []
    for ln in guidance_lines(g):
        if not ln.lstrip().startswith(("-", "*", "•")):
            continue
        cites = citations(ln)
        if not cites:
            continue
        if known_ids is not None and not any(c in known_ids for c in cites):
            continue
        keep.append(ln)
    return "\n".join(keep)


def cap_guidance(g: str, *, max_lines: int = MAX_GUIDANCE_LINES,
                 max_chars: int = MAX_GUIDANCE_CHARS) -> str:
    """Hard ceiling: the newest lines survive. Guidance only ever grows otherwise."""
    lines = guidance_lines(g)
    lines = lines[-max_lines:]
    while lines and len("\n".join(lines)) > max_chars:
        lines = lines[1:]
    return "\n".join(lines)


def retire_guidance(skill_dir: Path, runner, tasks: list[TaskRecord], *,
                    budget: int = 6, work_root: Path | None = None) -> tuple[list[str], int]:
    """Counterfactual pruning of guidance lines.

    A line whose cited tasks pass WITHOUT it is not doing anything: retire it
    (to `.evo/retired_guidance.md`). Runs at most *budget* task roll-outs;
    with a pytest runner prose has no effect and nothing is touched.
    """
    import shutil

    from .edits import snapshot
    if getattr(runner, "name", "") == "pytest":
        return [], 0
    skill_dir = Path(skill_dir)
    md_path = skill_dir / "SKILL.md"
    if not md_path.exists():
        return [], 0
    md = md_path.read_text(encoding="utf-8")
    lines = guidance_lines(read_slow_field(md))
    by_id = {t.id: t for t in tasks}
    retired: list[str] = []
    runs = 0
    work_root = Path(work_root or skill_dir / ".evo" / "work")
    for ln in list(lines):
        cited = [by_id[c] for c in citations(ln) if c in by_id]
        if not cited or runs + len(cited) > budget:
            continue
        # baseline: do the cited tasks pass WITH the line?
        with_line = {r.task_id: r for r in runner.run(skill_dir, cited)}
        runs += len(cited)
        if not all(with_line.get(t.id) is not None and with_line[t.id].passed for t in cited):
            continue                        # the line is not (yet) load-bearing; keep it
        if runs + len(cited) > budget:
            break
        work = work_root / f"retire-{abs(hash(ln)) % 10**8}"
        try:
            cand = snapshot(skill_dir, work)
            rest = [x for x in lines if x != ln]
            (cand / "SKILL.md").write_text(write_slow_field(md, "\n".join(rest)), encoding="utf-8")
            without = {r.task_id: r for r in runner.run(cand, cited)}
            runs += len(cited)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        if all(without.get(t.id) is not None and without[t.id].passed for t in cited):
            retired.append(ln)
            lines.remove(ln)
    if retired:
        md_path.write_text(write_slow_field(md, "\n".join(lines)), encoding="utf-8")
        log = skill_dir / ".evo" / "retired_guidance.md"
        log.parent.mkdir(exist_ok=True)
        with log.open("a", encoding="utf-8") as fh:
            for ln in retired:
                fh.write(ln + "\n")
    return retired, runs


def run_meta_skill(
    backend: Backend, *, lon: Longitudinal, prev_meta: str = "",
    accepted_summary: str = "", rejected_summary: str = "",
) -> str | None:
    payload = {
        "comparison": lon.render(),
        "edits_accepted_this_round": accepted_summary[:2000],
        "edits_rejected_this_round": rejected_summary[:2000],
        "previous_meta_skill": prev_meta,
    }
    try:
        raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                               system=_META_SYSTEM, stage="meta_skill", max_tokens=700)
    except Exception:  # noqa: BLE001
        return None
    data = extract_json(raw) or {}
    m = str(data.get("meta_skill") or "").strip()
    return m or None


def apply_slow_update(skill_dir: Path, guidance: str) -> Path:
    p = Path(skill_dir) / "SKILL.md"
    text = p.read_text(encoding="utf-8") if p.exists() else ""
    p.write_text(write_slow_field(text, guidance), encoding="utf-8")
    return p


def load_meta(evo_dir: Path) -> str:
    p = Path(evo_dir) / "meta_skill.md"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def save_meta(evo_dir: Path, meta: str) -> Path:
    p = Path(evo_dir) / "meta_skill.md"
    p.write_text(meta.strip() + "\n", encoding="utf-8")
    return p


def snapshot_records(records: list[ExecRecord]) -> dict[str, bool]:
    return {r.task_id: r.passed for r in records}
