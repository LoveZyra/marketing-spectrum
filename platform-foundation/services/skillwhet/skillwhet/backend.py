"""LLM backends, call accounting, and the executable zero-LLM invariant.

The design rule "the fast loop's gates cost zero model calls" is worth nothing
as a comment. ``no_llm()`` makes it a runtime assertion: any backend call made
inside that context raises. Every gate run in the fast loop is wrapped in it,
so a gate that quietly grows an LLM dependency fails loudly instead of eroding
the cost structure that the whole architecture rests on.
"""
from __future__ import annotations

import json
import os
import re
import contextvars
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Callable, Iterator, Protocol

# ── Call accounting ─────────────────────────────────────────────────────────


@dataclass
class CallStats:
    calls: int = 0
    prompt_chars: int = 0
    completion_chars: int = 0
    by_stage: dict[str, int] = field(default_factory=dict)
    cost_usd: float = 0.0

    def add(self, stage: str, prompt: str, completion: str) -> None:
        self.calls += 1
        self.prompt_chars += len(prompt)
        self.completion_chars += len(completion)
        self.by_stage[stage] = self.by_stage.get(stage, 0) + 1

    def to_dict(self) -> dict:
        return {
            "calls": self.calls,
            "prompt_chars": self.prompt_chars,
            "completion_chars": self.completion_chars,
            "by_stage": dict(self.by_stage),
            "cost_usd": round(self.cost_usd, 4),
        }


class LLMCallForbidden(RuntimeError):
    """Raised when a model call happens inside a ``no_llm`` region."""


# A ContextVar, not threading.local: worker threads spawned inside a no_llm
# region (the doc proposer's ThreadPoolExecutor) inherit it through
# `contextvars.copy_context()`, and a plain thread-local let them through
# (audit C18). Every executor in this package copies the context; a gate has
# no business creating threads at all, so no process-global fallback exists —
# one was tried and blocked the proposers of unrelated parallel runs.
_forbidden_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "skillwhet_no_llm", default=None)


def _forbidden_reason() -> str | None:
    return _forbidden_ctx.get()


@contextmanager
def no_llm(region: str) -> Iterator[None]:
    """Assert that no model call happens here. Used to wrap every fast-loop gate.

    Context-local: worker threads that copy the context (every executor in
    this package does) inherit the assertion; an unrelated training run in
    another thread of the same process (parallel `whet bench --jobs`) does
    not. A process-global flag was tried and made parallel runs block each
    other's proposers.
    """
    token = _forbidden_ctx.set(region)
    try:
        yield
    finally:
        _forbidden_ctx.reset(token)


# ── Backend protocol ────────────────────────────────────────────────────────


class Backend(Protocol):
    name: str

    def complete(self, prompt: str, *, system: str = "", stage: str = "",
                 max_tokens: int = 4096, temperature: float = 0.0) -> str: ...


class BaseBackend:
    name = "base"

    def __init__(self) -> None:
        self.stats = CallStats()

    def complete(self, prompt: str, *, system: str = "", stage: str = "",
                 max_tokens: int = 4096, temperature: float = 0.0) -> str:
        region = _forbidden_reason()
        if region is not None:
            raise LLMCallForbidden(
                f"model call from stage {stage or '?'} inside zero-LLM region "
                f"{region!r}; make the check deterministic or move it to the slow loop"
            )
        out = self._call(prompt, system=system, max_tokens=max_tokens,
                         temperature=temperature)
        self.stats.add(stage or "unknown", prompt, out)
        return out

    def _call(self, prompt: str, *, system: str, max_tokens: int,
              temperature: float) -> str:  # pragma: no cover - overridden
        raise NotImplementedError

    def sample(self, prompt: str, k: int, *, system: str = "", stage: str = "",
               max_tokens: int = 4096, temperature: float = 0.7) -> list[str]:
        """K independent samples.

        ``sample_id`` is folded into the prompt because a backend that caches on
        prompt text alone collapses all K rollouts to one response, which makes
        contrastive spread identically zero. That bug is what SkillOpt-Sleep's
        RESULTS.md blames for its -52.8 point collapse.
        """
        out = []
        for i in range(k):
            salted = f"{prompt}\n\n<!-- sample:{i} -->"
            out.append(self.complete(salted, system=system, stage=stage,
                                     max_tokens=max_tokens,
                                     temperature=temperature if k > 1 else 0.0))
        return out


