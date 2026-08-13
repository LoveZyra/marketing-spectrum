"""事件流落盘与重放（纯函数 + 轻量 EventLog 容器）。

用途：
  - 在"假设驱动模式（methodology/12）"中记录推理过程
  - 供事后复盘 / 调试 / 教学回放

事件类型:
  - hypothesis_proposed
  - tool_call
  - evidence_returned
  - finding_added
  - validation_done
  - state_change
  - decision         # 路由决策（调用/跳过/回退/临时工具）
  - critique         # self_critique 结果摘要
  - adhoc_tool       # 临时工具生命周期事件
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass, field

EVENT_TYPES = (
    "hypothesis_proposed",
    "tool_call",
    "evidence_returned",
    "finding_added",
    "validation_done",
    "state_change",
    "decision",
    "critique",
    "adhoc_tool",
)

DECISION_KINDS = ("invoke", "skip", "fallback", "adhoc", "remediate")


def new_id(prefix: str) -> str:
    """生成 8 位短 id：<prefix>_<8hex>。"""
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def code_hash(code: str) -> str:
    """12 位代码哈希，用于 evidence 缓存命中检测。"""
    return hashlib.sha1(code.encode("utf-8")).hexdigest()[:12]


@dataclass
class EventLog:
    """轻量事件日志容器；可在 state 中作为 state['event_log'] 持有。"""
    output_dir: str
    filename: str = "events.jsonl"
    events: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        os.makedirs(self.output_dir, exist_ok=True)

    @property
    def path(self) -> str:
        return os.path.join(self.output_dir, self.filename)

    def append(self, event_type: str, payload: dict) -> dict:
        """追加一条事件并落盘。返回该事件 dict。"""
        if event_type not in EVENT_TYPES:
            raise ValueError(
                f"unknown event type: {event_type}; "
                f"must be one of {EVENT_TYPES}"
            )
        evt = {"ts": time.time(), "type": event_type, "payload": payload}
        self.events.append(evt)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(evt, ensure_ascii=False, default=str) + "\n")
        return evt

    def batch_append(self, items: list[tuple[str, dict]]) -> list[dict]:
        """批量追加多条事件，单次 open 完成所有写入，减少高频 IO。

        items: list of (event_type, payload)
        返回写入的事件列表。
        """
        evts = []
        for event_type, payload in items:
            if event_type not in EVENT_TYPES:
                raise ValueError(
                    f"unknown event type: {event_type}; "
                    f"must be one of {EVENT_TYPES}"
                )
            evt = {"ts": time.time(), "type": event_type, "payload": payload}
            self.events.append(evt)
            evts.append(evt)
        with open(self.path, "a", encoding="utf-8") as f:
            for evt in evts:
                f.write(json.dumps(evt, ensure_ascii=False, default=str) + "\n")
        return evts

    # ── 便捷封装：常用事件类型的快捷方法 ───────────────────────────────

    def log_hypothesis(self, hyp_id: str, question: str) -> dict:
        return self.append("hypothesis_proposed", {"id": hyp_id, "question": question})

    def log_tool_call(self, agent: str, tool: str, args: dict,
                      evidence_id: str | None = None) -> dict:
        payload = {"agent": agent, "tool": tool, "args": args}
        if evidence_id:
            payload["evidence_id"] = evidence_id
        return self.append("tool_call", payload)

    def log_evidence(self, ev_id: str, agent: str, n_rows: int,
                     error: bool = False) -> dict:
        return self.append("evidence_returned", {
            "id": ev_id, "agent": agent, "n_rows": n_rows, "error": error,
        })

    def log_finding(self, fnd_id: str, agent: str, signal: str, severity: str) -> dict:
        return self.append("finding_added", {
            "id": fnd_id, "agent": agent, "signal": signal, "severity": severity,
        })

    def log_validation(self, hyp_id: str, validated: bool, evidence_ids: list[str]) -> dict:
        return self.append("validation_done", {
            "hypothesis_id": hyp_id,
            "validated": validated,
            "evidence_ids": evidence_ids,
        })

    def log_state(self, payload: dict) -> dict:
        return self.append("state_change", payload)

    def log_decision(self, tool_id: str, kind: str, reason: str,
                     elapsed_ms: int | None = None,
                     preconditions_ok: bool | None = None,
                     fallback_used: str | None = None) -> dict:
        """记录一条路由决策。

        kind ∈ {"invoke","skip","fallback","adhoc","remediate"}
          - invoke    : 调用该工具
          - skip      : 跳过（preconditions 未满足或被显式禁用）
          - fallback  : 走 fallback_if_missing 分支
          - adhoc     : 触发临时工具自生成
          - remediate : self_critique 报错后做的修订动作
        """
        if kind not in DECISION_KINDS:
            raise ValueError(f"unknown decision kind: {kind}; must be one of {DECISION_KINDS}")
        payload: dict = {"tool_id": tool_id, "kind": kind, "reason": reason}
        if elapsed_ms is not None:
            payload["elapsed_ms"] = elapsed_ms
        if preconditions_ok is not None:
            payload["preconditions_ok"] = preconditions_ok
        if fallback_used is not None:
            payload["fallback_used"] = fallback_used
        return self.append("decision", payload)

    def log_critique(self, round_no: int, issues_summary: dict) -> dict:
        """记录 self_critique 一轮结果摘要（来自 self_critique.summarize）。"""
        return self.append("critique", {"round": round_no, **issues_summary})

    def log_adhoc(self, tool_id: str, stage: str, name: str,
                  code_hash: str | None = None,
                  status: str | None = None,
                  errors: list[str] | None = None) -> dict:
        """记录临时工具生命周期：propose / execute / validate / attach / promote。"""
        payload: dict = {"tool_id": tool_id, "stage": stage, "name": name}
        if code_hash:
            payload["code_hash"] = code_hash
        if status:
            payload["status"] = status
        if errors:
            payload["errors"] = errors
        return self.append("adhoc_tool", payload)


def write_decision_trace(state: dict, log: "EventLog") -> None:
    """把 EventLog 中的 decision 事件汇总到 state['_decision_trace']。

    state['_decision_trace'] 是供报告读者审计的"线性决策日志"，比 events.jsonl 更精炼：
        [{"step": "data_overview", "decided_by": "must_run", "elapsed_ms": 320}, ...]

    采用 merge 语义：保留 state 中已有的条目，当前 session 的同名条目会覆盖旧值。
    这样 run-tools（只有 self_critique session）不会抹掉 prepare/compute-thresholds 写入的条目。
    """
    # 以 step 为 key 建索引（先放旧值，再用新值覆盖）
    existing = {
        (item.get("step") or item.get("tool_id")): item
        for item in (state.get("_decision_trace") or [])
    }
    for ev in log.events:
        if ev.get("type") != "decision":
            continue
        p = ev.get("payload") or {}
        item = {"step": p.get("tool_id"), "decided_by": p.get("reason"), "kind": p.get("kind")}
        if "elapsed_ms" in p:
            item["elapsed_ms"] = p["elapsed_ms"]
        if "fallback_used" in p:
            item["fallback_used"] = p["fallback_used"]
        existing[item["step"]] = item
    state["_decision_trace"] = list(existing.values())


# ── 重放工具 ──────────────────────────────────────────────────────────


def load_events(path: str) -> list[dict]:
    """从 events.jsonl 读取全部事件。"""
    if not os.path.exists(path):
        return []
    events: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                events.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return events


def replay_events(path: str, on_event=None) -> dict:
    """重放事件流，返回汇总统计。

    参数：
      path     : events.jsonl 路径
      on_event : 可选回调，签名 (event_dict) -> None；用于自定义重放逻辑

    返回汇总 dict：
      {
        "total_events": N,
        "by_type": {"tool_call": x, "finding_added": y, ...},
        "tool_call_count": M,
        "hypotheses_proposed": [...question...],
        "findings_added": [{"agent": ..., "signal": ..., "severity": ...}, ...],
        "duration_s": 末事件 ts - 首事件 ts
      }
    """
    events = load_events(path)
    summary: dict = {
        "total_events": len(events),
        "by_type": {},
        "tool_call_count": 0,
        "hypotheses_proposed": [],
        "findings_added": [],
        "duration_s": 0.0,
    }
    if not events:
        return summary

    for ev in events:
        et = ev.get("type", "")
        summary["by_type"][et] = summary["by_type"].get(et, 0) + 1
        payload = ev.get("payload") or {}

        if et == "tool_call":
            summary["tool_call_count"] += 1
        elif et == "hypothesis_proposed":
            summary["hypotheses_proposed"].append(payload.get("question", ""))
        elif et == "finding_added":
            summary["findings_added"].append({
                "agent": payload.get("agent", ""),
                "signal": payload.get("signal", ""),
                "severity": payload.get("severity", ""),
            })

        if on_event is not None:
            on_event(ev)

    summary["duration_s"] = round(events[-1].get("ts", 0) - events[0].get("ts", 0), 2)
    return summary


def print_replay(path: str) -> None:
    """简单命令行重放：把每条事件按时间顺序打印一行摘要。"""
    events = load_events(path)
    if not events:
        print(f"[empty] {path}")
        return
    t0 = events[0].get("ts", 0)
    for ev in events:
        delta = ev.get("ts", 0) - t0
        et = ev.get("type", "?")
        p = ev.get("payload") or {}
        if et == "hypothesis_proposed":
            tag = f"HYP  {p.get('id', '')}"
            text = p.get("question", "")[:80]
        elif et == "tool_call":
            tag = f"TOOL {p.get('tool', '')}"
            text = json.dumps(p.get("args", {}), ensure_ascii=False)[:80]
        elif et == "evidence_returned":
            tag = f"EVID {p.get('id', '')}"
            text = f"agent={p.get('agent', '')} n_rows={p.get('n_rows', 0)}"
        elif et == "finding_added":
            tag = f"FND  [{p.get('severity', '?'):4s}]"
            text = f"{p.get('agent', '')}: {p.get('signal', '')[:60]}"
        elif et == "state_change":
            tag = "STATE"
            text = json.dumps(p, ensure_ascii=False)[:80]
        elif et == "decision":
            tag = f"DEC  [{p.get('kind', '?'):8s}]"
            text = f"{p.get('tool_id', '')}: {p.get('reason', '')[:60]}"
        elif et == "critique":
            tag = f"CRIT r{p.get('round', '?')}"
            text = f"err={p.get('error', 0)} warn={p.get('warning', 0)} types={p.get('by_type', {})}"
        elif et == "adhoc_tool":
            tag = f"ADHC [{p.get('stage', '?'):8s}]"
            text = f"{p.get('name', '')} status={p.get('status', '')}"
        else:
            tag, text = et.upper(), ""
        print(f"  +{delta:6.2f}s  {tag:18s}  {text}")
    print(f"\n[{len(events)} events, total {events[-1].get('ts', 0) - t0:.2f}s]")


# ── 便捷工厂 ──────────────────────────────────────────────────────────


def open_event_log(output_dir: str, fresh: bool = False) -> EventLog:
    """打开（或新建）一个 EventLog。fresh=True 时会清掉旧的 events.jsonl。"""
    log = EventLog(output_dir=output_dir)
    if fresh and os.path.exists(log.path):
        os.remove(log.path)
    return log
