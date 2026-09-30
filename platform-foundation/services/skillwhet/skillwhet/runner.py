"""Task execution: how a skill is scored on a set of tasks.

Two implementations ship:

``PytestRunner``  — the task set *is* the test suite. No agent, no model calls,
                    fully deterministic. This is what makes the whole loop
                    runnable end-to-end for a code-heavy skill.
``AgentRunner``   — a real roll-out: the skill is loaded into an agent's context
                    and the answer is judged. This is the expensive path the
                    slow loop's gate pays for.

Everything downstream (G6 replay, G7 hold-out gate) depends only on the Runner
protocol, so swapping harnesses does not touch the gates.
"""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Protocol

from . import pytestio
from .backend import Backend, extract_json
from .evidence import ExecRecord, TaskRecord, parse_traceback
from .sandbox import SandboxPolicy, run_sandboxed


class Runner(Protocol):
    def run(self, skill_dir: Path, tasks: list[TaskRecord]) -> list[ExecRecord]: ...


class PytestRunner:
    """Score a skill by running its tests. Zero model calls, fully sandboxed.

    Task ids are pytest node ids. A task not present in the run is recorded as a
    failure rather than skipped, so a candidate cannot improve its score by
    deleting the test that was failing.
    """

    name = "pytest"

    def __init__(self, subdir: str = "tests/unit",
                 policy: SandboxPolicy | None = None) -> None:
        self.subdir = subdir
        self.policy = policy or SandboxPolicy()

    def run(self, skill_dir: Path, tasks: list[TaskRecord]) -> list[ExecRecord]:
        skill_dir = Path(skill_dir)
        tdir = skill_dir / self.subdir
        if not tdir.is_dir():
            return [self._missing(t) for t in tasks]

        res = run_sandboxed(pytestio.argv(self.subdir, tb="native"), skill_dir, self.policy)
        out = (res.stdout or "") + "\n" + (res.stderr or "")
        status = pytestio.parse_verbose(out)
        blocks = pytestio.failure_blocks(out)

        records = []
        for t in tasks:
            st = status.get(t.id)
            if st in ("PASSED", "XPASS", "XFAIL"):
                records.append(ExecRecord(task_id=t.id, split=t.split, hard=1.0,
                                          soft=1.0, passed=True))
                continue
            block = blocks.get(pytestio.node_title(t.id), "")
            rec = parse_traceback(block, skill_dir=skill_dir) if block else ExecRecord("", "train")
            rec.task_id, rec.split = t.id, t.split
            rec.passed, rec.hard, rec.soft = False, 0.0, 0.0
            rec.stdout = block[-2000:]
            if st is None and not block:
                rec.exc_type = rec.exc_type or "NotCollected"
                rec.exc_message = rec.exc_message or "task not present in this run"
            records.append(rec)
        from .progress import task_done
        for rec in records:                       # hd:逐条上报(pytest 一次跑完,事后逐条报)
            task_done(rec)
        return records

    @staticmethod
    def _missing(t: TaskRecord) -> ExecRecord:
        return ExecRecord(task_id=t.id, split=t.split, passed=False,
                          exc_type="NoTests", exc_message="test directory missing")

    @staticmethod
    def _failure_block(out: str, node_id: str) -> str:
        return pytestio.failure_block(out, node_id)


