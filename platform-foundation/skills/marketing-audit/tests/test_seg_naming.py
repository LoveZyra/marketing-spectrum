#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型人群命名门禁(2026-08-17 重写命名器)。

线上三个实锤:
  ① `客单价 >= 0` 被命名成「**高**客单价人群」—— `_cond_tag` 只看方向符号不看阈值。
     `gmv >= 0` 在非负字段上等于"客单价不为空",几乎全量;运营照这个名字去投,
     投的是完全不同的人。**名字是反的**,比不好听严重得多。
  ② 「低bigpromoexpo深漏斗人群」—— 字段查不到中文标签时,第三级兜底把英文字段名
     硬塞进人群名并截半截。
  ③ 「无是否有活动目非会员等级:1人群」—— `_tag_from_desc` 只剥一遍前缀,
     「近1天是否有…」里 `近1天` 先被剥掉后 `是否` 不再位于串首,那条规则失效,
     剩下的串再被硬截 6 字。

重写后的口径:只用**有中文标签、有信息量**的条件,按区分度+信息量选前 2 个,
产出「关键特征·关键特征人群」。

三道闸保证名字一定唯一(这是硬要求 —— 人群名是圈人锚点,`crowd_rules.json` 与
`priority_actions.target_audiences` 同时引用它):
  闸一 格式门禁:中文、以「人群」结尾、有实际标签、长度可控;不合格退回编号名;
  闸二 撞名补一个"组内取值不同"的标签 →「A·B·C人群」;
  闸三 仍撞则 `·变体N` —— 不依赖任何数据,**数学上封死**。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import model_interpreter as MI  # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ── 1. 三个线上实锤的直接回归 ─────────────────────────────────────────
print("=== 1. 线上实锤 ===")

check("`>= 0` 不再写成「高X」(它等于「不为空」,零信息量,不进名字)",
      MI._cond_tag("gmv", ">=", 0) == "", repr(MI._cond_tag("gmv", ">=", 0)))
check("`> 0` 写成「有X」/精选表的成对写法(真有值,有业务含义)",
      MI._cond_tag("gmv", ">", 0) == "高客单价" or
      MI._cond_tag("gmv", ">", 0).startswith("有"), MI._cond_tag("gmv", ">", 0))
check("`> 0` 的二值字段用精选表的地道说法,不拿中性词拼「有」",
      MI._cond_tag("pre_has_target_product_create", ">", 0) == "目标品类创单",
      MI._cond_tag("pre_has_target_product_create", ">", 0))
check("`<= 0` 用精选表的「未…」,不写成「无曝光过大促」",
      MI._cond_tag("pre_big_promo_expose", "<=", 0) == "未曝光大促",
      MI._cond_tag("pre_big_promo_expose", "<=", 0))
check("非 0 阈值仍按高/低", MI._cond_tag("gmv", ">", 598.0) == "高客单价",
      MI._cond_tag("gmv", ">", 598.0))

check("查不到中文标签的字段不进名字(不再塞英文半截)",
      MI._cond_tag("zzz_unknown_field", ">", 3) == "",
      repr(MI._cond_tag("zzz_unknown_field", ">", 3)))

check("registry 描述的前缀剥到底(「近1天是否有活动目标品类的创单」)",
      "是否" not in MI._tag_from_desc("pre_has_target_product_create"),
      MI._tag_from_desc("pre_has_target_product_create"))
check("通用名词尾巴不当标签(「近1天深夜时段行为次数」不能起成「次数」)",
      MI._tag_from_desc("pre_night_cnt") not in MI._GENERIC_TAIL,
      MI._tag_from_desc("pre_night_cnt"))
check("硬截后的虚字去掉(「首条行为的小」→ 不以「的」结尾)",
      not MI._tag_from_desc("pre_first_active_hour").endswith("的"),
      MI._tag_from_desc("pre_first_active_hour"))


# ── 2. 端到端:线上那几单的规则,起出什么名字 ──────────────────────────
print("\n=== 2. 端到端(复刻线上三单的规则组) ===")

