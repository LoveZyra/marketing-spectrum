"""Self-Critique 反思环（methodology/05_self_critique.md 配套实现）。

输入：完整或部分 state
输出：
  - critique(state) -> list[issue]：列出需要归宿的问题。
  - assess(state) -> list[assessment]：逐条评估截至当前轮前已有诊断结果，标注
    accepted / questioned / pending，并给 questioned 项生成复诊计划。

不依赖 LLM，仅做规则化校验。Agent 自身的 LLM 反思可以叠加在此基础上。
"""
from __future__ import annotations

import re
from typing import Any

_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")
_QUANTIFIED_HINTS = ("%", "pp", "倍", "×", "x")

_AGENT_TOOL_MAP = {
    "funnel_diagnosis": "domain_funnel_diagnosis",
    "marketing_attribution": "domain_marketing_attribution",
    "user_segment": "domain_user_segment",
    "price_sensitivity": "domain_price_sensitivity",
    "platform_behavior": "domain_platform_behavior",
    "path_quality": "domain_path_quality",
}

# 6 个领域统计 agent：其 finding 的事实层在 state.agent_structured_stats[agent]。
# diagnostic_rules / model_analysis 不在此列——它们的事实层分别是 diagnostic_rules_summary
# 与 finding 自身 metric_refs，assess() 据此判定可复核性（见 _is_pending_result）。
_DOMAIN_STAT_AGENTS = frozenset(_AGENT_TOOL_MAP.keys())


def critique(state: dict[str, Any]) -> list[dict[str, Any]]:
    issues: list[dict[str, Any]] = []
    issues.extend(_check_statistical_coherence(state))
    issues.extend(_check_metric_sign(state))
    issues.extend(_check_signal_coverage(state))
    issues.extend(_check_business_coherence(state))
    issues.extend(_check_redundancy(state))
    issues.extend(_check_closure(state))
    issues.extend(_check_render_health(state))
    issues.extend(_check_draft_residue(state))
    issues.extend(_check_language_compliance(state))
    return [_with_rediagnosis_plan(issue, state) for issue in issues]


def assess(state: dict[str, Any]) -> list[dict[str, Any]]:
    """逐条评估当前 state 中已有诊断结果的合理性。

    返回 assessment 列表，并写入 `state["self_critique_assessments"]`。
    每条 assessment 的 status:
      - accepted: 当前证据足以接受，可进入综合。
      - questioned: 存在明确 issue，需要修订或复诊。
      - pending: 当前缺少足够事实层数据，不能接受也不能否定，需补证据。
    """
    issues = critique(state)
    by_target: dict[tuple[str, str], list[dict]] = {}
    for issue in issues:
        key = (issue.get("target_kind", ""), str(issue.get("target_id", "")))
        by_target.setdefault(key, []).append(issue)

    assessments: list[dict[str, Any]] = []
    for item in _iter_result_items(state):
        key = (item["target_kind"], item["target_id"])
        item_issues = by_target.get(key, [])
        if item_issues:
            status = "questioned"
            rationale = "命中 self_critique issue，必须修订、移位、显式接受或复诊。"
            plans = [i.get("rediagnosis_plan") for i in item_issues if i.get("rediagnosis_plan")]
        elif _is_pending_result(item, state):
            status = "pending"
            rationale = "缺少可复核的事实层数据或引用对象，暂不能接受为最终结论。"
            plans = [_pending_plan(item)]
        else:
            status = "accepted"
            rationale = "当前证据、闭环引用与重复性检查未发现阻塞问题。"
            plans = []

        assessments.append({
            "target_kind": item["target_kind"],
            "target_id": item["target_id"],
            "status": status,
            "rationale": rationale,
            "issues": item_issues,
            "rediagnosis_plans": plans,
        })

    state["self_critique"] = issues
    state["self_critique_assessments"] = assessments
    return assessments


