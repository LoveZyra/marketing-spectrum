#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fix30:规则链路正确性门禁 —— 解析对 → SQL 对 → 中文对,每环各有裁判。

九道门,任何一道红都不许发版:
  1) 渲染器性质测试:随机结构化 steps → pandas/SQL 两形态在同一份含 NaN 的随机
     数据上命中**集合**相同(sqlite 只当 CI 裁判,不进生产);填充帧('__NA__')与
     raw 帧(NaN)两种空值表示下 pandas 结果一致。
  2) 合并等价:同特征多步合并后的条件 ≡ 合并前逐步条件的交集(紧边界/交并/补集
     改写逻辑是各形态共用的,它错四形态一起错,必须单独证)。
  3) 叶子 oracle 端到端:真训 LGB/XGB → 抽规则,oracle 自检失败数必须为 0。
  4) 标签覆盖门禁:规则库条件里用到的每个字段必须能翻出中文(新增字段没配标签
     直接红,杜绝出参里静默漏英文)。
  5) 规则库白名单 + 残留 + 语义对拍:35 条 condition_template 语法在白名单内;
     pandas_to_sql 无 pandas 残留;字段对字段的 !=/== 必须带双侧 notna 守卫
     (规则 42 空值分歧的教训);翻出的 SQL 与 pandas 条件在合成数据上命中集合相同。
  6) 中文黄金快照:35 条规则库 + 模型侧各类渲染样例的 sql_to_zh 产物与
     golden_filter_zh.json 逐条比对 —— 评审过的永不静默改变,没评审的进不来。
     (重新生成:GOLDEN_REGEN=1 python3 tests/test_rule_chain_fix30.py,改动需人工评审)
  7) 非法标识符字段(数字开头,如 360d_create_order_count)双端可执行:SQL 加反引号、
     pandas 走 _df['col'],且两端命中集合一致 —— 生产实锤过的坑,裸写两端都是语法错。
  8) 模型 seg 交付形态:drop_null 下无 IS NULL / 无 __NA__ 内部哨兵外露;
     drop_null=False(oracle 用的树真实形态)则空值路由照常渲染。
  9) sql_to_zh 认反引号字段。
