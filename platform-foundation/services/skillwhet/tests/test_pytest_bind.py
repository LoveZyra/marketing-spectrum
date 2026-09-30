"""A stray regular `scripts` package on the host must not shadow the skill's own."""
from pathlib import Path

from skillwhet import pytestio
from skillwhet.sandbox import SandboxPolicy, run_sandboxed

import shutil

EXAMPLE = Path(__file__).resolve().parents[1] / "examples" / "pdf-tables"


def make_skill(root: Path) -> Path:
    d = root / "pdf-tables"
    shutil.copytree(EXAMPLE, d, ignore=shutil.ignore_patterns(".evo", "__pycache__"))
    return d


def _shadow(tmp_path: Path) -> Path:
    stray = tmp_path / "stray-site" / "scripts"
    stray.mkdir(parents=True)
    (stray / "__init__.py").write_text("# a regular package named scripts, shipped by some pip package\n")
    return stray.parent


def test_regular_scripts_package_on_path_would_shadow_the_skill(tmp_path: Path):
    skill = make_skill(tmp_path)
    policy = SandboxPolicy(extra_env={"PYTHONPATH": str(_shadow(tmp_path))})
    full = pytestio.argv("tests/unit")
    i = full.index("skillwhet.pytest_bind")
    argv = full[:i - 1] + full[i + 1:]          # drop the "-p skillwhet.pytest_bind" pair
    without = run_sandboxed(argv, skill, policy)
    assert without.returncode == 2 and "No module named 'scripts." in without.stdout, without.stdout[-800:]


def test_bind_plugin_pins_the_skill_scripts_dir(tmp_path: Path):
    skill = make_skill(tmp_path)
    policy = SandboxPolicy(extra_env={"PYTHONPATH": str(_shadow(tmp_path))})
    with_bind = run_sandboxed(pytestio.argv("tests/unit"), skill, policy)
    assert "No module named 'scripts." not in with_bind.stdout, with_bind.stdout[-800:]
    status = pytestio.parse_verbose(with_bind.stdout)
    assert status and any(k.startswith("tests/unit/") for k in status)


def test_sandbox_keeps_the_real_user_site_when_home_is_redirected(tmp_path: Path):
    """gz 现场:HOME 指到副本后,非 root 用 --user 装的 pytest 在沙箱里找不到(rc=1,No module named pytest)。"""
    import site
    import sys
    skill = make_skill(tmp_path)
    res = run_sandboxed([sys.executable, "-c",
                         "import os, site; print(os.environ['HOME']); print(site.getuserbase())"],
                        skill, SandboxPolicy())
    home_line, base_line = res.stdout.strip().splitlines()[-2:]
    assert home_line == str(skill.resolve()) or home_line == str(skill)
    assert base_line == site.getuserbase(), "user base must not follow the redirected HOME"