def _check_statistical_coherence(state: dict) -> list[dict]:
    issues: list[dict] = []
    structured = state.get("agent_structured_stats") or {}
    data_overview = state.get("data_overview") or {}
    # adaptive_thresholds 是 compute-thresholds 产出的合法证据源（methodology/08 允许从 CVR
    # 分桶取值，如 cvr_below/cvr_above/n_below/n_above），与 data_overview 同级需一并索引
    adaptive_thresholds = state.get("adaptive_thresholds") or {}
    for f in state.get("findings", []):
        for m in f.get("metric_refs", []) or []:
            name = m.get("name")
            value = m.get("value")
            n_total = m.get("n_total")
            if not name or value is None:
                continue
            # 值为 0 且 finding 强调"无/零/缺失"语义时跳过严格匹配（结构性 finding）
            try:
                if float(value) == 0.0:
                    sig = (f.get("signal", "") + f.get("detail", "")).lower()
                    if any(kw in sig for kw in ("0%", "零", "无一", "未转化", "未触达", "缺失")):
                        continue
            except (TypeError, ValueError):
                pass

            recs = structured.get(f.get("agent")) or []
            # 先查 agent_structured_stats；再回退查 data_overview（finding 常引用 overview 字段）
            findable = _value_findable(recs, name, value) if recs else False
            if not findable and data_overview:
                findable = _value_findable_in_overview(data_overview, value)
            if not findable and adaptive_thresholds:
                findable = _value_findable_in_overview(adaptive_thresholds, value)
            if not findable and (recs or data_overview or adaptive_thresholds):
                issues.append({
                    "type": "statistical_coherence",
                    "severity": "warning",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": f"metric {name}={value} 在 agent_structured_stats / data_overview / adaptive_thresholds 中均无法定位",
                    "suggested_fix": "重算并把真实数值写回 metric_refs；或改引用 agent_raw_stats 文本片段",
                })
            ci_low, ci_high = m.get("ci_low"), m.get("ci_high")
            if ci_low is not None and ci_high is not None and ci_low <= 0 <= ci_high and f.get("severity") == "high":
                issues.append({
                    "type": "statistical_coherence",
                    "severity": "warning",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": f"metric {name} 的 95% CI 跨 0（[{ci_low}, {ci_high}]）但 severity=high",
                    "suggested_fix": "severity 降级为 mid 或在 detail 末尾追加『CI 跨 0，方向待验证』",
                })
            p_value = m.get("p_value")
            if p_value is not None and p_value > 0.05 and f.get("severity") in ("high", "mid"):
                issues.append({
                    "type": "statistical_coherence",
                    "severity": "error",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": f"p_value={p_value} > 0.05 但 severity={f.get('severity')}",
                    "suggested_fix": "调用 stats_utils.severity_from_pvalue 自动降级",
                })
            if n_total is not None and n_total < 30 and f.get("severity") == "high":
                issues.append({
                    "type": "statistical_coherence",
                    "severity": "warning",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": f"n_total={n_total} < 30 但 severity=high",
                    "suggested_fix": "severity 降级且 confidence ≤ 0.6",
                })
    return issues


def _check_metric_sign(state: dict) -> list[dict]:
    """指标符号自洽：cvr_gap 的符号必须等于 cvr_triggered − cvr_not_triggered。
    符号相反说明 LLM 写反了触发组/对照组（渲染器虽会自动纠正，但叙述文字仍可能错）。"""
    issues: list[dict] = []
    for f in state.get("findings", []):
        m = {mr.get("name"): mr.get("value") for mr in (f.get("metric_refs") or [])}
        ct, cn, cg = m.get("cvr_triggered"), m.get("cvr_not_triggered"), m.get("cvr_gap")
        if ct is None or cn is None or cg is None:
            continue
        try:
            expected = float(ct) - float(cn)
            if abs(float(cg)) > 1e-9 and abs(expected) > 1e-9 and (float(cg) > 0) != (expected > 0):
                issues.append({
                    "type": "statistical_coherence",
                    "severity": "warning",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": (f"cvr_gap 符号({float(cg):+.4f})与 cvr_triggered−cvr_not_triggered"
                                f"({expected:+.4f})相反，触发组/对照组可能写反"),
                    "suggested_fix": "核对 metric_refs：负向规则 cvr_triggered<cvr_not_triggered、gap<0；并据此校正 signal/detail 叙述方向",
                })
        except (TypeError, ValueError):
            continue
    return issues


