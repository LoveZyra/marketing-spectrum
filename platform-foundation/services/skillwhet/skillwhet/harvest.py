"""Harvest tasks from real agent sessions (Claude Code transcripts).

Reads ``~/.claude/projects/<slug>/<session>.jsonl``, reduces each session to a
digest, and asks a model to mine checkable tasks from it.

Three rules that the reference implementation (skillopt_sleep) got wrong or
left open, fixed here:

  * redaction happens at HARVEST time, before anything reaches a model —
    skillopt_sleep never redacted its Claude source at all
  * a task with no rubric is dropped, never invented; rubric beats checks always
    (two real reward hacks were recorded against literal-string checks)
  * our own replay/optimizer sessions are filtered out, or the loop learns
    from its own output
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .backend import Backend, extract_json
from .evidence import TaskRecord, validate_judge

# ── Redaction ───────────────────────────────────────────────────────────────

# 键名像密钥、取值却显然不是密钥的:参数名 / 枚举 / 占位符(小写比较)
_NON_SECRET_VALUES = frozenset({
    "oauth", "oauth2", "bearer", "basic", "digest", "jwt", "hmac", "none", "null", "true", "false",
    "required", "optional", "enabled", "disabled", "default", "auto", "string", "str", "int", "integer",
    "env", "file", "header", "query", "cookie", "password", "token", "secret", "api_key", "apikey",
    "redacted", "[redacted]", "xxxx", "****", "<redacted>", "example", "changeme",
})
_NUMBER_RE = re.compile(r"[+-]?\d+(?:[.,_]\d+)*[kKmM]?")


def _keep_or_redact(m: re.Match, template: str) -> str:
    value = m.group(3).rstrip(",;")
    key = m.group(1).lower()
    # 口令类的键(password / 密码 / 口令)取值是纯数字也可能就是口令(PIN),不豁免数字
    numeric_ok = not any(w in key for w in ("password", "passwd", "密码", "口令"))
    if (numeric_ok and _NUMBER_RE.fullmatch(value)) or value.lower() in _NON_SECRET_VALUES or value.startswith("[REDACTED"):
        return m.group(0)
    return template.format(k=m.group(1))


_SECRET_PATTERNS: list[tuple[re.Pattern, object]] = [
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{10,}"), "[REDACTED:anthropic]"),
    (re.compile(r"sk-[A-Za-z0-9_-]{10,}"), "[REDACTED:openai]"),
    (re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"), "Bearer [REDACTED]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"),
     "[REDACTED:jwt]"),
    (re.compile(r"AKIA[0-9A-Z]{16}"), "[REDACTED:aws]"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"), "[REDACTED:github]"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"), "[REDACTED:slack]"),
    (re.compile(r"AIza[0-9A-Za-z_-]{30,}"), "[REDACTED:google]"),
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
                re.DOTALL), "[REDACTED:pem]"),
    # `OPENAI_API_KEY=...`, `DATABASE_PASSWORD: ...`, `x-api-key: ...` — any
    # identifier that CONTAINS one of the secret words, not only one that
    # starts with it (audit C9).
    # hl(动态 P2-18):URL 内嵌凭据 `scheme://user:pass@host` 整段用户信息去掉
    (re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^\s/@:'\"]+:[^\s/@'\"]+@"), r"\1[REDACTED]@"),
    # `OPENAI_API_KEY=...`, `DATABASE_PASSWORD: ...`, `x-api-key: ...` — any
    # identifier that CONTAINS one of the secret words, not only one that
    # starts with it (audit C9). hl(动态 P2-18):口令门槛 8 → 4(短口令也是口令),接受全角冒号;
    # hl(复核 P3):纯数字与常见的非密钥取值(`max_tokens: 4096`、`credential_type: oauth`)豁免,见 _keep_or_redact
    (re.compile(r"(?i)([A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|passwd"
                r"|authorization|credential|ticket)[A-Za-z0-9_-]*)"
                r"(\s*[:=:=]\s*['\"]?)([^\s'\"]{4,})"), lambda m: _keep_or_redact(m, "{k}=[REDACTED]")),
    (re.compile(r"(?i)\"([A-Za-z0-9_.-]*(?:apikey|api_key|accesstoken|access_token|token"
                r"|password|secret|authorization|credential|ticket)[A-Za-z0-9_-]*)\""
                r"(\s*:\s*\")([^\"]{4,})\""), lambda m: _keep_or_redact(m, '"{k}": "[REDACTED]"')),
    # hl(动态 P2-18):中文键名(密码 / 口令 / 密钥 / 秘钥 / 令牌 / 凭证),半角 / 全角冒号、等号或「是」
    (re.compile(r"((?:登录|数据库|管理员|账[号户]|root|admin)?\s*(?:密码|口令|密钥|秘钥|令牌|凭证))"
                r"(\s*(?:[:=:=]|是)\s*['\"「]?)([^\s'\"「」,,;;。]{4,})"), lambda m: _keep_or_redact(m, "{k}:[REDACTED]")),
    (re.compile(r"\"((?:密码|口令|密钥|秘钥|令牌|凭证)[^\"]{0,20})\"(\s*:\s*\")([^\"]{4,})\""),
     lambda m: _keep_or_redact(m, '"{k}": "[REDACTED]"')),
]


# Prism 随用户消息附带、页面上不显示的技术说明(「让 Claude 建定时任务」带着一次性票据与接口说明);
# 服务端以 `\n\n<说明>` 接在用户原话后面写进 transcript。它不是用户说的话,挖任务时整段丢掉(hb)。
_HIDDEN_CONTEXT_MARKERS = ("[系统随消息附带的技术说明",)


def strip_hidden_context(text: str) -> str:
    cut = min((i for i in (text.find(m) for m in _HIDDEN_CONTEXT_MARKERS) if i >= 0), default=-1)
    return text[:cut].rstrip() if cut >= 0 else text


_SKILL_PATH_RE = re.compile(r"/skills/([A-Za-z0-9][A-Za-z0-9._-]{0,63})/")


def redact(text: str) -> str:
    for rx, repl in _SECRET_PATTERNS:
        text = rx.sub(repl, text)
    return text


def redact_obj(obj):
    """hl(动态 P2-18):对任意 JSON 结构里的每个字符串脱敏(反馈叠加层落盘前用)。"""
    if isinstance(obj, str):
        return redact(obj)
    if isinstance(obj, list):
        return [redact_obj(x) for x in obj]
    if isinstance(obj, dict):
        return {k: redact_obj(v) for k, v in obj.items()}
    return obj


# ── Session digest ──────────────────────────────────────────────────────────

_NEG = ("still broken", "still not", "doesn't work", "does not work", "not working",
        "that's wrong", "incorrect", "wrong", "fix it", "didn't", "did not", "revert",
        "undo", "还是不行", "不对", "错了", "没用", "回滚")
_POS = ("thanks", "thank you", "perfect", "great", "works now", "fixed", "lgtm",
        "looks good", "correct", "可以了", "好了", "谢谢", "对的", "没问题")

# Our own prompts: a session whose first turn contains these was produced by
# this optimiser (or by SkillOpt), not by a human.
_SELF_MARKERS = (
    "You repair Python defects in an agent skill",
    "You analyse MULTIPLE failed agent trajectories",
    "You are a failure attributor",
    "You are the strategic advisor for an agent-skill training loop",
    "You are a real user contacting online support",
    "Reconstruct a simulated-user scenario",
    "You are an expert failure-analysis agent",
    "You are SkillOpt-Sleep",
    "## CURRENT SKILL", "## FAILED TASKS",
)


@dataclass
class SessionDigest:
    session_id: str
    project: str
    started_at: str = ""
    ended_at: str = ""
    user_prompts: list[str] = field(default_factory=list)
    assistant_finals: list[str] = field(default_factory=list)
    tools_used: list[str] = field(default_factory=list)
    skills_used: list[str] = field(default_factory=list)
    feedback: list[str] = field(default_factory=list)
    n_user_turns: int = 0
    raw_path: str = ""
    # ha:Prism 反馈叠加层对上的那几条(按助手消息 uuid 对上):
    # {uuid, verdict(1/0/-1), category, note, expected_output, prompt(它前面那句用户话)}
    user_feedback: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in self.__dataclass_fields__}

    def summary(self) -> dict:
        """dry-run 给人看的一行(脱敏后;不带全文)。"""
        votes = [f for f in self.feedback if f.startswith("user:")]
        return {
            "session_id": self.session_id, "project": self.project,
            "started_at": self.started_at, "ended_at": self.ended_at,
            "turns": self.n_user_turns, "tools": self.tools_used[:6], "skills": self.skills_used[:4],
            "first_prompt": (self.user_prompts[0] if self.user_prompts else "")[:160],
            "votes": len(votes), "guessed_feedback": len(self.feedback) - len(votes),
        }


# ── Feedback overlay (ha S3-01) ─────────────────────────────────────────────
#
# Prism 导出的 `feedback-overlay.json`:{"<provider 会话 id>": [{"message_uuid", "verdict",
# "category", "note", "expected_output"}]}。verdict 1 / 0 / -1 = 好 / 一般 / 差。
# 投票排在关键词猜测前面:有投票时 `satisfied` 直接取投票,不再让模型猜。

def load_overlay(path: Path | None) -> dict[str, list[dict]]:
    if not path:
        return {}
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if isinstance(data, dict) and isinstance(data.get("sessions"), dict):
        data = data["sessions"]
    if not isinstance(data, dict):
        return {}
    out: dict[str, list[dict]] = {}
    for sid, rows in data.items():
        if not isinstance(rows, list):
            continue
        keep = []
        for r in rows:
            if not isinstance(r, dict) or not isinstance(r.get("message_uuid"), str) or not r["message_uuid"]:
                continue
            v = r.get("verdict")
            if isinstance(v, bool) or v not in (-1, 0, 1):
                continue                          # 只认 -1 / 0 / 1;None、"−1"、True 都不算投票
            cat = r.get("category")
            keep.append({**r, "category": re.sub(r"[^a-z_]", "", str(cat))[:32] if cat else ""})
        out[str(sid)] = keep
    return out


def _vote_tag(row: dict) -> str:
    v = row.get("verdict")
    if v == 1:
        return "user:pos"
    if v == -1:
        return f"user:neg:{row.get('category') or 'other'}"
    return "user:mixed"


def load_session_whitelist(path: Path | None) -> set[str] | None:
    """`--sessions <文件>`:JSON 数组或每行一个 id;None = 不限。"""
    if not path:
        return None
    text = Path(path).read_text(encoding="utf-8")
    try:
        data = json.loads(text)
    except ValueError:
        return {ln.strip() for ln in text.splitlines() if ln.strip()}
    if isinstance(data, dict):
        data = data.get("sessions") or []
    if not isinstance(data, list):              # 标量(数字 / null / 字符串)不是清单:按"一行一个 id"读
        return {ln.strip() for ln in text.splitlines() if ln.strip() and ln.strip() != "null"}
    return {str(x) for x in data if isinstance(x, (str, int)) and str(x).strip()}


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    return ""


def _is_meta_prompt(p: str) -> bool:
    s = p.strip()
    if not s or s.startswith("<") or s.startswith("[Pasted text") or s.startswith("Caveat:"):
        return True
    if s.startswith("[Request interrupted") or s.startswith("This session is being continued"):
        return True
    if s.startswith("Continue from where you left off"):
        return True
    if s.startswith("/") and len(s.split()) <= 3:
        return True
    return "<command-name>" in s[:200] or "<command-message>" in s[:200]


def digest_transcript(path: Path, overlay: list[dict] | None = None) -> SessionDigest | None:
    path = Path(path)
    d = SessionDigest(session_id=path.stem, project=str(path.parent), raw_path=str(path))
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    by_uuid = {str(r["message_uuid"]): r for r in (overlay or [])}
    last_prompt = ""
    for line in lines:
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        ts = rec.get("timestamp") or ""
        if ts:
            d.started_at = d.started_at or ts
            d.ended_at = ts
        if rec.get("cwd"):
            d.project = rec["cwd"]
        # Records the harness wrote, not the human: compaction summaries,
        # meta turns, sub-agent prompts recorded inline (audit C10).
        if rec.get("isMeta") or rec.get("isSidechain") or rec.get("isCompactSummary"):
            continue
        if rec.get("type") in ("summary", "system", "progress"):
            continue
        msg = rec.get("message") or {}
        role, content = msg.get("role"), msg.get("content")
        if role == "user":
            if isinstance(content, list) and content and all(
                    isinstance(b, dict) and b.get("type") == "tool_result" for b in content):
                continue                      # a tool result, not a human turn
            text = redact(strip_hidden_context(_text_of(content)))
            if _is_meta_prompt(text):
                last_prompt = ""        # 被当成元指令略过的那句,后面的投票不能挂到更早那句上
                continue
            d.user_prompts.append(text[:2000])
            d.n_user_turns += 1
            last_prompt = text[:2000]
            low = text.lower()
            for kw in _NEG:
                if kw in low:
                    d.feedback.append(f"neg:{kw}")
                    break
            for kw in _POS:
                if kw in low:
                    d.feedback.append(f"pos:{kw}")
                    break
        elif role == "assistant":
            text = redact(_text_of(content))
            if text.strip():
                d.assistant_finals.append(text[:2000])
                d.assistant_finals = d.assistant_finals[-5:]
            fb = by_uuid.pop(str(rec.get("uuid") or ""), None)
            if fb is not None:
                # 用户对这条回答的投票:排在关键词猜测前面,mine() 里 satisfied 直接取它
                d.feedback.insert(0, _vote_tag(fb))
                raw_expected = str(fb.get("expected_output") or "")
                d.user_feedback.append({
                    "uuid": str(fb["message_uuid"]), "verdict": fb.get("verdict"),
                    "category": fb.get("category") or "", "note": redact(str(fb.get("note") or ""))[:2000],
                    "expected_output": redact(raw_expected)[:8000], "expected_raw_len": len(raw_expected),
                    "prompt": last_prompt, "answer": text[:2000],
                })
            if isinstance(content, list):
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        name = str(b.get("name", ""))
                        if name and name not in d.tools_used:
                            d.tools_used.append(name)
                        if name == "Skill":
                            sk = str((b.get("input") or {}).get("skill", "")).strip()
                            if sk and sk not in d.skills_used:
                                d.skills_used.append(sk)
                        # 不走 Skill 工具、直接读 / 跑 skills/<名>/ 下文件的,也算用过(hb)
                        try:
                            blob = json.dumps(b.get("input") or {}, ensure_ascii=False)
                        except (TypeError, ValueError):
                            blob = ""
                        for sk in _SKILL_PATH_RE.findall(blob):
                            if sk not in d.skills_used:
                                d.skills_used.append(sk)
    if not d.user_prompts:
        return None
    if any(m in d.user_prompts[0] for m in _SELF_MARKERS):
        return None                                  # our own output; never learn from it
    return d


def uses_skill(d: SessionDigest, skill: str) -> bool:
    """这个会话跟 *skill* 有关:调用过它(Skill 工具 / 读它目录下的文件),或者有投给它的票。"""
    return skill in d.skills_used or bool(d.user_feedback)


def harvest(transcripts_dir: Path, *, since_iso: str = "", limit: int = 0,
            project_filter: str = "", sessions: set[str] | None = None,
            overlay: dict[str, list[dict]] | None = None) -> list[SessionDigest]:
    """会话摘要。`sessions` 是白名单(transcript 文件名 = provider 会话 id);Prism 传的是
    当前用户**可见**的那些,root 也按可见性,不全量。`overlay` 是反馈叠加层。"""
    root = Path(transcripts_dir).expanduser()
    if not root.is_dir():
        return []
    paths = [p for p in root.rglob("*.jsonl")
             if "subagents" not in p.parts and not p.name.startswith("agent-")]
    if sessions is not None:
        paths = [p for p in paths if p.stem in sessions]
    paths.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    out: list[SessionDigest] = []
    for p in paths:
        d = digest_transcript(p, (overlay or {}).get(p.stem))
        if d is None:
            continue
        if since_iso and d.ended_at and d.ended_at < since_iso:
            continue
        if project_filter and project_filter not in d.project:
            continue
        out.append(d)
        if limit and len(out) >= limit:
            break
    return out


# ── Mining ──────────────────────────────────────────────────────────────────

_MINER_SYSTEM = """You turn a real agent session into at most 3 checkable tasks for
training an agent skill.

