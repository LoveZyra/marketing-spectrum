"""问题账本 —— 跨 job 沉淀"可优化问题"，供创建者定期评审后人工晋升。

设计原则
========
1. **纯旁路**：不参与任何诊断判定、不修改 yaml、不影响报告。任何异常都吞掉并降级，
   绝不让写账本影响主链（ROADMAP §四「报告永不崩」）。
2. **只追加、永不改写**：账本被多个并发 job 共享。`count` / `first_seen` / `campaigns`
   等聚合量全部在**读取时折叠**计算，追加走 POSIX `O_APPEND` 单次 write（行长 <4KB 时原子），
   因此零锁、并发安全。文件长大后用 `cli issues compact` 离线折叠重写。
3. **不在 DiagnosticEngine 内部调用**：engine 是纯统计层（见其 docstring），
   往里塞文件 IO 会破坏定位、也让 engine 单测被迫碰磁盘。采集统一由 cli.py 在拿到 summary 之后触发。
4. **绝不自动改 yaml**：只产出 diff 草稿，由人决定。

记录类型
========
- `job_snapshot`：每 job 一行，记该次全部规则的 status/trigger_rate 向量。
  「长期不触发 / 长期不适用」这类**趋势信号在报告时从 snapshot 序列算出来**，不预先写进账本
  ——否则 28 条规则 × N 个 job 的正常状态会把账本淹掉。
- `observe`：只记明确的异常与反馈（字段缺失 / 阈值算不出 / validator warn /
  critique 未解决 / 用户与 Agent 上报），带 `issue_key` 作折叠主键。
- `status`：人工处置记录（open → confirmed / promoted / rejected），只由 `cli issues resolve` 写。

存放位置
========
`<skill_root>/feedback/issues.jsonl`（可用 `MA_FEEDBACK_DIR` 覆盖）。
skill 目录不可写时降级到 `~/.marketing_audit_skill/` 并 warning 一次。
"""
from __future__ import annotations

import json
import logging
import os
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

logger = logging.getLogger(__name__)

# ── 常量 ──────────────────────────────────────────────────────────────

_SKILL_ROOT = Path(__file__).resolve().parent.parent
_FALLBACK_DIR = Path.home() / ".marketing_audit_skill"

MAX_LINE_BYTES = 4096          # 超过此长度 O_APPEND 不再保证原子
MAX_DETAIL = 200
MAX_AGENT_NOTE = 300
MAX_USER_QUOTE = 500
MAX_CAMPAIGNS = 20

KINDS_AUTO = {
    "field_missing", "threshold_uncomputable", "full_trigger",
    "validator_warn", "critique_unresolved",
}
KINDS_HUMAN = {"wrong_scope", "advice_infeasible", "rule_semantics", "data_mismatch"}
KINDS = KINDS_AUTO | KINDS_HUMAN
SOURCES = {"auto", "agent", "user"}
SCOPES = {"this_job", "systematic", "unknown"}
VERDICTS = {"agreed", "disputed", "unverifiable"}
STATUSES = {"open", "confirmed", "promoted", "rejected"}

_warned_fallback = False


# ── 路径 ──────────────────────────────────────────────────────────────


def feedback_dir() -> Path:
    """账本目录。优先 MA_FEEDBACK_DIR，其次 skill 目录下 feedback/，不可写时降级。"""
    global _warned_fallback
    env = os.environ.get("MA_FEEDBACK_DIR")
    if env:
        return Path(env)
    d = _SKILL_ROOT / "feedback"
    try:
        d.mkdir(parents=True, exist_ok=True)
        # 只探测"能不能以追加方式打开账本"——这正是本模块唯一需要的能力。
        # 早先用 touch + unlink 探测，会在**允许写但不允许删**的挂载上（如只给了
        # 追加权限的共享目录、部分容器挂载）误判为不可写并无谓降级到 home 目录。
        with open(d / "issues.jsonl", "ab"):
            pass
        return d
    except Exception as e:
        if not _warned_fallback:
            logger.warning(
                "feedback/ 不可写（%s），账本降级到 %s；"
                "如为只读部署，请设置 MA_FEEDBACK_DIR 指向可写目录", e, _FALLBACK_DIR)
            _warned_fallback = True
        try:
            _FALLBACK_DIR.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        return _FALLBACK_DIR


