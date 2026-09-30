"""Gate protocol and shared helpers."""
from __future__ import annotations

import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

from ..types import Contract, Finding, GateResult, Verdict


SKIP_DIRS = {"__pycache__", "node_modules", ".evo", ".git", ".venv", "venv"}


@dataclass
class Candidate:
    """What every gate is handed. Gates must not mutate it."""

    skill_dir: Path
    contract: Contract
    changed_modules: set[str] = field(default_factory=set)
    label: str = ""
    # Per-test status on the skill this candidate was derived from. When set,
    # the test gates judge RELATIVELY (no regression) instead of absolutely
    # (everything green) — a fix that repairs one of two red tests must land.
    baseline_tests: dict[str, bool] | None = None

    def scripts(self) -> list[Path]:
        root = self.skill_dir / "scripts"
        if not root.is_dir():
            return []
        return [p for p in sorted(root.rglob("*.py")) if "__pycache__" not in p.parts]

    def python_files(self, *, include_tests: bool = True) -> list[Path]:
        """Every ``.py`` in the bundle, wherever it lives (``snippets/``, ``lib/``, root …).

        ``scripts()`` is the optimizer's *edit surface*; this is what actually
        executes. The security and parse gates must look at all of it — a module
        outside ``scripts/`` is imported by the tests and runs just the same
        (hb: a skill with all its code in ``snippets/`` got a vacuous G0/G1 PASS).
        """
        out = []
        for p in sorted(self.skill_dir.rglob("*.py")):
            parts = p.relative_to(self.skill_dir).parts
            if any(x in SKIP_DIRS or x.startswith(".") for x in parts[:-1]):
                continue
            if not include_tests and parts[0] in ("tests", "test"):
                continue
            out.append(p)
        return out

    def rel(self, p: Path) -> str:
        return Path(p).relative_to(self.skill_dir).as_posix()


class Gate(Protocol):
    name: str
    cost: str  # "free" | "cheap" | "expensive"

    def run(self, cand: Candidate) -> GateResult: ...


class BaseGate:
    name = "base"
    cost = "free"

    def run(self, cand: Candidate) -> GateResult:  # pragma: no cover - overridden
        raise NotImplementedError

    def _timed(self, fn, cand: Candidate) -> GateResult:
        t0 = time.perf_counter()
        res = fn(cand)
        res.elapsed_ms = (time.perf_counter() - t0) * 1000
        return res

    def ok(self, **detail) -> GateResult:
        return GateResult(gate=self.name, verdict=Verdict.PASS, detail=detail)

    def fail(self, findings: list[Finding], **detail) -> GateResult:
        return GateResult(
            gate=self.name, verdict=Verdict.FAIL, findings=findings, detail=detail
        )

    def skip(self, reason: str, **detail) -> GateResult:
        return GateResult(
            gate=self.name, verdict=Verdict.SKIP, detail={"reason": reason, **detail}
        )

    def finding(self, rule: str, message: str, path: str = "", line: int = 0,
                severity: str = "error") -> Finding:
        return Finding(
            gate=self.name, rule=rule, message=message, path=path,
            line=line, severity=severity,  # type: ignore[arg-type]
        )


_PY_MODULES = {"pytest": "pytest", "ruff": "ruff", "bandit": "bandit", "pyright": "pyright"}
_probe_cache: dict[str, list[str] | None] = {}
INSTALL_HINTS = {
    "pytest": "pip install pytest pytest-timeout   (must be importable by the `python3` on PATH)",
    "ruff": "pip install ruff   (or `pip install 'skillwhet[gates]'`)",
    "bandit": "pip install bandit   (or `pip install 'skillwhet[gates]'`)",
    "pyright": "pip install pyright   (or npm i -g pyright)",
}


def _importable(python: str | None, mod: str) -> bool:
    if not python:
        return False
    try:
        return subprocess.run([python, "-c", f"import {mod}"], capture_output=True,  # noqa: S603
                              timeout=30, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def tool_command(name: str) -> list[str] | None:
    """怎么调用一个外部检查器;没装就 None。结果缓存。

    hl(动态 P2-19 / 复核 P2-4):生产上 jovyan 以 `pip --user` 装,脚本常常不在 serve 的 PATH 上,
    而模块装在当前解释器里 —— 原来 G1 / G2 用 `shutil.which` 判,缺 bandit 就让所有非 root 训练
    (都要 G1 PASS)停摆。现在按 pytest 的办法:优先 `<当前解释器> -m <模块>`,其次 PATH 上的脚本。
    pytest 本身由沙箱以 `python3 -m pytest` 跑,所以探测 PATH 上的 `python3`。"""
    if name in _probe_cache:
        return _probe_cache[name]
    cmd: list[str] | None
    if name == "pytest":
        py = shutil.which("python3")
        cmd = ["python3", "-m", "pytest"] if _importable(py, "pytest") else None
    elif name in _PY_MODULES:
        mod = _PY_MODULES[name]
        if _importable(sys.executable, mod):
            cmd = [sys.executable, "-m", mod]
        else:
            path = shutil.which(name)
            cmd = [path] if path else None
    else:
        path = shutil.which(name)
        cmd = [path] if path else None
    _probe_cache[name] = cmd
    return cmd


def tool_available(name: str) -> bool:
    return tool_command(name) is not None


def missing_tool_reason(name: str) -> str:
    return f"{name} not installed — {INSTALL_HINTS.get(name, f'install {name}')}"


def run_tool(argv: list[str], cwd: Path, timeout: int = 120) -> tuple[int, str, str]:
    """Run an external checker. Never raises; a crash is reported as rc=-1."""
    try:
        p = subprocess.run(  # noqa: S603 - argv is constructed, never shell
            argv, cwd=str(cwd), capture_output=True, text=True,
            timeout=timeout, check=False,
        )
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return -1, "", f"timeout after {timeout}s"
    except OSError as exc:
        return -1, "", str(exc)