# 主题合并组（源自 methodology/08 关联规则合并原则 + 同类语义）：
# 覆盖组内任一规则的 finding，视为覆盖整组，避免把"已并入相关问题"误报为漏诊。
_COVERAGE_GROUPS: list[set] = [
    {1, 4, 5, 27},             # 低意向 / 无效触达 / 僵尸 / 低质量人群
    {2, 20, 33, 34, 35, 37, 38},  # 过度触达 / 频次疲劳 / 跨渠道叠加 / 多渠道冲突 / 活动堆叠 / 弹屏过多
    {6, 44},                   # 时机错配 / 伪实时配置
    {7},                       # 成单后触达
    {15, 16, 17, 18, 39},      # 关键打断（含弹屏打扰填写）
    {21, 25, 41},              # 遗单召回 / 创单未付促付
    {12, 13, 14},              # 站内外衔接
    {11, 43},                  # 内容匹配（跨品类错配 / 推送零浏览品类）
    {19},                      # 自然转化
    {23, 24},                  # 流程体验 / 比价 / 漏斗倒退
    {42},                      # 红包平台
]


def _group_of(rule_id: int) -> set:
    for g in _COVERAGE_GROUPS:
        if rule_id in g:
            return g
    return {rule_id}


def _check_signal_coverage(state: dict) -> list[dict]:
    """漏诊检测（反思环核心增强）：compute-thresholds 标记为 effective_signal 的强信号
    （已触发因果/正向、相对效应量|CVR差|/对照CVR≥30%、样本≥100、卡方p<0.05），若其所属主题组没有任何 finding 覆盖，
    提示可能漏诊。让反思环不仅审"写了什么"，也审"漏了什么"。"""
    issues: list[dict] = []
    rules_summary = (state.get("data_overview") or {}).get("diagnostic_rules_summary") or []
    effective = [r for r in rules_summary if r.get("effective_signal")]
    if not effective:
        return issues

    covered_groups: set = set()  # 已被 finding 覆盖的主题组（用 frozenset 标识）
    for f in state.get("findings", []):
        rid = f.get("rule_id")
        if rid is not None:
            try:
                covered_groups.add(frozenset(_group_of(int(rid))))
            except (TypeError, ValueError):
                pass

    def _score(r):
        try:
            return abs(float(r.get("cvr_gap") or 0)) * float(r.get("trigger_rate") or 0)
        except (TypeError, ValueError):
            return 0.0

    flagged_groups: set = set()
    for r in sorted(effective, key=_score, reverse=True):
        rid = r.get("rule_id")
        if rid is None:
            continue
        grp = frozenset(_group_of(int(rid)))
        if grp in covered_groups or grp in flagged_groups:
            continue
        flagged_groups.add(grp)
        if len(flagged_groups) > 4:   # 最多提示 4 个主题，保持精炼
            break
        gap = r.get("cvr_gap")
        gap_s = f"{float(gap)*100:+.2f}pp" if gap is not None else "—"
        issues.append({
            "type": "signal_coverage",
            "severity": "warning",
            "target_kind": "rule",
            "target_id": str(rid),
            "message": (f"强信号「{r.get('name','')}」(CVR差 {gap_s}, 触发 {int(r.get('trigger_cnt') or 0):,} 人) "
                        f"及其同类主题未被任何 finding 覆盖，可能漏诊"),
            "suggested_fix": "为该主题补一条 finding（diagnostic_rules, rule_id 对应），或在 data_caveats 说明为何不纳入",
        })
    return issues


