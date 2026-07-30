"""model_interpreter — 把 model_analysis 的高/中价值字段机械化转成 finding/segment/caveat。

覆盖 10 个字段（跳过 backend/pos_weight/n_features/overall_cvr 等纯审计字段）：

  高价值（6）：
    1. `calibration`            → finding + blind_spots（圈人阈值警告）
    2. `low_score_converted`    → finding + blind_spots（特征工程盲区）
    3. `decision_rules`         → audience_segments（lift ≥ 2 的规则）
    4. `note`                   → data_caveats（零方差剔除 / 低样本量）
    5. `stratified_auc`         → finding + blind_spots（子群拟合不足）
    6. `rule_stability`         → caveat（规则跨子群稳定性）

  中价值（4）：
    7. `score_buckets`             → finding（分桶预测 vs 实际偏离）
    8. `score_distribution`        → caveat（分数分布形态）
    9. `stratified_score_buckets`  → caveat（圈人规则在子群是否同样有效）
   10. `rule_overlap`              → caveat（圈人去重 / 触达疲劳预警）

调用：
    from .model_interpreter import interpret_model
    out = interpret_model(state["model_analysis"])
    state["findings"].extend(out["auto_findings"])
    state["audience_segments"].extend(out["auto_segments"])
    state["data_caveats"].extend(out["auto_caveats"])
    state.setdefault("action_plan", {}).setdefault("blind_spots", []).extend(out["auto_blind_spots"])

Agent 拿到这些"候选产物"后继续进行筛选 / 合并 / 润色，interpreter 只负责"机械化抽取"。
"""
from __future__ import annotations

import re
from typing import Any

# 内置阈值（model_interpreter 专用，不依赖外部阈值配置）
DEFAULTS = {
    "calibration_overconf_gap_mid":   0.05,   # max_gap > 此值且 overconfident → mid
    "calibration_overconf_gap_high":  0.15,   # > 此值 → high
    "low_score_share_mid":            0.10,   # 漏判占比 > 10% → mid
    "low_score_share_high":           0.20,   # > 20% → high
    "decision_rule_lift_min":         2.0,    # 规则 lift 阈值
    "decision_rule_sample_min":       100,    # 规则覆盖人数下限
    "stratified_auc_gap_min":         0.05,   # 子群 AUC 跨度阈值
    "rule_stability_precision_gap":   0.15,   # 规则跨子群 precision 差异阈值
    "score_bucket_gap_mid":           0.10,   # 桶级 |actual - predicted| → mid
    "score_bucket_gap_high":          0.20,   # 桶级偏离 → high
    "score_dist_top_skew_pct":        0.05,   # pct_above_0.9 > 此值 → 长尾警告
    "stratified_bucket_cvr_gap":      0.30,   # 子群同一桶 CVR 相对差异阈值
    "rule_overlap_jaccard_min":       0.50,   # 规则间 Jaccard 阈值（冗余圈人）
}


# ── AUC 质量分级阈值 ─────────────────────────────────────────────
AUC_DISCARD   = 0.50   # < 0.50：预测倒置，全部 findings 丢弃
AUC_ELEVATED  = 0.65   # ≥ 0.65：findings 可提升权重、非规则 findings 进入核心诊断

# sample_count 过滤（低样本规则降级为 blind_spot）
RULE_SAMPLE_MIN  = 100


def _auc_quality(auc: float) -> str:
    """返回 'invalid' | 'normal' | 'elevated'。"""
    if auc < AUC_DISCARD:
        return "invalid"
    if auc < AUC_ELEVATED:
        return "normal"
    return "elevated"


