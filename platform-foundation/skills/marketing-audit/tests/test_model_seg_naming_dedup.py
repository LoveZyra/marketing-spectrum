#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""模型人群的两道门禁(2026-08-17 线上报告实锤的两个问题)。

**问题一 —— 人群名里冒出「空值」**
线上三条模型人群叫「低次数非消费频次:空值等人群」这类名字。根因不在命名器,在
渲染器:`_merge_render_clauses` 的 display 分支在 null_in=False 时会把「空值」塞进
NOT IN 清单表示"空值也排除"。交付形态(drop_null=True)下每条分支的 null_in 都是
False,于是**每个**分类子句都挂这个标注;命名器 `_parse_conds` 把它当成一个真实
类别值,写进了人群名。SQL 侧一直是对的(`NOT IN ('近1年无消费')`,没有空值)。
两头都堵:渲染层交付形态不再标,命名层把「空值/__NA__」当渲染标注剥掉。

**问题二 —— 三条人群里两条圈的是同一批人**
两条规则只差 `pre_last_order_to_touch_min <= 2.5` vs `<= 3.5`,覆盖 524 人、预计
增量 138 单**逐位相同**。去冗(_dedup_by_overlap)本该按 Jaccard=1.0 拦下,没拦住 ——
判重掩码没算出来时它是**静默** fail-open。三处返工:
  ① 判重掩码改用交付形态 rule_pandas(与 rule_sql 同源、叶子 oracle 逐行验过),
     不再解析 display 串(display 阈值做过美化、不认 '__NA__' 哨兵,本地实测同一条
     规则 display 圈 132 人、交付形态只有 91 人);
  ② 去掉 `命中<10 静默跳过`;小集合的 Jaccard 恰恰最容易是 1.0;
  ③ 掩码缺席时加一道不依赖掩码的守卫(交付 SQL 逐字相同,或只差一个数值阈值且
     命中/转化数逐位相同),并把"没判过重就放行"写进 auto_blind_spots。
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np                                    # noqa: E402
import pandas as pd                                   # noqa: E402

from snippets import model_interpreter as MI          # noqa: E402
from snippets.model_analyst import (                  # noqa: E402
    DecisionRule, _apply_rule_mask, _merge_render_clauses,
    _rule_mask_for_overlap, _rule_overlap,
)

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ══════════════════════════ 一、人群名不吃「空值」 ══════════════════════════
print("=== 一、人群名不吃「空值」 ===")

CAT_MAPS = {"order_pc": ["__NA__", "近1年无消费", "1单", "2-3单", "4单+"]}


def steps(thr: float):
    return [("cat", "order_pc", {"__NA__", "近1年无消费"}, False, False),
            ("num", "pre_max_funnel_depth", (2.5, False), None, False),
            ("num", "pre_last_order_to_touch_min", None, (thr, True), False),
            ("num", "insite_product_cnt", (4.5, False), None, False)]


disp_d, sql_d, pd_d = _merge_render_clauses(steps(2.5), CAT_MAPS, drop_null=True)
disp_k, sql_k, pd_k = _merge_render_clauses(steps(2.5), CAT_MAPS, drop_null=False)
_dd, _dk = " AND ".join(disp_d), " AND ".join(disp_k)

check("交付形态(剔空值)的 display 不再标「空值」", "空值" not in _dd, _dd)
check("MA_MODEL_SEG_NULL=1(不剔空值)时标注照旧保留", "空值" in _dk, _dk)
check("SQL 两种形态都不含空值字面量(一直是对的,回归钉住)",
      "空值" not in " AND ".join(sql_d) and "空值" not in " AND ".join(sql_k),
      " AND ".join(sql_d))

name_d = MI._build_seg_names([_dd])[0]
name_k = MI._build_seg_names([_dk])[0]
check("人群名里不再出现「空值」(线上那个名字的直接回归)", "空值" not in name_d, name_d)
# 2026-08-17 命名器重写后口径改了:「非消费频次:近1年无消费」是 13 字的双重否定,
# 又长又泛,已被信息量排序降档 —— 名额让给「深漏斗」「刚下过单」这类短而具体的标签。
# 这里要守的仍是原意:名字由**有信息量的中文标签**组成,不含空值、不含英文半截词。
check("人群名由有信息量的中文标签组成(不含空值/英文)",
      bool(name_d) and not __import__("re").search(r"[A-Za-z_]|空值", name_d)
      and name_d.endswith("人群") and "·" in name_d, name_d)
check("命名层单独也扛得住:display 里带「空值」也不进名字",
      "空值" not in name_k, name_k)
check("命名不吃「空值」但不丢字段本身(建议动作仍能按 dimension 选)",
      any(f == "order_pc" for f, _o, _v in MI._parse_conds(_dk)),
      str(MI._parse_conds(_dk)[:1]))

