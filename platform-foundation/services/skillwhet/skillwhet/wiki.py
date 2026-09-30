"""Persistent knowledge layer — the wiki is never rolled back.

WikiSkill (2608.27454, Google Research): the insights that guide skill
development stay scattered across optimisation history, so they cannot be
reused across iterations. SkillOpt's rejected-edit buffer is cleared at every
epoch boundary, so "why that direction failed" evaporates with the epoch.

The fix is to decouple knowledge from parameters. A rejected candidate rolls the
skill back; it does NOT roll the wiki back. A failed edit contributed knowledge
even when it contributed no parameters. That matters most in the fast loop,
where candidate volume is highest and almost everything is rejected.

he (0.5.0) — a lesson is a claim, and claims have a status:

  hypothesis  seen once, or only from one candidate
  supported   seen from ≥ 2 distinct candidates, no counterexample outweighing it
  disputed    counterexamples ≥ half of the supporting candidates:
                · a gate-rejection lesson ("editing X fails G4") is contradicted by an
                  ACCEPTED candidate that edited the same scope;
                · a success lesson ("this change in X worked") is contradicted when the
                  round-boundary comparison (slow update) shows the accepted round
                  regressed tasks.
  retired     not seen for ``RETIRE_AFTER_RUNS`` training runs; kept on disk, left
              out of the proposer brief.

``scope`` is where the lesson applies (``module::symbol`` / ``doc:<path>``);
``revision`` counts changes to the claim. Old ``index.json`` files load unchanged
and get their status derived on read.
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from .types import Bundle, Finding


RETIRE_AFTER_RUNS = 5
BEHAVIOURAL_GATES = ("G4", "G5", "G6")   # regression / hold-out / replay: about what a change DOES
STATUSES = ("hypothesis", "supported", "disputed", "retired")


def bundle_scope(bundle: Bundle) -> list[str]:
    """Where a candidate touched the skill: ``module::symbol`` and ``doc:<path>``."""
    out = [f"{e.module}::{e.symbol or '*'}" for e in bundle.code_edits]
    out += [f"doc:{d.path}" for d in bundle.doc_edits]
    return list(dict.fromkeys(out))


def _overlaps(a: list[str], b: list[str]) -> list[str]:
    """Scopes that meet: equal, or a module-wide ``m::*`` against any ``m::sym``."""
    hits = []
    for x in a:
        for y in b:
            if x == y or (x.endswith("::*") and y.startswith(x[:-1])) or (y.endswith("::*") and x.startswith(y[:-1])):
                hits.append(x)
                break
    return hits


def _slug(text: str) -> str:
    s = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return re.sub(r"[\s_]+", "-", s)[:60] or "pattern"


@dataclass
class Pattern:
    """One durable lesson: a failure mode plus what to do about it."""

    id: str
    title: str
    kind: str                       # gate-rejection | defect | success | governance
    observations: int = 1
    gates_that_rejected: list[str] = field(default_factory=list)
    workaround: str = ""
    evidence: list[str] = field(default_factory=list)
    first_seen_round: int = 0
    last_seen_round: int = 0
    # he
    status: str = "hypothesis"      # hypothesis | supported | disputed | retired
    scope: list[str] = field(default_factory=list)
    counterexamples: list[str] = field(default_factory=list)
    revision: int = 1
    last_seen_run: int = 0

    def to_dict(self) -> dict:
        return asdict(self)

    def supporters(self) -> int:
        """Distinct candidates (bundle digests) behind the claim; at least one."""
        return max(1, len({e for e in self.evidence if e.startswith("bundle:")}))

    def reassess(self, run: int = 0) -> bool:
        """Derive the status from the evidence. Returns True when it changed."""
        before = self.status
        if before == "retired":
            return False                 # only a new observation brings a lesson back (see Wiki.observe)
        if run and self.last_seen_run and run - self.last_seen_run >= RETIRE_AFTER_RUNS:
            self.status = "retired"
        elif self.counterexamples and len(self.counterexamples) * 2 >= self.supporters():
            self.status = "disputed"
        elif self.supporters() >= 2 or self.observations >= 3:
            self.status = "supported"
        else:
            self.status = "hypothesis"
        return self.status != before

    def render(self) -> str:
        lines = [
            f"# {self.title}", "",
            f"- status: {self.status} (revision {self.revision})",
            f"- kind: {self.kind}",
            f"- observed: {self.observations}x (rounds {self.first_seen_round}"
            f"-{self.last_seen_round})",
        ]
        if self.gates_that_rejected:
            counts: dict[str, int] = {}
            for g in self.gates_that_rejected:
                counts[g] = counts.get(g, 0) + 1
            lines.append("- rejected by: " + ", ".join(
                f"{g} x{n}" for g, n in sorted(counts.items(), key=lambda kv: -kv[1])
            ))
        if self.scope:
            lines.append("- scope: " + ", ".join(self.scope[:12]))
        if self.workaround:
            lines += ["", "## What to do instead", "", self.workaround]
        if self.counterexamples:
            lines += ["", "## Counterexamples", ""] + [f"- {c}" for c in self.counterexamples[:10]]
        if self.evidence:
            lines += ["", "## Evidence", ""] + [f"- {e}" for e in self.evidence[:10]]
        return "\n".join(lines) + "\n"


class Wiki:
    """`.evo/wiki/` — patterns/, logs.md, impact.md. Append-only in spirit."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.patterns_dir = self.root / "patterns"
        self.patterns_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.root / "index.json"
        self.patterns: dict[str, Pattern] = {}
        if self.index_path.exists():
            try:
                for d in json.loads(self.index_path.read_text(encoding="utf-8")):
                    known = {k: v for k, v in d.items() if k in Pattern.__dataclass_fields__}
                    p = Pattern(**known)
                    if "status" not in d:
                        p.reassess()             # 0.4.x index files carry no status; newer ones keep theirs
                    self.patterns[p.id] = p
            except (json.JSONDecodeError, TypeError):
                pass
        self.run = 0                             # set by begin_run(); 0 = reading only

    # -- runs ----------------------------------------------------------------
    def begin_run(self) -> int:
        """A training run starts: count it, and retire lessons not seen for a while."""
        meta_p = self.root / "meta.json"
        try:
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        self.run = int(meta.get("runs", 0)) + 1
        meta_p.write_text(json.dumps({**meta, "runs": self.run}), encoding="utf-8")
        changed = False
        for p in self.patterns.values():
            if not p.last_seen_run:
                p.last_seen_run = self.run         # legacy pattern: start its clock now
                changed = True
            if p.reassess(self.run):
                p.revision += 1
                self._render(p)
                changed = True
        if changed:
            self._flush()
        return self.run

    # -- writing -----------------------------------------------------------
    def observe(self, *, title: str, kind: str, round_no: int,
                gate: str = "", workaround: str = "",
                evidence: list[str] | None = None, scope: list[str] | None = None) -> Pattern:
        pid = _slug(title)
        p = self.patterns.get(pid)
        if p is None:
            p = Pattern(id=pid, title=title, kind=kind,
                        first_seen_round=round_no, last_seen_round=round_no, last_seen_run=self.run)
            self.patterns[pid] = p
        else:
            p.observations += 1
            p.last_seen_round = round_no
            p.revision += 1
            if self.run:
                p.last_seen_run = self.run
        if gate:
            p.gates_that_rejected.append(gate)
        if workaround and not p.workaround:
            p.workaround = workaround
        for e in evidence or []:
            if e not in p.evidence:
                p.evidence.append(e)
        for sc in scope or []:
            if sc not in p.scope and len(p.scope) < 20:
                p.scope.append(sc)
        if p.status == "retired":
            p.status = "hypothesis"              # seen again: back in play
        p.reassess(self.run)
        self._render(p)
        self._flush()
        return p

    def _render(self, p: Pattern) -> None:
        (self.patterns_dir / f"{p.id}.md").write_text(p.render(), encoding="utf-8")

    def _contradict(self, p: Pattern, note: str) -> None:
        if note in p.counterexamples:
            return
        p.counterexamples.append(note)
        p.revision += 1
        p.reassess(self.run)
        self._render(p)

    def record_rejection(self, bundle: Bundle, round_no: int, gate: str,
                         findings: list[Finding], *, fingerprint: str = "") -> Pattern:
        """A rejected candidate: the skill reverts, this does not."""
        if fingerprint:
            self._remember_fingerprint(fingerprint, gate, round_no)
        head = findings[0] if findings else None
        title = (f"{gate}: {head.rule}" if head else f"{gate}: rejected")
        # The hold-out suite is never shown to the optimizer — not even the
        # names of its tests, which are descriptive by convention (audit C17).
        # The wiki records that G5 rejected and how often; nothing more.
        secret = gate.startswith("G5") or any(
            "tests/holdout" in (f.message or "") for f in findings)
        workaround = "" if secret else (head.message[:400] if head else "")
        return self.observe(
            title=title, kind="gate-rejection", round_no=round_no, gate=gate,
            workaround=workaround,
            evidence=[f"bundle:{bundle.digest()}", f"origin:{bundle.origin}",
                      *bundle.evidence[:4]],
            scope=bundle_scope(bundle),
        )

    def record_acceptance(self, bundle: Bundle, round_no: int) -> None:
        self.log(round_no, f"ACCEPT {bundle.origin} {bundle.digest()} — "
                           f"{bundle.rationale[:160]}")

    def record_round_accepted(self, bundles: list[Bundle], round_no: int) -> None:
        """he: the round passed G7 — its promoted CODE candidates now count as evidence.

        A lesson "changing X breaks behaviour" (rejected by a behavioural gate, G4–G6) is
        contradicted by an accepted change to the same symbol. Lessons from G0–G3 are about
        what the code said (syntax, a banned call, a lint rule), not where it was, so a
        change elsewhere in the same function does not contradict them; prose bundles are
        left out because every doc edit shares the scope ``doc:SKILL.md``."""
        changed = False
        for bundle in bundles:
            scope = [x for x in bundle_scope(bundle) if not x.startswith("doc:")]
            if not scope:
                continue
            for p in list(self.patterns.values()):
                if p.kind != "gate-rejection" or p.status == "retired":
                    continue
                if not any(g[:2] in BEHAVIOURAL_GATES for g in p.gates_that_rejected):
                    continue
                hit = _overlaps([x for x in p.scope if not x.startswith("doc:")], scope)
                if hit:
                    self._contradict(p, f"r{round_no}: accepted {bundle.origin} {bundle.digest()} in {', '.join(hit[:3])}")
                    changed = True
            self.observe(title=f"accepted: {scope[0]}" + (f" (+{len(scope) - 1})" if len(scope) > 1 else ""),
                         kind="success", round_no=round_no, workaround=bundle.rationale[:400],
                         evidence=[f"bundle:{bundle.digest()}", f"origin:{bundle.origin}", f"round:{self.run}:{round_no}"],
                         scope=scope)
        if changed:
            self._flush()

    def record_longitudinal(self, round_no: int, regressed: list[str], improved: list[str]) -> list[str]:
        """he: the slow update compared round r-1 and r on the same tasks. Success lessons
        of round r that regressed tasks are disputed. Returns the ids of the patterns changed."""
        if not regressed:
            return []
        touched = []
        tag = f"round:{self.run}:{round_no}"
        for p in self.patterns.values():
            if p.kind == "success" and tag in p.evidence and p.status != "retired":
                self._contradict(p, f"r{round_no}: next-round comparison regressed {len(regressed)} task(s) "
                                    f"({', '.join(regressed[:3])}); improved {len(improved)}")
                touched.append(p.id)
        if touched:
            self._flush()
        return touched

    def log(self, round_no: int, line: str) -> None:
        ts = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        with (self.root / "logs.md").open("a", encoding="utf-8") as fh:
            fh.write(f"- `{ts}` r{round_no} {line}\n")

    def record_impact(self, round_no: int, accepted: int, rejected: int,
                      score: float | None) -> None:
        with (self.root / "impact.md").open("a", encoding="utf-8") as fh:
            fh.write(f"| {round_no} | {accepted} | {rejected} | "
                     f"{'-' if score is None else f'{score:.4f}'} |\n")

    # -- fingerprints of rejected candidates (search-side dedup) -----------
    @property
    def _fp_path(self) -> Path:
        return self.root / "rejected_fingerprints.json"

    def rejected_fingerprints(self) -> dict[str, dict]:
        try:
            return json.loads(self._fp_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def _remember_fingerprint(self, fp: str, gate: str, round_no: int) -> None:
        d = self.rejected_fingerprints()
        d[fp] = {"gate": gate, "round": round_no}
        self._fp_path.write_text(json.dumps(d, indent=1), encoding="utf-8")

    def _flush(self) -> None:
        self.index_path.write_text(
            json.dumps([p.to_dict() for p in self.patterns.values()],
                       ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    # -- reading -----------------------------------------------------------
    def recurring(self, min_observations: int = 2) -> list[Pattern]:
        return sorted(
            (p for p in self.patterns.values()
             if p.observations >= min_observations and p.status != "retired"),
            key=lambda p: -p.observations,
        )

    def brief(self, limit: int = 12) -> str:
        """Rendered for the proposer: what has already been tried and failed.

        he: retired lessons are left out; supported ones come first; disputed ones
        are shown as disputed with their newest counterexample, so the proposer does
        not avoid a direction that has since been shown to work."""
        live = [p for p in self.patterns.values() if p.kind != "success" and p.status != "retired"]
        order = {"supported": 0, "hypothesis": 1, "disputed": 2}
        rows = sorted(live, key=lambda p: (order.get(p.status, 3), -p.observations))[:limit]
        if not rows:
            return ""
        out = ["## Known failure patterns (from previous rounds)", ""]
        for p in rows:
            wa = p.workaround[:160] if p.workaround else ""
            if "tests/holdout" in wa or "holdout" in p.title.lower():
                wa = ""                                   # defence in depth
            tag = f"{p.status}, seen {p.observations}x"
            line = f"- **{p.title}** ({tag})" + (f" — {wa}" if wa else "")
            if p.status == "disputed" and p.counterexamples:
                line += f" — BUT: {p.counterexamples[-1][:160]}"
            out.append(line)
        return "\n".join(out)
