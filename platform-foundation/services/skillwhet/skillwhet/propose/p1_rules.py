"""P1 — rule-driven repair. Zero LLM calls, unlimited budget.

Deterministic tools first: they are free, they never hallucinate, and running
them first means the diffs the model-driven paths produce afterwards are clean
instead of tangled up with formatting noise.

The tool invocation IS the evidence, which is why ``require_provenance``
exempts origin="P1" — the change is reproducible from the source alone.
"""
from __future__ import annotations

import shutil
from pathlib import Path

from ..edits import snapshot
from ..gates.base import run_tool, tool_command
from ..types import Bundle, CodeEdit

# Ruff rules that are safe to auto-fix. Deliberately narrow: anything that could
# change behaviour is left for P2/P3 where a human-readable rationale is required.
SAFE_FIX_RULES = [
    "F401",   # unused import
    "I",      # import sorting
    "UP",     # pyupgrade
    "RET504", # unnecessary assignment before return
    "SIM105", # contextlib.suppress
    "C4",     # comprehensions
    "PIE",    # misc lint
]


def propose_rule_fixes(
    skill_dir: Path, *, scratch: Path | None = None, rules: list[str] | None = None,
) -> list[Bundle]:
    """Run the autofixers on a snapshot and package the resulting deltas.

    Returns at most one bundle; it carries a ``rewrite_module`` edit per file the
    tools actually changed. Whole-file replacement is acceptable here precisely
    because the transformation is deterministic and still has to clear G0-G5.
    """
    skill_dir = Path(skill_dir)
    ruff = tool_command("ruff")        # hl:`python -m ruff` 优先(pip --user 装时脚本不在 PATH)
    if ruff is None:
        return []
    scripts = skill_dir / "scripts"
    if not scripts.is_dir():
        return []

    work = snapshot(skill_dir, (scratch or skill_dir.parent / ".whet-p1") / "work")
    try:
        before = {
            p.relative_to(work).as_posix(): p.read_text(encoding="utf-8")
            for p in sorted((work / "scripts").rglob("*.py"))
        }
        run_tool(
            [*ruff, "check", "scripts", "--fix", "--no-cache",
             "--select", ",".join(rules or SAFE_FIX_RULES)],
            work,
        )
        run_tool([*ruff, "format", "scripts", "--no-cache"], work)

        edits: list[CodeEdit] = []
        for rel, old in before.items():
            new = (work / rel).read_text(encoding="utf-8")
            if new != old:
                edits.append(CodeEdit(
                    op="rewrite_module", module=rel, content=new,
                    evidence=[f"tool:ruff --fix --select {','.join(rules or SAFE_FIX_RULES)}",
                              "tool:ruff format"],
                    rationale="deterministic autofix + format",
                ))
        if not edits:
            return []
        return [Bundle(
            code_edits=edits, origin="P1",
            evidence=["tool:ruff"],
            rationale=f"rule-driven cleanup of {len(edits)} module(s)",
        )]
    finally:
        shutil.rmtree(work.parent, ignore_errors=True)
