"""ReportRenderer — 金融纸风格报告渲染器（HTML + Markdown）。

对外暴露三个纯函数：
  - render_markdown(report) -> str
  - render_html(report)     -> str
  - save_report(report, output_dir) -> {"json","md","html"} 路径 dict

金融纸样式（字体 base64 内嵌于 assets/fonts/fonts.css）随渲染函数内联输出，自包含离线可用。

设计原则：
  · 故事化：围绕"3-5 个根本问题"展开，而非按数据维度堆砌
  · 选择性：仅展示支撑结论的数据，原始统计可折叠或不展示
  · 去 AI 化：陈述事实，不暴露"Agent / 诊断 / 分析路径"等术语
  · 留白与层次：足够的边距，严格的字号层级，单主色调
"""
from __future__ import annotations

import html as _html
import json
import math as _math
import os
import re
from datetime import datetime
from pathlib import Path

def _fin(v: object) -> bool:
    """返回 True 当且仅当 v 是有限数值（非 None、非 NaN、非 Inf）。"""
    try:
        return v is not None and not _math.isnan(float(v)) and not _math.isinf(float(v))
    except (TypeError, ValueError):
        return False


from functools import lru_cache


def _aggregate_incremental_orders(segments: list) -> int:
    """汇总预期增量（支付）订单。

    优先用 segment 的 estimated_incremental_orders；缺失时回退为
    Σ estimated_size × (expected_cvr_mid − baseline_cvr)（以支付成单为口径），
    避免摘要恒显示误导性的 0。
    """
    direct = sum(int(s.get("estimated_incremental_orders") or 0) for s in (segments or []))
    if direct:
        return direct
    est = 0.0
    for s in segments or []:
        base, mid, size = s.get("baseline_cvr"), s.get("expected_cvr_mid"), s.get("estimated_size")
        if _fin(base) and _fin(mid) and _fin(size) and float(mid) > float(base):
            est += float(size) * (float(mid) - float(base))
    return int(round(est))


@lru_cache(maxsize=1)
def _registry_feature_zh() -> dict:
    """从 feature_registry.yaml 读 {字段名: 中文描述}，供裸字段名兜底中文化。

    pyyaml/文件缺失时返回空 dict，渲染层据此回退到原字段名，不抛错。
    """
    try:
        import yaml  # type: ignore
        path = Path(__file__).resolve().parent.parent / "feature_schema" / "feature_registry.yaml"
        reg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return {f["name"]: f.get("description", "")
                for f in reg.get("features", []) if f.get("name")}
    except Exception:
        return {}

@lru_cache(maxsize=1)
def _registry_feature_types() -> dict:
    """从 feature_registry.yaml 读 {字段名: type}，供中文条件判断二值字段。"""
    try:
        import yaml  # type: ignore
        path = Path(__file__).resolve().parent.parent / "feature_schema" / "feature_registry.yaml"
        reg = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        return {f["name"]: (f.get("type") or "")
                for f in reg.get("features", []) if f.get("name")}
    except Exception:
        return {}


# 条件表达式里不该被当作字段名替换的保留字
_COND_KEYWORDS = {
    "and", "or", "not", "in", "na", "True", "False", "None",
    "str", "contains", "isin", "isna", "notna", "fillna", "dt", "astype",
}

# 先长后短，避免 >= 被 > 切开
_COND_OPS = [(">=", " ≥ "), ("<=", " ≤ "), ("!=", " ≠ "), ("==", " = "),
             (">", " > "), ("<", " < ")]

# 「是否X」型二值字段：X 是这几个动词时用「已/未」，其余一律「有/无」
# （"已转化/未成单" 比 "有转化/无成单" 顺口；而 "已营销作为首触点" 就不通了）
_BINARY_DONE_WORDS = {"转化", "成单", "创单", "付款", "支付"}


def _zh_label(field: str) -> str:
    """字段名 → 中文标签。复用报告其余部分同一套口径，保证前后叫法一致。"""
    return ReportRenderer._humanize_feature(field)


def _binary_phrase(field: str, is_one: bool) -> str:
    """二值字段的 ==1/==0 → 「已转化」「站内多渠道推送品类不一致」这类说法。

    「A是否B」必须保留限定语 A —— 只取 B 会把
    "站内多渠道推送品类是否一致" 压成光秃秃的「无一致」，运营看不出说的是哪件事。
    """
    lab = _zh_label(field)
    i = lab.find("是否")
    if i >= 0:
        prefix, suffix = lab[:i], lab[i + 2:]
        if suffix.startswith("有"):          # "触达前是否有X" → 触达前有X / 触达前无X
            return prefix + (suffix if is_one else "无" + suffix[1:])
        if not prefix:                       # "是否转化" → 已转化 / 未转化
            if suffix in _BINARY_DONE_WORDS:
                return ("已" if is_one else "未") + suffix
            return ("有" if is_one else "无") + suffix
        # "A是否B" → AB / A不B；B 是「…过」这类完成体时用「未」
        # （"近1天是否浏览过X" 的否定是"近1天未浏览过X"，写成"不浏览过"不通）
        neg = "未" if "过" in suffix else "不"
        return prefix + (suffix if is_one else neg + suffix)
    if lab.startswith("有"):
        return lab if is_one else "无" + lab[1:]
    if lab in _BINARY_DONE_WORDS:
        return ("已" if is_one else "未") + lab
    return ("有" if is_one else "无") + lab


def humanize_condition(cond: str) -> str:
    """pandas 布尔表达式 → 运营可读的中文条件。

    只做**展示层投影**：`filter_conditions` 原文一个字都不改，下游圈人仍以原文为准。
    翻不动的片段原样保留 —— 宁可露出一小段英文，也不能猜错语义。
    任何异常都吞掉返回空串（附录多一列空白，好过整张报告渲不出来）。

    例：
      pre_train_depth<1 and pre_create_order_cnt>=1
        → 火车票漏斗深度 < 1 且 历史创单次数 ≥ 1
      (is_converted == 1) & (is_paid == 0)
        → （已转化）且（未成单）
    """
    if not cond or not str(cond).strip():
        return ""
    try:
        t = str(cond)

        # ① 摘走字符串字面量，避免其中的字段名/运算符被误替换。
        #    占位符用非标识符字符，后面的 \b\w+\b 扫描碰不到它。
        lits: list[str] = []

        def _stash(m: "re.Match[str]") -> str:
            lits.append(m.group(0)[1:-1])
            return f"⟦{len(lits) - 1}⟧"

        t = re.sub(r"'[^']*'|\"[^\"]*\"", _stash, t)

        types = _registry_feature_types()

        # ② 二值字段的 ==1 / ==0 先转成「已/未」「有/无」，比「= 1」可读得多
        def _binary(m: "re.Match[str]") -> str:
            f, v = m.group(1), m.group(2)
            if types.get(f) != "binary":
                return m.group(0)
            return _binary_phrase(f, v == "1")

        t = re.sub(r"\b([A-Za-z_]\w*)\s*==\s*([01])(?:\.0)?\b", _binary, t)

        # ③ pandas 方法调用 / in 判断
        t = re.sub(r"\b([A-Za-z_]\w*)\.str\.contains\(\s*(⟦\d+⟧)[^)]*\)",
                   r"\1 包含「\2」", t)
        t = re.sub(r"\b([A-Za-z_]\w*)\.notna\(\s*\)", r"\1 不为空", t)
        t = re.sub(r"\b([A-Za-z_]\w*)\.isna\(\s*\)", r"\1 为空", t)
        t = re.sub(r"\b([A-Za-z_]\w*)\.isin\(\s*\[([^\]]*)\]\s*\)", r"\1 属于 [\2]", t)
        # `not in` 必须先于 `in` 处理，否则只翻掉 in、剩个光秃秃的 not，
        # 语义正好反过来（模型规则里 `timediff not in (...)` 是常客）
        t = re.sub(r"\bnot\s+in\s+(?=[(\[])", "不属于 ", t)
        t = re.sub(r"\b([A-Za-z_]\w*)\s*\.isin\(\s*\[([^\]]*)\]\s*\)\s*==\s*False", r"\1 不属于 [\2]", t)
        t = re.sub(r"\s+in\s+(?=[(\[])", " 属于 ", t)

        # ④ 运算符与连接词
        for a, b in _COND_OPS:
            t = t.replace(a, b)
        t = re.sub(r"\s*&\s*", " 且 ", t)
        t = re.sub(r"\s*\|\s*", " 或 ", t)
        t = re.sub(r"\band\b", "且", t)
        t = re.sub(r"\bor\b", "或", t)
        t = re.sub(r"~\s*\(", "非（", t)

        # ⑤ 剩余标识符 → 中文标签（保留字不动；查不到中文的原样留着）
        def _ident(m: "re.Match[str]") -> str:
            w = m.group(0)
            if w in _COND_KEYWORDS:
                return w
            lab = _zh_label(w)
            return lab if lab != w else w

        t = re.sub(r"\b[A-Za-z_]\w*\b", _ident, t)

        # ⑥ 括号中文化 + 收拾空白（全角括号两侧不留空格，读起来更紧凑）
        t = t.replace("(", "（").replace(")", "）")
        t = re.sub(r"\s{2,}", " ", t)
        t = re.sub(r"\s*（\s*", "（", t)
        t = re.sub(r"\s*）\s*", "）", t)
        t = re.sub(r"）(且|或)（", r"）\1（", t)
        t = t.strip()

        # ⑦ 还原字面量
        for i, lit in enumerate(lits):
            t = t.replace(f"⟦{i}⟧", lit)
        return t
    except Exception:                      # noqa: BLE001 —— 展示层永不崩
        return ""


AGENT_DIM_LABELS_ZH = {
    "funnel_diagnosis":       "转化漏斗",
    "marketing_attribution":  "营销渠道",
    "user_segment":           "用户兴趣",
    "price_sensitivity":      "优惠机制",
    "platform_behavior":      "平台与活跃度",
    "path_quality":           "行为路径",
    "model_analysis":         "模型分析",
    "diagnostic_rules":       "规则诊断",
    "adhoc":                  "补充诊断",
}
AGENT_DIM_LABELS_EN = {
    "funnel_diagnosis":       "Conversion Funnel",
    "marketing_attribution":  "Marketing Channels",
    "user_segment":           "User Interest",
    "price_sensitivity":      "Pricing & Coupon",
    "platform_behavior":      "Platform & Activity",
    "path_quality":           "Behavior Path",
    "model_analysis":         "Model Analysis",
    "synthesizer":            "Cross-Dimension",
    "adhoc":                  "Supplemental Diagnosis",
}
# 默认中文；调用方可在调 render_* 前 monkey-patch:
#   from snippets import report_renderer
#   report_renderer.AGENT_DIM_LABELS = report_renderer.AGENT_DIM_LABELS_EN
# 也可传入自定义 dict 覆盖个别 key。后续可拓展为 locale 参数；当前最小钩子。
AGENT_DIM_LABELS = AGENT_DIM_LABELS_ZH
SEV_RANK = {"high": 0, "mid": 1, "low": 2}
# 实现难度排序权重：低→高（快赢优先）。摘要与各章节核心问题/行动均按此排序。
_DIFF_RANK = {"easy": 0, "medium": 1, "hard": 2}


def _ease_to_diff(ease) -> str:
    """规则类目易度 _ease（0.30-0.90，越大越易）映射为 easy/medium/hard。
    阈值与第 I 章卡片 ease badge 保持一致。"""
    if _fin(ease):
        e = float(ease)
        if e >= 0.70:
            return "easy"
        if e >= 0.45:
            return "medium"
        return "hard"
    return "medium"

# 仅在 finding 缺少 signal/detail 时作为最后兜底；正常情况完全使用 finding 真实文本。
_DEFAULT_PROBLEM_TITLES = {
    "funnel_diagnosis": "转化漏斗存在异常流失",
    "marketing_attribution": "营销渠道效率分化",
    "user_segment": "用户兴趣与活动定向错配",
    "price_sensitivity": "优惠机制驱动效果分化",
    "platform_behavior": "平台触达与用户活跃习惯不一致",
    "path_quality": "用户行为路径质量诊断",
    "synthesizer": "跨维度交叉信号",
    "model_analysis": "模型识别的关键信号",
    "adhoc": "补充诊断发现",
}
_DEFAULT_PROBLEM_IMPACTS = {
    "funnel_diagnosis": "前端引流投入未能有效转化为下单行为。",
    "marketing_attribution": "营销资源分配存在结构性失衡。",
    "user_segment": "活动入口曝光给非目标兴趣人群，转化漏斗起点流量薄弱。",
    "price_sensitivity": "优惠投入与转化提升不匹配。",
    "platform_behavior": "触达渠道与用户实际使用习惯不一致。",
    "path_quality": "用户主动转化意愿薄弱，活动可持续性存疑。",
    "model_analysis": "模型识别出的信号未充分应用于圈人与投放决策。",
    "synthesizer": "多维度交叉模式提示存在结构性根因，单维度策略难以解决。",
    "adhoc": "针对特定假设的补充诊断，需在下一周期补充常规化埋点验证。",
}

# CSS 一次性加载
def _e(t) -> str:
    return _html.escape(str(t)) if t is not None else ""


_ALLUSERS_SENTINELS = {
    "全量", "全量用户", "全体", "全体用户", "所有用户", "all", "all users", "全部",
}


def _is_allusers_sentinel(name: str) -> bool:
    """判断 target_audience 名是否是『覆盖全量用户』的哨兵词。"""
    return name.strip().lower() in {s.lower() for s in _ALLUSERS_SENTINELS}


def _problem_rule_label(p: dict, rule_data: dict | None) -> str:
    """问题的简短规则/信号名 —— 中间徽章、封面左列、行动分组标题的统一来源。

    取值优先级：
      1) 42 条规则归属问题：规则展示名（rule_data.display_name；正向信号为中性/正向别名，
         负向/定义性为原中文名，如"跨品类推送错配"）——避免正向信号挂负向规则名
      2) 无规则归属（正向阈值机会 / 模型洞察）：问题自带的 `rule_name`
         （draft_builder 用特征中文名预填，Agent 可润色为更贴切的信号名）
    二者皆无返回空串（调用方再以大类标签兜底）。
    """
    rd = rule_data or {}
    name = rd.get("display_name") or rd.get("name") or (p.get("rule_name") or "")
    name = str(name).strip()
    return "" if ("[待润色]" in name or "待润色" in name) else name


