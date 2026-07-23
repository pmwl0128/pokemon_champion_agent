"""LLM provider seam for the QA orchestration (apps/design.md §7.2). One blocking method
so the whole answer pipeline runs inside a single `asyncio.to_thread` — the endpoint stays
async while provider + skill-tool calls stay simple synchronous code."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from typing import Mapping, Protocol


class LlmUnavailable(RuntimeError):
    """The provider cannot serve at all (missing key, network failure, upstream 5xx/429).
    Maps to HTTP 503 — the caller refunds the user's quota count. `tokens` carries any spend
    from EARLIER rounds of the same request so the budget is still settled truthfully when the
    provider dies mid-pipeline (the orchestrator attaches it before re-raising)."""

    tokens: int = 0


@dataclass
class ChatResult:
    message: dict          # assistant message verbatim: content and/or tool_calls
    prompt_tokens: int = 0
    completion_tokens: int = 0
    # DeepSeek prefix-cache split (§9 pricing: hit ¥0.02/M vs miss ¥1/M) — 0 when the
    # upstream doesn't report it.
    cache_hit_tokens: int = 0
    cache_miss_tokens: int = 0


class LlmProvider(Protocol):
    def chat(self, messages: list[dict], tools: list[dict], *, max_tokens: int,
             tool_choice: str, timeout: float) -> ChatResult: ...


def _optional_float(values: Mapping[str, str], key: str) -> float | None:
    raw = values.get(key, "").strip()
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be a number or empty") from exc


def _optional_int(values: Mapping[str, str], key: str) -> int | None:
    raw = values.get(key, "").strip()
    if not raw:
        return None
    try:
        return int(raw)
    except ValueError as exc:
        raise ValueError(f"{key} must be an integer or empty") from exc


@dataclass(frozen=True)
class OpenAIChatConfig:
    """One environment-backed seam for OpenAI-compatible chat-completions providers.

    Known generation controls get typed fields. ``extra_body`` is the escape hatch for a
    future provider-specific option without another code change, but cannot replace request
    structure or orchestration-owned limits.
    """

    api_key: str
    base_url: str = "https://api.deepseek.com"
    api_path: str = "/chat/completions"
    model: str = "deepseek-v4-flash"
    api_style: str = "openai-chat-completions"
    temperature: float | None = 0.3
    top_p: float | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    seed: int | None = None
    thinking: str | None = "enabled"
    reasoning_effort: str | None = "high"
    extra_body: dict = field(default_factory=dict)

    @classmethod
    def from_env(cls, values: Mapping[str, str]) -> "OpenAIChatConfig":
        api_style = values.get("PCUI_LLM_API_STYLE", "openai-chat-completions").strip()
        if api_style != "openai-chat-completions":
            raise ValueError("PCUI_LLM_API_STYLE currently supports only openai-chat-completions")
        thinking_raw = values.get("PCUI_LLM_THINKING", "enabled").strip().lower()
        if thinking_raw not in {"enabled", "disabled", ""}:
            raise ValueError("PCUI_LLM_THINKING must be enabled, disabled, or empty")
        effort_raw = values.get("PCUI_LLM_REASONING_EFFORT", "high").strip().lower()
        if effort_raw not in {"high", "max", ""}:
            raise ValueError("PCUI_LLM_REASONING_EFFORT must be high, max, or empty")
        raw_extra = values.get("PCUI_LLM_EXTRA_BODY_JSON", "{}").strip() or "{}"
        try:
            extra = json.loads(raw_extra)
        except ValueError as exc:
            raise ValueError("PCUI_LLM_EXTRA_BODY_JSON must be a JSON object") from exc
        if not isinstance(extra, dict):
            raise ValueError("PCUI_LLM_EXTRA_BODY_JSON must be a JSON object")
        reserved = {"model", "messages", "stream", "max_tokens", "tools", "tool_choice",
                    "temperature", "top_p", "presence_penalty", "frequency_penalty", "seed",
                    "thinking", "reasoning_effort"}
        overlap = reserved.intersection(extra)
        if overlap:
            raise ValueError("PCUI_LLM_EXTRA_BODY_JSON cannot override: "
                             + ", ".join(sorted(overlap)))
        base_url = values.get("PCUI_LLM_BASE_URL",
                              values.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")).strip()
        model = values.get("PCUI_LLM_MODEL",
                           values.get("DEEPSEEK_MODEL", "deepseek-v4-flash")).strip()
        api_key = values.get("PCUI_LLM_API_KEY",
                             values.get("DEEPSEEK_API_KEY", "")).strip()
        api_path = values.get("PCUI_LLM_API_PATH", "/chat/completions").strip()
        if not base_url or not model or not api_path.startswith("/"):
            raise ValueError("PCUI_LLM_BASE_URL/model must be non-empty and API_PATH must start with /")
        return cls(
            api_key=api_key, base_url=base_url, api_path=api_path, model=model,
            api_style=api_style,
            temperature=_optional_float(values, "PCUI_LLM_TEMPERATURE")
            if "PCUI_LLM_TEMPERATURE" in values else 0.3,
            top_p=_optional_float(values, "PCUI_LLM_TOP_P"),
            presence_penalty=_optional_float(values, "PCUI_LLM_PRESENCE_PENALTY"),
            frequency_penalty=_optional_float(values, "PCUI_LLM_FREQUENCY_PENALTY"),
            seed=_optional_int(values, "PCUI_LLM_SEED"),
            thinking=thinking_raw or None,
            reasoning_effort=effort_raw or None,
            extra_body=extra,
        )

    def safe_summary(self) -> str:
        thinking = self.thinking or "provider-default"
        effort = self.reasoning_effort if self.thinking == "enabled" else "n/a"
        return (f"{self.api_style}, model={self.model}, thinking={thinking}, "
                f"reasoning_effort={effort}")


class OpenAICompatibleProvider:
    """Blocking OpenAI chat-completions client used behind the provider protocol seam."""

    def __init__(self, config: OpenAIChatConfig):
        self.config = config
        self.model = config.model

    @property
    def thinking_enabled(self) -> bool:
        return self.config.thinking == "enabled"

    def with_thinking(self, enabled: bool) -> "OpenAICompatibleProvider":
        """Return an isolated surface-specific client without mutating shared config."""
        return OpenAICompatibleProvider(replace(
            self.config, thinking="enabled" if enabled else "disabled"))

    def chat(self, messages: list[dict], tools: list[dict], *, max_tokens: int,
             tool_choice: str, timeout: float) -> ChatResult:
        import httpx
        cfg = self.config
        payload: dict = {"model": cfg.model, "messages": messages, "stream": False,
                         "max_tokens": max_tokens, **cfg.extra_body}
        for key, value in (("temperature", cfg.temperature), ("top_p", cfg.top_p),
                           ("presence_penalty", cfg.presence_penalty),
                           ("frequency_penalty", cfg.frequency_penalty), ("seed", cfg.seed)):
            if value is not None and cfg.thinking != "enabled":
                payload[key] = value
        if cfg.thinking is not None:
            payload["thinking"] = {"type": cfg.thinking}
        if cfg.thinking == "enabled" and cfg.reasoning_effort is not None:
            payload["reasoning_effort"] = cfg.reasoning_effort
        # Keep the tool definitions in the payload even on the forced-final (tool_choice=none)
        # call: they are part of the cached request prefix, so dropping them would break upstream
        # prefix caching on the most common terminal call. tool_choice=none still forbids calls.
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice
        try:
            resp = httpx.post(f"{cfg.base_url.rstrip('/')}{cfg.api_path}", json=payload,
                              headers={"Authorization": f"Bearer {cfg.api_key}"},
                              timeout=timeout)
        except httpx.HTTPError as e:
            raise LlmUnavailable(f"llm request failed: {type(e).__name__}") from e
        except ImportError as e:
            # httpx fails to even BUILD its transport when the environment selects a proxy scheme
            # whose optional extra is missing (ALL_PROXY=socks5h://... without `httpx[socks]`).
            # That is a deployment/config fault, not a model fault — but it is not an HTTPError, so
            # it used to escape this handler and surface as a bare 500 "pipeline failed", which said
            # nothing about the actual cause. Report it as an unavailable transport, with the reason.
            raise LlmUnavailable(f"llm transport unavailable: {e}") from e
        except OSError as e:
            # Connection-level faults (proxy refused, DNS, TLS) — same class of operator problem.
            raise LlmUnavailable(f"llm transport failed: {type(e).__name__}: {e}") from e
        if resp.status_code != 200:
            # No body in the message: upstream errors can echo request fragments.
            raise LlmUnavailable(f"llm upstream returned {resp.status_code}")
        try:
            doc = resp.json()
            message = doc["choices"][0]["message"]
        except (ValueError, LookupError, TypeError) as e:
            raise LlmUnavailable("llm upstream returned an unparseable response") from e
        usage = doc.get("usage") or {}
        return ChatResult(message, int(usage.get("prompt_tokens") or 0),
                          int(usage.get("completion_tokens") or 0),
                          int(usage.get("prompt_cache_hit_tokens") or 0),
                          int(usage.get("prompt_cache_miss_tokens") or 0))


class DeepSeekProvider(OpenAICompatibleProvider):
    """Backward-compatible constructor for callers that still use the old class name."""

    def __init__(self, api_key: str, base_url: str = "https://api.deepseek.com",
                 model: str = "deepseek-v4-flash"):
        super().__init__(OpenAIChatConfig(api_key=api_key, base_url=base_url, model=model))


def _first_name(rows: object, used: set[str] | None = None) -> str | None:
    for row in rows if isinstance(rows, list) else []:
        name = row.get("name") if isinstance(row, dict) else None
        if isinstance(name, str) and name and (used is None or name not in used):
            return name
    return None


def _echo_builder_reply(messages: list[dict]) -> str | None:
    """A grounded deterministic candidate for zero-cost release/browser rehearsals.

    Echo mode is test infrastructure, not a second production builder. It selects only values from
    the real builder prompt so the complete queue -> UEP -> SSE -> result UI can be smoke-tested.
    """
    payload = None
    for message in reversed(messages):
        try:
            doc = json.loads(str(message.get("content") or ""))
        except (TypeError, ValueError):
            continue
        if isinstance(doc, dict) and isinstance(doc.get("final_team"), list):
            return json.dumps({"rationale": "Echo rehearsal of the validator-confirmed final team."})
        if isinstance(doc, dict) and "usage_details" in doc and "skeletons" in doc:
            payload = doc
            break
    if not isinstance(payload, dict):
        return None

    details = payload.get("usage_details") if isinstance(payload.get("usage_details"), dict) else {}
    mega_options = [row for row in (payload.get("mega_options") or []) if isinstance(row, dict)]
    skeletons = [row for row in (payload.get("skeletons") or []) if isinstance(row, dict)]
    constraints = payload.get("constraints") if isinstance(payload.get("constraints"), dict) else {}
    wanted: list[str] = []

    def want(name: object) -> None:
        if isinstance(name, str) and name and name not in wanted:
            wanted.append(name)

    locked = [name for name in (constraints.get("locked") or [])
              if isinstance(name, str) and name]
    for name in locked:
        want(name)
    # Reserve the two Mega slots before broad skeleton/ranking fill. A future frame with six core
    # candidates must not crowd all Megas out of the deterministic release rehearsal.
    locked_bases = {name.removeprefix("Mega ") for name in locked}
    for option in mega_options:
        if len([name for name in wanted if name.startswith("Mega ")]) >= 2:
            break
        species = option.get("species")
        if isinstance(species, str) and species.removeprefix("Mega ") not in locked_bases:
            want(species)
    for skeleton in skeletons[:1]:
        for candidate in skeleton.get("core_candidates") or []:
            if isinstance(candidate, dict):
                want(candidate.get("species"))
    for name in details:
        want(name)

    mega_by_name = {row.get("species"): row for row in mega_options
                    if isinstance(row.get("species"), str)}
    used_items: set[str] = set()
    used_bases: set[str] = set()
    members: list[dict] = []

    def base_name(species: str) -> str:
        return species.removeprefix("Mega ")

    for species in wanted:
        if len(members) >= 6 or base_name(species) in used_bases:
            continue
        mega = mega_by_name.get(species)
        detail = details.get(species) or details.get(base_name(species))
        detail = detail if isinstance(detail, dict) else {}
        if mega is not None:
            item = mega.get("item")
            ability = mega.get("ability") or _first_name(detail.get("abilities"))
            nature = mega.get("nature") or _first_name(detail.get("natures"))
            moves = mega.get("moves") or [row.get("name") for row in detail.get("moves") or []
                     if isinstance(row, dict) and row.get("name")]
            spread = mega.get("spread")
        else:
            item = _first_name(detail.get("items"), used_items)
            ability = _first_name(detail.get("abilities"))
            nature = _first_name(detail.get("natures"))
            moves = [row.get("name") for row in detail.get("moves") or []
                     if isinstance(row, dict) and row.get("name")]
            spreads = detail.get("spreads") or []
            first_spread = spreads[0] if spreads and isinstance(spreads[0], dict) else {}
            spread = first_spread.get("spread")
        if not item or item in used_items or not ability or not nature or not moves:
            continue
        used_items.add(str(item))
        used_bases.add(base_name(species))
        members.append({"species": species, "item": item, "ability": ability,
                        "nature": nature, "moves": moves[:4], "spread": spread or {}})
    if len(members) != 6 or len([m for m in members if m["species"].startswith("Mega ")]) != 2:
        return None
    frame_id = skeletons[0].get("frame_id") if skeletons else None
    return json.dumps({"frame_id": frame_id, "pokemon": members,
                       "rationale": "Echo rehearsal assembled a grounded six-member team."})


class EchoProvider:
    """Dev provider (`online-serve --provider echo`): answers without any LLM so the page
    plumbing (limits, cookie, DTO shape) can be exercised end-to-end with zero cost."""

    def chat(self, messages: list[dict], tools: list[dict], *, max_tokens: int,
             tool_choice: str, timeout: float) -> ChatResult:
        if any("team-assembly engine" in str(message.get("content") or "")
               for message in messages if message.get("role") == "system"):
            reply = _echo_builder_reply(messages)
            if reply is not None:
                return ChatResult({"role": "assistant", "content": reply})
        question = str(messages[-1].get("content", ""))
        return ChatResult({"role": "assistant", "content": f"(echo) {question}"})
