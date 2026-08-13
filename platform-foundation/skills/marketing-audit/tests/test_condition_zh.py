#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix24：人群包「中文筛选条件」列的回归测试。

硬约束（顺序即优先级）：
  1) **`filter_conditions` 原文一个字都不能变** —— 它是下游圈人的执行口径；
  2) 中文列翻不动时返回空串，**绝不猜**，更不能让渲染崩掉；
  3) 报告里出现的字段中文名，与报告其余部分（典型案例、模型解读）用同一套标签。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import report_renderer as rr  # noqa: E402
from snippets.report_renderer import (  # noqa: E402
    ReportRenderer, humanize_condition as H, render_html,
)

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ── 1. 各种真实条件形态 ───────────────────────────────────────────────

CASES = [
    ("pre_train_depth<1 and pre_create_order_cnt>=1",
     ["火车票漏斗深度", "近1天创单次数", "且", "≥", "<"]),
    ("(is_converted == 1) & (is_paid == 0)", ["已转化", "未成单", "且"]),
    ("(pre_has_coupon == 0)", ["近1天无领券行为"]),
    ("(pre_browse_target_product == 0)", ["近1天未浏览过活动目标品类"]),
    ("(pre_last_coupon_platform.notna()) & (pre_last_coupon_platform != pre_primary_platform)",
     ["不为空", "≠"]),
    ("(pre_last_mainflow_detail.str.contains('详情', na=False))", ["包含「详情」"]),
    ("((pre_popup_touch_cnt + pre_push_touch_cnt) >= 3) & (pre_mainflow_event_cnt == 0)",
     ["近1天弹屏触达次数", "+", "≥ 3", "主流程行为次数 = 0"]),
    ("(risk_type == '风险用户') | (finance_revenue_after < 0)", ["风险用户", "或"]),
    ("activity_channel_std in ('push', 'popup')", ["属于", "push"]),
    # `not in` 要先于 `in` 翻，否则剩个光秃秃的 not，语义正好反过来
    ("timediff not in ('1-10分钟','10分钟+') and insite_channel_cnt > 2.5",
     ["不属于", "1-10分钟", "且"]),
]
for cond, wants in CASES:
    got = H(cond)
    miss = [w for w in wants if w not in got]
    check(f"翻译：{cond[:44]}", not miss, got if miss else "")

# ── 2. 不留英文字段名 / 不留 ASCII 运算符 ─────────────────────────────

for cond, _ in CASES:
    got = H(cond)
    leftover = re.findall(r"\b(?:pre_|activity_|is_|insite_|has_|ads_)\w+", got)
    check(f"无残留英文字段名：{cond[:36]}", not leftover, str(leftover))
    check(f"无 ASCII 比较符：{cond[:36]}",
          not re.search(r"(>=|<=|==|!=)", got), got)

# ── 3. 边界与容错 ─────────────────────────────────────────────────────

check("空输入 → 空串", H("") == "" and H(None) == "")
check("纯空白 → 空串", H("   ") == "")
check("无法识别的片段原样保留（不猜）", "weird_unknown_col" in H("weird_unknown_col > 5"))
check("异常不外抛", isinstance(H("((((" ), str))
check("not in 不会退化成「属于」（语义反转的回归）",
      "不属于" in H("timediff not in ('1-10分钟')") and " not " not in H("timediff not in ('1-10分钟')"),
      H("timediff not in ('1-10分钟')"))

# ── 4. 原文不被改动（最重要的一条）────────────────────────────────────

state = json.loads((ROOT / "examples" / "output_example.json").read_text(encoding="utf-8"))
before = [s.get("filter_conditions") for s in state.get("audience_segments", [])]
html = render_html(state)
after = [s.get("filter_conditions") for s in state.get("audience_segments", [])]
check("渲染后 filter_conditions 原文逐字未变", before == after)
check("state 未被塞进中文字段（中文列只是展示层投影）",
      all("filter_conditions_zh" not in s for s in state.get("audience_segments", [])))

# ── 5. 报告结构 ───────────────────────────────────────────────────────

# fix28 起条件格里嵌了 <details class="fp-raw">，区块边界改用 </table> 定位，
# 否则 `.*?</details>` 会停在第一个内层折叠上。
m = re.search(r"可落地人群包.*?</table>", html, re.S)
check("附录仍有「可落地人群包」区块", m is not None)
if m:
    seg = m.group(0)
    heads = re.findall(r"text-transform:uppercase[^>]*>([^<]+)</th>", seg)
    # fix28：中文主显、英文折叠 —— 回到三列（四列版把 code 挤成一行折三次）
    check("表头为三列且筛选条件列标注为中文",
          heads == ["人群名称", "筛选条件（中文）", "建议动作"], str(heads))
    rows = [r for r in re.findall(r"<tr[^>]*>(.*?)</tr>", seg, re.S)
            if len(re.findall(r"<td[^>]*>", r)) >= 3]
    n_seg = len(state.get("audience_segments", []))
    check(f"每个人群一行且都是三格（共 {n_seg} 个）", len(rows) == n_seg, f"{len(rows)} 行")
    filled = 0
    for r in rows:
        tds = re.findall(r"<td[^>]*>(.*?)</td>", r, re.S)
        # 中文在条件格的首个 div 里，<details> 之前
        zh = re.sub(r"<[^>]+>", "", tds[1].split("<details")[0]).strip()
        if zh:
            filled += 1
    check("中文全部有内容（本样例应 100% 覆盖）", filled == len(rows), f"{filled}/{len(rows)}")

    # fix28 的三条硬约束
    for s_ in state.get("audience_segments", []):
        raw = s_.get("filter_conditions") or ""
        if raw:
            check(f"原条件仍在 DOM 里：{raw[:26]}", rr._e(raw) in seg)
    check("英文原条件被折叠进 <details class=\"fp-raw\">",
          seg.count('class="fp-raw"') == n_seg and seg.count("原条件") == n_seg,
          f'{seg.count(chr(34) + "fp-raw" + chr(34))} / {seg.count("原条件")}')
    check("打印时强制展开（beforeprint 钩子已挂载）", "beforeprint" in html)