def _refine_no_rule_category(p: dict, category: str) -> str:
    """无规则归属的问题（rule_data 为空）按信号类型细化大类标签，避免退化为 agent 名。

    positive→"转化机会"、leakage→"支付漏损"；其余维持原 category。
    """
    st = p.get("_signal_type")
    if st == "positive":
        return "转化机会"
    if st == "leakage":
        return "支付漏损"
    return category


class ReportRenderer:
    """把 report dict 渲染成 HTML / Markdown。无 LLM 调用。

    输出 HTML 为金融纸样式、完全自包含（字体 base64 内嵌、纯 CSS 图表、零外部 CDN），
    天然适配内网交付 / 离线审阅 / 合规场景，无需额外离线开关。
    """

    def __init__(self, report: dict, output_dir: str | None = None,
                  date: str | None = None):
        self.r = report
        self.output_dir = output_dir or "."
        self._date = date or datetime.now().strftime("%Y年%m月%d日")
        self.render_warnings: list[str] = []

    # ── 公共入口 ─────────────────────────────────────────────────────
    def save_html(self, filename: str = "diagnosis_report.html") -> str:
        os.makedirs(self.output_dir, exist_ok=True)
        path = os.path.join(self.output_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(self._render_html())
        return path

    def save_markdown(self, filename: str = "diagnosis_report.md") -> str:
        os.makedirs(self.output_dir, exist_ok=True)
        path = os.path.join(self.output_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(self._render_markdown())
        return path

    def _render_html(self) -> str:
        return render_fp(self)

    def _extract_headline(self) -> str:
        narratives = self.r.get("narratives", {}) or {}
        if isinstance(narratives, dict) and narratives.get("headline"):
            return narratives["headline"]
        if self.r.get("headline"):
            return self.r["headline"]
        gs = self.r.get("global_summary", "") or ""
        gs = re.sub(r"\*+", "", gs).replace("—", "").strip()
        sents = re.split(r"[。;]", gs)
        for s in sents:
            s = s.strip().lstrip("·•-– \n")
            if any(kw in s for kw in ["作为", "我已", "本次诊断", "Agent", "整合", "我"]):
                continue
            if 15 <= len(s) <= 80:
                return s + "。"
        hi = self.r.get("high_severity_count", 0)
        # 兜底 headline 不得臆断具体维度（"渠道效率/品类匹配/优惠机制"并非每个活动都成立）；
        # 仅给不含数据判断的中性句，真正的结论由 Agent 写入 narratives.headline。
        return f"活动存在 {hi} 项高危问题，详见下文核心问题诊断。" if hi else "详见下文核心问题诊断与行动建议。"

    def _resolve_cvr_for_problem(self, p: dict, rules_by_id: dict) -> dict:
        """从 rule_data（compute-thresholds，权威）提取 CVR 指标；metric_refs 仅补充缺失字段。

        cvr_t/cvr_n 以 rule_data 为准：LLM 写的 metric_refs 常有 cvr_triggered/cvr_not_triggered
        互换问题，而 compute-thresholds 的计算结果总是正确的。
        返回含 cvr_t/cvr_n/cvr_g/tr/n_ev 的 dict，无效值统一为 None。
        """
        rule_id   = p.get("rule_id")
        rule_data = rules_by_id.get(int(rule_id)) if rule_id is not None else None
        metric_refs = p.get("metric_refs") or []

        def _get_m(key):
            for m in metric_refs:
                if isinstance(m, dict) and m.get("name") == key:
                    return m.get("value")
            return None

        rd = rule_data or {}
        raw = {
            # cvr_t / cvr_n：rule_data 优先（避免 LLM 写反）；无 rule_id 时才用 metric_refs
            "cvr_t": rd.get("cvr_triggered")     or _get_m("cvr_triggered"),
            "cvr_n": rd.get("cvr_not_triggered")  or _get_m("cvr_not_triggered"),
            # cvr_gap：metric_refs 优先（LLM 有时会用 finding-level 精确值），fallback rule_data
            "cvr_g": _get_m("cvr_gap")            or rd.get("cvr_gap"),
            "tr":    _get_m("trigger_rate")        or rd.get("trigger_rate"),
            "n_ev":  _get_m("n_event")            or rd.get("trigger_cnt"),
            "rule_data": rule_data,
        }
        # 若主 rule_id 无 CVR，迭代 evidence_finding_ids 中的次级 findings 补充
        has_cvr = any(_fin(raw[k]) for k in ["cvr_t", "cvr_n", "cvr_g"])
        if not has_cvr:
            findings_list = self.r.get("findings") or []
            findings_by_id = {f.get("id"): f for f in findings_list if f.get("id")}
            for fid in (p.get("evidence_finding_ids") or []):
                f = findings_by_id.get(fid)
                if not f:
                    continue
                frid = f.get("rule_id")
                if frid is None:
                    continue
                rdd = rules_by_id.get(int(frid))
                if not rdd:
                    continue
                raw["cvr_t"] = raw["cvr_t"] or rdd.get("cvr_triggered")
                raw["cvr_n"] = raw["cvr_n"] or rdd.get("cvr_not_triggered")
                raw["cvr_g"] = raw["cvr_g"] or rdd.get("cvr_gap")
                raw["tr"]    = raw["tr"]    or rdd.get("trigger_rate")
                raw["n_ev"]  = raw["n_ev"]  or rdd.get("trigger_cnt")
                if not raw["rule_data"]:
                    raw["rule_data"] = rdd
                if any(_fin(raw[k]) for k in ["cvr_t", "cvr_n", "cvr_g"]):
                    break

        # NaN / None 统一归 None
        result = {k: (v if (k == "rule_data" or _fin(v)) else None) for k, v in raw.items()}

        # 口径统一：compute-thresholds 已把规则主口径（cvr_triggered/cvr_not_triggered/cvr_gap）
        # 算成 eval_col（默认成单率 is_paid）。展示基准由 state["_cvr_col"] 决定，卡片标签据此显示
        # 「成单率/创单率」。无需再做 paid_* 覆盖（该列已并入主口径）。
        result["is_paid_basis"] = (self.r.get("_cvr_col", "is_paid") == "is_paid")

        # 符号一致性自检：cvr_gap < 0 说明触发组 CVR < 对照组 CVR；
        # 若 cvr_t > cvr_n 时 gap 却为负，说明两者被互换了，自动纠正。
        cvr_t, cvr_n, cvr_g = result.get("cvr_t"), result.get("cvr_n"), result.get("cvr_g")
        if (_fin(cvr_g) and _fin(cvr_t) and _fin(cvr_n)
                and float(cvr_g) < 0 and float(cvr_t) > float(cvr_n)):
            result["cvr_t"], result["cvr_n"] = result["cvr_n"], result["cvr_t"]

        return result

    def _order_problems_by_difficulty(self, items: list[dict]) -> list[dict]:
        """把核心问题按实现难度（低→高，快赢优先）稳定重排。

        难度来源优先级：
          ① 该问题对应行动的 `execution_difficulty`（业务/Agent 判定，权威）；
             同一问题多条行动取最易者。
          ② 规则类目易度 `_ease` 推断（草稿期行动难度全为 medium 时仍有区分度）。
        同难度内按 `_ease` 降序（更易者更前），再按原业务优先级稳定保持。
        """
        actions = ((self.r.get("action_plan") or {}).get("priority_actions")) or []
        rank_to_diff: dict = {}
        for a in actions:
            pr = a.get("problem_rank")
            if pr is None:
                continue
            d = a.get("execution_difficulty", "medium")
            cur = rank_to_diff.get(pr)
            if cur is None or _DIFF_RANK.get(d, 1) < _DIFF_RANK.get(cur, 1):
                rank_to_diff[pr] = d

        def _key(t):
            idx, it = t
            exec_d = rank_to_diff.get(it.get("problem_rank")) or _ease_to_diff(it.get("_ease"))
            ease_v = float(it.get("_ease")) if _fin(it.get("_ease")) else 0.5
            return (_DIFF_RANK.get(exec_d, 1), -ease_v, idx)

        return [it for _, it in sorted(enumerate(items), key=_key)]

    def _extract_top_problems(self) -> list[dict]:
        """根据 narratives.problems / findings 真实内容生成问题列表。

        - 第一来源：state['narratives']['problems'] 中所有 problem 都进入，按 agent 优先级排序
        - 第二来源（兜底）：从 findings 中按 severity + agent 优先级挑选 high/mid 各 1 条
        - 不再用硬编码模板覆盖 title/impact，title 直接取 LLM 写的
        """
        ov = self.r.get("data_overview", {}) or {}
        narratives = self.r.get("narratives", {}) or {}
        nar_problems = narratives if isinstance(narratives, list) else narratives.get("problems", []) or []

        # 读取 model_auc_quality，决定模型 findings 的权重
        auc_quality = self.r.get("model_auc_quality", "invalid")
        model_elevated = (auc_quality == "elevated")   # AUC ≥ 0.65
        model_usable   = (auc_quality != "invalid")    # AUC ≥ 0.50

        findings_list = self.r.get("findings") or []
        findings_by_id: dict = {f["id"]: f for f in findings_list if f.get("id")}
        rules_by_id: dict = {
            int(r["rule_id"]): r
            for r in ((self.r.get("data_overview") or {}).get("diagnostic_rules_summary") or [])
            if r.get("rule_id") is not None
        }

        if nar_problems:
            # ── agent 优先级：AUC elevated 时，model_analysis 提升至前排 ──
            if model_elevated:
                agent_priority = ["model_analysis", "diagnostic_rules",
                                  "marketing_attribution", "user_segment", "funnel_diagnosis",
                                  "price_sensitivity", "path_quality", "platform_behavior",
                                  "synthesizer", "adhoc"]
            else:
                agent_priority = ["marketing_attribution", "user_segment", "funnel_diagnosis",
                                  "price_sensitivity", "path_quality", "platform_behavior",
                                  "synthesizer", "model_analysis", "adhoc", "diagnostic_rules"]
            order_idx = {a: i for i, a in enumerate(agent_priority)}

            def _problem_sort_key(p):
                agent_score = order_idx.get(p.get("agent", ""), 999)
                # AUC elevated 时 model findings 按 severity 再排
                if model_elevated and p.get("agent") == "model_analysis":
                    fnd_ids = p.get("evidence_finding_ids") or []
                    lf = next((findings_by_id[fid] for fid in fnd_ids if fid in findings_by_id), None)
                    sev_score = SEV_RANK.get((lf or {}).get("severity", "low"), 9)
                    return (0, sev_score)  # 强制最前
                return (agent_score, 0)

            sorted_problems = sorted(nar_problems, key=_problem_sort_key)
            ordered = []
            for p in sorted_problems:
                title     = (p.get("title") or "").strip()
                narrative = (p.get("narrative") or p.get("detail") or "").strip()
                if not (title or narrative):
                    continue
                fnd_ids = p.get("evidence_finding_ids") or []
                linked_finding = next(
                    (findings_by_id[fid] for fid in fnd_ids if fid in findings_by_id), None
                )
                _lf_rid = (linked_finding or {}).get("rule_id")
                # None-guard：rules_by_id 可能为空（compute-thresholds 跳过/被裁剪）或不含该 rule_id，
                # 此时 .get() 返回 None，直接 .get("_signal_type") 会 AttributeError 导致整页 render 失败
                _rule_row = rules_by_id.get(int(_lf_rid)) if _lf_rid is not None else None
                _sigtype = (
                    (linked_finding or {}).get("_signal_type")
                    or (_rule_row or {}).get("_signal_type")
                    or p.get("_signal_type")
                )
                ordered.append({
                    "title":                title or _DEFAULT_PROBLEM_TITLES.get(p.get("agent", ""), "诊断发现"),
                    "narrative":            narrative,
                    "impact":               p.get("impact", ""),
                    "severity":             (linked_finding or {}).get("severity", "mid"),
                    "rule_id":              _lf_rid,
                    "metric_refs":          (linked_finding or {}).get("metric_refs") or [],
                    "agent":                p.get("agent", ""),
                    "_signal_type":         _sigtype,
                    "evidence_finding_ids": fnd_ids,
                    "rule_name":            p.get("rule_name", ""),
                    "typical_case":         p.get("typical_case"),
                    "problem_rank":         p.get("problem_rank"),
                    "_ease":                (_rule_row or {}).get("_ease"),
                })
            # 先取业务优先级 Top5，再按实现难度（低→高）重排，摘要/各章节顺序一致
            return self._order_problems_by_difficulty(ordered[:5])

        # ── 兜底：从 findings 列表直接构造（model findings 按 AUC 质量排序）──
        by_agent: dict = {}
        for f in findings_list:
            by_agent.setdefault(f.get("agent", ""), []).append(f)

        # AUC elevated：model_analysis findings 提到最前，其余按常规顺序
        if model_elevated:
            base_priority = ["model_analysis", "diagnostic_rules",
                             "marketing_attribution", "user_segment", "funnel_diagnosis",
                             "price_sensitivity", "path_quality", "platform_behavior",
                             "synthesizer", "adhoc"]
        else:
            base_priority = ["diagnostic_rules", "marketing_attribution", "user_segment",
                             "funnel_diagnosis", "price_sensitivity", "path_quality",
                             "platform_behavior", "synthesizer",
                             *(["model_analysis"] if model_usable else []), "adhoc"]

        problems = []
        for agent in base_priority:
            items = by_agent.get(agent, [])
            if not items:
                continue
            items.sort(key=lambda x: SEV_RANK.get(x.get("severity", "low"), 9))
            if items[0].get("severity") not in ("high", "mid"):
                continue
            p = self._build_problem(agent, items[0], ov)
            p["agent"] = agent
            p["rule_id"] = items[0].get("rule_id")
            p["metric_refs"] = items[0].get("metric_refs") or []
            p["severity"] = items[0].get("severity", "mid")
            problems.append(p)
            if len(problems) >= 5:
                break
        return problems[:5]

    def _build_problem(self, agent: str, finding: dict, ov: dict) -> dict:
        """优先使用 finding 自身文本；模板仅作 fallback。"""
        signal = (finding.get("signal") or "").strip()
        detail = (finding.get("detail") or "").strip()
        detail = re.sub(r"^由于代码执行错误[^,，]*[,，]\s*", "", detail)

        # 标题：优先 signal（finding 真实写法），其次模板，再次兜底
        title = signal[:60] if signal else _DEFAULT_PROBLEM_TITLES.get(
            agent, AGENT_DIM_LABELS.get(agent, agent or "诊断发现")
        )
        # 叙述：detail 优先，缺则用 signal；都没有 → 标记缺数据
        narrative = (detail or signal or "（finding 缺少 detail/signal 文本）")[:300]
        # 业务影响：优先 finding.impact 字段（若 LLM 写了），其次兜底模板
        impact = (finding.get("impact") or _DEFAULT_PROBLEM_IMPACTS.get(agent, "")).strip()
        return {
            "title": title,
            "narrative": narrative,
            "impact": impact,
        }

    @staticmethod
    def _humanize_feature(name: str) -> str:
        mapping = {
            "pre_mkt_touch_cnt": "近1天营销触达次数", "pre_mainflow_event_cnt": "主流程行为次数",
            "pre_total_event_cnt": "总行为次数", "pre_active_span_min": "活跃时长（分钟）",
            "pre_events_per_hour": "行为密度", "activity_touch_cnt": "当日触达次数",
            "pre_coupon_collect_cnt": "领券数量", "pre_homepage_event_cnt": "首页行为次数",
            "pre_product_category_cnt": "浏览品类数", "pre_max_funnel_depth": "近1天最深漏斗深度",
            "pre_first_active_hour": "首次活跃小时", "pre_is_marketing_first": "营销作为首触点",
            "pre_is_marketing_last": "营销作为末触点", "pre_skip_detail_flag": "跳过详情页",
            "pre_popup_touch_cnt": "近1天弹屏触达次数", "pre_push_touch_cnt": "近1天Push触达次数",
            "pre_create_not_complete": "遗单用户", "pre_has_complete_order": "有历史成单",
            # 典型案例常用指标的简洁中文名（避免裸露英文字段名）
            "pre_funnel_pages_cnt": "主流程页面数", "pre_reached_payment": "到达支付页",
            "pre_create_order_cnt": "近1天创单次数", "pre_complete_order_cnt": "近1天成单次数",
            "pre_target_product_depth": "目标品类漏斗深度", "pre_target_product_funnel_depth": "目标品类漏斗深度",
            "pre_target_product_visit_cnt": "目标品类主流程浏览次数", "pre_product_category_cnt": "浏览品类数",
            "pre_mkt_direct_exit_cnt": "营销后直接退出次数", "pre_mkt_fatigue_cnt": "营销疲劳离开次数",
            "pre_popup_reject_cnt": "弹屏强拒绝次数", "pre_back_to_booking_cnt": "预订页回退次数",
            "pre_back_to_list_cnt": "详情返列表次数", "pre_over_mkt_flag": "近1天过度触达",
            "pre_funnel_regression_after_mkt": "营销后漏斗倒退次数",
            "pre_top_interest_product": "最深兴趣品类", "pre_mkt_product_browse_match": "活动品类匹配兴趣",
            "pre_browse_flight": "浏览过机票", "pre_browse_hotel": "浏览过酒店",
            "pre_browse_train": "浏览过火车票", "pre_browse_scenic": "浏览过景区",
            "pre_flight_visit_cnt": "机票主流程浏览次数", "pre_hotel_visit_cnt": "酒店主流程浏览次数",
            "pre_train_visit_cnt": "火车票主流程浏览次数",
            "pre_flight_depth": "机票漏斗深度", "pre_train_depth": "火车票漏斗深度",
            "pre_is_cross_category": "跨品类浏览", "pre_product_category_cnt": "浏览品类数",
            "pre_last_coupon_product": "最近领券品类", "pre_rp_target_product": "领过目标品类券",
            "pre_has_blackwhale": "领过黑鲸优惠",
            "activity_click_cnt": "当日点击次数", "is_converted": "是否转化", "is_paid": "是否成单",
            "ads_product_name": "站外广告品类", "first_insite_product_name": "站内承接品类",
            "ads_insite_match_flag": "站外站内品类一致", "has_ads_touch": "有站外广告触达",
            "has_insite_touch": "有站内承接",
            # 用户画像（V2.1）
            "age": "年龄", "gender": "性别", "member_level": "会员等级",
            "resident_city_level": "常住城市等级", "is_blackwhale_user": "黑鲸会员",
            "is_private_domain": "私域用户", "type_mem": "集团新老客", "type": "主题人群",
            "risk_type": "风险类型", "visit_days": "近90天访问天数", "timediff": "当天停留时长(秒)",
            "gmv": "近1年客单价(元)", "finance_revenue_after": "近1年消费营收(元)",
            "order_pc": "近1年消费频次", "360d_create_order_count": "近1年订单数",
            "order_cross": "跨品类交叉消费", "serialid_bonus": "促销订单占比",
            "last_create_order_time": "最近消费时间", "label001": "注册时间",
            # 先知场景（V2.1）
            "sceneid": "先知人群包编号", "scene_name": "先知节点名称",
            "is_today": "实时场景", "scene_has_offline_node": "含离线节点",
        }
        if name in mapping:
            return mapping[name]
        # 回退到特征注册表的中文描述（避免裸露英文字段名），去掉末尾 (0/1)/(1-5) 等说明
        zh = _registry_feature_zh().get(name)
        if zh:
            # 先剥闭合的尾括号说明；再兜一层"左括号后没有右括号"的残缺情形
            # （registry 里曾出现 YAML 把 " #12）" 当行注释吃掉、只剩半个括号的描述）
            zh2 = re.sub(r"[（(][^（()）]*[)）]\s*$", "", zh).strip()
            zh2 = re.sub(r"[（(][^（()）]*$", "", zh2).strip()
            # fix29：再切掉逗号后的解释性从句。registry 里不少描述是「口径，作用说明」
            # 两段式（"…到最后触达时刻的时间差（分钟），反映用户活跃时长"），整句当标签
            # 塞进条件句会变成一长串读不断的话 —— 而 fix29 之后这个标签还会随
            # crowd_rules 的 filter_zh 进 API 出参，不能是个从句。只切逗号后，
            # 逗号前的口径一个字不动（宁可长，不猜）。
            zh2 = re.split(r"[，,]", zh2, 1)[0].strip() or zh2
            return zh2 or zh
        return name

    @staticmethod
    def _bold_numbers_md(text: str) -> str:
        """Markdown 版关键数字加粗：百分比/倍数/人数。"""
        if not text:
            return ""
        text = re.sub(r"(-?\d+(?:\.\d+)?%)", r"**\1**", text)
        text = re.sub(r"(\d+(?:\.\d+)?\s*倍)", r"**\1**", text)
        text = re.sub(r"(\d{1,3}(?:,\d{3})+\s*(?:人|用户|单|订单)?)", r"**\1**", text)
        # 无千分位但带单位的数字。负向后顾排除前缀为数字/逗号/星号，避免重复命中
        # 已被上一条加粗的千分位数尾段（如 2,403用户 → **2,**403用户****）。
        text = re.sub(r"((?<![\d,*])\d+(?:\s*(?:人|用户|单|订单)))", r"**\1**", text)
        return text

    _FIELD_ZH: dict = {
        "pre_mkt_touch_cnt": "历史营销触达次数", "pre_mainflow_event_cnt": "主流程行为次数",
        "pre_total_event_cnt": "总行为次数", "pre_active_span_min": "活跃时长(分钟)",
        "pre_events_per_hour": "行为密度(次/小时)", "activity_touch_cnt": "当日触达次数",
        "pre_coupon_collect_cnt": "领券数量", "pre_homepage_event_cnt": "首页行为次数",
        "pre_product_category_cnt": "浏览品类数", "pre_max_funnel_depth": "历史漏斗深度",
        "pre_first_active_hour": "首次活跃小时", "pre_is_marketing_first": "营销作为首触点",
        "pre_is_marketing_last": "营销作为末触点", "pre_skip_detail_flag": "跳过详情页",
        "pre_has_mkt_click": "历史有营销点击", "pre_browse_hotel": "浏览酒店",
        "pre_browse_flight": "浏览机票", "pre_browse_train": "浏览火车票",
        "pre_browse_scenic": "浏览景区", "pre_is_cross_platform": "跨平台",
        "pre_is_cross_category": "跨品类浏览", "pre_create_not_complete": "遗单用户",
        "pre_popup_touch_cnt": "历史弹屏触达次数", "pre_reached_detail": "到达详情页",
        "pre_reached_booking": "到达填写页", "pre_back_to_list_cnt": "详情→列表回退次数",
        "pre_rp_target_product": "目标品类红包", "pre_mkt_trigger_mainflow_cnt": "主流程触发次数",
        "pre_first_expose_to_touch_min": "首曝到触达间隔(分钟)",
        "pre_last_order_to_touch_min": "上次成单到触达间隔(分钟)",
        "pre_flight_depth": "机票漏斗深度", "pre_flight_visit_cnt": "机票访问次数",
        "pre_hotel_visit_cnt": "酒店访问次数", "pre_search_cnt": "搜索次数",
        "pre_push_touch_cnt": "历史Push触达次数", "pre_popup_reject_cnt": "历史弹屏拒绝次数",
        "insite_channel_cnt": "站内渠道数", "is_converted": "是否成单",
        "pre_has_complete_order": "有历史完单", "pre_has_create_order": "有历史创单",
        "pre_mkt_fatigue_cnt": "营销疲劳次数", "pre_mkt_direct_exit_cnt": "营销直接退出次数",
        # 用户画像价值字段（V2.1，配 percentile 阈值）
        "age": "年龄", "member_level": "会员等级", "resident_city_level": "常住城市等级",
        "gmv": "近1年客单价", "finance_revenue_after": "近1年消费营收", "order_pc": "近1年消费频次",
        "360d_create_order_count": "近1年订单数", "visit_days": "近90天访问天数",
        "timediff": "当天停留时长", "serialid_bonus": "促销订单占比",
    }

    def _build_rule_label_map(self) -> dict:
        """从 state 构建 rule_id → {name, category, threshold_hint, stats_hint} 映射。"""
        label_map: dict = {}
        ov = self.r.get("data_overview") or {}
        rules = ov.get("diagnostic_rules_summary") or []
        thresholds = self.r.get("adaptive_thresholds") or {}

        for r in rules:
            rid = r.get("rule_id")
            if rid is None:
                continue
            rid = int(rid)
            name = r.get("name", "")
            tr = r.get("trigger_rate")
            cvr_t = r.get("cvr_triggered")
            cvr_n = r.get("cvr_not_triggered")
            cvr_g = r.get("cvr_gap")

            # 统计摘要（触发率 + CVR 差值）
            stats_parts = []
            if _fin(tr):
                stats_parts.append(f"触发率{float(tr)*100:.1f}%")
            if _fin(cvr_t):
                stats_parts.append(f"触发CVR {float(cvr_t)*100:.1f}%")
            if _fin(cvr_n):
                stats_parts.append(f"对照CVR {float(cvr_n)*100:.1f}%")
            if _fin(cvr_g):
                gap_str = f"{float(cvr_g)*100:+.1f}pp"
                stats_parts.append(f"差值{gap_str}")
            stats_hint = "，".join(stats_parts)

            # 阈值提示：从 adaptive_thresholds 提取该规则相关字段的最优阈值
            thresh_parts = []
            # 尝试从规则名/常见字段猜测主要阈值字段
            RULE_THRESH_FIELDS = {
                1:  "pre_mainflow_event_cnt", 2:  "activity_touch_cnt",
                5:  "pre_total_event_cnt",    7:  "pre_last_order_to_touch_min",
                8:  "pre_last_order_to_touch_min", 15: "pre_last_mainflow_to_touch_min",
                22: "pre_mkt_fatigue_cnt",    23: "pre_product_category_cnt",
                24: "pre_back_to_list_cnt",   25: "pre_create_order_cnt",
                28: "pre_min_mkt_response_sec", 30: "pre_first_expose_to_touch_min",
                32: "pre_mkt_trigger_mainflow_cnt", 35: "pre_popup_touch_cnt",
            }
            thresh_field = RULE_THRESH_FIELDS.get(rid)
            if thresh_field and thresh_field in thresholds:
                tv = thresholds[thresh_field].get("optimal")
                if _fin(tv):
                    fz = self._FIELD_ZH.get(thresh_field, thresh_field)
                    thresh_parts.append(f"阈值:{fz}={float(tv):.4g}")
            thresh_hint = "，".join(thresh_parts)

            label_map[rid] = {
                "name": name,
                "category": r.get("category", ""),
                "stats_hint": stats_hint,
                "thresh_hint": thresh_hint,
            }
        return label_map

    def _expand_rule_refs(self, text: str, label_map: dict | None = None) -> str:
        """将文本中的 rule#N / Rule N / 规则N 替换为中文名称 + 阈值提示。

        例：rule#32触发率... → 「营销未触发主流程」(阈值:主流程触发次数=1)触发率...
        例：Rule 32 → 「营销未触发主流程」
        """
        _pat = r'(?:rule|规则)[#\s]\s*(\d+)'
        if not text or not re.search(_pat, text, re.IGNORECASE):
            return text
        if label_map is None:
            label_map = self._build_rule_label_map()

        def _replace(m: re.Match) -> str:
            num_str = re.search(r'\d+', m.group(0))
            if not num_str:
                return m.group(0)
            rid = int(num_str.group(0))
            info = label_map.get(rid)
            if not info:
                return m.group(0)
            name = info["name"]
            thresh = info.get("thresh_hint", "")
            suffix = f"（{thresh}）" if thresh else ""
            return f"「{name}」{suffix}"

        return re.sub(_pat, _replace, text, flags=re.IGNORECASE)

    @staticmethod
    def _segment_anchor_id(name: str) -> str:
        cleaned = re.sub(r"[^\w一-龥]+", "-", name).strip("-").lower()
        return f"segment-{cleaned}" if cleaned else "segment-unknown"

    # ── 附录 ─────────────────────────────────────────────────────────
    def _render_markdown(self) -> str:
        r = self.r
        profile = r.get("campaign_profile") or {}
        _cm = r.get("campaign_meta") or {}
        title = (profile.get("name")
                 or _cm.get("campaign_name")
                 or r.get("campaign_id", ""))
        ov = r.get("data_overview", {}) or {}
        cs = ov.get("conversion_summary", {}) or {}
        plan = r.get("action_plan") or {}

        # 管理层一页摘要（与 HTML 的 _exec_summary 对应）
        findings = r.get("findings") or []
        high_cnt = sum(1 for f in findings if f.get("severity") == "high")
        mid_cnt = sum(1 for f in findings if f.get("severity") == "mid")
        low_cnt = sum(1 for f in findings if f.get("severity") == "low")
        segments = r.get("audience_segments") or []
        inc_orders = _aggregate_incremental_orders(segments)
        n_actions = len(plan.get("priority_actions") or [])

        # A0：最终转化口径用 is_paid（支付成单率），创单率（is_converted）作过程指标并列
        paid_rate, create_rate = cs.get("paid_rate"), cs.get("overall_cvr")
        paid_s = f"{paid_rate:.2%}" if _fin(paid_rate) else "—"
        create_s = f"{create_rate:.2%}" if _fin(create_rate) else "—"

        lines = [
            f"# {title}",
            "",
            f"营销活动诊断报告 · {self._date}",
            "",
            "---",
            "",
            f"**核心结论：** {self._extract_headline()}",
            "",
            "## 管理层一页摘要",
            "",
            "| 维度 | 关键指标 |",
            "|---|---|",
            f"| 覆盖用户 | **{cs.get('total_users',0):,}** |",
            f"| 支付成单率（最终） | **{paid_s}** |",
            f"| 创单率（过程） | **{create_s}** |",
            f"| 问题严重度 | 🔴 高危 **{high_cnt}** · 🟡 中危 **{mid_cnt}** · ⚪ 低危 **{low_cnt}** |",
            (f"| 行动方案 | **{n_actions}** 项优先动作 · **{len(segments)}** 个人群包"
             + (f" · 预期增量支付订单 **{inc_orders:,}**" if inc_orders else "") + " |"),
            "",
        ]

        problems = self._extract_top_problems()
        if problems:
            lines += ["## 第一章 · 核心问题诊断", ""]
            nums = ["一", "二", "三", "四", "五"]
            # MD 无颜色，正向机会需显式标记，否则与"问题"混排无法区分（HTML 用绿色区分）
            _fst = {f.get("id"): f.get("_signal_type") for f in findings}
            for i, p in enumerate(problems):
                _eids = p.get("evidence_finding_ids") or []
                _is_pos = (p.get("_signal_type") == "positive") or any(
                    _fst.get(e) == "positive" for e in _eids)
                _tag = "【正向机会】" if _is_pos else ""
                lines += [
                    f"### {nums[i] if i < len(nums) else str(i+1)}、{_tag}{p['title']}",
                    "",
                    p["narrative"],
                    "",
                ]
                if p.get("impact"):
                    lines += [f"> **业务影响：** {p['impact']}", ""]

        # 模型摘要（精简版）——预测准确率不足时不展示特征/建议，仅一行说明
        ma = r.get("model_analysis")
        auc_quality = r.get("model_auc_quality", "")
        if ma and auc_quality == "invalid":
            lines += ["## 模型辅助分析摘要", "",
                      "- 转化预测模型可信度不足，模型洞察结论已略过，"
                      "本报告仅基于统计规则诊断。详见附录「数据局限性」。", ""]
        elif ma and ma.get("top_features"):
            n_smp = (ma.get('n_samples') or 0)
            # 低基数活动（如成单率 0.04%）下 .1f 会塌成 "0.0%"，按量级自适应保留有效位
            _oc = float(ma.get('overall_cvr') or 0) * 100
            cvr_pct = f"{_oc:.2f}%" if _oc < 1 else f"{_oc:.1f}%"
            # 模型目标为成单率（is_paid）；overall_cvr 即建模目标的整体比例
            _mt = "成单率" if r.get("_cvr_col", "is_paid") == "is_paid" else "创单率"
            lines += ["## 模型辅助分析摘要", "",
                      f"- 建模样本 {n_smp:,} 人，整体{_mt} {cvr_pct}", ""]
            lines += ["**转化驱动因素 Top 5**（↑正向 / ↓负向 / ≈混合）", ""]
            _dir_arrow = {"positive": "↑", "negative": "↓", "mixed": "≈", "": ""}
            for f in ma["top_features"][:5]:
                arrow = _dir_arrow.get(f.get("direction", ""), "")
                feat_zh = f.get("description") or self._humanize_feature(f.get("feature", ""))
                lines.append(f"- #{f['rank']} {feat_zh} {arrow}")
            lines.append("")
            lsc = ma.get("low_score_converted") or {}
            if lsc.get("n"):
                _evt = "成单" if r.get("_cvr_col", "is_paid") == "is_paid" else "转化"
                lines.append(
                    f"> **模型漏判提示**：{lsc['n']} 名实际{_evt}用户预测分低于 p20"
                    f"（占全部{_evt} {lsc.get('share_of_converted_pct',0)}%），建议优化相关特征。"
                )
                lines.append("")

        actions = plan.get("priority_actions", []) or []
        if actions:
            lines += ["## 第二章 · 行动建议", ""]
            for a in actions:
                lines.append(f"**#{a.get('rank','')} {a.get('title','')}**")
                lines.append(f"  {a.get('description','')}")
                lines.append(f"  预期：{a.get('expected_impact','—')}")
                lines.append("")

        # 附录
        lines += ["", "## 附录", ""]
        findings = r.get("findings", []) or []
        if findings:
            lines += [f"### 全部发现（{len(findings)} 条）", "", "| 级别 | 维度 | 问题 |", "|---|---|---|"]
            sev_icon = {"high": "🔴 高", "mid": "🟡 中", "low": "⚪ 低"}
            for f in findings:
                agent = AGENT_DIM_LABELS.get(f.get("agent", ""), f.get("agent", ""))
                sig = self._bold_numbers_md(f.get("signal", ""))
                lines.append(
                    f"| {sev_icon.get(f.get('severity','low'), '⚪ 低')} | {agent} | {sig} |"
                )
            lines.append("")

        return "\n".join(lines)


# ══════════════════════════════════════════════════════════════════════════
# 金融纸（Financial Paper）渲染层 —— render_html() 委托至此
# ══════════════════════════════════════════════════════════════════════════

_FONTS_CSS_PATH = Path(__file__).resolve().parent.parent / "assets" / "fonts" / "fonts.css"
try:
    _FONTS_CSS = _FONTS_CSS_PATH.read_text(encoding="utf-8")
except Exception:
    _FONTS_CSS = ""

# 颜色变量在 :root 定义，内联样式用 var(--x) 引用，保持标记简洁
_ROOT = (
    ":root{"
    "--serif:'Lora','Source Serif 4','Songti SC','PingFang SC',Georgia,serif;"
    "--sans:-apple-system,'PingFang SC','Microsoft YaHei','Inter',sans-serif;"
    "--mono:'Spline Sans Mono','SF Mono',Consolas,monospace;"
    # 奶白底 + 纯黑字 + S3「鲜明高对比」配色（定稿）
    "--bg:#faf9f5;--paper:#fff;--panel:#faf9f5;--ink:#000000;--ink2:#444444;"
    "--mut:#3f3d39;--faint:#4f4c46;--lab:#bb3b27;--line:#d4d4d2;--line2:#ebe9e3;"
    "--red:#e23b3b;--grn:#1f9e78;--amb:#b45309;--bar:#ebe9e3;--barn:#c5d0d1;"
    "--chipbg:#f3f1ea;--chipbd:#d4d4d2;--chiptx:#bb3b27;"
    # 老核心问题卡(diag-card)所需别名变量
    "--soft:#faf9f5;--soft-2:#f3f1ea;--accent:#bb3b27;--ink-2:#444444;--ink-3:#6b6b6b;"
    "--line-soft:#ebe9e3;--green:#1f9e78;--amber:#b45309;--line-strong:#1a1a1a}"
)

_BASE_CSS = (
    "*{box-sizing:border-box}html,body{margin:0;padding:0}"
    "body{background:var(--bg);color:var(--ink);font-family:var(--serif);"
    "-webkit-font-smoothing:antialiased}"
    "details>summary{list-style:none;cursor:pointer}"
    "details>summary::-webkit-details-marker{display:none}"
    "a{color:inherit}"
    ".fp-toc-link:hover{color:#000000 !important}"
    "#ddtable{font-size:10px}"
    "#ddtable th,#ddtable td{padding-left:4px;padding-right:4px}"
    "@media (max-width:1320px){.fp-toc{display:none}}"
    "@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact;background:#fff}"
    ".fp-sheet{box-shadow:none;border:none}.fp-toc{display:none}"
    # 折叠的原条件默认不进 PDF；这里连同 beforeprint 钩子一起兜底展开
    "details.fp-raw>summary{display:none}details.fp-raw::details-content{content-visibility:visible}}"
)

# 核心问题诊断卡（老版 diag-card：chip 头部 + 坐标轴条形图 + 右侧 KPI），
# 作用域 .fp-oldcards，配色为定稿 S3「鲜明高对比」（已直接固化，无后处理）。
_CARDS_CSS = (
    ".fp-oldcards{"
    "--ink:#000000;--ink-2:#444444;--ink-3:#6b6b6b;--ink-4:#9a9a9a;"
    "--line:#d4d4d2;--line-soft:#ebe9e3;--line-strong:#1a1a1a;--paper:#fff;--soft:#faf9f5;--soft-2:#f3f1ea;"
    "--accent:#bb3b27;--red:#e23b3b;--green:#1f9e78;--green-soft:#f0fdf4;--amber:#b45309;--blue:#1e6fb0;"
    "--serif:'Lora','Source Serif 4','Songti SC',Georgia,serif;"
    "--sans:-apple-system,'PingFang SC','Microsoft YaHei','Inter',sans-serif;"
    "--mono:'Spline Sans Mono','SF Mono',Consolas,monospace;font-family:var(--sans)}"
    ".fp-oldcards .diag-card{border:1px solid var(--line);border-radius:8px;margin-bottom:20px;overflow:hidden;background:var(--paper);box-shadow:0 1px 3px rgba(0,0,0,.06)}"
    ".fp-oldcards .diag-card-header{display:flex;align-items:center;gap:10px;padding:14px 20px;background:var(--soft);border-bottom:1px solid var(--line);flex-wrap:wrap}"
    ".fp-oldcards .diag-rank{font-family:var(--sans);font-size:15px;font-weight:700;color:var(--ink-3);min-width:auto;letter-spacing:.04em}"
    ".fp-oldcards .diag-name{flex:1;font-family:var(--serif);font-size:15px;font-weight:600;color:var(--ink)}"
    ".fp-oldcards .diag-category{font-family:var(--sans);background:#f1ede7;color:#6f6256;border:1px solid #e6dfd4;border-radius:999px;padding:2px 11px;font-size:12px;font-weight:600;letter-spacing:.02em;white-space:nowrap}"
    ".fp-oldcards .diag-rule-name{font-family:var(--sans);background:#faf9f6;color:#8c8579;border:1px solid #ece8e1;border-radius:999px;padding:2px 11px;font-size:12px;font-weight:500;white-space:nowrap}"
    ".fp-oldcards .diag-ease-badge{font-family:var(--sans);border:none;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600;opacity:.9;white-space:nowrap}"
    ".fp-oldcards .diag-sev-badge{font-family:var(--sans);border:none;background:transparent;padding:0 2px;font-size:11.5px;font-weight:700;white-space:nowrap}"
    ".fp-oldcards .diag-sig-badge{font-family:var(--mono);font-size:10px;font-weight:600;color:#b45309;white-space:nowrap;margin-left:2px}"
    ".fp-oldcards .diag-card-body{display:grid;grid-template-columns:1fr auto;gap:0}"
    ".fp-oldcards .diag-chart-wrap{padding:16px 20px;border-right:1px solid var(--line)}"
    ".fp-oldcards .diag-chart-title{font-family:var(--sans);font-size:11px;font-weight:500;color:var(--ink-3);margin-bottom:8px;text-transform:uppercase;letter-spacing:.03em}"
    ".fp-oldcards .diag-cvr-labels{font-family:var(--sans);display:flex;gap:16px;margin-top:10px;font-size:12px;flex-wrap:wrap}"
    ".fp-oldcards .diag-cvr-bad{color:#ee4a4a}.fp-oldcards .diag-cvr-good{color:#27ad87}.fp-oldcards .diag-cvr-gap{color:var(--ink-2)}"
    ".fp-oldcards .diag-cvr-labels strong{font-family:var(--mono)}"
    ".fp-oldcards .bad-val{color:#ee4a4a}.fp-oldcards .good-val{color:#27ad87}"
    ".fp-oldcards .diag-metrics{display:flex;flex-direction:column;justify-content:center;padding:16px 20px;gap:12px;min-width:190px}"
    ".fp-oldcards .diag-metric-item{text-align:center}"
    ".fp-oldcards .diag-metric-val{font-family:var(--mono);font-size:24px;font-weight:700;color:var(--ink)}"
    ".fp-oldcards .diag-metric-val-sm{font-family:var(--serif);font-size:12px;color:var(--ink-2);line-height:1.5}"
    ".fp-oldcards .diag-metric-lbl{font-family:var(--sans);font-size:11px;color:var(--ink-3);margin-top:2px}"
    ".fp-oldcards .diag-metric-lift{border-top:1px dashed var(--line);padding-top:10px}"
    ".fp-oldcards .diag-narrative-block{padding:14px 20px 16px;border-top:1px solid var(--line)}"
    ".fp-oldcards .diag-narrative-text{font-family:var(--serif);font-size:13px;line-height:1.75;color:var(--ink-2);margin:0 0 10px}"
    ".fp-oldcards .diag-impact-row{font-family:var(--serif);display:flex;gap:10px;padding:8px 14px;background:var(--soft);border-left:2px solid var(--accent);font-size:12px;color:var(--ink);align-items:baseline;margin:0}"
    ".fp-oldcards .impact-label{font-family:var(--sans);font-size:10px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);white-space:nowrap}"
    # impact-text:业务影响正文必须整体包成一个 flex 子项。父容器是 display:flex,
    # 正文里 _emph() 会把数字包成 <b>,裸文本混在元素之间会被切成一个个匿名 flex 子项,
    # 整句话碎成一列列(2026-07-30 线上 356352 报告实证)。包一层 span 恢复正常行内排版。
    ".fp-oldcards .impact-text{flex:1 1 auto;min-width:0}"
    ".fp-oldcards .diag-case-block{margin:14px 20px 20px;border-top:1px dashed var(--line);padding-top:14px}"
    ".fp-oldcards .diag-case-title{font-family:var(--sans);cursor:pointer;list-style:none;user-select:none;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);display:flex;align-items:center;gap:8px}"
    ".fp-oldcards .diag-case-tag{font-weight:600;font-size:12px;letter-spacing:normal;text-transform:none;color:var(--accent)}"
    ".fp-oldcards .diag-case-hint{font-weight:400;font-size:11px;letter-spacing:normal;text-transform:none;color:var(--ink-3)}"
    ".fp-oldcards .diag-case-card{margin-top:10px;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--soft)}"
    ".fp-oldcards .diag-case-header{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--soft-2);border-bottom:1px solid var(--line);font-family:var(--sans)}"
    ".fp-oldcards .diag-case-userid{font-family:var(--mono);font-size:12px;color:var(--ink-2)}"
    ".fp-oldcards .diag-case-badge{font-family:var(--sans);font-size:11px;font-weight:600;padding:2px 11px;border-radius:999px}"
    ".fp-oldcards .diag-case-badge.unmatched{background:#fef2f2;color:#991b1b;border:1px solid #fca5a5}"
    ".fp-oldcards .diag-case-badge.matched{background:#dcfce7;color:#166534;border:1px solid #86efac}"
    ".fp-oldcards .diag-case-badge.pending{background:#fef3c7;color:#92400e;border:1px solid #fcd34d}"
    ".fp-oldcards .diag-case-badge.immune{background:#f3f4f6;color:#4b5563;border:1px solid #d1d5db}"
    ".fp-oldcards .diag-case-badge.converted{background:#dbeafe;color:#1e40af;border:1px solid #93c5fd}"
    ".fp-oldcards .diag-case-body{padding:12px 16px;display:flex;flex-direction:column;gap:10px}"
    ".fp-oldcards .diag-case-section{margin-bottom:4px}"
    ".fp-oldcards .diag-case-label{font-family:var(--sans);font-size:10.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-3);margin-bottom:6px}"
    ".fp-oldcards .diag-case-metrics{display:flex;gap:0;border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);margin:6px 0;font-family:var(--sans)}"
    ".fp-oldcards .diag-case-metric{flex:1;text-align:center;padding:8px 4px;border-right:1px solid var(--line-soft)}"
    ".fp-oldcards .diag-case-metric:last-child{border-right:none}"
    ".fp-oldcards .diag-case-metric-val{font-family:var(--mono);font-size:20px;font-weight:700;color:var(--ink);line-height:1.1}"
    ".fp-oldcards .diag-case-metric-lbl{font-family:var(--sans);font-size:10.5px;color:var(--ink-3);margin-top:2px}"
    ".fp-oldcards .diag-case-timeline{display:flex;flex-direction:column;gap:0;border-left:2px solid var(--line);padding-left:12px;margin-left:4px}"
    ".fp-oldcards .diag-case-event{display:flex;align-items:baseline;gap:10px;padding:5px 0;font-family:var(--sans);font-size:12.5px}"
    ".fp-oldcards .diag-case-time{font-family:var(--mono);font-size:11px;color:var(--ink-3);min-width:40px;flex-shrink:0}"
    ".fp-oldcards .diag-case-action{font-family:var(--serif);color:var(--ink-2)}"
    ".fp-oldcards .diag-case-action.has-issue{color:#ee4a4a;font-weight:500}"
    ".fp-oldcards .diag-case-action.is-success{color:#27ad87;font-weight:500}"
    ".fp-oldcards .diag-case-action strong{color:var(--red)}"
    "@media (max-width:680px){.fp-oldcards .diag-card-body{grid-template-columns:1fr}.fp-oldcards .diag-chart-wrap{border-right:none;border-bottom:1px solid var(--line)}}"
)

_SCROLLSPY = """
(function(){function init(){var links={};document.querySelectorAll('.fp-toc-link').forEach(function(a){links[a.getAttribute('data-t')]=a;});var ids=['fp-1','fp-2','fp-3','fp-apx'];if(!document.getElementById('fp-1')||!Object.keys(links).length){return setTimeout(init,120);}function setActive(id){Object.keys(links).forEach(function(k){var on=k===id,a=links[k];a.style.color=on?'#e23b3b':'#6b6b6b';a.style.fontWeight=on?'700':'400';a.style.borderLeftColor=on?'#e23b3b':'transparent';});}function onScroll(){var y=(window.scrollY||document.documentElement.scrollTop)+150,cur=ids[0];ids.forEach(function(id){var el=document.getElementById(id);if(el&&(el.getBoundingClientRect().top+(window.scrollY||document.documentElement.scrollTop))<=y)cur=id;});setActive(cur);}window.addEventListener('scroll',onScroll,{passive:true});window.addEventListener('resize',onScroll,{passive:true});onScroll();}if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);})();
"""


def _build_segment_backlinks(problems, actions) -> dict:
    """人群名 → (核心发现序号, 标题)。对不上的人群不进这张表，附录里就不加链接。

    序号口径必须与 `_chapter1` 的 `problem-{i+1}` 完全一致 —— 那边用的是
    problems 列表下标，这里也用同一个列表算，避免两处编号漂移。
    """
    try:
        rank_to = {}
        for i, p in enumerate(problems or []):
            pr = p.get("problem_rank")
            if pr is not None and pr not in rank_to:
                rank_to[pr] = (i + 1, p.get("title") or "")
        out: dict = {}
        for a in (actions or []):
            hit = rank_to.get(a.get("problem_rank"))
            if not hit:
                continue
            for aud in (a.get("target_audiences") or []):
                name = aud.get("name") if isinstance(aud, dict) else str(aud)
                if name and name not in out:
                    out[name] = hit
        return out
    except Exception:            # noqa: BLE001 —— 附录少几个链接，好过报告渲不出来
        return {}


# 回跳处理：拦截 .fp-jump，用 scrollIntoView 代替裸锚点跳转。
# 裸 `href="#x"` 在报告被嵌入到宿主页后会被解析成绝对地址、触发整页跳转；
# 这里 preventDefault 掉，顺便给落点闪一下描边，让人看清跳到哪了。
# 打印/导出 PDF 时把折叠的原条件强制展开 —— <details> 收起时内容不进 PDF，
# 而附录是给下游圈人做审计用的，原条件不能在纸质版里凭空消失。打印完还原用户原本的状态。
_PRINTOPEN = """
(function(){function all(){return document.querySelectorAll('details.fp-raw');}
window.addEventListener('beforeprint',function(){all().forEach(function(d){d.dataset.fpo=d.open?'1':'';d.open=true;});});
window.addEventListener('afterprint',function(){all().forEach(function(d){d.open=d.dataset.fpo==='1';});});})();
"""

_JUMPBACK = """
(function(){function init(){document.querySelectorAll('a.fp-jump').forEach(function(a){
a.addEventListener('click',function(e){e.preventDefault();
var id=(a.getAttribute('data-to')||'');var t=id&&document.getElementById(id);if(!t)return;
t.scrollIntoView({behavior:'smooth',block:'center'});
var o=t.style.outline,f=t.style.outlineOffset;t.style.outline='2px solid #e23b3b';t.style.outlineOffset='4px';
setTimeout(function(){t.style.outline=o;t.style.outlineOffset=f;},1400);});});}
if(document.readyState!=='loading')init();else document.addEventListener('DOMContentLoaded',init);})();
"""


def _pct(x, dp=2):
    try:
        return f"{float(x)*100:.{dp}f}%"
    except (TypeError, ValueError):
        return "—"


def _pp(x):
    try:
        return f"{float(x)*100:+.2f}pp"
    except (TypeError, ValueError):
        return "—"


def _fmt_lift(v_pp) -> str:
    """潜在改善（pp）自适应精度。固定 .2f 在低基数活动（成单率 0.04%）下会把 <0.01pp 的
    lift 全塌成 "0.00"，使「潜在改善」列/卡显示"无改善"。≥0.01pp 行为与旧 .2f 完全一致，
    仅对更小的量级保留有效位，避免出现误导性的 0.00。"""
    try:
        v = float(v_pp)
    except (TypeError, ValueError):
        return "0"
    if v <= 0:
        return "0"
    if v >= 0.01:
        return f"{v:.2f}"
    if v >= 0.001:
        return f"{v:.3f}"
    return f"{v:.4f}"


def _emph(text: str) -> str:
    """正文关键数字内联高亮：pp 按正负着色，% 与千分位计数加粗等宽（重点突出）。"""
    t = _e(text)
    t = re.sub(r"([+\-−]\s?\d[\d.]*\s?pp)",
               lambda m: f'<b style="font-family:var(--mono);color:{"#1f9e78" if m.group(1).lstrip()[0] == "+" else "#e23b3b"}">{m.group(1)}</b>', t)
    t = re.sub(r"(?<![\d>])(\d[\d.]*%)", r'<b style="font-family:var(--mono)">\1</b>', t)
    t = re.sub(r"(?<![\d>])(\d{1,3}(?:,\d{3})+)", r'<b style="font-family:var(--mono)">\1</b>', t)
    return t


def _hl_path(action: str) -> str:
    """行为时序中的 **关键步骤** → 加粗标红。"""
    return re.sub(r"\*\*(.+?)\*\*", r'<b style="color:#e23b3b">\1</b>', _e(action))


_CN_NUM = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]


def _cn(n: int) -> str:
    return _CN_NUM[n] if 0 <= n <= 10 else str(n)


_DIFF_LABEL = {"easy": "低", "medium": "中", "hard": "高"}
_DIFF_FULL = {"easy": "低难度", "medium": "中难度", "hard": "高难度"}
_SEV_ZH = {"high": "高危", "mid": "中危", "low": "低危"}


def _diff_badge(diff: str, full: bool = False) -> str:
    lbl = (_DIFF_FULL if full else _DIFF_LABEL).get(diff, diff or "中")
    if diff == "easy":
        c, bd = "#1f9e78", "#a9cdb4"
    elif diff == "hard":
        c, bd = "#e23b3b", "#f0c8c0"
    else:
        c, bd = "#b45309", "#c8c8c3"
    return (f'<span style="font-size:{"11px" if full else "10px"};font-weight:600;color:{c};'
            f'border:1px solid {bd};border-radius:3px;padding:{"2px 9px" if full else "1px 7px"};'
            f'white-space:nowrap">{lbl}</span>')


def render_fp(rr) -> str:
    """主入口：传入 ReportRenderer 实例，返回金融纸 HTML 字符串。"""

    R = rr.r
    profile = R.get("campaign_profile") or {}
    cm = R.get("campaign_meta") or {}
    title = profile.get("name") or cm.get("campaign_name") or R.get("campaign_id", "")
    cid = R.get("campaign_id", "")
    date = rr._date

    ov = R.get("data_overview") or {}
    cs = ov.get("conversion_summary") or {}
    rules_by_id = {int(r["rule_id"]): r for r in (ov.get("diagnostic_rules_summary") or [])
                   if r.get("rule_id") is not None}
    lmap = rr._build_rule_label_map()

    problems = rr._extract_top_problems()           # 已按难度排序
    actions = (R.get("action_plan") or {}).get("priority_actions") or []
    segments = R.get("audience_segments") or []

    # 每个问题解析展示数据
    _agent_cat = {**{k: v for k, v in AGENT_DIM_LABELS_ZH.items()},
                  "diagnostic_rules": "诊断规则"}
    pdata = []
    for p in problems:
        cvr = rr._resolve_cvr_for_problem(p, rules_by_id)
        rd = cvr.get("rule_data") or {}
        cat = rd.get("category") or _agent_cat.get(p.get("agent", ""), "综合诊断")
        if not rd:
            cat = _refine_no_rule_category(p, cat)
        rname = _problem_rule_label(p, rd)
        ct, cn, cg = cvr.get("cvr_t"), cvr.get("cvr_n"), cvr.get("cvr_g")
        tr, n_ev = cvr.get("tr"), cvr.get("n_ev")
        is_pos = (p.get("_signal_type") == "positive") or (
            _fin(cg) and float(cg) > 0 and _fin(ct) and _fin(cn) and float(ct) > float(cn))
        is_paid = bool(cvr.get("is_paid_basis"))
        lift = abs(float(cg)) * float(tr) if (_fin(cg) and _fin(tr)) else None
        # 难度取该问题对应行动（problem_rank 匹配）的最易者
        pr = p.get("problem_rank")
        diffs = [a.get("execution_difficulty", "medium") for a in actions if a.get("problem_rank") == pr]
        diff = min(diffs, key=lambda d: _DIFF_RANK.get(d, 1)) if diffs else None
        pdata.append({"p": p, "cat": cat, "rname": rname, "ct": ct, "cn": cn, "cg": cg,
                      "tr": tr, "n_ev": n_ev, "is_pos": is_pos, "is_paid": is_paid,
                      "lift": lift, "diff": diff, "sev": p.get("severity", "mid")})

    head = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            f'<meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>{_e(title)} · 营销诊断报告</title>'
            f'<style>{_FONTS_CSS}\n{_ROOT}{_BASE_CSS}{_CARDS_CSS}</style>'
            f'<script>{_SCROLLSPY}</script>'
            f'<script>{_JUMPBACK}</script>'
            f'<script>{_PRINTOPEN}</script></head>')

    body = (
        _fp_toc()
        + '<div class="fp-sheet" style="max-width:940px;margin:0 auto;background:var(--paper);'
          'border:1px solid var(--line);box-shadow:0 18px 50px -28px rgba(60,45,25,.45);padding:56px 68px 60px">'
        + _masthead(title, cid, date)
        + _exec_summary(R, cs, problems)
        + _funnel_band(cs, pdata, actions)
        + _matrix(pdata, actions)
        + _chapter1(rr, pdata, lmap)
        + _chapter2(rr, problems, actions, segments, lmap,
                    {d["p"].get("problem_rank"): d["tr"] for d in pdata})
        + _chapter3(rr)
        + _appendix(rr, segments, _build_segment_backlinks(problems, actions))
        + _footer(title, cid, date)
        + '</div>'
    )
    wrap = ('<div style="min-height:100vh;background:var(--bg);padding:44px 24px 72px;'
            'font-family:var(--serif);color:var(--ink)">' + body + '</div>')
    return head + '<body>' + wrap + '</body></html>'


