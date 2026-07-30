"""report_validator — 用 schemas/*.json 校验 state / report 合规性。

依赖 `jsonschema`（pip install jsonschema）。如果该包不可用，会降级为"宽松检查"：
仅做结构性检查（关键字段存在性 + 类型），不做 schema 全量校验。

公开函数：
  - validate_finding(obj)               -> list[str] (问题列表，空则通过)
  - validate_audience_segment(obj)      -> list[str]
  - validate_action(obj)                -> list[str]
  - validate_report(report)             -> list[str]
  - lint_report(report)                 -> list[str]
       结合 schema + methodology/03 的"写作约束"做软性 lint（禁用词检测等）
"""
from __future__ import annotations

import json
import re
from pathlib import Path

SCHEMAS_DIR = Path(__file__).resolve().parents[1] / "schemas"

# 哨兵词：覆盖全量用户，不需要在 audience_segments 中显式定义
ALLUSERS_SENTINELS = {
    "全量", "全量用户", "全体", "全体用户", "所有用户", "all", "all users", "全部",
}

# 与 methodology/03_synthesis.md 的禁用词清单保持一致
FORBIDDEN_WORDS = [
    "或可能", "似乎", "存在风险", "主因之一", "有待", "建议关注",
    "需要进一步分析", "初步判断", "可能是", "或许",
    "本次诊断", "分析显示", "AI", "Agent",
    "根据数据可知", "经过分析", "我们认为", "我认为",
]

# ── jsonschema 可选依赖 ───────────────────────────────────────────────


def _try_import_jsonschema():
    try:
        import jsonschema  # type: ignore
        return jsonschema
    except ImportError:
        return None


_JS = _try_import_jsonschema()


def _load_schema(name: str) -> dict:
    path = SCHEMAS_DIR / f"{name}.schema.json"
    if not path.exists():
        return {}
    with open(path, encoding="utf-8") as f:
        return json.load(f)


_SCHEMAS = {
    "finding": _load_schema("finding"),
    "audience_segment": _load_schema("audience_segment"),
    "action": _load_schema("action"),
    "report": _load_schema("report"),
}


def _build_registry():
    """构造一个 referencing.Registry，把所有 schema 注册成可被 $ref 引用的资源。

    `report.schema.json` 引用了 `finding.schema.json` 等相对路径；
    jsonschema 4.18+ 默认会试图把这些路径当 URL 拉取，必须显式注册。
    """
    if _JS is None:
        return None
    try:
        from referencing import Registry, Resource
        from referencing.jsonschema import DRAFT7
    except ImportError:
        return None
    resources = []
    for name, sch in _SCHEMAS.items():
        if not sch:
            continue
        # 同时注册短名（finding.schema.json）与完整 file:// uri
        resources.append((f"{name}.schema.json", Resource(contents=sch, specification=DRAFT7)))
    return Registry().with_resources(resources)


_REGISTRY = _build_registry()


# ── 基础校验 ──────────────────────────────────────────────────────────


def _validate_against(obj: dict, schema_name: str) -> list[str]:
    schema = _SCHEMAS.get(schema_name) or {}
    if not schema:
        return [f"[warn] schema {schema_name} not found"]

    errors: list[str] = []
    if _JS is not None:
        try:
            if _REGISTRY is not None:
                # 使用 validator + registry，正确解析跨文件 $ref
                validator_cls = _JS.validators.validator_for(schema)
                validator = validator_cls(schema, registry=_REGISTRY)
                for err in validator.iter_errors(obj):
                    path = ".".join(str(p) for p in getattr(err, "path", []) or [])
                    errors.append(f"{schema_name}[{path or '<root>'}]: {err.message}")
            else:
                _JS.validate(instance=obj, schema=schema)
        except _JS.ValidationError as e:
            path = ".".join(str(p) for p in getattr(e, "path", []) or [])
            errors.append(f"{schema_name}[{path or '<root>'}]: {e.message}")
        except Exception as e:
            # 任何 referencing 解析异常都降级为单条警告，不阻断
            errors.append(f"[warn] {schema_name}: {type(e).__name__}: {e}")
        return errors

    # 降级：宽松检查 required 字段
    required = schema.get("required", [])
    for key in required:
        if key not in obj or obj[key] in (None, ""):
            errors.append(f"{schema_name}: missing required field `{key}`")
    return errors