For each task give:
- intent: what the user actually wanted, generalised (no ids, paths, names)
- rubric: how a reviewer would judge a good answer — ALWAYS provide this
- checks: optional machine checks, each {"op": ..., "arg": ...} with op in
  contains | not_contains | regex | no_refusal | max_chars | min_chars
- satisfied: was the user satisfied in the session (true/false/null)

If `user_feedback` is present, those are the user's OWN votes and notes on
specific answers: treat a note as the reviewer's complaint and write the rubric
so that a good answer would have avoided it. Never invent a rubric the user
did not imply.

Skip anything case-specific, unverifiable, or already resolved by a human
doing something the skill cannot (permissions, back-office lookups).

Return JSON only: {"tasks": [{"intent": ..., "rubric": ..., "checks": [...], "satisfied": ...}]}"""


def _vote_outcome(d: SessionDigest) -> str | None:
    """有投票就按投票(差 > 一般 > 好:一条差评就是 fail);没投票回 None 让模型猜。"""
    verdicts = [fb.get("verdict") for fb in d.user_feedback]
    if not verdicts:
        return None
    if -1 in verdicts:
        return "fail"
    if 0 in verdicts:
        return "mixed"
    return "success"


EXACT_MAX_CHARS = 200


def exact_tasks_from_feedback(d: SessionDigest, *, skill_hint: str = "", limit: int = 0) -> list[TaskRecord]:
    """带期望结果的反馈直接成任务,零模型调用(A 路的 harvest 版)。

    · 用户的"待优化点"**不**进 context_excerpt —— runner 会把它拼进给被测 agent 的提示,
      等于把答案递过去;它只进判据;
    · 期望结果短(≤ 200 字)且脱敏 / 截断没动过它 → exact;否则(长文、被脱敏改过)→ rubric,
      "好答案与此一致" + "避免:<待优化点>",不拿一个本来就对不上的字符串去做子串比对。
    """
    import hashlib
    out: list[TaskRecord] = []
    for fb in d.user_feedback:
        expected = fb.get("expected_output") or ""
        if not expected or not fb.get("prompt"):
            continue
        raw = fb.get("expected_raw_len")
        pristine = "[REDACTED" not in expected and (raw is None or raw == len(expected))
        note = (fb.get("note") or "").strip()
        tid = "hx_" + hashlib.sha256(f"{d.session_id}::{fb['uuid']}".encode()).hexdigest()[:12]
        if pristine and len(expected) <= EXACT_MAX_CHARS:
            kind, reference = "exact", expected
        else:
            kind = "rubric"
            reference = f"A good answer agrees with the user's expected result: {expected[:1500]}"
            if note:
                reference += f"\nAvoid what the user complained about: {note[:600]}"
        out.append(TaskRecord(
            id=tid, intent=fb["prompt"][:2000], context_excerpt="",
            outcome={1: "success", 0: "mixed", -1: "fail"}.get(fb.get("verdict"), "unknown"),
            reference_kind=kind, reference=reference,
            skill_hint=skill_hint or (d.skills_used[0] if d.skills_used else ""),
            source_sessions=[d.session_id], family_id=d.session_id,
            tags=["source:harvest", "outcome:voted", f"feedback:{fb['uuid'][:8]}"],
        ))
        if limit and len(out) >= limit:
            break
    return out


def mine(digests: list[SessionDigest], backend: Backend, *,
         max_tasks: int = 40, skill_hint: str = "") -> tuple[list[TaskRecord], dict]:
    """LLM miner. No rubric → dropped. Shape-only checks → warned, kept, rubric wins."""
    import hashlib
    tasks: list[TaskRecord] = []
    stats = {"sessions": len(digests), "candidates": 0, "dropped_uncheckable": 0,
             "shape_only": 0, "errors": 0}
    for d in digests:
        if len(tasks) >= max_tasks:
            break
        # 带期望结果的反馈先直接落任务(不用问模型);也受 max_tasks 管
        tasks.extend(exact_tasks_from_feedback(d, skill_hint=skill_hint, limit=max_tasks - len(tasks)))
        payload = {"user_prompts": d.user_prompts[:6],
                   "final_answer": (d.assistant_finals[-1] if d.assistant_finals else "")[:800],
                   "feedback": d.feedback[:6], "tools": d.tools_used[:10]}
        if d.user_feedback:
            payload["user_feedback"] = [
                {"verdict": fb.get("verdict"), "category": fb.get("category"), "note": (fb.get("note") or "")[:600],
                 "about": (fb.get("prompt") or "")[:300]}
                for fb in d.user_feedback[:6]]
        try:
            raw = backend.complete(json.dumps(payload, ensure_ascii=False),
                                   system=_MINER_SYSTEM, stage="harvest.mine",
                                   max_tokens=1200)
        except Exception as exc:  # noqa: BLE001
            stats["errors"] += 1
            stats.setdefault("last_error", str(exc)[:300])
            continue
        data = extract_json(raw) or {}
        for c in (data.get("tasks") or [])[:3]:
            stats["candidates"] += 1
            intent = str(c.get("intent") or "").strip()
            rubric = c.get("rubric")
            if len(intent) < 8 or not isinstance(rubric, str) or len(rubric.strip()) < 8:
                stats["dropped_uncheckable"] += 1
                continue
            checks = [x for x in (c.get("checks") or []) if isinstance(x, dict)]
            judge = {"kind": "rule", "checks": checks} if checks else {}
            if judge:
                warns = validate_judge(judge)
                if any("shape-only" in w for w in warns):
                    stats["shape_only"] += 1
            sat = c.get("satisfied")
            voted = _vote_outcome(d)
            outcome = voted or ("success" if sat is True else "fail" if sat is False else "unknown")
            tid = "h_" + hashlib.sha256(f"{d.project}::{intent}".encode()).hexdigest()[:12]
            tasks.append(TaskRecord(
                id=tid, intent=intent,
                context_excerpt="\n".join(d.user_prompts[1:4])[:600],
                outcome=outcome,
                reference_kind="rubric", reference=rubric.strip(),
                judge=judge, skill_hint=skill_hint or (d.skills_used[0] if d.skills_used else ""),
                source_sessions=[d.session_id], family_id=d.session_id,
                tags=[f"tools:{'+'.join(d.tools_used[:4])}", "source:harvest",
                      "outcome:voted" if voted else "outcome:guessed"],
            ))
            if len(tasks) >= max_tasks:
                return _dedup(tasks), stats
    return _dedup(tasks), stats


def _dedup(tasks: list[TaskRecord]) -> list[TaskRecord]:
    seen: dict[str, TaskRecord] = {}
    for t in tasks:
        if t.id in seen:
            seen[t.id].source_sessions = sorted(set(seen[t.id].source_sessions + t.source_sessions))
        else:
            seen[t.id] = t
    return list(seen.values())