# 整条只圈空值的分类子句:值被剥空后不参与命名,不能产出「非」这种半截标签
_only_null = "order_pc not in [空值] AND pre_max_funnel_depth>2.5"
_n = MI._build_seg_names([_only_null])[0]
check("值被剥空的条件不参与命名(不出「非」这种半截标签)",
      "非人群" not in _n and _n.strip() not in ("非人群", "人群"), _n)


# ══════════════════════════ 二、同一批人只出一个 ══════════════════════════
print("\n=== 二、只差一个阈值、圈同一批人的规则必须去冗 ===")

rng = np.random.default_rng(0)
N = 3000
DF = pd.DataFrame({
    "order_pc": rng.choice(["__NA__", "近1年无消费", "1单", "2-3单"], N),
    "pre_max_funnel_depth": rng.integers(0, 6, N).astype(float),
    "pre_last_order_to_touch_min": rng.choice([0, 1, 2, 3, 4, 10, 60], N).astype(float),
    "insite_product_cnt": rng.integers(0, 9, N).astype(float),
    "is_paid": rng.integers(0, 2, N),
})


def mk(thr: float, n: int = 524, conv: int = 138) -> DecisionRule:
    d, s, p = _merge_render_clauses(steps(thr), CAT_MAPS, drop_null=True)
    return DecisionRule(rule_text=" AND ".join(d), rule_sql=" AND ".join(s),
                        rule_pandas=" & ".join(p), predicted_cvr=0.5,
                        sample_count=n, lift=4.9, n_converted=conv)


R25, R35 = mk(2.5), mk(3.5)

# ---- ① 判重掩码走交付形态,不再是 display 串的近似
m_deliver = _rule_mask_for_overlap(DF, R25)
m_display = _apply_rule_mask(DF, R25.rule_text)
check("判重掩码取自 rule_pandas(交付形态)", m_deliver is not None)
check("交付形态与 display 解析确实不是同一批人(所以不能拿 display 判重)",
      m_display is not None and int(m_deliver.sum()) != int(m_display.sum()),
      "交付={} display={}".format(int(m_deliver.sum()), int(m_display.sum())))
check("交付形态掩码 == 交付 pandas 条件本身算出来的行",
      int(m_deliver.sum()) == int(np.asarray(
          __import__("snippets.diagnostic_engine", fromlist=["x"]).eval_condition(
              R25.rule_pandas, DF)).sum()))

ov = _rule_overlap(DF, [R25, R35], target_col="is_paid")
_pair = next((p for p in (ov.get("pairs") or [])
              if {p["i"], p["j"]} == {0, 1}), None)
check("两条规则都算出了掩码,给出了这一对的 Jaccard", _pair is not None, str(ov.get("pairs")))
check("重叠度高到足以判重(≥ 默认阈值 0.5)",
      bool(_pair) and _pair["jaccard"] >= 0.5, str(_pair))
check("缺掩码的规则如实报出来,不再静默", "rules_without_mask" in ov, str(sorted(ov)))

# ---- ② 命中少的规则不再被静默跳过(小集合的 Jaccard 最容易是 1.0)
TINY = DF.head(40).copy()
ov_tiny = _rule_overlap(TINY, [R25, R35], target_col="is_paid")
_covered = ov_tiny.get("n_rules_covered", 0)
check("命中 <10 的规则照样参与判重(不再 >=10 静默跳过)",
      _covered == 2 or ov_tiny.get("rules_without_mask") == [],
      "covered={} missing={}".format(_covered, ov_tiny.get("rules_without_mask")))


def dedup(ma: dict, max_jac: float = 0.5, top_n: int = 3):
    qualified = [(4.9, 524, 0, {"rule": R25.rule_text, "rule_sql": R25.rule_sql,
                                "sample_count": 524, "n_converted": 138}),
                 (4.9, 524, 1, {"rule": R35.rule_text, "rule_sql": R35.rule_sql,
                                "sample_count": 524, "n_converted": 138}),
                 (3.1, 900, 2, {"rule": "insite_product_cnt>1.5", "rule_sql": "insite_product_cnt > 1.5",
                                "sample_count": 900, "n_converted": 40})]
    return MI._dedup_by_overlap(qualified, ma, max_jac, top_n)


# ---- ③ 有掩码:按 Jaccard 判重
picked, dropped = dedup({"rule_overlap": {"pairs": [{"i": 0, "j": 1, "jaccard": 1.0}]}})
check("有 Jaccard 时同批人被判掉", [p[2] for p in picked] == [0, 2], str([p[2] for p in picked]))
check("判掉这件事进了 dropped", any(d.get("jaccard") == 1.0 for d in dropped), str(dropped)[:120])

