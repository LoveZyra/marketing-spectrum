"""CLI: ``whet <command>``."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .backend import ClaudeCLIBackend, MockBackend, OpenAICompatibleBackend, Roles
from .contract import (
    bootstrap_contract, collect_facts, derive_contract, load_contract, save_contract,
)
from .evidence import assign_splits, load_tasks, save_tasks, split_counts
from .gates import PyramidConfig, build_fast_pyramid, format_report, run_pyramid
from .loops import FastConfig
from .runner import PytestRunner
from .staging import StagingError, adopt, latest
from .trainer import TrainConfig, bootstrap, train


def _backend(spec: str, model: str):
    """``claude`` (default) → claude -p;  ``mock`` → offline;  anything else → OpenAI-compatible."""
    if spec == "mock":
        return MockBackend()
    if spec in ("claude", "claude_cli", "", None):
        return ClaudeCLIBackend(model=model or "sonnet")
    return OpenAICompatibleBackend(model=model or spec)


def _roles(args) -> Roles:
    # Defaults: haiku proposes in the fast loop (cheap, sampled wide), sonnet
    # proposes in the slow loop, opus judges — three different models so the
    # Generator != Evaluator constraint holds by construction.
    fast = _backend(args.fast_backend, args.fast_model or "haiku")
    slow = _backend(args.slow_backend, args.slow_model or "sonnet")
    ev = _backend(args.eval_backend, args.eval_model or "opus")
    tm = getattr(args, "target_model", "")
    target = _backend(args.fast_backend, tm) if tm else None
    return Roles(fast, slow, ev, target=target)


# ── contract ────────────────────────────────────────────────────────────────

def _contract_init(a) -> int:
    skill = Path(a.skill)
    third = [x.strip() for x in (a.allow or "").split(",") if x.strip()]
    c = bootstrap_contract(skill, third_party=third)
    save_contract(skill, c)
    print(f"wrote {skill / 'CONTRACT.yaml'}")
    print(f"  entrypoints     : {len(c.entrypoints)}")
    print(f"  allowed_imports : {', '.join(c.allowed_imports) or '(none)'}")
    for e in c.entrypoints:
        print(f"  · {e.module}::{e.id}  [{e.stability}]  effects={e.side_effects}")
    return 0


def _contract_sync(a) -> int:
    skill = Path(a.skill)
    c, changes = derive_contract(skill, base=load_contract(skill))
    if not changes:
        print("contract is in sync with source")
        return 0
    print(f"{len(changes)} change(s):")
    for ch in changes:
        print(f"  {ch}")
    if a.write:
        save_contract(skill, c)
        print("written")
        return 0
    print("(dry run — pass --write to apply)")
    return 1


# ── gate / facts ────────────────────────────────────────────────────────────

def _gate(a) -> int:
    skill = Path(a.skill)
    cfg = PyramidConfig(max_complexity=a.max_complexity,
                        use_bandit=not a.no_bandit, use_pyright=not a.no_pyright,
                        run_tests=not a.no_tests)
    res = run_pyramid(skill, load_contract(skill), build_fast_pyramid(cfg),
                      short_circuit=not a.no_short_circuit)
    if a.json:
        print(json.dumps(res.to_dict(), ensure_ascii=False, indent=2))
    else:
        print(f"skill: {skill}")
        print(format_report(res, verbose=a.verbose))
    return 0 if res.passed else 1


def _facts(a) -> int:
    out = {
        m: {"imports": sorted(f.imports), "side_effects": sorted(f.side_effects),
            "functions": f.functions, "annotated": f.annotated,
            "dangerous": [{"name": n, "why": w, "line": ln} for n, w, ln in f.dangerous]}
        for m, f in collect_facts(Path(a.skill)).items()
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


# ── training ────────────────────────────────────────────────────────────────

def _bootstrap(a) -> int:
    skill = Path(a.skill)
    third = [x.strip() for x in (a.allow or "").split(",") if x.strip()]
    bootstrap(skill, third_party=third)
    print(f"frozen baseline    : {skill / '.evo' / 'baseline'}")
    print(f"contract           : {skill / 'CONTRACT.yaml'}")
    print(f"preserve ledger    : {skill / '.evo' / 'ledger.yaml'}")
    print("\nnext: put tasks in a JSON file, then `whet train <skill> --tasks t.json`")
    return 0


def _tasks_from_pytest(skill: Path, subdir: str) -> list:
    """Derive a task set from the test suite: the tests ARE the tasks.

    Ids come from the same argv every gate and runner use (``--rootdir=.``),
    so a pytest.ini above the skill cannot prefix them (audit B10).
    """
    from .evidence import TaskRecord
    from .pytestio import collect_ids
    return [TaskRecord(id=i, intent=i.split("::")[-1], reference_kind="rule")
            for i in collect_ids(skill, subdir)]


def _runner(a, roles):
    """--runner pytest | agent | simulate | mixed (dispatch by reference_kind)."""
    from .runner import AgentRunner, MixedRunner
    from .simulate import SimulationRunner
    kind = getattr(a, "runner", "pytest")
    if kind == "pytest":
        return PytestRunner(subdir=a.test_dir)
    js = getattr(a, "judge_samples", 1)
    workers = getattr(a, "workers", 4)
    if kind == "agent":
        return AgentRunner(roles.evaluator_target(), roles.evaluator,
                           judge_samples=js, workers=workers)
    if kind == "simulate":
        return SimulationRunner(roles.evaluator_target(), roles.evaluator)
    return MixedRunner(PytestRunner(subdir=a.test_dir),
                       AgentRunner(roles.evaluator_target(), roles.evaluator,
                                   judge_samples=js, workers=workers),
                       SimulationRunner(roles.evaluator_target(), roles.evaluator))


def _train(a) -> int:
    skill = Path(a.skill)
    if a.tasks:
        tasks = load_tasks(Path(a.tasks))
    else:
        tasks = _tasks_from_pytest(skill, a.test_dir)
        assign_splits(tasks, val_fraction=a.val_fraction, test_fraction=a.test_fraction)
        print(f"[tasks] derived {len(tasks)} from {a.test_dir}: {split_counts(tasks)}")
        if a.save_tasks:
            save_tasks(Path(a.save_tasks), tasks)
    if not tasks:
        print("no checkable tasks; nothing to train on", file=sys.stderr)
        return 2

    cfg = TrainConfig(
        rounds=a.rounds, fast_iters=a.fast_iters, edit_budget=a.edit_budget,
        enable_slow_loop=not a.no_slow_loop,
        enable_slow_update=not a.no_slow_update, enable_meta_skill=not a.no_meta_skill,
        evolve_tests_every=a.tests_every,
        gate_metric=a.gate_metric, no_regression=not a.allow_regression,
        synthesize_every=a.synthesize_every, synth_budget=a.synth_budget,
        counterfactual_budget=a.counterfactual_budget, retire_budget=a.retire_budget,
        cache=not a.no_cache, pairwise_judge=a.pairwise_judge,
        max_cost_usd=a.max_cost_usd, max_minutes=a.max_minutes, no_accept_rounds=a.no_accept_rounds,
        eval_test_at_end=a.eval_test, leak_check=not a.no_leak_check,
        resume=a.resume,
        fast=FastConfig(k_samples=a.k, budget_p2=a.budget_p2, budget_p3=a.budget_p3,
                        enable_p1=not a.no_p1, enable_p3=not a.no_p3,
                        replay=not a.no_replay, mutation_floor=a.mutation_floor,
                        best_of_k=not a.first_wins, refine_rounds=a.refine,
                        dedup=not a.no_dedup, escalate_after=a.escalate_after,
                        pyramid=PyramidConfig(use_bandit=not a.no_bandit,
                                              use_pyright=not a.no_pyright)),
    )
    roles = _roles(a)
    from .progress import Progress
    progress = Progress(Path(a.progress)) if a.progress else None
    if progress is not None:
        progress.emit("job_start", skill=str(skill), tasks=len(tasks), rounds=a.rounds, runner=a.runner,
                      resume=bool(a.resume),
                      models={"fast": a.fast_model or "haiku", "slow": a.slow_model or "sonnet",
                              "eval": a.eval_model or "opus", "target": a.target_model or None})
    try:
        result = train(skill, tasks, roles, _runner(a, roles), cfg=cfg, progress=progress)
    except Exception as exc:  # noqa: BLE001 — the platform reads the progress file, not our traceback
        if progress is not None:
            progress.emit("error", message=f"{type(exc).__name__}: {exc}"[:500])
        raise

    print(f"\nbaseline  : {result.baseline_score:.4f}")
    print(f"stop      : {result.stop_reason}")
    print(f"best      : {result.best_score:.4f}")
    print(f"improved  : {result.improved}")
    print(f"cost      : ${result.total_cost_usd:.4f}")
    for r in result.rounds:
        print(f"  round {r.round}: attribution={r.attribution} fast={r.fast} "
              f"slow={r.slow or '-'} gate={r.gate.get('action', '-')} "
              f"train={r.train_score} val={r.candidate_score}")
    if result.staging_dir:
        print(f"\nstaged    : {result.staging_dir}")
        print("nothing was written to the live skill. review the report, then:")
        print(f"  whet adopt {a.skill}")
    return 0


def _adopt(a) -> int:
    root = Path(a.skill) / ".evo" / "staging"
    staged = Path(a.staging) if a.staging else latest(root)
    if staged is None:
        print("no staged round found", file=sys.stderr)
        return 2
    try:
        written = adopt(staged, force=a.force, require_release=True, allow_unreleased=a.no_release)
    except StagingError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 1
    print(f"adopted {len(written)} file(s) from {staged}")
    for w in written[:20]:
        print(f"  · {w}")
    print(f"backup: {staged / 'backup'}")
    return 0


def _release_eval(a) -> int:
    """ha S3-04:对一份 staging 做**唯一一次**留出集(test)评估 —— S₀ 与候选各跑一遍。

    先原子地占住(claim),再在**临时拷贝**上跑(测试的副作用不碰 proposed/ 与 .evo/baseline),
    最后写 release.json(带候选的 bundle 哈希与 test 集哈希)。"""
    import hashlib
    import shutil as _sh
    import tempfile
    from .evidence import load_tasks
    from .expensive import aggregate, select_score
    from .progress import NULL, Progress
    from .staging import (StagingError, bundle_hash, claim_release, looks_on_test_set,
                          record_release)
    copy = Path(a.skill).resolve()
    root = copy / ".evo" / "staging"
    staged = (Path(a.staging) if "/" in a.staging else root / a.staging).resolve()
    progress = Progress(Path(a.progress)) if a.progress else NULL
    progress.emit("job_start", job_kind="release_eval", skill=str(copy), staging=staged.name)

    def fail(code: str, msg: str, rc: int) -> int:
        progress.emit("error", code=code, message=msg)
        print(f"refused: {msg}", file=sys.stderr)
        return rc
    if staged.parent != root.resolve():
        return fail("STAGING_NOT_FOUND", f"{staged} is not a staging of {copy}", 2)
    if not (staged / "manifest.json").exists():
        return fail("STAGING_NOT_FOUND", f"no staging at {staged}", 2)
    if (staged / "adopted.json").exists():
        return fail("ALREADY_ADOPTED", "this staging is already adopted — S0 is now the candidate itself; "
                    "evaluating it would compare it with itself", 5)
    tests = [t for t in load_tasks(Path(a.tasks)) if t.split == "test"]
    if not tests:
        return fail("NO_TEST_TASKS", "the task set has no test split — nothing to release-evaluate on", 4)
    test_set_hash = hashlib.sha256(json.dumps(sorted(t.id for t in tests)).encode()).hexdigest()
    try:
        claim_release(copy, staged, test_set_hash)
    except StagingError as exc:
        return fail("TEST_CONSUMED", str(exc), 3)
    man = json.loads((staged / "manifest.json").read_text(encoding="utf-8"))
    baseline_dir = copy / ".evo" / "baseline"
    base_hash_now = bundle_hash(baseline_dir)
    roles = _roles(a)
    runner = _runner(a, roles)
    scores = {}
    with tempfile.TemporaryDirectory(prefix="whet-release-") as tmp:
        for label, src in (("baseline", baseline_dir), ("candidate", staged / "proposed")):
            work = Path(tmp) / label
            _sh.copytree(src, work, ignore=_sh.ignore_patterns(".evo", "__pycache__", ".pytest_cache"))
            recs = runner.run(work, tests)
            h, so = aggregate(recs)
            scores[label] = round(select_score(h, so, a.gate_metric), 4)
            scores[f"{label}_passed"] = sum(1 for r in recs if r.passed)
            progress.emit("release_score", label=label, score=scores[label],
                          passed=scores[f"{label}_passed"], total=len(tests))
    cost = 0.0
    for b in {id(x): x for x in (roles.fast_proposer, roles.slow_proposer, roles.evaluator, roles.target)
              if x is not None}.values():
        cost += getattr(getattr(b, "stats", None), "cost_usd", 0.0)
    result = {"test_tasks": len(tests), "baseline": scores["baseline"], "candidate": scores["candidate"],
              "baseline_passed": scores["baseline_passed"], "candidate_passed": scores["candidate_passed"],
              "delta": round(scores["candidate"] - scores["baseline"], 4),
              "runner": getattr(runner, "name", a.runner), "gate_metric": a.gate_metric,
              "cost_usd": round(cost, 4), "test_set_hash": test_set_hash,
              "looks_on_test_set": looks_on_test_set(copy, test_set_hash),
              "candidate_bundle_hash": bundle_hash(staged / "proposed"),
              # S₀ 在两次之间被采纳改过,基线就不是训练时那个了 —— 不拒,但写明
              "baseline_matches_staging": (not man.get("base_bundle_hash")) or man.get("base_bundle_hash") == base_hash_now}
    try:
        rec = record_release(copy, staged, result)
    except StagingError as exc:
        return fail("TEST_CONSUMED", str(exc), 3)
    progress.emit("done", stop_reason="release_eval", improved=result["delta"] > 0, cost_usd=result["cost_usd"],
                  staging=staged.name, test_score_baseline=result["baseline"], test_score_best=result["candidate"])
    print(json.dumps(rec, ensure_ascii=False, indent=2))
    return 0


def _probe(a) -> int:
    """Does this backend produce parseable JSON for every proposer schema?

    Run this BEFORE the first real training run. Thirty seconds here saves an
    hour of debugging a loop that proposes nothing because the model wrapped
    its JSON in prose.
    """
    from .backend import extract_json
    b = _backend(a.backend, a.model)
    probes = [
        ("p2.defect", "You repair Python defects. Return JSON only: "
                      '{"symbol": "...", "content": "...", "repro_test": "...", "rationale": "..."}',
         '{"module":"scripts/m.py","symbol":"f","exception":"TypeError: bad","source":"def f(x):\n    return x+1"}',
         ["symbol", "content", "repro_test"]),
        ("doc.reflect", "Propose skill prose edits. Return JSON only: "
                        '{"batch_size": 1, "patterns": [], "edits": [{"op":"append","path":"SKILL.md","content":"..."}]}',
         '{"skill":"# S","trajectories":[{"summary":"agent forgot to check input"}]}',
         ["edits"]),
        ("attribute", "Assign one root cause. Return JSON only: "
                      '{"root_cause": "code_defect|doc_defect|contract_drift|isolate", "summary": "...", "confidence": 0.5}',
         '{"exception":"KeyError: x","module":"scripts/m.py"}', ["root_cause"]),
        ("judge", 'Score 0..1. Return ONLY {"score": <0..1>, "reason": "..."}',
         '{"rubric":"answer names the capital","response":"Paris"}', ["score"]),
    ]
    ok_all = True
    for stage, system, prompt, keys in probes:
        try:
            raw = b.complete(prompt, system=system, stage=f"probe.{stage}", max_tokens=600)
        except Exception as exc:  # noqa: BLE001
            print(f"  [FAIL] {stage:12s} call failed: {exc}")
            ok_all = False
            continue
        d = extract_json(raw)
        missing = [k for k in keys if not d or k not in d]
        status = "PASS" if d and not missing else "FAIL"
        ok_all &= status == "PASS"
        note = "" if status == "PASS" else f"  missing={missing} raw={raw[:80]!r}"
        print(f"  [{status}] {stage:12s}{note}")
    st = getattr(b, "stats", None)
    if st:
        print(f"\n  calls={st.calls}  cost=${getattr(st, 'cost_usd', 0):.4f}  backend={b.name}"
              f"  model={getattr(b, 'model', '-')}")
    return 0 if ok_all else 1


def _harvest(a) -> int:
    from .evidence import assign_splits, save_tasks, split_counts
    from .harvest import harvest, load_overlay, load_session_whitelist, mine, uses_skill
    from .progress import NULL, Progress
    progress = Progress(Path(a.progress)) if a.progress else NULL
    progress.emit("job_start", job_kind="harvest", skill=a.skill, dry_run=bool(a.dry_run))
    overlay = load_overlay(Path(a.feedback)) if a.feedback else {}
    sessions = load_session_whitelist(Path(a.sessions)) if a.sessions else None
    digests = harvest(Path(a.transcripts).expanduser(), since_iso=a.since,
                      limit=a.limit, project_filter=a.project, sessions=sessions, overlay=overlay)
    skipped_other = 0
    if a.skill and not a.any_skill:
        # hb:原来所选项目里**每个**会话都被挖进这个 skill 的任务集("苏州天气"也成了 marketing-audit
        # 的任务)。只留用过这个 skill、或者有投给它的票的会话;--any-skill 才全挖
        kept = [d for d in digests if uses_skill(d, a.skill)]
        skipped_other = len(digests) - len(kept)
        digests = kept
    voted = sum(1 for d in digests if d.user_feedback)
    print(f"[harvest] {len(digests)} session(s) from {a.transcripts}"
          f"{f' ({voted} with user votes)' if overlay else ''}"
          f"{f', whitelist {len(sessions)}' if sessions is not None else ''}", file=sys.stderr)
    result: dict = {"sessions": [d.summary() for d in digests], "tasks": [], "stats": {},
                    "dry_run": bool(a.dry_run), "skipped_other_skill": skipped_other}
    progress.emit("harvest_sessions", sessions=len(digests), voted=voted, skipped_other_skill=skipped_other)
    if a.dry_run:
        progress.emit("done", stop_reason="dry_run", improved=False, cost_usd=0.0, sessions=len(digests))
        if a.json_out:
            Path(a.json_out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        elif a.json:
            print(json.dumps(result, ensure_ascii=False, indent=1))
        else:
            for d in digests[:10]:
                print(f"  · {d.session_id[:8]}  turns={d.n_user_turns}  "
                      f"tools={','.join(d.tools_used[:4])}  first={d.user_prompts[0][:60]!r}")
        return 0
    if not digests:
        if a.json_out:
            Path(a.json_out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        progress.emit("done", stop_reason="no_sessions", improved=False, cost_usd=0.0, sessions=0, tasks=0)
        return 0
    backend = _backend(a.backend, a.model or "sonnet")
    tasks, stats = mine(digests, backend, max_tasks=a.max_tasks, skill_hint=a.skill or "")
    if stats.get("errors") and stats["errors"] >= len(digests) and not tasks:
        msg = f"every mining call failed ({stats['errors']}): {stats.get('last_error', '')}"
        progress.emit("error", code="MINER_FAILED", message=msg)
        print(msg, file=sys.stderr)
        return 1
    assign_splits(tasks, val_fraction=a.val_fraction, test_fraction=a.test_fraction)
    print(f"[mine] {stats}  → {len(tasks)} checkable task(s) {split_counts(tasks)}", file=sys.stderr)
    result["tasks"] = [t.to_dict() for t in tasks]
    cost = round(getattr(getattr(backend, "stats", None), "cost_usd", 0.0), 4)
    result["stats"] = {**stats, "cost_usd": cost,
                       "voted": sum(1 for t in tasks if "outcome:voted" in t.tags),
                       "exact": sum(1 for t in tasks if t.reference_kind == "exact")}
    progress.emit("done", stop_reason="mined", improved=bool(tasks), cost_usd=cost,
                  sessions=len(digests), tasks=len(tasks))
    if a.json_out:
        Path(a.json_out).write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"wrote {a.json_out}", file=sys.stderr)
    if a.out:
        out = save_tasks(Path(a.out), tasks)
        print(f"wrote {out}", file=sys.stderr)
    if a.json and not a.json_out:
        print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


def _simulate(a) -> int:
    """Run one multi-turn simulation against a skill and print the verdict."""
    from .simulate import Scenario, simulate, verify
    sc = Scenario.from_dict(json.loads(Path(a.scenario).read_text(encoding="utf-8")))
    skill = Path(a.skill)
    parts = [p.read_text(encoding="utf-8") for p in
             [skill / "SKILL.md", *sorted((skill / "references").glob("*.md"))] if p.exists()]
    service = _backend(a.fast_backend, a.fast_model or "sonnet")
    evaluator = _backend(a.eval_backend, a.eval_model or "opus")
    traj = simulate(sc, service=service, user=evaluator, skill_text="\n\n".join(parts),
                    max_turns=a.max_turns)
    v = verify(traj, sc, evaluator)
    print(traj.transcript())
    print("\n" + json.dumps(v.to_dict(), ensure_ascii=False, indent=2))
    return 0 if v.passed else 1


def _eval(a) -> int:
    """Measure a skill on a split N times; report mean and spread (no training)."""
    from .bench import evaluate_repeated
    skill = Path(a.skill)
    tasks = load_tasks(Path(a.tasks))
    tasks = [t for t in tasks if t.split == a.split] if a.split != "all" else tasks
    if not tasks:
        print(f"no tasks in split {a.split!r}", file=sys.stderr)
        return 2
    roles = _roles(a)
    a.runner = a.runner or "pytest"
    runner = _runner(a, roles)                        # never cached: spread is the point
    res = evaluate_repeated(skill, tasks, runner, repeat=a.repeat, metric=a.gate_metric)
    d = res.to_dict()
    print(json.dumps(d, ensure_ascii=False, indent=2) if a.json else
          f"{a.split}: scores={d['scores']} mean={d['mean']} spread={d['spread']} "
          f"stdev={d['stdev']}\nunstable tasks: {d['unstable_tasks'] or 'none'}")
    calls, cost = 0, 0.0
    for b in {id(x): x for x in (roles.fast_proposer, roles.slow_proposer, roles.evaluator,
                                 roles.target) if x is not None}.values():
        calls += getattr(getattr(b, "stats", None), "calls", 0)
        cost += getattr(getattr(b, "stats", None), "cost_usd", 0.0)
    print(f"calls={calls} cost=${cost:.4f}")
    return 0


def _bench(a) -> int:
    """Train every seeded case under each configuration; print the table."""
    from .bench import run_bench
    from .runner import AgentRunner
    roles = _roles(a)
    base = dict(rounds=a.rounds, fast_iters=a.fast_iters, enable_slow_update=not a.no_slow_update,
                enable_meta_skill=not a.no_meta_skill, evolve_tests_every=a.tests_every)
    pyr = PyramidConfig(use_bandit=not a.no_bandit, use_pyright=not a.no_pyright)

    def make(**fast_kw):
        def _cfg(meta):
            return TrainConfig(**base, fast=FastConfig(k_samples=a.k, budget_p2=a.budget_p2,
                                                       enable_p3=not a.no_p3, pyramid=pyr,
                                                       **fast_kw))
        return _cfg
    configs = {"full": make()}
    if a.ablate:
        configs.update({
            "first-wins": make(best_of_k=False),
            "no-refine": make(refine_rounds=0),
            "no-dedup": make(dedup=False),
        })

    def make_runner(meta, roles_):
        kind = meta.get("runner", "pytest")
        if kind == "agent":
            return AgentRunner(roles_.evaluator_target(), roles_.evaluator,
                               judge_samples=a.judge_samples, workers=a.workers)
        return PytestRunner(subdir=meta.get("test_dir", "tests/unit"))

    report = run_bench(Path(a.cases), configs=configs, roles=roles, make_runner=make_runner,
                       work_root=Path(a.work), only=a.only.split(",") if a.only else None,
                       repeat=a.repeat, jobs=a.jobs, make_roles=lambda: _roles(a))
    md = report.markdown()
    print(md)
    if a.out:
        Path(a.out).write_text(json.dumps(report.to_dict(), indent=2), encoding="utf-8")
        Path(a.out).with_suffix(".md").write_text(md + "\n", encoding="utf-8")
        print(f"\nwritten: {a.out}, {Path(a.out).with_suffix('.md')}")
    return 0


def _status(a) -> int:
    skill = Path(a.skill)
    evo = skill / ".evo"
    staged = latest(evo / "staging")
    info = {
        "skill": str(skill),
        "bootstrapped": (evo / "baseline").exists(),
        "entrypoints": len(load_contract(skill).entrypoints),
        "latest_staging": str(staged) if staged else None,
        "adopted": bool(staged and (staged / "adopted.json").exists()),
        "wiki_patterns": len(list((evo / "wiki" / "patterns").glob("*.md")))
        if (evo / "wiki" / "patterns").is_dir() else 0,
        "provenance_records": sum(
            1 for _ in (evo / "provenance.jsonl").read_text().splitlines()
        ) if (evo / "provenance.jsonl").exists() else 0,
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    if staged and (staged / "report.md").exists() and not a.json:
        print("\n" + (staged / "report.md").read_text(encoding="utf-8"))
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser("whet", description="SkillWhet — sharpen agent skills")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("contract"); cs = c.add_subparsers(dest="sub", required=True)
    ci = cs.add_parser("init"); ci.add_argument("skill")
    ci.add_argument("--allow", default=""); ci.set_defaults(fn=_contract_init)
    cy = cs.add_parser("sync"); cy.add_argument("skill")
    cy.add_argument("--write", action="store_true"); cy.set_defaults(fn=_contract_sync)

    g = sub.add_parser("gate", help="run the free gate pyramid G0-G5")
    g.add_argument("skill")
    g.add_argument("--json", action="store_true")
    g.add_argument("--verbose", "-v", action="store_true")
    g.add_argument("--no-bandit", action="store_true")
    g.add_argument("--no-pyright", action="store_true")
    g.add_argument("--no-tests", action="store_true")
    g.add_argument("--no-short-circuit", action="store_true")
    g.add_argument("--max-complexity", type=int, default=10)
    g.set_defaults(fn=_gate)

    f = sub.add_parser("facts"); f.add_argument("skill"); f.set_defaults(fn=_facts)

    b = sub.add_parser("bootstrap", help="freeze S0, derive contract, capture ledger")
    b.add_argument("skill"); b.add_argument("--allow", default="")
    b.set_defaults(fn=_bootstrap)

    t = sub.add_parser("train", help="run the evolution loop")
    t.add_argument("skill")
    t.add_argument("--tasks", default="", help="task JSON; omit to derive from tests")
    t.add_argument("--save-tasks", default="")
    t.add_argument("--test-dir", default="tests/unit")
    t.add_argument("--runner", default="pytest",
                   choices=["pytest", "agent", "simulate", "mixed"],
                   help="pytest: tasks are node ids; agent: exact/rubric/rule tasks "
                        "judged by the evaluator; simulate: multi-turn scenarios; "
                        "mixed: dispatch per task")
    t.add_argument("--target-model", default="",
                   help="frozen model the skill is loaded into for agent/simulate "
                        "runners (default: the fast model)")
    t.add_argument("--rounds", type=int, default=4)
    t.add_argument("--resume", action="store_true",
                   help="continue an interrupted run from its last completed round (.evo/checkpoint.json); "
                        "falls back to a fresh run when the checkpoint does not match")
    t.add_argument("--fast-iters", type=int, default=3)
    t.add_argument("--edit-budget", type=int, default=4)
    t.add_argument("-k", type=int, default=4, help="samples per defect (fast loop)")
    t.add_argument("--budget-p2", type=int, default=6)
    t.add_argument("--budget-p3", type=int, default=4)
    t.add_argument("--val-fraction", type=float, default=0.25)
    t.add_argument("--test-fraction", type=float, default=0.25)
    t.add_argument("--gate-metric", default="mixed", choices=["hard", "soft", "mixed"])
    t.add_argument("--allow-regression", action="store_true")
    t.add_argument("--no-slow-loop", action="store_true")
    t.add_argument("--no-p1", action="store_true")
    t.add_argument("--no-p3", action="store_true")
    t.add_argument("--no-bandit", action="store_true")
    t.add_argument("--no-pyright", action="store_true")
    for role in ("fast", "slow", "eval"):
        t.add_argument(f"--{role}-backend", default="claude",
                       help="claude (default, uses `claude -p`) | mock | <openai-compatible>")
        t.add_argument(f"--{role}-model", default="")
    t.add_argument("--mutation-floor", type=float, default=0.0)
    t.add_argument("--no-replay", action="store_true", help="skip G6 per-patch replay")
    t.add_argument("--no-slow-update", action="store_true")
    t.add_argument("--no-meta-skill", action="store_true")
    t.add_argument("--judge-samples", type=int, default=1,
                   help="rubric judge verdicts per task; the median is used (3 recommended)")
    t.add_argument("--workers", type=int, default=4, help="parallel agent roll-outs")
    t.add_argument("--synthesize-every", type=int, default=0,
                   help="grow the train set with variants of agent tasks every k rounds (0 = off)")
    t.add_argument("--synth-budget", type=int, default=4)
    t.add_argument("--counterfactual-budget", type=int, default=0,
                   help="roll-outs per round for prose-section ablation (0 = off)")
    t.add_argument("--retire-budget", type=int, default=0,
                   help="roll-outs per round for retiring guidance lines (0 = off)")
    t.add_argument("--no-cache", action="store_true", help="do not memoise agent roll-outs")
    t.add_argument("--pairwise-judge", action="store_true",
                   help="G7 as a side-by-side sign test (candidate vs current answers) for rubric tasks")
    t.add_argument("--first-wins", action="store_true",
                   help="promote the first candidate that passes instead of the best of K")
    t.add_argument("--refine", type=int, default=1,
                   help="re-ask a rejected candidate with the gate findings this many times")
    t.add_argument("--no-dedup", action="store_true")
    t.add_argument("--escalate-after", type=int, default=2,
                   help="rounds a defect resists before the slow model proposes for it")
    t.add_argument("--progress", default="", help="append progress events (JSONL) here")
    t.add_argument("--max-cost-usd", type=float, default=0.0, help="stop after the round that crosses this")
    t.add_argument("--max-minutes", type=float, default=0.0, help="stop after the round that crosses this")
    t.add_argument("--eval-test", action="store_true",
                   help="also score the test split at the end (legacy; normally `whet release-eval` does it once)")
    t.add_argument("--no-leak-check", action="store_true", help="skip the G8 task-data leak check")
    t.add_argument("--no-accept-rounds", type=int, default=0,
                   help="stop after N consecutive rounds without an accepted round (0 = off)")
    t.add_argument("--tests-every", type=int, default=2,
                   help="evolve tests on every Nth round (0 = never)")
    t.set_defaults(fn=_train)

    ad = sub.add_parser("adopt", help="apply a staged round to the live skill")
    ad.add_argument("skill"); ad.add_argument("--staging", default="")
    ad.add_argument("--force", action="store_true", help="adopt an unaccepted round / over a drifted skill")
    ad.add_argument("--no-release", action="store_true",
                    help="adopt without a release evaluation on the test split (ha release-once)")
    ad.set_defaults(fn=_adopt)

    re_ = sub.add_parser("release-eval", help="score S0 and a staged candidate ONCE on the test split")
    re_.add_argument("skill"); re_.add_argument("--staging", required=True)
    re_.add_argument("--tasks", required=True)
    re_.add_argument("--runner", default="pytest", choices=["pytest", "agent", "simulate", "mixed"])
    re_.add_argument("--test-dir", default="tests/unit")
    re_.add_argument("--judge-samples", type=int, default=1)
    re_.add_argument("--workers", type=int, default=4)
    re_.add_argument("--gate-metric", default="mixed", choices=["hard", "soft", "mixed"])
    re_.add_argument("--target-model", default="")
    re_.add_argument("--progress", default="")
    for role in ("fast", "slow", "eval"):
        re_.add_argument(f"--{role}-backend", default="claude")
        re_.add_argument(f"--{role}-model", default="")
    re_.set_defaults(fn=_release_eval)

    ev = sub.add_parser("eval", help="measure a skill N times on a split; report the spread")
    ev.add_argument("skill"); ev.add_argument("--tasks", required=True)
    ev.add_argument("--split", default="val", choices=["train", "val", "test", "all"])
    ev.add_argument("--repeat", type=int, default=3)
    ev.add_argument("--runner", default="pytest", choices=["pytest", "agent", "simulate", "mixed"])
    ev.add_argument("--test-dir", default="tests/unit")
    ev.add_argument("--judge-samples", type=int, default=1)
    ev.add_argument("--workers", type=int, default=4)
    ev.add_argument("--gate-metric", default="mixed", choices=["hard", "soft", "mixed"])
    ev.add_argument("--target-model", default="")
    ev.add_argument("--json", action="store_true")
    for role in ("fast", "slow", "eval"):
        ev.add_argument(f"--{role}-backend", default="claude")
        ev.add_argument(f"--{role}-model", default="")
    ev.set_defaults(fn=_eval)

    bn = sub.add_parser("bench", help="train every seeded case under each config; print a table")
    bn.add_argument("--cases", default="examples/bench")
    bn.add_argument("--work", default=".bench-work")
    bn.add_argument("--out", default="", help="write JSON (+ .md) report here")
    bn.add_argument("--only", default="", help="comma-separated case names")
    bn.add_argument("--ablate", action="store_true", help="also run first-wins / no-refine / no-dedup")
    bn.add_argument("--repeat", type=int, default=1, help="runs per (case, config); spread is reported")
    bn.add_argument("--jobs", type=int, default=1, help="parallel runs (each with its own backends)")
    bn.add_argument("--rounds", type=int, default=2)
    bn.add_argument("--fast-iters", type=int, default=2)
    bn.add_argument("-k", type=int, default=3)
    bn.add_argument("--budget-p2", type=int, default=4)
    bn.add_argument("--tests-every", type=int, default=0)
    bn.add_argument("--judge-samples", type=int, default=1)
    bn.add_argument("--workers", type=int, default=4)
    bn.add_argument("--no-p3", action="store_true"); bn.add_argument("--no-bandit", action="store_true")
    bn.add_argument("--no-pyright", action="store_true"); bn.add_argument("--no-slow-update", action="store_true")
    bn.add_argument("--no-meta-skill", action="store_true")
    bn.add_argument("--target-model", default="")
    for role in ("fast", "slow", "eval"):
        bn.add_argument(f"--{role}-backend", default="claude")
        bn.add_argument(f"--{role}-model", default="")
    bn.set_defaults(fn=_bench)

    st = sub.add_parser("status"); st.add_argument("skill")
    st.add_argument("--json", action="store_true"); st.set_defaults(fn=_status)

    pr = sub.add_parser("probe", help="check a backend returns parseable JSON for every schema")
    pr.add_argument("--backend", default="claude"); pr.add_argument("--model", default="haiku")
    pr.set_defaults(fn=_probe)

    hv = sub.add_parser("harvest", help="mine tasks from Claude Code transcripts")
    hv.add_argument("--transcripts", default="~/.claude/projects")
    hv.add_argument("--out", default="tasks.json", help="write tasks file here (empty = skip)")
    hv.add_argument("--since", default=""); hv.add_argument("--limit", type=int, default=60)
    hv.add_argument("--project", default="", help="substring filter on project path")
    hv.add_argument("--max-tasks", type=int, default=40)
    hv.add_argument("--val-fraction", type=float, default=0.25)
    hv.add_argument("--test-fraction", type=float, default=0.25)
    hv.add_argument("--dry-run", action="store_true", help="list sessions, no model calls")
    hv.add_argument("--backend", default="claude"); hv.add_argument("--model", default="")
    # ha S3-01/03:反馈叠加层、会话白名单、机器可读输出
    hv.add_argument("--feedback", default="", help="Prism feedback-overlay.json (votes by assistant message uuid)")
    hv.add_argument("--sessions", default="", help="file with allowed session ids (JSON array or one per line)")
    hv.add_argument("--skill", default="", help="skill_hint to stamp on mined tasks")
    hv.add_argument("--any-skill", action="store_true",
                    help="mine every whitelisted session, not only those that used --skill")
    hv.add_argument("--json", action="store_true", help="print the result as JSON")
    hv.add_argument("--json-out", default="", help="write {sessions, tasks, stats} JSON here")
    hv.add_argument("--progress", default="", help="append JSONL progress events here")
    hv.set_defaults(fn=_harvest)

    sm = sub.add_parser("simulate", help="one multi-turn user simulation against a skill")
    sm.add_argument("skill"); sm.add_argument("--scenario", required=True)
    sm.add_argument("--max-turns", type=int, default=10)
    for role in ("fast", "eval"):
        sm.add_argument(f"--{role}-backend", default="claude")
        sm.add_argument(f"--{role}-model", default="")
    sm.set_defaults(fn=_simulate)

    sv = sub.add_parser("serve", help="loopback HTTP face for the platform (Prism); phase-1 surface")
    sv.add_argument("--host", default="127.0.0.1")
    sv.add_argument("--port", type=int, default=8093)
    sv.add_argument("--home", default="~/.prism/skillwhet", help="work / tasks / jobs / tmp root")
    sv.add_argument("--token", default="", help="shared secret; default from SKILLWHET_TOKEN")
    sv.set_defaults(fn=_serve)
    return p


def _serve(a) -> int:
    from .server import main_serve
    return main_serve(a)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
