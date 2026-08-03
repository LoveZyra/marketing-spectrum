# -*- coding: utf-8 -*-
"""圈人口径回归:接口只输出需要 push 的人群。

跑三层:
  1) pick_push_rules 单测            —— 纯函数,六种输入
  2) 2026-07-28 真实 crowd_rules 重放 —— 拿线上那份出事的数据过一遍
  3) stub 全链路                     —— 从 build_stub_state 一路到 crowd_spec

四个哨兵(全过才算修好):
  哨兵1 覆盖面极广的 exclude(fnd_r37)不能混进推送包
  哨兵2 促付(fnd_r41, direction_raw=促付)必须被认回 push
  哨兵3 引用不存在列的坏规则要被 dry-run 剔掉
  哨兵4 push_sql 里不能出现 fnd_r37 的谓词

用法:python3 regress_direction.py
"""
import json
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ.setdefault("MA_RUNTIME", "stub")

import ma_core
import ma_pipeline as P

OK, BAD = [], []


def check(name, cond, detail=""):
    (OK if cond else BAD).append(name)
    print("  [{}] {}{}".format("PASS" if cond else "FAIL", name,
                               ("  <- " + detail) if detail else ""))


# ---------------------------------------------------------------- 1) 单测
print("\n=== 1) pick_push_rules 单测 ===")
CASES = [
    ("audience_segment + push",            {"source": "audience_segment", "direction": "push",
                                            "sql_filter": "a=1", "finding_id": "fnd_model_x"}, True),
    ("audience_segment + exclude",         {"source": "audience_segment", "direction": "exclude",
                                            "sql_filter": "a=1", "finding_id": "fnd_r9"}, False),
    ("exclude + direction_raw=促付(救回)", {"source": "audience_segment", "direction": "exclude",
                                            "direction_raw": "促付", "sql_filter": "a=1",
                                            "finding_id": "fnd_r41"}, True),
    ("exclude + direction_raw=某种新说法",  {"source": "audience_segment", "direction": "exclude",
                                            "direction_raw": "某种新说法", "sql_filter": "a=1",
                                            "finding_id": "fnd_r99"}, False),
    ("audience_segment 缺 direction",      {"source": "audience_segment", "sql_filter": "a=1",
                                            "finding_id": "fnd_r8"}, True),
    ("diagnostic_rule + push",             {"source": "diagnostic_rule", "direction": "push",
                                            "sql_filter": "a=1"}, False),
    # 同一个坑的另一半:direction 本身就是中文动作词,没有 direction_raw 兜底。
    # 真 skill 的 schema 不约束 direction,crowd-rules 也只统计 push/exclude 两个值,
    # 别的原样带出来 —— 所以「促付」完全可能直接落在 direction 上。
    ("direction 直接就是促付(救回)",       {"source": "audience_segment", "direction": "促付",
                                            "sql_filter": "a=1",
                                            "finding_id": "fnd_r41"}, True),
    ("direction 是没见过的说法",            {"source": "audience_segment", "direction": "冷却",
                                            "sql_filter": "a=1",
                                            "finding_id": "fnd_r98"}, False),
]
for label, rule, want_in in CASES:
    segs, picked, excluded, fixes = P.pick_push_rules([rule], "both")
    check(label, (len(segs) == 1) == want_in,
          "segs={} excluded={}".format(len(segs), len(excluded)))
_, _, ex, _ = P.pick_push_rules([CASES[1][1]], "both")
check("excluded_rules 不带 sql_filter", "sql_filter" not in (ex[0] if ex else {}))

# 2026-07-29 job_...105131 的出参:fnd_r41 确实进了 rules、size.push 也算了它,
# 可它自己的 direction 字段还写着 exclude。下游照 direction 再过一遍就白救了。
_r41 = dict(CASES[2][1])
_segs41, _, _, _ = P.pick_push_rules([_r41], "both")
_out41 = _segs41[0] if _segs41 else {}
check("救回来的规则 direction 也要改成 push", _out41.get("direction") == "push",
      "direction={}".format(_out41.get("direction")))
check("原值留痕 direction_from_skill", _out41.get("direction_from_skill") == "exclude")
check("原 direction_raw 不丢", _out41.get("direction_raw") == "促付")
check("不就地改坏调用方的 dict", _r41.get("direction") == "exclude")

