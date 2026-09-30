"""The main loop. Everything else is a component of this.

Round structure (r = 1..R):

    execute train → attribute (4-way)
    ├─ fast loop × N   code: P1/P2/P3 → G0-G5 → [repro-red, G6 replay, mutation] → promote
    ├─ atomic bundles  contract drift
    ├─ slow loop       prose: reflect → merge → rank → G0-G5   (gets code_delta,
    │                  governance advice from r-1, optimizer meta skill)
    ├─ governance G8   dual-anchor hard + structural soft (advice → r+1)
    ├─ hold-out G7     strictly greater, no-regression
    ├─ [r ≥ 2] slow update: same tasks under S_{r-1} vs S_r → protected block
    ├─ [r ≥ 2] meta skill: optimizer-side memory
    └─ [even r] test evolution — code is frozen this step; tests only grow

Three deliberate orderings:
  * code before prose — repaired code changes what the prose should say
  * fast loop iterates inside the slow loop — its gates are free
  * candidate set always contains S0 — the run can never end worse than it began
"""
from __future__ import annotations

import shutil
from dataclasses import asdict, dataclass, field
from pathlib import Path

from . import checkpoint as _ck
from .attribute import attribute
from .cache import CachedRunner, RunCache
from .counterfactual import section_effects
from .search import ClusterLedger
from .synthesize import load_synthetic, save_synthetic, synthesize_tasks
from .backend import Roles
from .contract import bootstrap_contract, load_contract, save_contract
from .edits import snapshot
from .evidence import ExecRecord, TaskRecord, split_counts
from .evolve_tests import check_monotonic, evolve_tests
from .expensive import (
    GateDecision, GovernanceResult, aggregate, govern, holdout_gate, pairwise_gate, select_score,
)
from .gates.pyramid import PyramidConfig
from .ledger import Ledger
from .loops import FastConfig, code_delta_summary, fast_loop, slow_loop
from .progress import NULL as NULL_PROGRESS, Progress, bind as _bind_progress, step as _step, unbind as _unbind_progress
from .propose.p3_capability import Gap
from .provenance import ProvenanceLog
from .runner import Runner
from .slow_update import (
    apply_slow_update, compare_rounds, load_meta, read_slow_field, retire_guidance,
    run_meta_skill, run_slow_update, save_meta,
)
from .staging import stage
from .types import Bundle, FailureSignal, RootCause
from .wiki import Wiki


@dataclass
class TrainConfig:
    rounds: int = 4
    fast_iters: int = 3
    edit_budget: int = 4
    minibatch_size: int = 8
    gate_metric: str = "mixed"
    gate_mixed_weight: float = 0.5
    no_regression: bool = True
    enable_slow_loop: bool = True
    enable_slow_update: bool = True
    enable_meta_skill: bool = True
    evolve_tests_every: int = 2      # every k-th round opens with a test phase
    test_budget: int = 3
    slow_update_sample: int = 20
    # effectiveness (REVIEW §1)
    frontier_window: int = 3         # §1.2 rounds a task must be stable before it leaves the active set
    frontier_min: int = 4            # §1.2 never replay fewer than this many tasks
    synthesize_every: int = 0        # §1.2 0 = off; k = grow the task set every k-th round
    synth_budget: int = 4
    counterfactual_budget: int = 0   # §1.5 roll-outs per round for section ablation (0 = off)
    retire_budget: int = 0           # §1.7 roll-outs per round for guidance retirement (0 = off)
    min_val: int = 4                 # §1.8 warn when the hold-out slice is smaller
    gap_patience: int = 2            # §1.8 consecutive widenings of train-val gap before stopping
    gap_delta: float = 0.05
    doc_revert_margin: float = 0.02  # §1.6 revert a prose bundle only if val drops by more than this
    pairwise_judge: bool = False     # §1.8 G7 as a side-by-side sign test instead of absolute scores
    cache: bool = True               # §1.10 memoise non-pytest roll-outs on (skill digest, task)
    # gz: platform-driven stops. 0 / None = off. Checked at round boundaries; the
    # round that crosses the line still records its result but no further round starts.
    max_cost_usd: float = 0.0
    max_minutes: float = 0.0
    no_accept_rounds: int = 0        # stop after N consecutive rounds without an accepted round
    # ha S3-04 release-once: the test split is NOT looked at by training. It is
    # evaluated exactly once per staging, by `whet release-eval`, when someone
    # intends to release it. True restores the old end-of-train evaluation.
    eval_test_at_end: bool = False
    # ha S3-05: G8 leak check — new doc lines sharing a distinctive n-gram with a
    # task's context / intent / reference are a hard violation (the doc memorised data).
    leak_check: bool = True
    # he: continue an interrupted run from its last completed round (``.evo/checkpoint.json``)
    resume: bool = False
    fast: FastConfig = field(default_factory=FastConfig)
    pyramid: PyramidConfig = field(default_factory=PyramidConfig)


@dataclass
class RoundReport:
    round: int
    attribution: dict = field(default_factory=dict)
    fast: dict = field(default_factory=dict)
    slow: dict = field(default_factory=dict)
    baseline_score: float = 0.0
    candidate_score: float = 0.0
    gate: dict = field(default_factory=dict)
    governance: dict = field(default_factory=dict)
    slow_update: dict = field(default_factory=dict)
    tests: dict = field(default_factory=dict)
    synthesis: dict = field(default_factory=dict)
    counterfactual: dict = field(default_factory=dict)
    frontier: dict = field(default_factory=dict)
    train_score: float = 0.0
    accepted_bundles: int = 0
    rejected_bundles: int = 0
    llm_calls: int = 0
    cost_usd: float = 0.0
    edits: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TrainResult:
    best_dir: Path
    best_score: float
    baseline_score: float
    rounds: list[RoundReport]
    staging_dir: Path | None
    improved: bool
    total_cost_usd: float = 0.0
    stop_reason: str = "rounds"

    def to_dict(self) -> dict:
        return {"best_score": self.best_score, "baseline_score": self.baseline_score,
                "improved": self.improved, "total_cost_usd": round(self.total_cost_usd, 4),
                "stop_reason": self.stop_reason,
                "staging_dir": str(self.staging_dir) if self.staging_dir else None,
                "rounds": [r.to_dict() for r in self.rounds]}