def validate_finding(obj: dict) -> list[str]:
    return _validate_against(obj, "finding")


def validate_audience_segment(obj: dict) -> list[str]:
    return _validate_against(obj, "audience_segment")


def validate_action(obj: dict) -> list[str]:
    return _validate_against(obj, "action")


def normalize_target_audiences(report: dict) -> dict:
    """把 action_plan.priority_actions[].target_audiences 中的纯字符串升格为
    `{name, matched}` 对象（matched 自动用 audience_segments.name 集合判断）。

    schema 现在用 oneOf 同时接受字符串与对象，但下游程序化消费（圈人系统等）
    通常需要对象形态拿 matched 标记；这个 helper 让宿主 Agent 一行调用即可。

    原地修改并返回 report，便于链式调用。
    """
    seg_names = {s.get("name") for s in report.get("audience_segments", []) if isinstance(s, dict)}
    seg_names |= ALLUSERS_SENTINELS
    plan = report.get("action_plan") or {}
    for act in plan.get("priority_actions", []):
        wrapped = []
        for ta in act.get("target_audiences", []):
            if isinstance(ta, str):
                wrapped.append({"name": ta, "matched": ta in seg_names})
            elif isinstance(ta, dict) and "matched" not in ta and "name" in ta:
                ta["matched"] = ta["name"] in seg_names
                wrapped.append(ta)
            else:
                wrapped.append(ta)
        act["target_audiences"] = wrapped
    return report


def validate_report(report: dict) -> list[str]:
    """对整体 report 做 schema 校验 + 逐条校验 findings/audience_segments/priority_actions。"""
    errors: list[str] = []
    errors += _validate_against(report, "report")

    for i, f in enumerate(report.get("findings") or []):
        errors += [f"findings[{i}].{e}" for e in validate_finding(f)]

    for i, s in enumerate(report.get("audience_segments") or []):
        errors += [f"audience_segments[{i}].{e}" for e in validate_audience_segment(s)]

    plan = report.get("action_plan") or {}
    for i, a in enumerate(plan.get("priority_actions") or []):
        errors += [f"action_plan.priority_actions[{i}].{e}" for e in validate_action(a)]

    # headline 字数硬门槛（30-60 字）。
    # 推荐区间仍是 30-50（见 lint_report 的软警告）；中文 headline 含活动名+2 个数字+判断
    # 时常落在 50-60，硬上限放宽到 60 避免仅因 1-2 字超限阻断 render。
    narratives = report.get("narratives") or {}
    headline = narratives.get("headline", "") if isinstance(narratives, dict) else ""
    if headline:
        hl_len = len(headline)
        if hl_len < 30:
            errors.append(f"headline 长度 {hl_len} 字 < 30 字（当前：{headline[:40]}）")
        elif hl_len > 60:
            errors.append(f"headline 长度 {hl_len} 字 > 60 字（当前：{headline[:60]}…）")

    return errors


# ── 完整性校验（页面一致性硬保障） ───────────────────────────────────


_STD_CVR_KEYS = {"cvr_triggered", "cvr_not_triggered", "cvr_gap", "trigger_rate", "n_event"}