def interpret_model(model_analysis: dict | None,
                    thresholds: dict[str, Any] | None = None) -> dict[str, list[dict]]:
    """从 model_analysis 抽取候选 findings / segments / caveats / blind_spots。

    AUC 门控逻辑：
      - AUC < 0.50 (invalid)：全部 findings 丢弃，仅保留 note → data_caveats，
                              并写入 AUC 倒置告警。
      - 0.50 ≤ AUC < 0.65 (normal)：正常生成，渲染层按常规优先级展示。
      - AUC ≥ 0.65 (elevated)：findings 标记 model_priority_boost=True，
                              渲染层在核心诊断中提升权重；无 rule_id 的 findings
                              可作为新增问题进入诊断和行动建议。

    Returns:
        {
          "auto_findings":    list[dict],  # 包含 source/auc_quality/model_priority_boost
          "auto_segments":    list[dict],
          "auto_caveats":     list[dict],
          "auto_blind_spots": list[dict],
          "auc_quality":      str,         # "invalid" | "normal" | "elevated"
        }
    """
    out: dict[str, Any] = {
        "auto_findings":    [],
        "auto_segments":    [],
        "auto_caveats":     [],
        "auto_blind_spots": [],
        "auc_quality":      "invalid",
    }
    if not model_analysis or not isinstance(model_analysis, dict):
        return out

    auc = float(model_analysis.get("auc") or 0)
    quality = _auc_quality(auc)
    out["auc_quality"] = quality
    t = {**DEFAULTS, **(thresholds or {})}

    # ── AUC < 0.5：仅保留 note/zero-var caveats，其余全部丢弃 ──
    if quality == "invalid":
        _interpret_note(model_analysis, out)
        # 按置信区间细分两种情况
        auc_ci_high = model_analysis.get("auc_ci_high")
        try:
            ci_high = float(auc_ci_high) if auc_ci_high is not None else None
        except (TypeError, ValueError):
            ci_high = None

        if ci_high is not None and ci_high >= 0.5:
            issue = f"AUC={auc:.4f}，置信区间上界={ci_high:.4f}≥0.5，模型与随机猜测无统计差异"
            impact = (
                "当前特征集对该活动类型无预测力（可能因落地页类活动缺乏活动页内行为特征）。"
                "所有模型衍生 findings 已丢弃；建议补充活动页内行为特征（停留时长、点击位置）后重新建模。"
            )
        else:
            ci_desc = f"，置信区间上界={ci_high:.4f}<0.5" if ci_high is not None else ""
            issue = f"AUC={auc:.4f} < 0.5{ci_desc}，模型显著差于随机（预测方向倒置）"
            impact = (
                "所有模型衍生 findings 已自动丢弃，不计入诊断结果。"
                "AUC 显著低于随机疑似目标泄漏或标签定义问题，需排查特征工程。"
            )
        out["auto_caveats"].append({
            "field": "model_analysis.auc",
            "issue": issue,
            "impact": impact,
        })
        return out

    # ── AUC ≥ 0.5：正常运行所有解释器 ──
    _interpret_calibration(model_analysis, t, out)
    _interpret_low_score_converted(model_analysis, t, out)
    _interpret_decision_rules(model_analysis, t, out)
    _interpret_note(model_analysis, out)
    _interpret_stratified_auc(model_analysis, t, out)
    _interpret_rule_stability(model_analysis, t, out)
    _interpret_score_buckets(model_analysis, t, out)
    _interpret_score_distribution(model_analysis, t, out)
    _interpret_stratified_score_buckets(model_analysis, t, out)
    _interpret_rule_overlap(model_analysis, t, out)

    # ── 为每条 finding 标记来源和优先级 ──
    is_elevated = (quality == "elevated")
    for f in out["auto_findings"]:
        f["source"] = "model_interpreter"
        f["auc_quality"] = quality
        f.setdefault("rule_id", None)          # 无 rule_id = 超出 42 条规则的模型发现
        f["model_priority_boost"] = is_elevated  # True 时渲染层提升权重

    # ── 低召回率决策规则降级为 blind_spot ──
    valid_segs, low_recall_segs = [], []
    for seg in out["auto_segments"]:
        # 从 rationale 里提取 sample_count（简单启发）
        rat = seg.get("rationale", "")
        import re as _re
        m = _re.search(r"命中 ([\d,]+) 用户", rat)
        n = int(m.group(1).replace(",", "")) if m else seg.get("estimated_size", 0)
        if n >= RULE_SAMPLE_MIN:
            valid_segs.append(seg)
        else:
            out["auto_blind_spots"].append({
                "topic": f"模型规则覆盖不足（n={n}<{RULE_SAMPLE_MIN}）",
                "evidence": rat[:120],
                "recommended_probe": "扩大样本量后重新建模，或合并相邻规则提高覆盖",
            })
            low_recall_segs.append(seg)
    out["auto_segments"] = valid_segs

    return out


