"""诊断规则批量评估引擎。

设计原则
========
- DiagnosticEngine 是纯统计层：只计算触发率和分布，不写诊断结论
- 结论由宿主 Agent 基于 methodology/08_diagnostic_rules.md 生成
- 添加新规则只需在 feature_schema/diagnostic_rules.yaml 中增加条目
- 阈值占位符 threshold(field, stat) 在运行时由 adaptive_thresholds 替换
"""
from __future__ import annotations

import logging
import re
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .feature_loader import FeatureLoader
from .stats_utils import chi2_test

try:
    import yaml
    _YAML_OK = True
except ImportError:
    _YAML_OK = False

logger = logging.getLogger(__name__)

_RULES_PATH = Path(__file__).resolve().parent.parent / "feature_schema" / "diagnostic_rules.yaml"

# 当某字段的阈值在 adaptive_thresholds 中找不到时，不触发规则（安全降级）
_MISSING_THRESHOLD_SENTINEL = float("inf")


def _load_rules(path: Path | None = None) -> list[dict]:
    p = path or _RULES_PATH
    if not _YAML_OK:
        raise ImportError("pyyaml 未安装，请执行: pip install pyyaml")
    with open(p, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return data.get("rules", [])


def _resolve_threshold_placeholder(
    template: str,
    adaptive_thresholds: dict[str, dict],
) -> tuple[str, list[str]]:
    """将 condition_template 中的 threshold(field, stat) 替换为实际数值。

    返回 (resolved_condition, warnings_list)
    """
    pattern = re.compile(r"threshold\(['\"]([^'\"]+)['\"]\s*,\s*['\"]([^'\"]+)['\"]\)")
    warnings_out: list[str] = []
    resolved = template

    for match in pattern.finditer(template):
        field, stat = match.group(1), match.group(2)
        field_thresholds = adaptive_thresholds.get(field, {})
        value = field_thresholds.get(stat) or field_thresholds.get("optimal")
        if value is None:
            value = _MISSING_THRESHOLD_SENTINEL
            warnings_out.append(f"字段 '{field}' 的 '{stat}' 阈值未计算，使用 inf（规则不会触发）")
        resolved = resolved.replace(match.group(0), str(value))

    return resolved, warnings_out


def _is_nan(v) -> bool:
    """None や NaN チェック。"""
    import math as _m
    try:
        return _m.isnan(float(v))
    except Exception:
        return False


class DiagnosticEngine:
    """规则驱动的诊断评估引擎。

    用法
    ----
    engine = DiagnosticEngine(adaptive_thresholds, loader)
    summary = engine.rule_summary(df)           # 全部 42 条规则的触发率汇总
    result = engine.apply_single(rule_id=2, df) # 单条规则评估
    all_results = engine.apply_all(df)          # 全量评估
    """

    # ── 维度级活动渠道门槛 ──────────────────────────────────────────────
    # 某些诊断维度只在特定"活动渠道类型"下才成立，与用户历史触点无关。
    # 站内外衔接（站外广告→站内承接）只在活动本身是「广告投放(ads)」时才有意义；
    # 活动/弹屏/push/短信等非广告活动即便用户历史有广告触点，也不计算该维度。
    # 这是类别级硬约束：即使将来在该类别下新增规则、且作者忘了写 channel_filter，
    # 也会被此门槛拦截，从根本上避免"非广告活动误诊站内外衔接"复发。
    _CAMPAIGN_CHANNEL_GATED_CATEGORIES: dict[str, set[str]] = {
        "站内外衔接": {"ads"},
    }

    def __init__(
        self,
        adaptive_thresholds: dict[str, dict],
        loader: FeatureLoader,
        rules_path: Path | str | None = None,
        cvr_col: str = "is_paid",
    ) -> None:
        self._thresholds = adaptive_thresholds
        self._loader = loader
        self._rules = _load_rules(Path(rules_path) if rules_path else None)
        self._rule_map: dict[int, dict] = {r["id"]: r for r in self._rules}
        self._cvr_col = cvr_col  # 转化标签列名，默认 is_paid（实际付款）

    def _campaign_channel(self, df: pd.DataFrame) -> str | None:
        """当前活动的渠道类型 = activity_channel_std 的主导值（一份数据=一个活动）。"""
        if "activity_channel_std" not in df.columns:
            return None
        vals = df["activity_channel_std"].dropna()
        if vals.empty:
            return None
        return str(vals.mode().iloc[0])

    # ── 主接口 ───────────────────────────────────────────────────────────

    def apply_all(self, df: pd.DataFrame) -> list[dict]:
        """对所有规则批量评估，返回每条规则的评估结果列表。

        结果格式（每条）:
        {
          "rule_id": 2,
          "category": "触达质量",
          "name": "过度营销骚扰",
          "status": "triggered" | "skipped" | "not_applicable" | "error",
          "trigger_rate": 0.15,           # 触发行占比
          "trigger_cnt": 1500,            # 触发行数
          "total_cnt": 10000,             # 参与评估的行数
          "converted_in_triggered": 0.02, # 触发行的 CVR（如果 is_converted 存在）
          "converted_in_not_triggered": 0.06,
          "cvr_gap": -0.04,               # 触发行与未触发行 CVR 差（负值=触发行 CVR 更低）
          "threshold_used": {"activity_touch_cnt": 3.0},  # 本规则实际使用的阈值
          "skip_reason": null,            # 跳过原因
          "warnings": [],                 # 计算过程中的警告
        }
        """
        results = []
        for rule in self._rules:
            results.append(self._evaluate_rule(rule, df))
        return results

    def apply_single(self, rule_id: int, df: pd.DataFrame) -> dict:
        """评估单条规则，供 Agent 按需调用。"""
        rule = self._rule_map.get(rule_id)
        if rule is None:
            return {"rule_id": rule_id, "status": "error", "skip_reason": f"规则 #{rule_id} 不存在"}
        return self._evaluate_rule(rule, df)

    # 大类执行难易度（ease越高=越容易执行）
    _CATEGORY_EASE: dict = {
        "触达质量":   0.90, "创单前营销": 0.85, "转化效率": 0.75,
        "优惠机制":   0.70, "时机匹配":   0.65, "内容匹配": 0.60,
        "决策效率":   0.50, "用户价值":   0.45, "流程体验": 0.40,
        "关键打断":   0.35, "站内外衔接": 0.30,
        # 兜底：历史"其他"类别保留权重，避免未迁移规则掉到默认 0.5
        "其他":       0.55,
    }

    def rule_summary(self, df: pd.DataFrame) -> pd.DataFrame:
        """返回所有规则的触发率汇总 DataFrame，含评分字段供 Top N 筛选。

        新增列：
          is_definitional      : 触发条件含"未转化"语义，CVR=0% 是逻辑必然
          is_positive_signal   : 触发用户 CVR > 未触发用户（正向信号）
          _ease                : 执行难易度（来自 CATEGORY_EASE）
          _score               : 综合评分 = |cvr_gap| × trigger_rate × ease × (1+sev_bonus) × penalty × bonus
        """
        results = self.apply_all(df)
        rows = []
        for r in results:
            rule_meta = self._rule_map.get(r["rule_id"], {})
            is_def = bool(rule_meta.get("is_definitional", False))
            is_pos = bool(rule_meta.get("is_positive_signal", False))
            ease   = self._CATEGORY_EASE.get(rule_meta.get("category", ""), 0.5)
            sev    = rule_meta.get("severity_base", "mid")
            # 解析后的触发行为条件，供下游为任意规则生成人群包筛选条件（不含渠道过滤）
            _cond_tmpl = rule_meta.get("condition_template")
            _resolved_cond = (_resolve_threshold_placeholder(_cond_tmpl, self._thresholds)[0]
                              if _cond_tmpl else None)
            sev_bonus = {"high": 0.3, "mid": 0.1, "low": 0.0}.get(sev, 0.0)

            cvr_t   = r.get("converted_in_triggered")
            cvr_nt  = r.get("converted_in_not_triggered")
            cvr_gap = r.get("cvr_gap")
            tr      = r.get("trigger_rate") or 0.0
            tc      = r.get("trigger_cnt") or 0

            # ── 触发组 vs 对照组 CVR 差异的卡方显著性 ──
            # 与 6 个领域分析口径一致（chi2_test），让 42 条规则诊断也具备统计显著性约束
            # （README「统计显著性约束」原则）。scipy 缺失或样本不足时 p_value=None（不阻断）。
            cvr_gap_p_value = None
            _total_cnt = int(r.get("total_cnt") or 0)
            if (cvr_t is not None and not _is_nan(cvr_t)
                    and cvr_nt is not None and not _is_nan(cvr_nt)
                    and tc > 0 and _total_cnt > tc):
                _n_trig = int(tc)
                _n_non = _total_cnt - _n_trig
                _conv_trig = int(round(float(cvr_t) * _n_trig))
                _conv_non = int(round(float(cvr_nt) * _n_non))
                if _n_non > 0:
                    _, _pv, _ = chi2_test([
                        [_conv_trig, _n_trig - _conv_trig],
                        [_conv_non, _n_non - _conv_non],
                    ])
                    if _pv is not None and not _is_nan(_pv):
                        cvr_gap_p_value = round(float(_pv), 6)
            cvr_gap_significant = bool(cvr_gap_p_value is not None and cvr_gap_p_value < 0.05)

            # ── 正向信号显著性校验（相对效应量口径，基差无关）──
            # 改用「相对效应量」rel=|gap|/对照CVR：成单/创单率基数稀疏时绝对 pp 阈值会把低转化
            # 活动的真实信号全部挡掉（如 0.04% 转化活动任何 gap 都 <1.5pp）。要求：触发CVR>对照、
            # rel≥30%（与严重度 mid 档一致）、触发样本≥100，才算显著正向。
            REL_MIN        = 0.30   # 相对效应量 ≥ 30%
            POS_SAMPLE_MIN = 100
            try:
                gap_val = float(cvr_gap) if (cvr_gap is not None and not _is_nan(cvr_gap)) else None
            except Exception:
                gap_val = None
            cn_ref_eff = (float(cvr_nt) if (cvr_nt is not None and not _is_nan(cvr_nt)
                                            and float(cvr_nt) > 0) else 0.0)
            rel_eff = (abs(gap_val) / cn_ref_eff) if (cn_ref_eff > 0 and gap_val is not None) else 0.0
            significant_positive = bool(
                gap_val is not None and gap_val > 0 and rel_eff >= REL_MIN and tc >= POS_SAMPLE_MIN
            )
            # YAML 标记的 is_positive_signal 仅作候选，最终由显著性确认
            final_positive = significant_positive

            # ── 评分惩罚/加成──
            is_full_trig = (r.get("status") == "full_trigger_no_baseline")
            is_zero_cvr  = (cvr_t is not None and not _is_nan(cvr_t) and float(cvr_t) == 0.0)
            # 定义性规则 / CVR=0 规则：不参与 cvr_gap 评分，仅用 trigger_rate 衡量规模
            use_scale_only = is_def or is_zero_cvr

            _score: float = 0.0
            if is_full_trig:
                _score = 0.0  # 无对照组，不评分
            elif use_scale_only:
                # 定义性规则：仅用 trigger_rate 衡量规模，强降权 0.05，
                # 确保不挤占真实因果信号的 Top 位次
                _score = tr * ease * 0.05
            elif gap_val is not None and tr > 0:
                bonus = 1.5 if final_positive else 1.0
                _score = abs(gap_val) * tr * ease * (1 + sev_bonus) * bonus

            signal_type = ("definitional" if use_scale_only
                           else "positive" if final_positive
                           else "full_trigger" if is_full_trig
                           else "causal")

            # ── 泄漏/同义反复护栏──
            # 触发组 CVR≈100% 说明触发条件本身蕴含转化语义（如"营销触发下单未成单"），
            # 该"正向"是定义必然而非可干预信号。标 is_leakage，剔出有效信号，
            # 由 draft 重述为创单→支付漏损问题，而非"正向机会"。
            LEAKAGE_CVR = 0.99
            is_leakage = bool(
                signal_type == "positive"
                and cvr_t is not None and not _is_nan(cvr_t)
                and float(cvr_t) >= LEAKAGE_CVR
            )

            # ── 有效信号标记（相对效应量口径，基差无关）──
            # 真正值得 Agent 优先看的信号：已触发的因果/正向规则，相对效应量达标
            # （rel=|gap|/对照CVR ≥ 30%、触发样本 ≥ 100），且差异卡方显著。绝对 pp 阈值对
            # 低转化活动（如 0.04%）天然不可达，改用相对口径；定义性/full_trigger/泄漏规则不算。
            effective_signal = bool(
                r.get("status") == "triggered"
                and signal_type in ("causal", "positive")
                and not is_leakage
                and gap_val is not None
                and rel_eff >= REL_MIN
                and tc >= POS_SAMPLE_MIN
                # 统计显著性门槛：差异须通过卡方检验（p<0.05）；p_value 不可得时（无 scipy）
                # 按原逻辑放行，保证降级环境下行为不变。
                and (cvr_gap_p_value is None or cvr_gap_significant)
            )

            # ── 展示名（修复正向信号"绿标配负向规则名"矛盾）──
            # 规则中文名编码的是负向假设（如"僵尸用户浪费营销"）。当数据把该规则判为正向信号时，
            # 用 YAML positive_alias 给出中性/正向展示名；缺省退回"<类别>·正向机会"，绝不把负向名
            # 挂在绿色正向卡上。负向/定义性规则仍用原名。
            pos_alias = rule_meta.get("positive_alias", "")
            display_name = ((pos_alias or f"{r['category']}·正向机会")
                            if final_positive else r["name"])

            rows.append({
                "rule_id":            r["rule_id"],
                "category":           r["category"],
                "name":               r["name"],
                "display_name":       display_name,
                "positive_alias":     pos_alias,
                "status":             r["status"],
                "trigger_rate":       r.get("trigger_rate"),
                "trigger_cnt":        r.get("trigger_cnt"),
                "total_cnt":          r.get("total_cnt"),
                "cvr_triggered":      cvr_t,
                "cvr_not_triggered":  cvr_nt,
                "cvr_gap":            cvr_gap,
                "cvr_gap_p_value":    cvr_gap_p_value,
                "cvr_gap_significant": cvr_gap_significant,
                "channel_filter":     rule_meta.get("channel_filter", "all"),
                "condition":          _resolved_cond,
                "severity_base":      sev,
                "skip_reason":        r.get("skip_reason"),
                "is_definitional":    is_def,
                "is_positive_signal": final_positive,
                "positive_reason":    rule_meta.get("positive_signal_reason", "") if final_positive else "",
                "_ease":              ease,
                "_score":             _score,
                "_signal_type":       signal_type,
                "is_leakage":         is_leakage,
                "effective_signal":   effective_signal,
            })
        return pd.DataFrame(rows)

    def get_triggered_rows(self, rule_id: int, df: pd.DataFrame) -> pd.DataFrame:
        """返回触发某条规则的行子集，供深入分析使用。"""
        rule = self._rule_map.get(rule_id)
        if rule is None or rule.get("condition_template") is None:
            return pd.DataFrame()
        mask = self._eval_mask(rule, df)
        if mask is None:
            return pd.DataFrame()
        return df[mask].copy()

    # 规则主阈值字段映射（用于在 signal 中标注阈值）
    _RULE_THRESHOLD_FIELD: dict = {
        1: "pre_mainflow_event_cnt", 2: "activity_touch_cnt", 5: "pre_total_event_cnt",
        7: "pre_last_order_to_touch_min",
        15: "pre_last_mainflow_to_touch_min",
        23: "pre_product_category_cnt", 24: "pre_back_to_list_cnt", 25: "pre_create_order_cnt",
        35: "pre_popup_touch_cnt", 37: "insite_channel_cnt",
    }

    def draft_findings_from_rules(
        self, rule_summary: list[dict] | None = None,
        top_n: int = 6, min_score: float = 0.0,
    ) -> list[dict]:
        """从规则汇总自动草拟候选 finding 骨架，减少宿主 Agent 手写负担。

        宿主 Agent 拿到草稿后只需润色 signal/detail 叙述并补充业务影响，
        metric_refs 已按标准键名（cvr_triggered 等）填好，无需手拼。

        筛选逻辑（按 _signal_type 分层）：
          - causal / positive：按 _score 降序取（真实因果/正向信号优先）
          - definitional：按 trigger_rate 降序补充（结构性问题，关注规模）
          - 排除 not_applicable / skipped / full_trigger_no_baseline（无诊断价值）

        Args:
            rule_summary : diagnostic_rules_summary（list[dict]）；None 时需先调 rule_summary()
            top_n        : 草拟数量上限
            min_score    : _score 下限过滤

        Returns:
            list[dict]，每条含 id/agent/rule_id/signal/severity/detail/metric_refs/
            confidence/_signal_type/_draft（标记为草稿）
        """
        if rule_summary is None:
            raise ValueError("draft_findings_from_rules 需传入 rule_summary（list[dict]）")

        def _ok(v):
            return v is not None and not _is_nan(v)

        # 仅保留有诊断价值的状态；定义性规则不进入核心问题列表（CVR=0% 系触发条件必然）
        candidates = [
            r for r in rule_summary
            if r.get("status") in ("triggered",)
            and r.get("_signal_type") in ("causal", "positive")
            and (r.get("_score") or 0) >= min_score
        ]
        # 因果+正向信号按 score 降序
        ordered = sorted(candidates, key=lambda r: -(r.get("_score") or 0))[:top_n]

        drafts = []
        for r in ordered:
            rid = int(r["rule_id"])
            name = r.get("name", "")
            tr = r.get("trigger_rate")
            tc = r.get("trigger_cnt")
            cvr_t = r.get("cvr_triggered")
            cvr_n = r.get("cvr_not_triggered")
            cvr_g = r.get("cvr_gap")
            stype = r.get("_signal_type")

            tr_s = f"{float(tr)*100:.1f}%" if _ok(tr) else "—"
            ct_s = f"{float(cvr_t)*100:.2f}%" if _ok(cvr_t) else "—"
            cn_s = f"{float(cvr_n)*100:.2f}%" if _ok(cvr_n) else "—"
            gap_s = f"{float(cvr_g)*100:+.2f}pp" if _ok(cvr_g) else "—"

            # 阈值提示
            thresh_hint = ""
            tf = self._RULE_THRESHOLD_FIELD.get(rid)
            if tf and tf in self._thresholds:
                tv = self._thresholds[tf].get("optimal")
                if _ok(tv):
                    thresh_hint = f"（阈值 {tf}={float(tv):.4g}）"

            # 展示口径名（与 cvr_col 一致，默认成单率）
            basis = "成单率" if self._cvr_col == "is_paid" else "创单率"
            # 相对效应量（基差无关）：成单率基数稀疏，绝对 pp 阈值会把大问题误降级
            cn_ref = float(cvr_n) if _ok(cvr_n) else 0.0
            rel = (abs(float(cvr_g)) / cn_ref) if (cn_ref > 0 and _ok(cvr_g)) else 0.0
            # 正向信号用中性/正向展示名，不挂负向规则名
            disp = r.get("display_name") or name

            # 按信号类型生成不同 signal 模板
            if stype == "positive":
                signal = f"{disp}（正向）：{tc}用户（{tr_s}）触发，触发{basis}={ct_s}高于未触发{cn_s}（{gap_s}），是成单正向因子"
                severity = "mid"
                detail = f"「{disp}」正向信号：该行为/特征与高成单相关，建议作为优质人群定向或保护型策略依据。{thresh_hint}"
            elif stype == "definitional":
                signal = f"{name}：{tc}用户（{tr_s}）触发，触发{basis}={ct_s}（定义性，{basis}=0%系规则触发条件含未成单语义）"
                severity = "mid"
                detail = f"「{name}」问题规模 {tr_s}（{tc}人）。诊断价值在于规模，叙述应以触发率为主，不强调 {basis} 差值。{thresh_hint}"
            else:  # causal
                sev_base = r.get("severity_base", "mid")
                # 强相对效应（|gap|≥60%对照）或大体量（覆盖≥10%且≥30%对照）判 high
                scale = (int(tc) / int(r.get("total_cnt") or 0)) if r.get("total_cnt") else 0.0
                severity = "high" if (rel >= 0.60 or (scale >= 0.10 and rel >= 0.30)) else sev_base
                signal = f"{name}：{tc}用户（{tr_s}）触发，触发{basis}={ct_s} vs 未触发{cn_s}，差距{gap_s}"
                detail = f"「{name}」触发率{tr_s}（{tc}人），{basis}差距{gap_s}。{thresh_hint}"

            drafts.append({
                "id": f"fnd_r{rid}",
                "agent": "diagnostic_rules",
                "rule_id": rid,
                "signal": signal,
                "severity": severity,
                "detail": detail,
                "metric_refs": [
                    {"name": "cvr_triggered",     "value": cvr_t, "n_event": tc},
                    {"name": "cvr_not_triggered", "value": cvr_n},
                    {"name": "cvr_gap",           "value": cvr_g},
                    {"name": "trigger_rate",      "value": tr},
                    {"name": "n_event",           "value": tc},
                ],
                "confidence": 0.85,
                "_signal_type": stype,
                "_draft": True,  # 标记为草稿，宿主 Agent 需润色后去除
            })
        return drafts

    # ── 内部实现 ─────────────────────────────────────────────────────────

    def _evaluate_rule(self, rule: dict, df: pd.DataFrame) -> dict:
        """评估单条规则，返回结果 dict。"""
        rid = rule["id"]
        base = {
            "rule_id": rid,
            "category": rule.get("category", ""),
            "name": rule.get("name", ""),
            "status": "pending",
            "trigger_rate": None,
            "trigger_cnt": None,
            "total_cnt": None,
            "converted_in_triggered": None,
            "converted_in_not_triggered": None,
            "cvr_gap": None,
            "threshold_used": {},
            "skip_reason": None,
            "warnings": [],
        }

        # auto_eval=false 标记的规则（如 #4 人群质量）跳过
        if not rule.get("auto_eval", True):
            base["status"] = "not_applicable"
            base["skip_reason"] = "需接入外部数据，无法自动评估"
            return base

        # ── 维度级活动渠道门槛：某些维度只在特定活动渠道类型下才适用 ──
        gate = self._CAMPAIGN_CHANNEL_GATED_CATEGORIES.get(rule.get("category", ""))
        if gate:
            camp_ch = self._campaign_channel(df)
            if camp_ch is not None and camp_ch not in gate:
                base["status"] = "not_applicable"
                base["skip_reason"] = (
                    f"「{rule.get('category')}」维度仅在活动渠道为 {sorted(gate)} 时诊断；"
                    f"当前活动渠道为「{camp_ch}」，不适用"
                )
                return base

        # 检查必要字段是否存在 / 是否全量缺失
        required = rule.get("required_fields", [])
        missing_req = [f for f in required if f not in df.columns]
        if missing_req:
            base["status"] = "skipped"
            base["skip_reason"] = f"必要字段缺失: {missing_req}"
            return base
        # 字段存在但全量 null（ETL 未回填） → 也标记 skipped 并给出明确原因
        all_null_fields = [
            f for f in required
            if f in df.columns and df[f].isna().all()
        ]
        if all_null_fields:
            base["status"] = "skipped"
            base["skip_reason"] = f"字段全量缺失(ETL未回填): {all_null_fields}"
            return base

        # condition_template 为 null 的规则跳过
        condition = rule.get("condition_template")
        if condition is None:
            base["status"] = "not_applicable"
            base["skip_reason"] = "无自动评估条件"
            return base

        # ── channel_filter：仅在适用渠道子集上评估规则──
        channel_filter = rule.get("channel_filter", "all")
        if channel_filter and channel_filter != "all":
            ch_mask = self._eval_mask_from_condition(channel_filter, df)
            if ch_mask is None:
                base["warnings"].append(f"channel_filter 解析失败: {channel_filter}")
            else:
                n_match = int(ch_mask.sum())
                if n_match == 0:
                    base["status"] = "not_applicable"
                    base["skip_reason"] = f"channel_filter「{channel_filter}」无匹配行（当前渠道类型不适用此规则）"
                    return base
                # 在适用渠道子集上评估
                df = df[ch_mask]
                base["channel_filtered_n"] = n_match

        # 解析阈值占位符
        resolved_condition, warns = _resolve_threshold_placeholder(condition, self._thresholds)
        base["warnings"].extend(warns)

        # 记录本规则实际使用的阈值
        for tf in rule.get("threshold_fields", []):
            field = tf["field"]
            stat = tf.get("stat", "optimal")
            val = self._thresholds.get(field, {}).get(stat)
            base["threshold_used"][field] = val

        # 计算触发 mask
        mask = self._eval_mask_from_condition(resolved_condition, df)
        if mask is None:
            base["status"] = "error"
            base["skip_reason"] = "条件计算失败（查看 warnings）"
            return base

        total = len(df)
        trigger_cnt = int(mask.sum())
        base["trigger_cnt"] = trigger_cnt
        base["total_cnt"] = total
        base["trigger_rate"] = round(trigger_cnt / total, 4) if total else 0
        # 100% 触发时无对照组 → 特殊状态，无法量化 CVR 差值
        if trigger_cnt == total:
            base["status"] = "full_trigger_no_baseline"
        else:
            base["status"] = "triggered" if trigger_cnt > 0 else "not_triggered"

        # 触发行 vs 未触发行的 CVR 对比（使用 self._cvr_col，默认 is_converted）
        cvr_col = self._cvr_col if self._cvr_col in df.columns else (
            "is_converted" if "is_converted" in df.columns else None
        )
        if cvr_col and total > 0:
            tgt = df[cvr_col]
            if mask.sum() > 0:
                base["converted_in_triggered"] = round(float(tgt[mask].mean()), 4)
            not_mask = ~mask
            if not_mask.sum() > 0:
                base["converted_in_not_triggered"] = round(float(tgt[not_mask].mean()), 4)
            if (base["converted_in_triggered"] is not None
                    and base["converted_in_not_triggered"] is not None):
                base["cvr_gap"] = round(
                    base["converted_in_triggered"] - base["converted_in_not_triggered"], 4
                )

        return base

    def _eval_mask(self, rule: dict, df: pd.DataFrame) -> pd.Series | None:
        """从规则对象计算触发 mask（带阈值替换）。"""
        condition = rule.get("condition_template")
        if condition is None:
            return None
        resolved, _ = _resolve_threshold_placeholder(condition, self._thresholds)
        return self._eval_mask_from_condition(resolved, df)

    def _eval_mask_from_condition(self, condition: str, df: pd.DataFrame) -> pd.Series | None:
        """将条件字符串求值为布尔 Series。

        使用 df.eval() 优先，对含 .str.contains / .isna() 等 pandas 方法的表达式
        退回到 Python eval()。
        """
        # 方法 1：尝试 df.eval()（不支持 pandas 方法调用）
        # 如果条件包含 .isin / .isna / .notna / .str 等方法，直接走方法 2
        _pandas_method_pattern = re.compile(
            r"\.(isin|isna|notna|str\.|fillna|dt\.)", re.IGNORECASE
        )
        if not _pandas_method_pattern.search(condition):
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    mask = df.eval(condition)
                if isinstance(mask, pd.Series) and mask.dtype == bool:
                    return mask.fillna(False)
            except Exception:
                pass

        # 方法 2：在包含 df 列名的局部命名空间中 eval（允许 pandas 方法调用）
        try:
            # 检测条件中涉及 datetime 运算的列（如 convert_time - last_touch_time）并预转换
            # 模式：对象类型列在 condition 里出现且 condition 含 .dt. 操作符
            _dt_hint = re.compile(r"\.dt\.", re.IGNORECASE)
            _needs_dt_parse = _dt_hint.search(condition) is not None
            local_ns: dict[str, Any] = {}
            for col in df.columns:
                series = df[col]
                if (
                    _needs_dt_parse
                    and col in condition
                    and series.dtype == object
                    and series.notna().sum() > 0
                ):
                    # 尝试解析为 datetime；失败则保留原列
                    try:
                        series = pd.to_datetime(series, errors="coerce")
                    except Exception:
                        pass
                local_ns[col] = series
            local_ns["pd"] = pd
            local_ns["np"] = np
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                result = eval(condition, {"__builtins__": {}}, local_ns)  # noqa: S307
            if isinstance(result, pd.Series):
                return result.fillna(False).astype(bool)
            if isinstance(result, (bool, np.bool_)):
                return pd.Series(bool(result), index=df.index)
        except Exception as e:
            logger.debug("DiagnosticEngine: 条件求值失败: %s → %s", condition, e)

        return None

    # ── 报告生成 ─────────────────────────────────────────────────────────

    def format_rule_summary_md(self, df: pd.DataFrame) -> str:
        """生成 Markdown 格式的规则触发汇总表，供 thresholds_report.md 附录使用。"""
        summary_df = self.rule_summary(df)
        if summary_df.empty:
            return "（无规则评估结果）"

        eff = summary_df[summary_df.get("effective_signal", False) == True] if "effective_signal" in summary_df else summary_df.iloc[0:0]
        eff_names = "、".join(f"{int(r['rule_id'])} {r['name']}" for _, r in eff.iterrows()) or "（无）"

        lines = [
            "## 诊断规则触发率汇总",
            "",
            f'> ⭐ **有效信号优先看**（共 {len(eff)} 条）：已触发的因果/正向规则且效应量达标（相对效应量 |CVR差|/对照CVR≥30%、触发样本≥100、卡方 p<0.05），是值得优先诊断的条目，其余 triggered 多为定义性或近零差值的规模型条目。',
            f'> 有效信号清单：{eff_names}',
            "",
            '> ⚠️ **定义性规则**（`[定义]` 标注）：触发条件本身包含“未转化”语义，CVR=0% 是逻辑必然，**不代表真实因果信号**，以触发规模为主要诊断依据。',
            '> \U0001f7e9 **正向机会**（`[正向]` 标注）：触发行 CVR 高于对照组，说明存在可保护的正向信号。',
            "",
            "| # | 分类 | 问题名称 | 状态 | 触发率 | 触发行数 | CVR(触发) | CVR(未触发) | CVR差 | 显著性 | 信号类型 | 有效 |",
            "|:---:|---|---|:---:|---:|---:|---:|---:|---:|:---:|:---:|:---:|",
        ]
        for _, row in summary_df.iterrows():
            status_icon = {
                "triggered": "🔴",
                "not_triggered": "🟢",
                "skipped": "⚪",
                "not_applicable": "—",
                "error": "⚠️",
            }.get(row.get("status", ""), "?")

            trigger_rate = f"{row['trigger_rate']*100:.1f}%" if pd.notna(row.get("trigger_rate")) else "—"
            trigger_cnt = f"{int(row['trigger_cnt']):,}" if pd.notna(row.get("trigger_cnt")) else "—"
            cvr_t = f"{row['cvr_triggered']*100:.2f}%" if pd.notna(row.get("cvr_triggered")) else "—"
            cvr_nt = f"{row['cvr_not_triggered']*100:.2f}%" if pd.notna(row.get("cvr_not_triggered")) else "—"
            cvr_gap = f"{row['cvr_gap']*100:+.2f}pp" if pd.notna(row.get("cvr_gap")) else "—"

            signal_type = row.get("_signal_type", "")
            signal_badge = {
                "definitional": "⚠️ [定义]",
                "positive":     "🟩 [正向]",
                "causal":       "📊 [因果]",
                "full_trigger": "🔲 [全触发]",
            }.get(signal_type, "")

            eff_badge = "⭐" if row.get("effective_signal", False) else ""

            _pv = row.get("cvr_gap_p_value")
            if pd.notna(_pv) if _pv is not None else False:
                sig_badge = (f"✅ p={_pv:.3f}" if row.get("cvr_gap_significant")
                             else f"⚠️ p={_pv:.3f}")
            else:
                sig_badge = "—"

            lines.append(
                f"| {row['rule_id']} | {row['category']} | {row['name']} "
                f"| {status_icon} {row['status']} | {trigger_rate} | {trigger_cnt} "
                f"| {cvr_t} | {cvr_nt} | {cvr_gap} | {sig_badge} | {signal_badge} | {eff_badge} |"
            )

        return "\n".join(lines)
