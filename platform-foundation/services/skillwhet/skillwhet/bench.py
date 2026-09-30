"""Measurement without training (`whet eval`) and the seeded-case benchmark
(`whet bench`).

`evaluate_repeated` answers the question every single-number report hides:
how much of the score is the skill and how much is the judge? It runs the same
split N times and reports the spread. With a deterministic runner (pytest) the
spread is zero; with a rubric judge it is not, and `--judge-samples 3` exists
to shrink it.

`run_bench` is the harness for "standard benchmark numbers": a directory of
cases, each a skill with seeded defects and its task file, trained under one
or more configurations, with baseline / best / test / cost per case and the
mean across cases. A case is a directory:

    cases/<name>/skill/        the skill (with defects seeded)
    cases/<name>/tasks.json    train / val / test tasks
    cases/<name>/case.json     {"runner": "pytest"|"agent", "defects": [...], "notes": "..."}
"""
from __future__ import annotations

import json
import shutil
import statistics
import time
from dataclasses import dataclass, field
from pathlib import Path

from .evidence import TaskRecord, load_tasks
from .expensive import aggregate, select_score


@dataclass
class RepeatResult:
    scores: list[float]
    per_task: dict[str, list[float]]
    metric: str
    noise: int = 0                     # roll-outs that did not happen (backend/judge errors)

    @property
    def mean(self) -> float:
        return statistics.fmean(self.scores) if self.scores else 0.0

    @property
    def spread(self) -> float:
        return (max(self.scores) - min(self.scores)) if self.scores else 0.0

    @property
    def stdev(self) -> float:
        return statistics.pstdev(self.scores) if len(self.scores) > 1 else 0.0

    def to_dict(self) -> dict:
        return {"metric": self.metric, "scores": [round(s, 4) for s in self.scores],
                "mean": round(self.mean, 4), "spread": round(self.spread, 4),
                "stdev": round(self.stdev, 4), "noise_records": self.noise,
                "per_task": {k: [round(x, 3) for x in v] for k, v in self.per_task.items()},
                "unstable_tasks": sorted(k for k, v in self.per_task.items()
                                         if len(set(round(x, 2) for x in v if x == x)) > 1)}


def evaluate_repeated(skill_dir: Path, tasks: list[TaskRecord], runner, *,
                      repeat: int = 3, metric: str = "mixed", mixed_weight: float = 0.5) -> RepeatResult:
    """Same skill, same tasks, `repeat` times. Caching must be OFF for this."""
    scores: list[float] = []
    per: dict[str, list[float]] = {t.id: [] for t in tasks}
    noise = 0
    for _ in range(max(1, repeat)):
        recs = runner.run(Path(skill_dir), tasks)
        noise += sum(1 for r in recs if not r.scored)
        h, s = aggregate(recs)                      # noise excluded from the mean
        scores.append(select_score(h, s, metric, mixed_weight))
        for r in recs:
            if r.task_id in per:
                per[r.task_id].append(select_score(r.hard, r.soft, metric, mixed_weight)
                                      if r.scored else float("nan"))
    return RepeatResult(scores, per, metric, noise)


# ── benchmark ───────────────────────────────────────────────────────────────


@dataclass
class CaseResult:
    case: str
    config: str
    baseline: float
    best: float
    improved: bool
    test_baseline: float | None
    test_best: float | None
    rounds: int
    accepted: int
    cost_usd: float
    seconds: float
    error: str = ""
    repeat: int = 0

    def to_dict(self) -> dict:
        return {k: (round(v, 4) if isinstance(v, float) else v)
                for k, v in self.__dict__.items()}


@dataclass
class BenchReport:
    results: list[CaseResult] = field(default_factory=list)

    def by_config(self) -> dict[str, list[CaseResult]]:
        out: dict[str, list[CaseResult]] = {}
        for r in self.results:
            out.setdefault(r.config, []).append(r)
        return out

    def markdown(self) -> str:
        repeated = max((r.repeat for r in self.results), default=0) > 0
        head = "| config | case | rep | baseline | best | Δ | test S0 → best | rounds | accepted | cost | time |"
        lines = [head if repeated else head.replace(" rep |", ""),
                 "|---|---|---|---|---|---|---|---|---|---|---|" if repeated else "|---|---|---|---|---|---|---|---|---|---|"]
        for r in sorted(self.results, key=lambda x: (x.config, x.case, x.repeat)):
            rep = f" {r.repeat} |" if repeated else ""
            if r.error:
                lines.append(f"| {r.config} | {r.case} |{rep} — | — | — | — | — | — | — | ERROR: {r.error[:60]} |")
                continue
            t = ("—" if r.test_baseline is None else
                 f"{r.test_baseline:.3f} → {r.test_best:.3f}")
            lines.append(f"| {r.config} | {r.case} |{rep} {r.baseline:.3f} | {r.best:.3f} | "
                         f"{r.best - r.baseline:+.3f} | {t} | {r.rounds} | {r.accepted} | "
                         f"${r.cost_usd:.2f} | {r.seconds:.0f}s |")
        lines.append("")
        lines.append("| config | runs | mean Δ val | mean Δ test (± spread across repeats) | improved | total cost |")
        lines.append("|---|---|---|---|---|---|")
        for cfg_name, rs in self.by_config().items():
            ok = [r for r in rs if not r.error]
            if not ok:
                continue
            dv = statistics.fmean(r.best - r.baseline for r in ok)
            dt_vals = [r.test_best - r.test_baseline for r in ok
                       if r.test_baseline is not None and r.test_best is not None]
            dt = f"{statistics.fmean(dt_vals):+.3f}" if dt_vals else "—"
            if repeated and dt_vals:
                # spread of the per-repeat means: how much of the difference
                # between configs is noise
                by_rep: dict[int, list[float]] = {}
                for r in ok:
                    if r.test_baseline is not None and r.test_best is not None:
                        by_rep.setdefault(r.repeat, []).append(r.test_best - r.test_baseline)
                means = [statistics.fmean(v) for v in by_rep.values()]
                dt += f" ± {max(means) - min(means):.3f}"
            lines.append(f"| {cfg_name} | {len(ok)} | {dv:+.3f} | {dt} | "
                         f"{sum(r.improved for r in ok)}/{len(ok)} | ${sum(r.cost_usd for r in ok):.2f} |")
        return "\n".join(lines)

    def to_dict(self) -> dict:
        return {"results": [r.to_dict() for r in self.results]}


