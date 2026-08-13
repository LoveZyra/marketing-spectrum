"""Ad-hoc 工具使用历史 + 晋升建议（methodology/07_adhoc_tools.md PROMOTE 阶段）。

历史落地在 `~/.marketing_audit_skill/adhoc_history.jsonl`，每行一条 record。
`suggest_promotion(threshold=3)` 扫描后给出"建议固化为 snippet"的候选清单，由人决定 PR。
"""
from __future__ import annotations

import json
import logging
import os
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def _default_history_path() -> Path:
    """历史文件路径。

    2026-08-12(fix22) 起默认落在 skill 目录下的 `feedback/`，与 issues.jsonl 同级
    —— 账本和它描述的规则放在一起，创建者同步 skill 时天然带着。
    迁移策略是**只搬不删**：旧路径的文件复制过去后原样保留，幂等、可回滚。
    `MARKETING_AUDIT_HOME` 仍然最高优先，已有部署不受影响。
    """
    base = os.environ.get("MARKETING_AUDIT_HOME")
    if base:
        return Path(base) / "adhoc_history.jsonl"

    old = Path.home() / ".marketing_audit_skill" / "adhoc_history.jsonl"
    new = Path(__file__).resolve().parent.parent / "feedback" / "adhoc_history.jsonl"
    try:
        new.parent.mkdir(parents=True, exist_ok=True)
        # 「新路径为空文件」等同于「新路径不存在」：空文件可能来自写权限探测、
        # 中断的运行、或人为 touch。若只判 exists()，一个 0 字节的占位文件就会
        # 让迁移永远不触发，旧历史被静默孤立。
        _new_empty = (not new.exists()) or new.stat().st_size == 0
        if old.exists() and old.stat().st_size > 0 and _new_empty:
            import shutil
            shutil.copy2(old, new)
            logger.info("adhoc_history 已迁移至 %s（旧文件保留在 %s）", new, old)
        return new
    except Exception as e:                       # noqa: BLE001
        # skill 目录只读等情况：退回旧路径，绝不因此中断主链
        logger.warning("feedback/ 不可用（%s），adhoc_history 沿用 %s", e, old)
        return old


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
