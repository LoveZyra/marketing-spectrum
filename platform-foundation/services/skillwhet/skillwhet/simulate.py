"""Multi-turn user simulation as a feedback GENERATOR, not an evaluation endpoint.

SkillEvo's (2608.13120) central finding: with the editor unchanged, single-turn
QA feedback plateaus at 66.4 while multi-turn feedback reaches 81.8. Follow-up
questions expose defects layer by layer — what this round repairs lets the
dialogue go one step further and reach the next latent defect. Every round both
consumes gradient and produces new gradient.

Three trust conditions, each with a mechanism:
  coverage       — an intent state machine: the dialogue may end only when every
                   agenda item has been raised AND addressed
  accuracy       — dual-sided scoring: the simulator's coverage c_U is scored
                   separately from the agent's exposed-intent accuracy s_C
  attributability— the verifier scores KNOWLEDGE content only; a knowledge
                   error (opposite rule) is capped at 59 regardless of polish
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from .backend import Backend, extract_json
from .evidence import ExecRecord, TaskRecord

Priority = Literal["key", "minor"]
KEY_WEIGHT = 0.7
PASS_THRESHOLD = 60.0
KNOWLEDGE_ERROR_CAP = 59.0


_KEY_WORDS = {"key", "high", "primary", "must", "critical", "main", "core", "1", "true"}


def norm_priority(p) -> Priority:
    return "key" if str(p).strip().lower() in _KEY_WORDS else "minor"


@dataclass
class Intent:
    topic: str
    priority: Priority = "key"

    def __post_init__(self) -> None:
        self.topic = str(self.topic).strip()
        self.priority = norm_priority(self.priority)

    def to_dict(self) -> dict:
        return {"topic": self.topic, "priority": self.priority}


@dataclass
class Scenario:
    opening_message: str
    behavior_facts: str
    emotion_trajectory: str
    agenda: list[Intent]
    expected_solution: str            # verifier-only; NEVER shown to the user agent

    def to_dict(self) -> dict:
        return {"opening_message": self.opening_message,
                "behavior_facts": self.behavior_facts,
                "emotion_trajectory": self.emotion_trajectory,
                "agenda": [i.to_dict() for i in self.agenda],
                "expected_solution": self.expected_solution}

    @classmethod
    def from_dict(cls, d: dict) -> Scenario:
        return cls(
            opening_message=str(d.get("opening_message", "")),
            behavior_facts=str(d.get("behavior_facts", "")),
            emotion_trajectory=str(d.get("emotion_trajectory", "")),
            agenda=[_intent_from(i) for i in d.get("agenda") or d.get("target_keywords") or []
                    if _intent_from(i) is not None],
            expected_solution=str(d.get("expected_solution", "")),
        )


def _intent_from(i) -> Intent | None:
    """Accept {"topic":..,"priority":..}, {"name":..,"weight":..} or a bare string."""
    if isinstance(i, str):
        return Intent(i, "key") if i.strip() else None
    if isinstance(i, dict):
        topic = str(i.get("topic") or i.get("name") or i.get("intent") or "").strip()
        if not topic:
            return None
        return Intent(topic, i.get("priority", i.get("weight", "key")))
    return None


# ── Intent state machine ────────────────────────────────────────────────────

class IntentStateMachine:
    def __init__(self, agenda: list[Intent]) -> None:
        self.agenda = agenda
        self.raised: set[str] = set()
        self.addressed: set[str] = set()

    def note_raised(self, topics: list[str]) -> None:
        for t in topics:
            m = self._match(t)
            if m:
                self.raised.add(m)

    def note_addressed(self, topics: list[str]) -> None:
        for t in topics:
            m = self._match(t)
            if m and m in self.raised:
                self.addressed.add(m)

    def _match(self, text: str) -> str | None:
        """Exact topic first, then the LONGEST topic that overlaps the text.

        First-substring-wins meant that with "refund" and "refund timeline" on
        the agenda the longer one could never be raised (audit C5).
        """
        text = text.strip().lower()
        if not text:
            return None
        for i in self.agenda:
            if i.topic.lower() == text:
                return i.topic
        best: Intent | None = None
        for i in self.agenda:
            t = i.topic.lower()
            if t in text or text in t:
                if best is None or len(t) > len(best.topic):
                    best = i
        return best.topic if best else None

    def may_terminate(self) -> bool:
        return all(i.topic in self.raised and i.topic in self.addressed
                   for i in self.agenda)

    def coverage(self) -> float:
        keys = [i for i in self.agenda if i.priority == "key"]
        if not keys:
            return 1.0
        return sum(1 for i in keys if i.topic in self.raised) / len(keys)

    def pending(self) -> list[str]:
        return [i.topic for i in self.agenda if i.topic not in self.raised]


# ── User agent ──────────────────────────────────────────────────────────────

_USER_SYSTEM = """You are a real user contacting online support. You are not an AI.