def load_cases(root: Path) -> list[Path]:
    root = Path(root)
    return sorted(p for p in root.iterdir()
                  if p.is_dir() and (p / "skill").is_dir() and (p / "tasks.json").exists())


def run_case(case_dir: Path, *, config_name: str, make_cfg, roles, make_runner,
             work_root: Path, repeat: int = 0) -> CaseResult:
    """Train one case under one config in a scratch copy; never touches the case."""
    from .trainer import bootstrap, train
    meta = {}
    if (case_dir / "case.json").exists():
        meta = json.loads((case_dir / "case.json").read_text(encoding="utf-8"))
    scratch = Path(work_root) / config_name / (case_dir.name if not repeat else f"{case_dir.name}-r{repeat}")
    if scratch.exists():
        shutil.rmtree(scratch)
    shutil.copytree(case_dir / "skill", scratch,
                    ignore=shutil.ignore_patterns(".evo", "__pycache__", ".pytest_cache"))
    tasks = load_tasks(case_dir / "tasks.json")
    t0 = time.time()
    try:
        bootstrap(scratch)
        cfg = make_cfg(meta)
        runner = make_runner(meta, roles)
        res = train(scratch, tasks, roles, runner, cfg=cfg)
        rep = json.loads((res.staging_dir / "report.json").read_text(encoding="utf-8")) \
            if res.staging_dir and (res.staging_dir / "report.json").exists() else {}
        return CaseResult(
            case=case_dir.name, config=config_name,
            baseline=res.baseline_score, best=res.best_score, improved=res.improved,
            test_baseline=rep.get("test_score_baseline"), test_best=rep.get("test_score_best"),
            rounds=len(res.rounds), accepted=sum(r.accepted_bundles for r in res.rounds),
            cost_usd=res.total_cost_usd, seconds=time.time() - t0, repeat=repeat,
        )
    except Exception as exc:  # noqa: BLE001 - one case must not end the benchmark
        return CaseResult(case=case_dir.name, config=config_name, baseline=0.0, best=0.0,
                          improved=False, test_baseline=None, test_best=None, rounds=0,
                          accepted=0, cost_usd=0.0, seconds=time.time() - t0,
                          error=f"{type(exc).__name__}: {exc}", repeat=repeat)


def run_bench(cases_root: Path, *, configs: dict[str, object], roles, make_runner,
              work_root: Path, only: list[str] | None = None, repeat: int = 1,
              jobs: int = 1, make_roles=None) -> BenchReport:
    """Every (case, config, repeat) triple; `jobs` of them at a time.

    Backends keep per-instance call/cost counters, so parallel runs need their
    own `Roles` — pass `make_roles` to build one per job; with one shared
    `roles` the benchmark runs sequentially regardless of `jobs`.
    """
    report = BenchReport()
    triples = [(case, name, make_cfg, rep)
               for case in load_cases(cases_root) if not only or case.name in only
               for name, make_cfg in configs.items()
               for rep in (range(1, repeat + 1) if repeat > 1 else [0])]
    if jobs <= 1 or make_roles is None:
        for case, name, make_cfg, rep in triples:
            report.results.append(run_case(case, config_name=name, make_cfg=make_cfg,
                                           roles=roles, make_runner=make_runner,
                                           work_root=work_root, repeat=rep))
        return report
    from concurrent.futures import ThreadPoolExecutor

    def one(t):
        case, name, make_cfg, rep = t
        return run_case(case, config_name=name, make_cfg=make_cfg, roles=make_roles(),
                        make_runner=make_runner, work_root=work_root, repeat=rep)
    with ThreadPoolExecutor(max_workers=jobs) as ex:
        report.results = list(ex.map(one, triples))
    return report
