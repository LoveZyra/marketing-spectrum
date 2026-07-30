"""draft_builder — 从 compute-thresholds 产物自动装配 state_full 骨架。

定位：把原本由宿主 Agent 手写的 Step 3（findings/segments/narratives/actions）
变成"自动草拟 + Agent 润色"。草拟结果满足：
  - 覆盖全部 effective_signal 主题组 → self_critique.signal_coverage 几乎不报漏诊
  - 每个核心问题含 typical_case、可画图指标、对应行动 → lint_report_completeness 通过
  - headline / problem_rank / target_audiences 自洽 → 直接可 render

所有自动文案标 `_draft: True`，宿主 Agent 应润色 signal/detail/narrative/title 后去除标记，
并把 `_stage` 置为 "full"。纯确定性，不依赖 LLM。
"""
from __future__ import annotations

from typing import Any

# 主题合并组数据单一来源：self_critique（对齐 methodology/08 关联规则合并原则）
from .self_critique import _COVERAGE_GROUPS

# rule_id → case_pool 模式（typical_case 选取）。覆盖全部 42 条规则，确保每条问题的
# 典型案例都来自"与该问题定义最一致"的人群（fit_fn 再在该人群内选最典型用户）。
_RULE_CASE_PATTERN: dict[int, str] = {
    # 内容匹配：品类错配 / 推送零浏览品类 / 跨品类比价
    11: "category_mismatch", 43: "category_mismatch", 23: "cross_category",
    # 未进主流程 / 低意向 / 僵尸 / 低质量人群 / 时机错配（低参与）/ 伪实时配置
    1: "no_mainflow", 5: "no_mainflow", 27: "no_mainflow",
    4: "no_mainflow", 6: "no_mainflow", 44: "no_mainflow",
    # 反复营销骚扰 / 频次疲劳 / 多渠道冲突 / 活动堆叠 / 弹屏过多 / 创单前营销过多
    2: "marketing_fatigue", 3: "marketing_fatigue", 20: "marketing_fatigue",
    33: "marketing_fatigue", 34: "marketing_fatigue", 35: "marketing_fatigue",
    37: "marketing_fatigue", 38: "marketing_fatigue",
    # 创单未付/促付类（is_converted=1 & is_paid=0 或有未付创单人群）用 created_not_paid 案例
    16: "created_not_paid", 21: "created_not_paid",
    25: "created_not_paid", 41: "created_not_paid",
    # 成单后被打扰（已成单 + 短间隔强渠道）用 post_order_disturb 案例
    7: "post_order_disturb",
    # 高意向深漏斗未转化 / 关键页打断 / 填写页打断
    15: "high_intent_unconverted", 17: "high_intent_unconverted",
    39: "high_intent_unconverted",
    # 漏斗倒退（含营销干扰支付）
    18: "funnel_regression", 24: "funnel_regression",
    # 自然/高频转化、正向信号（红包平台不符为正向）
    19: "high_cvr_positive", 40: "high_cvr_positive", 42: "high_cvr_positive",
    # 站内外衔接类规则用 ads_mismatch 案例，时序明确呈现"站外广告品类→站内承接品类不一致"
    12: "ads_mismatch", 13: "ads_mismatch", 14: "ads_mismatch",
}

# rule_id → 候选人群筛选字段与阈值方向（用于自动生成 audience_segment）
_RULE_SEGMENT_FIELD: dict[int, tuple[str, str]] = {
    11: ("pre_mkt_product_browse_match", "==0"),
    43: ("pre_target_product_visit_cnt", "==0"),
    1: ("pre_mainflow_event_cnt", "<=1"), 27: ("pre_target_product_depth", "<=1"),
    20: ("pre_mkt_touch_cnt", ">=N"), 2: ("activity_touch_cnt", ">=N"),
    21: ("is_converted==1 and is_paid", "==0"), 41: ("is_converted==1 and is_paid", "==0"),
    23: ("pre_train_depth", ">=1"), 12: ("insite_multi_channel_match_flag", "==0"),
}

