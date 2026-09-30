"""Filesystem helpers shared by the ledger, governance and promotion.

The one rule: internal directories are recognised RELATIVE to the skill root.
Checking ``".evo" in path.parts`` on an absolute path made every file of the
training working copy (which lives at ``<live>/.evo/current``) invisible to
the ledger, so governance blocked every round (audit B1).
"""
from __future__ import annotations

from pathlib import Path
from typing import Iterable, Iterator

INTERNAL_DIRS = frozenset({".evo", "__pycache__", ".pytest_cache", ".ruff_cache",
                           ".mypy_cache", ".git"})


def is_internal(rel: Path) -> bool:
    return any(part in INTERNAL_DIRS for part in rel.parts)


def iter_skill_files(root: Path, suffixes: Iterable[str] | None = None) -> Iterator[Path]:
    """Regular files under *root*, skipping internal dirs relative to *root*."""
    root = Path(root)
    want = set(suffixes) if suffixes else None
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        if is_internal(p.relative_to(root)):
            continue
        if want is None or p.suffix in want:
            yield p