def lint_report_completeness(report: dict) -> list[dict]:
    """渲染前完整性校验：把"会导致报告页面变残/模块缺失"的问题在 render 前列清单。

    返回 list[dict]，每条含 {level, code, message}：
      - level="block"：会破坏页面结构或编号映射，render 应阻断
      - level="warn" ：页面有占位兜底但内容不完整，提示补齐

    覆盖：
      B1 核心问题数量；B2 每问题 typical_case + evidence 命中；
      B3 主 finding 可画图指标；B4 行动 problem_rank/人群引用；B5 行动覆盖。
    """
    gaps: list[dict] = []

    narratives = report.get("narratives") or {}
    problems = narratives if isinstance(narratives, list) else (narratives.get("problems") or [])
    n_problems = len(problems)
    findings = report.get("findings") or []
    findings_by_id = {f.get("id"): f for f in findings if f.get("id")}
    rules_by_id = {
        r.get("rule_id"): r
        for r in ((report.get("data_overview") or {}).get("diagnostic_rules_summary") or [])
        if r.get("rule_id") is not None
    }
    seg_names = {s.get("name") for s in (report.get("audience_segments") or []) if s.get("name")}
    plan = report.get("action_plan") or {}
    actions = plan.get("priority_actions") or []

    # B1 — 核心问题数量
    if n_problems == 0:
        gaps.append({"level": "block", "code": "no_problems",
                     "message": "narratives.problems 为空：核心问题诊断章节将无内容。至少给出 1 个核心问题。"})
    elif n_problems < 3:
        gaps.append({"level": "warn", "code": "few_problems",
                     "message": f"核心问题仅 {n_problems} 个（推荐≥3）：封面诊断卡偏空，建议补足或提升次优问题。"})

    # B2/B3 — 每个问题：typical_case + evidence 命中 + 主 finding 可画图
    for i, p in enumerate(problems):
        fids = p.get("evidence_finding_ids") or []
        linked = next((findings_by_id[fid] for fid in fids if fid in findings_by_id), None)
        if not p.get("typical_case"):
            gaps.append({"level": "warn", "code": "missing_typical_case",
                         "message": f"problems[{i}]『{p.get('title','')[:18]}』缺 typical_case：该问题无案例块，与其它问题视觉不一致。"})
        if not linked:
            gaps.append({"level": "warn", "code": "evidence_unlinked",
                         "message": f"problems[{i}]『{p.get('title','')[:18]}』的 evidence_finding_ids 未命中任何 finding：无法引证。"})
            continue
        # B3：主 finding 是否可画对比图（标准 CVR 键 或 可由 rule_id 回退）
        has_std = any(m.get("name") in _STD_CVR_KEYS and m.get("value") is not None
                      for m in (linked.get("metric_refs") or []))
        rid = linked.get("rule_id")
        has_rule_data = rid is not None and rid in rules_by_id
        if not has_std and not has_rule_data:
            gaps.append({"level": "warn", "code": "no_chartable_metric",
                         "message": f"problems[{i}] 主 finding『{linked.get('id','')}』无标准 CVR 指标且无 rule_id 可回退：对比图将为占位。"})

    # B4 — 行动 problem_rank 合法性 + 人群引用
    for i, a in enumerate(actions):
        pr = a.get("problem_rank")
        if pr is None or not isinstance(pr, int) or pr < 1 or pr > max(n_problems, 0):
            gaps.append({"level": "block", "code": "bad_problem_rank",
                         "message": f"priority_actions[{i}] 的 problem_rank={pr} 超出范围 [1,{n_problems}]：封面行动卡分组会错位。"})
        for aud in a.get("target_audiences") or []:
            name = aud.get("name") if isinstance(aud, dict) else aud
            if name in ("全量", "全量用户"):
                continue
            if name not in seg_names:
                gaps.append({"level": "warn", "code": "audience_unresolved",
                             "message": f"priority_actions[{i}] 引用人群『{name}』不在 audience_segments：报告中将显示断链。"})

    # B0 — 草稿未润色拦截：draft 产出的骨架不得当作最终报告 render。
    #   仅检测 [待润色] 标记不够——机械去标记（strip "[待润色]" 但不重写）会留下 draft_builder
    #   注入的说明性填充句（"补充业务根因与建议方向"、"（基于 key_features 补一句用户画像）" 等）
    #   以及非方括号的 "（草稿，待润色）"，这些同样是未润色内容。故：
    #     ① "待润色" 裸串（覆盖 [待润色]/（草稿，待润色）/任意变体）
    #     ② draft_builder 的骨架填充签名句（正式润色文案绝不会包含）
    import json as _json
    blob = _json.dumps({"f": findings, "n": narratives,
                        "a": actions, "s": report.get("audience_segments")},
                       ensure_ascii=False)
    n_todo = blob.count("待润色")
    n_draftflag = blob.count('"_draft": true') + blob.count("'_draft': True")
    _DRAFT_FILLERS = (
        "补充现象+数据叙述", "补充业务影响", "补充业务根因与建议方向",
        "补一句用户画像", "补 2-3 句根因", "补充行为时序",
        "动词开头，补具体行动描述", "（基于 key_features", "（基于该用户数据补",
        "补具体行动描述", "指标现状→目标", "论断式标题",
    )
    filler_hits = [f for f in _DRAFT_FILLERS if f in blob]
    if report.get("_stage") == "draft" or n_todo > 0 or n_draftflag > 0 or filler_hits:
        _extra = f"、骨架填充句×{len(filler_hits)}（{'; '.join(filler_hits[:3])}…）" if filler_hits else ""
        gaps.append({"level": "block", "code": "draft_not_polished",
                     "message": (f"检测到未润色草稿（待润色×{n_todo}、_draft 标记×{n_draftflag}、"
                                 f"_stage={report.get('_stage')}{_extra}）：请按 methodology/03 把所有草稿骨架"
                                 "文案改写为运营友好叙述（含'待润色'、'补充…'、'（基于…补…）'等填充句），"
                                 "删除 _draft 标记并把 _stage 置为 full 后再 render。")})

    # B5 — 行动覆盖
    if n_problems > 0 and not actions:
        gaps.append({"level": "warn", "code": "no_actions",
                     "message": "有核心问题但 priority_actions 为空：行动建议章节将为占位。"})
    else:
        covered = {a.get("problem_rank") for a in actions}
        for rank in range(1, n_problems + 1):
            if rank not in covered:
                gaps.append({"level": "warn", "code": "problem_without_action",
                             "message": f"核心问题 #{rank} 没有对应的 priority_action：该问题缺落地动作。"})

    return gaps