def bootstrap(skill_dir: Path, *, third_party: list[str] | None = None) -> Path:
    """Freeze S0, derive the contract, capture the preserve ledger."""
    skill_dir = Path(skill_dir)
    evo = skill_dir / ".evo"
    evo.mkdir(exist_ok=True)
    contract = bootstrap_contract(skill_dir, third_party=third_party)
    save_contract(skill_dir, contract)
    baseline = evo / "baseline"
    if baseline.exists():
        shutil.rmtree(baseline)
    snapshot(skill_dir, baseline)
    Ledger.capture(skill_dir, contract).save(evo / "ledger.yaml")
    return skill_dir


class _TaskState:
    """Per-task outcome history across rounds AND runs (`.evo/task_state.json`).

    Feeds the frontier (§1.2): a task that has passed for `window` rounds is
    stable and leaves the per-candidate replay set; one that flipped recently
    carries extra weight in the replay ranking.
    """

    def __init__(self, path: Path, data: dict[str, list[bool]]) -> None:
        self.path, self.data = path, data

    @classmethod
    def load(cls, path: Path) -> _TaskState:
        try:
            import json
            return cls(path, {k: [bool(x) for x in v]
                              for k, v in json.loads(path.read_text(encoding="utf-8")).items()})
        except (OSError, ValueError):
            return cls(path, {})

    def save(self) -> None:
        import json
        self.path.write_text(json.dumps({k: v[-12:] for k, v in self.data.items()}),
                             encoding="utf-8")

    def observe(self, records) -> None:
        for r in records:
            if r.scored:
                self.data.setdefault(r.task_id, []).append(bool(r.passed))

    def streak(self, task_id: str) -> int:
        h = self.data.get(task_id, [])
        n = 0
        for x in reversed(h):
            if not x:
                break
            n += 1
        return n

    def flips(self, task_id: str, window: int) -> int:
        h = self.data.get(task_id, [])[-(window + 1):]
        return sum(1 for a, b in zip(h, h[1:]) if a != b)

    def active(self, tasks, records, *, window: int, minimum: int):
        by_id = {r.task_id: r for r in records}
        act = [t for t in tasks if not (by_id.get(t.id) is not None and by_id[t.id].passed
                                        and self.streak(t.id) >= window)]
        if len(act) < minimum:
            for t in tasks:                       # pad with stable ones for regression sensing
                if t not in act:
                    act.append(t)
                if len(act) >= minimum:
                    break
        return act

    def weights(self, tasks, *, window: int) -> dict[str, float]:
        return {t.id: 1.0 + self.flips(t.id, window) for t in tasks}


def _successes(tasks, records) -> list[str]:
    """What worked this round, rendered for the prose reflector (§1.6)."""
    by_id = {t.id: t for t in tasks}
    out = []
    for r in records:
        if not r.passed or not r.scored:
            continue
        t = by_id.get(r.task_id)
        if t is None:
            continue
        line = f"PASSED {t.id}: {t.intent[:160]}"
        if r.stdout and "::" not in t.id:
            line += f" — answer: {r.stdout[:240]!r}"
        out.append(line)
    return out[:40]


def _calls_and_cost(roles: Roles) -> tuple[int, float]:
    # hl(静态 P1-10):指定 --target-model 时 rollout 走的是独立的 target 后端,原来这里不累加它,
    # budget_reached / cost_usd / Prism 的当日额度全都漏掉 rollout 的钱。按对象去重,同一后端只算一次。
    seen: dict[int, object] = {}
    for b in (roles.fast_proposer, roles.slow_proposer, roles.evaluator, roles.target):
        if b is not None:
            seen[id(b)] = b
    calls = sum(getattr(getattr(b, "stats", None), "calls", 0) for b in seen.values())
    cost = sum(getattr(getattr(b, "stats", None), "cost_usd", 0.0) for b in seen.values())
    return calls, cost


def model_snapshot(roles: Roles, runner: Runner | None = None) -> dict:
    """Which backends / models actually served this run — the alias the user typed
    and, when the backend saw it, the concrete model the gateway answered with."""
    def one(b) -> dict | None:
        if b is None:
            return None
        return {"backend": getattr(b, "name", type(b).__name__),
                "model": getattr(b, "model", None),
                "resolved_model": getattr(b, "resolved_model", None)}
    snap = {"fast": one(roles.fast_proposer), "slow": one(roles.slow_proposer),
            "eval": one(roles.evaluator), "target": one(roles.target),
            "runner": getattr(runner, "name", None) if runner is not None else None}
    try:
        import shutil as _sh
        import subprocess as _sp
        exe = _sh.which("claude")
        if exe:
            out = _sp.run([exe, "--version"], capture_output=True, text=True, timeout=10, check=False)
            snap["claude_cli"] = (out.stdout or out.stderr).strip()[:80]
    except (OSError, _sp.SubprocessError):
        pass
    return snap


def _run_identity(runner: Runner, roles: Roles) -> dict:
    """he: what else must match for a checkpoint to be resumable — the runner (and its
    test dir) and the backend / model of every role. Not part of TrainConfig."""
    def one(b) -> list:
        return [getattr(b, "name", type(b).__name__) if b is not None else None, getattr(b, "model", None)]
    inner = getattr(runner, "inner", runner)
    return {"runner": getattr(inner, "name", type(inner).__name__),
            "test_dir": str(getattr(inner, "subdir", "") or ""),
            "roles": [one(roles.fast_proposer), one(roles.slow_proposer), one(roles.evaluator), one(roles.target)]}


def train(
    skill_dir: Path,
    tasks: list[TaskRecord],
    roles: Roles,
    runner: Runner,
    *,
    cfg: TrainConfig | None = None,
    gaps: list[Gap] | None = None,
    work_root: Path | None = None,
    progress: Progress | None = None,
) -> TrainResult:
    # hd:把进度文件挂到当前上下文,训练里每一步 / 每条任务 / 每个候选都能上报"此刻在做什么"
    token = _bind_progress(progress, usage=lambda: _calls_and_cost(roles))
    try:
        return _train(skill_dir, tasks, roles, runner, cfg=cfg, gaps=gaps,
                      work_root=work_root, progress=progress)
    finally:
        _unbind_progress(token)


