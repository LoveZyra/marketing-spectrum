"""pytest plugin: bind the skill's own top-level package dirs before anything else.

Skills keep their code in ``scripts/`` (no ``__init__.py`` — a namespace package)
and their tests do ``from scripts.extract import …``. That works on a clean
interpreter and silently breaks on a real host: Python resolves a *regular*
package named ``scripts`` found anywhere on ``sys.path`` — a stray one shipped
by some pip package in the user's site-packages — **before** it will synthesise
a namespace package from the skill dir, whatever the ``sys.path`` order is.
The symptom is ``ModuleNotFoundError: No module named 'scripts.extract'`` for
every skill, so G4/G5 fail on that machine and pass everywhere else
(first hit: the ubuntu test box, 2026-09-23).

Loaded with ``-p skillwhet.pytest_bind`` from :func:`pytestio.argv`, i.e. for
every pytest run the trainer starts (gates, runner, mutation, evolve_tests).
It runs at plugin-load time, before conftest and before any test module: for
each direct subdirectory of the cwd (= skill dir) that holds ``.py`` files and
has no ``__init__.py``, it registers a namespace module pinned to that
directory. Directories the skill did not write (``tests``, dotfiles, ``.evo``)
are left alone; a subdir with ``__init__.py`` is a regular package and wins on
its own.
"""
from __future__ import annotations

import os
import sys
import types
from pathlib import Path

SKIP = {"tests", "test", "__pycache__", "node_modules"}


def bind(skill_dir: Path | None = None) -> list[str]:
    root = Path(skill_dir or os.getcwd()).resolve()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    bound: list[str] = []
    for child in sorted(root.iterdir()):
        name = child.name
        if not child.is_dir() or name in SKIP or name.startswith(".") or not name.isidentifier():
            continue
        if (child / "__init__.py").exists() or not any(child.glob("*.py")):
            continue
        existing = sys.modules.get(name)
        if existing is not None and str(child) in list(getattr(existing, "__path__", []) or []):
            continue
        mod = types.ModuleType(name)
        mod.__path__ = [str(child)]  # type: ignore[attr-defined]
        mod.__package__ = name
        mod.__file__ = None  # namespace-like: no single file
        sys.modules[name] = mod
        bound.append(name)
    return bound


bind()