def ledger_path() -> Path:
    return feedback_dir() / "issues.jsonl"


# ── 基础读写（唯一允许碰磁盘的两个函数）────────────────────────────────


def _now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _clip(v: Any, n: int) -> Any:
    if isinstance(v, str) and len(v) > n:
        return v[: n - 1] + "…"
    return v


def append(record: dict, path: Path | None = None) -> bool:
    """原子追加一条记录。任何失败都返回 False，绝不抛。"""
    try:
        rec = dict(record)
        rec.setdefault("ts", _now())
        rec["detail"] = _clip(rec.get("detail"), MAX_DETAIL) if rec.get("detail") else rec.get("detail")
        if rec.get("agent_note"):
            rec["agent_note"] = _clip(rec["agent_note"], MAX_AGENT_NOTE)
        if rec.get("user_quote"):
            rec["user_quote"] = _clip(rec["user_quote"], MAX_USER_QUOTE)
        rec = {k: v for k, v in rec.items() if v is not None}

        line = json.dumps(rec, ensure_ascii=False, default=str) + "\n"
        data = line.encode("utf-8")
        if len(data) > MAX_LINE_BYTES:
            # 兜底截断：宁可丢细节也不能写出非原子的长行
            rec["detail"] = _clip(str(rec.get("detail", "")), 80)
            rec.pop("user_quote", None)
            rec["_truncated"] = True
            data = (json.dumps(rec, ensure_ascii=False, default=str) + "\n").encode("utf-8")

        p = path or ledger_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "ab") as f:      # "a" + 单次 write → O_APPEND 原子
            f.write(data)
        return True
    except Exception as e:            # noqa: BLE001 —— 账本永不阻断主链
        logger.warning("issue_ledger.append 失败（已忽略）：%s", e)
        return False


def append_many(records: Iterable[dict], path: Path | None = None) -> int:
    return sum(1 for r in records if append(r, path))


def _read_raw(path: Path | None = None) -> list[dict]:
    """逐行读取，坏行跳过不抛。"""
    p = path or ledger_path()
    out: list[dict] = []
    try:
        if not p.exists():
            return out
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    if isinstance(rec, dict):
                        out.append(rec)
                except json.JSONDecodeError:
                    continue      # 半行 / 脏行：跳过，不因个别坏行毁掉整个账本
    except Exception as e:        # noqa: BLE001
        logger.warning("issue_ledger 读取失败（返回已读部分）：%s", e)
    return out


# ── 折叠 ──────────────────────────────────────────────────────────────