# 2026-07-29 本地端到端:direction 上直接写着「促付」,没有 direction_raw。
# 上面那支救不到它 —— 它会一路滑进 excluded,和 fnd_r41 死法一模一样,只是换了字段。
_bare = {"source": "audience_segment", "direction": "促付", "sql_filter": "a=1",
         "name": "创单未付待促付人群", "finding_id": "fnd_r41"}
_segsb, _, _exb, _fixb = P.pick_push_rules([_bare], "both")
check("direction=促付 也要被认回 push", len(_segsb) == 1 and not _exb,
      "segs={} excluded={}".format(len(_segsb), len(_exb)))
check("认回来之后字段也改成 push", (_segsb[0] if _segsb else {}).get("direction") == "push",
      str((_segsb[0] if _segsb else {}).get("direction")))
check("原值留痕 direction_from_skill=促付",
      (_segsb[0] if _segsb else {}).get("direction_from_skill") == "促付")
check("纠正这件事要吵一声", any("促付" in f and "已纠正为 push" in f for f in _fixb),
      json.dumps(_fixb, ensure_ascii=False)[:160])
check("不就地改坏调用方的 dict(direction 这支同样)", _bare.get("direction") == "促付")

_odd = {"source": "audience_segment", "direction": "冷却", "sql_filter": "a=1",
        "name": "近期已触达疲劳人群", "finding_id": "fnd_r98"}
_segso, _, _exo, _fixo = P.pick_push_rules([_odd], "both")
check("认不出来的方向按 exclude 处理,不硬塞进推送包",
      not _segso and len(_exo) == 1 and _exo[0].get("direction") == "exclude",
      json.dumps(_exo, ensure_ascii=False)[:160])
check("认不出来也要吵一声,不能无声吞掉",
      any("未识别" in f for f in _fixo), json.dumps(_fixo, ensure_ascii=False)[:160])

# ---------------------------------------------------------------- 2) 真实数据重放
print("\n=== 2) 2026-07-28 真实 crowd_rules 重放 ===")


def find_real_rules():
    """找一份真出过事的 crowd_rules.json 来重放。

    三个地方按顺序找:云端拷贝的 运行证据/、服务器上现跑出来的 jobs/、
    以及跟着安装包一起发的 fixtures/。

    fixtures/ 那份是兜底,而且是**必须有**的一份:这一节的 5 条断言正好就是
    「fnd_r41 创单未付待促付人群被认回 push」那个线上问题的回归。早先只找前两个
    地方,于是刚解包的机器上它一条都不跑,汇总还是"全过"—— 一个只在自己电脑上
    生效的回归,等于没有。

    真跑出来的排在 fixtures 前面:要是服务器上新跑的那单里也有 fnd_r41,拿它重放
    比拿一份三天前的存档更有意义 —— 那才是"现在这台机器上还对不对"。

    只认带 fnd_r41 的那种:这一节的断言全都围着「促付被认回 push」写,
    随便挑一份不含它的数据来跑,挂掉的是数据而不是代码,那种红是骗人的。
    """
    import glob
    here = os.path.dirname(os.path.abspath(__file__))
    cands = sorted(glob.glob(os.path.join(here, "运行证据/jobs/*/run/crowd_rules.json")) +
                   glob.glob(os.path.join(here, "jobs/*/run/crowd_rules.json")),
                   reverse=True)
    # 兜底的存档单独接在后面,不参与上面那个按时间倒序的排序 ——
    # 它的路径里没有 job_日期,混进去排只会排出个随机位置。
    cands += sorted(glob.glob(os.path.join(here, "fixtures/crowd_rules_*.json")))
    for p in cands:
        try:
            with open(p, encoding="utf-8") as f:
                rules = json.load(f)
        except Exception:
            continue
        if isinstance(rules, list) and any(
                (r or {}).get("finding_id") == "fnd_r41" for r in rules if isinstance(r, dict)):
            return p, rules
    return (cands[0] if cands else "(没找到任何 crowd_rules.json)"), None


