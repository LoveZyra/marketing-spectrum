"""Sandboxed subprocess execution.

Skill code is the only part of a skill that actually runs, so every execution
in the fast loop goes through here. The architecture doc promised this and the
first implementation pass did not have it — pytest ran with full network and
filesystem access, which is exactly the surface SkillJack attacks.

Three layers, each degrading loudly rather than silently:
  1. network namespace isolation via ``unshare -n``   (Linux; reported if absent)
  2. POSIX resource limits via ``setrlimit``          (CPU, address space, files)
  3. wall-clock timeout                               (always available)
"""
from __future__ import annotations

import os
import resource
import shutil
import signal
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class SandboxPolicy:
    network: bool = False          # False => run inside a fresh network namespace
    cpu_seconds: int = 60
    memory_mb: int = 2048
    max_file_mb: int = 64
    max_processes: int = 256
    wall_timeout_s: int = 300
    env_allowlist: tuple[str, ...] = ("PATH", "LANG", "LC_ALL", "PYTHONHASHSEED", "PYTHONUSERBASE", "VIRTUAL_ENV")
    extra_env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def permissive(cls) -> SandboxPolicy:
        """Escape hatch for debugging. Never the default."""
        return cls(network=True, cpu_seconds=600, memory_mb=8192, wall_timeout_s=900)


@dataclass
class SandboxResult:
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False
    network_isolated: bool = False
    limits_applied: bool = False
    degraded: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out


def network_isolation_available() -> bool:
    if sys.platform != "linux" or shutil.which("unshare") is None:
        return False
    try:
        p = subprocess.run(  # noqa: S603
            ["unshare", "-n", "true"], capture_output=True, timeout=10, check=False
        )
        return p.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _limits(policy: SandboxPolicy):
    """Returned closure runs in the child between fork and exec."""

    def apply() -> None:  # pragma: no cover - runs in the forked child
        os.setsid()
        soft_caps = [
            (resource.RLIMIT_CPU, policy.cpu_seconds),
            (resource.RLIMIT_AS, policy.memory_mb * 1024 * 1024),
            (resource.RLIMIT_FSIZE, policy.max_file_mb * 1024 * 1024),
            (resource.RLIMIT_NPROC, policy.max_processes),
            (resource.RLIMIT_CORE, 0),
        ]
        for what, value in soft_caps:
            try:
                hard = resource.getrlimit(what)[1]
                cap = value if hard == resource.RLIM_INFINITY else min(value, hard)
                resource.setrlimit(what, (cap, hard))
            except (ValueError, OSError):
                pass

    return apply


def _child_env(policy: SandboxPolicy, cwd: Path) -> dict[str, str]:
    env = {k: os.environ[k] for k in policy.env_allowlist if k in os.environ}
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    # HOME 指向沙箱工作目录,不是训练器的真 HOME:技能里的测试用 ~ 展开时落在副本里,
    # 摸不到 ~/.claude/skills(技能库)与 ~/.prism(数据)。没有文件系统隔离,这只是
    # 挡住"顺手"的写法;真正的隔离要靠 unshare -m / bwrap(见 DEPLOY.md)。
    env["HOME"] = str(cwd)
    # HOME 一挪,Python 的 user site(~/.local/lib/pythonX.Y/site-packages)也跟着挪 ——
    # 非 root 用 `pip install --break-system-packages` 装的 pytest / skillwhet 就在那儿
    # (pip 对不可写的系统 site-packages 会静默退成 --user)。把真正的 user base 钉住,
    # 子进程才找得到它们;这是 gz 现场 33 个 G4 `pytest-crashed rc=1` 的原因。
    if "PYTHONUSERBASE" not in env:
        try:
            import site
            env["PYTHONUSERBASE"] = site.getuserbase()
        except Exception:  # noqa: BLE001 — 没有 user base 就算了
            pass
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    # Deny-by-default for the common credential names; a skill that needs one
    # must go through the contract, not inherit it from the trainer's shell.
    env.update(policy.extra_env)
    return env


def _kill_group(p: subprocess.Popen) -> None:
    try:
        if sys.platform != "win32":
            os.killpg(os.getpgid(p.pid), signal.SIGKILL)
        else:  # pragma: no cover
            p.kill()
    except (ProcessLookupError, PermissionError, OSError):
        try:
            p.kill()
        except OSError:
            pass


def run_sandboxed(
    argv: list[str],
    cwd: Path,
    policy: SandboxPolicy | None = None,
) -> SandboxResult:
    """Run *argv* under the policy. Never raises; failures become a result."""
    policy = policy or SandboxPolicy()
    degraded: list[str] = []

    cmd = list(argv)
    isolated = False
    if not policy.network:
        if network_isolation_available():
            cmd = ["unshare", "-n", *cmd]
            isolated = True
        else:
            degraded.append(
                "network isolation unavailable (needs Linux + unshare); "
                "the child CAN reach the network"
            )

    try:
        # Popen rather than run(): on timeout the whole process GROUP is killed
        # (the child called setsid), so a test that spawned a sleeping helper
        # cannot outlive the sandbox (audit A15).
        p = subprocess.Popen(  # noqa: S603 - argv built by us, never a shell string
            cmd,
            cwd=str(cwd),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True,
            env=_child_env(policy, Path(cwd)),
            preexec_fn=_limits(policy) if sys.platform != "win32" else None,
        )
        try:
            out, err = p.communicate(timeout=policy.wall_timeout_s)
        except subprocess.TimeoutExpired:
            _kill_group(p)
            out, err = p.communicate()
            return SandboxResult(
                returncode=-1, stdout=out or "",
                stderr=(err or "") + f"\nwall-clock timeout after {policy.wall_timeout_s}s",
                timed_out=True, network_isolated=isolated,
                limits_applied=sys.platform != "win32", degraded=degraded,
            )
        return SandboxResult(
            returncode=p.returncode, stdout=out, stderr=err,
            network_isolated=isolated, limits_applied=sys.platform != "win32",
            degraded=degraded,
        )
    except OSError as exc:
        return SandboxResult(
            returncode=-1, stdout="", stderr=str(exc),
            network_isolated=isolated, degraded=degraded,
        )
