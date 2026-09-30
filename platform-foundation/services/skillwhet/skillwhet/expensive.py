"""The three expensive gates: G6 per-patch replay, G7 hold-out, G8 governance.

They live together because they share the roll-out budget and only run on
candidates that already cleared every free gate.
"""
from __future__ import annotations

import re

import json
import shutil
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .fs import iter_skill_files
from .bundle import materialize
from .contract import load_contract
from .backend import Backend, extract_json
from .evidence import ExecRecord, TaskRecord
from .ledger import Ledger, Violation
from .runner import Runner
from .types import Bundle, Contract

# ── G6: per-patch replay ────────────────────────────────────────────────────

TRANSITION_SCORES = {
    ("fail", "pass"): 3.0,      # repaired
    ("pass", "pass"): 2.0,      # preserved
    ("fail", "fail"): 1.0,      # inert
    ("pass", "fail"): 0.0,      # REGRESSION — the case an aggregate gate misses
}
ACCEPT_THRESHOLD = 2.0


@dataclass
class ReplayVerdict:
    digest: str
    score: float
    accepted: bool
    repaired: int = 0
    preserved: int = 0
    inert: int = 0
    regressed: int = 0
    regressed_tasks: list[str] = field(default_factory=list)
    unscored: int = 0

    def to_dict(self) -> dict:
        return asdict(self)


def replay_candidate(
    cand_dir: Path, tasks: list[TaskRecord], runner: Runner,
    *, baseline: list[ExecRecord], digest: str = "",
    threshold: float = ACCEPT_THRESHOLD, allow_inert: bool = False,
    weights: dict[str, float] | None = None,
) -> ReplayVerdict:
    """Score an already-materialised candidate by outcome transition, per task.

    ``allow_inert``: accept a change that repairs nothing as long as it breaks
    nothing (deterministic P1 rule fixes); model-proposed repairs must repair.

    An aggregate gate cannot see "helps on average, quietly breaks one task that
    used to pass". This can: any pass->fail transition scores 0.0 and drags the
    mean below the threshold. (SkillCAT 2606.13317.)
    """
    before = {r.task_id: r for r in baseline}
    after = {r.task_id: r for r in runner.run(cand_dir, tasks)}
    v = ReplayVerdict(digest=digest, score=0.0, accepted=False)
    total = 0.0
    scored = 0.0
    for t in tasks:
        rb, ra = before.get(t.id), after.get(t.id)
        if (rb is not None and not rb.scored) or (ra is not None and not ra.scored):
            v.unscored += 1                      # evaluation noise: no verdict
            continue
        # A task that flipped recently is on the frontier and weighs more in the
        # ranking mean (§1.2); the accept/reject verdict below is unweighted.
        w = float((weights or {}).get(t.id, 1.0)) or 1.0
        scored += w
        b = "pass" if (rb is not None and rb.passed) else "fail"
        a = "pass" if (ra is not None and ra.passed) else "fail"
        total += TRANSITION_SCORES[(b, a)] * w
        if (b, a) == ("fail", "pass"):
            v.repaired += 1
        elif (b, a) == ("pass", "pass"):
            v.preserved += 1
        elif (b, a) == ("fail", "fail"):
            v.inert += 1
        else:
            v.regressed += 1
            v.regressed_tasks.append(t.id)

    v.score = total / max(1.0, scored)
    # A single regression is disqualifying regardless of the mean: interference
    # is weighted far above raw pass gain by design. Beyond that the rule is
    # "no regression AND at least one repair": the old mean-threshold rejected
    # a correct fix whenever it repaired fewer than half of the still-failing
    # tasks, because fail->fail scores 1.0 and drags the mean under 2.0
    # (audit B2). The mean survives as a ranking key, not a verdict.
    v.accepted = v.regressed == 0 and (v.repaired >= 1 or (allow_inert and scored > 0))
    return v


def replay_patch(
    skill_dir: Path, bundle: Bundle, tasks: list[TaskRecord], runner: Runner,
    *, work_root: Path, baseline: list[ExecRecord] | None = None,
    threshold: float = ACCEPT_THRESHOLD,
) -> ReplayVerdict:
    """Convenience wrapper: materialise the bundle, then ``replay_candidate``."""
    base = baseline or runner.run(skill_dir, tasks)
    work = Path(work_root) / f"replay-{bundle.digest()}"
    try:
        cand, _ = materialize(skill_dir, bundle, work)
        return replay_candidate(cand, tasks, runner, baseline=base,
                                digest=bundle.digest(), threshold=threshold)
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── G7: held-out aggregate gate ─────────────────────────────────────────────