def _check_draft_residue(state: dict) -> list[dict]:
    """未润色草稿残留检查：[待润色] 占位、残留 _draft 标记、_stage 非 full。

    与 render 的 completeness block 形成双保险——即便绕过 render 直接交付，
    self_critique 也能拦下未润色草稿。
    """
    import json as _json
    issues: list[dict] = []
    stage = state.get("_stage")
    if stage and stage != "full":
        issues.append({
            "type": "draft_residue", "severity": "error",
            "target_kind": "state", "target_id": "_stage",
            "message": f"_stage={stage}（非 full）：草稿尚未完成润色，不应交付/render。",
            "suggested_fix": "润色所有 [待润色] 文案、删除 _draft 标记后将 _stage 置为 full",
        })
    blob = _json.dumps({k: state.get(k) for k in
                        ("narratives", "action_plan", "audience_segments", "findings")},
                       ensure_ascii=False)
    n_todo = blob.count("[待润色]")
    n_draft = blob.count('"_draft"')
    if n_todo:
        issues.append({
            "type": "draft_residue", "severity": "error",
            "target_kind": "state", "target_id": "draft_placeholder",
            "message": f"检测到 {n_todo} 处 [待润色] 占位未改写（narratives/action_plan/segments/findings）。",
            "suggested_fix": "按 methodology/03 改写所有 [待润色] 文案，保持 metric_refs 数值不变",
        })
    if n_draft:
        issues.append({
            "type": "draft_residue", "severity": "warning",
            "target_kind": "state", "target_id": "draft_flag",
            "message": f"检测到 {n_draft} 处残留 _draft 标记，润色完成后应删除。",
            "suggested_fix": "删除各对象的 _draft 标记",
        })
    return issues


def _check_render_health(state: dict) -> list[dict]:
    """渲染健康：若上一次 render 产生过模块降级（render_warnings 非空），提示存在
    模块渲染异常，需排查对应数据。"""
    issues: list[dict] = []
    for w in state.get("render_warnings") or []:
        issues.append({
            "type": "render_health",
            "severity": "warning",
            "target_kind": "render",
            "target_id": "render",
            "message": f"渲染时有模块降级：{w}",
            "suggested_fix": "排查该模块依赖的 state 数据是否缺失/异常；修复后重新 render",
        })
    return issues


def _check_business_coherence(state: dict) -> list[dict]:
    issues: list[dict] = []
    profile = state.get("campaign_profile") or {}
    model = state.get("model_analysis") or {}
    top_features = {tf.get("feature"): tf for tf in (model.get("top_features") or [])}
    design_dims = {d.get("dimension") for d in (profile.get("design_issues") or [])}

    # ── AUC < 0.5 时，model_analysis findings 不应出现在 findings 列表 ──
    try:
        import math as _m
        auc = float(model.get("auc") or 0)
    except (TypeError, ValueError):
        auc = 0.0
    if _m.isfinite(auc) and auc < 0.5:
        bad_model_findings = [
            f for f in state.get("findings", [])
            if f.get("agent") == "model_analysis"
        ]
        for f in bad_model_findings:
            issues.append({
                "type": "business_coherence",
                "severity": "error",
                "target_kind": "finding",
                "target_id": f.get("id", ""),
                "message": f"AUC={auc:.4f}<0.5，model_analysis finding 不可信，不应计入诊断结果",
                "suggested_fix": "将该 finding 移入 data_caveats 并从 findings 列表删除",
            })

    for f in state.get("findings", []):
        # 既查 evidence_field（model_interpreter 自动 finding），也查 signal/detail 文本
        # （手写 finding 通常只在叙述里提特征名），让模型×统计方向冲突对两类 finding 都生效
        sig = f.get("signal", "")
        haystack = (f.get("evidence_field", "") or "") + " " + sig + " " + (f.get("detail", "") or "")
        for feat_name, tf in top_features.items():
            if not feat_name or feat_name not in haystack:
                continue
            direction = _infer_direction(sig)
            model_dir = tf.get("direction") or ("positive" if tf.get("importance", 0) > 0 else "unknown")
            if direction == "negative" and model_dir == "positive":
                issues.append({
                    "type": "business_coherence",
                    "severity": "warning",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": f"finding 方向(负向)与模型 Top 特征 {feat_name} 方向(正向)冲突",
                    "suggested_fix": "移入 action_plan.cross_validation 或 blind_spots，标注潜在混杂",
                })
                break  # 每条 finding 只报一次方向冲突，避免多特征重复刷屏

        agent_dim = _map_agent_to_dimension(f.get("agent"))
        if agent_dim and design_dims and agent_dim in design_dims and f.get("severity") == "low":
            issues.append({
                "type": "business_coherence",
                "severity": "warning",
                "target_kind": "finding",
                "target_id": f.get("id", ""),
                "message": f"维度 {agent_dim} 已在 campaign_profile.design_issues 命中但当前 finding 仅 low",
                "suggested_fix": "评估是否应升级 severity；或在 detail 中明确引用对应 design_issue",
            })
    return issues


