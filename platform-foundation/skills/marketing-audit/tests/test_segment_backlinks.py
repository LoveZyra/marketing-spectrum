#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""附录人群包的「↑ #N 回到核心发现」回链口径(2026-08-17 改为结构匹配)。

背景 —— 线上一份报告里三个模型人群同时挂上「↑ #2」:
  · 回链此前按人群名去撞 `action_plan.priority_actions[].target_audiences`;
  · 而 target_audiences 不在圈人锚点清单里,是 Agent 润色时的自由发挥区;
  · 模型 finding 在 `draft_builder._segment_from_finding` 直接 return None,
    所以它那条行动的草稿写的是 ["全量"] —— Agent 把这个占位"写实"成了它在
    audience_segments 里看到的三个模型人群名,于是附录挂出三条死链
    (那条核心发现根本不产出这些人群)。

现在的口径:人群的 finding_id ∈ 某条核心发现的 evidence_finding_ids 才算它
产出的人群。名字匹配降级为兜底,只在人群自己没有 finding_id 时启用。

红线:
  1) 结构匹配优先 —— 有 finding_id 就一律按 finding_id 判,不看名字;
  2) target_audiences 被写歪不影响回链 —— 本次线上问题的直接回归;
  3) 序号与 `_chapter1` 的 `problem-{i+1}` 同源(用 problems 下标,不用 problem_rank 值);
  4) 没有 finding_id 的老数据仍走名字兜底(历史 job 重渲染不掉链接);
  5) 老两参签名行为不变;
  6) 端到端:渲染真实示例 state,链接锚点 problem-N 在报告里确实存在(不给死链)。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets.report_renderer import _build_segment_backlinks as blk  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ── 复刻线上那一单的形状 ───────────────────────────────────────────────
# 核心发现 #1/#3 是规则发现(各自产出一个人群),#2 是模型洞察发现(不产人群)。
PROBLEMS = [
    {"problem_rank": 1, "title": "创单未付规模偏大", "evidence_finding_ids": ["fnd_r41"]},
    {"problem_rank": 2, "title": "模型识别出高潜人群", "evidence_finding_ids": ["fnd_model_low_score_converted"]},
    {"problem_rank": 3, "title": "近四成触达品类错配", "evidence_finding_ids": ["fnd_r18"]},
]
# Agent 把 #2 那条行动的 ["全量"] 换成了三个模型人群名 —— 就是这次线上的样子
ACTIONS = [
    {"problem_rank": 1, "target_audiences": ["创单未付待促付人群"]},
    {"problem_rank": 2, "target_audiences": ["目标品类深漏斗高潜人群",
                                             "火车票浏览高潜人群",
                                             "品类匹配高潜人群"]},
    {"problem_rank": 3, "target_audiences": ["品类错配人群"]},
]
SEGMENTS = [
    {"name": "目标品类深漏斗高潜人群", "finding_id": "fnd_model_decision_rule"},
    {"name": "火车票浏览高潜人群", "finding_id": "fnd_model_decision_rule"},
    {"name": "品类匹配高潜人群", "finding_id": "fnd_model_decision_rule"},
    {"name": "创单未付待促付人群", "finding_id": "fnd_r41"},
    {"name": "品类错配人群", "finding_id": "fnd_r18"},
]

back = blk(PROBLEMS, ACTIONS, SEGMENTS)

# ── 1/2. 结构匹配优先;target_audiences 写歪不影响 ─────────────────────

check("模型人群不再被挂上回链(本次线上问题的直接回归)",
      not any(n in back for n in ("目标品类深漏斗高潜人群", "火车票浏览高潜人群",
                                  "品类匹配高潜人群")),
      json.dumps(back, ensure_ascii=False))
check("规则人群仍按 finding_id 挂上各自的核心发现",
      back.get("创单未付待促付人群", (None,))[0] == 1
      and back.get("品类错配人群", (None,))[0] == 3,
      json.dumps(back, ensure_ascii=False))
check("回链表里只剩真正有归属的人群", set(back) == {"创单未付待促付人群", "品类错配人群"},
      str(sorted(back)))

# 反向:名字对得上但 finding_id 对不上 → 不挂(结构说了算)
_mismatch = blk(PROBLEMS, [{"problem_rank": 1, "target_audiences": ["品类错配人群"]}],
                [{"name": "品类错配人群", "finding_id": "fnd_r18"}])
check("名字被指到别处也不改归属(结构优先于名字)",
      _mismatch.get("品类错配人群", (None,))[0] == 3, str(_mismatch))

# ── 3. 序号与 _chapter1 同源:用 problems 下标,不是 problem_rank 值 ──

_shift = [dict(p, problem_rank=p["problem_rank"] + 10) for p in PROBLEMS]
_b2 = blk(_shift, [], SEGMENTS)
check("序号取 problems 下标(problem_rank 整体偏移也不影响 #N)",
      _b2.get("创单未付待促付人群", (None,))[0] == 1
      and _b2.get("品类错配人群", (None,))[0] == 3, str(_b2))

# ── 4. 老数据兜底:人群没有 finding_id 时按名字 ───────────────────────

_old_segs = [{"name": "创单未付待促付人群"}, {"name": "目标品类深漏斗高潜人群"}]
_b3 = blk(PROBLEMS, ACTIONS, _old_segs)
check("无 finding_id 的老人群仍走名字兜底(历史 job 重渲染不掉链接)",
      _b3.get("创单未付待促付人群", (None,))[0] == 1, str(_b3))
check("兜底口径下 Agent 写进 TA 的名字才会挂上(与改动前一致)",
      _b3.get("目标品类深漏斗高潜人群", (None,))[0] == 2, str(_b3))

# ── 5. 老两参签名不变 ────────────────────────────────────────────────

_b4 = blk(PROBLEMS, ACTIONS)
check("两参调用退回纯名字口径(签名向后兼容)",
      set(_b4) == {"创单未付待促付人群", "品类错配人群",
                   "目标品类深漏斗高潜人群", "火车票浏览高潜人群", "品类匹配高潜人群"},
      str(sorted(_b4)))

# ── 6. 脏形状不许把报告渲挂 ──────────────────────────────────────────

check("脏形状一律返回 dict,不抛(附录少几个链接好过报告渲不出来)",
      all(isinstance(x, dict) for x in (
          blk(None, None, None),
          blk(PROBLEMS, ["不是字典"], ["也不是字典"]),
          blk([{"evidence_finding_ids": "不是列表"}], [], SEGMENTS),
          blk(PROBLEMS, ACTIONS, [None, 3, {"name": None}]))))

# ── 7. 端到端:真实示例渲出来,每个链接都能落到一个存在的锚点 ─────────

state = json.loads((ROOT / "examples" / "output_example.json").read_text(encoding="utf-8"))
try:
    from snippets.report_renderer import render_html
    html = render_html(state)
except Exception as exc:                       # noqa: BLE001
    html = ""
    check("示例 state 能渲出报告", False, repr(exc)[:120])

if html:
    anchors = set(re.findall(r'id="(problem-\d+)"', html))
    targets = set(re.findall(r'class="fp-jump"[^>]*data-to="(problem-\d+)"', html))
    check("附录回链全部落在存在的锚点上(无死链)",
          targets <= anchors, f"悬空={sorted(targets - anchors)}")
    check("示例渲染仍产出至少一条回链(没把功能整个关掉)", bool(targets), str(sorted(targets)))

print()
print("=" * 62)
print("结果:" + ("全部通过" if not fails else f"失败 {len(fails)} 项:" + ", ".join(fails)))
sys.exit(1 if fails else 0)
