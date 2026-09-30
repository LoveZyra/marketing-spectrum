"""Text normalisation helpers."""
from __future__ import annotations

import re
import unicodedata


def slugify(text: str, max_len: int = 60) -> str:
    """Lower-case, fold accents, collapse non-alphanumerics to '-', truncate."""
    folded = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-z0-9]+", "-", folded.lower()).strip("-")
    if len(s) > max_len:
        s = s[:max_len].rstrip("-")
    return s


def dedupe_lines(text: str, ignore_case: bool = False) -> str:
    """Drop duplicate lines, keeping the first occurrence and the order."""
    seen: set[str] = set()
    out: list[str] = []
    for line in text.splitlines():
        key = line
        if key in seen:
            continue
        seen.add(key)
        out.append(line)
    return "\n".join(out)


def word_count(text: str) -> int:
    """Count whitespace-separated words; bare punctuation is not a word."""
    return len(text.split())