# ── 1. calibration: 过度自信 → 圈人阈值警告 ────────────────────


def _interpret_calibration(ma: dict, t: dict, out: dict) -> None:
    """模型校准偏差仅作内部 caveat，不生成业务 finding（model_analysis 只诊断营销活动问题）。"""
    calib = ma.get("calibration") or {}
    if not calib:
        return
    overconf = bool(calib.get("overconfident"))
    max_gap = float(calib.get("max_calibration_gap") or 0)
    if not overconf and max_gap < t["calibration_overconf_gap_mid"]:
        return
    # 仅记录为数据缺陷提示，供 synthesis 参考；不写入 auto_findings（避免在报告中显示）
    out["auto_caveats"].append({
        "field": "model.calibration",
        "issue": f"模型校准偏差较大（max_gap={max_gap:.3f}），高分段预测CVR高于实际",
        "impact": "圈人时勿直接按预测分位数划线，建议下调10-15%；决策树规则的lift数值仅供参考",
    })


# ── 2. low_score_converted: 漏判 → 特征工程盲区 ────────────────


def _interpret_low_score_converted(ma: dict, t: dict, out: dict) -> None:
    lsc = ma.get("low_score_converted") or {}
    n = int(lsc.get("n") or 0)
    if n <= 0:
        return
    # share_of_converted_pct 恒为百分数（0-100），统一除以 100 得分数。
    # （旧 `if share_pct > 1` 启发式在成单率口径下 share<1% 时会把 0.37% 误当成 37%，错判 high。）
    share_pct = float(lsc.get("share_of_converted_pct") or 0)
    share = share_pct / 100.0
    if share < t["low_score_share_mid"]:
        return
    sev = "high" if share >= t["low_score_share_high"] else "mid"
    # 取 lift 显著的特征作为"模型漏掉的信号"
    features = lsc.get("features") or {}
    notable: list[str] = []
    for name, info in features.items():
        if not isinstance(info, dict) or not info.get("significant"):
            continue
        lp = info.get("lift_pct")
        if isinstance(lp, (int, float)) and abs(lp) >= 0.5:
            notable.append(f"{name}({lp:+.0%})")
    notable_str = "、".join(notable[:4]) or "（无显著漂移特征）"

    out["auto_findings"].append({
        "id": "fnd_model_low_score_converted",
        "agent": "model_analysis",
        "signal": f"模型漏判 {n} 个真实转化用户（占转化总数 {share_pct}%）",
        "severity": sev,
        "detail": (
            f"low_score_converted.n={n}, share={share_pct}%; "
            f"该群体显著漂移特征：{notable_str}"
        ),
        "evidence_field": "model.low_score_converted",
        "metric_refs": [{"name": "low_score_share", "value": share, "n_total": n}],
    })
    out["auto_blind_spots"].append({
        "topic": "模型漏判转化用户（特征工程盲区）",
        "evidence": f"漏判 {n} 人，关键漂移特征 {notable_str}",
        "recommended_probe": "下次活动评估时把这些特征做二阶交叉或单独建分支模型",
    })


# ── 3. decision_rules: lift≥2 → audience_segments ─────────────

# 决策树规则关键特征 → 人群名短标签（用于从规则自动起业务化人群名）
_FEAT_TAG: dict[str, str] = {
    "pre_target_product_funnel_depth": "目标品类深漏斗", "pre_target_product_depth": "目标品类深漏斗",
    "pre_max_funnel_depth": "深漏斗", "pre_reached_payment": "到支付页",
    "pre_create_not_complete": "遗单", "pre_has_target_product_create": "目标品类创单",
    "pre_create_order_cnt": "多次创单", "pre_complete_order_cnt": "复购",
    "pre_mkt_product_browse_match": "品类匹配", "pre_top_interest_product": "特定兴趣品类",
    "pre_train_depth": "火车票浏览", "pre_flight_depth": "机票浏览", "pre_hotel_depth": "酒店浏览",
    "pre_mkt_touch_cnt": "高频触达", "pre_coupon_collect_cnt": "活跃领券",
    "pre_is_repurchase": "复购", "pre_has_complete_order": "有成单",
}

_CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]