GROUPS = {
    "客单价>=0 那一单": [
        "gmv >= 0 AND visit_days <= 27 AND pre_create_not_complete > 0 AND pre_max_funnel_depth <= 2",
        "pre_max_funnel_depth >= 3 AND gmv >= 0 AND visit_days <= 46 AND pre_big_promo_expose <= 0",
        "member_level not in [1] AND insite_channel_cnt >= 4 AND pre_has_target_product_create > 0",
    ],
    "消费频次:空值 那一单": [
        "order_pc not in [近1年无消费] AND pre_max_funnel_depth > 2 AND pre_night_cnt <= 0 AND insite_product_cnt > 4",
        "order_pc not in [近1年无消费] AND pre_max_funnel_depth > 2 AND pre_last_order_to_touch_min <= 2 AND insite_product_cnt > 4",
        "order_pc not in [近1年无消费] AND pre_max_funnel_depth > 2 AND pre_target_product_depth > 3 AND insite_product_cnt > 4",
    ],
    "目标品类/火车票 那一单": [
        "pre_target_product_funnel_depth > 1 AND pre_create_order_cnt > 2 AND pre_train_depth > 1",
        "pre_target_product_funnel_depth > 1 AND pre_train_depth > 1",
        "pre_target_product_funnel_depth > 1 AND pre_mkt_product_browse_match > 0",
    ],
}
for _tag, _rules in GROUPS.items():
    _names = MI._build_seg_names(_rules)
    print(f"  [{_tag}] {_names}")
    check(f"{_tag}:名字唯一", len(set(_names)) == len(_names), str(_names))
    check(f"{_tag}:全部过格式门禁", all(MI._name_ok(n) or n.startswith("模型高潜人群")
                                          for n in _names), str(_names))
    check(f"{_tag}:不含英文/空值", not any(
        __import__("re").search(r"[A-Za-z_]|空值", n) for n in _names), str(_names))
    check(f"{_tag}:不出现「高客单价」这种反话(该组条件里没有高客单价)",
          not any("高客单价" in n for n in _names), str(_names))
    check(f"{_tag}:标签之间不重复说同一件事", not any(
        len(set(n[:-2].split("·"))) != len(n[:-2].split("·")) for n in _names), str(_names))
    check(f"{_tag}:同一份数据重跑必然同名(确定性,人群名是圈人锚点)",
          MI._build_seg_names(_rules) == _names)


# ── 3. 三道闸 ────────────────────────────────────────────────────────
print("\n=== 3. 三道闸 ===")

# 闸一:一个能用的标签都凑不出 → 退回编号名,而不是吐半截英文
_no_label = MI._build_seg_names(["zzz_a > 1 AND zzz_b <= 0"] * 2)
check("闸一:凑不出中文标签 → 退回编号名",
      all(n.startswith("模型高潜人群") for n in _no_label), str(_no_label))
check("闸一:编号名之间也唯一", len(set(_no_label)) == 2, str(_no_label))

check("闸一:格式门禁认得出不合格的名字",
      not MI._name_ok("bigpromoexpo人群") and not MI._name_ok("空值人群")
      and not MI._name_ok("人群") and not MI._name_ok("遗单") and MI._name_ok("遗单·低频访问人群"))

# 闸二:撞名时补一个"组内取值不同"的标签,而不是直接上变体N
_g2 = MI._build_seg_names([
    "pre_max_funnel_depth > 2 AND visit_days > 3 AND gmv > 100",
    "pre_max_funnel_depth > 2 AND visit_days > 3 AND gmv > 900",
])
check("闸二:撞名先补区分标签", len(set(_g2)) == 2, str(_g2))
check("闸二:不是直接退回变体N", not any("变体" in n for n in _g2), str(_g2))

# 闸三:条件完全相同,补无可补 → 变体N,数学上封死
_g3 = MI._build_seg_names(["gmv > 5 AND visit_days > 3"] * 4)
check("闸三:条件完全相同也必唯一", len(set(_g3)) == 4, str(_g3))
check("闸三:兜底是变体N", sum("变体" in n for n in _g3) == 3, str(_g3))

# 压力:20 条同规则,唯一性不能塌
_g4 = MI._build_seg_names(["gmv > 5"] * 20)
check("闸三:20 条同规则仍全部唯一", len(set(_g4)) == 20, str(_g4[:3]) + " …")


# ── 4. 标签覆盖:模型规则用得到的字段必须起得出非通用中文标签 ───────────
print("\n=== 4. 标签覆盖 ===")

# 这些是近几单生产报告的模型规则里真实出现过的字段
SEEN = [
    "gmv", "visit_days", "order_pc", "member_level", "insite_channel_cnt",
    "insite_product_cnt", "pre_max_funnel_depth", "pre_create_not_complete",
    "pre_has_target_product_create", "pre_has_target_product_order",
    "pre_big_promo_expose", "pre_night_cnt", "pre_last_order_to_touch_min",
    "pre_target_product_depth", "pre_target_product_funnel_depth",
    "pre_train_depth", "pre_create_order_cnt", "pre_mkt_product_browse_match",
]
for _f in SEEN:
    _t = MI._zh_tag(_f)
    check(f"{_f} 起得出中文标签", bool(_t) and _t not in MI._GENERIC_TAIL, repr(_t))

print()
print("=" * 62)
print("结果:" + ("全部通过" if not fails else f"失败 {len(fails)} 项:" + ", ".join(fails)))
sys.exit(1 if fails else 0)