def _check_redundancy(state: dict) -> list[dict]:
    issues: list[dict] = []
    seen_sig: dict[str, str] = {}
    for f in state.get("findings", []):
        sig = _normalize(f.get("signal", ""))
        for prev_id, prev_sig in seen_sig.items():
            if _token_overlap(sig, prev_sig) > 0.8:
                issues.append({
                    "type": "redundancy",
                    "severity": "warning",
                    "target_kind": "finding",
                    "target_id": f.get("id", ""),
                    "message": f"signal 与 {prev_id} 重合度 > 80%",
                    "suggested_fix": "合并保留有更高 n_total / 更紧标题那条",
                })
                break
        seen_sig[f.get("id", "")] = sig

    seen_filters: dict[str, str] = {}
    for s in state.get("audience_segments", []):
        key = _normalize(s.get("filter_conditions", ""))
        if key in seen_filters:
            issues.append({
                "type": "redundancy",
                "severity": "warning",
                "target_kind": "audience_segment",
                "target_id": s.get("name", ""),
                "message": f"filter_conditions 与 {seen_filters[key]} 等价",
                "suggested_fix": "合并人群或区分 segment 的目的/触达动作",
            })
        else:
            seen_filters[key] = s.get("name", "")
    return issues


_ALLUSERS_SENTINELS = {
    "全量", "全量用户", "全体", "全体用户", "所有用户", "all", "all users", "全部",
}


def _check_language_compliance(state: dict) -> list[dict]:
    """将 report_validator.lint_report() 中的语言合规警告转为结构化 issue，
    纳入 critique 统一归宿循环，让 LLM 通过 LLM-revise 修订对外文本。

    覆盖：规则编号暴露（Rule N）、ML 专有词（AUC/LightGBM）、禁用词、渠道词汇错配。
    """
    issues: list[dict] = []
    try:
        from snippets.report_validator import lint_report  # lazy import
        lint_warns = lint_report(state)
    except Exception:
        return issues

    # 将 lint warning 字符串解析为 target_kind / target_id
    _find_loc = re.compile(r'^findings\[(\d+)\]\s*\(([^)]*)\)')
    _nar_loc  = re.compile(r'^narratives\.problems\[(\d+)\]')
    _act_loc  = re.compile(r'^action_plan\.priority_actions\[(\d+)\]')

    _LANGUAGE_KEYWORDS = {
        '含规则编号':   ('规则编号暴露（Rule N）：对外文本不得出现规则编号',
                         '将 Rule N / rule#N 替换为对应中文规则名，可从 diagnostic_rules_summary[rule_id].name 查找'),
        '含技术专有词': ('技术专有词暴露：对外文本不得出现 ML/技术术语',
                         '将 AUC/LightGBM/GBDT 等替换为中文业务描述，如「转化预测准确率」「转化预测模型」'),
        '含禁用词':     ('禁用词违规：出现 methodology/03_synthesis.md 禁止的写作词汇',
                         '按写作约束删除/替换禁用词，改为确定性结论表述'),
        '专属词汇':     ('渠道词汇错配：当前渠道下不应出现其他渠道专属词汇',
                         '替换为本次活动实际渠道对应词汇，如 activity 渠道使用「活动触达用户」'),
    }

    for w in lint_warns:
        matched_key = next((k for k in _LANGUAGE_KEYWORDS if k in w), None)
        if matched_key is None:
            continue  # 不是语言合规类 warning，跳过（如 _decision_trace 等结构性 warning）

        msg, fix = _LANGUAGE_KEYWORDS[matched_key]

        # 解析目标位置
        m_find = _find_loc.match(w)
        m_nar  = _nar_loc.match(w)
        m_act  = _act_loc.match(w)

        if m_find:
            target_kind = "finding"
            target_id   = m_find.group(2).strip() or m_find.group(1)
        elif m_nar:
            target_kind = "narrative"
            target_id   = m_nar.group(1)
        elif m_act:
            target_kind = "priority_action"
            target_id   = m_act.group(1)
        else:
            target_kind = "finding"
            target_id   = "unknown"

        issues.append({
            "type":         "language_compliance",
            "severity":     "warning",
            "target_kind":  target_kind,
            "target_id":    target_id,
            "message":      f"{msg} — {w}",
            "suggested_fix": fix,
        })

    return issues


