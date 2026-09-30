"""The two loops.

Fast loop  — code. Verification is free, so propose widely and let the gates cut.
Slow loop  — prose. Verification costs a roll-out, so propose once, carefully.

They are separate functions rather than one parameterised loop because their
economics are inverted, and collapsing them would force one of the two into the
wrong regime.
"""
from __future__ import annotations

import textwrap
from dataclasses import dataclass, field
from pathlib import Path

from . import pytestio
from .attribute import Attribution
from .backend import Backend, no_llm
from .bundle import CommitResult, Evaluation, commit, evaluate, promote
from .evidence import ExecRecord, TaskRecord
from .expensive import replay_candidate
from .gates import build_fast_pyramid
from .gates.g4_tests import collect_test_status
from .gates.pyramid import PyramidConfig
from .impact import bundle_symbols, tasks_touching
from .mutation import run_mutation
from .propose.doc import propose_doc_edits
from .propose.p1_rules import propose_rule_fixes
from .propose.p2_defect import propose_defect_fixes
from .propose.p3_capability import Gap, propose_capability, rank_gaps
from .progress import note
from .provenance import ProvenanceLog, record
from .runner import Runner
from .search import ClusterLedger, cluster_key, fingerprint, refinable, refine
from .sandbox import SandboxPolicy, run_sandboxed
from .types import Bundle
from .wiki import Wiki


@dataclass
class FastConfig:
    k_samples: int = 4
    budget_p2: int = 6
    budget_p3: int = 4
    enable_p1: bool = True
    enable_p2: bool = True
    enable_p3: bool = True
    temperature: float = 0.7
    # search (REVIEW §1.3 / §1.4 / §1.10)
    best_of_k: bool = True              # gate every candidate of a cluster, land the best
    refine_rounds: int = 1              # re-ask with gate findings before giving up
    dedup: bool = True                  # AST fingerprint; rejected ones remembered in wiki
    escalate_after: int = 2             # rounds a cluster resists before the strong model
    # pre-promote checks (need a materialised candidate; run after G0-G5)
    replay: bool = True                 # G6 per-patch transition scoring
    require_repro_red: bool = True      # P2/P3 repro must fail before the fix
    mutation_floor: float = 0.0         # 0 = off; e.g. 0.5 = ≥50% mutants killed
    mutation_max: int = 8
    pyramid: PyramidConfig = field(default_factory=PyramidConfig)


@dataclass
class LoopOutcome:
    accepted: list[Bundle] = field(default_factory=list)
    rejected: list[CommitResult] = field(default_factory=list)
    proposed: int = 0
    rejected_by: dict[str, int] = field(default_factory=dict)
    deduped: int = 0
    refined: int = 0
    viable_not_selected: int = 0
    escalated: int = 0

    def summary(self) -> dict:
        return {"proposed": self.proposed, "accepted": len(self.accepted),
                "rejected": len(self.rejected), "rejected_by": dict(self.rejected_by),
                "deduped": self.deduped, "refined": self.refined,
                "viable_not_selected": self.viable_not_selected,
                "escalated": self.escalated}


# ── repro-red check ─────────────────────────────────────────────────────────

def _repro_status(skill_dir: Path, repro_src: str, modules: list[str]) -> str:
    """Run a repro test against *skill_dir*: 'green' | 'red' | 'broken'.

    'red' means pytest collected it and at least one test FAILED. A repro that
    does not even import ('broken') used to count as red — so any garbage
    satisfied the "must fail before the fix" rule (audit B8).
    """
    probe = skill_dir / "tests" / "unit" / "_whet_repro_probe.py"
    header = "import sys, pathlib\n" \
             "sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))\n"
    imports = ""
    for m in modules:
        mod = m.replace("/", ".").removesuffix(".py")
        imports += f"from {mod} import *  # noqa\n"
    try:
        probe.parent.mkdir(parents=True, exist_ok=True)
        probe.write_text(header + imports + "\n" + textwrap.dedent(repro_src) + "\n",
                         encoding="utf-8")
        res = run_sandboxed(
            pytestio.argv(probe.relative_to(skill_dir).as_posix(), tb="line"),
            skill_dir, SandboxPolicy(wall_timeout_s=60),
        )
        out = (res.stdout or "") + "\n" + (res.stderr or "")
        if not pytestio.collectable(res.returncode, out):
            return "broken"
        verdicts = pytestio.parse_verbose(out).values()
        if any(v in ("FAILED", "ERROR") for v in verdicts):
            return "red"
        return "green" if any(v == "PASSED" for v in verdicts) else "broken"
    finally:
        probe.unlink(missing_ok=True)
        cache = probe.parent / "__pycache__"
        if cache.is_dir():
            import shutil
            shutil.rmtree(cache, ignore_errors=True)