def _seg_name_from_rule(rule_text: str, idx: int) -> str:
    """从决策树规则文本自动生成业务化人群名：取 2-3 个关键特征短标签拼接。"""
    tags: list[str] = []
    for feat, tag in _FEAT_TAG.items():
        if feat in rule_text and tag not in tags:
            tags.append(tag)
        if len(tags) >= 3:
            break
    if tags:
        return "·".join(tags) + "高潜人群"
    return f"模型高潜人群{_CN_NUM[idx] if idx < len(_CN_NUM) else idx + 1}"


def _interpret_decision_rules(ma: dict, t: dict, out: dict) -> None:
    rules = ma.get("decision_rules") or []
    if not rules:
        return
    lift_min = float(t["decision_rule_lift_min"])
    sample_min = int(t["decision_rule_sample_min"])
    overall_cvr = float(ma.get("overall_cvr") or 0)

    seen_names: dict[str, int] = {}
    for i, rule in enumerate(rules):
        lift = float(rule.get("lift") or 0)
        n_sample = int(rule.get("sample_count") or 0)
        if lift < lift_min or n_sample < sample_min:
            continue
        pred_cvr = float(rule.get("predicted_cvr") or 0)
        rule_text = rule.get("rule") or rule.get("rule_text") or ""
        filter_cond = _rule_to_filter(rule_text)
        # 人群名去重：同名（关键特征相同）追加「·变体N」区分
        seg_name = _seg_name_from_rule(rule_text, i)
        seen_names[seg_name] = seen_names.get(seg_name, 0) + 1
        if seen_names[seg_name] > 1:
            seg_name = f"{seg_name}·变体{seen_names[seg_name]}"
        # estimated_incremental_orders: lift提升倍数 × 覆盖人数 × (预测CVR - 基准CVR)
        estimated_incremental_orders = max(0, int(
            n_sample * (pred_cvr - overall_cvr)
        ))
        out["auto_segments"].append({
            "name": seg_name,
            "filter_conditions": filter_cond,
            "filter_conditions_sql": rule.get("rule_sql") or "",   # 可执行 Spark SQL（分类切分已 code→name 还原）
            "rationale": (
                f"决策树规则 lift={lift:.1f}× (predicted_cvr={pred_cvr:.2%}, "
                f"baseline={overall_cvr:.2%}), 命中 {n_sample:,} 用户"
            ),
            "action": "下一周期对该群体做优先级投放或预算倾斜",
            "estimated_size": n_sample,
            "baseline_cvr": overall_cvr,
            "expected_cvr_mid": pred_cvr,
            "estimated_incremental_orders": estimated_incremental_orders,
            "supporting_findings": ["fnd_model_decision_rule"],
            "source": "model_interpreter",
            "direction": "push",                       # 模型高潜人群 → 建议推送
            "finding_id": "fnd_model_decision_rule",
            "needs_polish": True,  # 机器抽取的人群，Agent 应按业务语义改名/校验筛选条件后再用
        })


_FIELD_TYPE_CACHE: dict[str, str] | None = None
_INT_FIELD_TYPES = ("count", "ordinal", "binary")   # registry 中值域为整数的字段类型
_SENTINEL_EPS = 1e-20                                # 二值特征树切分哨兵上界（约 1e-35）
_CMP_RE = re.compile(r"(\w+)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?(?:[eE]-?\d+)?)")


def _field_type(name: str) -> str | None:
    """查 feature_registry.yaml 的字段类型（count/rate/ordinal/binary/...）；查不到返回 None。"""
    global _FIELD_TYPE_CACHE
    if _FIELD_TYPE_CACHE is None:
        try:
            try:
                from .feature_loader import _load_registry
            except ImportError:
                from feature_loader import _load_registry
            _FIELD_TYPE_CACHE = {r["name"]: (r.get("type") or "") for r in _load_registry()}
        except Exception:
            _FIELD_TYPE_CACHE = {}
    return _FIELD_TYPE_CACHE.get(name) or None


def _fmt_threshold(v: float) -> str:
    """阈值 → 无科学计数法的位置计数字符串（与 model_analyst._fmt_threshold 同约定）。"""
    if v == int(v):
        return str(int(v))
    s = f"{v:.10f}".rstrip("0").rstrip(".")
    return s if float(s) != 0 else repr(v)