"""
from __future__ import annotations

import json
import logging
import os
import re
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import model_analyst as ma            # noqa: E402
from snippets import crowd_translator as ct         # noqa: E402
from snippets.diagnostic_engine import eval_condition  # noqa: E402
from snippets.feature_labels import feature_label   # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


# ── 工具:pandas / sqlite 双跑取命中行集合 ────────────────────────────────


def _sqlite_hits(df: pd.DataFrame, sql_where: str) -> "set[int] | None":
    con = sqlite3.connect(":memory:")
    try:
        d = df.copy()
        for c in d.columns:
            if str(d[c].dtype) == "category":
                d[c] = d[c].astype(object)
            if d[c].dtype == object:
                d[c] = d[c].where(pd.notna(d[c]), None)
        d.to_sql("pop", con, index=False)
        rows = con.execute(f"SELECT rowid-1 FROM pop WHERE {sql_where}").fetchall()
        return {r[0] for r in rows}
    except Exception as exc:  # noqa: BLE001
        print("   sqlite 执行失败:", exc, "|", sql_where[:100])
        return None
    finally:
        con.close()


def _pd_hits(df: pd.DataFrame, cond: str) -> "set[int] | None":
    mask = eval_condition(cond, df)
    if mask is None:
        return None
    arr = np.asarray(mask, dtype=bool)
    return set(np.where(arr)[0].tolist())


# ── 1+2. 渲染器性质测试 + 合并等价 ───────────────────────────────────────

rng = np.random.default_rng(20260814)
POOL = ["酒店", "机票", "火车票", "景区", "门票"]


def _rand_df(n=400) -> pd.DataFrame:
    df = pd.DataFrame({
        "x": rng.choice([0, 1, 2, 3, 3.5, 4, 7.25, 10, np.nan], n),
        "y": rng.normal(5, 3, n),
        "c": rng.choice(POOL + [None], n),
    })
    df.loc[rng.choice(n, n // 6, replace=False), "y"] = np.nan
    return df


def _rand_steps() -> list:
    steps = []
    for _ in range(rng.integers(1, 5)):
        feat = rng.choice(["x", "y", "c"])
        na = bool(rng.integers(0, 2))
        if feat == "c":
            k = int(rng.integers(1, 4))
            names = set(rng.choice(POOL + ["__NA__"], k, replace=False).tolist())
            steps.append(("cat", "c", names, bool(rng.integers(0, 2)), na))
        else:
            thr = float(rng.choice([0.0, 1.0, 3.5, 4.0, 7.25]))
            closed = bool(rng.integers(0, 2))
            if rng.integers(0, 2):
                steps.append(("num", feat, (thr, closed), None, na))
            else:
                steps.append(("num", feat, None, (thr, closed), na))
    return steps


N_CASES = 300
mismatch_sql = mismatch_fill = mismatch_merge = exec_fail = 0
for _case in range(N_CASES):
    df = _rand_df()
    steps = _rand_steps()
    cat_maps = {"c": POOL + ["__NA__"]}
    _disp, sqls, pds = ma._merge_render_clauses(steps, cat_maps)
    if not sqls:
        continue
    sql_cond = " AND ".join(sqls)
    pd_cond = " & ".join(pds)

    h_sql = _sqlite_hits(df, sql_cond)
    h_pd = _pd_hits(df, pd_cond)
    if h_sql is None or h_pd is None:
        exec_fail += 1
        continue
    if h_sql != h_pd:
        mismatch_sql += 1
        if mismatch_sql <= 3:
            print("   ✗ SQL≠pandas:", steps, "|", sql_cond[:90])

    # 填充帧:分类空值填 '__NA__' 字符串(训练帧的表示),pandas 结果必须不变
    df_fill = df.copy()
    df_fill["c"] = df_fill["c"].where(pd.notna(df_fill["c"]), "__NA__")
    h_fill = _pd_hits(df_fill, pd_cond)
    if h_fill != h_pd:
        mismatch_fill += 1
        if mismatch_fill <= 3:
            print("   ✗ 填充帧漂移:", steps, "|", pd_cond[:90])

    # 合并等价:逐步单独渲染取交集 == 合并渲染
    inter: "set[int] | None" = None
    ok = True
    for st in steps:
        _d1, _s1, p1 = ma._merge_render_clauses([st], cat_maps)
        h1 = _pd_hits(df, " & ".join(p1)) if p1 else set(range(len(df)))
        if h1 is None:
            ok = False
            break
        inter = h1 if inter is None else (inter & h1)
    if ok and inter is not None and inter != h_pd:
        mismatch_merge += 1
        if mismatch_merge <= 3:
            print("   ✗ 合并不等价:", steps)

check(f"渲染器性质测试({N_CASES} 例):pandas ≡ SQL(命中集合逐行相同)",
      mismatch_sql == 0 and exec_fail == 0, f"不一致 {mismatch_sql} / 执行失败 {exec_fail}")
check("空值双表示:填充帧('__NA__') 与 raw 帧(NaN) 下 pandas 结果一致",
      mismatch_fill == 0, f"漂移 {mismatch_fill}")
check("合并等价:合并渲染 ≡ 逐步渲染取交集", mismatch_merge == 0, f"不等价 {mismatch_merge}")


# ── 3. 叶子 oracle 端到端(LGB + XGB) ────────────────────────────────────

class _CountWarn(logging.Handler):
    def __init__(self):
        super().__init__(level=logging.WARNING)
        self.n = 0

    def emit(self, record):  # noqa: ANN001
        self.n += 1


_h = _CountWarn()
ma.logger.addHandler(_h)
try:
    n = 3000
    df_t = pd.DataFrame({
        "visit_days": rng.integers(0, 90, n).astype(float),
        "gmv": rng.exponential(300, n),
        "cat": pd.Categorical(rng.choice(POOL + ["__NA__"], n)),
        "cnt": rng.poisson(5, n).astype(float),
    })
    df_t.loc[rng.choice(n, 400, replace=False), "visit_days"] = np.nan
    df_t.loc[rng.choice(n, 300, replace=False), "cnt"] = np.nan
    y_t = pd.Series(((df_t.visit_days.fillna(-1) > 30)
                     & (df_t.cat.isin(["酒店", "机票"]))
                     | (df_t.gmv > 600)).astype(int))
    import lightgbm as lgb
    import xgboost as xgbt
    m1 = lgb.LGBMClassifier(n_estimators=8, num_leaves=15,
                            min_child_samples=30, verbose=-1).fit(df_t, y_t)
    r1 = ma._extract_rules_lgb(m1, y_t.mean(), 100, X=df_t, y=y_t)
    m2 = xgbt.XGBClassifier(n_estimators=5, max_depth=4,
                            enable_categorical=True, tree_method="hist").fit(df_t, y_t)
    r2 = ma._extract_rules_xgb(m2, y_t.mean(), 100, X=df_t, y=y_t)
    check("端到端:LGB/XGB 规则抽取非空", len(r1) > 0 and len(r2) > 0,
          f"lgb={len(r1)} xgb={len(r2)}")
    check("端到端:叶子 oracle 自检失败数为 0", _h.n == 0, f"失败 {_h.n} 条")
    check("端到端:每条规则三形态齐全(rule_text/rule_sql/rule_pandas)",
          all(r.rule_text and r.rule_sql and r.rule_pandas for r in r1 + r2))
finally:
    ma.logger.removeHandler(_h)


# ── 4+5. 规则库:标签覆盖 / 白名单 / 残留 / 守卫 / 语义对拍 ────────────────

_yaml_text = (ROOT / "feature_schema" / "diagnostic_rules.yaml").read_text(encoding="utf-8")
CONDS = [c.strip() for c in re.findall(r"^\s*condition_template:\s*(.+)$", _yaml_text, flags=re.M)]
check("规则库条件读取", len(CONDS) >= 35, f"{len(CONDS)} 条")

_KEYWORDS = {"and", "or", "not", "in", "threshold", "optimal", "str", "contains",
             "isin", "isna", "notna", "na", "False", "True", "None", "p25", "p75", "p50"}
_ID_RE = re.compile(r"\b[A-Za-z_][A-Za-z0-9_]*\b")

# 4) 标签覆盖:条件里的每个字段必须能翻出中文
_no_label = set()
for c in CONDS:
    body = re.sub(r"'[^']*'|\"[^\"]*\"", "", c)
    for w in _ID_RE.findall(body):
        if w in _KEYWORDS:
            continue
        if feature_label(w) == w:
            _no_label.add(w)
check("标签覆盖门禁:规则库字段全部有中文标签", not _no_label, ",".join(sorted(_no_label)))

# 5a) 白名单:允许的语法之外出现即红
_BLACK = re.compile(r"~|\.between\(|\.str\.(startswith|endswith|len)\b|\.astype\(|"
                    r"\.fillna\(|\.round\(|\.abs\(|\.dt\.|\bBETWEEN\b", re.I)
_bad_syntax = [c for c in CONDS if _BLACK.search(c)]
check("白名单:无黑名单语法(~ / between / startswith / astype / fillna / dt 等)",
      not _bad_syntax, str(_bad_syntax[:2]))

# .str.contains 参数不得含正则元字符(pandas 按正则、SQL LIKE 按字面,语义会岔开)
_meta = []
for c in CONDS:
    for m in re.finditer(r"\.str\.contains\(\s*['\"]([^'\"]*)['\"]", c):
        if re.search(r"[|.*+\[\](){}?^$\\%_]", m.group(1)):
            _meta.append(c)
check("白名单:.str.contains 参数为纯字面量(无正则元字符)", not _meta, str(_meta[:1]))

# 5b) 字段对字段的 != / == 必须双侧 notna 守卫(规则 42 教训:NaN!=x 两侧归属相反)
_unguarded = []
for c in CONDS:
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*[!=]=\s*([A-Za-z_]\w*)\b", c):
        a, b = m.group(1), m.group(2)
        if b in _KEYWORDS or a in _KEYWORDS:
            continue
        if f"{a}.notna()" not in c or f"{b}.notna()" not in c:
            _unguarded.append(c)
check("字段对字段比较带双侧 notna 守卫", not _unguarded, str(_unguarded[:1]))

# 5c) 残留:翻完的 SQL 不得留 pandas 痕迹
_RESID = re.compile(r"\.str\.|\.isna\(|\.notna\(|\.isin\(|~|==|(?<![<>!])&")
_resolved = [re.sub(r"threshold\([^)]*\)", "3.5", c) for c in CONDS]
_sqls = [ct.pandas_to_sql(c) for c in _resolved]
_resid = [(c, s) for c, s in zip(_resolved, _sqls)
          if _RESID.search(re.sub(r"'[^']*'", "''", s))]
check("pandas_to_sql 无残留(35 条全翻净)", not _resid, str(_resid[:1]))


# 5d) 语义对拍:pandas 条件与翻译后 SQL 在合成数据上命中集合相同
def _synth_df_for(cond: str, n=300) -> pd.DataFrame:
    """按条件里的用法造合成数据:出现引号值/contains/字段对字段 → 字符串列,
    其余数值列。所有列都掺 20% 空值 —— 空值行为正是对拍要抓的。"""
    body = cond
    str_fields: dict[str, list] = {}
    for m in re.finditer(r"\b([A-Za-z_]\w*)\.str\.contains\(\s*['\"]([^'\"]*)['\"]", body):
        f, v = m.group(1), m.group(2)
        str_fields.setdefault(f, []).extend([v, f"前缀{v}后缀", "无关值甲", "无关值乙"])
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*[!=]=\s*['\"]([^'\"]*)['\"]", body):
        f, v = m.group(1), m.group(2)
        str_fields.setdefault(f, []).extend([v, "其他甲", "其他乙"])
    for m in re.finditer(r"\b([A-Za-z_]\w*)\.isin\(\s*\[([^\]]*)\]", body):
        f, vals = m.group(1), re.findall(r"['\"]([^'\"]*)['\"]", m.group(2))
        str_fields.setdefault(f, []).extend(vals + ["其他丙"])
    for m in re.finditer(r"\b([A-Za-z_]\w*)\s*[!=]=\s*([A-Za-z_]\w*)\b", body):
        a, b = m.group(1), m.group(2)
        if a not in _KEYWORDS and b not in _KEYWORDS:
            pool = ["app", "wx", "h5", "pc"]
            str_fields.setdefault(a, []).extend(pool)
            str_fields.setdefault(b, []).extend(pool)

    fields = [w for w in dict.fromkeys(_ID_RE.findall(re.sub(r"'[^']*'", "", body)))
              if w not in _KEYWORDS]
    df = pd.DataFrame(index=range(n))
    for f in fields:
        if f in str_fields:
            pool = list(dict.fromkeys(str_fields[f])) + [None]
            df[f] = rng.choice(pool, n)
        else:
            df[f] = rng.choice([0, 0.0, 1, 2, 3, 3.5, 4, 5, 8, 10, np.nan], n)
    return df


_pair_bad = []
for cond, sql in zip(_resolved, _sqls):
    df_s = _synth_df_for(cond)
    hp = _pd_hits(df_s, cond)
    hs = _sqlite_hits(df_s, sql)
    if hp is None or hs is None or hp != hs:
        _pair_bad.append((cond, "pd" if hp is None else ("sql" if hs is None else
                                                         f"差 {len(hp ^ hs)} 行")))
check("语义对拍:35 条规则库 pandas ≡ 翻译 SQL(含空值行)", not _pair_bad,
      str(_pair_bad[:2]))


# ── 6. 中文黄金快照 ─────────────────────────────────────────────────────

MODEL_SAMPLES = [
    "gmv <= 606.8277 AND cat IN ('机票','酒店') AND visit_days > 30.5",
    "(gmv <= 606.8277 OR gmv IS NULL) AND (cat IS NULL OR cat IN ('酒店'))",
    "(visit_days >= 31 OR visit_days IS NULL) AND cat NOT IN ('景区')",
    "(pre_total_event_cnt IS NOT NULL AND pre_total_event_cnt NOT IN ('0'))",
    "pre_is_dormant_user > 0",
]
golden_path = ROOT / "tests" / "golden_filter_zh.json"
current = {}
for c, s in zip(_resolved, _sqls):
    current[s] = ct.sql_to_zh(s)
for s in MODEL_SAMPLES:
    current[s] = ct.sql_to_zh(s)

if os.environ.get("GOLDEN_REGEN") == "1" or not golden_path.exists():
    golden_path.write_text(json.dumps(current, ensure_ascii=False, indent=1),
                           encoding="utf-8")
    print(f"NOTE  黄金快照已生成/更新:{golden_path.name}(共 {len(current)} 条,需人工评审)")
    golden = current
else:
    golden = json.loads(golden_path.read_text(encoding="utf-8"))

_drift = {k for k in set(golden) | set(current) if golden.get(k) != current.get(k)}
check("中文黄金快照:与评审版逐条一致(改动需 GOLDEN_REGEN=1 显式更新+人工评审)",
      not _drift, str(list(_drift)[:1]))
check("中文快照非空率 100%(闭合语法内不允许翻不出)",
      all(v for v in current.values()),
      str([k for k, v in current.items() if not v][:1]))

# sql_to_zh fail-closed:闭合语法之外必须拒绝而不是硬翻
check("sql_to_zh fail-closed:BETWEEN/CASE/坏字符 → 空串",
      ct.sql_to_zh("a BETWEEN 1 AND 2") == ""
      and ct.sql_to_zh("CASE WHEN a=1 THEN 1 END") == ""
      and ct.sql_to_zh("a & b") == "")
check("sql_to_zh 值不翻:英文代码值/中文值原样保留",
      "'popup'" in ct.sql_to_zh("activity_channel_std = 'popup'")
      and "'风险用户'" in ct.sql_to_zh("risk_type = '风险用户'"))


# ── 7. 非法标识符字段(数字开头,如 360d_create_order_count)双端可执行 ──────
# 2026-08-14 生产实锤:该列裸写在 pandas eval 里是语法错(规则被 oracle 全量剔除),
# 在 Hive 里同样是语法错(更早的 Spark dry-run 时代应是静默剔除,无人追查)。
# SQL 端加反引号、pandas 端走 _df['col'],两端都必须真能跑。

_bad_name = "360d_create_order_count"
_df_bad = pd.DataFrame({
    _bad_name: rng.choice(["0", "1", "5+", None], 200),
    "ok_col": rng.integers(0, 10, 200).astype(float),
})
_steps_bad = [("cat", _bad_name, {"0", "1"}, True, False), ("num", "ok_col", (3.0, True), None, False)]
_d3, _s3, _p3 = ma._merge_render_clauses(_steps_bad, {_bad_name: ["0", "1", "5+"]})
_sql_bad, _pd_bad = " AND ".join(_s3), " & ".join(_p3)
check("非法标识符字段 SQL 端加反引号", "`{}`".format(_bad_name) in _sql_bad, _sql_bad[:70])
check("非法标识符字段 pandas 端走 _df[...]", "_df['{}']".format(_bad_name) in _pd_bad, _pd_bad[:70])
_h_pd_bad = _pd_hits(_df_bad, _pd_bad)
_h_sql_bad = _sqlite_hits(_df_bad, _sql_bad)
check("非法标识符字段 pandas 可执行(非 None)", _h_pd_bad is not None)
check("非法标识符字段 SQL 可执行(非 None)", _h_sql_bad is not None)
check("非法标识符字段 pandas ≡ SQL", _h_pd_bad == _h_sql_bad,
      "{} vs {}".format(len(_h_pd_bad or []), len(_h_sql_bad or [])))

# ── 8. 模型 seg 交付形态:默认剔空值人群,内部哨兵不外露 ────────────────────
_steps_null = [("num", "ok_col", None, (3.0, True), True),
               ("cat", "c", {"__NA__", "酒店"}, True, True)]
_d4, _s4, _p4 = ma._merge_render_clauses(_steps_null, {"c": ["酒店", "机票", "__NA__"]}, drop_null=True)
_sql4 = " AND ".join(_s4)
check("drop_null 交付形态无 IS NULL", "IS NULL" not in _sql4, _sql4[:70])
check("drop_null 交付形态无 __NA__ 哨兵", "__NA__" not in _sql4, _sql4[:70])
_d5, _s5, _p5 = ma._merge_render_clauses(_steps_null, {"c": ["酒店", "机票", "__NA__"]}, drop_null=False)
check("drop_null=False 时空值路由照常渲染(树的真实形态,oracle 用它)",
      "IS NULL" in " AND ".join(_s5))

# ── 9. sql_to_zh 认反引号字段 ───────────────────────────────────────────
_zh_bad = ct.sql_to_zh("`360d_create_order_count` IN ('4','5+') AND ok_col > 3")
check("sql_to_zh 翻译反引号字段", "近1年订单数" in _zh_bad and "`" not in _zh_bad, _zh_bad)

print()
print("=" * 62)
print("结果:" + ("全部通过" if not fails else f"失败 {len(fails)} 项:" + ", ".join(fails)))
sys.exit(1 if fails else 0)