# rule_id → 业务化人群名（避免出现「问题人群·41」这类暴露规则号的草稿名）；
# 未列出的规则由 `规则中文名 + 人群` 自动派生，故全量规则都有可读人群名。
_RULE_SEGMENT_NAME: dict[int, str] = {
    # 内容匹配
    11: "品类错配人群", 43: "目标品类零浏览人群", 23: "跨品类比价人群",
    # 触达质量 / 低意向
    1: "无主流程低意向人群", 5: "僵尸沉默人群", 27: "低意向待激活人群",
    3: "弹屏打扰人群", 4: "低质量人群",
    # 站内外衔接
    12: "站内多渠道品类不一致人群", 13: "站内外承接错位人群", 14: "站外无承接人群",
    # 频次 / 疲劳
    2: "当日高频触达人群", 20: "过度营销疲劳人群", 37: "跨渠道高频疲劳人群",
    33: "创单前营销过多人群", 34: "多渠道冲突人群", 35: "弹屏过多人群", 38: "活动堆叠人群",
    # 创单未付 / 促付
    16: "弹屏打断支付人群", 21: "创单未付待促付人群",
    25: "多次创单未付人群", 41: "创单未付待促付人群",
    # 成单后打扰
    7: "成单后误触人群",
    # 关键页打断 / 漏斗
    15: "详情页打断人群", 17: "填写页打断人群", 18: "营销干扰支付人群",
    24: "漏斗倒退人群", 39: "弹屏打扰填写人群",
    # 时机匹配
    6: "时段错配人群", 44: "伪实时配置人群",
    # 正向 / 复购
    40: "高频复购人群",
}


def _g(rid: int) -> frozenset:
    for grp in _COVERAGE_GROUPS:
        if rid in grp:
            return frozenset(grp)
    return frozenset({rid})


def _num(v):
    try:
        f = float(v)
        return f if f == f else None  # NaN guard
    except (TypeError, ValueError):
        return None


def _mref(f: dict, name: str):
    return next((m.get("value") for m in f.get("metric_refs", []) if m.get("name") == name), None)


def _rule_name(f: dict) -> str:
    """从 draft finding 的 signal 还原规则中文名（signal 以「名称：」或「名称（正向…」开头）。"""
    sig = f.get("signal", "")
    for sep in ("：", "（", ":"):
        if sep in sig:
            return sig.split(sep)[0].strip()
    return sig[:8]