def _rule_to_filter(rule_text: str) -> str:
    """把决策树规则文本转 pandas 可读 filter，并把原始树阈值语义化。

    逐个比较项（字段 算子 数值）处理，字段类型查 feature_registry.yaml：
      - 哨兵阈值（<1e-20，二值切分；model_analyst 新版已在源头消化，此处兜底老 state）
        → ==0 / >=1
      - 整数域字段（type=count/ordinal/binary）的小数阈值取整；严格/非严格取整方向不同：
        >=v→ceil；>v→floor+1；<=v→floor；<v→ceil-1
      - 小数域字段（type=rate 等）阈值**原样保留**（只去科学计数法）——取整会让展示
        与实际执行的 rule_sql 语义脱节
      - registry 查不到的字段退回启发式：阈值>1 视为计数取整，否则保留
    """
    if not rule_text:
        return ""
    import math
    t = rule_text.replace(" AND ", " and ").replace(" OR ", " or ")

    def _sub(m: "re.Match[str]") -> str:
        feat, op, num = m.group(1), m.group(2), m.group(3)
        v = float(num)
        if 0 < v < _SENTINEL_EPS:  # 哨兵兜底（老 state / 外部 rule 文本）
            return f"{feat} >= 1" if op in (">", ">=") else f"{feat} == 0"
        ftype = _field_type(feat)
        int_field = (ftype in _INT_FIELD_TYPES) if ftype else None
        if v != int(v) and (int_field or (int_field is None and v > 1)):
            if op == ">=":
                op2, b = ">=", math.ceil(v)
            elif op == ">":
                op2, b = ">=", math.floor(v) + 1
            elif op == "<=":
                op2, b = "<=", math.floor(v)
            else:
                op2, b = "<=", math.ceil(v) - 1
            return f"{feat} {op2} {int(b)}"
        # 整数域边界美化：<=0 → ==0，>0 → >=1（源头哨兵转换产出的形式）
        if v == 0 and int_field:
            if op == "<=":
                return f"{feat} == 0"
            if op == ">":
                return f"{feat} >= 1"
        return f"{feat} {op} {_fmt_threshold(v)}"

    return _CMP_RE.sub(_sub, t)


# ── 4. note: 零方差 / 低样本量 → data_caveats ─────────────────


_ZERO_VAR_RE = re.compile(r"\[零方差剔除\]\s*([^/]+)")
_LOW_SAMPLE_RE = re.compile(r"\[低样本量[·•]?(\S*?)\]\s*([^/]+)?")


def _interpret_note(ma: dict, out: dict) -> None:
    note = ma.get("note") or ""
    if not note:
        return
    m = _ZERO_VAR_RE.search(note)
    if m:
        cols_str = m.group(1).strip()
        out["auto_caveats"].append({
            "field": "model_analysis.dropped_zero_var",
            "issue": "零方差列已自动剔除",
            "fallback": cols_str[:200],
            "impact": "这些字段对模型零贡献；如业务上认为有意义请补充更细颗粒",
        })
    m2 = _LOW_SAMPLE_RE.search(note)
    if m2:
        out["auto_caveats"].append({
            "field": "model_analysis.n_samples",
            "issue": f"低样本量警告：{m2.group(0)}",
            "impact": "模型 AUC 置信区间偏宽，圈人结论需配合人工复核",
        })


# ── 5. stratified_auc: 子群拟合不足 → finding + blind_spots ────


def _interpret_stratified_auc(ma: dict, t: dict, out: dict) -> None:
    sa = ma.get("stratified_auc") or {}
    overall_auc = float(ma.get("auc") or 0)
    if not sa or overall_auc <= 0:
        return
    gap_min = float(t["stratified_auc_gap_min"])
    weak_dims: list[str] = []
    for dim, vals in sa.items():
        if not isinstance(vals, dict) or not vals:
            continue
        numeric = [float(v) for v in vals.values() if isinstance(v, (int, float))]
        if len(numeric) < 2:
            continue
        gap = max(numeric) - min(numeric)
        if gap < gap_min:
            continue
        worst_val, worst_auc = min(vals.items(), key=lambda x: x[1])
        weak_dims.append(f"{dim}={worst_val} (AUC {worst_auc:.3f})")

    if not weak_dims:
        return
    # 子群拟合不足是「模型内部质量」观测（含 AUC、原始字段名），属内部 blind_spot，
    # 不作为面向运营的 user-facing finding——否则 detail "…(AUC 0.7)" 会把 ML 术语与裸字段名
    # 泄漏进报告（违反 methodology/03·08 语言规范，render lint 会报 warning）。只写 blind_spots。
    out["auto_blind_spots"].append({
        "topic": "模型对部分子群拟合不足",
        "evidence": "; ".join(weak_dims[:3]),
        "recommended_probe": "不要对这些子群直接套用全量规则；建议子群单独建模或保守圈人",
    })


