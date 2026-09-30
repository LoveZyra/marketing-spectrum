"""One place for how SkillWhet invokes pytest and reads what it says.

Every gate, runner and check used to build its own argv and its own regex;
the audit found them disagreeing with each other (ids with spaces invisible to
one parser, rootdir prefixes visible to one collector and not to the runner).
Now they all go through here.

Rules:
  * ``--rootdir=.`` and ``-c /dev/null``: node ids are always relative to the
    skill directory and a pytest.ini/pyproject.toml above the skill can neither
    prefix the ids nor inject ``addopts``.
  * ``-v`` lines are parsed anchored at BOTH ends, so a parametrize id may
    contain spaces, brackets or even the word "PASSED".
"""
from __future__ import annotations

import re
from pathlib import Path

_STATUSES = "PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS"

# `tests/unit/test_x.py::test_p[hello world] PASSED   [ 33%]`
NODE_LINE = re.compile(
    rf"^(?P<id>\S+::.+?)\s+(?P<st>{_STATUSES})(?:\s+\[\s*\d+%\])?\s*$",
    re.MULTILINE,
)
# `___________________ test_p[hello world] ___________________`
FAILURE_HEADER = re.compile(r"^_{3,}\s*(?P<title>.+?)\s*_{3,}\s*$", re.MULTILINE)
SUMMARY = re.compile(r"(\d+) (passed|failed|error|errors|skipped|xfailed|xpassed)")


def argv(target: str = "tests/unit", *, verbose: bool = True, tb: str = "short",
         timeout_s: int | None = None, extra: list[str] | None = None) -> list[str]:
    """The canonical pytest command line, run with cwd = skill dir."""
    # -p skillwhet.pytest_bind: pin the skill's own `scripts/` (a namespace package)
    # before a stray regular `scripts` package on the host can shadow it — see that module.
    out = ["python3", "-m", "pytest", target, "--rootdir=.", "-c", "/dev/null",
           "--no-header", "-p", "no:cacheprovider", "-p", "skillwhet.pytest_bind", f"--tb={tb}"]
    if verbose:
        out.append("-v")
    if timeout_s:
        out.append(f"--timeout={timeout_s}")
    if extra:
        out += extra
    return out


def strip_timeout(args: list[str]) -> list[str]:
    """pytest-timeout is optional; drop the flag when pytest rejects it."""
    return [a for a in args if not a.startswith("--timeout")]


def rejected_timeout(out: str) -> bool:
    return "unrecognized arguments: --timeout" in out


def parse_verbose(out: str) -> dict[str, str]:
    """node id → PASSED/FAILED/ERROR/SKIPPED/XFAIL/XPASS, from ``-v`` output."""
    return {m.group("id"): m.group("st") for m in NODE_LINE.finditer(out)}


def status_map(out: str) -> dict[str, bool]:
    """node id → passed. Skipped tests are omitted: they carry no verdict."""
    res = {}
    for nid, st in parse_verbose(out).items():
        if st in ("PASSED", "XPASS", "XFAIL"):
            res[nid] = True
        elif st in ("FAILED", "ERROR"):
            res[nid] = False
    return res


def counts(out: str) -> tuple[int, int, int]:
    """(passed, failed, errors) from the final summary line."""
    passed = failed = errors = 0
    for m in SUMMARY.finditer(out):
        n, kind = int(m.group(1)), m.group(2)
        if kind == "passed":
            passed = n
        elif kind == "failed":
            failed = n
        elif kind.startswith("error"):
            errors = n
    return passed, failed, errors


def collectable(rc: int, out: str) -> bool:
    """rc 0/1 with at least one verdict line, i.e. the session actually ran tests."""
    return rc in (0, 1) and bool(parse_verbose(out))


def node_title(node_id: str) -> str:
    """What pytest prints in a failure header: `TestX.test_y[param]`."""
    parts = node_id.split("::")[1:]
    return ".".join(parts)


def failure_blocks(out: str) -> dict[str, str]:
    """Failure-header title → the block that follows it (through the next header).

    Titles are matched exactly, never by substring: the audit caught
    ``test_parse`` receiving ``test_parse_empty``'s traceback. Captured
    stdout/stderr sections are cut off so a script that *prints* a line
    that looks like an exception cannot masquerade as one.
    """
    marks = list(FAILURE_HEADER.finditer(out))
    blocks: dict[str, str] = {}
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(out)
        title = m.group("title")
        for prefix in ("ERROR at setup of ", "ERROR at teardown of ", "ERROR collecting "):
            if title.startswith(prefix):
                title = title[len(prefix):]
        chunk = out[m.start():end]
        cap = re.search(r"^-{3,} Captured .* -{3,}\s*$", chunk, re.MULTILINE)
        if cap:
            chunk = chunk[:cap.start()]
        blocks.setdefault(title, chunk)
    return blocks


def failure_block(out: str, node_id: str) -> str:
    return failure_blocks(out).get(node_title(node_id), "")


def collect_ids(skill_dir: Path, subdir: str = "tests/unit") -> list[str]:
    """Node ids under *subdir*, relative to the skill dir. Zero model calls."""
    from .sandbox import SandboxPolicy, run_sandboxed
    res = run_sandboxed(
        argv(subdir, verbose=False, extra=["--collect-only", "-q"]),
        Path(skill_dir), SandboxPolicy(wall_timeout_s=120),
    )
    return [ln.strip() for ln in (res.stdout or "").splitlines()
            if "::" in ln and not ln.startswith((" ", "<"))]