def build_draft(state: dict[str, Any], top_findings: int = 5,
                max_problems: int = 4) -> dict[str, Any]:
    """原地装配 state 的 findings/segments/narratives/action_plan 骨架，返回同一 state。"""
    rule_summary = (state.get("data_overview") or {}).get("diagnostic_rules_summary") or []
    thresholds = state.get("adaptive_thresholds") or {}
    # 展示/判定主口径：默认成单率（is_paid）；compute-thresholds 已写入 state["_cvr_col"]
    cvr_label = "成单率" if state.get("_cvr_col", "is_paid") == "is_paid" else "创单率"
    case_pool = state.get("case_pool") or {}
    conv = (state.get("data_overview") or {}).get("conversion_summary") or {}
    total_users = int(_num(conv.get("total_users")) or 0)

    # ── 1) findings：每个 effective_signal 主题组取分最高的一条，保证覆盖 ──
    eff = [r for r in rule_summary if r.get("effective_signal")]
    by_group: dict[frozenset, dict] = {}
    for r in eff:
        rid = r.get("rule_id")
        if rid is None:
            continue
        grp = _g(int(rid))
        cur = by_group.get(grp)
        if cur is None or (r.get("_score") or 0) > (cur.get("_score") or 0):
            by_group[grp] = r
    grouped = sorted(by_group.values(), key=lambda r: -(r.get("_score") or 0))

    drafted: list[dict] = []
    for r in grouped:
        drafted.append(_finding_from_rule(r, thresholds, cvr_label))

    # 正向阈值机会（TOP 区分度，无 rule 归属）：取最强 1 条正向 split
    pos = _top_positive_threshold(thresholds, exclude_fields={
        _RULE_SEGMENT_FIELD.get(int(r["rule_id"]), ("", ""))[0] for r in grouped if r.get("rule_id")
    }, cvr_label=cvr_label)
    if pos:
        drafted.append(pos)

    # 创单未付（促付）型规则：触发组创单率≈100% 但成单率低于对照（被 effective_signal 以定义性排除）。
    # 成单口径下这类规则成单率=0% 属定义性，故用「创单率(create_triggered)≈1 且成单更差」识别，
    # 重述为创单→支付漏损（促付）问题，取触发人数最多的最多 2 条前置到 findings。
    def _is_leak_row(r: dict) -> bool:
        c = _num(r.get("create_triggered"))
        pt, pn = _num(r.get("cvr_triggered")), _num(r.get("cvr_not_triggered"))
        return bool((r.get("is_leakage")) or (
            c is not None and c >= 0.99 and pt is not None and pn is not None and pt < pn))
    leak_rules = sorted(
        [r for r in rule_summary
         if _is_leak_row(r) and (r.get("trigger_cnt") or 0) >= 100
         and not r.get("is_positive_signal")],
        key=lambda r: -(r.get("trigger_cnt") or 0),
    )[:2]
    drafted = [_finding_from_rule(r, thresholds, cvr_label) for r in leak_rules] + drafted

    # 保留 prepare 阶段 model_interpreter 已产出的 findings（带 evidence_field）
    existing = [f for f in (state.get("findings") or []) if f.get("agent") == "model_analysis"]
    state["findings"] = drafted + existing
    state["high_severity_count"] = sum(1 for f in state["findings"] if f.get("severity") == "high")

    # 核心问题选取：因果/泄漏问题优先（按 severity→业务体量），正向机会其后避免 100%CVR 霸榜
    _sev_rank = {"high": 0, "mid": 1, "low": 2}
    def _problem_key(f):
        is_pos = 1 if f.get("_signal_type") == "positive" else 0
        sev = _sev_rank.get(f.get("severity"), 1)
        if f.get("_signal_type") == "leakage":
            # 同义反复 gap 不计入，按触发体量衡量业务重要性
            mag = (f.get("affected_users") or 0) / max(total_users, 1)
        else:
            mag = abs(_num(_mref(f, "cvr_gap")) or 0) * (_num(_mref(f, "trigger_rate")) or 0)
        return (is_pos, sev, -mag)
    problem_findings = sorted(drafted, key=_problem_key)[:max_problems]

    # ── 2) audience_segments：保留已有 + 为每个核心问题 finding 生成候选人群（建立 finding→seg 映射）──
    segments: list[dict] = list(state.get("audience_segments") or [])
    seg_names = {s.get("name") for s in segments}
    fid_to_seg: dict[str, str] = {}
    for f in problem_findings:
        seg = _segment_from_finding(f, thresholds)
        if seg:
            if seg["name"] not in seg_names:
                segments.append(seg)
                seg_names.add(seg["name"])
            fid_to_seg[f["id"]] = seg["name"]
    state["audience_segments"] = segments

    # ── 3) narratives.problems：核心问题 finding 升级为问题（typical_case 自动匹配，含 problem_rank）──
    problems: list[dict] = []
    for i, f in enumerate(problem_findings, start=1):
        p = _problem_from_finding(f, case_pool, segments)
        p["problem_rank"] = i
        problems.append(p)
    headline = _headline(problem_findings, state)
    state["narratives"] = {"headline": headline, "problems": problems, "_draft": True}

    # ── 4) action_plan.priority_actions：每个问题一条骨架行动（人群指向各自 finding 的人群）──
    actions: list[dict] = []
    for i, (f, p) in enumerate(zip(problem_findings, problems), start=1):
        actions.append(_action_from_problem(i, f, p, fid_to_seg.get(f["id"])))
    state.setdefault("action_plan", {})
    state["action_plan"]["priority_actions"] = actions
    state["action_plan"].setdefault("cross_validation", [])
    state["action_plan"].setdefault("data_caveats", [])

    state["_stage"] = "draft"
    return state


# ── 装配子函数 ────────────────────────────────────────────────────────

