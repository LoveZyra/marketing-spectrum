"""G0 — parse gate. ~1ms. Catches the single most common LLM code failure:
output truncated mid-function, which is syntactically invalid.
"""
from __future__ import annotations

import ast

import libcst as cst

from ..types import GateResult
from .base import BaseGate, Candidate


class ParseGate(BaseGate):
    name = "G0.parse"
    cost = "free"

    def run(self, cand: Candidate) -> GateResult:
        return self._timed(self._run, cand)

    def _run(self, cand: Candidate) -> GateResult:
        findings = []
        n = 0
        editable = set(cand.scripts())
        # 语法:包里所有 .py(测试与 scripts/ 以外的代码也会被 import 执行);
        # libcst 往返:只对优化器能改的 scripts/ 有意义
        for p in cand.python_files():
            n += 1
            rel = cand.rel(p)
            try:
                src = p.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError) as exc:
                findings.append(self.finding("unreadable", str(exc)[:200], path=rel))
                continue
            try:
                ast.parse(src)
            except SyntaxError as exc:
                findings.append(self.finding(
                    "syntax-error",
                    f"{exc.msg} (offset {exc.offset})",
                    path=rel, line=exc.lineno or 0,
                ))
                continue
            if p not in editable:
                continue
            # libcst is stricter about round-trip; a module that ast accepts but
            # libcst cannot render is unusable for structured edits.
            try:
                mod = cst.parse_module(src)
                if mod.code != src:
                    findings.append(self.finding(
                        "round-trip-unstable",
                        "libcst round-trip does not reproduce the source byte-for-byte",
                        path=rel,
                    ))
            except Exception as exc:  # noqa: BLE001
                findings.append(self.finding(
                    "cst-parse-error", str(exc)[:200], path=rel
                ))
        if findings:
            return self.fail(findings, modules=n)
        return self.ok(modules=n)