def load(path: Path | None = None) -> list[dict]:
    """按 issue_key 折叠 observe 记录，套用最新 status。返回 count 降序列表。"""
    raw = _read_raw(path)
    obs = [r for r in raw if r.get("t") == "observe" and r.get("issue_key")]
    sts = [r for r in raw if r.get("t") == "status" and r.get("issue_key")]

    buckets: dict[str, dict] = {}
    for r in obs:
        k = r["issue_key"]
        b = buckets.setdefault(k, {
            "issue_key": k, "kind": r.get("kind"), "count": 0,
            "sources": set(), "campaigns": [], "jobs": [],
            "rule_id": r.get("rule_id"), "field": r.get("field"),
            "details": [], "user_quotes": [], "reporters": set(),
            "scopes": set(), "verdicts": set(), "agent_notes": [],
            "first_seen": r.get("ts"), "last_seen": r.get("ts"),
        })
        b["count"] += 1
        b["sources"].add(r.get("source", "auto"))
        for key, dst in (("campaign_id", "campaigns"), ("job_id", "jobs")):
            v = r.get(key)
            if v and v not in b[dst]:
                b[dst].append(v)
        for key, dst in (("detail", "details"), ("user_quote", "user_quotes"),
                         ("agent_note", "agent_notes")):
            v = r.get(key)
            if v and v not in b[dst]:
                b[dst].append(v)
        if r.get("reporter"):
            b["reporters"].add(r["reporter"])
        if r.get("scope"):
            b["scopes"].add(r["scope"])
        if r.get("agent_verdict"):
            b["verdicts"].add(r["agent_verdict"])
        ts = r.get("ts")
        if ts:
            b["first_seen"] = min(b["first_seen"] or ts, ts)
            b["last_seen"] = max(b["last_seen"] or ts, ts)

    latest_status: dict[str, dict] = {}
    for r in sorted(sts, key=lambda x: x.get("ts") or ""):
        latest_status[r["issue_key"]] = r

    out: list[dict] = []
    for k, b in buckets.items():
        st = latest_status.get(k)
        camps = b["campaigns"]
        item = {
            "issue_key": k,
            "kind": b["kind"],
            "count": b["count"],
            "source": ("user" if "user" in b["sources"]
                       else "agent" if "agent" in b["sources"] else "auto"),
            "rule_id": b["rule_id"],
            "field": b["field"],
            "first_seen": b["first_seen"],
            "last_seen": b["last_seen"],
            "campaigns": camps[:MAX_CAMPAIGNS],
            "campaigns_truncated": len(camps) > MAX_CAMPAIGNS,
            "n_campaigns": len(camps),
            "jobs": b["jobs"][:MAX_CAMPAIGNS],
            "details": b["details"][:5],
            # 不同人说的话不能互相覆盖 —— 全部保留
            "user_quotes": b["user_quotes"],
            "agent_notes": b["agent_notes"][:5],
            "reporters": sorted(b["reporters"]),
            "scope": (sorted(b["scopes"])[0] if len(b["scopes"]) == 1
                      else ("unknown" if not b["scopes"] else "conflicting")),
            "agent_verdict": (sorted(b["verdicts"])[0] if len(b["verdicts"]) == 1
                              else ("" if not b["verdicts"] else "conflicting")),
            # 同一 key 下取值分歧 → 标记，交给人裁决，机器不做多数表决
            "conflicting": len(b["scopes"]) > 1 or len(b["verdicts"]) > 1,
            "status": (st or {}).get("status", "open"),
            "resolution": (st or {}).get("resolution", ""),
            "resolved_by": (st or {}).get("by", ""),
        }
        out.append(item)
    out.sort(key=lambda x: (-x["count"], x["issue_key"]))
    return out


def load_snapshots(path: Path | None = None) -> list[dict]:
    snaps = [r for r in _read_raw(path) if r.get("t") == "job_snapshot"]
    snaps.sort(key=lambda x: x.get("ts") or "")
    return snaps