# ── 6. rule_stability: 跨子群 precision 差异 → caveat ──────────


def _interpret_rule_stability(ma: dict, t: dict, out: dict) -> None:
    rs = ma.get("rule_stability") or {}
    if not rs:
        return
    gap_thr = float(t["rule_stability_precision_gap"])
    unstable: list[tuple[str, float]] = []
    for rule_text, dim_vals in rs.items():
        if not isinstance(dim_vals, dict) or not dim_vals:
            continue
        precisions = [float(v) for v in dim_vals.values() if isinstance(v, (int, float))]
        if len(precisions) < 2:
            continue
        gap = max(precisions) - min(precisions)
        if gap >= gap_thr:
            unstable.append((rule_text, gap))

    if not unstable:
        return
    unstable.sort(key=lambda x: -x[1])
    sample = "; ".join(f"{r[:40]}… (Δprec={g:.2f})" for r, g in unstable[:3])
    out["auto_caveats"].append({
        "field": "model_analysis.rule_stability",
        "issue": f"{len(unstable)} 条决策规则在子人群上 precision 差异显著",
        "impact": "跨平台/时段直接复用规则可能失效；圈人前需子群验证。示例：" + sample,
    })


# ── 7. score_buckets: 桶级 actual vs predicted 偏离 → finding ──


def _interpret_score_buckets(ma: dict, t: dict, out: dict) -> None:
    buckets = ma.get("score_buckets") or []
    if len(buckets) < 3:
        return
    gap_mid = float(t["score_bucket_gap_mid"])
    worst = None
    worst_gap = 0.0
    for b in buckets:
        if not isinstance(b, dict):
            continue
        a = float(b.get("actual_cvr") or 0)
        p = float(b.get("predicted_cvr") or 0)
        gap = abs(a - p)
        if gap > worst_gap:
            worst_gap = gap
            worst = b
    if worst is None or worst_gap < gap_mid:
        return
    bucket_label = worst.get("bucket") or worst.get("score_range") or "?"
    # 分桶偏差仅作内部 caveat，不生成业务 finding
    out["auto_caveats"].append({
        "field": "model.score_buckets",
        "issue": (
            f"分桶{bucket_label}实际CVR与预测偏差{worst_gap:.1%}，"
            f"actual={float(worst.get('actual_cvr') or 0):.3f}, "
            f"predicted={float(worst.get('predicted_cvr') or 0):.3f}"
        ),
        "impact": "模型在该分桶高估转化率，圈人时应结合实际CVR校验，不宜单纯按预测分位数圈选",
    })


# ── 8. score_distribution: 长尾/集中 → caveat ─────────────────


def _interpret_score_distribution(ma: dict, t: dict, out: dict) -> None:
    sd = ma.get("score_distribution") or {}
    if not sd:
        return
    skew = float(sd.get("skewness") or 0)
    pct_high = float(sd.get("pct_above_0_9") or sd.get("pct_above_0.9") or 0)
    pct_low = float(sd.get("pct_below_0_1") or sd.get("pct_below_0.1") or 0)
    issues = []
    if pct_high >= t["score_dist_top_skew_pct"]:
        issues.append(f"高分段（>0.9）占比 {pct_high:.1%}（n={int(pct_high*100)}%）")
    if pct_low > 0.95:
        issues.append(f"低分段（<0.1）占比 {pct_low:.1%}，几乎所有用户被打低分")
    if abs(skew) > 3.0:
        issues.append(f"分布严重偏态 skewness={skew:.2f}")
    if not issues:
        return
    out["auto_caveats"].append({
        "field": "model_analysis.score_distribution",
        "issue": "模型分数分布形态异常：" + "；".join(issues),
        "impact": "圈人阈值不应直接用模型分位数；建议结合业务 CVR 反推阈值",
    })


