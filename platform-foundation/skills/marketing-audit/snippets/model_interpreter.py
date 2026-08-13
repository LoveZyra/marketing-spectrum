"""model_interpreter — 把 model_analysis 的高/中价值字段机械化转成 finding/segment/caveat。

覆盖 10 个字段（跳过 backend/pos_weight/n_features/overall_cvr 等纯审计字段）：

  高价值（6）：
    1. `calibration`            → finding + blind_spots（圈人阈值警告）
    2. `low_score_converted`    → finding + blind_spots（特征工程盲区）
    3. `decision_rules`         → audience_segments（lift ≥ 2 的规则,按全量口径 lift 取效果最好的 top3）
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
    "decision_rule_top_n":            3,      # 报告只保留预测效果最好的前 N 条模型规则(按全量口径 lift 排序,同 lift 取覆盖大者)
    "decision_rule_max_jaccard":      0.5,    # 选人群时与已选规则命中人群的 Jaccard ≥ 此值即视为重复,跳过
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
    sampled = bool(calib.get("sampled_prior")) or bool(ma.get("sampled"))
    if sampled:
        # fix19:训练采样(正样本全保留)把先验抬高,概率绝对值本就不代表线上先验,
        # 校准差是采样口径内的现象,不当成模型缺陷吵;按分位圈人不受影响。
        out["auto_caveats"].append({
            "field": "model.calibration",
            "issue": f"校准差 max_gap={max_gap:.3f} 系训练采样先验口径下的读数(正样本全保留训练)",
            "impact": "按预测分位数圈人不受影响;勿把预测概率当线上绝对转化率使用,"
                      "增量估算已改用按采样率外推的真实CVR(precision_population)",
        })
    else:
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


# ── 3. decision_rules: lift≥2 → audience_segments(效果最好 top3)──

# 决策树规则关键特征 → 人群名短标签。fix20:值改为 (高值侧, 低值侧) 二元组 ——
# 同一字段切在高侧和低侧是两类完全相反的人群,原来一律用同一个词会起出反语义的名字
# (`pre_max_funnel_depth <= 1` 也被叫成「深漏斗高潜」)。写成单字符串的条目按
# 「高侧用它、低侧加『低』前缀」兼容。二值字段用 (有X, 无X) 语义。
_FEAT_TAG: dict[str, tuple] = {
    # 漏斗 / 主流程
    "pre_target_product_funnel_depth": ("目标品类深漏斗", "目标品类浅漏斗"),
    "pre_target_product_depth": ("目标品类深漏斗", "目标品类浅漏斗"),
    "pre_max_funnel_depth": ("深漏斗", "浅漏斗"),
    "pre_mainflow_event_cnt": ("主流程活跃", "无主流程"),
    "pre_last_mainflow_to_touch_min": ("触达距行为久", "近期主流程"),
    "pre_reached_payment": ("到支付页", "未到支付页"),
    "pre_reached_booking": ("到填写页", "未到填写页"),
    "pre_back_to_booking_cnt": ("回填写页", "未回填写页"),
    "pre_skip_detail_flag": ("跳过详情", "看过详情"),
    # 订单 / 转化
    "pre_create_not_complete": ("遗单", "无遗单"),
    "pre_has_target_product_create": ("目标品类创单", "无目标品类创单"),
    "pre_create_order_cnt": ("多次创单", "少创单"),
    "pre_complete_order_cnt": ("复购", "少成单"),
    "pre_has_complete_order": ("有成单", "无成单"),
    "pre_is_repurchase": ("复购", "首购"),
    "gmv": ("高客单价", "低客单价"),
    # 浏览 / 兴趣
    "pre_mkt_product_browse_match": ("品类匹配", "品类不匹配"),
    "pre_top_interest_product": ("特定兴趣品类", "无偏好品类"),
    "pre_product_category_cnt": ("多品类浏览", "窄品类浏览"),
    "insite_product_cnt": ("站内多品类", "站内窄品类"),
    "pre_browse_cnt": ("高频浏览", "低频浏览"),
    "pre_search_cnt": ("多次搜索", "无搜索"),
    "pre_train_depth": ("火车票浏览", "未看火车票"),
    "pre_flight_depth": ("机票浏览", "未看机票"),
    "pre_hotel_depth": ("酒店浏览", "未看酒店"),
    "pre_tile_area_exposed": ("曝光瓷片区", "未曝光瓷片区"),
    # 营销触达
    "pre_mkt_touch_cnt": ("高频触达", "低频触达"),
    "activity_touch_cnt": ("高频触达", "低频触达"),
    "pre_mkt_channel_cnt": ("多渠道触达", "单渠道触达"),
    "pre_is_marketing_first": ("营销首触", "自然进入"),
    "pre_has_mkt_click": ("点过营销", "未点营销"),
    "pre_min_mkt_response_sec": ("响应慢", "响应快"),
    # 价格敏感
    "pre_coupon_collect_cnt": ("活跃领券", "不领券"),
    "pre_has_coupon": ("持券", "无券"),
    "serialid_bonus": ("促销偏好高", "促销偏好低"),
    "pre_has_blackwhale": ("黑鲸会员", "非黑鲸"),
    # 平台行为
    "pre_events_per_hour": ("高频活跃", "低频活跃"),
    "pre_is_dormant_user": ("沉睡用户", "活跃用户"),
    "pre_viewed_member_assets": ("看过权益", "未看权益"),
}

_CN_NUM = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十"]

# 条件解析：数值比较 | 分类 in/not in（fix19 起规则文本可能含分类子句）
_COND_RE = re.compile(
    r"(\w+)\s*(>=|<=|==|!=|>|<)\s*(-?\d+(?:\.\d+)?(?:[eE]-?\d+)?)"
    r"|(\w+)\s+(not in|in)\s+\[([^\]]*)\]"
)
# `==`/`!=` 只出现在 filter_conditions(pandas 形态)里,rule_text 用不到;
# 但命名两边都要能吃,所以按"值即方向"归一:==0/!=1 归低侧,==1/!=0 归高侧。
_EQ_OPS = ("==", "!=")
_DESC_CACHE: "dict[str, str] | None" = None
_MAX_NAME_LEN = 20          # 人群名长度上限（报告表格一行放得下）


def _parse_conds(rule_text: str) -> list[tuple]:
    """规则文本 → [(feat, op, val)]，保持根→叶的书写顺序。

    op ∈ {'>', '>=', '<', '<=', 'in', 'not in'}；数值 op 的 val 为 float，
    分类 op 的 val 为类别名列表。
    """
    out: list[tuple] = []
    for m in _COND_RE.finditer(rule_text or ""):
        if m.group(1):
            try:
                out.append((m.group(1), m.group(2), float(m.group(3))))
            except ValueError:
                continue
        elif m.group(4):
            vals = [v.strip() for v in (m.group(6) or "").split(",") if v.strip()]
            out.append((m.group(4), m.group(5), vals))
    return out


def _feat_desc(name: str) -> str:
    """feature_registry.yaml 的中文描述；查不到返回空串。"""
    global _DESC_CACHE
    if _DESC_CACHE is None:
        try:
            try:
                from .feature_loader import _load_registry
            except ImportError:
                from feature_loader import _load_registry
            _DESC_CACHE = {r["name"]: (r.get("description") or "") for r in _load_registry()}
        except Exception:
            _DESC_CACHE = {}
    return _DESC_CACHE.get(name) or ""


_DESC_STRIP = re.compile(r"[（(].*?[）)]|^(?:近\d+[年月天日]|当日|历史上?|最近一次|是否|用户)")
_DESC_TAIL = re.compile(r"(不同品类数|品类数|次数|数量|时间差|占比|阶段|标记|标志)$")
_DIR_AFFIX = re.compile(r"^(?:高|低|多|少|有|无|未|深|浅)|(?:高|低|多|少)$")


def _tag_from_desc(name: str) -> str:
    """registry 描述 → ≤6 字短标签（第二级兜底）。"""
    d = _feat_desc(name)
    if not d:
        return ""
    d = _DESC_STRIP.sub("", d).split("，")[0].split(",")[0].strip()
    m = _DESC_TAIL.search(d)
    if m and len(d) > 6:                 # 长描述取尾部核心名词（中文核心词多在后段）
        d = m.group(0)
    return d[:6]


def _neutral_tag(feat: str) -> str:
    """字段的**中性**短标签（不带高/低方向）——分类条件用，方向由类别值自己表达。"""
    base = _FEAT_TAG.get(feat)
    if base:
        head = base[0] if isinstance(base, tuple) else base
        stripped = _DIR_AFFIX.sub("", head)
        if stripped:
            return stripped[:6]
    return (_tag_from_desc(feat) or _humanize_field(feat))[:6]


def _humanize_field(name: str) -> str:
    """字段名 → 可读短串（第三级兜底，保证任何字段都能起出可区分的名字）。"""
    s = re.sub(r"^pre_", "", name or "")
    s = re.sub(r"_(cnt|num|flag|min|sec|rate|amt)$", "", s)
    return s.replace("_", "")[:12] or (name or "特征")


def _cond_tag(feat: str, op, val) -> str:
    """单个条件 → 带方向的短标签。"""
    if op in ("in", "not in"):
        # 分类条件:方向由类别值本身表达,字段用中性词,值直接进名字(信息量远高于字段名)
        vals = [str(v) for v in (val if isinstance(val, list) else [val])]
        head = _neutral_tag(feat)
        neg = "非" if op == "not in" else ""
        if not re.search(r"[一-鿿]", head):
            # 字段没有中文标签(registry 也查不到):英文字段名不如类别值可读,直接用值
            return (neg + "/".join(vals[:2]) + ("等" if len(vals) > 2 else ""))[:14]
        shown = "/".join(vals[:2]) + ("等" if len(vals) > 2 else "")
        if len(head) + len(shown) > 10:   # 太长时只留第一个值,不做半个词的截断
            shown = vals[0] + ("等" if len(vals) > 1 else "")
        return (neg + f"{head}:{shown}")[:14]
    if op in _EQ_OPS:                     # ==/!= 按"值即方向"归一(见 _EQ_OPS 注释)
        try:
            high = (float(val) != 0) if op == "==" else (float(val) == 0)
        except (TypeError, ValueError):
            high = op == "=="
    else:
        high = op in (">", ">=")
    base = _FEAT_TAG.get(feat)
    if base:
        if isinstance(base, tuple):
            return base[0] if high else base[1]
        return base if high else "低" + base
    tag = _tag_from_desc(feat) or _humanize_field(feat)
    try:                                  # 二值字段的 0/1 切分用有/无更自然
        if float(val) in (0.0, 1.0) and _field_type(feat) == "binary":
            return ("有" if high else "无") + tag
    except (TypeError, ValueError):
        pass
    return ("高" if high else "低") + tag


def _seg_name_from_rule(rule_text: str, idx: int) -> str:
    """单条规则起名（无对照组时的退化版本，保留供外部/老调用方使用）。"""
    return _build_seg_names([rule_text], [idx])[0]


def _build_seg_names(rule_texts: list[str], idxs: "list[int] | None" = None) -> list[str]:
    """一组规则一起起名 —— fix20 的核心改动。

    原实现从一张 17 字段固定表里做子串匹配，命中不到就退化成「模型高潜人群一/二」，
    而同一批 top 规则往往共享同一个高频特征（如 pre_max_funnel_depth），于是三条
    规则全叫「深漏斗高潜人群」，只能靠 ·变体N 区分，名字零信息量。

    改成**按区分度命名**：
      1. 统计各字段在这组规则里的出现次数；只在本条出现的是「独有条件」；
      2. 名字主体取本条最多 2 个独有条件的带方向标签（无独有条件时，取与其它规则
         阈值不同的共有条件并把阈值写进名字）；
      3. 共有条件挑一个作收尾词（保留人群的共性语义，如「深漏斗」）；
      4. 标签三级兜底：_FEAT_TAG 精选表 → registry 中文描述 → 字段名可读化，
         保证任何字段都能起出可区分的名字；
      5. 全部失败才退回「模型高潜人群N」。
    结果确定性：只依赖规则文本与其顺序，同一份数据重跑必然同名（人群名是圈人锚点）。
    """
    idxs = idxs if idxs is not None else list(range(len(rule_texts)))
    conds = [_parse_conds(t) for t in rule_texts]
    freq: dict[str, int] = {}
    for cs in conds:
        for feat in {c[0] for c in cs}:
            freq[feat] = freq.get(feat, 0) + 1

    names: list[str] = []
    for k, cs in enumerate(conds):
        uniq = [c for c in cs if freq.get(c[0], 0) == 1]
        shared = [c for c in cs if freq.get(c[0], 0) > 1]
        tags = [_cond_tag(*c) for c in uniq[:2]]
        used_feats = {c[0] for c in uniq[:2]}
        if not tags and shared:
            # 全是共有字段：找与其它规则"取值不同"的那个来命名。
            # 优先看标签是否已能区分（如 深漏斗 vs 浅漏斗、持券 vs 无券）——能区分就不加
            # 阈值,否则会写出「持券≥0…」这种噪声;只有标签也撞了(同方向、只差阈值)才补阈值。
            o_tags = [{c[0]: _cond_tag(*c) for c in conds[j]}
                      for j in range(len(conds)) if j != k]
            o_vals = [{c[0]: (c[1], str(c[2])) for c in conds[j]}
                      for j in range(len(conds)) if j != k]
            for c in shared:
                my_tag = _cond_tag(*c)
                if any(o.get(c[0], my_tag) != my_tag for o in o_tags):
                    tags = [my_tag]                  # 标签本身已能区分
                    used_feats.add(c[0])
                    break
            if not tags:
                mine_of = lambda c: (c[1], str(c[2]))
                for c in shared:
                    if any(o.get(c[0], mine_of(c)) != mine_of(c) for o in o_vals):
                        tag = _cond_tag(*c)
                        if not isinstance(c[2], list):   # 数值:补阈值;分类:值已在标签里
                            op = "≥" if c[1] in (">", ">=") else "≤"
                            tag = f"{tag}{op}{_fmt_threshold(float(c[2]))}"
                        tags = [tag]
                        used_feats.add(c[0])
                        break
        suffix = ""
        for c in shared:
            # 收尾词必须换一个字段:同字段再来一次会写出「深漏斗≥2.5深漏斗人群」
            if c[0] in used_feats:
                continue
            t = _cond_tag(*c)
            if t and t not in tags:
                suffix = t
                break
        if not tags and not suffix:
            names.append(f"模型高潜人群{_CN_NUM[k] if k < len(_CN_NUM) else k + 1}")
            continue
        name = "·".join(tags) + suffix + "人群"
        if len(name) > _MAX_NAME_LEN:                  # 超长先砍收尾词，再砍第二个标签
            name = "·".join(tags) + "人群"
            if len(name) > _MAX_NAME_LEN and len(tags) > 1:
                name = tags[0] + "人群"
        names.append(name[:_MAX_NAME_LEN])
    return _disambiguate_names(names, conds)


def _disambiguate_names(names: list[str], conds: list) -> list[str]:
    """撞名后处理：给同名的规则补一个"组内取值不同"的条件，直到名字唯一。

    命名主逻辑按"独有字段"起名，但两条规则字段集完全相同、只差阈值时（决策树很常见，
    如 insite_product_cnt>4.5 vs >3.5）仍会撞。此时在名字里补上那个区分条件的阈值 ——
    这比退回「·变体2」有信息量得多（变体N 只是编号，运营看不出两批人差在哪）。
    """
    dup: dict = {}
    for i, n in enumerate(names):
        dup.setdefault(n, []).append(i)
    for n, idxs in dup.items():
        if len(idxs) < 2:
            continue
        for k in idxs:
            mine = {c[0]: (c[1], str(c[2])) for c in conds[k]}
            others = [{c[0]: (c[1], str(c[2])) for c in conds[j]} for j in idxs if j != k]
            for c in conds[k]:
                if all(o.get(c[0]) != mine[c[0]] for o in others):
                    # 优先补"区分条件的标签"(如 ·高x2),它有业务含义;
                    # 标签已经在名字里(同字段同方向、只差阈值)才退而补阈值。
                    tag = _cond_tag(*c)
                    if tag and tag not in n:
                        extra = "·" + tag
                    elif isinstance(c[2], list):
                        extra = "·" + "/".join(str(x) for x in c[2][:2])
                    else:
                        op = "≥" if c[1] in (">", ">=") else "≤"
                        extra = f"{op}{_fmt_threshold(float(c[2]))}"
                    base = n[:-2] if n.endswith("人群") else n
                    names[k] = (base + extra + "人群")[:_MAX_NAME_LEN + 6]
                    break
    return names


def _dedup_by_overlap(qualified: list, ma: dict, max_jac: float, top_n: int) -> tuple:
    """按命中人群重叠度贪心选出至多 top_n 条互补规则。

    重叠度来自 model_analyst 的 O28(`rule_overlap.pairs`,以 decision_rules 下标为键,
    真实掩码算出来的 Jaccard)。拿不到数据(老 state / 掩码解析失败)就原样返回前 top_n 条 ——
    不猜、不用规则文本近似判重,宁可退回 fix19 行为。
    返回 (选中列表, 被跳过明细)。
    """
    pairs = ((ma.get("rule_overlap") or {}).get("pairs")) or []
    if not pairs:
        return qualified[:top_n], []
    jac: dict = {}
    for p in pairs:
        try:
            i, j, v = int(p["i"]), int(p["j"]), float(p["jaccard"])
        except (KeyError, TypeError, ValueError):
            continue
        jac[(i, j)] = v
        jac[(j, i)] = v
    picked: list = []
    dropped: list = []
    for item in qualified:
        if len(picked) >= top_n:
            break
        ri = item[2]
        hit = None
        for kept in picked:
            v = jac.get((ri, kept[2]))
            if v is not None and v >= max_jac:
                hit = (kept, v)
                break
        if hit is None:
            picked.append(item)
        else:
            kept, v = hit
            dropped.append({
                "jaccard": v,
                "rule": (item[3].get("rule") or item[3].get("rule_text") or ""),
                "kept": (kept[3].get("rule") or kept[3].get("rule_text") or ""),
            })
    return picked, dropped


def _interpret_decision_rules(ma: dict, t: dict, out: dict) -> None:
    rules = ma.get("decision_rules") or []
    if not rules:
        return
    lift_min = float(t["decision_rule_lift_min"])
    sample_min = int(t["decision_rule_sample_min"])
    top_n = int(t["decision_rule_top_n"])
    # fix19:增量估算用全量真实 CVR(训练采样时 overall_cvr 是采样世界的 30% 级口径,
    # 直接参与增量计算会整体错位);未采样时 true_overall_cvr == overall_cvr。
    overall_cvr = float(ma.get("true_overall_cvr") or ma.get("overall_cvr") or 0)

    # 第一遍:过质量门槛(lift≥lift_min 且覆盖≥sample_min)
    qualified: list[tuple[float, int, int, dict]] = []
    for ri, rule in enumerate(rules):
        # fix19:优先用全量口径的 lift(采样世界的 lift 分母是被抬高的先验)
        lift = float(rule.get("lift_population") or rule.get("lift") or 0)
        n_sample = int(rule.get("sample_count") or 0)   # fix19 起已是全量外推值
        if lift < lift_min or n_sample < sample_min:
            continue
        qualified.append((lift, n_sample, ri, rule))
    # fix19(top_n):报告只保留预测效果最好的前 N 条 —— 按真实口径 lift 降序
    # (同 lift 取覆盖人数大者;不用 predicted_cvr,它带采样先验+类权重双重扭曲)。
    # 全量规则仍完整保留在 state["model_analysis"]["decision_rules"] 可审计。
    qualified.sort(key=lambda x: (x[0], x[1]), reverse=True)
    # fix20:按人群覆盖去冗后再取 top_n —— 决策树常给出只差一个阈值的近重复规则
    # (实测 top3 里两条只差 insite_product_cnt>4.5 vs >3.5,Jaccard>0.9,其实是同一批人),
    # 不去冗会让 top_n 名额被同一批人占掉两个,报告显示三个人群、圈人 OR 起来只有两批。
    # 贪心:按 lift 降序取,与已选任一条 Jaccard≥阈值就跳过,继续往下补足 top_n。
    qualified, dropped = _dedup_by_overlap(qualified, ma, float(t["decision_rule_max_jaccard"]),
                                           top_n)
    for d in dropped:
        out["auto_blind_spots"].append({
            "topic": "模型规则去冗:与已选人群高度重叠(Jaccard={:.2f})未纳入".format(d["jaccard"]),
            "evidence": "被跳过:{} | 已选:{}".format(d["rule"][:80], d["kept"][:80]),
            "recommended_probe": "如需更多互补人群,调低 decision_rule_max_jaccard 或放宽 lift 门槛",
        })

    # fix20:一组规则一起起名(按区分度),不再逐条从固定表碰运气
    seg_names = _build_seg_names([(r.get("rule") or r.get("rule_text") or "")
                                  for (_l, _n, _ri, r) in qualified])

    seen_names: dict[str, int] = {}
    for i, (lift, n_sample, _ri, rule) in enumerate(qualified):
        pred_cvr = float(rule.get("predicted_cvr") or 0)
        rule_text = rule.get("rule") or rule.get("rule_text") or ""
        filter_cond = _rule_to_filter(rule_text)
        # 人群名去重：同名（关键特征相同）追加「·变体N」区分
        seg_name = seg_names[i] if i < len(seg_names) else _seg_name_from_rule(rule_text, i)
        # ·变体N 仅作最后防线:fix20 的按区分度命名正常不会撞名,撞了说明两条规则
        # 条件集完全相同(那本该被去重/去冗拦掉),留个后缀保证人群名唯一(圈人锚点)
        seen_names[seg_name] = seen_names.get(seg_name, 0) + 1
        if seen_names[seg_name] > 1:
            seg_name = f"{seg_name}·变体{seen_names[seg_name]}"
        # estimated_incremental_orders: 覆盖人数 × (人群真实CVR - 基准CVR)
        # fix19:人群 CVR 优先用验证集实测并按采样率无偏外推的 precision_population
        # (predicted_cvr 是采样先验+类权重双重扭曲下的概率,不可当绝对值用)。
        cvr_for_inc = float(rule.get("precision_population") or rule.get("precision")
                            or rule.get("predicted_cvr") or 0)
        estimated_incremental_orders = max(0, int(
            n_sample * (cvr_for_inc - overall_cvr)
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
# 树切分点「刚好大于 0」的哨兵上界。
# 2026-08-12(fix23)：由 1e-20 上调到 1e-6 —— 实际切分点会落在 1e-10 这类量级，
# 老门槛拦不住，于是渲染成 `> 0.0000000001` 进了报告与 sql_filter。
# 依据（feature_registry 实证）：全表仅 4 个 rate 型 + 2 个金额型字段可能非整数，
# 最小可表示非零值 ≈ 3e-3（促销占比 1/365）；(0, 1e-6) 内不存在任何真实取值，
# 落在那里的切分点必然是树内部产物。门槛比最小真实值仍保守 1000 倍，
# 且对真实数据**选中的行完全不变**（`x > 1e-10` ≡ `x > 0`）。
_SENTINEL_EPS = 1e-6   # 与 model_analyst 同一约定
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


_MAX_DECIMALS = 4   # 阈值最多保留 4 位小数（与 model_analyst._MAX_DECIMALS 同一约定）


def _fmt_threshold(v: float) -> str:
    """阈值 → 无科学计数法、最多 4 位小数的字符串（与 model_analyst._fmt_threshold 同约定）。

    2026-08-07：不出科学计数法 + 最多 4 位小数；只有 4 位会把值抹成 0 的极小阈值
    （3e-05 这类）才继续加位数，取第一个非零写法。详见 model_analyst 同名函数注释。
    """
    if v == int(v):
        return str(int(v))
    if abs(v) < _SENTINEL_EPS:
        # 哨兵区间直接归零：不能靠"第 N 位能否表示出非零"来判，
        # 9.9e-7 在第 6 位会进位成 0.000001，看着非零其实仍在哨兵区间内。
        return "0"
    s = f"{v:.{_MAX_DECIMALS}f}".rstrip("0").rstrip(".")
    if s and float(s) != 0:
        return s
    for nd in (5, 6):   # 极小阈值：最多再加到 6 位；仍为 0 说明它在哨兵区间，写 0
        s = f"{v:.{nd}f}".rstrip("0").rstrip(".")
        if s and float(s) != 0:
            return s
    # 6 位仍表示不出非零 ⇒ |v| < 1e-6 ⇒ 哨兵区间（见 _SENTINEL_EPS 推导）。
    # 老实现会一路加到 40 位，产出 `0.0000000001` 这种既不可读、业务上也等价于 0 的串。
    return "0"


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