def _train(
    skill_dir: Path,
    tasks: list[TaskRecord],
    roles: Roles,
    runner: Runner,
    *,
    cfg: TrainConfig | None = None,
    gaps: list[Gap] | None = None,
    work_root: Path | None = None,
    progress: Progress | None = None,
) -> TrainResult:
    import time as _time
    cfg = cfg or TrainConfig()
    progress = progress or NULL_PROGRESS
    started_at = _time.monotonic()
    stop_reason = "rounds"
    no_accept_streak = 0
    roles.validate()                                   # Generator != Evaluator
    live_dir = Path(skill_dir)
    evo = live_dir / ".evo"
    evo.mkdir(exist_ok=True)
    work_root = Path(work_root or evo / "work")
    work_root.mkdir(parents=True, exist_ok=True)
    if not (evo / "baseline").exists():
        bootstrap(live_dir)

    # The live skill is READ here and written only by `adopt`. Everything the
    # loop does happens on this working copy. (The first real-model run showed
    # accepted bundles being promoted straight into the live directory — the
    # staging design promised otherwise, and a test named for that promise had
    # never asserted it.)
    skill_dir = snapshot(live_dir, evo / "current")
    baseline_dir = evo / "baseline"
    wiki = Wiki(evo / "wiki")
    wiki.begin_run()                       # he: counts runs; lessons unseen for long retire
    prov = ProvenanceLog(evo / "provenance.jsonl")
    ledger = Ledger.load(evo / "ledger.yaml")
    meta = load_meta(evo) if cfg.enable_meta_skill else ""

    if cfg.cache and getattr(runner, "name", "") != "pytest":
        runner = CachedRunner(runner, RunCache(evo / "cache.json"))
    clusters = ClusterLedger.load(evo / "clusters.json")
    state = _TaskState.load(evo / "task_state.json")

    train_tasks = [t for t in tasks if t.split == "train"]
    val_tasks = [t for t in tasks if t.split == "val"]
    from .expensive import LeakIndex
    leak_sources = LeakIndex([x for t in tasks if t.split in ("val", "test")
                              for x in (t.context_excerpt, t.intent,
                                        t.reference if t.reference_kind == "exact" else "") if x])
    test_tasks = [t for t in tasks if t.split == "test"]
    known_ids = {t.id for t in tasks}
    for st in load_synthetic(evo / "synthetic_tasks.json"):      # survive across runs
        if st.id not in known_ids:
            train_tasks.append(st)
            known_ids.add(st.id)
    wiki.log(0, f"tasks {split_counts(tasks)} (+{sum(1 for t in train_tasks if t.origin == 'synthetic')} synthetic)")
    progress.emit("tasks_split", train=len(train_tasks), val=len(val_tasks), test=len(test_tasks),
                  synthetic=sum(1 for t in train_tasks if t.origin == "synthetic"))
    if 0 < len(val_tasks) < cfg.min_val:
        wiki.log(0, f"WARNING: only {len(val_tasks)} val task(s); G7 has little statistical "
                    f"power — ties backed by train repairs are accepted, train regressions reject")

    # he: resume from the last completed round of an interrupted run, or start clean
    ck_data = _ck.data_key(tasks, live_dir, baseline_dir)
    ck_cfg = _ck.cfg_key(cfg, extra=_run_identity(runner, roles))
    ck = _ck.load(evo) if cfg.resume else None
    if cfg.resume:
        reason = _ck.why_not(ck, data=ck_data, cfg=ck_cfg, evo=evo)
        if reason:
            wiki.log(0, f"resume requested but not possible: {reason}; starting a fresh run")
            progress.emit("resume_unavailable", reason=reason)
            ck = None
    if ck is None:
        _ck.clear(evo)
    start_round = int(ck["round"]) if ck else 0
    if ck and ck.get("stopped"):
        # the previous run had already decided to stop after this round (budget / timeout /
        # no_accept / gap) and crashed while staging: do not start another round
        stop_reason = str(ck["stopped"])

    # ── baseline on the held-out slice ──────────────────────────────────────
    if ck:
        base_records = [ExecRecord(**x) for x in ck["base_records"]]
    else:
        with _step("baseline", n=len(val_tasks), split="val"):
            base_records = runner.run(skill_dir, val_tasks) if val_tasks else []
    if base_records and not any(r.scored for r in base_records):
        # Every roll-out failed (backend down, session limit): a baseline of
        # 0.0 measured during an outage would make anything look like progress.
        raise RuntimeError("every baseline roll-out failed — backend unavailable? "
                           f"({base_records[0].exc_type}: {base_records[0].exc_message[:120]})")
    b_hard, b_soft = aggregate(base_records)
    baseline_score = select_score(b_hard, b_soft, cfg.gate_metric, cfg.gate_mixed_weight)

    if ck:
        baseline_score = float(ck["baseline_score"])
    progress.emit("baseline", val_score=round(baseline_score, 4), val_tasks=len(val_tasks),
                  **({"resumed": True} if ck else {}))
    candidates: list[tuple[float, Path]] = [(baseline_score, baseline_dir)]   # S0 first
    current_records = list(base_records)          # answers of the last accepted state
    best_score, best_dir = baseline_score, baseline_dir
    current_score = baseline_score
    reports: list[RoundReport] = []
    advice_carry: list[dict] = []
    calls0, cost0 = _calls_and_cost(roles)
    job_cost0 = cost0                      # hf: what this job has spent = cost now − this

    def _over_budget(r: int, what: str) -> bool:
        """hf: the budget is also checked INSIDE a round, before each optional / proposal step,
        so a round that has already used the money does not start another batch of model calls.
        Verification that is already due (the full check, G7) still runs — nothing half-verified
        is ever accepted — so the overshoot is at most the verification of work already done."""
        if not cfg.max_cost_usd:
            return False
        spent_now = _calls_and_cost(roles)[1] - job_cost0
        if spent_now < cfg.max_cost_usd:
            return False
        wiki.log(r, f"budget ${cfg.max_cost_usd:.2f} reached (${spent_now:.4f}) — skipping {what}")
        progress.emit("budget_reached", round=r, skipped=what, spent_usd=round(spent_now, 4),
                      max_cost_usd=cfg.max_cost_usd)
        return True

    # `anchor` is the last ACCEPTED state of the working copy. A rejected round
    # is rolled back to it — otherwise a hard G8 violation introduced in round
    # 1 stays in `.evo/current` and blocks every later round (audit B4).
    anchor_dir = baseline_dir
    gap_history: list[float] = []
    no_accept_streak = 0
    prior_cost = 0.0
    accepted_rounds: list[int] = []
    if ck:
        def _dir(name: str) -> Path:
            return baseline_dir if name == "baseline" else evo / name
        candidates = [(float(sc), _dir(name)) for sc, name in ck["candidates"]]
        current_records = [ExecRecord(**x) for x in ck["current_records"]]
        current_score, best_score = float(ck["current_score"]), float(ck["best_score"])
        reports = [RoundReport(**d) for d in ck["reports"]]
        advice_carry = list(ck.get("advice_carry") or [])
        anchor_dir = _dir(ck["anchor"])
        gap_history = [float(x) for x in ck.get("gap_history") or []]
        no_accept_streak = int(ck.get("no_accept_streak") or 0)
        accepted_rounds = [int(x) for x in ck.get("accepted_rounds") or []]
        for d in ck.get("evolved_tasks") or []:          # red tests grown in earlier rounds stay train tasks
            et = TaskRecord.from_dict(d)
            if et.id not in known_ids:
                train_tasks.append(et)
                known_ids.add(et.id)
        prior_cost = round(sum(x.cost_usd for x in reports), 4)
        skill_dir = snapshot(anchor_dir, evo / "current")      # the interrupted round is discarded
        wiki.log(start_round + 1, f"resumed after round {start_round} (anchor {anchor_dir.name})")
        for x in reports:                  # replay the finished rounds so the curve is whole
            progress.emit("gate", round=x.round, accepted=x.round in accepted_rounds,
                          train_score=x.train_score, val_baseline=round(baseline_score, 4),
                          val_candidate=round(x.candidate_score, 4), action=x.gate.get("action"),
                          formula=x.gate.get("formula"), replayed=True)
        progress.emit("resumed", from_round=start_round, rounds=cfg.rounds, prior_cost_usd=prior_cost,
                      anchor=anchor_dir.name)

    def _checkpoint(r: int, stopped: str = "") -> None:
        def _name(d: Path) -> str:
            return "baseline" if d == baseline_dir else d.name
        _ck.save(evo, {
            "data_key": ck_data, "cfg_key": ck_cfg, "round": r, "rounds_planned": cfg.rounds,
            "baseline_score": baseline_score,
            "base_records": [x.to_dict() for x in base_records],
            "current_records": [x.to_dict() for x in current_records],
            "current_score": current_score, "best_score": best_score,
            "candidates": [[sc, _name(d)] for sc, d in candidates],
            "anchor": _name(anchor_dir), "reports": [x.to_dict() for x in reports],
            "advice_carry": advice_carry, "gap_history": gap_history,
            "no_accept_streak": no_accept_streak, "accepted_rounds": accepted_rounds,
            "evolved_tasks": [t.to_dict() for t in train_tasks if "evolved" in t.tags],
            "stopped": stopped,
        })

    pending = evo / "pending_tests"          # evolved, still-red tests across runs

    def _restore(src: Path, keep_tests_from: Path | None = None) -> None:
        nonlocal skill_dir
        added: dict[str, str] = {}
        if keep_tests_from is not None:
            for tp in (keep_tests_from / "tests" / "unit").glob("test_*.py"):
                if not (src / "tests" / "unit" / tp.name).exists():
                    added[tp.name] = tp.read_text(encoding="utf-8")
        skill_dir = snapshot(src, evo / "current")
        # Evolved tests are red, monotone and code-free: they survive a rollback
        # and the end of the run, so the next run starts with them.
        for name, body in added.items():
            (skill_dir / "tests" / "unit").mkdir(parents=True, exist_ok=True)
            (skill_dir / "tests" / "unit" / name).write_text(body, encoding="utf-8")
            pending.mkdir(exist_ok=True)
            (pending / name).write_text(body, encoding="utf-8")

    if pending.is_dir():
        for tp in sorted(pending.glob("test_*.py")):
            dst = skill_dir / "tests" / "unit" / tp.name
            if not dst.exists():
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_text(tp.read_text(encoding="utf-8"), encoding="utf-8")

    last_round = start_round if ck and ck.get("stopped") else cfg.rounds
    for r in range(start_round + 1, last_round + 1):
        rep = RoundReport(round=r, baseline_score=baseline_score)
        tests_phase = cfg.evolve_tests_every > 0 and r % cfg.evolve_tests_every == 0
        progress.emit("round_start", round=r, tests_phase=tests_phase)

        with _step("rollout", round=r, split="train", n=len(train_tasks), why="measure"):
            records = runner.run(skill_dir, train_tasks) if train_tasks else []
        if records and not any(r.scored for r in records):
            wiki.log(r, f"every train roll-out failed ({records[0].exc_type}); stopping")
            rep.gate = {"action": "abort", "formula": "backend unavailable"}
            reports.append(rep)
            stop_reason = "backend_unavailable"
            progress.emit("error", round=r, message="every train roll-out failed — backend unavailable")
            break
        state.observe(records)
        stable_before = {r.task_id for r in records if r.passed and state.streak(r.task_id) >= cfg.frontier_window}

        # §1.2 task synthesis: neighbours of failing agent tasks, on the schedule
        if cfg.synthesize_every > 0 and r % cfg.synthesize_every == 0 and not _over_budget(r, "synthesis"):
            seeds = [t for t in train_tasks if t.origin == "real"]
            with _step("synthesis", round=r):
                new_tasks, sstats = synthesize_tasks(seeds, records, roles.slow_proposer,
                                                     budget=cfg.synth_budget, existing_ids=known_ids,
                                                     skill_dir=skill_dir)
            if new_tasks:
                from .synthesize import neighbour_check
                new_tasks, nstats = neighbour_check(
                    new_tasks, {x.task_id: x.passed for x in records if x.scored}, runner, skill_dir)
                sstats.update(nstats)
            rep.synthesis = {**sstats, "added": len(new_tasks)}
            if new_tasks:
                train_tasks.extend(new_tasks)
                known_ids.update(t.id for t in new_tasks)
                save_synthetic(evo / "synthetic_tasks.json",
                               [t for t in train_tasks if t.origin == "synthetic"])
                records = runner.run(skill_dir, train_tasks)
                state.observe(records)

        with _step("attribution", round=r, failures=sum(1 for x in records if not x.passed)):
            attribution = attribute(skill_dir, records, {t.id: t for t in train_tasks},
                                    evaluator=roles.evaluator)
        # §1.5 counterfactual section ablation → precise doc_defect signals
        if cfg.counterfactual_budget > 0 and not _over_budget(r, "counterfactual"):
            with _step("counterfactual", round=r, budget=cfg.counterfactual_budget):
                effects, used = section_effects(skill_dir, train_tasks, records, runner,
                                                budget=cfg.counterfactual_budget, work_root=work_root)
            rep.counterfactual = {"runs": used, "effects": [e.to_dict() for e in effects.values()]}
            for e in effects.values():
                if e.harmful:
                    attribution.doc_defect.append(FailureSignal(
                        id=f"cf:{e.anchor}", root_cause=RootCause.DOC_DEFECT,
                        summary=f"section '{e.anchor}' is HARMFUL: {len(e.harmful)} failing "
                                f"task(s) pass without it — rewrite or remove it",
                        evidence=[f"task:{t}" for t in e.harmful[:5]] + [f"anchor:{e.anchor}"],
                        count=len(e.harmful)))
        rep.attribution = attribution.summary()
        progress.emit("attribution", round=r, **{k: v for k, v in rep.attribution.items()
                                                  if isinstance(v, (int, float, str, bool))})

        # §1.2 frontier: replay/G6 runs on the tasks that can still move, not on
        # everything that has passed for `frontier_window` rounds. Stable tasks
        # are re-checked in full at the end of the round (a regression there
        # rejects the round).
        active = state.active(train_tasks, records, window=cfg.frontier_window,
                              minimum=cfg.frontier_min)
        weights = state.weights(train_tasks, window=cfg.frontier_window)
        rep.frontier = {"active": len(active), "stable": len(train_tasks) - len(active)}

        if not attribution.actionable() and not tests_phase:
            wiki.log(r, "no repairable signal; stopping early")
            stop_reason = "no_signal"
            progress.emit("round_end", round=r, accepted=False, reason="no_signal")
            th, ts_ = aggregate(records)
            rep.train_score = round(select_score(th, ts_, cfg.gate_metric, cfg.gate_mixed_weight), 4)
            rep.candidate_score = current_score
            reports.append(rep)
            calls, cost = _calls_and_cost(roles)
            rep.llm_calls, rep.cost_usd = calls - calls0, round(cost - cost0, 4)
            calls0, cost0 = calls, cost
            break

        accepted_code: list[Bundle] = []
        rejected_summ: list[str] = []
        round_bundles: list[Bundle] = []          # he: promoted this round; lessons recorded only if G7 accepts

        if tests_phase and not _over_budget(r, "test evolution"):
            # ── test phase: tests grow, code is frozen. Runs BEFORE the code
            # phase of the same round so the new red tests are repaired in this
            # round rather than parked in a round that G7 can never accept
            # (audit B7). The optimizer's code edits cannot touch tests/ at all
            # (edits.editable_path), so "alternate" is enforced structurally.
            before = snapshot(skill_dir, work_root / f"tests-before-r{r}")
            targets = attribution.doc_defect + [
                FailureSignal(
                    id=f"cluster:{c.key}", root_cause=RootCause.CODE_DEFECT,
                    summary=f"{c.exc_type} in {c.module}::{c.symbol}: {c.sample_message}",
                    evidence=[f"task:{t}" for t in c.task_ids[:3]],
                    module=c.module, symbol=c.symbol, exc_type=c.exc_type, count=c.count,
                ) for c in attribution.code_defect
            ]
            with _step("evolve_tests", round=r, targets=len(targets)):
                res_t = evolve_tests(skill_dir, targets, roles.fast_proposer,
                                     budget=cfg.test_budget, code_frozen=True)
            weak = check_monotonic(before, skill_dir)          # rule 2, hard
            if weak:
                for p in sorted((skill_dir / "tests" / "unit").glob("test_*.py")):
                    if not (before / "tests" / "unit" / p.name).exists():
                        p.unlink()
                res_t.rejected_weakening = [str(w) for w in weak]
                res_t.added = []
            shutil.rmtree(before, ignore_errors=True)
            rep.tests = res_t.to_dict()
            wiki.log(r, f"tests: {rep.tests}")
            # New red tests become train tasks, so the code phase can see them.
            if res_t.added:
                from .pytestio import collect_ids
                for nid in collect_ids(skill_dir, "tests/unit"):
                    if nid not in known_ids and any(nid.startswith(a) for a in res_t.added):
                        train_tasks.append(TaskRecord(
                            id=nid, intent=f"evolved test {nid.split('::')[-1]}",
                            reference_kind="rule", split="train", origin="synthetic",
                            tags=["evolved"]))
                        known_ids.add(nid)
                records = runner.run(skill_dir, train_tasks)
                state.observe(records)
                attribution = attribute(skill_dir, records, {t.id: t for t in train_tasks},
                                        evaluator=roles.evaluator)
                rep.attribution = attribution.summary()
                active = state.active(train_tasks, records, window=cfg.frontier_window,
                                      minimum=cfg.frontier_min)

        # ── fast loop: code ─────────────────────────────────────────────────
        for fast_iter in range(cfg.fast_iters):
            if not attribution.actionable():
                break
            if _over_budget(r, f"fast loop pass {fast_iter + 1}"):
                break
            with _step("fast_loop", round=r, code_defects=len(attribution.code_defect), active=len(active),
                       iter=fast_iter + 1):
                out = fast_loop(
                    skill_dir, attribution, roles.fast_proposer,
                    wiki=wiki, prov=prov, work_root=work_root, round_no=r,
                    cfg=cfg.fast, gaps=(gaps or []) + attribution.gaps(),
                    runner=runner, train_tasks=active,
                    baseline_records=[x for x in records if x.task_id in {t.id for t in active}],
                    strong_backend=roles.slow_proposer, clusters=clusters,
                    task_weights=weights,
                )
            accepted_code.extend(out.accepted)
            round_bundles.extend(out.accepted)
            rejected_summ += [f"{x.bundle.origin}: {x.reason}" for x in out.rejected[:6]]
            cur = out.summary()
            prev = rep.fast or {"proposed": 0, "accepted": 0, "rejected": 0, "rejected_by": {}}
            rb = dict(prev["rejected_by"])
            for k, v in cur["rejected_by"].items():
                rb[k] = rb.get(k, 0) + v
            rep.fast = {
                "proposed": prev["proposed"] + cur["proposed"],
                "accepted": prev["accepted"] + cur["accepted"],
                "rejected": prev["rejected"] + cur["rejected"],
                "rejected_by": rb,
            }
            rep.edits += [{"origin": b.origin,
                           "what": ", ".join(f"{e.module}::{e.symbol or '*'}"
                                             for e in b.code_edits),
                           "rationale": b.rationale[:200]} for b in out.accepted]
            if not out.accepted:
                break
            with _step("rollout", round=r, split="train", n=len(train_tasks), why="after_fix"):
                records = runner.run(skill_dir, train_tasks) if train_tasks else []
            state.observe(records)
            attribution = attribute(skill_dir, records,
                                    {t.id: t for t in train_tasks},
                                    evaluator=roles.evaluator)
            active = state.active(train_tasks, records, window=cfg.frontier_window,
                                  minimum=cfg.frontier_min)

        # ── slow loop: prose, informed by what the code just became ─────────
        if cfg.enable_slow_loop and attribution.doc_defect and not _over_budget(r, "slow loop"):
            prose_matters = getattr(runner, "name", "") != "pytest" and bool(val_tasks)
            pre_doc = snapshot(skill_dir, work_root / f"pre-doc-r{r}")
            pre_val = []
            if prose_matters:
                with _step("rollout", round=r, split="val", n=len(val_tasks), why="before_doc"):
                    pre_val = runner.run(skill_dir, val_tasks)
            with _step("slow_loop", round=r, doc_defects=len(attribution.doc_defect)):
                sout = slow_loop(
                    skill_dir, attribution, roles.slow_proposer,
                    wiki=wiki, prov=prov, work_root=work_root, round_no=r,
                    code_delta=code_delta_summary(accepted_code),
                    edit_budget=cfg.edit_budget, minibatch_size=cfg.minibatch_size,
                    governance_advice=advice_carry, meta_skill=meta,
                    successes=_successes(train_tasks, records),
                )
            rep.slow = sout.summary()
            rep.edits += [{"origin": "doc", "what": f"{len(b.doc_edits)} prose edit(s)",
                           "rationale": b.rationale[:200]} for b in sout.accepted]
            # §1.6 the prose change is measured on its own, not folded into the
            # round's verdict with the code changes: if val drops, it alone is
            # reverted and the code changes keep their credit.
            if sout.accepted and prose_matters:
                with _step("rollout", round=r, split="val", n=len(val_tasks), why="after_doc"):
                    post_val = runner.run(skill_dir, val_tasks)
                before = select_score(*aggregate(pre_val), cfg.gate_metric, cfg.gate_mixed_weight)
                after = select_score(*aggregate(post_val), cfg.gate_metric, cfg.gate_mixed_weight)
                rep.slow["doc_val_delta"] = round(after - before, 4)
                if after > before + cfg.doc_revert_margin:
                    # Values the improvement removed were part of the defect:
                    # retire them from the ledger so G8 does not undo a fix it
                    # has just been shown to be one (tn-doc-wrong: "LAST").
                    from .propose.doc import prose_of
                    gone = [e.key for e in ledger.entries
                            if e.kind == "value" and not e.retired_by
                            and e.key in prose_of(pre_doc) and e.key not in prose_of(skill_dir)]
                    retired = ledger.retire_values(gone, by=",".join(b.digest() for b in sout.accepted))
                    if retired:
                        ledger.save(evo / "ledger.yaml")
                        rep.slow["ledger_retired"] = retired
                        wiki.log(r, f"ledger: retired value(s) removed by a measured doc improvement: {retired}")
                # A drop inside the judge's own noise is not evidence against
                # the prose (measured spread ≈ 0.03–0.09 on 8 rubric tasks).
                if after < before - cfg.doc_revert_margin:
                    for rel in ("SKILL.md", "references"):
                        src, dst = pre_doc / rel, skill_dir / rel
                        if src.is_dir():
                            shutil.rmtree(dst, ignore_errors=True)
                            shutil.copytree(src, dst)
                        elif src.is_file():
                            shutil.copy2(src, dst)
                    rep.slow["doc_reverted"] = True
                    rep.edits = [e for e in rep.edits if e["origin"] != "doc"]
                    wiki.log(r, f"doc bundle reverted: val {before:.3f} -> {after:.3f}")
            shutil.rmtree(pre_doc, ignore_errors=True)

        # ── governance (G8): hard violations block, soft advice carries forward
        contract = load_contract(skill_dir)
        with _step("governance", round=r):
            gov: GovernanceResult = govern(
                skill_dir, baseline_dir=baseline_dir, prev_dir=anchor_dir,
                ledger=ledger, contract=contract,
                passing_tests=[x.task_id for x in records if x.passed] or None,
                leak_sources=leak_sources if cfg.leak_check else None,
            )
        rep.governance = gov.to_dict()
        advice_carry = gov.advice
        progress.emit("fast_loop", round=r, **{k: v for k, v in rep.fast.items() if k != "rejected_by"},
                      rejected_by=rep.fast.get("rejected_by", {}))
        if rep.slow:
            progress.emit("slow_loop", round=r, **{k: v for k, v in rep.slow.items()
                                                    if isinstance(v, (int, float, str, bool))})
        progress.emit("governance", round=r, passed=gov.passed,
                      violations=len(rep.governance.get("violations", []) or []),
                      bloat_ratio=rep.governance.get("bloat_ratio"))

        # ── hold-out gate (G7) ──────────────────────────────────────────────
        rep.accepted_bundles = len(rep.edits)
        rep.rejected_bundles = int(rep.fast.get("rejected", 0)) + int(rep.slow.get("rejected", 0))
        round_changed = rep.accepted_bundles > 0 or bool(rep.tests.get("added"))
        substantive = any(e["origin"] != "P1" for e in rep.edits)   # a P1 cleanup alone is not progress
        accepted_round = False
        # Full train run once per round: stable tasks the frontier skipped are
        # regression-checked here; a stable task that broke rejects the round.
        if round_changed and train_tasks:
            with _step("rollout", round=r, split="train", n=len(train_tasks), why="full_check"):
                records = runner.run(skill_dir, train_tasks)
            state.observe(records)
        th, ts_ = aggregate(records)
        rep.train_score = round(select_score(th, ts_, cfg.gate_metric, cfg.gate_mixed_weight), 4)
        stable_regressed = sorted(t for t in stable_before
                                  if not any(x.task_id == t and x.passed for x in records))
        if stable_regressed:
            wiki.log(r, f"stable train task(s) regressed: {stable_regressed[:3]}")
        if val_tasks and not stable_regressed:
            with _step("rollout", round=r, split="val", n=len(val_tasks), why="g7"):
                cand_records = runner.run(skill_dir, val_tasks)
            tie_ok = any(e["origin"] != "P1" for e in rep.edits)
            h_, s_ = aggregate(cand_records)
            cand_score = select_score(h_, s_, cfg.gate_metric, cfg.gate_mixed_weight)
            use_pairwise = (cfg.pairwise_judge and getattr(runner, "name", "") != "pytest"
                            and any(t.reference_kind == "rubric" for t in val_tasks))
            if use_pairwise:
                # Side-by-side against the last ACCEPTED state's answers: the
                # judge picks the better answer per task (both orders), and the
                # round is accepted on a sign test — no absolute score involved.
                with _step("pairwise", round=r, n=len(val_tasks)):
                    pw = pairwise_gate(cand_records, current_records, val_tasks, roles.evaluator,
                                       tie_ok=tie_ok)
                rep.candidate_score = cand_score
                rep.gate = {**pw.to_dict(), "absolute_score": round(cand_score, 4)}
                accepted_round = pw.accepted and gov.passed
                if accepted_round:
                    current_records = cand_records
                    current_score = cand_score
                    best_score = max(best_score, cand_score)
            else:
                decision: GateDecision = holdout_gate(
                    cand_records, current_score, best_score,
                    metric=cfg.gate_metric, mixed_weight=cfg.gate_mixed_weight,
                    baseline_records=base_records, no_regression=cfg.no_regression,
                    # A tie on val with verified progress on train (every accepted
                    # bundle repaired ≥1 task under G6 with no regression) is
                    # progress, not drift. Only a tie with NOTHING behind it rejects.
                    tie_ok=tie_ok,
                )
                rep.candidate_score = decision.candidate_score
                rep.gate = decision.to_dict()
                accepted_round = decision.accepted and gov.passed
                if accepted_round:
                    current_records = cand_records
                    current_score = decision.candidate_score
                    if decision.candidate_score > best_score:
                        best_score = decision.candidate_score
            if not gov.passed:
                wiki.log(r, f"governance blocked: {len(gov.violations)} violation(s)")
        elif stable_regressed:
            rep.gate = {"action": "reject", "regressed_tasks": stable_regressed,
                        "formula": "a train task stable for the frontier window regressed"}
        else:
            # No hold-out slice: train progress under G6/G8 is the only evidence.
            accepted_round = gov.passed and substantive
            rep.gate = {"action": "accept" if accepted_round else "reject",
                        "formula": "no val tasks; accepted on G6+G8 alone"}
        if val_tasks and 0 < len(val_tasks) < cfg.min_val:
            rep.gate["warning"] = f"val has only {len(val_tasks)} task(s)"

        if accepted_round:
            accepted_rounds.append(r)
            wiki.record_round_accepted(round_bundles, r)
            keep = evo / f"round-{r:02d}"
            snapshot(skill_dir, keep)
            if pending.is_dir():
                for tp in pending.glob("test_*.py"):
                    if (skill_dir / "tests" / "unit" / tp.name).exists():
                        tp.unlink()
            candidates.append((rep.candidate_score if val_tasks else baseline_score, keep))
            prev_accepted = anchor_dir
            anchor_dir = keep
        else:
            prev_accepted = anchor_dir
            if round_changed:
                wiki.log(r, "round rejected; working copy rolled back to last accepted state")
                _restore(anchor_dir, keep_tests_from=skill_dir)

        # ── round-boundary learning (r ≥ 2) ─────────────────────────────────
        if r >= 2 and train_tasks and accepted_round and not _over_budget(r, "round-boundary slow update"):
            with _step("slow_update", round=r):
                lon = compare_rounds(runner, prev_accepted, skill_dir, train_tasks,
                                     sample=cfg.slow_update_sample, seed=r)
            rep.slow_update = {"comparison": lon.counts()}
            disputed = wiki.record_longitudinal(r, lon.regressed, lon.improved)
            if disputed:
                rep.slow_update["disputed_patterns"] = disputed
            if cfg.enable_slow_update:
                skill_md = skill_dir / "SKILL.md"
                prev_md = (prev_accepted / "SKILL.md")
                g = run_slow_update(
                    roles.slow_proposer,
                    prev_skill_md=prev_md.read_text(encoding="utf-8") if prev_md.exists() else "",
                    curr_skill_md=skill_md.read_text(encoding="utf-8") if skill_md.exists() else "",
                    lon=lon, prev_guidance=read_slow_field(
                        skill_md.read_text(encoding="utf-8") if skill_md.exists() else ""),
                )
                if g:
                    apply_slow_update(skill_dir, g)
                    rep.slow_update["guidance_chars"] = len(g)
                    snapshot(skill_dir, anchor_dir)      # guidance is part of the accepted state
            if cfg.enable_meta_skill:
                m = run_meta_skill(
                    roles.slow_proposer, lon=lon, prev_meta=meta,
                    accepted_summary="\n".join(e["rationale"] for e in rep.edits),
                    rejected_summary="\n".join(rejected_summ),
                )
                if m:
                    meta = m
                    save_meta(evo, meta)
                    rep.slow_update["meta_skill_chars"] = len(m)

        # §1.7 retire guidance lines whose cited tasks pass without them
        if accepted_round and cfg.retire_budget > 0 and not _over_budget(r, "guidance retirement"):
            with _step("retire_guidance", round=r, budget=cfg.retire_budget):
                retired, used = retire_guidance(skill_dir, runner, train_tasks,
                                                budget=cfg.retire_budget, work_root=work_root)
            rep.slow_update["retired_guidance"] = len(retired)
            rep.slow_update["retire_runs"] = used
            if retired:
                snapshot(skill_dir, anchor_dir)

        calls, cost = _calls_and_cost(roles)
        rep.llm_calls, rep.cost_usd = calls - calls0, round(cost - cost0, 4)
        calls0, cost0 = calls, cost
        wiki.record_impact(r, rep.accepted_bundles, rep.rejected_bundles, rep.candidate_score)
        reports.append(rep)
        state.save()
        progress.emit("gate", round=r, accepted=accepted_round,
                      train_score=rep.train_score, val_baseline=round(baseline_score, 4),
                      val_candidate=round(rep.candidate_score, 4),
                      action=rep.gate.get("action"), formula=rep.gate.get("formula"))
        progress.emit("round_end", round=r, accepted=accepted_round,
                      accepted_bundles=rep.accepted_bundles, rejected_bundles=rep.rejected_bundles,
                      cost_usd=rep.cost_usd, llm_calls=rep.llm_calls,
                      total_cost_usd=round(sum(x.cost_usd for x in reports), 4))

        # gz: platform stops — budget / wall clock / no progress. Checked after the
        # round's result is recorded so nothing half-verified is ever accepted.
        no_accept_streak = 0 if accepted_round else no_accept_streak + 1
        # he: the budget bounds THIS job (a resumed job starts its own count), like the clock
        spent = sum(x.cost_usd for x in reports) - prior_cost
        elapsed_min = (_time.monotonic() - started_at) / 60.0
        if cfg.max_cost_usd and spent >= cfg.max_cost_usd:
            wiki.log(r, f"stopping: cost ${spent:.4f} reached the budget ${cfg.max_cost_usd:.2f}")
            stop_reason = "budget"
            _checkpoint(r, stop_reason)
            break
        if cfg.max_minutes and elapsed_min >= cfg.max_minutes:
            wiki.log(r, f"stopping: {elapsed_min:.1f} min reached the limit {cfg.max_minutes:.0f} min")
            stop_reason = "timeout"
            _checkpoint(r, stop_reason)
            break
        if cfg.no_accept_rounds and no_accept_streak >= cfg.no_accept_rounds:
            wiki.log(r, f"stopping: {no_accept_streak} round(s) in a row without an accepted round")
            stop_reason = "no_accept"
            _checkpoint(r, stop_reason)
            break

        # §1.8 generalisation-gap monitor: train climbing while val does not is
        # the visible-vs-hold-out gap SpecBench measures; widening for
        # `gap_patience` accepted rounds stops the run.
        if val_tasks and accepted_round:
            gap_history.append(rep.train_score - rep.candidate_score)
            if len(gap_history) > cfg.gap_patience and all(
                    gap_history[-i] - gap_history[-i - 1] > cfg.gap_delta
                    for i in range(1, cfg.gap_patience + 1)):
                wiki.log(r, f"stopping: train-val gap widened {cfg.gap_patience} rounds "
                            f"in a row ({[round(g, 3) for g in gap_history[-cfg.gap_patience - 1:]]})")
                rep.gate["stopped"] = "generalisation gap widening"
                stop_reason = "gap"
                _checkpoint(r, stop_reason)
                break

        _checkpoint(r)              # he: a completed round survives a crash / restart

    # ── final selection over the whole history, S0 included ─────────────────
    # Ties go to the LATER candidate: an accepted tie carries verified train
    # progress that the earlier one does not.
    best_score, best_dir = max(enumerate(candidates), key=lambda kv: (kv[1][0], kv[0]))[1]
    # Every non-S0 candidate was accepted by G7+G8 with verified progress, so
    # "not S0" is the definition of improved (a val tie backed by repaired train
    # tasks counts; an unbacked tie never entered `candidates`).
    improved = best_dir is not baseline_dir
    total_cost = sum(r.cost_usd for r in reports)

    # The test split is evaluated exactly once, at the end, on S0 and on the
    # winner. It was counted but never run before (audit B14).
    test_scores: dict[str, float | None] = {"baseline": None, "best": None}
    if test_tasks and cfg.eval_test_at_end:
        for label, d in (("baseline", baseline_dir), ("best", best_dir)):
            with _step("rollout", split="test", n=len(test_tasks), why=label):
                h, so = aggregate(runner.run(d, test_tasks))
            test_scores[label] = round(select_score(h, so, cfg.gate_metric,
                                                    cfg.gate_mixed_weight), 4)

    final_report = {
        "baseline_score": round(baseline_score, 4),
        "candidate_score": round(best_score, 4),
        "improved": improved,
        "best_round_dir": best_dir.name,
        "total_cost_usd": round(total_cost, 4),
        "llm_calls": sum(r.llm_calls for r in reports),
        "rounds": [r.to_dict() for r in reports],
        "edits": [e for r in reports for e in r.edits],
        "violations": (reports[-1].governance.get("violations", []) if reports else []),
        "bloat_ratio": (reports[-1].governance.get("bloat_ratio", 0.0) if reports else 0.0),
        "held_out_test_tasks": len(test_tasks),
        "test_score_baseline": test_scores["baseline"],
        "test_score_best": test_scores["best"],
        "stop_reason": stop_reason,
        "elapsed_s": round(_time.monotonic() - started_at, 1),
        "model_snapshot": model_snapshot(roles, runner),
        "config": {k: v for k, v in asdict(cfg).items() if not isinstance(v, dict)},
    }
    with _step("staging"):
        staging_dir = stage(best_dir, live_dir, staging_root=evo / "staging",
                            report=final_report, accepted=improved)
    _ck.clear(evo)
    progress.emit("done", stop_reason=stop_reason, improved=improved,
                  baseline_score=round(baseline_score, 4), best_score=round(best_score, 4),
                  # he: a resumed run reports what THIS job spent; the whole run is total_cost_usd
                  cost_usd=round(total_cost - prior_cost, 4), total_cost_usd=round(total_cost, 4),
                  resumed_from=start_round or None, rounds=len(reports),
                  staging=staging_dir.name if staging_dir else None,
                  test_score_baseline=test_scores["baseline"], test_score_best=test_scores["best"])
    return TrainResult(best_dir=best_dir, best_score=best_score,
                       baseline_score=baseline_score, rounds=reports,
                       staging_dir=staging_dir, improved=improved,
                       total_cost_usd=total_cost, stop_reason=stop_reason)