def _baseline_tests(skill_dir: Path) -> dict[str, bool]:
    """Per-test status of the skill a candidate is derived from, all three suites.

    ``tests/contract/`` is generated from CONTRACT.yaml, so it is regenerated
    on the baseline first — otherwise a check added to the contract since the
    last run would look "newly broken" on every candidate (G3 §9.4).
    """
    try:
        from .contract import load_contract
        from .contract_tests import generate
        generate(skill_dir, load_contract(skill_dir))
    except Exception:  # noqa: BLE001 - no contract, unreadable skill: no baseline
        pass
    return {**collect_test_status(skill_dir, "tests/unit"),
            **collect_test_status(skill_dir, "tests/holdout"),
            **collect_test_status(skill_dir, "tests/contract")}


def _make_pre_promote(
    skill_dir: Path, cfg: FastConfig, runner: Runner | None,
    tasks: list[TaskRecord], baseline: list[ExecRecord],
    weights: dict[str, float] | None = None,
):
    """Build the hook that runs G6 replay, the repro-red check, and mutation."""

    def hook(cand: Path, bundle: Bundle) -> tuple[bool, str, dict]:
        detail: dict = {}
        modules = sorted({e.module for e in bundle.code_edits})

        # 1. The repro must be RED on the original and GREEN on the candidate.
        #    Green-before disproves the defect; red-after means the fix and
        #    the repro are about different things; broken means it says nothing.
        if cfg.require_repro_red and bundle.origin in ("P2", "P3"):
            for e in bundle.code_edits:
                if not e.repro_test:
                    continue
                before = _repro_status(skill_dir, e.repro_test, modules)
                if before == "green":
                    return False, "repro test was already green before the fix", detail
                if before == "broken":
                    return False, "repro test is not runnable (import/collection error)", detail
                after = _repro_status(cand, e.repro_test, modules)
                if after != "green":
                    return False, f"repro test is still {after} after the fix", detail
                detail["repro"] = "red->green"

        # 2. G6: per-patch transition scoring. Catches "helps on average, quietly
        #    breaks a task that used to pass" — invisible to an aggregate gate.
        #    pytest tasks that cannot reach an edited symbol are not replayed
        #    (impact.tasks_touching); agent tasks always are.
        if cfg.replay and runner is not None and tasks:
            replay_tasks = tasks
            if bundle.code_edits and not bundle.doc_edits:
                replay_tasks = tasks_touching(skill_dir, tasks, bundle_symbols(bundle)) or tasks
            v = replay_candidate(cand, replay_tasks, runner, baseline=baseline,
                                 digest=bundle.digest(),
                                 allow_inert=bundle.origin == "P1", weights=weights)
            detail["replay"] = v.to_dict()
            detail["replay_tasks"] = len(replay_tasks)
            if not v.accepted:
                why = (f"G6 replay: {v.regressed} regression(s) "
                       f"({', '.join(v.regressed_tasks[:3])})" if v.regressed
                       else "G6 replay: repairs no failing task")
                return False, why, detail

        # 3. Mutation floor: do the tests still test anything after this change?
        if cfg.mutation_floor > 0 and modules:
            rep = run_mutation(cand, modules, max_mutants=cfg.mutation_max,
                               work_root=cand / ".evo" / "work")
            detail["mutation"] = rep.to_dict()
            if not rep.meets(cfg.mutation_floor):
                return False, (f"mutation score {rep.score:.2f} below floor "
                               f"{cfg.mutation_floor:.2f}"), detail
        return True, "", detail

    return hook