# ── 固定左侧目录 ──────────────────────────────────────────────────────
def _fp_toc() -> str:
    items = [("fp-1", "I", "核心问题诊断"), ("fp-2", "II", "行动建议"),
             ("fp-3", "III", "详细诊断数据"), ("fp-apx", "A", "附录数据")]
    links = ""
    for i, (tid, num, name) in enumerate(items):
        on = i == 0
        links += (f'<a class="fp-toc-link" data-t="{tid}" href="#{tid}" '
                  f'style="display:block;font-size:11.5px;line-height:1.4;'
                  f'color:{"#e23b3b" if on else "#6b6b6b"};font-weight:{"700" if on else "400"};'
                  f'text-decoration:none;padding:8px 0 8px 14px;'
                  f'border-left:2px solid {"#e23b3b" if on else "transparent"};font-family:var(--mono)">'
                  f'{num}&nbsp;&nbsp;{name}</a>')
    return (f'<aside class="fp-toc" style="position:fixed;top:50%;left:max(16px,calc(50% - 640px));'
            f'transform:translateY(-50%);width:152px;z-index:60;font-family:var(--mono)">'
            f'<div style="font-size:10px;letter-spacing:.18em;text-transform:uppercase;'
            f'color:var(--lab);margin-bottom:14px;padding-left:14px">目录</div>{links}</aside>')


