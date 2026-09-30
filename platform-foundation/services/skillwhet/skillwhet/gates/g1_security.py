"""G1 — security gate. Runs BEFORE the static and test gates, because code is
the only part of a skill that actually executes.

Three checks, all deterministic:
  1. import allowlist   (allowlist, not denylist — a denylist is never complete)
  2. dangerous calls    (eval/exec/pickle/os.system/...)
  3. side-effect declaration consistency (observed ⊆ declared)

Optionally shells out to ``bandit`` when present; its absence downgrades the
gate to SKIP for that check rather than silently passing.
"""
from __future__ import annotations

import json

from ..analysis import analyze_source, returned_callables


def _imported_returns(source: str, returns_by_module: dict[str, dict[str, str]]) -> dict[str, str]:
    """local name → dangerous callable, for names imported from other scripts."""
    import ast as _ast
    out: dict[str, str] = {}
    try:
        tree = _ast.parse(source)
    except SyntaxError:
        return out
    for node in _ast.walk(tree):
        if isinstance(node, _ast.ImportFrom) and node.module and node.module.startswith("scripts"):
            rel = node.module.replace(".", "/") + ".py"
            table = returns_by_module.get(rel, {})
            for a in node.names:
                if a.name in table:
                    out[a.asname or a.name] = table[a.name]
    return out
from ..contract import DEFAULT_STDLIB_ALLOW
from ..types import GateResult, effects_satisfied
from .base import SKIP_DIRS, BaseGate, Candidate, missing_tool_reason, run_tool, tool_command


def own_module_names(root, files: list) -> set[str]:
    """Top-level names a skill's own code can import: every module stem and every package dir
    (relative to the skill root — never the absolute path's components)."""
    out: set[str] = set()
    for p in files:
        rel = p.relative_to(root)
        out.add(rel.stem)
        out.update(part for part in rel.parent.parts if part.isidentifier())
    return out - {"__init__"}


class SecurityGate(BaseGate):
    name = "G1.security"
    cost = "free"

    def __init__(self, *, use_bandit: bool = True, bandit_severity: str = "MEDIUM") -> None:
        self.use_bandit = use_bandit
        self.bandit_severity = bandit_severity

    def run(self, cand: Candidate) -> GateResult:
        return self._timed(self._run, cand)

    def _run(self, cand: Candidate) -> GateResult:
        findings = []
        allowed = set(cand.contract.allowed_imports) | DEFAULT_STDLIB_ALLOW
        declared_by_module: dict[str, set[str]] = {}
        for e in cand.contract.entrypoints:
            declared_by_module.setdefault(e.module, set()).update(e.side_effects)

        # Cross-module: which functions in scripts/ return a dangerous callable,
        # so `from scripts.helpers import get` + `get()(cmd)` resolves.
        returns_by_module: dict[str, dict[str, str]] = {}
        sources: dict[str, str] = {}
        # hb:查的是包里**所有**非测试代码(snippets/、lib/、根目录 …),不只 scripts/ ——
        # 测试会 import 它们,它们一样在服务器上执行
        code = cand.python_files(include_tests=False)
        # 包内自己的模块不是依赖:`from snippets import x`、同目录 `import stats_utils`、`from scripts.a import b`
        allowed |= own_module_names(cand.skill_dir, cand.python_files())
        for p in code:
            try:
                sources[cand.rel(p)] = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            returns_by_module[cand.rel(p)] = returned_callables(sources[cand.rel(p)])

        for p in code:
            rel = cand.rel(p)
            try:
                facts = analyze_source(sources.get(rel) or p.read_text(encoding="utf-8"),
                                       imported_returns=_imported_returns(
                                           sources.get(rel, ""), returns_by_module))
            except SyntaxError:
                continue  # G0 already failed this

            # 1. import allowlist
            for mod in sorted(facts.imports):
                if mod not in allowed:
                    findings.append(self.finding(
                        "import-not-allowed",
                        f"module {mod!r} is not in CONTRACT.allowed_imports "
                        f"nor the stdlib allowlist",
                        path=rel, line=facts.import_lines.get(mod, 0),
                    ))

            # 2. dangerous calls
            for name, why, line in facts.dangerous:
                findings.append(self.finding(
                    "dangerous-call", f"{name}: {why}", path=rel, line=line
                ))

            # 3. side effects observed vs declared
            declared = declared_by_module.get(rel)
            if declared is not None:
                observed = {e for e in facts.side_effects if e != "none"}
                undeclared = effects_satisfied(declared, observed)
                for eff in sorted(undeclared):
                    sites = [s for s in facts.effect_sites if s[0] == eff][:3]
                    where = ", ".join(f"{w}@L{ln}" for _, w, ln in sites)
                    findings.append(self.finding(
                        "undeclared-side-effect",
                        f"module performs {eff!r} but CONTRACT declares "
                        f"{sorted(declared)} ({where})",
                        path=rel, line=sites[0][2] if sites else 0,
                    ))

        detail: dict = {"allowlist_size": len(allowed), "modules": len(code)}

        # 4. optional: bandit
        if self.use_bandit:
            bandit = tool_command("bandit")
            if bandit is None:
                detail["bandit"] = missing_tool_reason("bandit")
                detail["missing_tools"] = ["bandit"]
            else:
                level = {"LOW": "-l", "MEDIUM": "-ll", "HIGH": "-lll"}.get(
                    str(self.bandit_severity).upper(), "-ll")
                # 整个包(含 tests/:测试也会执行),排除缓存 / 版本库 / .evo
                rc, out, _ = run_tool(
                    [*bandit, "-r", ".", "-f", "json", "-q", level,
                     "-x", ",".join(f"*/{d}/*" for d in sorted(SKIP_DIRS))],
                    cand.skill_dir,
                )
                if out.strip():
                    try:
                        data = json.loads(out)
                        for r in data.get("results", []):
                            findings.append(self.finding(
                                f"bandit:{r.get('test_id', '?')}",
                                r.get("issue_text", "")[:200],
                                path=str(r.get("filename", "")).removeprefix("./"),
                                line=int(r.get("line_number", 0) or 0),
                            ))
                        detail["bandit"] = f"rc={rc}"
                    except json.JSONDecodeError:
                        detail["bandit"] = "unparseable output"

        if findings:
            return self.fail(findings, **detail)
        if detail.get("missing_tools"):
            # hl(动态 P2-19):自己的静态检查没发现问题,但要求跑 bandit 又没装 —— 记 SKIP,不算 PASS
            # (非 root 训练与夜训都要 G1 PASS:装上 bandit,或显式 no_bandit 不要求它)
            return self.skip(f"own checks clean; {detail['bandit']}", **detail)
        return self.ok(**detail)
