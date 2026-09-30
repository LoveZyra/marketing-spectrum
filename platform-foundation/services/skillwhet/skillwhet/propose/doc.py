"""Slow-loop proposal side: minibatch reflection, hierarchical merge, ranking.

This is SkillOpt's machinery, and it exists for one reason: in the slow loop a
single verification costs a full roll-out, so you get one shot per round and it
had to be a good one. Minibatches surface recurring procedural errors instead of
anecdotes; hierarchical merging keeps what independent analyses agree on; the
edit budget is the learning rate.

The fast loop deliberately does NOT reuse any of this — see propose/p2_defect.py.
"""
from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..backend import Backend, extract_json
from ..types import Bundle, DocEdit, FailureSignal

_FAIL_SYSTEM = """You analyse MULTIPLE failed agent trajectories at once and propose
edits to the skill's prose.

- Identify the failure patterns COMMON to the batch, not one-off accidents.
- Edits must generalise: no task-specific values, no hard-coded answers.
- Only patch gaps; do not restate what the skill already says.
- Keep concrete values, versions and links verbatim. Replacing a specific value
  with "see the official docs" is knowledge loss and will be rejected.
- If an existing sentence is WRONG, use op=replace with that exact sentence as
  the target. Appending a "corrected" section while the wrong sentence stays
  leaves the skill contradicting itself and is counted as bloat.
- Never target text between <!-- SLOW_UPDATE_START --> and <!-- SLOW_UPDATE_END -->.

The skill text is given as several files, each under a `===== FILE: <path> =====`
marker. `path` MUST be one of those paths, and `target` MUST be copied
verbatim from THAT file (same line breaks, backticks and punctuation).

Return JSON only:
{"batch_size": <int>, "patterns": ["..."],
 "edits": [{"op": "append|insert_after|replace|delete", "path": "references/x.md",
            "target": "<exact text, for insert_after/replace/delete>",
            "content": "<markdown>"}]}"""

_SUCCESS_SYSTEM = """You analyse MULTIPLE SUCCESSFUL agent trajectories and encode the
behaviours worth preserving.

- Only patterns appearing across MULTIPLE trajectories.
- Only what the skill does not already cover.
- Be conservative: success edits reinforce, they do not restructure.

Same JSON shape as the failure analyst."""

_MERGE_SYSTEM = """You merge independently proposed skill patches into one.

1. Deduplicate; keep the best-worded version.
2. Resolve contradictions; prefer the better-supported side.
3. Prevalent patterns (appearing in several patches) are systematic — keep them.
   An edit from a single patch may be dropped as task-specific.
4. No two merged edits may target the same text region.
5. FAILURE-driven edits outrank SUCCESS-driven ones on the same point.

Return JSON only: {"reasoning": "...", "edits": [ ... same shape ... ]}"""

_RANK_SYSTEM = """Rank proposed skill edits and select the top N.

Priority: (1) systematic impact — fixes many failures, not one edge case;
(2) complementarity — fills a gap rather than repeating existing text;
(3) generality — a principle, not a bound instance; (4) actionability.

Return JSON only: {"reasoning": "...", "selected_indices": [<0-based, in priority order>]}"""