# ── 刊头 ──────────────────────────────────────────────────────────────
def _masthead(title, cid, date) -> str:
    return (
        '<header style="border-bottom:3px double var(--ink);padding-bottom:16px;margin-bottom:8px">'
        '<div style="display:flex;justify-content:space-between;align-items:baseline;'
        'font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;'
        'color:#7c2d12;font-weight:600;margin-bottom:18px">'
        '<span>营销活动诊断 · Marketing Diagnostic</span>'
        f'<span style="color:var(--faint)">{_e(cid)}</span></div>'
        f'<h1 style="font-size:42px;font-weight:700;line-height:1.1;letter-spacing:-.015em;'
        f'margin:0 0 10px;color:var(--ink)">{_e(title)}</h1>'
        '<div style="display:flex;justify-content:space-between;align-items:baseline;'
        'font-size:13px;color:var(--mut)">'
        '<span style="font-style:italic">全量营销活动转化诊断 · 支付成单（is_paid）口径</span>'
        f'<span style="font-family:var(--mono);font-size:11px;color:var(--faint)">{_e(date)}</span></div>'
        '</header>'
    )


# ── 核心结论 + 内联目录 ───────────────────────────────────────────────
def _exec_summary(R, cs, problems) -> str:
    headline = (R.get("narratives") or {}).get("headline") if isinstance(R.get("narratives"), dict) else None
    headline = headline or R.get("headline") or ""
    # 副句：优先用 Agent 撰写的 narratives.subhead（面向真实数据，不会像定型句那样在
    # 创单=成单/零转化等边界数据上自相矛盾）。渲染层不再自造带数据结论的模板句——
    # 缺省仅回退到不含任何数据判断的结构导航句。
    nar = R.get("narratives") if isinstance(R.get("narratives"), dict) else {}
    sub = (nar.get("subhead") or "").strip() if isinstance(nar, dict) else ""
    if not sub:
        sub = "下文按严重度拆解核心问题，并给出可落地的人群包与行动。"
    toc_rows = ""
    nav = [("fp-1", "核心问题诊断", "I"), ("fp-2", "行动建议", "II"),
           ("fp-3", "详细诊断数据", "III"), ("fp-apx", "附录数据", "A")]
    for i, (tid, name, num) in enumerate(nav):
        last = i == len(nav) - 1
        toc_rows += (f'<a href="#{tid}" style="display:flex;justify-content:space-between;gap:8px;'
                     f'padding:7px 0;white-space:nowrap;{"" if last else "border-bottom:1px solid var(--line2);"}'
                     f'color:var(--ink);text-decoration:none"><span>{name}</span>'
                     f'<span style="font-family:var(--mono);color:var(--lab)">{num}</span></a>')
    return (
        '<section style="display:grid;grid-template-columns:1fr 250px;gap:36px;padding:26px 0 4px;'
        'border-bottom:1px solid var(--line);margin-bottom:30px"><div>'
        '<div style="font-family:var(--mono);font-size:10px;letter-spacing:.2em;text-transform:uppercase;'
        'color:var(--lab);margin-bottom:12px">核心结论</div>'
        f'<p style="font-size:21px;line-height:1.5;font-weight:500;margin:0 0 14px;color:var(--ink);'
        f'letter-spacing:-.005em">{_emph(headline)}</p>'
        f'<p style="font-size:13.5px;font-style:italic;line-height:1.65;color:var(--mut);margin:0">{_e(sub)}</p>'
        '</div>'
        '<nav style="border-left:1px solid var(--line);padding-left:24px;font-size:12.5px;line-height:1">'
        '<div style="font-family:var(--mono);font-size:10px;letter-spacing:.16em;text-transform:uppercase;'
        f'color:var(--lab);margin-bottom:14px">目录</div>{toc_rows}</nav></section>'
    )