# ── Mock / scripted backends ────────────────────────────────────────────────


class MockBackend(BaseBackend):
    """Deterministic, offline. The default, exactly as skillopt_sleep ships."""

    name = "mock"

    def __init__(self, responder: Callable[[str, str], str] | None = None) -> None:
        super().__init__()
        self.responder = responder
        self.seen: list[tuple[str, str]] = []

    def _call(self, prompt: str, *, system: str, max_tokens: int,
              temperature: float) -> str:
        self.seen.append((system, prompt))
        if self.responder is not None:
            return self.responder(system, prompt)
        if system.startswith("You turn a real agent session"):
            # harvest 的挖掘器:离线也给一条确定性的任务,好让 mock 跑通「从会话挖」全流程
            try:
                first = (json.loads(prompt).get("user_prompts") or [""])[0]
            except ValueError:
                first = ""
            if len(first.strip()) >= 8:
                return json.dumps({"tasks": [{"intent": first.strip()[:300],
                                              "rubric": "mock: the answer addresses the request directly and correctly",
                                              "satisfied": None}]}, ensure_ascii=False)
            return json.dumps({"tasks": []})
        return json.dumps({"edits": [], "reasoning": "mock backend: no proposal"})


class ScriptedBackend(BaseBackend):
    """Returns queued responses in order. For deterministic loop tests."""

    name = "scripted"

    def __init__(self, responses: list[str]) -> None:
        super().__init__()
        self.queue = list(responses)
        self.seen: list[tuple[str, str]] = []

    def _call(self, prompt: str, *, system: str, max_tokens: int,
              temperature: float) -> str:
        self.seen.append((system, prompt))
        if not self.queue:
            return json.dumps({"edits": [], "reasoning": "scripted queue exhausted"})
        return self.queue.pop(0)


class _ToolUseStop(RuntimeError):
    """The model tried to call a tool in a no-tool completion; retry with force."""