def fast_loop(
    skill_dir: Path,
    attribution: Attribution,
    backend: Backend,
    *,
    wiki: Wiki,
    prov: ProvenanceLog,
    work_root: Path,
    round_no: int,
    cfg: FastConfig | None = None,
    gaps: list[Gap] | None = None,
    runner: Runner | None = None,
    train_tasks: list[TaskRecord] | None = None,
    baseline_records: list[ExecRecord] | None = None,
    strong_backend: Backend | None = None,
    clusters: ClusterLedger | None = None,
    task_weights: dict[str, float] | None = None,
) -> LoopOutcome:
    """Propose widely, gate everything, land the best candidate per defect.

    Per cluster the K candidates are all materialised and gated against the
    SAME baseline, then ranked (tasks repaired, replay mean, mutation score,
    smallest diff) and one is promoted. A candidate rejected at a refinable
    gate is re-asked once with the findings. Candidates whose AST fingerprint
    was already rejected (this round or in the wiki) are not gated at all.
    """
    cfg = cfg or FastConfig()
    out = LoopOutcome()
    gates = build_fast_pyramid(cfg.pyramid)
    known = wiki.brief()                     # what has already been tried and failed
    seen_fps: set[str] = set(wiki.rejected_fingerprints()) if cfg.dedup else set()

    # ── propose ─────────────────────────────────────────────────────────────
    note("proposing", round=round_no, code_defects=len(attribution.code_defect),
         gaps=len(gaps or []), k=cfg.k_samples)
    proposals: list[Bundle] = []
    if cfg.enable_p1:
        proposals += propose_rule_fixes(skill_dir, scratch=work_root)
    if cfg.enable_p2 and attribution.code_defect:
        normal, hard = [], []
        for c in attribution.code_defect:
            key = f"cluster:{c.key}"
            if strong_backend is not None and clusters is not None and \
                    clusters.stubborn(key, cfg.escalate_after):
                hard.append(c)
            else:
                normal.append(c)
        if normal:
            proposals += propose_defect_fixes(
                skill_dir, normal, backend,
                k=cfg.k_samples, budget=cfg.budget_p2, temperature=cfg.temperature,
                known_failures=known)
        if hard:
            # A cluster that resisted `escalate_after` rounds of the cheap model
            # gets the strong one — an escalation ladder, not a bigger K.
            out.escalated = len(hard)
            proposals += propose_defect_fixes(
                skill_dir, hard, strong_backend,
                k=max(2, cfg.k_samples // 2), budget=cfg.budget_p2,
                temperature=cfg.temperature, known_failures=known)
    if cfg.enable_p3 and gaps:
        proposals += propose_capability(
            skill_dir, rank_gaps(gaps), backend,
            k=max(2, cfg.k_samples - 1), budget=cfg.budget_p3,
            temperature=cfg.temperature, known_failures=known)
    out.proposed = len(proposals)
    by_origin: dict[str, int] = {}
    for b in proposals:
        by_origin[b.origin] = by_origin.get(b.origin, 0) + 1
    note("proposals", round=round_no, n=len(proposals), by_origin=by_origin)

    # ── baselines ───────────────────────────────────────────────────────────
    tasks = train_tasks or []
    baseline = baseline_records
    if runner is not None and tasks and baseline is None:
        baseline = runner.run(skill_dir, tasks)
    state = {"baseline": baseline or [],
             "hook": _make_pre_promote(skill_dir, cfg, runner, tasks, baseline or [], task_weights),
             "tests": _baseline_tests(skill_dir)}

    def refresh() -> None:
        if runner is not None and tasks:
            state["baseline"] = runner.run(skill_dir, tasks)
        state["hook"] = _make_pre_promote(skill_dir, cfg, runner, tasks, state["baseline"],
                                          task_weights)
        state["tests"] = _baseline_tests(skill_dir)

    def gate(bundle: Bundle) -> Evaluation:
        with no_llm(f"fast_loop.gates.r{round_no}"):
            return evaluate(skill_dir, bundle, work_root=work_root, gates=gates,
                            pre_promote=state["hook"], baseline_tests=state["tests"])

    def reject(bundle: Bundle, res: CommitResult) -> None:
        out.rejected.append(res)
        stage = res.pyramid.stopped_at if (res.pyramid and not res.pyramid.passed) \
            else res.reason.split(":")[0]
        out.rejected_by[stage] = out.rejected_by.get(stage, 0) + 1
        record(prov, bundle, round_no=round_no,
               gates_passed=[r.gate for r in (res.pyramid.results if res.pyramid else []) if r.ok],
               accepted=False, edits=[r.to_dict() for r in res.edit_reports], reason=res.reason)
        wiki.record_rejection(bundle, round_no, stage,
                              res.pyramid.findings if res.pyramid else [],
                              fingerprint=fingerprint(bundle) if cfg.dedup else "")

    # ── gate per cluster, land the best ─────────────────────────────────────
    groups: dict[str, list[Bundle]] = {}
    for b in proposals:
        groups.setdefault(cluster_key(b) if cfg.best_of_k else f"bundle:{b.digest()}", []).append(b)

    gated = 0
    total = sum(len(g) for g in groups.values())

    def _what(b: Bundle) -> str:
        return ", ".join(f"{e.module}::{e.symbol or '*'}" for e in b.code_edits)[:160]

    for key, group in groups.items():
        viable: list[Evaluation] = []
        for bundle in group:
            if cfg.dedup:
                fp = fingerprint(bundle)
                if fp in seen_fps:
                    out.deduped += 1
                    continue
                seen_fps.add(fp)
            ev = gate(bundle)
            attempts = 0
            while not ev.viable and attempts < cfg.refine_rounds and refinable(ev.result):
                attempts += 1
                better = refine(bundle, ev.result, backend, skill_dir=skill_dir)
                if better is None:
                    break
                reject(bundle, ev.result)                   # the original is recorded as such
                out.refined += 1
                bundle = better
                if cfg.dedup:
                    fp = fingerprint(bundle)
                    if fp in seen_fps:
                        break
                    seen_fps.add(fp)
                ev = gate(bundle)
            gated += 1
            stage_ = "viable" if ev.viable else (
                ev.result.pyramid.stopped_at if (ev.result.pyramid and not ev.result.pyramid.passed)
                else ev.result.reason.split(":")[0])
            note("candidate", round=round_no, i=gated, n=total, origin=bundle.origin, what=_what(bundle),
                 viable=bool(ev.viable), stage=stage_, refined=attempts,
                 reason=("" if ev.viable else str(ev.result.reason)[:160]))
            if ev.viable:
                viable.append(ev)
            else:
                reject(bundle, ev.result)
        if not viable:
            if clusters is not None and key.startswith("cluster:"):
                clusters.note(key, round_no, repaired=False)
            continue
        viable.sort(key=lambda e: e.rank_key, reverse=True)
        best, rest = viable[0], viable[1:]
        for ev in rest:
            out.viable_not_selected += 1
            record(prov, ev.result.bundle, round_no=round_no,
                   gates_passed=[r.gate for r in ev.result.pyramid.results if r.ok],
                   accepted=False)
            wiki.log(round_no, f"viable, not selected: {ev.result.bundle.digest()} "
                               f"rank={ev.rank_key} (chosen {best.result.bundle.digest()} "
                               f"rank={best.rank_key})")
            ev.discard()
        note("selected", round=round_no, origin=best.result.bundle.origin, what=_what(best.result.bundle),
             among=len(viable), rationale=str(best.result.bundle.rationale or "")[:200])
        res = promote(best, skill_dir)
        record(prov, res.bundle, round_no=round_no,
               gates_passed=[r.gate for r in res.pyramid.results if r.ok], accepted=True,
               edits=[r.to_dict() for r in res.edit_reports], reason=res.reason)
        out.accepted.append(res.bundle)
        wiki.record_acceptance(res.bundle, round_no)
        if clusters is not None and key.startswith("cluster:"):
            clusters.note(key, round_no, repaired=True)
        refresh()                            # later clusters are judged against the new state
    return out


def slow_loop(
    skill_dir: Path,
    attribution: Attribution,
    backend: Backend,
    *,
    wiki: Wiki,
    prov: ProvenanceLog,
    work_root: Path,
    round_no: int,
    code_delta: str = "",
    edit_budget: int = 4,
    minibatch_size: int = 8,
    governance_advice: list[dict] | None = None,
    meta_skill: str = "",
    gates=None,
    successes: list[str] | None = None,
) -> LoopOutcome:
    """One carefully merged proposal per round, because verifying costs a roll-out."""
    out = LoopOutcome()
    if not attribution.doc_defect:
        return out

    note("proposing_doc", round=round_no, doc_defects=len(attribution.doc_defect))
    bundle = propose_doc_edits(
        skill_dir, attribution.doc_defect, successes=list(successes or []), backend=backend,
        edit_budget=edit_budget, minibatch_size=minibatch_size,
        step_buffer=wiki.brief(), code_delta=code_delta,
        governance_advice=governance_advice, meta_skill=meta_skill,
    )
    if bundle.is_empty():
        return out
    out.proposed = 1

    # Judged relative to the suite as it stands, like the fast loop: a prose
    # bundle must not be rejected because an unrelated unit test is still red
    # (audit B5) — that is the normal state of a skill mid-training.
    base_tests = _baseline_tests(skill_dir)
    res = commit(skill_dir, bundle, work_root=work_root,
                 gates=gates or build_fast_pyramid(), baseline_tests=base_tests)
    record(prov, bundle, round_no=round_no,
           gates_passed=[r.gate for r in (res.pyramid.results if res.pyramid else [])
                         if r.ok],
           accepted=res.accepted, edits=[r.to_dict() for r in res.edit_reports],
           reason=res.reason)
    note("candidate", round=round_no, i=1, n=1, origin="doc", what=f"{len(bundle.doc_edits)} prose edit(s)",
         viable=bool(res.accepted),
         stage="viable" if res.accepted else (res.pyramid.stopped_at if res.pyramid else "pre-gate"),
         reason="" if res.accepted else str(res.reason)[:160], rationale=str(bundle.rationale or "")[:200])
    if res.accepted:
        out.accepted.append(bundle)
        wiki.record_acceptance(bundle, round_no)
        skipped = [r for r in res.edit_reports if not r.applied]
        if skipped:
            wiki.log(round_no, f"doc bundle landed with {len(skipped)} edit(s) NOT applied: "
                               + ", ".join(f"{r.op}:{r.status}" for r in skipped[:4]))
    else:
        out.rejected.append(res)
        wiki.record_rejection(bundle, round_no,
                              res.pyramid.stopped_at if res.pyramid else "pre-gate",
                              res.pyramid.findings if res.pyramid else [])
    return out


def code_delta_summary(bundles: list[Bundle]) -> str:
    """What the fast loop changed, rendered for the prose reflector.

    Without this the prose keeps accumulating warnings about problems the code
    no longer has — a textbook source of knowledge bloat.
    """
    if not bundles:
        return ""
    lines = ["The code changed this round; prose describing the old behaviour "
             "may now be stale:"]
    for b in bundles:
        for e in b.code_edits:
            what = f"{e.module}::{e.symbol}" if e.symbol else e.module
            lines.append(f"- [{b.origin}] {e.op} {what} — {e.rationale[:140]}")
    return "\n".join(lines)