# ── 转化漏斗带 ────────────────────────────────────────────────────────
def _funnel_band(cs, pdata, actions) -> str:
    users = cs.get("total_users") or 0
    conv = cs.get("converted") or 0
    paid = cs.get("paid") or 0
    cvr = cs.get("overall_cvr")
    paid_rate = cs.get("paid_rate")
    pay_of_conv = (paid / conv) if conv else None
    n_high = sum(1 for d in pdata if d["sev"] == "high")
    n_act = len(actions)

    def big(v, color="var(--ink)"):
        return (f'<div style="font-family:var(--mono);font-size:32px;font-weight:600;'
                f'letter-spacing:-.02em;color:{color};line-height:1">{v}</div>')

    def lbl(t):
        return f'<div style="margin-top:8px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)">{t}</div>'

    def step(top, val, arrow_color):
        # 漏斗步骤小标签统一黑色加粗（封面减少彩色干扰）；箭头保留语义色。
        # 不再标注"主要失血点"：该标签曾硬编码在创单→支付步骤上，与实际支付率无关（100% 也显示）
        lab_c = "#000000;font-weight:700" if arrow_color == "var(--red)" else arrow_color
        return (f'<div style="text-align:center;padding:0 8px">'
                f'<div style="font-size:9px;letter-spacing:.06em;text-transform:uppercase;color:{lab_c};margin-bottom:3px">{top}</div>'
                f'<div style="font-family:var(--mono);font-size:14px;font-weight:600;color:var(--ink)">{val}</div>'
                f'<div style="color:{arrow_color};font-size:13px;line-height:1;margin-top:3px">──▸</div></div>')

    return (
        '<div style="border:1px solid var(--line);background:var(--panel);margin-bottom:42px;padding:20px 28px 22px">'
        '<div style="display:flex;justify-content:space-between;align-items:baseline;padding-bottom:14px;'
        'margin-bottom:18px;border-bottom:1px solid var(--line)">'
        '<span style="font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;'
        'color:#000000;font-weight:700">转化漏斗 · 支付成单口径</span>'
        f'<span style="font-family:var(--mono);font-size:10.5px;letter-spacing:.04em;color:var(--faint)">'
        f'{n_high} 高危问题 · {n_act} 优先行动</span></div>'
        '<div style="display:grid;grid-template-columns:1fr 104px 1fr 104px 1fr;align-items:center">'
        f'<div>{big(f"{users:,}")}{lbl("活动覆盖用户")}</div>'
        f'{step("创单率", _pct(cvr), "#b45309")}'
        f'<div>{big(f"{conv:,}")}{lbl("创单用户")}</div>'
        f'{step("创单→支付", _pct(pay_of_conv, 1), "var(--red)")}'
        f'<div>{big(f"{paid:,}", "var(--red)")}{lbl("成单用户 · 成单率 " + _pct(paid_rate))}</div>'
        '</div></div>'
    )