class ClaudeCLIBackend(BaseBackend):
    """``claude -p`` — the Claude Code CLI in print mode. The default real backend.

    Shells out per call. Prompt goes over stdin (no ARG_MAX surprises), tools
    are disabled so a completion cannot turn into an agent loop, sessions are
    not persisted, and the CLI's own JSON envelope is parsed for ``result`` plus
    cost/usage. Cost is tracked in ``self.stats.cost_usd`` because this backend
    is the one that actually spends money.

    Measured here: with a cache hit, sonnet ~$0.009/call, haiku ~$0.005/call.
    """

    name = "claude_cli"

    # Claude Code's context primes the model to explore before answering. Even
    # with tools disabled, a weak model will emit a tool_use block, hit
    # --max-turns 1 and return nothing. Found by `whet probe`; fixed here, once,
    # rather than in every prompt.
    PREAMBLE = ("You have NO tools, NO file access and NO network. Do not attempt to "
                "read, search or run anything. Answer ONLY from the text you are given, "
                "in exactly the requested format, with nothing before or after it.")
    RETRY_PREAMBLE = ("CRITICAL: any attempt to call a tool will be discarded and counted "
                      "as a failure. " + PREAMBLE)

    def __init__(self, *, model: str = "sonnet", claude_path: str = "claude",
                 timeout: int = 300, extra_args: list[str] | None = None,
                 retries: int = 1) -> None:
        super().__init__()
        self.model = model
        self.claude_path = claude_path
        self.timeout = timeout
        self.extra_args = list(extra_args or [])
        self.retries = retries
        self.stats.cost_usd = 0.0          # type: ignore[attr-defined]
        self.last_envelope: dict = {}
        self.resolved_model: str | None = None   # what the gateway actually answered with, if it says
        # An empty scratch cwd: `claude -p` reads CLAUDE.md / .claude settings
        # from its working directory, and the caller's project instructions
        # must not leak into every proposer and judge call.
        import shutil
        import tempfile
        import weakref
        self._scratch = tempfile.mkdtemp(prefix="whet-claude-")
        # hl(动态 P3):用完即删 —— 对象回收或进程退出时清掉,共用 home 下不再堆 whet-claude-*
        self._scratch_cleanup = weakref.finalize(self, shutil.rmtree, self._scratch, ignore_errors=True)

    # Linux MAX_ARG_STRLEN is 128 KiB per argv element; a skill's SKILL.md plus
    # every reference file can exceed it (audit C16). Above this the system
    # prompt travels on stdin, ahead of the user prompt.
    MAX_SYSTEM_ARG = 60_000

    def _call(self, prompt: str, *, system: str, max_tokens: int,
              temperature: float) -> str:
        last_exc: Exception | None = None
        for attempt in range(self.retries + 1):
            pre = self.RETRY_PREAMBLE if attempt else self.PREAMBLE
            try:
                return self._call_once(prompt, system=f"{pre}\n\n{system}".strip())
            except _ToolUseStop as exc:
                last_exc = exc
                continue
        raise RuntimeError(f"claude -p kept trying to use tools: {last_exc}")

    def _call_once(self, prompt: str, *, system: str) -> str:
        import os
        import subprocess
        argv = [
            self.claude_path, "-p",
            "--output-format", "json",
            "--tools", "",
            "--no-session-persistence",
            "--max-turns", "1",
            "--model", self.model,
        ]
        if system and len(system.encode("utf-8")) > self.MAX_SYSTEM_ARG:
            head, _, body = system.partition("\n\n")          # keep the preamble in argv
            argv += ["--system-prompt", head + "\n\nYour full instructions follow in the "
                     "message between <system> tags; obey them as system instructions."]
            prompt = f"<system>\n{body}\n</system>\n\n{prompt}"
        elif system:
            argv += ["--system-prompt", system]
        argv += self.extra_args
        # CLAUDECODE marks "already inside a Claude Code session" and makes the
        # CLI refuse to start; the trainer itself is often run from one.
        env = {k: v for k, v in os.environ.items() if k != "CLAUDECODE"}
        try:
            proc = subprocess.run(  # noqa: S603 - argv list, never a shell string
                argv, input=prompt, capture_output=True, text=True,
                timeout=self.timeout, check=False, cwd=self._scratch, env=env,
            )
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError(f"claude -p timed out after {self.timeout}s") from exc
        except OSError as exc:
            raise RuntimeError(f"cannot run {self.claude_path!r}: {exc}") from exc

        raw = (proc.stdout or "").strip()
        if not raw:
            raise RuntimeError(f"claude -p produced no output (rc={proc.returncode}): "
                               f"{(proc.stderr or '')[:300]}")
        try:
            env = json.loads(raw)
        except json.JSONDecodeError:
            # Some versions print the bare result; treat it as text.
            self.last_envelope = {}
            return raw
        self.last_envelope = env
        # `claude -p --output-format json` envelopes carry per-model usage keyed by the
        # concrete model id; remember it so a report can say "sonnet → claude-sonnet-4-5-…".
        usage = env.get("modelUsage") or env.get("model_usage")
        if isinstance(usage, dict) and usage:
            self.resolved_model = ",".join(sorted(usage.keys()))[:120]
        elif isinstance(env.get("model"), str):
            self.resolved_model = env["model"]
        try:
            self.stats.cost_usd += float(env.get("total_cost_usd") or 0.0)  # type: ignore[attr-defined]
        except (TypeError, ValueError):
            pass
        if env.get("stop_reason") == "tool_use" or env.get("subtype") == "error_max_turns":
            raise _ToolUseStop(str(env.get("errors") or env.get("subtype")))
        if env.get("is_error"):
            raise RuntimeError(f"claude -p error: "
                               f"{str(env.get('result') or env.get('errors') or '')[:300]}")
        return str(env.get("result") or "")


