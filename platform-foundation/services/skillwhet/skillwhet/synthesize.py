"""Task synthesis: the task set grows toward the skill's blind spots (REVIEW §1.2).

Two sources, both anchored in something that actually happened:

  * neighbours of a FAILING task — same intent family, different numbers,
    order, or with a distractor. The skill just demonstrated it cannot handle
    this region; one failure is an anecdote, five neighbours are a signal the
    fast loop can cluster.
  * variants of a PASSING task — regression sensing for the region the skill
    does handle, so a later repair that breaks it is caught on train.

Rules: every synthetic task carries a rubric (dropped otherwise, never
invented); ``origin="synthetic"`` and ``split="train"`` always — synthetic
tasks never enter val or test (evidence.assign_splits enforces the same);
pytest node ids are not synthesised here (that is evolve_tests' job).
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from .backend import Backend, extract_json
from .evidence import ExecRecord, TaskRecord, validate_judge

_SYSTEM = """You create training tasks for an agent skill from ONE seed task.
The seed comes with its outcome (passed / failed) under the current skill.
You are also given the skill's prose and the list of functions it actually has.

Produce up to N variants that stay in the SAME intent family but differ in
concrete details: other numbers, another order of sub-requests, an added
irrelevant detail, a boundary case (empty, very large, unusual format).
Do NOT copy the seed. Refer ONLY to functions in the given list — a variant
that names a function the skill does not have is discarded.

For each variant give:
- intent: the user's request, self-contained
- context_excerpt: extra material the user provides (may be empty)
- rubric: how a reviewer would judge a good answer — ALWAYS provide this. The
  rubric states the CORRECT answer, derived from the seed's rubric, which is
  ground truth. NEVER write "consistent with the documentation" or "as the
  docs describe": the documentation may be wrong — that is what training
  repairs — and a rubric that defers to it rewards the defect.
- checks: optional machine checks [{"op": contains|not_contains|regex|no_refusal, "arg": ...}]

