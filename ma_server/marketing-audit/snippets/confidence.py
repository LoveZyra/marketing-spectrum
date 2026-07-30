"""4 维度置信度评分。

data_coverage 含 diagnostic_rule_coverage 子指标：triggered 或 not_triggered 的规则数 / 总规则数
（合并权重：domain_coverage * 0.5 + rule_coverage * 0.5）；n_agents 由 agent_raw_stats 自动推导。
"""
from __future__ import annotations


def compute_confidence(
    findings: list[dict],
    model_report: dict | None,
    agent_raw_stats: dict,
    n_agents: int | None = None,
    rule_summary: list[dict] | None = None,
) -> dict:
    """4 维度综合置信度评分。

    参数：
        findings         : Step 3/3b 累积的 findings 列表
        model_report     : Step 2 产出（可为 None / 含 backend / auc / note）
        agent_raw_stats  : 6 维度 snippet 输出（dict[str, str|list|dict]）
        n_agents         : 总维度数，None 时自动取 len(agent_raw_stats) or 6
        rule_summary     : diagnostic_engine.rule_summary 输出（list[dict]），
                           含 status 字段；可从 state.data_overview.diagnostic_rules_summary 读取

    返回：含 data_coverage / model_quality / finding_richness / evidence_depth /
         overall / level 的 dict，所有数值严格落在 [0, 1] 区间
    """
    scores: dict[str, float] = {}

    # ── 数据覆盖率 ─────────────────────────────────────────────────────
    # 子指标 1：domain snippet 覆盖率（有实质内容的维度数 / 总维度数）
    def _ok(v) -> bool:
        if v is None:
            return False
        if isinstance(v, str):
            return bool(v.strip()) and "[执行失败]" not in v
        if isinstance(v, (list, dict)):
            return len(v) > 0
        return True

    n_total_agents = n_agents or max(len(agent_raw_stats), 6)
    n_covered_domains = sum(1 for v in agent_raw_stats.values() if _ok(v))
    domain_coverage = round(n_covered_domains / n_total_agents, 2) if n_total_agents else 0.0

    # 子指标 2：诊断规则覆盖率
    # 有效评估：triggered / not_triggered / full_trigger_no_baseline（均已成功评估）
    # 排除 skipped / not_applicable / error（未被评估）。
    rule_coverage = 0.0
    if rule_summary:
        total_rules = len(rule_summary)
        evaluated_rules = sum(
            1 for r in rule_summary
            if r.get("status") in ("triggered", "not_triggered", "full_trigger_no_baseline")
        )
        rule_coverage = round(evaluated_rules / total_rules, 2) if total_rules else 0.0

    # 合并：有规则汇总时 domain+rule 各占 50%，否则退回纯 domain
    if rule_summary:
        scores["data_coverage"] = round(0.5 * domain_coverage + 0.5 * rule_coverage, 2)
    else:
        scores["data_coverage"] = domain_coverage
    scores["domain_coverage"] = domain_coverage
    scores["rule_coverage"] = rule_coverage

    # ── 模型质量 ────────────────────────────────────────────────────────
    mq = 0.0
    if model_report and isinstance(model_report.get("auc"), (int, float)):
        backend = (model_report.get("backend") or "").lower()
        note = (model_report.get("note") or "")
        auc = float(model_report["auc"])
        auc_basis = float(model_report.get("auc_ci_low") or 0.0)
        if auc_basis <= 0.0:
            auc_basis = auc
        skipped = (
            backend in ("", "none")
            or note.startswith("[跳过]")
            or auc <= 0.5
        )
        if not skipped:
            mq = max(0.0, min((auc_basis - 0.5) / 0.4, 1.0))
            if note.startswith("[低样本量·强]") or "n<200" in note:
                mq *= 0.3
            elif note.startswith("[低样本量·弱]") or note.startswith("[低样本量"):
                mq *= 0.6
    scores["model_quality"] = round(mq, 2)

    # ── 发现丰富度 ──────────────────────────────────────────────────────
    # high finding = is_converted/is_paid CVR 差值显著的触发规则
    high_cnt = sum(1 for f in findings if f.get("severity") == "high")
    mid_cnt = sum(1 for f in findings if f.get("severity") == "mid")
    scores["finding_richness"] = round(min((high_cnt * 2 + mid_cnt) / 10, 1.0), 2)

    # ── 证据深度 ────────────────────────────────────────────────────────
    with_evidence = sum(1 for f in findings if (f.get("detail") or "").strip())
    scores["evidence_depth"] = round(with_evidence / max(len(findings), 1), 2)

    # ── 加权综合 ────────────────────────────────────────────────────────
    weights = {"data_coverage": 0.3, "model_quality": 0.3,
               "finding_richness": 0.2, "evidence_depth": 0.2}
    overall = sum(scores[k] * weights[k] for k in weights)
    overall = max(0.0, min(1.0, overall))
    scores["overall"] = round(overall, 2)

    if overall >= 0.75:
        scores["level"] = "高"
    elif overall >= 0.5:
        scores["level"] = "中"
    else:
        scores["level"] = "低"

    return scores


def compute_confidence_from_state(state: dict) -> dict:
    """便捷包装：直接从 state dict 提取参数并调用 compute_confidence()。

    用法（SKILL.md 推荐调用方式）：
        from snippets.confidence import compute_confidence_from_state
        state["confidence"] = compute_confidence_from_state(state)
    """
    ov = state.get("data_overview") or {}
    return compute_confidence(
        findings     = state.get("findings") or [],
        model_report = state.get("model_analysis"),
        agent_raw_stats = state.get("agent_raw_stats") or {},
        rule_summary = ov.get("diagnostic_rules_summary"),
    )