# ── 软性 lint（写作约束） ─────────────────────────────────────────────


_DIGIT_PATTERN = re.compile(r"\d")


def lint_report(report: dict) -> list[str]:
    """检查 methodology/03_synthesis.md 的"写作约束"是否被遵守。

    返回警告列表（非阻塞性问题）。
    """
    warnings: list[str] = []

    def _check_forbidden(text: str, where: str) -> None:
        if not text:
            return
        for w in FORBIDDEN_WORDS:
            if w in text:
                warnings.append(f"{where}: 含禁用词 `{w}`")

    # 1) headline
    narr = report.get("narratives") or {}
    headline = narr.get("headline") if isinstance(narr, dict) else None
    headline = headline or report.get("headline") or ""
    if headline:
        _check_forbidden(headline, "narratives.headline")
        if not _DIGIT_PATTERN.search(headline):
            warnings.append('narratives.headline: 不含具体数字（违反"数字精确"原则）')
        if len(headline) > 50:
            warnings.append(f'narratives.headline: 长度 {len(headline)} 字，超出推荐 50 字（硬上限 60），建议精简')

    # 2) findings：含数字 + 禁用词 + CVR 方向一致性
    for i, f in enumerate(report.get("findings") or []):
        sig = f.get("signal", "") or ""
        if sig and not _DIGIT_PATTERN.search(sig):
            warnings.append(f"findings[{i}].signal: 不含数字")
        _check_forbidden(sig, f"findings[{i}].signal")
        _check_forbidden(f.get("detail", "") or "", f"findings[{i}].detail")
        # finding.confidence 仍是内部证据强度字段；展示层不显示，但小样本仍需降权。
        for j, mr in enumerate(f.get("metric_refs") or []):
            n_total = mr.get("n_total") if isinstance(mr, dict) else None
            if isinstance(n_total, int) and n_total < 30:
                conf = float(f.get("confidence", 0) or 0)
                if conf > 0.6:
                    warnings.append(
                        f"findings[{i}].metric_refs[{j}]: n_total={n_total} < 30 "
                        f"但 confidence={conf} > 0.6"
                    )

        # 2c) CVR 方向一致性：cvr_triggered − cvr_not_triggered 的符号须与 cvr_gap 一致
        def _mr_val(name):
            for m in (f.get("metric_refs") or []):
                if isinstance(m, dict) and m.get("name") == name:
                    try:
                        return float(m["value"])
                    except (TypeError, ValueError, KeyError):
                        pass
            return None

        cvr_t = _mr_val("cvr_triggered")
        cvr_n = _mr_val("cvr_not_triggered")
        cvr_g = _mr_val("cvr_gap")
        if cvr_t is not None and cvr_n is not None and cvr_g is not None:
            computed_gap = cvr_t - cvr_n
            if (computed_gap > 0) != (cvr_g > 0) and abs(cvr_g) > 0.005:
                warnings.append(
                    f"findings[{i}] ({f.get('id', '')}): metric_refs CVR 方向与 cvr_gap 符号矛盾 "
                    f"（cvr_triggered={cvr_t:.4f}, cvr_not_triggered={cvr_n:.4f}, "
                    f"gap={cvr_g:.4f}）— cvr_triggered/cvr_not_triggered 可能写反，"
                    f"应直接复制 diagnostic_rules_summary[rule_id] 的对应字段"
                )
    # 2b) 渠道词汇一致性：各渠道专属词汇不得在渠道不存在时出现
    _narratives_obj = report.get("narratives") or {}
    _nar_probs = _narratives_obj if isinstance(_narratives_obj, list) else _narratives_obj.get("problems") or []

    channel_dist = (
        (report.get("data_overview") or {}).get("data_basic", {}).get("activity_channel_dist") or {}
    )
    if channel_dist:
        _ch_lower = {k.lower() for k in channel_dist}
        _channel_guards = [
            {
                "name": "广告",
                "has_channel": any(k in {"ad", "ads", "cpc", "dsp", "display", "banner", "广告"} for k in _ch_lower),
                "terms": ["广告用户", "广告投放", "广告品类", "广告进站", "广告落地页", "广告承接", "广告流量"],
            },
            {
                "name": "弹屏/popup",
                "has_channel": any(k in {"popup", "pop_up", "弹屏", "inapp_popup"} for k in _ch_lower),
                "terms": ["弹屏触达用户", "弹屏打扰", "弹屏推送用户", "弹屏次数", "弹屏频次"],
            },
            {
                "name": "Push",
                "has_channel": any(k in {"push", "notification", "push_notification"} for k in _ch_lower),
                "terms": ["Push触达用户", "Push推送用户", "Push渠道用户", "Push 触达用户", "Push 推送用户", "Push 渠道用户"],
            },
            {
                "name": "短信/SMS",
                "has_channel": any(k in {"sms", "短信", "text_message"} for k in _ch_lower),
                "terms": ["短信触达用户", "短信推送用户", "短信营销用户"],
            },
        ]
        for guard in _channel_guards:
            if guard["has_channel"]:
                continue
            for i, f in enumerate(report.get("findings") or []):
                text = f"{f.get('signal', '')} {f.get('detail', '')}"
                bad = [t for t in guard["terms"] if t in text]
                if bad:
                    warnings.append(
                        f"findings[{i}] ({f.get('id', '')}): 含{guard['name']}专属词汇 {bad}，"
                        f"但实际渠道为 {list(channel_dist.keys())}"
                    )
            for i, p in enumerate(_nar_probs):
                text = f"{p.get('title', '')} {p.get('narrative', '')}"
                bad = [t for t in guard["terms"] if t in text]
                if bad:
                    warnings.append(
                        f"narratives.problems[{i}]: 含{guard['name']}专属词汇 {bad}，"
                        f"但实际渠道为 {list(channel_dist.keys())}"
                    )

    # 3) priority_actions：title 必须含数字
    plan = report.get("action_plan") or {}
    seg_names = {s.get("name") for s in (report.get("audience_segments") or []) if s.get("name")}
    for i, a in enumerate(plan.get("priority_actions") or []):
        title = a.get("title", "") or ""
        if title and not _DIGIT_PATTERN.search(title):
            warnings.append(f"action_plan.priority_actions[{i}].title: 不含数字（违反强制 title 模板）")
        _check_forbidden(title, f"action_plan.priority_actions[{i}].title")
        # target_audiences 应该引用已存在的 segment（字符串和 dict 格式均检查）
        for j, aud in enumerate(a.get("target_audiences") or []):
            if isinstance(aud, dict):
                name = aud.get("name", "")
                matched = aud.get("matched", False)
                if name and matched and name not in seg_names:
                    warnings.append(
                        f"action_plan.priority_actions[{i}].target_audiences[{j}]: "
                        f"name=`{name}` matched=True 但未出现在 audience_segments"
                    )
            elif isinstance(aud, str):
                name = aud.strip()
                # 跳过全量哨兵词（覆盖全量是合法的，不需要 segment）
                if name and name not in ALLUSERS_SENTINELS and name not in seg_names:
                    warnings.append(
                        f"action_plan.priority_actions[{i}].target_audiences[{j}]: "
                        f"`{name}` 未在 audience_segments 中定义（应先创建 segment 再引用）"
                    )

    # 3b) problem_rank 必填且在 narratives.problems 范围内
    n_problems = len((report.get("narratives") or {}).get("problems") or [])
    for i, a in enumerate(plan.get("priority_actions") or []):
        pr = a.get("problem_rank")
        if pr is None:
            warnings.append(
                f"action_plan.priority_actions[{i}].problem_rank: 未填写"
                f"（行动将通过 evidence 文本 fallback 分组，易错乱）"
            )
        elif n_problems > 0 and int(pr) > n_problems:
            warnings.append(
                f"action_plan.priority_actions[{i}].problem_rank: {pr} "
                f"超出核心问题范围（共 {n_problems} 个）"
            )

    # 4) audience_segments：filter_conditions 不应空
    for i, s in enumerate(report.get("audience_segments") or []):
        if not (s.get("filter_conditions") or "").strip():
            warnings.append(f"audience_segments[{i}].filter_conditions: 为空")

    # 5) findings ≥ 3 条 high
    high_cnt = sum(1 for f in (report.get("findings") or []) if f.get("severity") == "high")
    if high_cnt < 3:
        warnings.append(f"high severity finding 仅 {high_cnt} 条（建议 ≥ 3，触发 synth_findings 兜底）")

    # 6) 决策轨迹应非空（路由驱动模式必填）
    trace = report.get("_decision_trace") or []
    if not trace:
        warnings.append("_decision_trace 为空：路由驱动模式应通过 event_logger.log_decision 记录决策")
    else:
        # 检查 must_run 工具均被显式处理过（invoke / fallback / skip 都算合规决策）
        # 同时接受 "step" 和 "tool_id" 两种字段命名（历史兼容）
        seen = {
            item.get("step") or item.get("tool_id")
            for item in trace
            if item.get("kind") in ("invoke", "fallback", "skip")
        }
        for must in ("data_overview", "model_analysis", "compute_thresholds"):
            if must not in seen:
                warnings.append(f"_decision_trace: must_run 工具 `{must}` 未出现")

    # 7) 内部 self_critique 若存在，不允许 error 残留进入正式报告 state。
    issues = report.get("self_critique") or []
    err_issues = [i for i in issues if isinstance(i, dict) and i.get("severity") == "error"]
    if err_issues:
        warnings.append(f"self_critique 仍有 {len(err_issues)} 条 error 未修订，应修订后再 render")

    # 8) 内部 adhoc evidence 若存在，应能对应到 adhoc_tools；不要求报告展示。
    tools = report.get("adhoc_tools") or []
    evidences = report.get("adhoc_evidences") or []
    tool_ids = {t.get("id") for t in tools if isinstance(t, dict)}
    for i, ev in enumerate(evidences):
        if isinstance(ev, dict) and ev.get("tool_id") and ev["tool_id"] not in tool_ids:
            warnings.append(f"adhoc_evidences[{i}] 引用的 tool_id=`{ev['tool_id']}` 不在 adhoc_tools 中")

    # 9) finding 若显式引用 adhoc evidence，detail 应带 code_hash 方便内部追溯。
    for i, f in enumerate(report.get("findings") or []):
        ev_field = f.get("evidence_field", "") or ""
        if ev_field.startswith("adhoc:"):
            detail = f.get("detail", "") or ""
            if "code_hash" not in detail:
                warnings.append(f"findings[{i}].detail 引用 adhoc 但未标注 code_hash（违反 methodology/07）")

    # 10) 规则编号：finding.signal/detail 不应出现 "Rule N" / "rule#N" / "规则N"
    _rule_num_pat = re.compile(r'(?:rule|规则)[#\s]\s*\d+', re.IGNORECASE)
    for i, f in enumerate(report.get("findings") or []):
        text = f"{f.get('signal', '')} {f.get('detail', '')}"
        if _rule_num_pat.search(text):
            warnings.append(
                f"findings[{i}] ({f.get('id', '')}): 含规则编号（Rule N/rule#N），"
                f"应替换为中文规则名（如「营销未触达主流程」）"
            )
    for i, p in enumerate(_nar_probs):
        text = f"{p.get('title', '')} {p.get('narrative', '')} {p.get('impact', '')}"
        if _rule_num_pat.search(text):
            warnings.append(
                f"narratives.problems[{i}]: 含规则编号（Rule N），应替换为中文规则名"
            )

    # 11) ML/技术专有词：对外文本不应出现 AUC、LightGBM 等
    _ml_terms = re.compile(r'\bAUC\b|LightGBM|GBDT|XGBoost|feature importance', re.IGNORECASE)
    for i, f in enumerate(report.get("findings") or []):
        text = f"{f.get('signal', '')} {f.get('detail', '')}"
        m = _ml_terms.search(text)
        if m:
            warnings.append(
                f"findings[{i}] ({f.get('id', '')}): 含技术专有词「{m.group(0)}」，"
                f"应替换为面向运营的中文描述（如「转化预测模型」）"
            )
    for i, p in enumerate(_nar_probs):
        text = f"{p.get('title', '')} {p.get('narrative', '')} {p.get('impact', '')}"
        m = _ml_terms.search(text)
        if m:
            warnings.append(
                f"narratives.problems[{i}]: 含技术专有词「{m.group(0)}」，应替换为面向运营的中文描述"
            )

    return warnings