Return JSON only: {"variants": [{"intent": ..., "context_excerpt": ..., "rubric": ..., "checks": [...]}]}"""


def _tid(seed: TaskRecord, intent: str) -> str:
    return "syn_" + hashlib.sha256(f"{seed.id}::{intent}".encode("utf-8")).hexdigest()[:12]


_CALL = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*\(")
_BUILTIN_WORDS = {"e", "i", "if", "or", "and", "the", "a", "an", "of", "to", "in", "on"}


def _known_symbols(skill_dir: Path | None) -> set[str]:
    """Function names the skill really has (contract + AST), lower-cased."""
    if skill_dir is None:
        return set()
    names: set[str] = set()
    try:
        from .contract import collect_facts, load_contract
        for e in load_contract(skill_dir).entrypoints:
            names.add(e.id.split(".")[-1].lower())
        for f in collect_facts(skill_dir).values():
            for q in f.functions:
                names.add(q.split(".")[-1].lower())
    except Exception:  # noqa: BLE001
        pass
    return names


def _mentions_unknown(text: str, known: set[str]) -> str:
    """Name of the first function-like token not in *known* ('' if all are known)."""
    if not known:
        return ""
    for m in _CALL.finditer(text):
        name = m.group(1)
        if name.lower() in _BUILTIN_WORDS:
            continue
        if name.lower() not in known:
            return name
    return ""


def synthesize_tasks(
    seeds: list[TaskRecord],
    records: list[ExecRecord],
    backend: Backend,
    *,
    per_seed: int = 2,
    budget: int = 6,
    existing_ids: set[str] | None = None,
    skill_dir: Path | None = None,
) -> tuple[list[TaskRecord], dict]:
    """Variants of agent tasks (exact/rubric/rule). Returns (tasks, stats).

    Grounded in the skill: the prompt carries the skill's prose and function
    list, and any variant naming a function the skill does not have is
    dropped. The first real run produced tasks about `parse_invoice` and
    `get_records` — functions that do not exist — which can never pass and
    would have sat in the train set as permanent, unrepairable failures.
    """
    existing = set(existing_ids or ())
    outcome = {r.task_id: r for r in records}
    stats = {"seeds": 0, "candidates": 0, "dropped_no_rubric": 0, "dropped_duplicate": 0,
             "dropped_unknown_symbol": 0}
    known = _known_symbols(skill_dir)
    prose = ""
    if skill_dir is not None:
        try:
            from .propose.doc import prose_of
            prose = prose_of(skill_dir, budget=6000)
        except Exception:  # noqa: BLE001
            prose = ""
    out: list[TaskRecord] = []
    # failing seeds first — that is where the blind spots are
    ordered = sorted(seeds, key=lambda t: (outcome.get(t.id) is not None and outcome[t.id].passed,
                                           t.id))
    for seed in ordered:
        if len(out) >= budget:
            break
        if "::" in seed.id and seed.id.split("::")[0].endswith(".py"):
            continue                                  # pytest tasks: evolve_tests
        if seed.reference_kind == "none":
            continue
        rec = outcome.get(seed.id)
        stats["seeds"] += 1
        payload = {
            "N": per_seed,
            "skill_functions": sorted(known),
            "skill_prose": prose[:6000],
            "seed": {"intent": seed.intent, "context_excerpt": seed.context_excerpt[:800],
                     "rubric": seed.reference[:600] if seed.reference_kind != "exact" else "",
                     "expected_exact": seed.reference if seed.reference_kind == "exact" else ""},
            "outcome": "unknown" if rec is None else ("passed" if rec.passed else "failed"),
            "observed_answer_excerpt": (rec.stdout[:500] if rec is not None else ""),
        }
        try:
            raw = backend.complete(json.dumps(payload, ensure_ascii=False), system=_SYSTEM,
                                   stage="synth.tasks", max_tokens=1500)
        except Exception:  # noqa: BLE001
            continue
        data = extract_json(raw) or {}
        for v in (data.get("variants") or [])[:per_seed]:
            if not isinstance(v, dict):
                continue
            stats["candidates"] += 1
            intent = str(v.get("intent") or "").strip()
            rubric = v.get("rubric")
            if len(intent) < 8 or not isinstance(rubric, str) or len(rubric.strip()) < 8:
                stats["dropped_no_rubric"] += 1
                continue
            bad = _mentions_unknown(intent + " " + str(v.get("context_excerpt") or ""), known)
            if bad:
                stats["dropped_unknown_symbol"] += 1
                continue
            tid = _tid(seed, intent)
            if tid in existing:
                stats["dropped_duplicate"] += 1
                continue
            checks = [c for c in (v.get("checks") or []) if isinstance(c, dict)]
            judge = {"kind": "rule", "checks": checks} if checks else {}
            if judge and any("unknown op" in w for w in validate_judge(judge)):
                judge = {}
            existing.add(tid)
            out.append(TaskRecord(
                id=tid, intent=intent, context_excerpt=str(v.get("context_excerpt") or "")[:800],
                reference_kind="rubric", reference=rubric.strip(), judge=judge,
                split="train", origin="synthetic", skill_hint=seed.skill_hint,
                source_sessions=list(seed.source_sessions), tags=[*seed.tags, f"seed:{seed.id}"],
            ))
            if len(out) >= budget:
                break
    return out, stats


_DEFER = re.compile(r"(?i)(consistent with|according to|as (?:described|stated|documented) in|per) "
                    r"(?:the |its )?(?:documentation|docs|skill)")


def neighbour_check(tasks: list[TaskRecord], seeds_outcome: dict[str, bool],
                    runner, skill_dir: Path) -> tuple[list[TaskRecord], dict]:
    """Keep only variants that behave like their seed on the CURRENT skill.

    A variant of a failing seed that passes right now is not in the failure's
    neighbourhood — on the first grounded run every such variant passed on
    the defective docs and then FAILED after the fix, because its rubric had
    been written as "consistent with the documentation". Costs one roll-out
    per variant. Variants of passing seeds must pass (regression sensing).
    """
    stats = {"checked": len(tasks), "dropped_wrong_side": 0, "dropped_defers_to_docs": 0}
    keep: list[TaskRecord] = []
    pre = []
    for t in tasks:
        if _DEFER.search(t.reference or ""):
            stats["dropped_defers_to_docs"] += 1
            continue
        pre.append(t)
    if not pre:
        return [], stats
    recs = {r.task_id: r for r in runner.run(Path(skill_dir), pre)}
    for t in pre:
        seed = next((tag[len("seed:"):] for tag in t.tags if tag.startswith("seed:")), "")
        want_fail = not seeds_outcome.get(seed, True)
        r = recs.get(t.id)
        if r is None or not r.scored:
            keep.append(t)                       # noise: give it the benefit of the doubt
            continue
        if (want_fail and r.passed) or (not want_fail and not r.passed):
            stats["dropped_wrong_side"] += 1
            continue
        keep.append(t)
    return keep, stats


def load_synthetic(path: Path) -> list[TaskRecord]:
    p = Path(path)
    if not p.exists():
        return []
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return [TaskRecord.from_dict(d) for d in data.get("tasks", [])]


def save_synthetic(path: Path, tasks: list[TaskRecord]) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps({"format": "skillwhet.tasks.v1",
                             "tasks": [t.to_dict() for t in tasks]},
                            ensure_ascii=False, indent=1), encoding="utf-8")