def _check_closure(state: dict) -> list[dict]:
    issues: list[dict] = []
    plan = state.get("action_plan") or {}
    seg_names = {s.get("name") for s in state.get("audience_segments", []) if s.get("name")}
    seg_names |= _ALLUSERS_SENTINELS

    for a in plan.get("priority_actions", []) or []:
        for ta in a.get("target_audiences", []) or []:
            name = ta if isinstance(ta, str) else (ta.get("name") if isinstance(ta, dict) else None)
            if name and name not in seg_names:
                issues.append({
                    "type": "closure",
                    "severity": "error",
                    "target_kind": "priority_action",
                    "target_id": str(a.get("rank") or a.get("title", "")),
                    "message": f"target_audience '{name}' 在 audience_segments 中不存在",
                    "suggested_fix": "新增对应 audience_segment 或修正 target_audiences 名称",
                })

        impact = a.get("expected_impact", "") or ""
        if not _is_quantified(impact):
            issues.append({
                "type": "closure",
                "severity": "warning",
                "target_kind": "priority_action",
                "target_id": str(a.get("rank") or a.get("title", "")),
                "message": "expected_impact 缺少量化指标（无数字/%/pp/×）",
                "suggested_fix": "补充预期幅度，如『CVR +3-5pp』『预算节省 8%』",
            })

        title = a.get("title", "")
        if not _NUM_RE.search(title):
            issues.append({
                "type": "closure",
                "severity": "warning",
                "target_kind": "priority_action",
                "target_id": str(a.get("rank") or title),
                "message": "priority_action.title 不含具体数字",
                "suggested_fix": "改写为 <动词> <幅度>，<指标> <现状>→<目标> 格式",
            })

    return issues


# ── 辅助函数 ───────────────────────────────────────────────────────────

def _value_findable_in_overview(overview: dict, value: Any) -> bool:
    """递归扫描 data_overview 看 value 是否能匹配到某个数字字段（含 2% 容差）。"""
    try:
        v_num = float(value)
    except (TypeError, ValueError):
        return False

    def _walk(obj):
        if isinstance(obj, dict):
            for v in obj.values():
                if _walk(v):
                    return True
        elif isinstance(obj, list):
            for v in obj:
                if _walk(v):
                    return True
        else:
            try:
                x = float(obj)
                if abs(x - v_num) < 1e-4 or abs(x - v_num) / max(abs(v_num), 1e-9) < 0.02:
                    return True
                # 按量级匹配：adaptive_thresholds 的 cvr_gap 存为绝对值，而 finding 常用带符号
                # 的差值（负向规则 gap<0），provenance 只需定位数值大小，符号不敏感
                ax, av = abs(x), abs(v_num)
                if abs(ax - av) < 1e-4 or abs(ax - av) / max(av, 1e-9) < 0.02:
                    return True
            except (TypeError, ValueError):
                pass
        return False
    return _walk(overview)


def _value_findable(records: list[dict], metric_name: str, value: Any) -> bool:
    if not records:
        return False
    keys_to_try = {metric_name, metric_name.lower(), metric_name.replace(" ", "_")}
    try:
        v_num = float(value)
    except (TypeError, ValueError):
        return any(metric_name in str(r.get(k)) for r in records for k in r if k in keys_to_try) or True
    for r in records:
        for k, v in r.items():
            if k in keys_to_try or metric_name in str(k):
                try:
                    if abs(float(v) - v_num) < 1e-4 or abs(float(v) - v_num) / max(abs(v_num), 1e-9) < 0.02:
                        return True
                except (TypeError, ValueError):
                    continue
    return False


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower().strip())


