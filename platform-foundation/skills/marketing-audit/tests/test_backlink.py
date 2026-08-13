#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix27：附录人群包 → 核心发现回跳的回归测试。

盯住三件事：
  1) 编号口径与 `_chapter1` 的 `problem-{i+1}` 完全一致 —— 两处一旦漂移就是死链；
  2) 对不上核心发现的人群**不加链接**（模型分析产出的人群没有对应发现，给死链更糟）；
  3) 跳转不能退回裸锚点 —— 报告被外链嵌入后 `#x` 会解析成宿主页地址触发整页跳转。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets.report_renderer import _build_segment_backlinks, render_html  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ── 1. 映射函数本身 ───────────────────────────────────────────────────

P = [{"problem_rank": 7, "title": "甲"}, {"problem_rank": 3, "title": "乙"}]
A = [{"problem_rank": 3, "target_audiences": [{"name": "B群"}]},
     {"problem_rank": 7, "target_audiences": [{"name": "A群"}, "字符串人群"]},
     {"problem_rank": 99, "target_audiences": [{"name": "野群"}]}]
mp = _build_segment_backlinks(P, A)

check("按列表下标编号（rank 7 在第 1 位 → #1）", mp.get("A群") == (1, "甲"), str(mp.get("A群")))
check("第二条发现 → #2", mp.get("B群") == (2, "乙"), str(mp.get("B群")))
check("target_audiences 里的裸字符串也能对上", mp.get("字符串人群") == (1, "甲"))
check("对不上 problem_rank 的人群不进映射", "野群" not in mp)

check("空输入不炸", _build_segment_backlinks(None, None) == {})
check("结构异常不炸（返回空表而非抛异常）",
      _build_segment_backlinks([{"bad": 1}], [{"target_audiences": "not a list"}]) == {})
check("同名人群取先出现的那条",
      _build_segment_backlinks(
          P, [{"problem_rank": 7, "target_audiences": [{"name": "X"}]},
              {"problem_rank": 3, "target_audiences": [{"name": "X"}]}])["X"] == (1, "甲"))

# ── 2. 真实样例：编号必须落在真实存在的卡片上 ─────────────────────────

state = json.loads((ROOT / "examples" / "output_example.json").read_text(encoding="utf-8"))
html = render_html(state)

card_ids = set(re.findall(r'id="(problem-\d+)"', html))
targets = re.findall(r'<a class="fp-jump"[^>]*data-to="([^"]+)"', html)
check("有回跳链接生成", bool(targets), f"{len(targets)} 个")
check("每个回跳都落在真实存在的问题卡上",
      all(t in card_ids for t in targets), str(sorted(set(targets) - card_ids)))

n_seg = len(state.get("audience_segments", []))
check("回跳数不超过人群数（对不上的不加链接）", len(targets) <= n_seg, f"{len(targets)}/{n_seg}")

# href 与 data-to 必须一致：href 只作降级回退，data-to 才是 JS 认的
pairs = re.findall(r'<a class="fp-jump" href="#([^"]+)" data-to="([^"]+)"', html)
check("href 与 data-to 指向同一个锚点", all(a == b for a, b in pairs), str(pairs[:3]))
check("徽标 ↑ #N 的编号与目标一致",
      all(f"#{t.split('-')[1]}" in m for t, m in
          zip(targets, re.findall(r'<a class="fp-jump".*?</a>', html, re.S))))

# ── 3. 跳转方式：必须是 JS 接管，不是裸锚点 ───────────────────────────

check("挂了 preventDefault 的点击处理（不走裸锚点跳转）",
      "preventDefault" in html and "a.fp-jump" in html)
check("处理器只作用于 .fp-jump，不动现有正向 chip 与目录",
      "querySelectorAll('a.fp-jump')" in html)

# ── 4. 没有 actions 时不能崩，也不该有链接 ────────────────────────────

_no = json.loads(json.dumps(state))
_no["action_plan"] = {}
_no["actions"] = []
try:
    _h = render_html(_no)
    check("无行动方案时仍能渲染", True)
    check("无行动方案时不产生回跳", 'class="fp-jump"' not in _h)
except Exception as e:                       # noqa: BLE001
    check("无行动方案时仍能渲染", False, str(e))

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