def lint_channel_vocab_issues(report: dict) -> list[dict]:
    """返回渠道词汇专属违规的结构化列表，供 cli render 做 REWRITE_REQUIRED 判断。

    每条元素格式：
    {
        "location": "findings[2] (fnd_xx)" | "narratives.problems[0]",
        "channel": "广告" | "弹屏/popup" | "Push" | "短信/SMS",
        "bad_terms": ["广告用户", ...],
        "actual_channels": ["activity"],
        "rewrite_hint": "将上述词汇替换为实际渠道词汇（如"活动触达用户"）"
    }
    """
    issues: list[dict] = []
    channel_dist = (
        (report.get("data_overview") or {}).get("data_basic", {}).get("activity_channel_dist") or {}
    )
    if not channel_dist:
        return issues

    _ch_lower = {k.lower() for k in channel_dist}
    actual = list(channel_dist.keys())

    _CHANNEL_VOCAB_REPLACEMENT = {
        "广告": "活动触达用户/活动推送（activity渠道）",
        "弹屏/popup": "活动触达用户/活动推送（activity渠道）",
        "Push": "活动触达用户/活动推送（activity渠道）",
        "短信/SMS": "活动触达用户/活动推送（activity渠道）",
    }

    _channel_guards = [
        {
            "name": "广告",
            "has_channel": any(k in {"ad", "ads", "cpc", "dsp", "display", "banner", "广告"} for k in _ch_lower),
            "terms": ["广告用户", "广告投放", "广告品类", "广告进站", "广告落地页", "广告承接", "广告流量"],
            "hint": "将广告用户/广告投放/广告品类等词替换为活动触达用户/活动推送",
        },
        {
            "name": "弹屏/popup",
            "has_channel": any(k in {"popup", "pop_up", "弹屏", "inapp_popup"} for k in _ch_lower),
            "terms": ["弹屏触达用户", "弹屏打扰", "弹屏推送用户", "弹屏次数", "弹屏频次"],
            "hint": "将弹屏相关词汇删除或替换为实际渠道对应词汇",
        },
        {
            "name": "Push",
            "has_channel": any(k in {"push", "notification", "push_notification"} for k in _ch_lower),
            "terms": ["Push触达用户", "Push推送用户", "Push渠道用户", "Push 触达用户", "Push 推送用户", "Push 渠道用户"],
            "hint": "将Push专属词汇删除或替换为实际渠道对应词汇",
        },
        {
            "name": "短信/SMS",
            "has_channel": any(k in {"sms", "短信", "text_message"} for k in _ch_lower),
            "terms": ["短信触达用户", "短信推送用户", "短信营销用户"],
            "hint": "将短信专属词汇删除或替换为实际渠道对应词汇",
        },
    ]

    _narratives = report.get("narratives") or {}
    _nar_probs = _narratives if isinstance(_narratives, list) else _narratives.get("problems") or []

    for guard in _channel_guards:
        if guard["has_channel"]:
            continue
        for i, f in enumerate(report.get("findings") or []):
            text = f"{f.get('signal', '')} {f.get('detail', '')}"
            bad = [t for t in guard["terms"] if t in text]
            if bad:
                issues.append({
                    "location": f"findings[{i}] ({f.get('id', '')})",
                    "channel": guard["name"],
                    "bad_terms": bad,
                    "actual_channels": actual,
                    "rewrite_hint": guard["hint"],
                })
        for i, p in enumerate(_nar_probs):
            text = f"{p.get('title', '')} {p.get('narrative', '')}"
            bad = [t for t in guard["terms"] if t in text]
            if bad:
                issues.append({
                    "location": f"narratives.problems[{i}]",
                    "channel": guard["name"],
                    "bad_terms": bad,
                    "actual_channels": actual,
                    "rewrite_hint": guard["hint"],
                })

    return issues


# ── CLI 入口 ──────────────────────────────────────────────────────────


def main() -> int:
    import argparse
    import sys

    ap = argparse.ArgumentParser(description="Validate marketing audit report JSON.")
    ap.add_argument("report", help="path to diagnosis_report.json")
    ap.add_argument("--lint", action="store_true", help="also run methodology/03 soft lint")
    args = ap.parse_args()

    with open(args.report, encoding="utf-8") as f:
        report = json.load(f)

    errors = validate_report(report)
    if errors:
        print(f"[FAIL] {len(errors)} schema errors:")
        for e in errors:
            print(f"  - {e}")
    else:
        print("[OK] schema validation passed.")

    if args.lint:
        warnings = lint_report(report)
        if warnings:
            print(f"\n[lint] {len(warnings)} writing-style warnings:")
            for w in warnings:
                print(f"  - {w}")
        else:
            print("\n[lint] writing-style check passed.")
    return 1 if errors else 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