def _token_overlap(a: str, b: str) -> float:
    ta = set(re.findall(r"[一-龥a-zA-Z0-9_]+", a))
    tb = set(re.findall(r"[一-龥a-zA-Z0-9_]+", b))
    if not ta or not tb:
        return 0.0
    return len(ta & tb) / max(len(ta), len(tb))


def _is_quantified(text: str) -> bool:
    return bool(_NUM_RE.search(text)) or any(h in text for h in _QUANTIFIED_HINTS)


def _infer_direction(signal: str) -> str:
    if any(w in signal for w in ("反向", "下降", "降低", "更低", "负向", "低于", "不及")):
        return "negative"
    if any(w in signal for w in ("提升", "高于", "上升", "更高", "拉动")):
        return "positive"
    return "unknown"


def _map_agent_to_dimension(agent: str) -> str | None:
    mapping = {
        "funnel_diagnosis": "漏斗设计",
        "marketing_attribution": "渠道配置",
        "user_segment": "人群定向",
        "price_sensitivity": "激励设计",
        "platform_behavior": "平台触达",
        "path_quality": "路径设计",
    }
    return mapping.get(agent or "")


def summarize(issues: list[dict]) -> dict[str, int]:
    out = {"total": len(issues), "error": 0, "warning": 0}
    by_type: dict[str, int] = {}
    for i in issues:
        out[i.get("severity", "warning")] = out.get(i.get("severity", "warning"), 0) + 1
        t = i.get("type", "unknown")
        by_type[t] = by_type.get(t, 0) + 1
    out["by_type"] = by_type
    return out


def summarize_assessments(assessments: list[dict]) -> dict[str, Any]:
    """汇总 assess() 的 accepted / questioned / pending 分布。"""
    out: dict[str, Any] = {
        "total": len(assessments),
        "accepted": 0,
        "questioned": 0,
        "pending": 0,
        "needs_rediagnosis": 0,
        "by_kind": {},
    }
    for a in assessments:
        status = a.get("status", "pending")
        out[status] = out.get(status, 0) + 1
        if a.get("rediagnosis_plans"):
            out["needs_rediagnosis"] += 1
        kind = a.get("target_kind", "unknown")
        out["by_kind"][kind] = out["by_kind"].get(kind, 0) + 1
    return out