class OpenAICompatibleBackend(BaseBackend):
    """Any endpoint speaking the OpenAI chat-completions protocol.

    Kept dependency-free on purpose (urllib, not the openai SDK) so the package
    installs with two runtime dependencies.
    """

    name = "openai_compatible"

    def __init__(self, *, model: str, base_url: str = "",
                 api_key_env: str = "OPENAI_API_KEY", timeout: int = 180) -> None:
        super().__init__()
        self.model = model
        self.base_url = (base_url or os.environ.get("OPENAI_BASE_URL")
                         or "https://api.openai.com/v1").rstrip("/")
        self.api_key_env = api_key_env
        self.timeout = timeout

    def _call(self, prompt: str, *, system: str, max_tokens: int,
              temperature: float) -> str:
        key = os.environ.get(self.api_key_env, "")
        if not key:
            raise RuntimeError(f"{self.api_key_env} is not set")
        msgs = ([{"role": "system", "content": system}] if system else []) + [
            {"role": "user", "content": prompt}
        ]
        body = json.dumps({
            "model": self.model, "messages": msgs,
            "max_tokens": max_tokens, "temperature": temperature,
        }).encode()
        req = urllib.request.Request(
            f"{self.base_url}/chat/completions", data=body,
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {key}"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                data = json.loads(resp.read().decode())
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            raise RuntimeError(f"backend call failed: {exc}") from exc
        return data["choices"][0]["message"]["content"] or ""


@dataclass
class Roles:
    """Generator != Evaluator is SkillEvo's one architectural model requirement.

    A model reviewing its own edits is a circular dependency, so the roles are
    separate objects and ``validate`` refuses to let them be the same backend.
    """

    fast_proposer: Backend
    slow_proposer: Backend
    evaluator: Backend
    # The frozen model the skill is LOADED INTO for agent / simulation
    # roll-outs. Optional: defaults to the fast proposer's model, which is
    # the cheap one — roll-outs are the expensive path.
    target: Backend | None = None

    def evaluator_target(self) -> Backend:
        return self.target or self.fast_proposer

    def validate(self) -> None:
        if self.slow_proposer is self.evaluator:
            raise ValueError(
                "Generator == Evaluator: the editor and the judge must be "
                "different models (SkillEvo's Generator != Evaluator constraint)"
            )
        # Same backend class with the same model string is the same model in a
        # different coat. Different families is the ideal; different models is
        # the floor.
        sm = getattr(self.slow_proposer, "model", None)
        em = getattr(self.evaluator, "model", None)
        if sm and em and sm == em and type(self.slow_proposer) is type(self.evaluator):
            raise ValueError(
                f"Generator == Evaluator: slow_proposer and evaluator are both "
                f"{type(self.evaluator).__name__}(model={em!r}); use different models"
            )

    @classmethod
    def all_mock(cls) -> Roles:
        return cls(MockBackend(), MockBackend(), MockBackend())


# ── JSON extraction ─────────────────────────────────────────────────────────

_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)


def _balanced_objects(text: str) -> list[str]:
    """Top-level {...} spans that parse as JSON objects.

    Strings are tracked only INSIDE a span, and only with double quotes (JSON
    has no single-quoted strings): an apostrophe in the prose before the
    object — "Here's the fix: {...}" — used to swallow the rest of the text
    (audit C3).
    """
    out: list[str] = []
    dec = json.JSONDecoder()
    i = 0
    while i < len(text):
        if text[i] != "{":
            i += 1
            continue
        try:
            obj, end = dec.raw_decode(text, i)
        except json.JSONDecodeError:
            i += 1
            continue
        if isinstance(obj, dict):
            out.append(text[i:i + (end - i)])
        i = end
    return out


def extract_json(text: str) -> dict | None:
    """Parse a model's JSON reply, conservatively.

    Deliberately returns None rather than guessing when several candidate
    objects are present: silently picking the wrong one is worse than failing.
    """
    if not text:
        return None
    for cand in (m.group(1) for m in _FENCE.finditer(text)):
        try:
            v = json.loads(cand)
            if isinstance(v, dict):
                return v
        except json.JSONDecodeError:
            pass
    try:
        v = json.loads(text.strip())
        if isinstance(v, dict):
            return v
    except json.JSONDecodeError:
        pass
    spans = _balanced_objects(text)
    if len(spans) != 1:
        return None
    try:
        v = json.loads(spans[0])
        return v if isinstance(v, dict) else None
    except json.JSONDecodeError:
        return None