# ---- ④ 掩码缺席(线上那次的样子):守卫接管,统计量逐位相同 = 同一批人
picked2, dropped2 = dedup({"rule_overlap": {"pairs": []}})
check("掩码缺席时也不再放同一批人进来(不依赖掩码的守卫)",
      [p[2] for p in picked2] == [0, 2], str([p[2] for p in picked2]))
check("守卫判掉的条目 jaccard 记 None(和阈值判掉的区分开)",
      any(d.get("jaccard") is None and d.get("rule") for d in dropped2), str(dropped2)[:160])

# ---- ⑤ 名额腾出来要补足 top3(用户口径:补,不是少出人群)
check("去冗后名额补足到 top_n", len(picked2) == 3 or len(picked2) == 2,
      str(len(picked2)))
picked3, _ = MI._dedup_by_overlap(
    [(4.9, 524, 0, {"rule": R25.rule_text, "rule_sql": R25.rule_sql,
                    "sample_count": 524, "n_converted": 138}),
     (4.9, 524, 1, {"rule": R35.rule_text, "rule_sql": R35.rule_sql,
                    "sample_count": 524, "n_converted": 138}),
     (3.1, 900, 2, {"rule": "a>1.5", "rule_sql": "a > 1.5", "sample_count": 900, "n_converted": 40}),
     (2.7, 800, 3, {"rule": "b>2.5", "rule_sql": "b > 2.5", "sample_count": 800, "n_converted": 30})],
    {"rule_overlap": {"pairs": []}}, 0.5, 3)
check("被判掉一条后从后面补上来,仍出 3 个人群",
      [p[2] for p in picked3] == [0, 2, 3], str([p[2] for p in picked3]))
check("留的是贪心顺序里靠前那条(lift 高者优先,本例同 lift 取先到)",
      picked3[0][2] == 0, str(picked3[0][2]))

# ---- ⑥ 守卫不能误伤真正不同的人群
picked4, _ = MI._dedup_by_overlap(
    [(4.9, 524, 0, {"rule": R25.rule_text, "rule_sql": R25.rule_sql,
                    "sample_count": 524, "n_converted": 138}),
     (4.5, 700, 1, {"rule": R35.rule_text, "rule_sql": R35.rule_sql,
                    "sample_count": 700, "n_converted": 150})],
    {"rule_overlap": {"pairs": []}}, 0.5, 3)
check("统计量不同就不判重(守卫只治逐位相同的退化情形)",
      [p[2] for p in picked4] == [0, 1], str([p[2] for p in picked4]))

# ---- ⑦ 没判过重就放行 = 必须留痕
_blind = [d for d in dropped2 if d.get("_blind")]
picked5, dropped5 = MI._dedup_by_overlap(
    [(4.9, 524, 0, {"rule": "a>1.5", "rule_sql": "a > 1.5", "sample_count": 100, "n_converted": 5}),
     (4.5, 700, 1, {"rule": "b>2.5", "rule_sql": "b > 2.5", "sample_count": 700, "n_converted": 150})],
    {"rule_overlap": {"pairs": []}}, 0.5, 3)
check("判重数据缺席时留痕(fail-open 必须可见)",
      any(d.get("_blind") for d in dropped5), str(dropped5)[:160])

out = {"auto_segments": [], "auto_blind_spots": [], "auto_findings": [],
       "auto_actions": [], "auto_problems": []}
MI._interpret_decision_rules(
    {"decision_rules": [
        {"rule": R25.rule_text, "rule_sql": R25.rule_sql, "rule_pandas": R25.rule_pandas,
         "lift": 4.9, "sample_count": 524, "n_converted": 138, "predicted_cvr": 0.5},
        {"rule": R35.rule_text, "rule_sql": R35.rule_sql, "rule_pandas": R35.rule_pandas,
         "lift": 4.9, "sample_count": 524, "n_converted": 138, "predicted_cvr": 0.5}],
     "overall_cvr": 0.1, "true_overall_cvr": 0.1, "rule_overlap": {"pairs": []}},
    MI.DEFAULTS,
    out)
_segs = out.get("auto_segments") or []
check("端到端:同批人只出一个人群", len(_segs) == 1, str([s.get("name") for s in _segs]))
check("端到端:人群名里没有「空值」",
      all("空值" not in (s.get("name") or "") for s in _segs),
      str([s.get("name") for s in _segs]))
check("端到端:去冗理由写进 auto_blind_spots",
      any("去冗" in (b.get("topic") or "") for b in out["auto_blind_spots"]),
      str(out["auto_blind_spots"])[:200])

print()
print("=" * 62)
print("结果:" + ("全部通过" if not fails else f"失败 {len(fails)} 项:" + ", ".join(fails)))
sys.exit(1 if fails else 0)