You WILL: describe your problem; supply information when asked; restate what you
already did and saw (from the behaviour facts); confirm when something works.
You will NOT: read logs, use dev tools, or run diagnostics ("I don't know how");
diagnose root causes yourself; fabricate information not in the facts.

Behaviour:
1. Disclose progressively: open with ONE sentence; add a detail only when asked.
2. Keep messages short, like a real person.
3. Cooperate but stay in role; get stuck on complex operations.
4. Let emotion follow progress (see trajectory).
5. Advance exactly one concrete intent per turn. Raise EVERY item on the agenda
   before you finish — the dialogue may not end until all are raised.
6. Never ask for a human handoff or back-office lookups.

Each turn, output exactly one block:
<reason>...</reason>
<agenda_check>topic 1 (newline) topic 2</agenda_check>   # verbatim agenda topics you raised THIS turn
<action>send_text | done</action>
<say>your message</say>"""

_BLOCK = re.compile(r"<(reason|agenda_check|action|say)>(.*?)</\1>", re.DOTALL)


_OPEN_SAY = re.compile(r"<say>(.*)$", re.DOTALL)
_ANY_TAG = re.compile(r"<(reason|agenda_check|action)>.*?(?:</\1>|$)", re.DOTALL)


def _parse_block(text: str) -> dict:
    out = {k: v.strip() for k, v in _BLOCK.findall(text)}
    out.setdefault("action", "send_text")
    if "say" not in out:
        # Truncated output: take what follows an unclosed <say>, else the text
        # with every other tagged block removed. The raw text must never be
        # sent — it carries the hidden agenda and the user agent's reasoning
        # (audit C6).
        m = _OPEN_SAY.search(text)
        say = m.group(1) if m else _ANY_TAG.sub("", text)
        out["say"] = re.sub(r"</?\w+>", "", say).strip()[:400]
    out["agenda_check"] = [ln.strip() for ln in out.get("agenda_check", "").splitlines()
                           if ln.strip()]
    return out


@dataclass
class Turn:
    role: Literal["user", "agent"]
    text: str
    raised: list[str] = field(default_factory=list)


@dataclass
class Trajectory:
    turns: list[Turn]
    coverage: float
    terminated: Literal["normal", "abandoned", "max_turns"]
    raised: list[str]

    def transcript(self) -> str:
        return "\n".join(f"{t.role.upper()}: {t.text}" for t in self.turns)


def simulate(
    scenario: Scenario, *, service: Backend, user: Backend, skill_text: str,
    max_turns: int = 10, stall_limit: int = 3,
) -> Trajectory:
    """Run the dialogue. The user agent never sees ``expected_solution``."""
    sm = IntentStateMachine(scenario.agenda)
    turns: list[Turn] = []
    persona = {
        "behavior_facts": scenario.behavior_facts,
        "emotion_trajectory": scenario.emotion_trajectory,
        "agenda": [i.topic for i in scenario.agenda],
    }
    stalls = 0
    last_agent = ""
    # opening
    sm.note_raised([scenario.agenda[0].topic] if scenario.agenda else [])
    turns.append(Turn("user", scenario.opening_message,
                      [scenario.agenda[0].topic] if scenario.agenda else []))

    for _ in range(max_turns):
        history = "\n".join(f"{t.role}: {t.text}" for t in turns)
        try:
            reply = service.complete(history, system=skill_text, stage="sim.agent",
                                     max_tokens=800)
        except Exception as exc:  # noqa: BLE001
            reply = f"[agent error: {exc}]"
        turns.append(Turn("agent", reply))
        # A substantive reply addresses the intents raised so far. An error or
        # an empty reply addresses nothing (audit C4).
        if reply.strip() and not reply.startswith("[agent error"):
            sm.note_addressed([t for t in sm.raised])
        if reply.strip() and reply.strip() == last_agent.strip():
            stalls += 1
        last_agent = reply
        if stalls >= stall_limit:
            return Trajectory(turns, sm.coverage(), "abandoned", sorted(sm.raised))

        prompt = json.dumps({"persona": persona, "pending_agenda": sm.pending(),
                             "dialogue": history + f"\nagent: {reply}"},
                            ensure_ascii=False)
        try:
            raw = user.complete(prompt, system=_USER_SYSTEM, stage="sim.user",
                                max_tokens=400)
        except Exception as exc:  # noqa: BLE001
            raw = f"<action>done</action><say>[user error: {exc}]</say>"
        blk = _parse_block(raw)
        newly = [t for t in blk["agenda_check"] if sm._match(t) and sm._match(t) not in sm.raised]
        sm.note_raised(blk["agenda_check"])
        if blk["action"] == "done":
            # May only end once everything is raised AND addressed. A turn that
            # raises a new topic and says "done" in the same breath is not done:
            # the agent has not seen that topic yet — ending here scored the
            # agent 0 on a question it never received (audit C4).
            if sm.may_terminate() and not newly:
                return Trajectory(turns, sm.coverage(), "normal", sorted(sm.raised))
            if not blk["say"].strip() or not newly and sm.pending():
                blk["say"] = f"Also, about {sm.pending()[0]}?" if sm.pending() else blk["say"]
            if not blk["say"].strip():
                return Trajectory(turns, sm.coverage(), "normal", sorted(sm.raised))
        turns.append(Turn("user", blk["say"], blk["agenda_check"]))

    return Trajectory(turns, sm.coverage(), "max_turns", sorted(sm.raised))


# ── Verifier (dual-sided) ───────────────────────────────────────────────────

_VERIFY_SYSTEM = """You review a support dialogue against a human reference solution.
Score KNOWLEDGE CONTENT only: rules, paths, constraints, product facts.
Phrasing, brevity, extra information, dialogue strategy: no deduction.