# ── 问题 → 行动 矩阵 ──────────────────────────────────────────────────
def _matrix(pdata, actions) -> str:
    max_lift = max([d["lift"] for d in pdata if d["lift"]] or [1.0]) or 1.0
    rows = ""
    total_neg = 0.0
    for d in pdata:
        p = d["p"]
        name = d["rname"] or (p.get("title", "")[:14])
        dot = "#1f9e78" if d["is_pos"] else ("#b45309" if p.get("_signal_type") == "leakage" else "#e23b3b")
        lift = d["lift"] or 0.0
        if not d["is_pos"]:
            total_neg += lift
        bar_c = "#1f9e78" if d["is_pos"] else "#e23b3b"
        if p.get("_signal_type") == "leakage":
            bar_c = "#b45309"
        w = max(2, int(lift / max_lift * 100))
        lift_s = f'+{_fmt_lift(lift*100)}'
        # 对应行动
        pr = p.get("problem_rank")
        act = next((a for a in actions if a.get("problem_rank") == pr), None)
        act_title = (act.get("title", "") if act else "").split("，")[0].split(",")[0]
        diff = _diff_badge(d["diff"] or "medium")
        trig = _pct(d["tr"], 1) if _fin(d["tr"]) else "—"
        rows += (
            '<tr style="border-bottom:1px solid var(--line2)">'
            f'<td style="padding:11px 8px 11px 0;font-weight:600;color:var(--ink);white-space:nowrap">'
            f'<span style="display:inline-block;width:7px;height:7px;border-radius:2px;background:{dot};margin-right:7px"></span>{_e(name)}</td>'
            f'<td style="padding:11px 8px"><div style="display:flex;align-items:center;gap:8px">'
            f'<div style="flex:1;height:11px;background:var(--bar);overflow:hidden;min-width:48px">'
            f'<div style="height:100%;width:{w}%;background:{bar_c}"></div></div>'
            f'<span style="font-family:var(--mono);font-size:11.5px;font-weight:600;color:{bar_c};width:42px;text-align:right">{lift_s}</span></div></td>'
            f'<td style="padding:11px 8px">{diff}</td>'
            f'<td style="padding:11px 8px;color:var(--ink)">{_e(act_title)}</td>'
            f'<td style="padding:11px 0 11px 8px;text-align:right;font-family:var(--mono);font-size:11.5px;'
            f'font-weight:600;color:var(--ink);white-space:nowrap">{trig}</td></tr>'
        )
    th = ('<th style="text-align:{a};padding:9px 8px;font-family:var(--mono);font-size:9px;font-weight:700;'
          'letter-spacing:.06em;text-transform:uppercase;color:#000000{w}">{t}</th>')
    head = ("<tr style=\"border-bottom:1px solid var(--line)\">"
            + th.format(a="left", w=";padding-left:0", t="问题")
            + th.format(a="left", w=";width:150px", t="潜在改善")
            + th.format(a="left", w=";width:52px", t="难度")
            + th.format(a="left", w="", t="对应行动")
            + th.format(a="right", w=";width:84px;padding-right:0", t="触发占比")
            + "</tr>")
    return (
        '<div style="border:1px solid var(--line);background:var(--panel);margin-bottom:42px;padding:18px 24px 15px">'
        '<div style="font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;'
        'color:#000000;font-weight:700;padding-bottom:12px;margin-bottom:4px;border-bottom:1px solid var(--line)">核心问题 → 行动</div>'
        f'<table style="width:100%;border-collapse:collapse;font-size:12.5px"><thead>{head}</thead><tbody>{rows}</tbody></table>'
        '<div style="padding-top:12px;margin-top:3px;border-top:1px solid var(--line);display:flex;'
        'justify-content:space-between;gap:16px;font-size:11.5px;color:var(--mut);flex-wrap:wrap">'
        f'<span>失血点合计 <b style="font-family:var(--mono);color:var(--ink)">~{total_neg*100:.1f}pp</b> · '
        '<span style="color:var(--grn)">绿色为正向机会</span></span>'
        '<span>建议从 <b style="color:var(--ink)">低难度</b> 项起步</span></div></div>'
    )


# ── 第一章：核心问题诊断（老版 diag-card 样式）─────────────────────────
# 定稿配色（S3 鲜明高对比，已直接固化）：严重度 / 难度徽章色
_CARD_SEV = {"high": ("高危", "#e23b3b"), "mid": ("中危", "#b45309"), "low": ("低危", "#6b7280")}
_CARD_EASE = {"easy": ("低难度", "#1f9e78"), "medium": ("中难度", "#b45309"), "hard": ("高难度", "#e23b3b")}


def _nice_axis(maxv: float):
    """为条形图选取美观的坐标轴上限与刻度（≤6 格）。"""
    if maxv <= 0:
        maxv = 0.01
    raw = maxv * 1.12
    step = 1.0
    for u in (0.001, 0.002, 0.0025, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.5):
        if raw / u <= 6:
            step = u
            break
    axis_max = _math.ceil(raw / step) * step
    n = int(round(axis_max / step))
    return axis_max, [round(step * i, 5) for i in range(n + 1)]


def _svg_chart(cvr_t: float, cvr_n: float, positive: bool, r1lab: str, r2lab: str) -> str:
    """坐标轴条形图（触发组 vs 对照组）；<title> 悬停/点选展示具体值。"""
    axis_max, ticks = _nice_axis(max(cvr_t, cvr_n))
    X0, W = 150, 462

    def bx(v):
        return W * (v / axis_max if axis_max else 0)

    grid = ""
    for t in ticks:
        x = X0 + bx(t)
        grid += (f'<line x1="{x:.1f}" y1="12" x2="{x:.1f}" y2="70" stroke="#ebe9e3" stroke-width="1"/>'
                 f'<text x="{x:.1f}" y="84" font-size="10" fill="#9a9a9a" text-anchor="middle" '
                 f'font-family="Spline Sans Mono,monospace">{t*100:g}%</text>')
    r1c, r2c = ("#1f9e78", "#c5d0d1") if positive else ("#e23b3b", "#1f9e78")
    w1, w2 = bx(cvr_t), bx(cvr_n)

    def row(y, w, c, label, val):
        w = max(w, 2.2)  # 0 值也留一抹色块
        return (f'<g style="cursor:pointer"><title>{_e(label)}：{val}</title>'
                f'<rect x="{X0}" y="{y-6}" width="{W}" height="28" fill="transparent"/>'
                f'<rect x="{X0}" y="{y}" width="{w:.1f}" height="16" fill="{c}" rx="1.5"/></g>')
    return (
        '<svg viewBox="0 0 624 92" width="100%" height="92" '
        'font-family="-apple-system,PingFang SC,Microsoft YaHei,sans-serif">'
        f'{grid}'
        f'<text x="{X0-8}" y="30" font-size="11" fill="#444444" text-anchor="end">{_e(r1lab)}</text>'
        f'{row(20, w1, r1c, r1lab, f"{cvr_t*100:.2f}%")}'
        f'<text x="{X0-8}" y="60" font-size="11" fill="#444444" text-anchor="end">{_e(r2lab)}</text>'
        f'{row(50, w2, r2c, r2lab, f"{cvr_n*100:.2f}%")}'
        '</svg>'
    )


