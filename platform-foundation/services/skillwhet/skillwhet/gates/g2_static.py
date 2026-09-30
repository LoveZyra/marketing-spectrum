"""G2 — static gate: ruff (lint + complexity) and pyright (types).

Includes the anti-bloat ruleset: the defensive-code patterns that the
capability-driven path (P3) reliably produces are caught here, cheaply and
BEFORE the multi-objective utility would notice them statistically.
"""
from __future__ import annotations

import json

from ..analysis import analyze_source
from ..types import GateResult, Verdict
from .base import BaseGate, Candidate, missing_tool_reason, run_tool, tool_command

# Ruff rules that specifically catch "defensive code bloat".
ANTI_BLOAT_RULES = [
    "E722",    # bare except
    "BLE001",  # blind except Exception
    "S110",    # try/except/pass — silent swallow
    "S112",    # try/except/continue
    "B006",    # mutable default argument
    "B008",    # function call in default argument
    "RET504",  # unnecessary assignment before return
    "SIM105",  # use contextlib.suppress
    "F401",    # unused import
    "F841",    # unused local
]

DEFAULT_SELECT = ["E", "F", "B", "S", "BLE", "SIM", "RET", "C90", "UP", "I"]


class StaticGate(BaseGate):
    name = "G2.static"
    cost = "free"

    def __init__(
        self,
        *,
        max_complexity: int = 10,
        select: list[str] | None = None,
        use_pyright: bool = True,
        require_annotations_for: set[str] | None = None,
    ) -> None:
        self.max_complexity = max_complexity
        self.select = select or DEFAULT_SELECT
        self.use_pyright = use_pyright
        self.require_annotations_for = require_annotations_for or set()

    def run(self, cand: Candidate) -> GateResult:
        return self._timed(self._run, cand)

    def _run(self, cand: Candidate) -> GateResult:
        findings = []
        detail: dict = {}

        if not cand.scripts():
            # hb:原来回 PASS(modules=0),卡片上就成了"六门通过" —— 其实什么都没查
            others = len(cand.python_files(include_tests=False))
            return self.skip(
                "no .py under scripts/ (the code edit surface)"
                + (f"; {others} other module(s) are syntax- and security-checked only (G0/G1)" if others else ""))

        # ── ruff ────────────────────────────────────────────────────────
        # hl(动态 P2-19 / 复核 P3):缺 ruff 只跳过 ruff 这一项,pyright 与入口点注解照查;
        # 最后没有阻断问题但有工具没装 → 整门记 SKIP(不算 PASS),detail 写清缺什么、怎么装
        missing: list[str] = []
        ruff = tool_command("ruff")
        if ruff is None:
            detail["ruff"] = missing_tool_reason("ruff")
            missing.append("ruff")
        else:
            rc, out, err = run_tool(
                [*ruff, "check", "scripts",
                 "--select", ",".join(self.select),
                 "--ignore", "E501",
                 "--config", f"lint.mccabe.max-complexity={self.max_complexity}",
                 "--output-format", "json", "--no-cache", "--force-exclude"],
                cand.skill_dir,
            )
            detail["ruff"] = f"rc={rc}"
            if out.strip():
                try:
                    for it in json.loads(out):
                        code = it.get("code") or "?"
                        sev = "error" if code in ANTI_BLOAT_RULES else "warning"
                        findings.append(self.finding(
                            f"ruff:{code}",
                            (it.get("message") or "")[:200],
                            path=(it.get("filename") or "").split("/")[-1],
                            line=int((it.get("location") or {}).get("row", 0) or 0),
                            severity=sev,
                        ))
                except json.JSONDecodeError:
                    detail["ruff"] = f"unparseable output ({err[:80]})"

        # ── pyright ─────────────────────────────────────────────────────
        if self.use_pyright:
            pyright = tool_command("pyright")
            if pyright is None:
                detail["pyright"] = missing_tool_reason("pyright")
                missing.append("pyright")
            else:
                rc, out, _ = run_tool(
                    [*pyright, "--outputjson", "scripts"], cand.skill_dir, timeout=180
                )
                detail["pyright"] = f"rc={rc}"
                if out.strip():
                    try:
                        data = json.loads(out)
                        for d in data.get("generalDiagnostics", []):
                            if d.get("severity") != "error":
                                continue
                            rng = (d.get("range") or {}).get("start") or {}
                            findings.append(self.finding(
                                "pyright:type-error",
                                (d.get("message") or "")[:200],
                                path=str(d.get("file", "")).split("/")[-1],
                                line=int(rng.get("line", 0)) + 1,
                            ))
                    except json.JSONDecodeError:
                        detail["pyright"] = "unparseable output"

        # ── annotation coverage for stable entrypoints ──────────────────
        # pyright's value collapses without annotations, so stable entrypoints
        # are required to be fully annotated or G2/G3 are theatre.
        stable = {
            (e.module, e.id) for e in cand.contract.entrypoints
            if e.stability == "stable"
        }
        if stable:
            for p in cand.scripts():
                rel = cand.rel(p)
                try:
                    facts = analyze_source(p.read_text(encoding="utf-8"))
                except SyntaxError:
                    continue
                for qual, is_ann in facts.annotated.items():
                    if (rel, qual) in stable and not is_ann:
                        findings.append(self.finding(
                            "stable-entrypoint-unannotated",
                            f"{qual} is declared stability=stable but is not fully "
                            f"type-annotated; G2/G3 cannot verify it",
                            path=rel, line=facts.func_lines.get(qual, 0),
                        ))

        if missing:
            detail["missing_tools"] = missing
        blocking = [f for f in findings if f.severity == "error"]
        if blocking:
            return self.fail(findings, **detail)
        if missing:
            return GateResult(gate=self.name, verdict=Verdict.SKIP, findings=findings,
                              detail={"reason": "; ".join(detail[t] for t in missing), **detail})
        # Warnings are reported but do not block; they feed ΔBloat downstream.
        return GateResult(
            gate=self.name, verdict=Verdict.PASS, findings=findings, detail=detail
        )