def _finding_from_rule(r: dict, thresholds: dict, cvr_label: str = "成单率") -> dict:
    rid = int(r["rule_id"])
    name = r.get("name", "")
    tr, tc = r.get("trigger_rate"), r.get("trigger_cnt")
    # 主口径（展示 + 严重度/有效信号判定）：eval_col（默认成单率 is_paid）。
    # cvr_triggered/cvr_not_triggered/cvr_gap 已由 compute-thresholds 按成单率算出。
    ct, cn, cg = r.get("cvr_triggered"), r.get("cvr_not_triggered"), r.get("cvr_gap")
    # 过程口径：创单率（is_converted），仅供漏斗过程展示，不参与判定。
    create_ct, create_cn = r.get("create_triggered"), r.get("create_not_triggered")
    stype = r.get("_signal_type", "causal")
    # 创单未付（促付）型：触发组「创单率≈100%」但「成单率」低于对照——即营销已促成创单却漏在支付。
    # 成单口径下其成单率=0% 属定义性（被 effective 排除），故用创单率口径(create_ct≈1)+成单更差来识别，
    # 重述为促付问题（按规模而非 CVR 差诊断），避免成单口径丢失这类高价值"创单→支付漏损"问题。
    _create_t = _num(create_ct)
    _leak_by_create = (_create_t is not None and _create_t >= 0.99
                       and _num(ct) is not None and _num(cn) is not None and _num(ct) < _num(cn))
    is_leak = bool(r.get("is_leakage")) or _leak_by_create
    basis = cvr_label   # 展示口径名（默认「成单率」）
    tr_s = f"{_num(tr)*100:.1f}%" if _num(tr) is not None else "—"
    ct_s = f"{_num(ct)*100:.2f}%" if _num(ct) is not None else "—"
    cn_s = f"{_num(cn)*100:.2f}%" if _num(cn) is not None else "—"
    gap_s = f"{_num(cg)*100:+.2f}pp" if _num(cg) is not None else "—"
    n_tc = int(_num(tc)) if _num(tc) is not None else 0
    total = int(_num(r.get("total_cnt")) or 0)
    scale = (n_tc / total) if total else 0.0

    # 相对效应量（基差无关）：|gap| / 对照组 CVR。成单率基数（~2%）远小于创单率（~7%），
    # 用绝对 pp 阈值会把成单口径的大问题误降级；改用相对效应量，创单/成单两种口径一致判定。
    cn_ref = _num(cn) or 0.0
    rel = (abs(_num(cg)) / cn_ref) if (cn_ref > 0 and _num(cg) is not None) else 0.0

    ambiguous_pos = False
    if is_leak:
        # 泄漏/同义反复（触发组创单率≈100%）：重述为创单→支付漏损问题，用成单率量化。
        stype = "leakage"
        severity = "high" if n_tc >= 1000 else "mid"
        signal = f"{name}：{n_tc:,}用户创单后未完成支付，成单率 {ct_s}（对照 {cn_s}，差 {gap_s}）"
        detail = (f"「{name}」属创单→支付漏损：触达后成功创单却未支付，成单率仅 {ct_s}（对照 {cn_s}）。"
                  "请按促付（创单未付/营销冗余等）角度重述。[待润色]")
    elif stype == "positive":
        # 正向信号：用中性/正向展示名（display_name），不挂负向规则名（修复绿标配负向名矛盾）
        disp = r.get("display_name") or name
        signal = f"{disp}（正向机会）：{n_tc:,}用户（{tr_s}）触发，触发{basis} {ct_s} 高于对照 {cn_s}（{gap_s}）"
        severity = "mid"
        detail = f"「{disp}」为正向信号，建议作为优质人群定向或保护型策略依据。[待润色]"
    else:
        # 因果负向：severity 兼顾相对效应量与业务体量——
        # 强相对效应（|gap| ≥ 60% 对照）或大体量（覆盖≥10% 且 |gap| ≥ 30% 对照）均判 high。
        big_gap   = rel >= 0.60
        big_scale = (scale >= 0.10 and rel >= 0.30)
        severity = "high" if (big_gap or big_scale) else r.get("severity_base", "mid")
        signal = f"{name}：{n_tc:,}用户（{tr_s}）触发，触发{basis} {ct_s} vs 对照 {cn_s}，差 {gap_s}"
        detail = f"「{name}」触发率 {tr_s}（{n_tc:,}人），{basis}差 {gap_s}。补充业务根因与建议方向。[待润色]"

    # Wilson 95%CI（基于触发组 CVR 与样本量）：低样本/区间过宽时自动降 high→mid，叙述更诚实
    ci_low = ci_high = None
    if _num(ct) is not None and n_tc > 0:
        try:
            from .stats_utils import wilson_ci
            ci_low, ci_high = wilson_ci(float(ct), int(n_tc))
            if severity == "high" and (n_tc < 100 or (ci_high - ci_low) >= 0.10):
                severity = "mid"
        except Exception:
            pass

    # 统计显著性闸门：触发组 vs 对照组 CVR 差异未达显著（卡方 p≥0.05）时，severity 不得为 high。
    # 兑现 README「p>0.05 时 severity 降级」原则；p_value 不可得（无 scipy）时不降级，保证降级环境行为不变。
    cvr_gap_p = r.get("cvr_gap_p_value")
    if severity == "high" and cvr_gap_p is not None and not r.get("cvr_gap_significant"):
        severity = "mid"

    cvr_t_ref = {"name": "cvr_triggered", "value": ct, "n_event": n_tc}
    if ci_low is not None:
        cvr_t_ref["ci_low"], cvr_t_ref["ci_high"] = round(ci_low, 4), round(ci_high, 4)

    return {
        "id": f"fnd_r{rid}", "agent": "diagnostic_rules", "rule_id": rid,
        # 正向信号用中性/正向展示名作 badge，避免渲染层回退到负向规则名
        "signal_name": (r.get("display_name") or name) if stype == "positive" else "",
        "signal": signal, "severity": severity, "detail": detail,
        "metric_refs": [
            cvr_t_ref,
            {"name": "cvr_not_triggered", "value": cn},
            {"name": "cvr_gap", "value": cg},
            {"name": "trigger_rate", "value": tr},
            {"name": "n_event", "value": tc},
        ],
        "confidence": 0.85, "_signal_type": stype, "affected_users": n_tc,
        # 统计显著性（卡方）为元信息，不进 metric_refs（避免被统计自洽校验误报无法定位）；
        # p_value/significant 可从 diagnostic_rules_summary[rule_id] 审计，渲染层据此打 ⚠️ 标记。
        "cvr_gap_significant": r.get("cvr_gap_significant"),
        "cvr_gap_p_value": r.get("cvr_gap_p_value"),
        "direction_ambiguous": ambiguous_pos,
        "_rule_condition": r.get("condition"),  # 解析后触发条件，供任意规则生成人群包
        "_draft": True,
    }