Rubric (0-100): 90-100 accurate and complete; 70-89 minor omissions;
40-69 right direction, key knowledge missing; 10-39 direction deviates; 0-9 irrelevant.
A knowledge ERROR (rule contradicts the reference, or opposite conclusion) is
capped at 59 no matter how polished the rest is.

Also judge each agenda intent that was raised: was it answered correctly (1) or not (0).

Return JSON only:
{"score": <0-100>, "knowledge_error": true|false,
 "per_intent": {"<topic>": 0|1, ...}, "reasoning": "..."}"""


@dataclass
class Verdict:
    score: float
    passed: bool
    coverage: float            # c_U — simulator side
    exposed_accuracy: float    # s_C — agent side, weighted by priority
    knowledge_error: bool
    per_intent: dict[str, int]
    reasoning: str
    eval_noise: bool           # c_U < 1 → excluded from the agent-side denominator

    def to_dict(self) -> dict:
        return {"score": self.score, "passed": self.passed, "coverage": self.coverage,
                "exposed_accuracy": self.exposed_accuracy,
                "knowledge_error": self.knowledge_error, "per_intent": self.per_intent,
                "eval_noise": self.eval_noise, "reasoning": self.reasoning[:300]}


def verify(traj: Trajectory, scenario: Scenario, judge: Backend) -> Verdict:
    payload = {"dialogue": traj.transcript()[:8000],
               "reference_solution": scenario.expected_solution,
               "agenda": [i.to_dict() for i in scenario.agenda],
               "raised": traj.raised}
    try:
        raw = judge.complete(json.dumps(payload, ensure_ascii=False),
                             system=_VERIFY_SYSTEM, stage="sim.verify", max_tokens=600)
        d = extract_json(raw) or {}
    except Exception:  # noqa: BLE001
        d = {}
    try:
        score = float(d.get("score", 0))
    except (TypeError, ValueError):
        score = 0.0
    kerr = bool(d.get("knowledge_error"))
    if kerr:
        score = min(score, KNOWLEDGE_ERROR_CAP)
    per_raw = {str(k).strip().lower(): int(bool(v)) for k, v in (d.get("per_intent") or {}).items()}
    per: dict[str, int] = {}
    for i in scenario.agenda:
        key = i.topic.lower()
        if key in per_raw:
            per[i.topic] = per_raw[key]
        else:                                     # tolerate a judge that shortens the topic
            hits = [v for k, v in per_raw.items() if k in key or key in k]
            if hits:
                per[i.topic] = min(hits)

    # s_C: weighted accuracy over RAISED intents only
    num = den = 0.0
    for i in scenario.agenda:
        if i.topic not in traj.raised:
            continue
        w = KEY_WEIGHT if i.priority == "key" else 1.0 - KEY_WEIGHT
        den += w
        num += w * per.get(i.topic, 0)
    s_c = num / den if den else 0.0

    noise = traj.coverage < 1.0
    # missing a key condition fails the task even above threshold
    keys_raised_ok = all(per.get(i.topic, 0) for i in scenario.agenda
                         if i.priority == "key" and i.topic in traj.raised)
    passed = (score >= PASS_THRESHOLD) and keys_raised_ok and not noise
    return Verdict(score, passed, traj.coverage, s_c, kerr, per,
                   str(d.get("reasoning", "")), noise)


# ── Scenario synthesis from a human-handled ticket ──────────────────────────

_SYNTH_SYSTEM = """Reconstruct a simulated-user scenario from a real, human-handled
support ticket.