def _minibatches(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def _parse_edits(data: dict | None) -> list[DocEdit]:
    if not data:
        return []
    out = []
    for e in data.get("edits") or []:
        if not isinstance(e, dict):
            continue
        op = str(e.get("op", "")).strip()
        if op not in ("append", "insert_after", "replace", "delete"):
            continue
        path = str(e.get("path", "")).strip()
        if not path:
            continue
        out.append(DocEdit(
            op=op, path=path, content=str(e.get("content", "")),
            target=str(e.get("target", "")),
        ))
    return out


def reflect(
    signals: list[FailureSignal],
    successes: list[str],
    skill_text: str,
    backend: Backend,
    *,
    minibatch_size: int = 8,
    edit_budget: int = 4,
    workers: int = 8,
    step_buffer: str = "",
    code_delta: str = "",
    governance_advice: list[dict] | None = None,
    meta_skill: str = "",
) -> list[list[DocEdit]]:
    """Parallel minibatch reflection over failures and successes.

    ``code_delta`` is the fast loop's output for this round. Without it the prose
    accumulates stale warnings about problems the code no longer has, which is a
    textbook source of knowledge bloat.
    """
    jobs: list[tuple[str, list]] = []
    jobs += [("fail", b) for b in _minibatches(signals, minibatch_size)]
    jobs += [("succ", b) for b in _minibatches(successes, minibatch_size)]
    if not jobs:
        return []

    def one(job: tuple[str, list]) -> list[DocEdit]:
        kind, batch = job
        payload = {
            "skill": skill_text[:24000],
            "budget": edit_budget,
            "batch_size": len(batch),
            "trajectories": [
                s.to_dict() if hasattr(s, "to_dict") else str(s) for s in batch
            ],
        }
        if step_buffer:
            payload["previously_rejected_this_epoch"] = step_buffer[:4000]
        if code_delta:
            payload["code_changed_this_round"] = code_delta[:3000]
        if governance_advice:
            # G8's soft constraint: structural advice is not a rejection, it is
            # input to the next revision so degradation dissolves round by round.
            payload["structural_advice_from_governance"] = governance_advice[:6]
        if meta_skill:
            payload["optimizer_memory"] = meta_skill[:2500]
        try:
            raw = backend.complete(
                json.dumps(payload, ensure_ascii=False),
                system=_FAIL_SYSTEM if kind == "fail" else _SUCCESS_SYSTEM,
                stage=f"doc.reflect.{kind}", max_tokens=4096,
            )
        except Exception:  # noqa: BLE001
            return []
        return _parse_edits(extract_json(raw))[:edit_budget]

    import contextvars
    ctx = contextvars.copy_context()
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        return [r for r in ex.map(lambda j: ctx.copy().run(one, j), jobs) if r]


def merge(patches: list[list[DocEdit]], skill_text: str, backend: Backend,
          *, batch_size: int = 8) -> list[DocEdit]:
    """Hierarchical merge. Failure-first ordering is preserved by the fallback."""
    if not patches:
        return []
    if len(patches) == 1:
        return patches[0]

    level = patches
    while len(level) > 1:
        nxt: list[list[DocEdit]] = []
        for chunk in _minibatches(level, batch_size):
            if len(chunk) == 1:
                nxt.append(chunk[0])
                continue
            payload = {
                "skill": skill_text[:16000],
                "patches": [[e.to_dict() for e in p] for p in chunk],
            }
            try:
                raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                                       system=_MERGE_SYSTEM, stage="doc.merge",
                                       max_tokens=8192)
                merged = _parse_edits(extract_json(raw))
            except Exception:  # noqa: BLE001
                merged = []
            # Fallback is plain concatenation in order: failure patches were
            # queued first, so priority survives even when the merge call fails.
            nxt.append(merged or [e for p in chunk for e in p])
        level = nxt
    return level[0]


def rank_and_clip(edits: list[DocEdit], skill_text: str, backend: Backend,
                  *, budget: int) -> list[DocEdit]:
    """The edit budget is the textual learning rate; it is enforced client-side."""
    if len(edits) <= budget:
        return edits
    payload = {
        "skill": skill_text[:16000], "budget": budget,
        "edits": [{"i": i, **e.to_dict()} for i, e in enumerate(edits)],
    }
    try:
        raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                               system=_RANK_SYSTEM, stage="doc.rank", max_tokens=2048)
        idx = (extract_json(raw) or {}).get("selected_indices") or []
        picked, seen = [], set()
        for i in idx:
            if isinstance(i, int) and 0 <= i < len(edits) and i not in seen:
                picked.append(edits[i])
                seen.add(i)
            if len(picked) >= budget:
                break
        if picked:
            return picked
    except Exception:  # noqa: BLE001
        pass
    return edits[:budget]          # never trust the model to respect the cap


PROSE_BUDGET = 24_000


def prose_of(skill_dir: Path, budget: int = PROSE_BUDGET) -> str:
    """SKILL.md plus every references/*.md, each under a FILE marker.

    The reflector used to see SKILL.md alone: with the defect in
    references/extraction.md it could neither quote the wrong sentence for a
    `replace` nor know which path to name, so every fix became an `append`
    next to the sentence it contradicted (first real slow-loop run).
    """
    files = [Path(skill_dir) / "SKILL.md",
             *sorted((Path(skill_dir) / "references").glob("*.md"))]
    files = [f for f in files if f.exists()]
    if not files:
        return ""
    per = max(2000, budget // len(files))
    parts = []
    for f in files:
        rel = f.relative_to(Path(skill_dir)).as_posix()
        body = f.read_text(encoding="utf-8")
        if len(body) > per:
            body = body[:per] + f"\n… [truncated {len(body) - per} chars]"
        parts.append(f"===== FILE: {rel} =====\n{body}")
    return "\n\n".join(parts)


def propose_doc_edits(
    skill_dir: Path, signals: list[FailureSignal], successes: list[str],
    backend: Backend, *, edit_budget: int = 4, minibatch_size: int = 8,
    step_buffer: str = "", code_delta: str = "",
    governance_advice: list[dict] | None = None, meta_skill: str = "",
) -> Bundle:
    text = prose_of(Path(skill_dir))
    patches = reflect(signals, successes, text, backend,
                      minibatch_size=minibatch_size, edit_budget=edit_budget,
                      step_buffer=step_buffer, code_delta=code_delta,
                      governance_advice=governance_advice, meta_skill=meta_skill)
    merged = merge(patches, text, backend)
    final = rank_and_clip(merged, text, backend, budget=edit_budget)
    return Bundle(
        doc_edits=final, origin="doc",
        evidence=[s.id for s in signals[:10]],
        rationale=f"doc reflection: {len(patches)} patches -> {len(final)} edits",
    )