@dataclass
class GateDecision:
    action: str                       # accept_new_best | accept | reject
    candidate_score: float
    current_score: float
    best_score: float
    metric: str = "mixed"
    formula: str = ""
    regressed_tasks: list[str] = field(default_factory=list)

    @property
    def accepted(self) -> bool:
        return self.action in ("accept", "accept_new_best")

    def to_dict(self) -> dict:
        return asdict(self)


def select_score(hard: float, soft: float, metric: str = "mixed",
                 w: float = 0.5) -> float:
    if metric == "hard":
        return hard
    if metric == "soft":
        return soft
    if metric == "mixed":
        w = max(0.0, min(1.0, w))
        return (1.0 - w) * hard + w * soft
    raise ValueError(f"unknown gate metric {metric!r}")


def aggregate(records: list[ExecRecord]) -> tuple[float, float]:
    """Mean hard/soft over SCORED records; evaluation noise is not a verdict."""
    records = [r for r in records if r.scored]
    if not records:
        return 0.0, 0.0
    return (sum(r.hard for r in records) / len(records),
            sum(r.soft for r in records) / len(records))


def holdout_gate(
    candidate_records: list[ExecRecord],
    current_score: float,
    best_score: float,
    *,
    metric: str = "mixed",
    mixed_weight: float = 0.5,
    baseline_records: list[ExecRecord] | None = None,
    no_regression: bool = False,
    tie_ok: bool = False,
) -> GateDecision:
    """Strictly greater by default, so a tie is a rejection and the skill never
    drifts. ``tie_ok`` lets a tie through when the caller has independent
    evidence of progress (G6-verified repairs on train this round); a tiny val
    slice cannot see a fix to a task it does not contain, and rejecting every
    such round threw real repairs away (audit B4/1.8).
    """
    hard, soft = aggregate(candidate_records)
    cand = select_score(hard, soft, metric, mixed_weight)
    formula = (f"score = (1-{mixed_weight})*hard + {mixed_weight}*soft; "
               f"candidate = (1-{mixed_weight})*{hard:.3f} + "
               f"{mixed_weight}*{soft:.3f} = {cand:.3f}; current = {current_score:.3f}")

    regressed: list[str] = []
    if no_regression and baseline_records:
        before = {r.task_id: r for r in baseline_records}
        for r in candidate_records:
            b = before.get(r.task_id)
            if b is None or not r.scored or not b.scored:
                continue
            if not (r.hard == r.hard) or r.hard < b.hard:   # NaN counts as regression
                regressed.append(r.task_id)

    if regressed or cand < current_score or (cand == current_score and not tie_ok):
        return GateDecision("reject", cand, current_score, best_score,
                            metric, formula, regressed)
    if cand > best_score:
        return GateDecision("accept_new_best", cand, cand, cand, metric, formula)
    return GateDecision("accept", cand, cand, best_score, metric, formula)


# ── G7 (pairwise): candidate vs current, judged side by side ────────────────

_PAIR_SYSTEM = """Two answers to the same request are shown. Decide which one better
satisfies the rubric. Judge KNOWLEDGE CONTENT: correctness, completeness against
the rubric. Ignore length, tone and formatting.

Return ONLY {"winner": "A" | "B" | "tie", "reason": "<one line>"}"""


@dataclass
class PairwiseDecision:
    action: str                     # accept_new_best | accept | reject
    wins: int
    losses: int
    ties: int
    per_task: dict[str, str] = field(default_factory=dict)   # task id -> A/B/tie/inconsistent
    formula: str = ""

    @property
    def accepted(self) -> bool:
        return self.action in ("accept", "accept_new_best")

    def to_dict(self) -> dict:
        return asdict(self)


def pairwise_judge(judge: Backend, rubric: str, intent: str, current: str, candidate: str,
                   *, max_tokens: int = 300) -> str:
    """'candidate' | 'current' | 'tie' — asked in BOTH orders; disagreement is a tie.

    An absolute 0..1 score drifts with the judge's mood (measured: the same
    answer scored 0.95 twice and 0.365 once). A forced choice between two
    answers to the same rubric is what a judge is actually reliable at, and
    swapping positions cancels the well-known first-position bias.
    """
    def ask(a: str, b: str) -> str:
        payload = json.dumps({"request": intent[:1500], "rubric": rubric[:1500],
                              "A": a[:5000], "B": b[:5000]}, ensure_ascii=False)
        try:
            raw = judge.complete(payload, system=_PAIR_SYSTEM, stage="judge.pair",
                                 max_tokens=max_tokens)
        except Exception:  # noqa: BLE001
            return "tie"
        d = extract_json(raw) or {}
        w = str(d.get("winner", "tie")).strip().upper()
        return w if w in ("A", "B") else "tie"

    first = ask(current, candidate)          # A = current, B = candidate
    second = ask(candidate, current)         # A = candidate, B = current
    cand_first = {"A": "current", "B": "candidate", "tie": "tie"}[first]
    cand_second = {"A": "candidate", "B": "current", "tie": "tie"}[second]
    if cand_first == cand_second:
        return cand_first
    if "tie" in (cand_first, cand_second):
        return "tie"
    return "tie"                             # the two orders disagree: no signal