Produce JSON with:
- opening_message: the user's first sentence, symptom + request only, no root cause
- behavior_facts: what the user already did and saw; NO agent behaviour, no solution
- emotion_trajectory: short arrow chain, e.g. "confused -> impatient"
- agenda: [{"topic": "...", "priority": "key"|"minor"}] — key = the request whose
  answer alone would satisfy the user; minor = follow-ups. Merge stages of one
  request into one key intent.
- expected_solution: ONLY knowledge a skill could learn (rules, paths, constraints,
  steps). No case-specific ids, amounts or names. ≤ 200 words.

NO ANSWER LEAKAGE: opening_message and agenda must not contain the solution.
Return JSON only."""


def synthesize_scenario(ticket: str, backend: Backend) -> Scenario | None:
    try:
        raw = backend.complete(ticket[:12000], system=_SYNTH_SYSTEM,
                               stage="sim.synth", max_tokens=1200)
    except Exception:  # noqa: BLE001
        return None
    d = extract_json(raw)
    if not d or not d.get("opening_message") or not d.get("agenda"):
        return None
    return Scenario.from_dict(d)


# ── Runner adapter ──────────────────────────────────────────────────────────

class SimulationRunner:
    """Runner protocol over multi-turn simulation.

    Each TaskRecord carries its Scenario in ``judge["scenario"]``. The service
    agent is a frozen backend loaded with the skill's prose; the user and judge
    are the evaluator backend (Generator != Evaluator).
    """

    name = "simulation"

    def __init__(self, service: Backend, evaluator: Backend, *,
                 max_turns: int = 10) -> None:
        self.service = service
        self.evaluator = evaluator
        self.max_turns = max_turns

    def run(self, skill_dir: Path, tasks: list[TaskRecord]) -> list[ExecRecord]:
        skill_dir = Path(skill_dir)
        parts = []
        for p in [skill_dir / "SKILL.md", *sorted((skill_dir / "references").glob("*.md"))]:
            if p.exists():
                parts.append(p.read_text(encoding="utf-8"))
        skill_text = "\n\n".join(parts)

        out = []
        for t in tasks:
            sc_raw = (t.judge or {}).get("scenario")
            if not sc_raw:
                out.append(ExecRecord(task_id=t.id, split=t.split, passed=False,
                                      exc_type="NoScenario"))
                continue
            sc = Scenario.from_dict(sc_raw)
            traj = simulate(sc, service=self.service, user=self.evaluator,
                            skill_text=skill_text, max_turns=self.max_turns)
            v = verify(traj, sc, self.evaluator)
            rec = ExecRecord(
                task_id=t.id, split=t.split,
                hard=1.0 if v.passed else 0.0, soft=v.score / 100.0,
                passed=v.passed, stdout=traj.transcript()[:2000],
                exc_type="" if v.passed else ("EvalNoise" if v.eval_noise
                                              else "KnowledgeGap"),
                exc_message=v.reasoning[:200],
                noise=v.eval_noise,
                trajectory=[{"role": tn.role, "text": tn.text[:1500], "raised": tn.raised}
                            for tn in traj.turns] + [{"role": "judge", "text": v.reasoning[:500],
                                                      "per_intent": v.per_intent}],
            )
            out.append(rec)
            from .progress import task_done
            task_done(rec)
        return out