class AgentRunner:
    """Load the skill into a frozen agent's context, then judge the answer.

    The model is frozen; only the skill text varies. That is the whole premise —
    any measured change is attributable to the skill.
    """

    name = "agent"

    def __init__(self, target: Backend, judge: Backend, *,
                 max_output_tokens: int = 2048, judge_samples: int = 1,
                 workers: int = 4) -> None:
        self.target = target
        self.judge = judge
        self.max_output_tokens = max_output_tokens
        # Rubric judging is noisy; the median of n verdicts is what G7 sees
        # (REVIEW §1.8). 1 keeps the old behaviour; 3 is the recommended value.
        self.judge_samples = max(1, judge_samples)
        self.workers = max(1, workers)

    def run(self, skill_dir: Path, tasks: list[TaskRecord]) -> list[ExecRecord]:
        skill_text = self._skill_text(Path(skill_dir))
        if self.workers == 1 or len(tasks) <= 1:
            return [self._one(t, skill_text) for t in tasks]
        from concurrent.futures import ThreadPoolExecutor
        import contextvars
        ctx = contextvars.copy_context()
        with ThreadPoolExecutor(max_workers=self.workers) as ex:
            return list(ex.map(lambda t: ctx.copy().run(self._one, t, skill_text), tasks))

    def _one(self, t: TaskRecord, skill_text: str) -> ExecRecord:
        # hd:每条任务跑完就上报一次(线程池里也行:run() 把上下文复制进了工作线程)
        import time as _t
        from .progress import task_done
        t0 = _t.monotonic()
        rec = self._one_inner(t, skill_text)
        if not rec.duration_ms:
            rec.duration_ms = (_t.monotonic() - t0) * 1000
        task_done(rec)
        return rec

    def _one_inner(self, t: TaskRecord, skill_text: str) -> ExecRecord:
        prompt = f"{t.intent}\n\n{t.context_excerpt}".strip()
        system = t.system or skill_text
        try:
            answer = self.target.complete(prompt, system=system, stage="rollout",
                                          max_tokens=self.max_output_tokens)
        except Exception as exc:  # noqa: BLE001
            # The roll-out did not happen: that is evaluation noise, not a
            # verdict on the skill. Marked so no aggregate counts it as a 0.
            return ExecRecord(task_id=t.id, split=t.split, passed=False,
                              exc_type="BackendError", exc_message=str(exc)[:200], noise=True)
        hard, soft, why = self._score(t, answer)
        if why in ("judge call failed",):
            return ExecRecord(task_id=t.id, split=t.split, passed=False, exc_type="JudgeError",
                              exc_message=why, stdout=answer[:2000], noise=True)
        return ExecRecord(
            task_id=t.id, split=t.split, hard=hard, soft=soft,
            passed=hard >= 1.0, stdout=answer[:2000],
            exc_type="" if hard >= 1.0 else "WrongAnswer",
            exc_message="" if hard >= 1.0 else why[:200],
            trajectory=[{"role": "system", "text": system[:1500]},
                        {"role": "user", "text": prompt[:1500]},
                        {"role": "assistant", "text": answer[:3000]},
                        {"role": "judge", "text": why[:500]}],
        )

    @staticmethod
    def _skill_text(skill_dir: Path) -> str:
        parts = []
        for name in ("SKILL.md",):
            p = skill_dir / name
            if p.exists():
                parts.append(p.read_text(encoding="utf-8"))
        for p in sorted((skill_dir / "references").glob("*.md")):
            parts.append(p.read_text(encoding="utf-8"))
        return "\n\n".join(parts)

    def _score(self, t: TaskRecord, answer: str) -> tuple[float, float, str]:
        if t.reference_kind == "exact":
            ok = t.reference.strip().lower() in answer.strip().lower()
            return (1.0 if ok else 0.0), (1.0 if ok else 0.0), "exact match failed"
        if t.reference_kind == "rule":
            return score_rule_judge(t.judge, answer)
        prompt = json.dumps({"rubric": t.reference, "response": answer[:6000]},
                            ensure_ascii=False)
        scores: list[float] = []
        reasons: list[str] = []
        for i in range(self.judge_samples):
            salted = prompt if self.judge_samples == 1 else f"{prompt}\n<!-- sample:{i} -->"
            try:
                raw = self.judge.complete(
                    salted, system='Score how well the response satisfies the rubric. '
                                   'Return ONLY {"score": <0..1>, "reason": "..."}',
                    stage="judge", max_tokens=400,
                    temperature=0.0 if self.judge_samples == 1 else 0.7)
            except Exception:  # noqa: BLE001
                continue
            d = extract_json(raw) or {}
            try:
                scores.append(max(0.0, min(1.0, float(d.get("score", 0)))))
                reasons.append(str(d.get("reason", ""))[:200])
            except (TypeError, ValueError):
                continue
        if not scores:
            return 0.0, 0.0, "judge call failed"
        scores.sort()
        soft = scores[len(scores) // 2]                  # median: robust to one wild verdict
        return (1.0 if soft >= 0.8 else 0.0), soft, reasons[len(reasons) // 2]


_REFUSAL = re.compile(
    r"(?i)\b(i(?:'m| am) (?:sorry|afraid|unable)|i can(?:'t|not) (?:help|assist|do|provide|comply)"
    r"|i (?:won't|will not) (?:be able to )?(?:help|assist|provide)|as an ai\b"
    r"|(?:cannot|can't|unable to) (?:help|assist) with (?:that|this)"
    r"|无法(?:帮助|协助|提供|完成)|不能(?:帮助|协助|提供)|抱歉[，,]?我(?:无法|不能))")


def _section(response: str, heading: str) -> str | None:
    """Body of the markdown section whose heading matches, or None."""
    want = heading.strip().lstrip("#").strip().lower()
    lines = response.splitlines()
    for i, ln in enumerate(lines):
        st = ln.strip()
        if st.startswith("#") and st.lstrip("#").strip().lower() == want:
            body = []
            for nxt in lines[i + 1:]:
                if nxt.strip().startswith("#"):
                    break
                body.append(nxt)
            return "\n".join(body)
    return None


def score_rule_judge(judge: dict, response: str,
                     tools_called: list[str] | None = None) -> tuple[float, float, str]:
    """Deterministic rule judge. hard = all checks pass; soft = fraction passed.

    Every op in KNOWN_OPS is implemented here. Three of them used to be no-ops
    that always passed — `no_refusal` let "I'm sorry, I can't help" score 1.0
    (audit C1) — and `validate_judge` could not warn because they were "known".
    """
    checks = judge.get("checks") or []
    if not checks:
        return 0.0, 0.0, "no checks"
    passed, failed = 0, []
    tools = set(tools_called or [])
    for c in checks:
        op, arg = c.get("op"), c.get("arg")
        ok = True
        if op == "contains":
            ok = str(arg) in response
        elif op == "not_contains":
            ok = str(arg) not in response
        elif op == "regex":
            try:
                ok = re.search(str(arg), response) is not None
            except re.error:
                ok, op = False, "regex(invalid)"
        elif op in ("max_chars", "min_chars"):
            try:
                n = int(arg)
            except (TypeError, ValueError):
                ok, op = False, f"{op}(invalid arg)"
            else:
                ok = len(response) <= n if op == "max_chars" else len(response) >= n
        elif op == "section_present":
            ok = _section(response, str(arg)) is not None or str(arg).lower() in response.lower()
        elif op == "section_contains":
            # arg: "Heading::needle" (or {"section":..., "text":...})
            if isinstance(arg, dict):
                head, needle = str(arg.get("section", "")), str(arg.get("text", ""))
            else:
                sep = "::" if "::" in str(arg) else ":"
                head, _, needle = str(arg).partition(sep)
            body = _section(response, head)
            ok = body is not None and needle.lower() in body.lower()
        elif op == "no_refusal":
            ok = _REFUSAL.search(response[:600]) is None and bool(response.strip())
        elif op == "tool_called":
            ok = str(arg) in tools if tools_called is not None else False
            if tools_called is None:
                op = "tool_called(no tool log)"
        else:
            ok, op = False, f"{op}(unknown)"      # an op nobody implements tests nothing
        if ok:
            passed += 1
        else:
            failed.append(f"{op}={arg}")
    soft = passed / len(checks)
    return (1.0 if passed == len(checks) else 0.0), soft, (
        "all checks passed" if not failed else "failed: " + ", ".join(failed[:4])
    )


class MixedRunner:
    """Dispatch each task to the runner its shape asks for.

    pytest node ids → PytestRunner; tasks with a ``judge.scenario`` →
    SimulationRunner; everything else (exact / rubric / rule) → AgentRunner.
    Records come back in task order so callers can zip them with tasks.
    """

    name = "mixed"

    def __init__(self, pytest_runner: Runner, agent_runner: Runner,
                 sim_runner: Runner | None = None) -> None:
        self.pytest_runner = pytest_runner
        self.agent_runner = agent_runner
        self.sim_runner = sim_runner

    @staticmethod
    def _kind(t: TaskRecord) -> str:
        if "::" in t.id and t.id.split("::")[0].endswith(".py"):
            return "pytest"
        if isinstance(t.judge, dict) and t.judge.get("scenario"):
            return "simulate"
        return "agent"

    def run(self, skill_dir: Path, tasks: list[TaskRecord]) -> list[ExecRecord]:
        groups: dict[str, list[TaskRecord]] = {"pytest": [], "simulate": [], "agent": []}
        for t in tasks:
            groups[self._kind(t)].append(t)
        by_id: dict[str, ExecRecord] = {}
        if groups["pytest"]:
            by_id.update({r.task_id: r for r in self.pytest_runner.run(skill_dir, groups["pytest"])})
        if groups["simulate"]:
            runner = self.sim_runner or self.agent_runner
            by_id.update({r.task_id: r for r in runner.run(skill_dir, groups["simulate"])})
        if groups["agent"]:
            by_id.update({r.task_id: r for r in self.agent_runner.run(skill_dir, groups["agent"])})
        return [by_id.get(t.id) or ExecRecord(task_id=t.id, split=t.split, passed=False,
                                               exc_type="NotRun", exc_message="runner produced no record")
                for t in tasks]