def _top_positive_threshold(thresholds: dict, exclude_fields: set,
                            cvr_label: str = "成单率") -> dict | None:
    # 选择：用创单率切分差（信号更密、最优切分更稳）挑出区分度最高的正向 split
    best = None
    for field, info in thresholds.items():
        if info.get("signal_quality") != "threshold_found" or field in exclude_fields:
            continue
        cb, ca = _num(info.get("cvr_below")), _num(info.get("cvr_above"))
        if cb is None or ca is None or ca <= cb:
            continue
        gap = ca - cb
        if best is None or gap > best[0]:
            best = (gap, field, info)
    if not best or best[0] < 0.03:
        return None
    _gap_sel, field, info = best
    # 展示：成单率（eval 口径）优先；不可得退回创单率。保证正向机会卡也以成单率呈现。
    ca_e, cb_e = _num(info.get("cvr_above_eval")), _num(info.get("cvr_below_eval"))
    if ca_e is not None and cb_e is not None:
        ca, cb, gap, basis = ca_e, cb_e, (ca_e - cb_e), cvr_label
    else:
        ca, cb, gap, basis = (_num(info.get("cvr_above")), _num(info.get("cvr_below")),
                              _gap_sel, "创单率")
    na = int(_num(info.get("n_above")) or 0)
    # 高潜人群占比（符合特征比例）：n_above / n_total。供详情卡展示"符合特征比例/高潜用户数"。
    n_total = int(_num(info.get("n_total")) or 0)
    pos_rate = (na / n_total) if n_total else None
    opt = info.get("optimal")
    # 信号名：用特征中文名作为该正向机会的简洁"规则名"，供报告中间徽章/封面左列/行动分组统一展示。
    from .report_renderer import ReportRenderer as _RR
    signal_name = _RR._humanize_feature(field) or field
    return {
        "id": f"fnd_pos_{field}", "agent": "diagnostic_rules", "rule_id": None,
        "signal": (f"正向机会：「{signal_name}」≥{opt} 的高潜用户 {na:,} 人，"
                   f"{basis} {ca*100:.2f}% 远高于其余 {cb*100:.2f}%（+{gap*100:.2f}pp）"),
        "signal_name": signal_name,
        "severity": "mid",
        "detail": (f"「{signal_name}」≥{opt} 的用户{basis}显著更高，是核心转化来源，"
                   "建议保护并作为相似人群扩展种子。[待润色]"),
        "metric_refs": [
            {"name": "cvr_triggered", "value": ca, "n_event": na},
            {"name": "cvr_not_triggered", "value": cb},
            {"name": "cvr_gap", "value": gap},
            {"name": "trigger_rate", "value": pos_rate},
            {"name": "n_event", "value": na},
        ],
        "confidence": 0.8, "_signal_type": "positive", "affected_users": na, "_draft": True,
    }