def compact(path: Path | None = None) -> int:
    """离线折叠重写：去掉完全重复的行，保留全部语义。返回压缩后行数。

    R3（重装后 cat 合并两份账本）之后调用即可去重 —— 这正是"纯追加 + 读时折叠"
    设计的好处：合并账本只需 cat + compact，不需要任何冲突消解逻辑。
    """
    p = path or ledger_path()
    try:
        raw = _read_raw(p)
        seen: set[str] = set()
        kept: list[dict] = []
        for r in raw:
            sig = json.dumps(r, ensure_ascii=False, sort_keys=True, default=str)
            if sig in seen:
                continue
            seen.add(sig)
            kept.append(r)
        kept.sort(key=lambda x: x.get("ts") or "")
        tmp = p.with_suffix(".jsonl.tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            for r in kept:
                f.write(json.dumps(r, ensure_ascii=False, default=str) + "\n")
        tmp.replace(p)
        return len(kept)
    except Exception as e:            # noqa: BLE001
        logger.warning("issue_ledger.compact 失败：%s", e)
        return -1


# ── 采集器（纯函数：结构 → 待写记录，不碰磁盘，便于单测）──────────────


def _ctx_fields(ctx: dict) -> dict:
    return {
        "job_id": ctx.get("job_id"),
        "campaign_id": ctx.get("campaign_id"),
    }


_MISSING_FIELD_RE = re.compile(r"\[([^\]]*)\]")


def build_job_snapshot(rule_rows: list[dict], ctx: dict) -> dict:
    """每 job 一行的规则状态向量。趋势信号由 build_report 从序列上算。"""
    rules = {}
    for r in rule_rows:
        rid = r.get("rule_id")
        if rid is None:
            continue
        tr = r.get("trigger_rate")
        rules[str(rid)] = [r.get("status"), (round(float(tr), 4) if tr is not None else None)]
    return {
        "t": "job_snapshot",
        "job_id": ctx.get("job_id"),
        "campaign_id": ctx.get("campaign_id"),
        "campaign_channel": ctx.get("campaign_channel"),
        "skill_version": ctx.get("skill_version"),
        "rules": rules,
    }


def collect_from_rule_summary(rule_rows: list[dict], ctx: dict) -> list[dict]:
    """从 rule_summary 记录集抽取「明确异常」。正常状态不写，留给 snapshot。"""
    out: list[dict] = []
    base = _ctx_fields(ctx)
    for r in rule_rows:
        rid = r.get("rule_id")
        status = r.get("status")
        reason = str(r.get("skip_reason") or "")
        if status == "skipped" and ("字段缺失" in reason or "全量缺失" in reason
                                    or "ETL未回填" in reason or "ETL 未回填" in reason):
            m = _MISSING_FIELD_RE.search(reason)
            fields = [f.strip().strip("'\"") for f in m.group(1).split(",")] if m else []
            for fld in (fields or [""]):
                out.append({
                    "t": "observe", "source": "auto", "kind": "field_missing",
                    "issue_key": f"rule{rid}:field_missing:{fld or 'unknown'}",
                    "rule_id": rid, "field": fld or None, "detail": reason, **base,
                })
        elif status == "full_trigger_no_baseline":
            out.append({
                "t": "observe", "source": "auto", "kind": "full_trigger",
                "issue_key": f"rule{rid}:full_trigger",
                "rule_id": rid,
                "detail": "100% 触发无对照组，疑似 channel_filter/scope_filter 配置不当",
                **base,
            })
        for w in (r.get("warnings") or []):
            if "阈值未计算" in str(w):
                fld = str(w).split("'")[1] if "'" in str(w) else "unknown"
                out.append({
                    "t": "observe", "source": "auto", "kind": "threshold_uncomputable",
                    "issue_key": f"rule{rid}:threshold_uncomputable:{fld}",
                    "rule_id": rid, "field": fld, "detail": str(w), **base,
                })
    return out


def collect_from_lint(lint_items: list[dict], ctx: dict) -> list[dict]:
    """lint_report_completeness 的 warn 项（block 级会阻断 render，不需要沉淀）。"""
    base = _ctx_fields(ctx)
    return [{
        "t": "observe", "source": "auto", "kind": "validator_warn",
        "issue_key": f"lint:{g.get('code', 'unknown')}",
        "detail": str(g.get("message", ""))[:MAX_DETAIL], **base,
    } for g in (lint_items or []) if g.get("level") != "block"]


def collect_from_critique(state: dict, ctx: dict) -> list[dict]:
    """self_critique 中未获解决的存疑项（questioned/pending）。"""
    base = _ctx_fields(ctx)
    out: list[dict] = []
    for issue in (state.get("self_critique") or []):
        if str(issue.get("severity")) not in ("error", "warning"):
            continue
        typ = str(issue.get("type") or "unknown")
        out.append({
            "t": "observe", "source": "auto", "kind": "critique_unresolved",
            "issue_key": f"critique:{typ}",
            "detail": str(issue.get("message") or issue.get("detail") or typ)[:MAX_DETAIL],
            **base,
        })
    return out


# ── 上报 ──────────────────────────────────────────────────────────────


def record_feedback(*, source: str, kind: str, campaign_id: str | None = None,
                    job_id: str | None = None, rule_id: int | None = None,
                    field: str | None = None, scope: str = "unknown",
                    user_quote: str | None = None, agent_verdict: str | None = None,
                    agent_note: str | None = None, reporter: str | None = None,
                    detail: str | None = None, path: Path | None = None) -> bool:
    """Agent / 用户上报一条。schema 收严：kind、scope、verdict 都是封闭枚举。"""
    if source not in SOURCES or kind not in KINDS:
        logger.warning("record_feedback: 非法 source/kind：%s/%s", source, kind)
        return False
    if scope not in SCOPES:
        scope = "unknown"
    if agent_verdict and agent_verdict not in VERDICTS:
        agent_verdict = None
    anchor = f"rule{rule_id}" if rule_id is not None else (f"field:{field}" if field else "global")
    return append({
        "t": "observe", "source": source, "kind": kind,
        "issue_key": f"{anchor}:{kind}",
        "rule_id": rule_id, "field": field, "campaign_id": campaign_id, "job_id": job_id,
        "scope": scope, "user_quote": user_quote, "agent_verdict": agent_verdict,
        "agent_note": agent_note, "reporter": reporter, "detail": detail,
    }, path)


def set_status(issue_key: str, status: str, resolution: str = "", by: str = "",
               path: Path | None = None) -> bool:
    if status not in STATUSES:
        logger.warning("set_status: 非法 status：%s", status)
        return False
    return append({"t": "status", "issue_key": issue_key, "status": status,
                   "resolution": resolution, "by": by}, path)


# ── 趋势信号（从 snapshot 序列算，不写进账本）──────────────────────────


def trend_signals(snapshots: list[dict], na_streak: int = 10,
                  never_streak: int = 10) -> list[dict]:
    """连续 N 个 job 维持同一「无信息」状态 → 候选。按最近 job 倒序看连续段。"""
    if not snapshots:
        return []
    by_rule: dict[str, list[str]] = defaultdict(list)
    for s in snapshots:                       # 已按 ts 升序
        for rid, val in (s.get("rules") or {}).items():
            by_rule[rid].append((val or [None])[0])

    out: list[dict] = []
    for rid, seq in by_rule.items():
        tail = seq[::-1]
        for target, need, kind, msg in (
            ("not_applicable", na_streak, "rule_always_na", "连续 %d 个 job not_applicable"),
            ("not_triggered", never_streak, "rule_never_triggers", "连续 %d 个 job not_triggered"),
            ("skipped", na_streak, "rule_always_skipped", "连续 %d 个 job skipped"),
        ):
            run = 0
            for st in tail:
                if st == target:
                    run += 1
                else:
                    break
            if run >= need:
                out.append({"rule_id": int(rid) if rid.isdigit() else rid,
                            "kind": kind, "streak": run, "message": msg % run})
    out.sort(key=lambda x: -x["streak"])
    return out


# ── 评审报告 ──────────────────────────────────────────────────────────


def _since_cutoff(since: str | None) -> str | None:
    if not since:
        return None
    m = re.fullmatch(r"(\d+)([dwm])", since.strip())
    if not m:
        return None
    n, unit = int(m.group(1)), m.group(2)
    days = n * {"d": 1, "w": 7, "m": 30}[unit]
    return (datetime.now(timezone.utc).astimezone() - timedelta(days=days)).isoformat(timespec="seconds")


def build_report(since: str | None = None, na_streak: int = 10, never_streak: int = 10,
                 path: Path | None = None, rules_path: Path | None = None) -> str:
    """产出评审报告 markdown。

    验收口径：其中的 yaml diff 与 CHANGELOG 草稿应当能被创建者**直接粘贴、只润色措辞**。
    运行时注入已排除，账本的全部价值都要经由这一份报告兑现。
    """
    cutoff = _since_cutoff(since)
    issues = load(path)
    snaps = load_snapshots(path)
    if cutoff:
        issues = [i for i in issues if (i.get("last_seen") or "") >= cutoff]
        snaps = [s for s in snaps if (s.get("ts") or "") >= cutoff]

    rule_names = _load_rule_names(rules_path)
    open_issues = [i for i in issues if i["status"] in ("open", "confirmed")]
    human = [i for i in open_issues if i["source"] in ("user", "agent")]
    auto = [i for i in open_issues if i["source"] == "auto"]
    trends = trend_signals(snaps, na_streak, never_streak)

    L: list[str] = []
    L.append("# 诊断规则问题账本 · 评审报告")
    L.append("")
    span = f"{since} 内" if since else "全量"
    L.append(f"统计区间：{span} ｜ 覆盖 {len(snaps)} 个 job ｜ 未处置条目 {len(open_issues)} 条"
             f"（用户/Agent {len(human)}、自动 {len(auto)}）｜ 趋势信号 {len(trends)} 条")
    L.append("")

    # 一、用户与 Agent 反馈
    L.append("## 一、用户 / Agent 反馈（逐条全文，不折叠）")
    L.append("")
    if not human:
        L.append("（无）")
    for n, i in enumerate(human, 1):
        nm = rule_names.get(i.get("rule_id"), "")
        L.append(f"### U{n} · {_anchor_label(i, nm)} · `{i['kind']}` · scope={i['scope']}"
                 + ("  ⚠️ **存在分歧**" if i.get("conflicting") else ""))
        L.append("")
        L.append(f"- 提出人：{'、'.join(i['reporters']) or '未署名'} ｜ 首次 {_d(i['first_seen'])}"
                 f" ｜ 共 {i['count']} 次 ｜ 活动 {', '.join(i['campaigns']) or '—'}")
        for q in i["user_quotes"]:
            L.append(f"- 原话：「{q}」")
        for a in i["agent_notes"]:
            L.append(f"- Agent 核对（{i['agent_verdict'] or '—'}）：{a}")
        if i.get("conflicting"):
            L.append("- ⚠️ 同一条目收到取值不一致的反馈，**不做裁决**，两侧原话均已保留，请人工判断")
        L.append(f"- `issue_key`：`{i['issue_key']}`")
        L.append("")
        L.append("```diff")
        L.append(_yaml_diff_stub(i, nm))
        L.append("```")
        L.append("")

    # 二、自动信号
    L.append("## 二、自动信号（按出现次数降序）")
    L.append("")
    if not auto:
        L.append("（无）")
    else:
        L.append("| count | 活动数 | issue_key | kind | 说明 |")
        L.append("|---|---|---|---|---|")
        for i in auto:
            det = (i["details"] or [""])[0]
            L.append(f"| {i['count']} | {i['n_campaigns']} | `{i['issue_key']}` | "
                     f"{i['kind']} | {det} |")
    L.append("")

    # 三、趋势信号
    L.append("## 三、趋势信号（从 job_snapshot 序列计算，未写入账本）")
    L.append("")
    if not trends:
        L.append("（无）")
    else:
        L.append("| 规则 | 现象 | 建议 |")
        L.append("|---|---|---|")
        for t in trends:
            nm = rule_names.get(t["rule_id"], "")
            sug = {"rule_always_na": "先看这段时间的活动类型：若根本没出现过该规则适用的类型（如 #45 只在广告投放生效），"
                                     "属正常、不必处置；否则说明 applies_to/channel_filter 配置有误",
                   "rule_never_triggers": "下线候选：长期无触发说明该问题在当前投放模式下不存在",
                   "rule_always_skipped": "数仓待办：字段长期未回填，规则等于没跑"}[t["kind"]]
            L.append(f"| #{t['rule_id']} {nm} | {t['message']} | {sug} |")
    L.append("")

    # 四、ad-hoc 固化候选（展示层汇合，数据层不合并）
    L.append("## 四、Ad-hoc 工具固化候选")
    L.append("")
    L.append(_adhoc_section())
    L.append("")

    # 五、CHANGELOG 草稿
    L.append("## 五、CHANGELOG 草稿（可直接粘贴后润色）")
    L.append("")
    L.append("```markdown")
    L.append(f"## ★ {datetime.now().strftime('%Y-%m-%d')} 账本驱动的规则修订(fixNN)")
    L.append("")
    L.append("**来源**：`cli issues report` 第 N 轮评审。")
    L.append("")
    L.append("| 变更 | 说明 | 文件 |")
    L.append("|---|---|---|")
    for n, i in enumerate(human, 1):
        nm = rule_names.get(i.get("rule_id"), "")
        who = "、".join(i["reporters"]) or "用户"
        L.append(f"| #{i.get('rule_id')} {nm} 待定改动 | 来自反馈 U{n}（{who}，"
                 f"{i['n_campaigns']} 个活动复现）：{(i['user_quotes'] or [''])[0]} | diagnostic_rules.yaml |")
    for t in trends[:5]:
        nm = rule_names.get(t["rule_id"], "")
        L.append(f"| #{t['rule_id']} {nm} | {t['message']}，建议处置 | diagnostic_rules.yaml |")
    L.append("```")
    L.append("")
    L.append("---")
    L.append("")
    L.append("> 处置完成后用 `cli issues resolve --key <issue_key> --status promoted|rejected "
             "--note \"...\"` 记账；`--status` 变更后该条目不再出现在本报告。")
    L.append("> **本报告绝不自动修改 yaml** —— 上面的 diff 仅为草稿，改不改、怎么改由人决定。")
    return "\n".join(L)


def _d(ts: str | None) -> str:
    return (ts or "")[:10]


def _anchor_label(i: dict, name: str) -> str:
    if i.get("rule_id") is not None:
        return f"#{i['rule_id']} {name}".strip()
    return i.get("field") or "全局"


def _load_rule_names(rules_path: Path | None = None) -> dict:
    try:
        import yaml
        p = rules_path or (_SKILL_ROOT / "feature_schema" / "diagnostic_rules.yaml")
        data = yaml.safe_load(p.read_text(encoding="utf-8"))
        return {r["id"]: r.get("name", "") for r in data.get("rules", [])}
    except Exception:
        return {}


def _yaml_diff_stub(issue: dict, name: str) -> str:
    """给出定位到具体条目的 diff 骨架，让创建者在正确的位置改，而不是从零找。"""
    rid = issue.get("rule_id")
    if rid is None:
        return f"# 该反馈未锚定到具体规则（scope={issue.get('scope')}），需人工判断落点\n# {(issue['user_quotes'] or issue['details'] or [''])[0]}"
    lines = [f"  - id: {rid}                      # {name}",
             "-   condition_template: <当前条件>",
             "+   condition_template: <按反馈修改后的条件>"]
    if issue["kind"] == "wrong_scope":
        lines += ["+   applies_to: <收窄后的适用范围>",
                  "+   scope_filter: <对应表达式>"]
    elif issue["kind"] == "advice_infeasible":
        lines = [f"  - id: {rid}                      # {name}",
                 "-   recommendations: [<原建议>]",
                 "+   recommendations: [<业务可执行的新建议>]"]
    return "\n".join(lines)


def _adhoc_section() -> str:
    """展示层汇合 adhoc_registry（模块不合并，见评估 §6.1）。"""
    try:
        from . import adhoc_registry
        sugg = adhoc_registry.suggest_promotion(threshold=3)
    except Exception as e:                       # noqa: BLE001
        return f"（读取 adhoc_history 失败，已忽略：{e}）"
    if not sugg:
        return "（暂无达到固化阈值的 ad-hoc 工具）"
    out = ["| uses | name | 用途 | 建议路径 |", "|---|---|---|---|"]
    for s in sugg:
        out.append(f"| {s['uses']} | {s['name']} | {'; '.join(s.get('purpose_samples') or [])[:60]} | "
                   f"`{s.get('suggested_path', '')}` |")
    return "\n".join(out)