# ── 9. stratified_score_buckets: 子群同桶 CVR 差异 → caveat ────


def _interpret_stratified_score_buckets(ma: dict, t: dict, out: dict) -> None:
    ssb = ma.get("stratified_score_buckets") or {}
    if not ssb:
        return
    gap_thr = float(t["stratified_bucket_cvr_gap"])
    inconsistent: list[str] = []
    for dim, rows in ssb.items():
        if not isinstance(rows, list) or len(rows) < 2:
            continue
        # rows 形如 [{bucket, dim_val, cvr}, ...]
        # 按 bucket 聚合 → 同桶在不同子群的 CVR
        by_bucket: dict[str, list[tuple[str, float]]] = {}
        for r in rows:
            if not isinstance(r, dict):
                continue
            bk = str(r.get("bucket") or "?")
            cvr = r.get("cvr") or r.get("actual_cvr")
            if cvr is None:
                continue
            by_bucket.setdefault(bk, []).append((str(r.get("dim_val") or "?"), float(cvr)))
        for bk, vals in by_bucket.items():
            if len(vals) < 2:
                continue
            cvrs = [v[1] for v in vals]
            mn, mx = min(cvrs), max(cvrs)
            base = max(mx, 1e-6)
            if (mx - mn) / base >= gap_thr:
                worst = min(vals, key=lambda x: x[1])
                best = max(vals, key=lambda x: x[1])
                inconsistent.append(
                    f"{dim}@{bk}: {best[0]}={best[1]:.2%} vs {worst[0]}={worst[1]:.2%}"
                )
    if not inconsistent:
        return
    out["auto_caveats"].append({
        "field": "model_analysis.stratified_score_buckets",
        "issue": f"同分桶在子群上 CVR 差异显著（{len(inconsistent)} 处）",
        "impact": (
            "全量圈人规则在子人群可能失真。示例："
            + "; ".join(inconsistent[:3])
        ),
    })


# ── 10. rule_overlap: Jaccard 冗余 → caveat（去重圈人） ────────


def _interpret_rule_overlap(ma: dict, t: dict, out: dict) -> None:
    ro = ma.get("rule_overlap") or {}
    if not ro:
        return
    jaccard_min = float(t["rule_overlap_jaccard_min"])
    # 兼容两种结构：matrix dict-of-dict 或 redundant pairs 数组
    redundant_pairs: list[tuple[str, str, float]] = []
    matrix = ro.get("jaccard_matrix") or ro.get("matrix") or {}
    if isinstance(matrix, dict):
        seen = set()
        for ra, row in matrix.items():
            if not isinstance(row, dict):
                continue
            for rb, val in row.items():
                if ra == rb:
                    continue
                key = tuple(sorted([str(ra), str(rb)]))
                if key in seen:
                    continue
                seen.add(key)
                try:
                    j = float(val)
                except (TypeError, ValueError):
                    continue
                if j >= jaccard_min:
                    redundant_pairs.append((str(ra)[:30], str(rb)[:30], j))

    # 兼容 explicit 列表
    for item in ro.get("redundant") or []:
        if isinstance(item, dict):
            redundant_pairs.append((
                str(item.get("rule_a", ""))[:30],
                str(item.get("rule_b", ""))[:30],
                float(item.get("jaccard") or 0),
            ))

    if not redundant_pairs:
        return
    redundant_pairs.sort(key=lambda x: -x[2])
    sample = "; ".join(f"({a} & {b}) J={j:.2f}" for a, b, j in redundant_pairs[:3])
    out["auto_caveats"].append({
        "field": "model_analysis.rule_overlap",
        "issue": f"{len(redundant_pairs)} 对决策规则重叠度高（Jaccard ≥ {jaccard_min:.2f}）",
        "impact": "若多个 segment 直接合并触达，同一用户可能被多次推送 → 体验疲劳；建议去重或分时段。示例：" + sample,
    })


# ── 公开常量便于测试 ─────────────────────────────────────────────


__all__ = ["interpret_model", "DEFAULTS"]