def _segment_name(f: dict) -> str:
    """人群名：优先 curated 名，否则由规则中文名派生，杜绝「问题人群·NN」。"""
    rid = f.get("rule_id")
    if rid is not None and _RULE_SEGMENT_NAME.get(int(rid)):
        return _RULE_SEGMENT_NAME[int(rid)]
    return ("高潜·" if f.get("_signal_type") == "positive" else "") + _rule_name(f) + "人群"


def _segment_from_finding(f: dict, thresholds: dict) -> dict | None:
    rid = f.get("rule_id")
    if rid is not None:
        # 人群筛选条件必须与 finding 触发口径一致：优先用规则「解析后触发条件」（引用规则真实字段，
        # 人群规模与 finding 触发人数同源），杜绝 curated 单字段代理选错字段导致的人群口径漂移
        # （历史上 rule 37 用 pre_mkt_touch_cnt 代理 insite_channel_cnt，人群只剩 1/17）。
        cond = f.get("_rule_condition")
        if not cond and int(rid) in _RULE_SEGMENT_FIELD:
            field, op = _RULE_SEGMENT_FIELD[int(rid)]
            if ">=N" in op:
                tv = (thresholds.get(field) or {}).get("optimal")
                cond = f"{field} >= {tv}" if tv is not None else f"{field} >= 0"
            elif field.endswith("is_paid"):
                cond = f"{field} == 0"
            else:
                cond = f"{field} {op.replace('==', '== ').replace('<=', '<= ').replace('>=', '>= ')}"
        if not cond:
            return None
        seg_name = _segment_name(f)
    elif f.get("id", "").startswith("fnd_pos_"):
        field = f["id"].replace("fnd_pos_", "")
        tv = (thresholds.get(field) or {}).get("optimal")
        cond = f"{field} >= {tv}" if tv is not None else f"{field} > 0"
        seg_name = "高潜转化人群"
    else:
        return None
    ct = next((m.get("value") for m in f.get("metric_refs", []) if m.get("name") == "cvr_triggered"), None)
    _DIR = {"positive": "push", "causal": "exclude", "leakage": "促付"}.get(f.get("_signal_type"), "exclude")
    return {
        "name": seg_name, "filter_conditions": cond,
        "rationale": f"对应「{f.get('signal','')[:24]}」的人群，建议定向干预。[待润色]",
        "action": "按 finding 建议方向投放/排除/促付。[待润色]",
        "estimated_size": int(f.get("affected_users") or 0),
        "baseline_cvr": _num(ct) if _num(ct) is not None else 0.0,
        "confidence": 0.7, "_draft": True,
        "direction": _DIR, "finding_id": f.get("id"),
    }


def _problem_from_finding(f: dict, case_pool: dict, segments: list) -> dict:
    rid = f.get("rule_id")
    if rid is not None:
        pattern = _RULE_CASE_PATTERN.get(int(rid), "no_mainflow")
    else:
        pattern = "high_cvr_positive" if f.get("_signal_type") == "positive" else "no_mainflow"
    name = _rule_name(f)
    case = _typical_case(case_pool.get(pattern) or {}, f, name)
    return {
        "agent": "diagnostic_rules",
        # 无规则归属的问题（正向阈值机会/模型洞察）把 finding 的 signal_name 作为中间徽章/封面
        # 标签的"信号名"，避免该徽章在报告中显示为空白；规则归属问题此项为空（渲染层取规则名）。
        "rule_name": f.get("signal_name", ""),
        # 用干净规则名占位，不切 signal（避免半截数字）；标题由 Agent 改写为论断式
        "title": f"{name}[待润色：12-25字论断式标题，含一个关键数据]",
        "narrative": f.get("signal", "") + "。补充现象+数据叙述（60-100字）。[待润色]",
        "impact": "补充业务影响（CVR/成本/体验冲击，30-50字）。[待润色]",
        "evidence_finding_ids": [f.get("id")],
        "typical_case": case, "_draft": True,
    }