def _iter_result_items(state: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for f in state.get("findings", []) or []:
        fid = str(f.get("id") or f.get("signal") or "")
        if fid:
            items.append({"target_kind": "finding", "target_id": fid, "payload": f})
    for s in state.get("audience_segments", []) or []:
        name = str(s.get("name") or s.get("segment_id") or "")
        if name:
            items.append({"target_kind": "audience_segment", "target_id": name, "payload": s})
    plan = state.get("action_plan") or {}
    for a in plan.get("priority_actions", []) or []:
        aid = str(a.get("rank") or a.get("title") or "")
        if aid:
            items.append({"target_kind": "priority_action", "target_id": aid, "payload": a})
    return items


def _is_pending_result(item: dict[str, Any], state: dict[str, Any]) -> bool:
    payload = item.get("payload") or {}
    kind = item.get("target_kind")
    if kind == "finding":
        agent = payload.get("agent")
        has_metrics = bool(payload.get("metric_refs")) or bool(payload.get("evidence_field"))
        # 6 个领域统计 agent：事实层在 agent_structured_stats[agent]，缺该维度统计或无指标 → pending
        if agent in _DOMAIN_STAT_AGENTS:
            if not (state.get("agent_structured_stats") or {}).get(agent):
                return True
            return not has_metrics
        # 规则/正向阈值机会 finding（agent=diagnostic_rules）：事实层不在 agent_structured_stats，
        # 而在 diagnostic_rules_summary（按 rule_id 可定位）或 finding 自身 metric_refs。
        if agent == "diagnostic_rules":
            rid = payload.get("rule_id")
            rules_summary = (state.get("data_overview") or {}).get("diagnostic_rules_summary") or []
            in_summary = rid is not None and any(rr.get("rule_id") == rid for rr in rules_summary)
            return not (has_metrics or in_summary)
        # model_analysis / adhoc 等：自带 metric_refs 或 evidence_field 即可复核
        return not has_metrics
    if kind == "audience_segment":
        return not payload.get("filter_conditions")
    if kind == "priority_action":
        return not payload.get("expected_impact") or not payload.get("target_audiences")
    return False


def _pending_plan(item: dict[str, Any]) -> dict[str, Any]:
    payload = item.get("payload") or {}
    if item.get("target_kind") == "finding":
        tool_id = _AGENT_TOOL_MAP.get(payload.get("agent"), "adhoc_synthesis")
        return {
            "decision": "pending",
            "tool_id": tool_id,
            "reason": "补齐该 finding 的事实层统计与 metric_refs 后再判断接受/否定。",
            "fallback_tool_id": "adhoc_synthesis",
        }
    return {
        "decision": "pending",
        "tool_id": "LLM-revise",
        "reason": "补齐闭环引用、筛选条件或预期影响后再判断。",
        "fallback_tool_id": None,
    }


def _with_rediagnosis_plan(issue: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    issue = dict(issue)
    issue.setdefault("stance", "questioned")
    issue["rediagnosis_plan"] = _rediagnosis_plan(issue, state)
    return issue


def _rediagnosis_plan(issue: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """为被质疑/不接受的结果推荐下一步复诊工具。

    宿主 Agent 执行策略：
      1. 先按 tool_id 调用已有 manifest 工具；
      2. 若现有工具粒度不足或 precondition 失败，使用 fallback_tool_id；
      3. 工具返回后改写对应 finding/action/segment，再重新 assess/critique。
    """
    target = _find_target_payload(state, issue.get("target_kind"), issue.get("target_id"))
    agent = (target or {}).get("agent")
    issue_type = issue.get("type")
    if issue_type == "statistical_coherence":
        return {
            "decision": "reject_until_rediagnosed",
            "tool_id": _AGENT_TOOL_MAP.get(agent, "adhoc_synthesis"),
            "fallback_tool_id": "adhoc_synthesis",
            "reason": "统计值无法复现、CI/p_value/n_total 不支持当前结论，需用事实层工具重算。",
        }
    if issue_type == "business_coherence":
        return {
            "decision": "reject_until_rediagnosed",
            "tool_id": "diagnostic_rules",
            "fallback_tool_id": "adhoc_synthesis",
            "reason": "业务方向与活动设计或模型方向冲突，需做跨维度或模型×统计复核。",
        }
    if issue_type == "closure":
        return {
            "decision": "reject_until_revised",
            "tool_id": "LLM-revise",
            "fallback_tool_id": None,
            "reason": "行动闭环引用不成立，优先修订 action_plan/人群/字段引用。",
        }
    if issue_type == "redundancy":
        return {
            "decision": "reject_until_merged",
            "tool_id": "LLM-merge",
            "fallback_tool_id": None,
            "reason": "结果重复，合并保留证据更强的诊断项。",
        }
    if issue_type == "language_compliance":
        return {
            "decision": "reject_until_revised",
            "tool_id": "LLM-revise",
            "fallback_tool_id": None,
            "reason": "对外文本含规则编号/技术专有词/禁用词/错误渠道词汇，需 LLM 按写作约束改写，不涉及数据重算。",
        }
    if issue_type == "signal_coverage":
        return {
            "decision": "reject_until_revised",
            "tool_id": "diagnostic_rules",
            "fallback_tool_id": "LLM-revise",
            "reason": "强信号未被任何 finding 覆盖：为该规则补 finding，或在 data_caveats 显式说明并入/排除理由。",
        }
    if issue_type == "render_health":
        return {
            "decision": "pending",
            "tool_id": "LLM-revise",
            "fallback_tool_id": None,
            "reason": "渲染模块降级：排查对应 state 数据缺失/异常后修复，再重新 render。",
        }
    return {
        "decision": "pending",
        "tool_id": "adhoc_synthesis",
        "fallback_tool_id": None,
        "reason": "未知 issue 类型，生成临时工具补证据后再判定。",
    }


def _find_target_payload(state: dict[str, Any], target_kind: str | None, target_id: str | None) -> dict | None:
    if not target_kind or not target_id:
        return None
    for item in _iter_result_items(state):
        if item["target_kind"] == target_kind and str(item["target_id"]) == str(target_id):
            return item.get("payload")
    return None