REAL, real_rules = find_real_rules()
# 这条本身就是一条断言,不是一句提示。少了它,"找不到数据"这件事只会打印一行
# "(跳过:...)",而 install.sh 只看汇总的最后两行 —— 于是 5 条断言一条没跑,
# 屏幕上却是干干净净的"全过"。这种绿比红危险得多。
check("重放数据找得到(fixtures/ 里的存档兜底)", real_rules is not None, REAL)
if real_rules is not None:
    print("  重放数据:{}".format(REAL))
    for ps in ("both", "model", "rule"):
        segs, picked, excluded, fixes = P.pick_push_rules(real_rules, ps)
        tot = sum(r.get("estimated_size") or 0 for r in picked)
        print("  push_source={:<6} 进包 {} 条 (est 上限 {})".format(ps, len(picked), tot))
        if ps == "both":
            for r in picked:
                print("      + {:<28} {:<40} est={}".format(
                    r.get("name"), r.get("finding_id"), r.get("estimated_size")))
            for e in excluded:
                print("      - {:<28} {:<10} est={}".format(
                    e.get("name"), e.get("finding_id"), e.get("estimated_size")))
            for fx in fixes:
                print("      ! {}".format(fx))
            names = {r.get("finding_id") for r in picked}
            check("真实数据:fnd_r41 被认回 push", "fnd_r41" in names)
            check("真实数据:fnd_r37 挡在包外", "fnd_r37" not in names)
            check("真实数据:fnd_r11 挡在包外", "fnd_r11" not in names)
            sql = P.build_push_sql(picked, "tmp_dm.t", "mapid", "unionid")
            check("push_sql 不含疲劳谓词 insite_channel_cnt",
                  "insite_channel_cnt" not in sql)
            check("push_sql 不含错配谓词 pre_mkt_product_browse_match = 0",
                  "pre_mkt_product_browse_match = 0" not in sql)
else:
    print("  (跳过:找不到含 fnd_r41 的真实 crowd_rules.json;最近的候选是 {})".format(REAL))

# ---------------------------------------------------------------- 3) stub 全链路
print("\n=== 3) stub 全链路 ===")
RUN = "/tmp/regress_direction"
shutil.rmtree(RUN, ignore_errors=True)
os.makedirs(RUN + "/pub")
os.environ["MA_RUNTIME"] = "stub"
os.environ["MA_PUBLIC_DIR"] = RUN + "/pub"
os.environ["MA_URL_BASE"] = "http://localhost/x"
P._BACKEND_CACHE = None  # 后端按 env 现算,别吃上一次的缓存


def fake_cli(*a, **kw):
    # 让 polish 走优雅降级分支:返回 dict 而不是字符串,否则 polish_state 会 AttributeError
    return {"exit_code": 1, "elapsed_sec": 0.0, "stdout": "", "timed_out": False}


res = P.run_pipeline({"activity_id": "REGRESS", "date": "2026-07-28",
                      "push_source": "both"},
                     RUN, log=lambda m: None, set_phase=lambda *a, **k: None,
                     call_cli=fake_cli, extract_json=ma_core.extract_json)
spec = res.get("crowd_spec") or {}
rules = spec.get("rules") or []
excluded = spec.get("excluded_rules") or []
dropped = spec.get("dropped_rules") or []
sql = spec.get("push_sql") or ""
print("  size.push      = {}".format((spec.get("size") or {}).get("push")))
print("  rules          = {} 条  {}".format(
    len(rules), [r.get("finding_id") for r in rules]))
print("  excluded_rules = {} 条  {}".format(
    len(excluded), [e.get("finding_id") for e in excluded]))
print("  dropped_rules  = {} 条".format(len(dropped)))

ids = {r.get("finding_id") for r in rules}
ex_ids = {e.get("finding_id") for e in excluded}
check("哨兵1 fnd_r37 没混进推送包", "fnd_r37" not in ids)
check("哨兵2 fnd_r41 被认回 push", "fnd_r41" in ids and "fnd_r41" not in ex_ids)
check("哨兵3 坏列规则被 dry-run 剔掉", len(dropped) >= 1)
check("哨兵4 push_sql 不含 fnd_r37 谓词",
      not any((r.get("finding_id") == "fnd_r37" and (r.get("sql_filter") or "") in sql)
              for r in P._load(os.path.join(RUN, "crowd_rules.json"))))
rescue = [w for w in (res.get("warnings") or []) if "促付" in w]
check("哨兵2b warnings 里有纠正记录", bool(rescue),
      rescue[0] if rescue else "没有任何提到促付的 warning")

print("\n=== 汇总:{} 过 / {} 挂 ===".format(len(OK), len(BAD)))
for b in BAD:
    print("  挂: {}".format(b))
sys.exit(1 if BAD else 0)
