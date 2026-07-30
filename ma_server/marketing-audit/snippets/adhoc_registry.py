"""Ad-hoc 工具使用历史 + 晋升建议（methodology/07_adhoc_tools.md PROMOTE 阶段）。

历史落地在 `~/.marketing_audit_skill/adhoc_history.jsonl`，每行一条 record。
`suggest_promotion(threshold=3)` 扫描后给出"建议固化为 snippet"的候选清单，由人决定 PR。
"""
from __future__ import annotations

import json
import os
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


def _default_history_path() -> Path:
    base = os.environ.get("MARKETING_AUDIT_HOME")
    if base:
        return Path(base) / "adhoc_history.jsonl"
    return Path.home() / ".marketing_audit_skill" / "adhoc_history.jsonl"


def record_usage(spec: dict[str, Any], code_hash: str | None = None,
                 campaign_id: str | None = None,
                 path: Path | None = None) -> Path:
    """追加一条使用记录。返回历史文件路径。"""
    path = path or _default_history_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    record = {
        "ts": time.time(),
        "code_hash": code_hash or spec.get("code_hash"),
        "name": spec.get("name"),
        "purpose": spec.get("purpose"),
        "input_columns": spec.get("input_columns") or [],
        "campaign_id": campaign_id,
    }
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, default=str) + "\n")
    return path


def load_history(path: Path | None = None) -> list[dict]:
    path = path or _default_history_path()
    if not path.exists():
        return []
    out: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


def suggest_promotion(threshold: int = 3, path: Path | None = None) -> list[dict]:
    """扫描历史，对命中 ≥ threshold 的 code_hash 输出晋升建议。

    返回:
        [
          {
            "code_hash": "...", "name": "...", "uses": N,
            "campaigns": ["camp1", "camp2"],
            "purpose_samples": [...],
            "input_columns": [...],
            "suggested_path": "snippets/<name>.py",
            "suggested_manifest_entry": "domain_<name> | adhoc_<name>"
          }
        ]
    """
    records = load_history(path)
    if not records:
        return []
    counts: Counter[str] = Counter()
    by_hash: dict[str, dict] = defaultdict(lambda: {
        "names": set(), "campaigns": set(), "purposes": set(), "input_columns": set(),
    })
    for r in records:
        h = r.get("code_hash")
        if not h:
            continue
        counts[h] += 1
        bucket = by_hash[h]
        if r.get("name"):
            bucket["names"].add(r["name"])
        if r.get("campaign_id"):
            bucket["campaigns"].add(r["campaign_id"])
        if r.get("purpose"):
            bucket["purposes"].add(r["purpose"])
        for c in r.get("input_columns") or []:
            bucket["input_columns"].add(c)

    suggestions: list[dict] = []
    for h, n in counts.most_common():
        if n < threshold:
            break
        b = by_hash[h]
        primary_name = sorted(b["names"])[0] if b["names"] else f"adhoc_{h[:8]}"
        suggestions.append({
            "code_hash": h,
            "name": primary_name,
            "alt_names": sorted(b["names"] - {primary_name}),
            "uses": n,
            "campaigns": sorted(b["campaigns"]),
            "purpose_samples": sorted(b["purposes"])[:3],
            "input_columns": sorted(b["input_columns"]),
            "suggested_path": f"snippets/{primary_name}.py",
            "suggested_manifest_entry": f"adhoc_promoted_{primary_name}",
        })
    return suggestions
