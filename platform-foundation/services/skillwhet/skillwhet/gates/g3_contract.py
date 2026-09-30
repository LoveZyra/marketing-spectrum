"""G3 — contract gate. The gate this whole design exists for.

Interface drift between prose and code is the one defect class that an
end-to-end rollout can *detect* (the score drops) but cannot *localise* — you
do not learn which side to fix. Making the coupling surface explicit turns that
into a deterministic, millisecond check.

Three checks:
  1. signature consistency  — CONTRACT vs the AST
  2. doc anchor liveness    — the heading the contract points at still exists
  3. side-effect containment — observed ⊆ declared, per entrypoint's module
"""
from __future__ import annotations

from ..contract import collect_facts, resolve_anchor
from ..types import GateResult, effects_satisfied
from .base import BaseGate, Candidate


class ContractGate(BaseGate):
    name = "G3.contract"
    cost = "free"

    def __init__(self, *, require_anchor_for_stable: bool = True) -> None:
        self.require_anchor_for_stable = require_anchor_for_stable

    def run(self, cand: Candidate) -> GateResult:
        return self._timed(self._run, cand)

    def _run(self, cand: Candidate) -> GateResult:
        findings = []
        contract = cand.contract
        if not contract.entrypoints:
            return self.skip("contract has no entrypoints")

        facts = collect_facts(cand.skill_dir)

        for e in contract.entrypoints:
            f = facts.get(e.module)
            if f is None:
                findings.append(self.finding(
                    "module-missing",
                    f"entrypoint {e.id!r} declares module {e.module!r}, "
                    f"which does not exist or does not parse",
                    path=e.module,
                ))
                continue

            # 1. signature consistency
            actual = f.functions.get(e.id)
            if actual is None:
                findings.append(self.finding(
                    "symbol-missing",
                    f"entrypoint {e.id!r} not found in {e.module}",
                    path=e.module,
                ))
            elif e.signature and actual != e.signature:
                sev = "error" if e.stability == "stable" else "warning"
                findings.append(self.finding(
                    "signature-drift",
                    f"{e.id}: CONTRACT says {e.signature!r}, source has {actual!r}"
                    + (" (stable entrypoints may not drift unilaterally)"
                       if sev == "error" else ""),
                    path=e.module, line=f.func_lines.get(e.id, 0), severity=sev,
                ))

            # 2. doc anchor liveness
            if e.doc_anchor:
                ok, why = resolve_anchor(cand.skill_dir, e.doc_anchor)
                if not ok:
                    findings.append(self.finding(
                        "doc-anchor-broken", f"{e.id}: {why}", path=e.module
                    ))
            elif self.require_anchor_for_stable and e.stability == "stable":
                findings.append(self.finding(
                    "doc-anchor-missing",
                    f"{e.id} is stability=stable but has no doc_anchor; "
                    f"prose and code are not linked",
                    path=e.module,
                ))

            # 3. side-effect containment
            observed = {x for x in f.side_effects if x != "none"}
            undeclared = effects_satisfied(set(e.side_effects), observed)
            for eff in sorted(undeclared):
                sites = [s for s in f.effect_sites if s[0] == eff][:2]
                where = ", ".join(f"{w}@L{ln}" for _, w, ln in sites)
                findings.append(self.finding(
                    "side-effect-undeclared",
                    f"{e.module} performs {eff!r}, not covered by "
                    f"{e.id}.side_effects={e.side_effects} ({where})",
                    path=e.module, line=sites[0][2] if sites else 0,
                ))

        # 4. orphan public functions — present in source, absent from contract
        declared = {(e.module, e.id) for e in contract.entrypoints}
        for module, f in facts.items():
            for qual in f.functions:
                if qual.startswith("_") or "._" in qual:
                    continue
                if (module, qual) not in declared:
                    findings.append(self.finding(
                        "entrypoint-undeclared",
                        f"public function {qual!r} in {module} is not in CONTRACT "
                        f"(run `skillwhet contract sync`)",
                        path=module, line=f.func_lines.get(qual, 0),
                        severity="warning",
                    ))

        # 5. executable checks from CONTRACT.checks → tests/contract/, run now
        from .. import pytestio
        from ..contract_tests import generate
        from ..sandbox import SandboxPolicy, run_sandboxed
        written = generate(cand.skill_dir, contract)
        repaired = 0
        if written:
            res = run_sandboxed(
                pytestio.argv("tests/contract", tb="line", extra=["-rf"]),
                cand.skill_dir, SandboxPolicy(wall_timeout_s=120),
            )
            out = (res.stdout or "") + "\n" + (res.stderr or "")
            status = pytestio.parse_verbose(out)
            # Relative to the pre-edit skill, exactly like G4/G5: a check that was
            # ALREADY red stays red without rejecting an unrelated candidate,
            # otherwise one aspirational `example` in CONTRACT.yaml would deadlock
            # the whole loop (nothing can be promoted until it is fixed, and no
            # proposer targets it). Only NEW breakage is an error; a check that
            # goes red → green is counted so the search can prefer that candidate.
            base = {t: ok for t, ok in (cand.baseline_tests or {}).items()
                    if t.startswith("tests/contract/")}
            if res.returncode != 0:
                for nid, st in status.items():
                    if st not in ("FAILED", "ERROR"):
                        continue
                    was_green = base.get(nid, True)
                    findings.append(self.finding(
                        "contract-check-failed", nid[:220],
                        severity="error" if was_green else "warning"))
                for line in out.splitlines():
                    if line.startswith("FAILED") and not any(
                            line.split(" - ")[0].endswith(f.message) for f in findings):
                        nid = line.split(" - ")[0].removeprefix("FAILED").strip()
                        findings.append(self.finding(
                            "contract-check-failed", line.strip()[:220],
                            severity="error" if base.get(nid, True) else "warning"))
                if not any(f.rule == "contract-check-failed" for f in findings):
                    findings.append(self.finding(
                        "contract-check-failed",
                        (res.stdout or res.stderr).strip().splitlines()[-1][:220]
                        if (res.stdout or res.stderr).strip() else "contract tests failed"))
            repaired = sum(1 for nid, ok in base.items()
                           if not ok and status.get(nid, "") == "PASSED")

        if any(x.severity == "error" for x in findings):
            return self.fail(findings, entrypoints=len(contract.entrypoints))
        from ..types import Verdict
        return GateResult(
            gate=self.name, verdict=Verdict.PASS, findings=findings,
            detail={"entrypoints": len(contract.entrypoints),
                    "contract_checks_repaired": repaired},
        )
