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

# 二值/计数特征树切分点哨兵（如 1e-35）：仅指数 ≥20 视为哨兵，归一化为 >=1/<=0/>0。
_SENTINEL = r"[\d.]+e-(?:[2-9]\d|\d{3,})\b"

# fix20：非哨兵的科学计数法一律改写成位置计数（3e-05 → 0.00003）。
# 此前这里写的是"Spark SQL 原生支持科学计数法字面量，无需改写"——SQL 能不能执行是一回事，
# 但 sql_filter 同时会进报告展示与 org_json 给人看，`3e-05` 对运营不可读；
# 阈值不出科学计数法是全链路的统一约定（见 model_analyst/_fmt_threshold），
# 这里是落到 SQL 前的最后一道，源头漏了也在此兜住。
_SCI_NUM = re.compile(r"(?<![\w.])\d+(?:\.\d+)?[eE][+-]?\d+")


_MAX_DECIMALS = 4   # 阈值最多保留 4 位小数（与 model_analyst._MAX_DECIMALS 同一约定）


def _sci_to_plain(text: str) -> str:
    """科学计数法数字字面量 → 位置计数写法，最多 4 位小数；改不动的原样保留。

    4 位会把值抹成 0 的极小阈值（3e-05 这类率值切分点）才继续加位数取非零写法 ——
    直接抹成 0 会让 `> 0.00003` 变成 `> 0`，语义全变。
    """
    def _one(m: "re.Match[str]") -> str:
        raw = m.group(0)
        try:
            v = float(raw)
        except ValueError:
            return raw
        if v == int(v):
            return str(int(v))
        s = f"{v:.{_MAX_DECIMALS}f}".rstrip("0").rstrip(".")
        if s and float(s) != 0:
            return s
        for nd in (6, 8, 10, 12, 15, 20):
            s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
            if s and float(s) != 0:
                return s
        return raw                        # <1e-20 的只可能是哨兵，交给哨兵归一化
    return _SCI_NUM.sub(_one, text)


# 长尾小数(≥5 位)：树切分点的浮点噪声长这样(2.5000000000000004 / 15.520000000000001)
_LONG_DEC = re.compile(r"(?<![\w.])\d+\.\d{5,}(?![\w.])")
_NOISE_REL = 1e-9   # 四舍五入后相对误差 ≤ 此值 ⇒ 判定为浮点噪声，可安全抹平


def _trim_float_noise(text: str) -> str:
    """把浮点噪声造成的长尾小数收到 4 位；**只抹噪声，不改真值**。

    判据是四舍五入前后的相对误差：`2.5000000000000004`→`2.5` 差 1.8e-16，是噪声；
    而 `0.00003`(率值切分点)或 diagnostic_rules.yaml 里手写的 `0.12345` 收到 4 位会
    差好几个数量级，超出容差就原样保留 —— 手写规则的精度不该被这道工序动到。
    模型侧的阈值在源头(_fmt_threshold)已经是 4 位，这里是落到 SQL 前的兜底。
    """
    def _one(m: "re.Match[str]") -> str:
        raw = m.group(0)
        try:
            v = float(raw)
        except ValueError:
            return raw
        s = f"{v:.{_MAX_DECIMALS}f}".rstrip("0").rstrip(".")
        if not s:
            return raw
        try:
            r = float(s)
        except ValueError:
            return raw
        if r != 0 and abs(r - v) <= abs(v) * _NOISE_REL:
            return s
        return raw
    return _LONG_DEC.sub(_one, text)


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
    归一化为 >=1/<=0/>0，其余科学计数法（如 3e-05）改写为等值位置计数（0.00003）——
    出参 sql_filter 同时要给人看，全链路约定阈值不出科学计数法。
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
    # 4.5) 数字规整:科学计数法 → 位置计数;长尾小数抹掉浮点噪声(只抹噪声,不改真值)。
    #      放在字面量摘走之后做,字符串里的 '3e-05'、品类名里的长小数绝不会被动到。
    s = _trim_float_noise(_sci_to_plain(s))
    s = s.replace("!=", "<>")   # 先 != 再 ==，避免误伤
    s = s.replace("==", "=")
    s = s.replace("&", " AND ").replace("|", " OR ")
    s = re.sub(r"~\s*\(", "NOT (", s)
    # 5) 收紧空格，放回字面量
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"\x00(\d+)\x00", lambda m: lits[int(m.group(1))], s)
    return s


_PLACEHOLDER_RE = re.compile(r"\[待润色[^\]]*\]|\[TODO[^\]]*\]|【待润色[^】]*】|TODO|待补充")


# 建议动作取不到时的兜底话术(按方向)。与 API 侧 ma_pipeline._SUGG_DEFAULT 保持同一套口径,
# 两条链路(离线 render 产出 / API 出参回填)对同一批人给出同一句话。
# 促付(创单未付)圈人时归 exclude,但 direction_raw 留着原值,这里优先认它。
_SUGG_DEFAULT = {
    "push": "建议下一周期对该人群优先投放或预算倾斜",
    "exclude": "建议本活动暂缓向该人群推送，减少无效触达",
    "促付": "建议对该人群做创单未付促付提醒",
}


def _clean_action(text: "str | None") -> str:
    """草稿占位句一律当"没写"(返回空串),交给调用方兜底;正常文案原样返回。

    只删 `[待润色]` 标记是不够的:草稿骨架句本身就是占位内容
    (「按 finding 建议方向投放/排除/促付。[待润色]」),删标记后剩的半句照样是骨架。
    注意本函数只读不写 —— 人群段自己的 action 一个字都不动,state 里的 `[待润色]`
    标记原样保留,润色空槽扫描/完备性门禁/报告展示都照常认得出来。
    """
    t = text or ""
    if _PLACEHOLDER_RE.search(t):
        return ""
    s = t.strip().strip("。;；,，、 ")
    return s if len(s) >= 4 else ""


def _suggestion_for(seg: dict, direction: str, direction_raw: "str | None") -> str:
    """人群段 → 建议动作。action → 圈人理由首句 → 按方向兜底,保证非空。

    离线流程在 render 时产出本文件,拿到的是定稿文案;但万一那一单润色降级、
    action 还留着占位句,这里不再交出空串 —— 与 API 侧同一套兜底口径。
    """
    text = _clean_action(seg.get("action"))
    if not text:
        # 先整段判占位再取首句:草稿理由的标记在第二句
        #(「对应「X」的人群，建议定向干预。[待润色]」),先切句会把骨架首句当正文放行
        whole = _clean_action(seg.get("rationale"))
        text = _clean_action(whole.split("。")[0]) if whole else ""
    if not text:
        key = (direction_raw or "").strip() or (direction or "").strip()
        text = _SUGG_DEFAULT.get(key) or _SUGG_DEFAULT["push"]
    return text


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
            # fix20:人群对应的建议动作(= 报告「可落地人群包」的第三列),保证非空。
            # 离线流程在 render 时生成本文件,拿到的已是定稿文案;API 模式下本步在
            # 润色之前,这里多半是占位句→走兜底,出参前由 ma_pipeline 用定稿再刷一遍。
            "suggestion": _suggestion_for(s, direction, direction_raw),
        })

    return rules