def pairwise_gate(
    candidate_records: list[ExecRecord], current_records: list[ExecRecord],
    tasks: list[TaskRecord], judge: Backend, *, tie_ok: bool = False,
    min_margin: int = 1,
) -> PairwiseDecision:
    """Sign test over val tasks: accept when candidate wins more tasks than it loses.

    Only rubric tasks are judged pairwise; exact/rule tasks keep their
    deterministic verdicts (a pass beats a fail, equal verdicts tie).
    """
    cur = {r.task_id: r for r in current_records}
    wins = losses = ties = 0
    per: dict[str, str] = {}
    for t in tasks:
        a, b = cur.get(t.id), next((r for r in candidate_records if r.task_id == t.id), None)
        if a is None or b is None or not a.scored or not b.scored:
            continue
        if t.reference_kind != "rubric":
            v = "candidate" if b.hard > a.hard else "current" if a.hard > b.hard else "tie"
        elif a.stdout.strip() == b.stdout.strip():
            v = "tie"
        else:
            v = pairwise_judge(judge, t.reference, t.intent, a.stdout, b.stdout)
        per[t.id] = v
        if v == "candidate":
            wins += 1
        elif v == "current":
            losses += 1
        else:
            ties += 1
    formula = f"pairwise sign test: {wins} wins / {losses} losses / {ties} ties"
    if wins - losses >= min_margin:
        return PairwiseDecision("accept_new_best", wins, losses, ties, per, formula)
    if wins == losses and tie_ok and losses == 0:
        return PairwiseDecision("accept", wins, losses, ties, per, formula)
    return PairwiseDecision("reject", wins, losses, ties, per, formula)


# ── G8: governance ──────────────────────────────────────────────────────────

FILE_SPLIT_THRESHOLD = 700
DESCRIPTION_BLOAT_WORDS = 400
MAX_ADVICE_PER_FILE = 3


@dataclass
class GovernanceResult:
    passed: bool                                  # hard constraint only
    violations: list[Violation] = field(default_factory=list)
    advice: list[dict] = field(default_factory=list)   # soft: merged into next round
    bloat_ratio: float = 0.0

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "violations": [v.to_dict() for v in self.violations],
            "advice": self.advice,
            "bloat_ratio": round(self.bloat_ratio, 4),
        }


def _line_count(skill_dir: Path) -> int:
    n = 0
    for p in iter_skill_files(skill_dir, (".md", ".py")):
        n += len(p.read_text(encoding="utf-8", errors="replace").splitlines())
    return n


_TOKEN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*|\d+(?:[.,:/-]\d+)*%?|[\u4e00-\u9fff]")
LEAK_N = 5                 # n-gram length that trips the check when it carries a distinctive number
LEAK_N_PLAIN = 12          # without such a number the overlap must be much longer (prose, CJK chars repeat)
MAX_LEAK_REPORTS = 5
MAX_SOURCE_CHARS = 4000


def _toks(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN.findall(text)]


def _distinctive_number(tok: str) -> bool:
    """项目里的具体数值:至少两位数字,或带小数点 / 千分位 / 百分号 / 日期分隔。'1'、'v2' 不算。"""
    if not tok[:1].isdigit():
        return False
    digits = sum(ch.isdigit() for ch in tok)
    return digits >= 2 or any(ch in tok for ch in ".,:/-%")


def _ngrams(tokens: list[str], n: int) -> set[tuple[str, ...]]:
    return {tuple(tokens[i:i + n]) for i in range(len(tokens) - n + 1)}


def _grams(tokens: list[str]) -> tuple[set, set]:
    g5 = {g for g in _ngrams(tokens, LEAK_N) if any(_distinctive_number(t) for t in g)}
    return g5, _ngrams(tokens, LEAK_N_PLAIN)


class LeakIndex:
    """任务数据的 n-gram 索引,一次 train 只建一次(每轮都重建会很慢)。

    只放 **val / test** 的文本 —— 从 train 失败里学到东西写进文档是正常的学习,
    文档里出现 val / test 的具体内容才是泄漏(选择集被背下来了)。"""

    def __init__(self, sources: list[str]) -> None:
        self.g5: set[tuple[str, ...]] = set()
        self.gp: set[tuple[str, ...]] = set()
        for text in sources:
            a, b = _grams(_toks(text[:MAX_SOURCE_CHARS]))
            self.g5 |= a
            self.gp |= b

    def __bool__(self) -> bool:
        return bool(self.g5 or self.gp)