# 翻不动时不折叠：宁可露出英文，也不能把唯一的信息藏起来
_untr = json.loads(json.dumps(state))
for s_ in _untr.get("audience_segments", []):
    s_["filter_conditions"] = "weird_unknown_col_zzz"
_h2 = render_html(_untr)
_m2 = re.search(r"可落地人群包.*?</table>", _h2, re.S)
check("翻不出中文时不折叠、直接露出原条件",
      _m2 is not None and 'class="fp-raw"' not in _m2.group(0)
      and "weird_unknown_col_zzz" in _m2.group(0))

# ── 6. 标签口径与报告其余部分一致 ─────────────────────────────────────

check("中文标签复用 _humanize_feature（口径统一）",
      ReportRenderer._humanize_feature("pre_train_depth") in H("pre_train_depth<1"))

# ── 7. 渲染健壮性：条件是垃圾也不能崩 ─────────────────────────────────

bad = json.loads(json.dumps(state))
for s_ in bad.get("audience_segments", []):
    s_["filter_conditions"] = "(((&&& not a condition"
try:
    render_html(bad)
    check("条件是垃圾串时报告仍能渲染", True)
except Exception as e:                     # noqa: BLE001
    check("条件是垃圾串时报告仍能渲染", False, str(e))

# ── 8. registry 描述被 YAML ' #' 截断的回归（fix24.1）────────────────
#    未加引号的 YAML 标量里，空格后的 # 会被当行注释 —— 曾让三条描述只剩半个左括号，
#    直接泄进报告（"无一致（1=一致 0=不一致 NULL=站内不足2种渠道，诊断"）。

import yaml  # noqa: E402

_reg = yaml.safe_load((ROOT / "feature_schema" / "feature_registry.yaml")
                      .read_text(encoding="utf-8"))["features"]
_unbalanced = [f["name"] for f in _reg
               if (f.get("description") or "").count("（") != (f.get("description") or "").count("）")]
check("registry 无括号不闭合的描述（YAML # 截断的信号）", not _unbalanced, str(_unbalanced[:5]))

for _f in ("ads_no_insite_flag", "ads_insite_match_flag", "insite_multi_channel_match_flag"):
    _d = next(x for x in _reg if x["name"] == _f).get("description", "")
    check(f"{_f} 描述完整（含诊断编号）", _d.rstrip().endswith("）"), _d[-16:])

check("标签不含残缺括号", "（" not in ReportRenderer._humanize_feature("insite_multi_channel_match_flag"),
      ReportRenderer._humanize_feature("insite_multi_channel_match_flag"))

# 「A是否B」必须保留限定语 A，不能压成光秃秃的「无一致」
_got = H("insite_multi_channel_match_flag == 0")
check("「A是否B」保留限定语", "站内多渠道推送品类" in _got and "不一致" in _got, _got)
check("「A是否V过B」的否定用「未」不用「不」",
      "未浏览过" in H("pre_browse_target_product == 0"),
      H("pre_browse_target_product == 0"))
check("「A是否有B」用有/无", "无领券行为" in H("pre_has_coupon == 0"), H("pre_has_coupon == 0"))


# ── 9. 特征描述与权威建表语句对齐（fix25）──────────────────────────────
#    描述以 app_dm.marketing_audit_base_feature_activity 的 COMMENT 为准。
#    这里固化两点：窗口口径是「近1天」而非「历史」；以及不得再退回旧措辞。

_win = [f["name"] for f in _reg
        if f["name"].startswith("pre_") and "历史" in (f.get("description") or "")]
check("registry 里 pre_* 描述不再用「历史」（权威表口径是近1天）",
      not _win, f"{len(_win)} 个: {_win[:6]}")

for _f, _want in (("pre_popup_touch_cnt", "近1天弹屏触达次数"),
                  ("pre_is_repurchase", "近1天是否有多次成单"),
                  ("pre_create_order_cnt", "近1天创单次数")):
    _d = next(x for x in _reg if x["name"] == _f).get("description", "")
    check(f"{_f} 描述已对齐权威表", _d.startswith(_want), _d)

check("短标签表也已改口径（不再出现「历史弹屏触达次数」）",
      ReportRenderer._humanize_feature("pre_popup_touch_cnt") == "近1天弹屏触达次数",
      ReportRenderer._humanize_feature("pre_popup_touch_cnt"))


# fix25.1：所有 pre_* 描述统一带「近1天」窗口前缀（F 组同族展开项一并对齐）
_nopfx = [f["name"] for f in _reg
          if f["name"].startswith("pre_") and not (f.get("description") or "").startswith("近1天")]
check("registry 里 pre_* 描述全部带「近1天」前缀",
      not _nopfx, f"{len(_nopfx)} 个: {_nopfx[:6]}")
check("窗口写法统一为「近1天」（不混用「近一天」）",
      not [f for f in _reg if "近一天" in (f.get("description") or "")])

print()
print("=" * 62)
print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
sys.exit(1 if fails else 0)