def _chapter1(rr, pdata, lmap) -> str:
    n = len(pdata)
    cards = "".join(_diag_card(rr, i + 1, d, lmap) for i, d in enumerate(pdata))
    # 正向机会不应被称作"根本问题"：标题/副标题按问题与机会的构成自适应
    n_pos = sum(1 for d in pdata if d.get("is_pos"))
    if n_pos and n_pos < n:
        head = f'{_cn(n)}项核心发现（含 {_cn(n_pos)} 项正向机会）'
        sub = '问题与正向机会并列呈现，按实现难度与严重度排序。'
    elif n and n_pos == n:
        head = f'{_cn(n)}项正向机会'
        sub = '识别出可定向放大的优质人群信号，按优先级排序。'
    else:
        head = f'{_cn(n)}项相互关联的根本问题'
        sub = '每一项均直接影响转化漏斗的特定环节，按严重度排序。'
    return (
        '<section id="fp-1" style="margin-bottom:44px">'
        '<div style="margin-bottom:26px">'
        '<div style="font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;'
        'color:#7c2d12;font-weight:600;margin-bottom:8px">I · 核心问题诊断</div>'
        f'<h2 style="font-size:27px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px;color:var(--ink)">'
        f'{head}</h2>'
        '<p style="font-size:13.5px;font-style:italic;color:var(--mut);margin:0;line-height:1.6">'
        f'{sub}</p></div>'
        f'<div class="fp-oldcards">{cards}</div></section>'
    )


def _diag_card(rr, num, d, lmap) -> str:
    """单张核心问题卡：chip 头部 + 坐标轴条形图 + 右侧 KPI + 业务影响 + 典型案例。"""
    p = d["p"]
    is_pos = d["is_pos"]
    is_paid = d["is_paid"]
    ct = float(d["ct"]) if _fin(d["ct"]) else 0.0
    cn = float(d["cn"]) if _fin(d["cn"]) else 0.0
    cg = float(d["cg"]) if _fin(d["cg"]) else (ct - cn)
    tr = float(d["tr"]) if _fin(d["tr"]) else 0.0
    n_ev = int(d["n_ev"]) if _fin(d["n_ev"]) else 0
    exp = (float(d["lift"]) * 100) if _fin(d["lift"]) else abs(cg) * tr * 100
    sev_txt, sev_col = _CARD_SEV.get(d["sev"], _CARD_SEV["mid"])
    ease_txt, ease_col = _CARD_EASE.get(d["diff"], _CARD_EASE["medium"])
    mt = "支付成单率" if is_paid else "创单率"
    # 显著性提示：差异未达显著时保留（数据正确性），简洁呈现
    rd = rr._resolve_cvr_for_problem(
        p, {int(r["rule_id"]): r for r in ((rr.r.get("data_overview") or {}).get("diagnostic_rules_summary") or [])
            if r.get("rule_id") is not None}).get("rule_data") or {}
    sig = ""
    if rd.get("cvr_gap_p_value") is not None and not rd.get("cvr_gap_significant"):
        sig = f'<span class="diag-sig-badge">⚠ 差异未达显著 p={float(rd["cvr_gap_p_value"]):.2f}</span>'
    if is_pos:
        r1lab, r2lab = "高潜用户（触发规则）", "其余用户"
        lab_trig, lab_norm = f"高潜{mt}", f"其余{mt}"
        badcls = "diag-cvr-good"
        chart_title = f"高潜用户 vs 其余用户{mt}对比"
    else:
        r1lab, r2lab = "有问题用户（触发规则）", "正常用户"
        lab_trig, lab_norm = f"触发用户{mt}", f"正常用户{mt}"
        badcls = "diag-cvr-bad"
        chart_title = f"有问题用户 vs 正常用户{mt}对比"
    gapcls = "good-val" if is_pos else "bad-val"
    narrative = _emph(rr._expand_rule_refs(p.get("narrative", ""), lmap))
    impact = _emph(rr._expand_rule_refs(p.get("impact", ""), lmap))
    case = _diag_case(rr, p.get("typical_case"))
    return (
        f'<article class="diag-card" id="problem-{num}">'
        '<div class="diag-card-header">'
        f'<span class="diag-rank">#{num}</span>'
        f'<span class="diag-category">{_e(d["cat"])}</span>'
        f'<span class="diag-rule-name">{_e(d["rname"] or "")}</span>'
        f'<span class="diag-name">{_e(p.get("title", ""))}</span>'
        f'<span class="diag-ease-badge" style="background:{ease_col}15;color:{ease_col}">{ease_txt}</span>'
        f'<span class="diag-sev-badge" style="color:{sev_col}">{sev_txt}</span>{sig}'
        '</div>'
        '<div class="diag-card-body">'
        '<div class="diag-chart-wrap">'
        f'<div class="diag-chart-title">{_e(chart_title)}</div>'
        f'{_svg_chart(ct, cn, is_pos, r1lab, r2lab)}'
        '<div class="diag-cvr-labels">'
        f'<span class="{badcls}">{lab_trig} <strong>{_pct(ct)}</strong></span>'
        f'<span class="diag-cvr-good">{lab_norm} <strong>{_pct(cn)}</strong></span>'
        f'<span class="diag-cvr-gap {gapcls}">差值 <strong>{cg*100:+.2f}pp</strong></span>'
        '</div></div>'
        '<div class="diag-metrics">'
        f'<div class="diag-metric-item"><div class="diag-metric-val">{tr*100:.1f}%</div>'
        '<div class="diag-metric-lbl">触发比例</div></div>'
        f'<div class="diag-metric-item"><div class="diag-metric-val">{n_ev:,}</div>'
        '<div class="diag-metric-lbl">触发用户数</div></div>'
        '<div class="diag-metric-item diag-metric-lift">'
        f'<div class="diag-metric-val-sm">全量{mt}预期可改善约 {_fmt_lift(exp)}pp</div></div>'
        '</div></div>'
        '<div class="diag-narrative-block">'
        f'<p class="diag-narrative-text">{narrative}</p>'
        f'<p class="diag-impact-row"><span class="impact-label">业务影响</span>'
        f'<span class="impact-text">{impact}</span></p>'
        '</div>'
        f'{case}</article>'
    )


def _diag_case(rr, case) -> str:
    """典型案例（折叠）：用户画像 + 行为时序 + 根因分析。"""
    if not case:
        return ""
    uid = case.get("user_id", "")
    badge_type = case.get("badge_type", "immune")
    badge_txt = case.get("badge_text", "")
    profile = case.get("profile_text", "")
    metrics = case.get("metrics") or []
    timeline = case.get("timeline") or []
    root = case.get("root_cause", "")

    def _strong(t):
        return re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", _e(t))

    mhtml = "".join(
        f'<div class="diag-case-metric"><div class="diag-case-metric-val">{_e(str(m.get("val", "—")))}</div>'
        f'<div class="diag-case-metric-lbl">{_e(rr._humanize_feature(m.get("label", "")))}</div></div>'
        for m in metrics[:4])
    thtml = "".join(
        f'<div class="diag-case-event"><span class="diag-case-time">{_e(e.get("time", ""))}</span>'
        f'<span class="diag-case-action '
        f'{"has-issue" if e.get("type") == "issue" else ("is-success" if e.get("type") == "success" else "")}">'
        f'{_strong(e.get("action", ""))}</span></div>'
        for e in timeline)
    profile_block = (f'<div class="diag-case-section"><div class="diag-case-label">用户画像</div>'
                     f'<p style="font-family:var(--serif);font-size:12.5px;color:var(--ink-2);margin:0 0 6px">{_emph(profile)}</p>'
                     f'<div class="diag-case-metrics">{mhtml}</div></div>') if (profile or mhtml) else ""
    timeline_block = (f'<div class="diag-case-section"><div class="diag-case-label">行为时序</div>'
                      f'<div class="diag-case-timeline">{thtml}</div></div>') if thtml else ""
    root_block = (f'<div class="diag-case-section"><div class="diag-case-label">根因分析</div>'
                  f'<p style="font-family:var(--serif);font-size:12.5px;color:var(--ink-2);margin:0">{_e(root)}</p></div>') if root else ""
    tag = f'<span class="diag-case-tag">· {_e(badge_txt)}</span>' if badge_txt else ""
    return (
        '<details class="diag-case-block">'
        f'<summary class="diag-case-title">典型案例{tag}<span class="diag-case-hint">（点击展开）</span></summary>'
        '<div class="diag-case-card">'
        f'<div class="diag-case-header"><span class="diag-case-userid">用户 ID: {_e(uid)}</span>'
        f'<span class="diag-case-badge {_e(badge_type)}">{_e(badge_txt)}</span></div>'
        f'<div class="diag-case-body">{profile_block}{timeline_block}{root_block}</div>'
        '</div></details>'
    )


# ── 第二章：行动建议 ──────────────────────────────────────────────────
def _chapter2(rr, problems, actions, segments, lmap, tr_by_rank=None) -> str:
    tr_by_rank = tr_by_rank or {}
    # 行动按对应问题的展示顺序（难度）排列，编号 01..N
    order = {p.get("problem_rank"): i for i, p in enumerate(problems) if p.get("problem_rank") is not None}
    acts = sorted(actions, key=lambda a: (order.get(a.get("problem_rank"), 999),
                                          _DIFF_RANK.get(a.get("execution_difficulty", "medium"), 1),
                                          int(a.get("rank") or 99)))
    seg_names = {s.get("name") for s in segments if isinstance(s, dict) and s.get("name")}
    arts = ""
    n = len(acts)
    for i, a in enumerate(acts):
        last = i == n - 1
        arts += _action_article(rr, i + 1, a, seg_names, lmap, last, tr_by_rank.get(a.get("problem_rank")))
    return (
        '<section id="fp-2" style="margin-bottom:44px">'
        '<div style="margin-bottom:24px">'
        '<div style="font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;'
        'color:#7c2d12;font-weight:600;margin-bottom:8px">II · 行动建议</div>'
        '<h2 style="font-size:27px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px;color:var(--ink)">优先行动与预期效果</h2>'
        '<p style="font-size:13.5px;font-style:italic;color:var(--mut);margin:0;line-height:1.6">'
        '编号与核心问题一一对应，目标人群均链接至附录的人群包定义。</p></div>'
        f'<div style="border-top:2px solid var(--ink)">{arts}</div></section>'
    )


def _action_article(rr, num, a, seg_names, lmap, last, tr=None) -> str:
    diff = a.get("execution_difficulty", "medium")
    num_color = "#1f9e78" if diff == "easy" else ("#e23b3b" if diff == "hard" else "#b45309")
    # 标题旁展示对应人群「触发占比」（替代原现状→目标）
    goal = (f'<span style="color:var(--faint)">触发占比 </span>{_pct(tr, 1)}'
            if _fin(tr) else "")
    desc = _e(rr._expand_rule_refs(a.get("description", ""), lmap))
    evidence = _emph(rr._expand_rule_refs((a.get("evidence") or "")[:200], lmap))
    expected = _e(a.get("expected_impact", "—"))
    # 人群 chips → 附录锚点
    chips = ""
    for aud in (a.get("target_audiences") or [])[:3]:
        name = aud.get("name") if isinstance(aud, dict) else str(aud)
        if not name:
            continue
        anchor = rr._segment_anchor_id(name)
        linked = name in seg_names
        href = f'href="#{anchor}"' if linked else 'href="javascript:void(0)"'
        chips += (f'<a {href} style="display:inline-flex;align-items:center;gap:5px;font-size:11.5px;'
                  f'color:var(--chiptx);background:var(--chipbg);border:1px solid var(--chipbd);'
                  f'border-radius:3px;padding:3px 9px;text-decoration:none">'
                  f'<span style="color:var(--lab)">▸</span>{_e(name)}</a>')
    if not chips:
        chips = '<span style="font-size:11.5px;color:var(--mut)">全量用户</span>'
    bottom = "2px solid var(--ink)" if last else "1px solid var(--line)"
    return (
        f'<article style="padding:22px 0;border-bottom:{bottom}">'
        '<div style="display:grid;grid-template-columns:40px 1fr;gap:18px">'
        f'<span style="font-size:26px;font-style:italic;font-weight:600;color:{num_color};line-height:.9">{num:02d}</span>'
        '<div><div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:7px">'
        f'<h3 style="flex:1;min-width:220px;font-size:16.5px;font-weight:600;margin:0;color:var(--ink)">{_e(a.get("title",""))}</h3>'
        f'{_diff_badge(diff, full=True)}'
        f'<span style="font-family:var(--mono);font-size:13px;font-weight:600;color:var(--ink);white-space:nowrap">{goal}</span></div>'
        f'<p style="font-size:13.5px;line-height:1.65;color:var(--ink2);margin:0 0 10px">{desc}</p>'
        f'<p style="font-size:12.5px;line-height:1.6;font-style:italic;color:var(--mut);margin:0 0 14px;'
        f'border-left:2px solid #b45309;padding-left:12px"><b style="font-style:normal;font-family:var(--mono);'
        f'font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--amb)">证据 &nbsp;</b>{evidence}</p>'
        '<div style="display:grid;grid-template-columns:60px 1fr;gap:9px 14px;align-items:start;font-size:12.5px">'
        '<span style="font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--lab);padding-top:5px">目标人群</span>'
        f'<div style="display:flex;flex-wrap:wrap;gap:7px">{chips}</div>'
        '<span style="font-family:var(--mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--lab);padding-top:2px">预期效果</span>'
        f'<span style="color:var(--ink2);line-height:1.55">{expected}</span></div></div></div></article>'
    )


def _rule_row_severity(r: dict) -> str:
    """详细表用的数据驱动严重度（与 draft finding 同口径），替代恒为 mid 的 severity_base。

    severity_base 未导出到 diagnostic_rules_summary，旧逻辑 r.get('severity_base','mid')
    恒返回 'mid'，使详细表严重度列对所有规则都显示"中等"。改为按相对效应量 + 体量 +
    显著性 + 定义性/泄漏判定，使列值有意义且与核心问题卡严重度一致。
    """
    if r.get("_signal_type") == "positive" or r.get("is_positive_signal"):
        return "mid"  # 正向机会不计严重度高低
    n_tc = int(r.get("trigger_cnt") or 0)
    total = int(r.get("total_cnt") or 0)
    scale = (n_tc / total) if total else 0.0
    if r.get("is_leakage"):
        return "high" if n_tc >= 1000 else "mid"
    if r.get("is_definitional"):
        # 定义性规则触发组 CVR=0 是逻辑必然，相对效应量失真，按触发体量定级
        return "high" if scale >= 0.30 else "mid" if scale >= 0.05 else "low"
    cn = r.get("cvr_not_triggered")
    gap = r.get("cvr_gap")
    cn_ref = float(cn) if _fin(cn) else 0.0
    rel = (abs(float(gap)) / cn_ref) if (cn_ref > 0 and _fin(gap)) else 0.0
    sev = "high" if (rel >= 0.60 or (scale >= 0.10 and rel >= 0.30)) else "mid"
    # 显著性封顶：差异未达显著（卡方 p≥0.05）不得为 high
    if sev == "high" and r.get("cvr_gap_p_value") is not None and not r.get("cvr_gap_significant"):
        sev = "mid"
    return sev