def _typical_case(case: dict, f: dict, name: str = "") -> dict:
    # case.user_id 已是脱敏形式（U…***）；缺失时才用合成占位，避免出现 "UU…" 双前缀
    uid = str(case.get("user_id") or "典型用户（合成）")
    kf = case.get("key_features") or {}
    # 优先用 case 指定的展示指标（如品类错配的"最多浏览品类/次数/目标浏览次数"）；
    # 否则取 key_features 前 3 项，label 用中文特征名避免外露英文字段名
    from .report_renderer import ReportRenderer as _RR
    metrics = case.get("display_metrics") or \
        [{"val": str(v), "label": _RR._humanize_feature(k)} for k, v in list(kf.items())[:3]] or \
        [{"val": "—", "label": "指标"}]
    pe = case.get("path_events") or []
    # 取前 4 个事件：行为路径 + 红包(若有) + 触达 + 模式专属问题事件，避免关键 issue 被截断
    timeline = [{"time": e.get("time", ""), "action": e.get("action", ""),
                 "type": e.get("type", "normal")} for e in pe[:4]] or \
               [{"time": "—", "action": "（补充行为时序）", "type": "normal"}]
    return {
        # 徽章用完整规则名（语义完整，不做半词硬截）；Agent 润色时可缩到 ≤6 字
        "user_id": uid, "badge_text": (name or "案例"),
        "badge_type": "matched" if f.get("_signal_type") == "positive" else "unmatched",
        "profile_text": "（基于 key_features 补一句用户画像）[待润色]",
        "metrics": metrics, "timeline": timeline,
        "root_cause": "（基于该用户数据补 2-3 句根因）[待润色]",
    }


def _action_from_problem(rank: int, f: dict, problem: dict, seg_name: str | None) -> dict:
    seg = seg_name
    name = _rule_name(f)
    cg = _mref(f, "cvr_gap")
    gap_s = f"{abs(_num(cg))*100:.1f}pp" if _num(cg) is not None else "—"
    if f.get("_signal_type") == "leakage":
        # 泄漏型（创单→支付漏损）：用支付成单率口径，不展示同义反复的 cvr_gap（如 97.8pp）
        title = f"针对「{name}」促付，提升支付成单率[待润色：动词+幅度，支付率现状→目标]"
        expected = "支付成单率提升[待润色]"
    else:
        # 用干净规则名占位，不切 signal；Agent 改写为「动词+幅度，指标现状→目标」
        title = f"针对「{name}」优化，预期改善 {gap_s}[待润色：动词+幅度，指标现状→目标]"
        expected = f"CVR 改善约 {gap_s}[待润色]"
    return {
        "rank": rank, "problem_rank": rank, "dimension": "人群策略",
        "title": title,
        "description": "动词开头，补具体行动描述（30-50字）。[待润色]",
        "evidence": f.get("signal", "")[:60],
        "target_audiences": [seg] if seg else ["全量"],
        "expected_impact": expected,
        "execution_difficulty": "medium", "_draft": True,
    }


def _headline(findings: list, state: dict) -> str:
    # A0：最终指标用支付成单率（is_paid），创单率（is_converted）作过程口径并列展示
    cs = ((state.get("data_overview") or {}).get("conversion_summary") or {})
    cvr = _num(cs.get("overall_cvr"))    # 创单率（过程）
    paid = _num(cs.get("paid_rate"))     # 支付成单率（最终）
    cvr_s = f"{cvr*100:.2f}%" if cvr is not None else "—"
    paid_s = f"{paid*100:.2f}%" if paid is not None else "—"
    name = (state.get("campaign_meta") or {}).get("campaign_name", "本活动")
    top = _rule_name(findings[0]) if findings else ""
    h = f"{name}支付成单率{paid_s}（创单率{cvr_s}），主要问题：{top}等（草稿，待润色）"
    return h[:58]
