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
# fix21 起 segs 收全部方向(出参 rules[] 要全给),所以这里断言的不再是"进没进 segs",
# 而是**归一化后的 direction 对不对** —— 那才是调用方分流的依据,也是 push_sql
# 过滤的依据。want_push=True 表示这条应当被判成 push。
for label, rule, want_push in CASES:
    segs, picked, excluded, fixes = P.pick_push_rules([rule], "both")
    got = (segs[0].get("direction") if segs else None)
    if rule.get("source") != "audience_segment" or not rule.get("sql_filter"):
        # source 轴:诊断规则是"发现"不是投放包,压根不进 segs —— 这条没变
        check(label, len(segs) == 0, "segs={}(source 轴挡掉,符合预期)".format(len(segs)))
    else:
        check(label, len(segs) == 1 and (got == "push") == want_push,
              "segs={} direction={} excluded={}".format(len(segs), got, len(excluded)))
_, _, ex, _ = P.pick_push_rules([CASES[1][1]], "both")
check("excluded 视图不带 sql_filter(它只给 notes/meta 用)",
      "sql_filter" not in (ex[0] if ex else {}))

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
check("认不出来的方向按 exclude 处理(进 rules[] 但 direction=exclude,不进 push_sql)",
      len(_segso) == 1 and _segso[0].get("direction") == "exclude"
      and len(_exo) == 1 and _exo[0].get("direction") == "exclude",
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

            # ── fix21 红线:rules[] 带两个方向,但推送口径只含 push ──────────────
            # 这是 7/28 事故的唯一防线。picked 现在故意含 exclude(出参要全给),
            # 一旦有人把 push_only 那层过滤删掉/写错,下面三条会立刻红。
            _push_only = [r for r in picked
                          if (r.get("direction") or "").strip().lower() == "push"]
            _excl_in_picked = [r for r in picked
                               if (r.get("direction") or "").strip().lower() != "push"]
            check("fix21:picked 同时含 push 与 exclude(出参 rules[] 全给)",
                  bool(_push_only) and bool(_excl_in_picked),
                  "push={} exclude={}".format(len(_push_only), len(_excl_in_picked)))
            _sql_push = P.build_push_sql(_push_only, "tmp_dm.t", "mapid", "unionid")
            _sql_push = ((_sql_push[0] or "") + (_sql_push[1] or "")
                         if isinstance(_sql_push, tuple) else (_sql_push or ""))
            _leak = [r.get("finding_id") for r in _excl_in_picked
                     if (r.get("sql_filter") or "").strip()
                     and (r.get("sql_filter") or "").strip() in _sql_push
                     and (r.get("sql_filter") or "").strip()
                     not in {(x.get("sql_filter") or "").strip() for x in _push_only}]
            check("★ fix21 红线:push_sql 不含任何 exclude 独有谓词", not _leak, str(_leak))
            check("★ fix21 红线:push_sql 谓词数 == push 规则数(exclude 一条没混进来)",
                  _sql_push.count("OR") // 2 + 1 == len(_push_only) or len(_push_only) <= 1,
                  "push 规则 {} 条".format(len(_push_only)))
            # 反向用例:故意把 exclude 并进去,断言必须能抓到 —— 防止上面那条恒真
            _bad = P.build_push_sql(picked, "tmp_dm.t", "mapid", "unionid")
            _bad = (_bad[0] or "") + (_bad[1] or "") if isinstance(_bad, tuple) else (_bad or "")
            _caught = any((r.get("sql_filter") or "").strip() in _bad for r in _excl_in_picked)
            check("★ 反向用例:exclude 真混进 push_sql 时断言抓得到(防哨兵恒真)", _caught)
            # fix20(2026-08-14 部署实证):「fnd_r37/fnd_r11 挡在包外」是按 20260728
            # 存档里它们是 exclude 写死的。重放优先取服务器上最新真实 job,而方向是
            # **数据的事实** —— 某活动把 #37 判成显著正向(positive→push)完全合法,
            # 写死 id 会把"数据变了"误报成"代码坏了"。真正的不变量与 id 无关:
            # 数据里非 push 方向、又不是促付回收(direction_raw=促付)的条目,
            # 一个都不许进推送包;它们的谓词也不许出现在 push_sql 里。
            # fix21:非 push 方向现在**应当**出现在 picked/rules[] 里(调用方按
            # direction 分流)。所以这里断言的不再是"没进包",而是"进了包但方向标对了" ——
            # 标错方向 = 下游分流分错 = 和当年混进 push_sql 一样的后果。
            blocked = {r.get("finding_id") for r in real_rules
                       if isinstance(r, dict)
                       and (r.get("direction") or "") != "push"
                       and (r.get("direction_raw") or "") != "促付"}
            _in_pack = {r.get("finding_id"): (r.get("direction") or "") for r in picked}
            _mislabeled = [fid for fid in blocked
                           if _in_pack.get(fid) not in (None, "exclude")]
            check("真实数据:非 push 条目进了 rules[] 且方向标成 exclude(不是标成 push)",
                  not _mislabeled, str(_mislabeled or ""))
            sql = P.build_push_sql(picked, "tmp_dm.t", "mapid", "unionid")
            if isinstance(sql, tuple):          # build_push_sql 返回 (push_sql, count_sql)
                sql = (sql[0] or "") + (sql[1] or "")
            # 谓词哨兵按「被排除条目自己的完整 sql_filter」查,不按字段片段 ——
            # insite_channel_cnt 这类片段是多条规则共用的,某条含它的规则合法转正
            # (如 #37 判显著正向)后,片段哨兵会把合法进包误报成泄漏。
            # 同一谓词可能同时挂在"进包条目"和"排除条目"上(diagnostic_rule 与
            # audience_segment 双轨产出),那不算泄漏 —— 谓词在包里是因为进包的那条。
            _picked_filters = {(r.get("sql_filter") or "").strip() for r in picked}
            _leak_sql = []
            for _r in real_rules:
                if not isinstance(_r, dict) or _r.get("finding_id") not in blocked:
                    continue
                _f = (_r.get("sql_filter") or "").strip()
                if _f and _f in (sql or "") and _f not in _picked_filters:
                    _leak_sql.append("{}:{}".format(_r.get("finding_id"), _f[:40]))
            check("push_sql 不含仅属于被排除条目的谓词",
                  not _leak_sql, str(_leak_sql or ""))
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
# fix21:fnd_r37 现在会出现在 rules[] 里(调用方要按 direction 分流),
# 但它必须被标成 exclude,且绝不能进 push_sql —— 见哨兵4。
_r37 = [r for r in rules if r.get("finding_id") == "fnd_r37"]
check("哨兵1 fnd_r37 进 rules[] 但被标成 exclude",
      bool(_r37) and all((r.get("direction") or "") == "exclude" for r in _r37),
      str([r.get("direction") for r in _r37]))
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