def leak_suspects(skill_dir: Path, baseline_dir: Path, sources: "list[str] | LeakIndex") -> list[tuple[str, str, tuple[str, ...]]]:
    """ha S3-05:文档里的新内容与任务数据共享一段有辨识度的 n-gram。

    "新"按 n-gram 算,不按整行:S₀ 文档里本来就有的 n-gram 一律不算(改一行里的一个词,
    不会让这行其余部分都成了"新的")。命中 = 带具体数值的 5-gram,或 12-gram。
    """
    index = sources if isinstance(sources, LeakIndex) else LeakIndex(sources)
    if not index:
        return []
    old5: set = set()
    oldp: set = set()
    for p in iter_skill_files(baseline_dir, (".md",)):
        a, b = _grams(_toks(p.read_text(encoding="utf-8", errors="replace")))
        old5 |= a
        oldp |= b
    hits: list[tuple[str, str, tuple[str, ...]]] = []
    for p in iter_skill_files(skill_dir, (".md",)):
        rel = p.relative_to(skill_dir).as_posix()
        for ln in p.read_text(encoding="utf-8", errors="replace").splitlines():
            line = ln.strip()
            if not line:
                continue
            a, b = _grams(_toks(line))
            gram = next(iter((a - old5) & index.g5), None) or next(iter((b - oldp) & index.gp), None)
            if gram:
                hits.append((rel, line, gram))
                if len(hits) >= MAX_LEAK_REPORTS:
                    return hits
    return hits


def govern(
    skill_dir: Path,
    *,
    baseline_dir: Path,
    prev_dir: Path | None,
    ledger: Ledger,
    contract: Contract,
    passing_tests: list[str] | None = None,
    leak_sources: "list[str] | LeakIndex | None" = None,
) -> GovernanceResult:
    """Dual-anchor fact consistency (hard) + structural diagnosis (soft).

    Two anchors, because one cannot tell the two failure directions apart:
    against S0 you see knowledge accumulated-and-lost across rounds; against
    S_{t-1} you see errors introduced in this round. With only S0 the repair
    direction is ambiguous.
    """
    skill_dir, baseline_dir = Path(skill_dir), Path(baseline_dir)

    violations = ledger.check(skill_dir, contract, passing_tests)   # anchor: S0

    if prev_dir is not None and Path(prev_dir).exists():            # anchor: S_{t-1}
        prev_eps = {f"{e.module}::{e.id}" for e in load_contract(prev_dir).entrypoints}
        now_eps = {f"{e.module}::{e.id}" for e in contract.entrypoints}
        for gone in sorted(prev_eps - now_eps):
            violations.append(Violation(
                "entrypoint", gone,
                "entrypoint removed in THIS round (regression introduced now, "
                "not accumulated drift)", "prev",
            ))

    if leak_sources:
        for rel, line, gram in leak_suspects(skill_dir, baseline_dir, leak_sources):
            violations.append(Violation(
                "leak_suspect", rel,
                f"new doc line shares {' '.join(gram)!r} with task data — the doc is "
                f"memorising a task, not describing the skill: {line[:120]!r}", "tasks",
            ))

    base_lines = _line_count(baseline_dir) or 1
    bloat = (_line_count(skill_dir) - base_lines) / base_lines

    advice: list[dict] = []
    for p in iter_skill_files(skill_dir, (".md",)):
        rel = p.relative_to(skill_dir).as_posix()
        text = p.read_text(encoding="utf-8")
        lines = text.splitlines()
        per_file: list[dict] = []
        if len(lines) >= FILE_SPLIT_THRESHOLD:
            per_file.append({"type": "split_file", "target": rel, "priority": "high",
                             "reason": f"{len(lines)} lines, at or above the "
                                       f"{FILE_SPLIT_THRESHOLD}-line threshold"})
        heads = [ln.strip().lstrip("#").strip().lower()
                 for ln in lines if ln.strip().startswith("#")]
        dupes = {h for h in heads if heads.count(h) > 1 and h}
        for d in sorted(dupes)[:2]:
            per_file.append({"type": "merge_sections", "target": f"{rel}#{d}",
                             "priority": "medium",
                             "reason": "duplicate heading; sections likely overlap"})
        if rel == "SKILL.md":
            m = text.split("---")
            if len(m) > 2 and len(m[1].split()) > DESCRIPTION_BLOAT_WORDS:
                per_file.append({"type": "trim_description", "target": rel,
                                 "priority": "medium",
                                 "reason": f"frontmatter exceeds "
                                           f"{DESCRIPTION_BLOAT_WORDS} words"})
        advice.extend(per_file[:MAX_ADVICE_PER_FILE])

    return GovernanceResult(passed=not violations, violations=violations,
                            advice=advice, bloat_ratio=bloat)