# ── 第三章：详细诊断数据 ──────────────────────────────────────────────
def _chapter3(rr) -> str:
    rules = (rr.r.get("data_overview") or {}).get("diagnostic_rules_summary") or []
    trig = [r for r in rules if r.get("status") == "triggered" and _fin(r.get("cvr_gap")) and _fin(r.get("trigger_rate"))]
    def sk(r):
        ev = float(r.get("_ease", 0.5))
        return (0 if ev <= 0.35 else 1 if ev <= 0.55 else 2, -float(r.get("trigger_rate", 0)))
    trig.sort(key=sk)
    top = trig[:10]
    th = ('<th style="text-align:{a};padding:9px 8px;font-family:var(--mono);font-size:9px;font-weight:700;'
          'letter-spacing:.06em;text-transform:uppercase;color:#000000{w}">{t}</th>')
    head = ('<tr style="border-top:2px solid var(--ink);border-bottom:1px solid var(--ink)">'
            + th.format(a="left", w=";width:26px", t="#") + th.format(a="left", w="", t="大类")
            + th.format(a="left", w="", t="问题名称") + th.format(a="left", w="", t="严重度")
            + th.format(a="left", w="", t="难度") + th.format(a="right", w="", t="触发比例")
            + th.format(a="right", w="", t="触发人数") + th.format(a="right", w="", t="触发支付率")
            + th.format(a="right", w="", t="正常支付率") + th.format(a="right", w="", t="差值") + '</tr>')
    rows = ""
    for i, r in enumerate(top, 1):
        last = i == len(top)
        bb = "2px solid var(--ink)" if last else "1px solid var(--line2)"
        # cvr_triggered/not/gap 已是展示主口径（默认成单率 is_paid）；过程口径创单率为 create_*
        ct, cn, gap = r.get("cvr_triggered"), r.get("cvr_not_triggered"), r.get("cvr_gap")
        sev = _rule_row_severity(r)
        sev_zh = {"high": "严重", "mid": "中等", "low": "轻微"}.get(sev, "")
        sev_c = {"high": "#e23b3b", "mid": "#b45309", "low": "#555553"}.get(sev, "#555553")
        gap_c = "#e23b3b" if (_fin(gap) and float(gap) < 0) else "#1f9e78"
        td = 'padding:9px 8px;font-family:var(--mono)'
        rows += (
            f'<tr style="border-bottom:{bb}">'
            f'<td style="{td};color:var(--lab)">{i}</td>'
            f'<td style="padding:9px 8px;color:var(--faint);white-space:nowrap">{_e(r.get("category",""))}</td>'
            f'<td style="padding:9px 8px;font-weight:600;white-space:nowrap">{_e(r.get("display_name") or r.get("name",""))}</td>'
            f'<td style="padding:9px 8px;color:{sev_c}">{sev_zh}</td>'
            f'<td style="padding:9px 8px">{_diff_badge("easy" if float(r.get("_ease",0.5))<=0.35 else "hard" if float(r.get("_ease",0.5))>0.55 else "medium")}</td>'
            f'<td style="{td};text-align:right">{_pct(r.get("trigger_rate"),1)}</td>'
            f'<td style="{td};text-align:right">{int(r.get("trigger_cnt") or 0):,}</td>'
            f'<td style="{td};text-align:right;color:#000000">{_pct(ct)}</td>'
            f'<td style="{td};text-align:right;color:#000000">{_pct(cn)}</td>'
            f'<td style="{td};text-align:right;font-weight:600;color:{gap_c}">{_pp(gap)}</td></tr>'
        )
    if not rows:
        rows = '<tr><td colspan="10" style="padding:14px;color:var(--mut);font-style:italic">暂无有效触发规则可展示。</td></tr>'
    return (
        '<section id="fp-3" style="margin-bottom:44px">'
        '<div style="margin-bottom:24px">'
        '<div style="font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;'
        'color:#7c2d12;font-weight:600;margin-bottom:8px">III · 详细诊断数据</div>'
        '<h2 style="font-size:27px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px;color:var(--ink)">全部诊断维度（Top 10）</h2>'
        '<p style="font-size:13.5px;font-style:italic;color:var(--mut);margin:0;line-height:1.6">'
        '按执行难易（低→高）、触发比例（高→低）排序；支付率均为支付成单（is_paid）口径。</p></div>'
        f'<div style="overflow-x:auto"><table id="ddtable" style="width:100%;border-collapse:collapse;font-size:11.5px">'
        f'<thead>{head}</thead><tbody>{rows}</tbody></table></div></section>'
    )


# ── 附录 ──────────────────────────────────────────────────────────────
def _appendix(rr, segments, seg_back=None) -> str:
    R = rr.r
    findings = [f for f in (R.get("findings") or []) if f.get("signal")]
    # 全部发现
    f_rows = ""
    for k, f in enumerate(findings):
        last = k == len(findings) - 1
        bb = "2px solid var(--ink)" if last else "1px solid var(--line2)"
        sev = f.get("severity", "mid")
        lvl = {"high": ("● 高", "#e23b3b"), "mid": ("● 中", "#b45309"), "low": ("● 低", "#555553")}.get(sev, ("● 中", "#b45309"))
        f_rows += (f'<tr style="border-bottom:{bb}">'
                   f'<td style="padding:10px;vertical-align:top;color:{lvl[1]};font-weight:600;white-space:nowrap">{lvl[0]}</td>'
                   f'<td style="padding:10px;vertical-align:top;font-weight:600;width:30%">{_e(f.get("signal",""))}</td>'
                   f'<td style="padding:10px;vertical-align:top;color:var(--mut);line-height:1.55">{_e((f.get("detail") or "").replace("[待润色]",""))}</td></tr>')
    # 人群包
    s_rows = ""
    for k, s in enumerate(segments):
        last = k == len(segments) - 1
        bb = "2px solid var(--ink)" if last else "1px solid var(--line2)"
        anchor = rr._segment_anchor_id(s.get("name", ""))
        # 回跳：能对上核心发现的做成链接，对不上的保持纯文本（不给死链）
        _sname = s.get("name", "")
        _back = (seg_back or {}).get(_sname)
        if _back:
            _bnum, _btitle = _back
            _name_cell = (
                f'<a class="fp-jump" href="#problem-{_bnum}" data-to="problem-{_bnum}" '
                f'title="回到核心发现 #{_bnum}：{_e(_btitle)}" '
                f'style="color:var(--ink);text-decoration:none;border-bottom:1px dashed var(--line2)">'
                f'{_e(_sname)}'
                f'<span style="margin-left:6px;font-family:var(--mono);font-size:10px;font-weight:600;'
                f'color:var(--chiptx);background:var(--chipbg);border-radius:2px;padding:1px 4px;'
                f'white-space:nowrap">↑ #{_bnum}</span></a>')
        else:
            _name_cell = _e(_sname)
        # 筛选条件：中文主显，英文原条件折叠。中文是展示层投影，原文一个字不改。
        _raw_cond = s.get("filter_conditions", "")
        _code = (f'<code style="font-family:var(--mono);font-size:11px;background:var(--chipbg);'
                 f'padding:1px 5px;border-radius:2px;color:var(--chiptx);word-break:break-all">'
                 f'{_e(_raw_cond)}</code>')
        _zh_cond = humanize_condition(_raw_cond)
        # 只有真翻出东西才折叠：翻不动时 humanize_condition 会原样回显，
        # 那样折叠只是把同一串英文显示两遍，还把它藏了一半。
        if _zh_cond and _zh_cond.strip() != _raw_cond.strip():
            _cond_cell = (
                f'<div style="line-height:1.6;color:var(--ink)">{_e(_zh_cond)}</div>'
                f'<details class="fp-raw" style="margin:0"><summary style="cursor:pointer;'
                f'font-family:var(--mono);font-size:10px;letter-spacing:.04em;color:var(--lab);'
                f'margin-top:6px;user-select:none">原条件 \u25be</summary>'
                f'<div style="margin-top:6px">{_code}</div></details>')
        else:
            _cond_cell = _code      # 翻不动 → 原样展开，不折叠
        s_rows += (f'<tr id="{anchor}" style="scroll-margin-top:16px;border-bottom:{bb}">'
                   f'<td style="padding:10px;vertical-align:top;font-weight:600;white-space:nowrap">{_name_cell}</td>'
                   f'<td style="padding:10px;vertical-align:top">{_cond_cell}</td>'
                   f'<td style="padding:10px;vertical-align:top;color:var(--mut);line-height:1.5">{_e(s.get("action",""))}</td></tr>')
    # 数据局限（顶层 data_caveats 为主，action_plan.data_caveats 兜底）
    caveats = R.get("data_caveats") or (R.get("action_plan") or {}).get("data_caveats") or []
    cav_items = ""
    for c in caveats:
        field = c.get("field", "")
        issue = c.get("issue", "")
        impact = c.get("impact", "")
        cav_items += (f'<li style="padding-left:16px;border-left:2px solid #d97706">'
                      f'<div style="font-family:var(--mono);font-size:11px;font-weight:600;color:var(--chiptx);margin-bottom:3px">{_e(field)}</div>'
                      f'<div style="font-size:12.5px;color:var(--ink2);line-height:1.55">{_e(issue)}<span style="color:var(--amb)"> {_e(impact)}</span></div></li>')
    cav_block = ""
    if cav_items:
        cav_block = (
            f'<details style="border-top:1px solid var(--ink);border-bottom:1px solid var(--ink)">'
            f'<summary style="padding:14px 2px;display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:600;color:var(--ink)">'
            f'<span>数据局限性（{len(caveats)} 条）</span><span style="font-family:var(--mono);font-size:11px;color:var(--lab)">展开 ▾</span></summary>'
            f'<div style="background:#f3f1ea;border:1px solid #fef3c7;padding:18px 20px;margin-bottom:14px">'
            f'<p style="font-size:12.5px;font-style:italic;color:#6b6b6b;margin:0 0 14px">以下字段存在数据缺陷或经 fallback 派生，相关结论需谨慎采纳。</p>'
            f'<ul style="margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:13px">{cav_items}</ul></div></details>')

    def detail_block(title, head_cols, rows, open_=False):
        head = "".join(f'<th style="text-align:left;padding:8px 10px;font-family:var(--mono);font-size:10px;font-weight:700;'
                       f'letter-spacing:.06em;text-transform:uppercase;color:#000000">{h}</th>' for h in head_cols)
        return (f'<details{" open" if open_ else ""} style="border-top:1px solid var(--ink)">'
                f'<summary style="padding:14px 2px;display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:600;color:var(--ink)">'
                f'<span>{title}</span><span style="font-family:var(--mono);font-size:11px;color:var(--lab)">展开 ▾</span></summary>'
                f'<table style="width:100%;border-collapse:collapse;font-size:12.5px;margin-bottom:12px">'
                f'<thead><tr style="border-top:1px solid var(--ink);border-bottom:1px solid var(--ink)">{head}</tr></thead>'
                f'<tbody>{rows}</tbody></table></details>')

    return (
        '<section id="fp-apx" style="margin-bottom:8px">'
        '<div style="margin-bottom:20px">'
        '<div style="font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;'
        'color:#7c2d12;font-weight:600;margin-bottom:8px">Appendix · 附录数据</div>'
        '<h2 style="font-size:27px;font-weight:600;letter-spacing:-.01em;margin:0 0 8px;color:var(--ink)">完整发现、人群包与数据局限</h2>'
        '<p style="font-size:13.5px;font-style:italic;color:var(--mut);margin:0;line-height:1.6">用于审计与下游圈人。</p></div>'
        + detail_block(f"全部诊断发现（{len(findings)} 条）", ["级别", "问题", "数据依据"], f_rows)
        + detail_block(f"可落地人群包（{len(segments)} 个）",
                       ["人群名称", "筛选条件（中文）", "建议动作"], s_rows, open_=True)
        + cav_block + '</section>'
    )


def _footer(title, cid, date) -> str:
    return (
        '<footer style="margin-top:30px;padding-top:16px;border-top:3px double var(--ink);display:flex;'
        'justify-content:space-between;font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.04em">'
        f'<span>{_e(title)} · 营销诊断报告</span><span>{_e(cid)} · {_e(date)}</span></footer>'
    )


# ══════════════════════════════════════════════════════════════════════════
# 公共函数入口（供宿主 Agent 直接调用）
# ══════════════════════════════════════════════════════════════════════════


def render_markdown(report: dict, date: str | None = None) -> str:
    """渲染 Markdown 字符串。"""
    return ReportRenderer(report, date=date)._render_markdown()


def render_html(report: dict, date: str | None = None) -> str:
    """渲染金融纸 HTML 字符串（完整内联样式 + base64 内嵌字体，零外部 CDN，自包含）。"""
    return ReportRenderer(report, date=date)._render_html()


def save_report(report: dict, output_dir: str, date: str | None = None) -> dict[str, str]:
    """落盘 JSON / Markdown / HTML 三件套，返回 `{"json","md","html"}` 路径 dict。

    HTML 为金融纸样式、零外部 CDN、自包含，适合内网/合规交付。
    """
    os.makedirs(output_dir, exist_ok=True)
    paths: dict[str, str] = {}

    json_path = os.path.join(output_dir, "diagnosis_report.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2, default=str)
    paths["json"] = json_path

    renderer = ReportRenderer(report, output_dir=output_dir, date=date)
    paths["md"] = renderer.save_markdown()
    paths["html"] = renderer.save_html()

    # crowd_rules.json：可执行人群规则一等公民产物（direction + sql_filter + estimated_size）
    # 供下游 pipeline 直接圈人，无需再从 report 反查规则、手翻 pandas→SQL
    try:
        from .crowd_translator import build_crowd_rules
        crowd_path = os.path.join(output_dir, "crowd_rules.json")
        with open(crowd_path, "w", encoding="utf-8") as f:
            json.dump(build_crowd_rules(report), f, ensure_ascii=False, indent=2)
        paths["crowd_rules"] = crowd_path
    except Exception as e:
        print(f"[render] crowd_rules.json 生成失败（不影响主报告）: {e}")
    return paths
