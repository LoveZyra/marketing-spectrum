"""人群规则翻译器：pandas 布尔表达式 → Spark SQL，并汇总 crowd_rules.json。

供 report_renderer 在 render 时产出 crowd_rules.json（一等公民人群规则产物），
也可被外部 pipeline driver 导入复用，避免规则→SQL 翻译逻辑散落多处。
"""
from __future__ import annotations
import re

# finding/规则 _signal_type → 人群方向。segment schema 的 direction 有三值（push/exclude/促付），
# 但人群圈选只有 push/exclude 两侧：促付（创单未付）用户不应再推本活动，圈人时归 exclude，
# 原值保留在 direction_raw 供催付类活动/报告侧取用。
_DIR_MAP = {"positive": "push", "causal": "exclude", "leakage": "exclude"}
VALID_DIRECTIONS = ("push", "exclude")

# 二值/计数特征树切分点哨兵（如 1e-35）：仅指数 ≥20 视为哨兵做归一化；
# 真实小阈值（率值特征的 3e-05 等，Python repr 即科学计数法）保持原样，
# Spark SQL 原生支持科学计数法字面量，无需改写。
_SENTINEL = r"[\d.]+e-(?:[2-9]\d|\d{3,})\b"


def signal_to_direction(sig: str | None) -> str:
    return _DIR_MAP.get(sig, "exclude")


def pandas_to_sql(cond: str) -> str:
    """把诊断规则的 pandas 布尔表达式翻译成 Spark SQL WHERE（best-effort）。

    覆盖现有规则集出现的语法：
      .str.contains('x', na=False) → LIKE '%x%'
      col.notna() / col.isna()     → col IS NOT NULL / col IS NULL
      col.isin([a,b])              → col IN (a,b)
      != → <> ；== → = ；& → AND ；| → OR ；~( → NOT (
    字符串字面量内的运算符不会被替换；哨兵阈值（指数≥20 的科学计数法，如 1e-35）
    归一化为 >=1/<=0/>0，真实小阈值（如 3e-05）原样保留。
    未覆盖的语法原样返回（调用方需校验可执行性，建议对人群表做 LIMIT 0 dry-run）。
    """
    if not cond:
        return ""
    s = cond
    # 1) 字符串包含（含可选的 na= 参数）
    s = re.sub(r"(\w+)\.str\.contains\(\s*['\"]([^'\"]*)['\"](?:[^)]*)\)", r"\1 LIKE '%\2%'", s)
    # 2) 空值判断
    s = re.sub(r"(\w+)\.notna\(\)", r"\1 IS NOT NULL", s)
    s = re.sub(r"(\w+)\.isna\(\)", r"\1 IS NULL", s)
    # 3) isin
    s = re.sub(r"(\w+)\.isin\(\s*\[([^\]]*)\]\s*\)", r"\1 IN (\2)", s)
    # 3.5) 哨兵阈值归一化（语义为 ==0 / >=1）：仅指数 ≥20 的极小值（树切分哨兵 1e-35 等）；
    #      真实小阈值（3e-05 这类率值切分点）不动，避免语义反转
    s = re.sub(r">=\s*" + _SENTINEL, ">= 1", s)   # xgb: >=1e-35 → >=1（二值==1）
    s = re.sub(r"<=\s*" + _SENTINEL, "<= 0", s)   # lgb: <=1e-35 → <=0（二值==0）
    s = re.sub(r">\s*" + _SENTINEL, "> 0", s)     # lgb: >1e-35  → >0 （二值==1）
    # 4) 比较/逻辑运算符。先摘走字符串字面量，避免字面量内的 &/|/==/!= 被误改
    lits: list[str] = []

    def _stash(m: "re.Match[str]") -> str:
        lits.append(m.group(0))
        return "\x00{}\x00".format(len(lits) - 1)

    s = re.sub(r"'[^']*'|\"[^\"]*\"", _stash, s)
    s = s.replace("!=", "<>")   # 先 != 再 ==，避免误伤
    s = s.replace("==", "=")
    s = s.replace("&", " AND ").replace("|", " OR ")
    s = re.sub(r"~\s*\(", "NOT (", s)
    # 5) 收紧空格，放回字面量
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\x00(\d+)\x00", lambda m: lits[int(m.group(1))], s)
    return s


def build_crowd_rules(report: dict) -> list[dict]:
    """从报告汇总可执行人群规则：诊断规则(effective_signal) + audience_segments。"""
    rules: list[dict] = []

    # 1) 诊断规则：取 effective_signal==True，按 _signal_type 定方向
    drs = (report.get("data_overview") or {}).get("diagnostic_rules_summary") or []
    for r in drs:
        if not r.get("effective_signal"):
            continue
        cond = r.get("condition") or ""
        rules.append({
            "source": "diagnostic_rule",
            "rule_id": r.get("rule_id"),
            "name": r.get("display_name") or r.get("name"),
            "direction": signal_to_direction(r.get("_signal_type")),
            "_signal_type": r.get("_signal_type"),
            "pandas_filter": cond,
            "sql_filter": pandas_to_sql(cond),
            "estimated_size": int(r.get("trigger_cnt") or 0),
            "cvr_triggered": r.get("cvr_triggered"),
            "cvr_not_triggered": r.get("cvr_not_triggered"),
            "cvr_gap": r.get("cvr_gap"),
            "significant": bool(r.get("cvr_gap_significant")),
        })

    # 2) audience_segments：优先用 segment 自带的 filter_conditions_sql（模型seg），
    #    否则把 pandas filter_conditions 翻译成 SQL（规则seg）
    for s in report.get("audience_segments") or []:
        cond = s.get("filter_conditions") or ""
        sql = s.get("filter_conditions_sql") or pandas_to_sql(cond)
        direction = s.get("direction") or "push"
        direction_raw = None
        if direction not in VALID_DIRECTIONS:
            # 促付（创单未付，schema 合法值）等第三方向：圈人只有 push/exclude 两侧，
            # 归 exclude（不再推本活动），原值记 direction_raw 供催付类活动取用
            print("[crowd_translator] ℹ segment {!r} direction={!r} → 圈人按 exclude，原值记 direction_raw".format(
                s.get("name"), direction))
            direction_raw = direction
            direction = "exclude"
        rules.append({
            "source": "audience_segment",
            "name": s.get("name"),
            "direction": direction,
            **({"direction_raw": direction_raw} if direction_raw else {}),
            "pandas_filter": cond,
            "sql_filter": sql,
            "estimated_size": int(s.get("estimated_size") or 0),
            "baseline_cvr": s.get("baseline_cvr"),
            "expected_cvr_mid": s.get("expected_cvr_mid"),
            "finding_id": s.get("finding_id"),
        })

    return rules
