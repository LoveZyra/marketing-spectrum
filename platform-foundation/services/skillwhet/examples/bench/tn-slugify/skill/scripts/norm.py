"""Text normalisation helpers."""
from __future__ import annotations

import re
import unicodedata


def slugify(text: str, max_len: int = 60) -> str:
    """Lower-case, fold accents, collapse non-alphanumerics to '-', truncate."""
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    if len(s) > max_len:
        s = s[:max_len]
    return s


def dedupe_lines(text: str, ignore_case: bool = False) -> str:
    """Drop duplicate lines, keeping the first occurrence and the order."""
    seen: set[str] = set()
    out: list[str] = []
    for line in text.splitlines():
        key = line.rstrip()
        if ignore_case:
            key = key.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(line)
    return "\n".join(out)


def word_count(text: str) -> int:
    """Count whitespace-separated words; bare punctuation is not a word."""
    return sum(1 for tok in text.split() if re.search(r"[A-Za-z0-9]", tok))
