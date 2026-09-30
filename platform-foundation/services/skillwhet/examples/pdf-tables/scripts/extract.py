"""Table extraction helpers."""
from __future__ import annotations

import re


def extract_tables(path: str, pages: str | None = None) -> list[list[list[str]]]:
    """Extract tables from a PDF at *path*.

    This reference implementation parses a simple pipe-delimited sidecar so the
    example stays dependency-free.
    """
    tables: list[list[list[str]]] = []
    current: list[list[str]] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line.strip():
                if current:
                    tables.append(current)
                    current = []
                continue
            current.append([normalize_cell(c) for c in line.split("|")])
    if current:
        tables.append(current)
    return tables


def normalize_cell(raw: str) -> str:
    """Collapse whitespace and strip currency symbols from one cell."""
    return re.sub(r"\s+", " ", raw).strip().lstrip("$€£¥").strip()
