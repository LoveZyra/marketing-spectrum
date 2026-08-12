#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""issue_ledger 测试（fix22）。

覆盖：并发安全 / 折叠 / 冲突 / 状态 / 容错 / 采集 / 趋势 / 越界防护 / 迁移 / 行长 / R3 合并。
运行：python3 tests/test_issue_ledger.py
"""
from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

# skill 目录名可能含连字符（marketing-audit），不能当包名 import。
# 把 skill 根目录加进 sys.path，直接 import snippets 包即可 —— snippets/ 内的相对 import 照常工作。
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from snippets import issue_ledger as il      # noqa: E402

fails: list[str] = []


def check(label: str, cond: bool, extra: str = "") -> None:
    print(f"{'PASS' if cond else 'FAIL'}  {label}{('  ' + extra) if extra else ''}")
    if not cond:
        fails.append(label)


def obs(key: str, **kw) -> dict:
    d = {"t": "observe", "issue_key": key, "kind": "field_missing", "source": "auto"}
    d.update(kw)
    return d


# ── 并发安全 ──────────────────────────────────────────────────────────

def _worker(payload):
    path_s, wid, n = payload
    sys.path.insert(0, str(ROOT))
    from snippets import issue_ledger as mod
    p = Path(path_s)
    for i in range(n):
        mod.append({"t": "observe", "issue_key": f"w{wid}:k{i}", "kind": "field_missing",
                    "source": "auto", "detail": "x" * 100}, p)
    return n


def test_concurrent(tmp: Path) -> None:
    p = tmp / "conc.jsonl"
    with ProcessPoolExecutor(max_workers=8) as ex:
        list(ex.map(_worker, [(str(p), w, 200) for w in range(8)]))
    lines = p.read_text(encoding="utf-8").splitlines()
    check("并发：8 进程 × 200 行 = 1600 行", len(lines) == 1600, f"实际 {len(lines)}")
    bad = 0
    for ln in lines:
        try:
            json.loads(ln)
        except Exception:
            bad += 1
    check("并发：无撕裂行（每行均可解析）", bad == 0, f"坏行 {bad}")


# ── 折叠 / 冲突 / 状态 ────────────────────────────────────────────────

def test_fold(tmp: Path) -> None:
    p = tmp / "fold.jsonl"
    for i in range(5):
        il.append(obs("rule3:field_missing:x", campaign_id=f"c{i % 3}", rule_id=3,
                      field="x", ts=f"2026-08-{10+i:02d}T00:00:00+08:00"), p)
    items = il.load(p)
    it = items[0]
    check("折叠：count=5", it["count"] == 5, str(it["count"]))
    check("折叠：campaigns 去重 = 3", it["n_campaigns"] == 3, str(it["n_campaigns"]))
    check("折叠：first/last_seen 正确",
          it["first_seen"].startswith("2026-08-10") and it["last_seen"].startswith("2026-08-14"))

    p2 = tmp / "trunc.jsonl"
    for i in range(30):
        il.append(obs("k", campaign_id=f"c{i}"), p2)
    it2 = il.load(p2)[0]
    check("折叠：campaigns 截断到 20 并标记",
          len(it2["campaigns"]) == 20 and it2["campaigns_truncated"] and it2["n_campaigns"] == 30)


def test_conflict(tmp: Path) -> None:
    p = tmp / "conf.jsonl"
    il.record_feedback(source="user", kind="rule_semantics", rule_id=11, scope="systematic",
                       user_quote="太松了", reporter="甲", path=p)
    il.record_feedback(source="user", kind="rule_semantics", rule_id=11, scope="this_job",
                       user_quote="太紧了", reporter="乙", path=p)
    it = il.load(p)[0]
    check("冲突：标记 conflicting", it["conflicting"] is True)
    check("冲突：两条原话都保留（不互相覆盖）",
          len(it["user_quotes"]) == 2 and "太松了" in it["user_quotes"] and "太紧了" in it["user_quotes"])
    check("冲突：两位提出人都在", it["reporters"] == ["乙", "甲"] or it["reporters"] == ["甲", "乙"])


def test_status(tmp: Path) -> None:
    p = tmp / "st.jsonl"
    il.append(obs("rule9:field_missing:z"), p)
    il.set_status("rule9:field_missing:z", "promoted", "fix23 已修", "tianji", path=p)
    check("状态：promoted 生效", il.load(p)[0]["status"] == "promoted")
    il.set_status("rule9:field_missing:z", "rejected", "复议后不改", path=p)
    it = il.load(p)[0]
    check("状态：取最后一条", it["status"] == "rejected", it["status"])
    check("状态：非法值被拒", il.set_status("k", "whatever", path=p) is False)


# ── 容错 ──────────────────────────────────────────────────────────────

def test_tolerance(tmp: Path) -> None:
    p = tmp / "bad.jsonl"
    il.append(obs("good:1"), p)
    with open(p, "a", encoding="utf-8") as f:
        f.write('{"t":"observe","issue_key":"broken\n')     # 半行
        f.write("not json at all\n")
    il.append(obs("good:2"), p)
    items = il.load(p)
    check("容错：坏行跳过不抛，好行仍在", len(items) == 2, f"{len(items)} 条")

    # 用"父路径是个文件"制造不可写，比 chmod 可靠 —— root 会绕过权限位
    blocker = tmp / "notadir"
    blocker.write_text("i am a file", encoding="utf-8")
    ok = il.append(obs("x"), blocker / "sub" / "x.jsonl")
    check("容错：路径不可写时 append 返回 False 且不抛", ok is False)

    check("容错：文件不存在时 load 返回空", il.load(tmp / "nope.jsonl") == [])


def test_line_length(tmp: Path) -> None:
    p = tmp / "long.jsonl"
    il.record_feedback(source="user", kind="rule_semantics", rule_id=1,
                       user_quote="很" * 5000, detail="长" * 5000, path=p)
    line = p.read_text(encoding="utf-8").splitlines()[0]
    check("行长：单行 < 4KB", len(line.encode("utf-8")) < il.MAX_LINE_BYTES,
          f"{len(line.encode('utf-8'))} bytes")
    check("行长：截断后仍是合法 json", isinstance(json.loads(line), dict))


# ── 采集器 ────────────────────────────────────────────────────────────

CTX = {"job_id": "job_x", "campaign_id": "1000344", "campaign_channel": "push"}


def test_collect(tmp: Path) -> None:
    rows = [
        {"rule_id": 3, "status": "skipped",
         "skip_reason": "必要字段缺失: ['pre_popup_close_rate']"},
        {"rule_id": 13, "status": "full_trigger_no_baseline", "skip_reason": None},
        {"rule_id": 1, "status": "triggered", "trigger_rate": 0.3, "skip_reason": None},
        {"rule_id": 45, "status": "not_applicable", "skip_reason": "不适用"},
    ]
    recs = il.collect_from_rule_summary(rows, CTX)
    kinds = sorted(r["kind"] for r in recs)
    check("采集：只抽明确异常（不含 triggered/not_applicable）",
          kinds == ["field_missing", "full_trigger"], str(kinds))
    fm = [r for r in recs if r["kind"] == "field_missing"][0]
    check("采集：字段名解析正确", fm["field"] == "pre_popup_close_rate", str(fm["field"]))
    check("采集：issue_key 稳定", fm["issue_key"] == "rule3:field_missing:pre_popup_close_rate")

    snap = il.build_job_snapshot(rows, CTX)
    check("快照：覆盖全部规则", len(snap["rules"]) == 4)
    check("快照：单行 < 4KB",
          len(json.dumps(snap, ensure_ascii=False).encode("utf-8")) < il.MAX_LINE_BYTES)

    lint = il.collect_from_lint(
        [{"level": "warn", "code": "missing_typical_case", "message": "缺 typical_case"},
         {"level": "block", "code": "no_core", "message": "核心问题为空"}], CTX)
    check("采集：lint 只收 warn 不收 block",
          len(lint) == 1 and lint[0]["issue_key"] == "lint:missing_typical_case")

    crit = il.collect_from_critique(
        {"self_critique": [{"type": "closure", "severity": "error", "message": "未闭环"},
                           {"type": "x", "severity": "info", "message": "忽略"}]}, CTX)
    check("采集：critique 只收 error/warning", len(crit) == 1 and crit[0]["issue_key"] == "critique:closure")


def test_trend() -> None:
    snaps = [{"t": "job_snapshot", "ts": f"2026-08-{d:02d}T00:00:00+08:00",
              "rules": {"38": ["not_triggered", 0.0], "1": ["triggered", 0.3],
                        "3": ["skipped", None]}}
             for d in range(1, 13)]
    tr = il.trend_signals(snaps, na_streak=10, never_streak=10)
    kinds = {t["rule_id"]: t["kind"] for t in tr}
    check("趋势：连续 12 次 not_triggered → rule_never_triggers",
          kinds.get(38) == "rule_never_triggers", str(kinds))
    check("趋势：连续 skipped → rule_always_skipped", kinds.get(3) == "rule_always_skipped")
    check("趋势：正常触发的规则不产出信号", 1 not in kinds)

    snaps2 = snaps[:-1] + [{"t": "job_snapshot", "ts": "2026-08-13T00:00:00+08:00",
                            "rules": {"38": ["triggered", 0.2]}}]
    check("趋势：连续段被打断即不报", not [t for t in il.trend_signals(snaps2) if t["rule_id"] == 38])


# ── 越界防护 ──────────────────────────────────────────────────────────

def test_boundaries() -> None:
    src = (ROOT / "snippets" / "issue_ledger.py").read_text(encoding="utf-8")
    check("越界：issue_ledger 不写 yaml",
          "safe_dump" not in src and "yaml.dump" not in src)
    eng = (ROOT / "snippets" / "diagnostic_engine.py").read_text(encoding="utf-8")
    check("越界：DiagnosticEngine 不引用 issue_ledger（保持纯统计层）",
          "issue_ledger" not in eng)
    check("越界：非法 kind 被拒",
          il.record_feedback(source="user", kind="随便编一个", rule_id=1) is False)
    check("越界：非法 source 被拒",
          il.record_feedback(source="robot", kind="wrong_scope", rule_id=1) is False)


# ── 迁移 ──────────────────────────────────────────────────────────────

def test_migration(tmp: Path) -> None:
    import importlib
    home = tmp / "home"
    (home / ".marketing_audit_skill").mkdir(parents=True)
    old = home / ".marketing_audit_skill" / "adhoc_history.jsonl"
    old.write_text('{"name":"t1","code_hash":"h1"}\n', encoding="utf-8")

    # 本用例会碰到真实的 feedback/ 目录（要验的就是"默认路径落在哪"）。
    # 用**快照 + 写回**做还原，不用 unlink —— 部分挂载/共享目录允许写但不允许删，
    # 用删除做清理会让测试在这些环境里直接崩掉（实测 Cowork 挂载即如此）。
    new_fb = ROOT / "feedback" / "adhoc_history.jsonl"
    backup = new_fb.read_bytes() if new_fb.exists() else b""
    new_fb.parent.mkdir(parents=True, exist_ok=True)
    new_fb.write_bytes(b"")          # 置空 = 视作"新路径尚无文件"，触发迁移分支

    real_home = os.environ.get("HOME")
    os.environ["HOME"] = str(home)
    os.environ.pop("MARKETING_AUDIT_HOME", None)
    try:
        from snippets import adhoc_registry as _ar_mod
        ar = importlib.reload(_ar_mod)
        p1 = ar._default_history_path()
        check("迁移：新路径落在 feedback/", p1.parent.name == "feedback", str(p1))
        check("迁移：新路径存在但为 0 字节时仍会迁移（不因占位文件被静默跳过）",
              p1.exists() and p1.stat().st_size > 0)
        check("迁移：内容已搬过来", p1.exists() and "h1" in p1.read_text(encoding="utf-8"))
        check("迁移：旧文件保留（只搬不删）", old.exists())
        p1.write_text('{"name":"t1","code_hash":"h1"}\n{"name":"t2","code_hash":"h2"}\n',
                      encoding="utf-8")
        ar._default_history_path()
        check("迁移：重复执行不覆盖已有新文件",
              len(p1.read_text(encoding="utf-8").strip().splitlines()) == 2)

        os.environ["MARKETING_AUDIT_HOME"] = str(tmp / "envdir")
        ar2 = importlib.reload(ar)
        check("迁移：MARKETING_AUDIT_HOME 仍最高优先",
              str(ar2._default_history_path()).startswith(str(tmp / "envdir")))
    finally:
        os.environ.pop("MARKETING_AUDIT_HOME", None)
        if real_home:
            os.environ["HOME"] = real_home
        # 还原：写回原内容；原本不存在的，置空即可（空账本等价于无账本，load_history 返回 []）
        try:
            new_fb.write_bytes(backup)
        except Exception:
            pass


# ── R3：两份账本 cat 合并后 compact ───────────────────────────────────

def test_r3_merge(tmp: Path) -> None:
    a, b = tmp / "a.jsonl", tmp / "b.jsonl"
    for i in range(3):
        il.append(obs(f"k{i}", ts=f"2026-08-1{i}T00:00:00+08:00"), a)
    shutil.copy2(a, b)                       # 模拟备份
    il.append(obs("k9", ts="2026-08-20T00:00:00+08:00"), a)   # 备份期间新增
    merged = tmp / "m.jsonl"
    merged.write_bytes(b.read_bytes() + a.read_bytes())        # install.sh 的 cat
    n = il.compact(merged)
    check("R3：cat 合并后 compact 去重", n == 4, f"{n} 行")
    check("R3：合并不丢新条目", {i["issue_key"] for i in il.load(merged)} ==
          {"k0", "k1", "k2", "k9"})


# ── 报告 ──────────────────────────────────────────────────────────────

def test_report(tmp: Path) -> None:
    p = tmp / "rep.jsonl"
    il.record_feedback(source="user", kind="wrong_scope", rule_id=11, scope="systematic",
                       user_quote="对新客不成立", reporter="张三", agent_verdict="agreed",
                       agent_note="#11 未用 type_mem", campaign_id="1000344", path=p)
    for i in range(4):
        il.append(obs("rule3:field_missing:pre_popup_close_rate", rule_id=3,
                      field="pre_popup_close_rate", campaign_id=f"c{i}"), p)
    for d in range(1, 13):
        il.append({"t": "job_snapshot", "ts": f"2026-08-{d:02d}T00:00:00+08:00",
                   "rules": {"38": ["not_triggered", 0.0]}}, p)

    old = il.ledger_path
    il.ledger_path = lambda: p                        # noqa: E731
    try:
        md = il.build_report()
    finally:
        il.ledger_path = old
    for frag, label in (("## 一、用户 / Agent 反馈", "报告：有用户反馈栏"),
                        ("对新客不成立", "报告：原话全文出现"),
                        ("```diff", "报告：带 yaml diff 草稿"),
                        ("## 二、自动信号", "报告：有自动信号栏"),
                        ("rule_never_triggers", "报告：趋势信号出现")):
        check(label, frag in md or frag.replace("rule_never_triggers", "下线候选") in md)
    check("报告：用户反馈与自动信号分栏（不混排按 count）",
          md.index("## 一、用户 / Agent 反馈") < md.index("## 二、自动信号"))
    check("报告：注明不自动改 yaml", "绝不自动修改 yaml" in md)


# ── 主 ────────────────────────────────────────────────────────────────

def main() -> int:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        test_concurrent(tmp)
        test_fold(tmp)
        test_conflict(tmp)
        test_status(tmp)
        test_tolerance(tmp)
        test_line_length(tmp)
        test_collect(tmp)
        test_trend()
        test_boundaries()
        test_migration(tmp)
        test_r3_merge(tmp)
        test_report(tmp)
    print()
    print("=" * 62)
    print("结果：" + ("全部通过" if not fails else f"失败 {len(fails)} 项：" + ", ".join(fails)))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
