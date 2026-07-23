"""Fact-QA orchestration (apps/design.md §7.2): one question -> tool-grounded one-shot
answer. The system prompt + tool definitions are a byte-stable request prefix (upstream
auto-caching); at most QA_MAX_ROUNDS tool rounds over a read-only dex/meta tool surface
(the §13 v1 cut), every tool result clipped server-side, then one forced final call with
tool_choice=none. No conversation history — each question is independent.

The answer contract mirrors agent prose (design §6): entities are named by ENGLISH
CANONICAL, so the SPA's prose renderer localizes them with dex authority instead of
trusting model translations."""
from __future__ import annotations

import json
import re
import time
from typing import Any

from .provider import ChatResult, LlmProvider, LlmUnavailable

QA_QUESTION_MAX_CHARS = 400     # mirrors packages/protocol llm.ts
QA_MAX_ROUNDS = 3               # tool rounds; one extra forced-final call follows
QA_MAX_CALLS_PER_ROUND = 4
QA_TOOL_RESULT_CHARS = 3500     # per tool result, measured in UTF-8 BYTES (see clip_json)
QA_MAX_ANSWER_TOKENS = 900
QA_LLM_TIMEOUT = 40.0
QA_TOOL_TIMEOUT = 30.0          # per skill-tool (worker) call; also clamped by remaining deadline
QA_REPSET_TIMEOUT = 60.0        # repset is a one-shot team.py subprocess (~2s warm), not a worker
QA_DEADLINE_SECONDS = 90.0      # wall clock for the whole pipeline (§7.2 hard caps)
# Hard per-request token ceiling (§7.4): once crossed we stop spending on tool rounds and force
# the final synthesis, so one pathological question cannot burn the daily budget far past the
# reservation (the reserve stays the empirically-calibrated 12k; this caps the tail).
QA_MAX_REQUEST_TOKENS = 40_000

DEX_KINDS = ("pokemon", "move", "item", "ability", "nature")

# repset/skeleton "sps" shorthand -> team-json/calc spread keys (shared with the builder).
SPS_TO_SPREAD = {"hp": "hp", "at": "atk", "df": "def", "sa": "spa", "sd": "spd", "sp": "spe"}


def spread_from_sps(sps: Any) -> dict:
    out: dict[str, int] = {}
    if isinstance(sps, dict):
        for k, v in sps.items():
            key = SPS_TO_SPREAD.get(str(k), str(k))
            if key in ("hp", "atk", "def", "spa", "spd", "spe"):
                try:
                    out[key] = max(0, min(32, int(v or 0)))
                except (TypeError, ValueError):
                    pass
    return out


class QaFailed(RuntimeError):
    """The pipeline ran but produced no usable answer (model kept calling tools past the
    forced-final round, empty content, deadline). Carries the tokens burned so the caller
    can still settle the budget truthfully. Maps to HTTP 502."""

    def __init__(self, message: str, tokens: int = 0):
        super().__init__(message)
        self.tokens = tokens


SYSTEM_PROMPT = """\
You are the fact-lookup assistant of a Pokemon Champions data site.

Rules:
- Answer ONE factual question about Pokemon Champions: battle-dex facts (types, stats,
  abilities, moves, items, natures), the current metagame (usage ranking, common
  moves/items/abilities/natures/partners/SP spreads, representative real-team sets), or a
  concrete damage / speed comparison.
- You MUST call at least one tool before stating ANY Pokemon Champions fact — never answer
  a factual question from memory. Ground every factual claim in tool output; never invent
  numbers, sets, or rankings. If you answer WITHOUT calling any tool, your reply must be a
  brief out-of-scope / cannot-answer decline only (that is the ONLY ungrounded reply allowed).
  If the tools cannot answer, say so plainly.
- Pass entity names to tools AS THE USER WROTE THEM (any language) — the tools resolve
  zh/ja/en themselves. Do NOT translate names into English yourself: idioms like
  "Alolan Ninetales" miss the database (the canonical is "Ninetales-Alola").
- For "can X OHKO/2HKO Y", "how much does X's move do to Y" or "is X faster than Y",
  call calc_damage / calc_speed — NEVER estimate damage or speed from memory. Both sides
  default to their most-used competitive set (a Mega form uses its real-team representative
  set); ALWAYS disclose that assumption briefly when you state the result, and mention the
  assumed items when they matter. calc_damage/calc_speed resolve the sets INTERNALLY — they
  do not need a prior detail/repset lookup, and they still work when such a lookup missed:
  always TRY the calc tool before declining. If a tool ultimately fails, decline plainly —
  never substitute numbers from memory.
- For "what outspeeds X" / "which pokemon are faster than X" / "is X fast enough for the meta",
  call speed_ladder ONCE — it returns X plus the ranked field already sorted and split into
  outspeedsMe / ties / slowerThanMe. Do NOT loop calc_speed over the ranking: that runs out of
  tool rounds before you have enough of the field, and the answer ends up incomplete.
- repset_lookup gives the representative REAL-TEAM joint set (ability+item+nature+moves+SP
  played together) — prefer it over stitching independent usage modes when the question is
  "how is X actually built".
- Answer in the language given by the [lang=..] tag. Be concise: a short paragraph,
  at most ~120 words, no headings or bullet lists unless listing is the answer.
- PLAIN TEXT only — no markdown (**bold**, headers, tables); the site renders entities
  itself and markdown markers show up as literal noise.
- Name every Pokemon, move, item, ability and nature by its ENGLISH CANONICAL name exactly as the
  tools return it — the site localizes names itself; hand-translated names break that.
- This box only does factual lookups: for team building or anything off-topic, briefly say
  it is out of scope and point to the site's builder/calculator pages.
"""

TOOLS: list[dict] = [
    {"type": "function", "function": {
        "name": "dex_lookup",
        "description": "Look up one canonical fact sheet from the battle dex: a pokemon "
                       "(types/base stats/abilities), a move, an item, an ability or a "
                       "nature. Accepts Chinese / Japanese / English names.",
        "parameters": {"type": "object", "properties": {
            "kind": {"type": "string", "enum": list(DEX_KINDS)},
            "name": {"type": "string", "description": "entity name in any language"},
        }, "required": ["kind", "name"]},
    }},
    {"type": "function", "function": {
        "name": "meta_ranking",
        "description": "Current-season usage ranking (top N) for singles or doubles.",
        "parameters": {"type": "object", "properties": {
            "format": {"type": "string", "enum": ["single", "double"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 50},
        }, "required": ["format"]},
    }},
    {"type": "function", "function": {
        "name": "meta_detail",
        "description": "Current-season usage detail for ONE pokemon: common moves, items, "
                       "abilities, natures, partners and SP spreads, for singles or doubles.",
        "parameters": {"type": "object", "properties": {
            "format": {"type": "string", "enum": ["single", "double"]},
            "pokemon": {"type": "string", "description": "pokemon name in any language"},
        }, "required": ["format", "pokemon"]},
    }},
    {"type": "function", "function": {
        "name": "repset_lookup",
        "description": "Representative REAL-TEAM joint set(s) for one pokemon: ability, item, "
                       "nature, moves and SP spread as actually played together — more "
                       "faithful than stitching independent usage modes. Accepts Mega forms.",
        "parameters": {"type": "object", "properties": {
            "format": {"type": "string", "enum": ["single", "double"]},
            "pokemon": {"type": "string", "description": "pokemon name in any language"},
        }, "required": ["format", "pokemon"]},
    }},
    {"type": "function", "function": {
        "name": "speed_ladder",
        "description": "Speed ladder for ONE pokemon against the current metagame: its own final "
                       "speed plus the most-used sets of the top-N ranked pokemon, sorted fastest "
                       "first, marking which outspeed it. Use this for 'what outspeeds X' / 'is X "
                       "fast enough' — ONE call covers the whole field, never loop calc_speed over "
                       "the ranking.",
        "parameters": {"type": "object", "properties": {
            "pokemon": {"type": "string", "description": "pokemon name in any language"},
            "format": {"type": "string", "enum": ["single", "double"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 30,
                      "description": "how many ranked opponents to include (default 20)"},
        }, "required": ["pokemon", "format"]},
    }},
    {"type": "function", "function": {
        "name": "calc_damage",
        "description": "Compute REAL damage of one attack: damage %, KO chance, and the "
                       "assumed sets. Both sides default to their most-used competitive set "
                       "(usage modes; Mega forms use their real-team representative set). "
                       "Optional item overrides answer what-if-holding-X questions.",
        "parameters": {"type": "object", "properties": {
            "attacker": {"type": "string"},
            "defender": {"type": "string"},
            "move": {"type": "string", "description": "the attacking move (any language)"},
            "format": {"type": "string", "enum": ["single", "double"]},
            "attacker_item": {"type": "string", "description": "optional item override"},
            "defender_item": {"type": "string", "description": "optional item override"},
        }, "required": ["attacker", "defender", "move"]},
    }},
    {"type": "function", "function": {
        "name": "calc_speed",
        "description": "Compare the final speed of two pokemon under their most-used sets "
                       "(nature, Spe SP, item, ability). Returns both numbers and who is "
                       "faster.",
        "parameters": {"type": "object", "properties": {
            "pokemon_a": {"type": "string"},
            "pokemon_b": {"type": "string"},
            "format": {"type": "string", "enum": ["single", "double"]},
        }, "required": ["pokemon_a", "pokemon_b"]},
    }},
]


def prune(node: Any, list_cap: int = 12, str_cap: int = 400) -> Any:
    """Structural trim that KEEPS the JSON shape (lists capped with an omission marker,
    long strings ellipsized). Model-facing; also used by the builder wizard, whose prompt
    payloads must stay valid JSON (clip_json's byte-level tail cut may not)."""
    if isinstance(node, dict):
        return {k: prune(v, list_cap, str_cap) for k, v in node.items()}
    if isinstance(node, list):
        out = [prune(v, list_cap, str_cap) for v in node[:list_cap]]
        if len(node) > list_cap:
            out.append(f"…{len(node) - list_cap} more omitted")
        return out
    if isinstance(node, str) and len(node) > str_cap:
        return node[:str_cap] + "…"
    return node


def _utf8_clip(s: str, cap: int) -> str:
    """Cut a string to at most `cap` UTF-8 bytes without splitting a codepoint."""
    b = s.encode("utf-8")
    if len(b) <= cap:
        return s
    return b[:cap].decode("utf-8", "ignore")


def clip_json(doc: Any, cap: int = QA_TOOL_RESULT_CHARS) -> str:
    """Serialize a tool result under a UTF-8 BYTE budget: structural prune first (lists/
    strings), hard cut as the last resort — a clipped tail is model-facing, not a wire DTO.
    Bytes, not characters: a CJK-heavy result must not reach the model at ~3x the cap."""
    s = json.dumps(doc, ensure_ascii=False, separators=(",", ":"))
    if len(s.encode("utf-8")) <= cap:
        return s
    s = json.dumps(prune(doc), ensure_ascii=False, separators=(",", ":"))
    return s if len(s.encode("utf-8")) <= cap else _utf8_clip(s, cap) + "…(truncated)"


def _clean_name(raw: Any) -> str | None:
    name = str(raw or "").strip()[:100]
    if not name or name.startswith("-"):
        return None
    # DeepSeek's tool-argument generator occasionally DOUBLES a name verbatim (seen live:
    # "キュウコン（アローラのすがた）キュウコン（アローラのすがた）"), which then misses every
    # lookup and reads as "no data". No real entity name is its own first half repeated —
    # fold the duplication instead of failing the question.
    half = len(name) // 2
    if len(name) >= 6 and len(name) % 2 == 0 and name[:half] == name[half:]:
        name = name[:half]
    return name


# DeepSeek occasionally writes its tool-call DSL INTO the content instead of the structured
# tool_calls field (seen live: an answer body of <｜DSML｜invoke ...> markup). Such a reply
# is machine noise, never an answer — fail it (502, quota refunded) instead of showing it.
_TOOL_MARKUP = re.compile(r"<[|｜]{1,2}|DSML|tool[_▁]calls|<tool_call")


def _reject_tool_markup(content: str, tokens: int) -> str:
    if _TOOL_MARKUP.search(content):
        raise QaFailed("model leaked tool-call markup into the answer", tokens)
    return content


def _strip_markdown(text: str) -> str:
    """The prompt demands plain text, but chat models still sprinkle markdown out of habit
    and the SPA renders entities itself — stray markers are literal noise. Strip the common
    ones conservatively: paired emphasis, inline code/fences, and leading heading/bullet/
    quote markers. Inline hyphens, '#1'-style ranks and numeric ranges are left untouched
    (only line-leading markers are removed).

    Blank lines are DROPPED, not collapsed: models pad plain-text answers with markdown-style
    paragraph breaks, and the SPA already spaces every line as its own block — so each blank line
    arrives as a second, empty block and the answer reads as if it has holes punched through it."""
    text = text.replace("**", "").replace("__", "").replace("`", "")
    lines = []
    for line in text.split("\n"):
        s = re.sub(r"^\s{0,3}#{1,6}\s+", "", line)   # ATX heading -> its text
        s = re.sub(r"^\s{0,3}[-*+]\s+", "", s)        # bullet marker -> the item text
        s = re.sub(r"^\s{0,3}>\s?", "", s)            # blockquote marker
        if s.strip():
            lines.append(s)
    return "\n".join(lines).strip()


_SPREAD_KEYS = ("hp", "atk", "def", "spa", "spd", "spe")

# Main-series English regional idiom -> the dex's canonical suffix form. Models translate
# user names into "Alolan Ninetales" out of habit; the dex only knows "Ninetales-Alola".
_REGION_FORMS = {"alolan": "Alola", "galarian": "Galar", "hisuian": "Hisui",
                 "paldean": "Paldea"}
_REGION_RE = re.compile(r"^(Alolan|Galarian|Hisuian|Paldean)\s+(.+)$", re.IGNORECASE)


def _resolve_query(pool: Any, name: str, kind: str = "pokemon",
                   timeout: float = 15.0) -> str:
    """Snap one tool-argument name to dex canonical when possible (trilingual fuzzy);
    unresolvable names pass through verbatim so the downstream lookup reports the miss
    honestly. Also tries the regional-idiom rewrite (seen live: 'Alolan Ninetales' missed
    every lookup while 'Ninetales-Alola' and all zh/ja spellings hit)."""
    candidates = [name]
    m = _REGION_RE.match(name)
    if m:
        candidates.append(f"{m.group(2)}-{_REGION_FORMS[m.group(1).lower()]}")
    try:
        doc = pool.request_json(
            "dex", ["resolve", *candidates, "--format", "json", "--kind", kind],
            timeout=timeout)
        for e in doc if isinstance(doc, list) else []:
            if isinstance(e, dict) and e.get("ok") and e.get("canonical"):
                return str(e["canonical"])
    except Exception:
        pass
    return name


def _repset_budget(timeout: float, budget: float | None) -> float:
    """The repset fallback is a COLD one-shot `team.py` subprocess, so it earns more than
    QA_TOOL_TIMEOUT — but never more than the pipeline has left.

    Without the clamp `max(timeout, QA_REPSET_TIMEOUT)` re-inflated an already deadline-bounded
    budget back to a flat 60s, so ONE fallback could reserve two thirds of the 90s wall clock and
    starve every remaining tool call. Speed questions hit this constantly: a Mega form is keyed in
    the meta by its BASE species, so `meta detail` misses and both combatants land here — 2x60s
    against a 90s deadline, which surfaced to the user as an intermittent "answer failed"."""
    want = max(timeout, QA_REPSET_TIMEOUT)
    return max(1.0, min(want, budget) if budget is not None else want)


def _modal_combatant(pool: Any, fmt: str, name: str, timeout: float,
                     budget: float | None = None) -> tuple[dict, str]:
    """Most-used set for one calc combatant: usage modes (mapped detail — English canonical
    everywhere), falling back to the real-team representative set for forms the meta keys
    by base species (Megas), then to a bare default. Returns (combatant, provenance) — the
    provenance rides into the tool result so the model can DISCLOSE the assumption."""
    from .. import mappers
    try:
        doc = pool.request_json("meta", ["detail", "--format", fmt, "--pokemon", name,
                                         "--output", "json"], timeout=timeout)
        if isinstance(doc, dict) and not doc.get("error"):
            dto = mappers.map_detail(doc)
            panels = dto.get("panels") or {}
            out: dict[str, Any] = {"name": dto.get("name") or name}
            for panel, key in (("items", "item"), ("abilities", "ability"),
                               ("natures", "nature")):
                entries = panels.get(panel) or []
                if entries and entries[0].get("name"):
                    out[key] = entries[0]["name"]
            spreads = panels.get("spreads") or []
            spread = (spreads[0] or {}).get("spread") if spreads else None
            if isinstance(spread, dict) and spread:
                out["sps"] = {k: int(v) for k, v in spread.items()
                              if k in _SPREAD_KEYS and isinstance(v, (int, float))}
            return out, "most-used set (usage modes)"
    except Exception:
        pass
    try:
        doc = pool.request_json("team", ["repset", name, "--game-format", fmt,
                                         "--format", "json"],
                                timeout=_repset_budget(timeout, budget))
        arch = (doc.get("archetypes") or []) if isinstance(doc, dict) else []
        if arch and isinstance(arch[0], dict):
            a = arch[0]
            out = {"name": a.get("species") or name}
            for k in ("item", "ability", "nature"):
                if a.get(k):
                    out[k] = a[k]
            sps = spread_from_sps(a.get("sps"))
            if sps:
                out["sps"] = sps
            return out, "real-team representative set"
    except Exception:
        pass
    return {"name": name}, "no usage data — default neutral set"


def _run_tool(pool: Any, name: str, args: dict,
              timeout: float = QA_TOOL_TIMEOUT,
              budget: float | None = None) -> tuple[tuple[str, str, dict] | None, str]:
    """Execute one whitelisted tool call. Returns ((tool_id, label, params) or None, content).
    Bad arguments and CLI error shapes become CONTENT (the model reads the miss and says
    so); only infrastructure faults bubble up via WorkerError -> content too. `timeout` is
    the deadline-bounded budget for the worker call (design §7.2); `budget` is the pipeline's
    whole remaining wall clock, which bounds the longer-running repset fallback."""
    timeout = max(1.0, timeout)
    try:
        if name == "dex_lookup":
            kind = args.get("kind")
            q = _clean_name(args.get("name"))
            if kind not in DEX_KINDS or q is None:
                return None, json.dumps({"error": "bad dex_lookup arguments"})
            q = _resolve_query(pool, q, kind, timeout)
            doc = pool.request_json("dex", [kind, q, "--format", "json"], timeout=timeout)
            return (f"dex.{kind}", f"dex {kind} {q}", {"kind": kind, "name": q}), clip_json(doc)
        if name == "meta_ranking":
            fmt = args.get("format")
            if fmt not in ("single", "double"):
                return None, json.dumps({"error": "bad meta_ranking arguments"})
            limit = max(1, min(int(args.get("limit") or 30), 50))
            doc = pool.request_json("meta", ["ranking", "--format", fmt, "--limit",
                                             str(limit), "--output", "json"], timeout=timeout)
            return ("meta.ranking", f"meta ranking {fmt} top{limit}",
                    {"format": fmt, "limit": limit}), \
                clip_json(doc, cap=QA_TOOL_RESULT_CHARS * 2)
        if name == "meta_detail":
            fmt = args.get("format")
            q = _clean_name(args.get("pokemon"))
            if fmt not in ("single", "double") or q is None:
                return None, json.dumps({"error": "bad meta_detail arguments"})
            q = _resolve_query(pool, q, "pokemon", timeout)
            doc = pool.request_json("meta", ["detail", "--format", fmt, "--pokemon", q,
                                             "--output", "json"], timeout=timeout)
            return ("meta.detail", f"meta detail {fmt} {q}",
                    {"format": fmt, "pokemon": q}), clip_json(doc)
        if name == "repset_lookup":
            fmt = args.get("format") or "single"
            q = _clean_name(args.get("pokemon"))
            if fmt not in ("single", "double") or q is None:
                return None, json.dumps({"error": "bad repset_lookup arguments"})
            q = _resolve_query(pool, q, "pokemon", timeout)
            doc = pool.request_json("team", ["repset", q, "--game-format", fmt,
                                             "--format", "json"],
                                    timeout=_repset_budget(timeout, budget))
            arches = []
            for a in (doc.get("archetypes") or [])[:2] if isinstance(doc, dict) else []:
                if isinstance(a, dict):
                    arches.append({"species": a.get("species"), "ability": a.get("ability"),
                                   "item": a.get("item"), "nature": a.get("nature"),
                                   "moves": a.get("moves"),
                                   "sps": spread_from_sps(a.get("sps")),
                                   "share": a.get("share"),
                                   "confidence": a.get("confidence")})
            out: dict[str, Any] = {"resolved": (doc.get("query") or {}).get("resolved")
                                   if isinstance(doc, dict) else None,
                                   "format": fmt, "archetypes": arches}
            if not arches:
                out["note"] = "no real-team sample for this pokemon in this format"
            return ("team.repset", f"repset {fmt} {q}",
                    {"format": fmt, "pokemon": q}), clip_json(out)
        if name == "speed_ladder":
            fmt = args.get("format") or "single"
            who = _clean_name(args.get("pokemon"))
            if fmt not in ("single", "double") or who is None:
                return None, json.dumps({"error": "bad speed_ladder arguments"})
            try:
                limit = max(1, min(30, int(args.get("limit") or 20)))
            except (TypeError, ValueError):
                limit = 20
            from .. import mappers      # local import, same as the other calc branches: `mappers`
            #                                is function-local here, so using it before this line
            #                                is an UnboundLocalError, not a NameError.
            who = _resolve_query(pool, who, "pokemon", timeout)
            rank_doc = pool.request_json(
                "meta", ["ranking", "--format", fmt, "--limit", str(limit), "--output", "json"],
                timeout=timeout)
            names = [r.get("pokemon_en") or r.get("pokemon") or r.get("slug")
                     for r in ((rank_doc or {}).get("rows") or [])]
            names = [n for n in names if n]
            # `who` first so its row is unambiguous even when it is itself in the ranking.
            ordered = [who] + [n for n in names if n != who]
            # ONE resolution pass + ONE speedline batch for the whole field: looping calc_speed over
            # a ranking is what made this class of question run out of tool rounds before it had
            # enough of the field to answer.
            sides = [_modal_combatant(pool, fmt, n, timeout, budget) for n in ordered]
            items = []
            for combatant, _src in sides:
                it: dict[str, Any] = {"name": combatant["name"]}
                if combatant.get("nature"):
                    it["nature"] = combatant["nature"]
                spe = (combatant.get("sps") or {}).get("spe")
                if spe:
                    it["sps"] = {"spe": spe}
                for k in ("item", "ability"):
                    if combatant.get(k):
                        it[k] = combatant[k]
                items.append(it)
            doc = pool.request_json("speedline", ["batch"],
                                    json.dumps(items, ensure_ascii=False),
                                    timeout=max(timeout, 45.0) if budget is None
                                    else max(1.0, min(max(timeout, 45.0), budget)))
            rows = []
            for (combatant, src), raw in zip(sides, doc if isinstance(doc, list) else []):
                if isinstance(raw, dict) and not raw.get("error"):
                    m = mappers.map_speedline(raw)
                    rows.append({"name": m["name"], "finalSpeed": m["finalSpeed"],
                                 "nature": m["nature"], "speSp": m["speedSPs"],
                                 "item": combatant.get("item"), "basis": src})
            if not rows:
                return ("speed_ladder", f"speed ladder: {who} ({fmt})", {"pokemon": who}),                     json.dumps({"error": "no speed could be computed"})
            mine = rows[0]
            base = mine.get("finalSpeed")
            field = sorted((r for r in rows[1:] if r.get("finalSpeed") is not None),
                           key=lambda r: -r["finalSpeed"])
            out = {
                "pokemon": mine["name"], "format": fmt, "finalSpeed": base,
                "basis": mine.get("basis"),
                "note": "most-used sets; a set that ties is NOT faster. Speeds are the modal build "
                        "only — a faster variant of the same pokemon may exist.",
                "outspeedsMe": [r for r in field
                                if base is not None and (r["finalSpeed"] or 0) > base],
                "slowerThanMe": [r for r in field
                                 if base is not None and (r["finalSpeed"] or 0) < base],
                "ties": [r for r in field if base is not None and r["finalSpeed"] == base],
            }
            return ("speed_ladder", f"speed ladder: {mine['name']} ({fmt})",
                    {"pokemon": mine["name"], "format": fmt, "limit": limit}), clip_json(out)
        if name == "calc_damage":
            from .. import mappers
            fmt = args.get("format") or "single"
            atk_n = _clean_name(args.get("attacker"))
            dfd_n = _clean_name(args.get("defender"))
            mv = _clean_name(args.get("move"))
            if fmt not in ("single", "double") or None in (atk_n, dfd_n, mv):
                return None, json.dumps({"error": "bad calc_damage arguments"})
            atk_n = _resolve_query(pool, atk_n, "pokemon", timeout)
            dfd_n = _resolve_query(pool, dfd_n, "pokemon", timeout)
            mv = _resolve_query(pool, mv, "move", timeout)
            atk, src_a = _modal_combatant(pool, fmt, atk_n, timeout, budget)
            dfd, src_d = _modal_combatant(pool, fmt, dfd_n, timeout, budget)
            for override, side in ((args.get("attacker_item"), atk),
                                   (args.get("defender_item"), dfd)):
                item = _clean_name(override) if override else None
                if item:
                    side["item"] = _resolve_query(pool, item, "item", timeout)
                    side["_item_overridden"] = True
            payload = {"attacker": {k: v for k, v in atk.items() if not k.startswith("_")},
                       "defender": {k: v for k, v in dfd.items() if not k.startswith("_")},
                       "move": mv, "field": {"format": fmt}}
            doc = pool.request_json("calc", ["one"],
                                    json.dumps(payload, ensure_ascii=False), timeout=timeout)
            label = ("calc.damage", f"calc {atk['name']} {mv} vs {dfd['name']}",
                     {"attacker": atk["name"], "move": mv, "defender": dfd["name"],
                      "format": fmt})
            if isinstance(doc, dict) and doc.get("error"):
                return label, clip_json(doc)   # unknown move/mon: an honest miss
            mapped = mappers.map_damage(doc)
            result = {"description": mapped.get("description"),
                      "koChance": mapped.get("koChance"),
                      "minPercent": mapped.get("minPercent"),
                      "maxPercent": mapped.get("maxPercent"),
                      "hits": mapped.get("hits"),
                      "assumedSets": {
                          "attacker": {**payload["attacker"], "basis": src_a},
                          "defender": {**payload["defender"], "basis": src_d}}}
            return label, clip_json(result)
        if name == "calc_speed":
            from .. import mappers
            fmt = args.get("format") or "single"
            a_n = _clean_name(args.get("pokemon_a"))
            b_n = _clean_name(args.get("pokemon_b"))
            if fmt not in ("single", "double") or None in (a_n, b_n):
                return None, json.dumps({"error": "bad calc_speed arguments"})
            a_n = _resolve_query(pool, a_n, "pokemon", timeout)
            b_n = _resolve_query(pool, b_n, "pokemon", timeout)
            sides = [_modal_combatant(pool, fmt, n, timeout, budget) for n in (a_n, b_n)]
            items = []
            for combatant, _src in sides:
                item: dict[str, Any] = {"name": combatant["name"]}
                if combatant.get("nature"):
                    item["nature"] = combatant["nature"]
                spe = (combatant.get("sps") or {}).get("spe")
                if spe:
                    item["sps"] = {"spe": spe}
                for k in ("item", "ability"):
                    if combatant.get(k):
                        item[k] = combatant[k]
                items.append(item)
            doc = pool.request_json("speedline", ["batch"],
                                    json.dumps(items, ensure_ascii=False), timeout=timeout)
            rows = []
            for (combatant, src), raw in zip(sides, doc if isinstance(doc, list) else []):
                if isinstance(raw, dict) and not raw.get("error"):
                    m = mappers.map_speedline(raw)
                    rows.append({"name": m["name"], "finalSpeed": m["finalSpeed"],
                                 "nature": m["nature"], "speSp": m["speedSPs"],
                                 "item": combatant.get("item"), "basis": src})
                else:
                    rows.append({"name": combatant["name"],
                                 "error": "speed could not be computed"})
            speeds = [r.get("finalSpeed") for r in rows]
            faster = None
            if len(speeds) == 2 and all(isinstance(s, (int, float)) for s in speeds):
                faster = ("tie" if speeds[0] == speeds[1]
                          else rows[0]["name"] if speeds[0] > speeds[1] else rows[1]["name"])
            return ("calc.speed", f"speed {a_n} vs {b_n}",
                    {"a": a_n, "b": b_n, "format": fmt}), \
                clip_json({"combatants": rows, "faster": faster})
        return None, json.dumps({"error": f"unknown tool {name!r}"})
    except Exception as e:  # WorkerError / JSON decode — the model can still answer honestly
        return None, json.dumps({"error": f"tool failed: {type(e).__name__}"})


DIAGNOSE_EXPLAIN_PROMPT = """\
You are the team analyst of a Pokemon Champions data site. You receive ONE team-diagnose
report as JSON facts: legality, weaknesses by attack type, offensive gaps, speed order,
role coverage, and per-opponent check grades against the top meta.

FIELD GUIDE for `checks.byOpponent` — read these EXACTLY as defined, never guess:
- observedFloor: the weakest team answer across every RETAINED OBSERVED build of that
  opponent. C2 = someone can switch in safely and win the 1v1; C1 = someone can beat it
  on even footing but cannot switch in; C0 = neither. This is an observed portfolio floor,
  NOT a fabricated max-speed or broad-move worst case.
- witnessVariantIds: the exact retained builds where observedFloor occurs. floorBy names
  the team members providing the strongest answer on those witness builds.
- representativeGrade: the answer against the highest-coverage retained build. It is useful
  context but never replaces a weaker observedFloor.
- representedCoverage: share of the real-team sample covered by retained builds. This is
  provenance, not probability of winning or a strength score. calculationComplete=false means
  at least one retained build lacks a calculation; do not claim a complete floor.
- A grade C1/C0 despite big damage numbers usually means the kill is not CERTAIN (e.g.
  the opponent's common Focus Sash, move accuracy, damage rolls) or my member cannot
  survive the return hit — respect the grade; do not overrule it with damage intuition.

Metagame calls (maintainer-set):
- Coverage entries carry a per-format `expectation` ATTENTION LEVEL, not a universal team
  requirement. `priority` means inspect an absence closely and raise it only when the other
  report facts show a concrete consequence. `situational` means it matters only to plans that
  call for it; a missing situational entry is normal and is filtered from this payload. If a
  role is not in the coverage list, do not invent a gap. Never print the internal expectation
  tokens as labels in the answer. In singles, anti_setup is a high-priority signal to inspect
  (hard answers to stat-boosting sweepers: phazing, Haze-class moves, Unaware/Imposter);
  Toxic/Yawn under `status` are only soft, partial substitutes.
- Coverage classes: priority_attack = endgame priority finishers (priority-attention in singles;
  situational in doubles, where Fake Out + speed control substitute); weather_rewrite = the
  ability to overwrite the opponent's weather — a Mega form's ability counts (a Froslassite
  Froslass battles as Mega Froslass / Snow Warning, a real setter); disruption = Taunt/Encore
  class; damage_mitigation = Intimidate/burn class (priority-attention in doubles); fake_out = doubles
  opening pressure.
- Mega plan reading: two registered Mega stones are normal. If the report does not state a
  default Mega, do NOT invent one or infer what either form "solves" from model memory; say
  only that the battle selection must be made explicit when that ambiguity matters.
- A coverage entry with present=true means the team HAS that role — never call it missing,
  lacking, or "no hard answer": the bearers list names who provides it. Real teams do not
  double-invest in a role: never recommend ADDING a role that present=true already covers.
  If the single bearer looks exploitable, say the role rests on that one member and name
  the risk — that is a robustness note, not a missing role.

Write a SHORT interpretation (about 120 words, plain text, no markdown):
- the 2-3 most consequential problems in this report and WHY they matter,
- for each, what kind of change would address it (which member or slot to reconsider),
- grounded ONLY in the report facts — never invent numbers, matchups or members; when you
  cite a check grade, use observedFloor and name the opponent; name witness builds only when useful.
- the `team` list is the COMPLETE roster of MY team — advise ONLY those members. Every other
  Pokemon anywhere in the data (above all `checks.byOpponent[].opponent`) is an OPPONENT, never
  mine: never tell it to carry a move/item, never treat it as if it were on my team.
Name every Pokemon, move, item, ability and nature by its ENGLISH CANONICAL name exactly as
the report does (the site localizes names itself). Answer in the language given by [lang=..].
"""

DIAGNOSE_EXPLAIN_THINKING_PROFILE = """\

Thinking-mode output profile — this OVERRIDES the earlier 120-word/2-3-problem length only;
all factual and roster constraints above remain mandatory. Write a substantial, specific
interpretation as 3 short plain-text paragraphs (no headings or markdown): about 450-700
Chinese characters, 220-320 English words, or 550-850 Japanese characters.
- Explain the team's concrete structure using ONLY present entries in `roles.coverage` and
  their bearers/via values. Cite actual members and supplied moves/items/abilities, but do not
  add a mechanics explanation from memory.
- Connect 2-4 consequential risks across report sections. For opponent rows, report only the
  observedFloor, witnessVariantIds, floorBy, representativeGrade, representedCoverage, and
  calculationComplete facts. The compact payload intentionally has
  no damage cells: do not explain WHY a grade was assigned, infer turns-to-KO, or add speed,
  accuracy, typing, Focus Sash, weather, or damage claims.
- Close with 2-3 priorities phrased as selection/preservation needs or a CURRENT slot/role whose
  robustness needs checking. Name relevant opponents and members, but not an exact new set.
Every paragraph must contain concrete team entities or report facts. Vary the prose naturally;
avoid headings and repeated template labels that could describe an arbitrary team.
- This is an evidence briefing, NOT a rebuild. Never recommend a new named Pokemon, move, item,
  ability, spread, or type-based counter: the payload has no learnset/replacement authority.
  Describe only the needed function and which CURRENT slot could be reconsidered; exact changes
  require a later legality/calc check. This overrides the earlier request to suggest changes.
- Pokemon Champions has team selection but no ban phase. Say select/lead/preserve/position;
  never tell the user to ban an opponent.
- Entity spelling is non-negotiable even in Chinese/Japanese prose: write `Pelipper 的 Drizzle`,
  never translate Pelipper or Drizzle. The UI performs localization after generation.
"""

DIAGNOSE_EXPLAIN_THINKING_USER_CONTRACT = """\
FINAL OUTPUT CONTRACT: exactly 3 plain-text paragraphs and follow the language-specific length
range in the thinking-mode profile.
This is evidence interpretation, not a rebuild. Use English canonical entity spellings even
inside Chinese prose. Do not introduce or recommend ANY named entity absent from [report].
For opponent matchups, use only observedFloor/witnessVariantIds/floorBy/representativeGrade/
representedCoverage/calculationComplete. Never explain a grade's cause
or invent mechanics, moves, items, damage, speed, accuracy, or type interactions. Adjustment
priorities may name a current slot and a needed function only. No headings, markdown, ban phase,
or generic filler.
"""

DIAGNOSE_EXPLAIN_INPUT_BYTES = 28_000
DIAGNOSE_EXPLAIN_MAX_TOKENS = 650
DIAGNOSE_EXPLAIN_THINKING_MAX_TOKENS = 6000
DIAGNOSE_EXPLAIN_THINKING_TIMEOUT = 120.0


def _diagnose_explain_projection(report: dict) -> dict:
    """Compact model-facing report that keeps every opponent roll-up but drops the
    6-member damage cells. The deterministic API/UI still receives the complete grid.

    With top-30 checks the cells dominate the payload (~170 KB). Keep the deterministic
    roll-ups for all 30. The prose layer must not reverse-engineer a grade from selected cells:
    partial evidence encouraged confident but incorrect causal explanations in real calls.
    """
    trimmed = {k: report.get(k) for k in
               ("legality", "defense", "offense", "speed", "roles", "checks")}
    checks = trimmed.get("checks")
    if isinstance(checks, dict):
        source_rows = [row for row in (checks.get("byOpponent") or [])
                       if isinstance(row, dict)]

        rows = []
        for row in source_rows:
            if not isinstance(row, dict):
                continue
            projected = {k: row.get(k) for k in
                         ("opponent", "usageRank", "observedFloor", "witnessVariantIds",
                          "floorBy", "representativeGrade", "representedCoverage",
                          "calculationComplete")}
            rows.append(projected)
        trimmed["checks"] = {
            "topK": checks.get("topK"),
            "confidence": checks.get("confidence"),
            "byOpponent": rows,
        }
    return trimmed


def _localize_diagnose_attention_tokens(text: str, lang: str) -> str:
    """Last-resort guard for model echoes of DTO enum values in non-English prose.

    The prompt and payload use non-prescriptive public levels, but an upstream model can still
    echo a token literally. Keep that implementation vocabulary out of the user-facing reading.
    """
    if lang == "zh":
        replacements = {"required": "重点关注", "priority": "重点关注",
                        "optional": "按需关注", "situational": "按需关注"}
    elif lang == "ja":
        replacements = {"required": "要確認", "priority": "要確認",
                        "optional": "必要に応じて", "situational": "必要に応じて"}
    else:
        return text
    for raw, localized in replacements.items():
        text = re.sub(rf"`?\b{raw}\b`?", localized, text, flags=re.IGNORECASE)
    return text


def explain_diagnose(provider: LlmProvider, report: dict, lang: str) -> tuple[str, int]:
    """One tool-less LLM call turning a diagnose report's facts into a short reading
    (the local agent's interpretation layer, ported as an OPT-IN online add-on). Returns
    (text, tokens burned); raises LlmUnavailable / QaFailed like the QA pipeline."""
    trimmed = _diagnose_explain_projection(report)
    # Drop SITUATIONAL-tier absences from the coverage fed to the model: they are normal in the
    # format and must never surface as problems — removing them from the payload is the
    # surest guard (belt-and-suspenders with the prompt rule). Present roles and REQUIRED
    # absences stay (signals worth checking against the rest of the report).
    roles = trimmed.get("roles")
    if isinstance(roles, dict) and isinstance(roles.get("coverage"), list):
        kept = [c for c in roles["coverage"]
                if not (isinstance(c, dict) and not c.get("present")
                        and c.get("expectation") == "situational")]
        trimmed = {**trimmed, "roles": {**roles, "coverage": kept}}
    # State the complete user team explicitly and FIRST. The richer thinking profile needs
    # the actual sets to explain a plan rather than emitting a generic coverage summary; this
    # is the visitor's own submitted data, not private metagame evidence.
    team = [{k: m.get(k) for k in
             ("species", "item", "ability", "nature", "moves", "spread")}
            for m in ((report.get("team") or {}).get("pokemon") or [])
            if isinstance(m, dict) and m.get("species")]
    trimmed = {"team": team, **trimmed}
    thinking = getattr(provider, "thinking_enabled", False)
    report_json = clip_json(trimmed, cap=DIAGNOSE_EXPLAIN_INPUT_BYTES)
    user_content = f"[lang={lang}] [report]{report_json}\n[/report]"
    if thinking:
        # Repeat the high-risk constraints AFTER the data: long system prompts are easy for a
        # reasoning model to dilute while drafting a lengthy answer; the final user contract is
        # the closest instruction to the completion.
        user_content += "\n" + DIAGNOSE_EXPLAIN_THINKING_USER_CONTRACT
    messages = [
        {"role": "system", "content": DIAGNOSE_EXPLAIN_PROMPT
         + (DIAGNOSE_EXPLAIN_THINKING_PROFILE if thinking else "")},
        {"role": "user", "content": user_content},
    ]
    max_tokens = (DIAGNOSE_EXPLAIN_THINKING_MAX_TOKENS
                  if thinking
                  else DIAGNOSE_EXPLAIN_MAX_TOKENS)
    timeout = (DIAGNOSE_EXPLAIN_THINKING_TIMEOUT
               if thinking
               else QA_LLM_TIMEOUT)
    result = provider.chat(messages, [], max_tokens=max_tokens,
                           tool_choice="none", timeout=timeout)
    tokens = result.prompt_tokens + result.completion_tokens
    text = _strip_markdown(str(result.message.get("content") or "").strip())
    text = _localize_diagnose_attention_tokens(text, lang)
    if not text:
        raise QaFailed("empty diagnose explanation", tokens)
    _reject_tool_markup(text, tokens)
    return text, tokens


def answer(pool: Any, provider: LlmProvider, question: str, lang: str) -> dict:
    """Run the full pipeline. Returns {"answer", "toolTrace", "grounded", "tokens"} plus the
    metric split the §9 benchmark consumes ("promptTokens"/"completionTokens"/"cacheHitTokens"/
    "llmCalls"/"toolBytes"); raises QaFailed (tokens attached) when the model never produces
    usable content. `grounded` is True only when a tool actually ran — an ungrounded reply is a
    refusal/decline, never a Champions fact (design §7.2).

    Two hard caps make §7.2/§7.4 real, not aspirational: the wall-clock deadline is threaded
    into EVERY provider/worker call (so no single call runs past it) and re-checked between
    tools; and once cumulative tokens cross QA_MAX_REQUEST_TOKENS the loop stops spending on
    tool rounds and forces the closing synthesis."""
    messages: list[dict] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": f"[lang={lang}] {question}"},
    ]
    trace: list[dict] = []
    tokens = 0
    metrics = {"promptTokens": 0, "completionTokens": 0, "cacheHitTokens": 0,
               "llmCalls": 0, "toolBytes": 0}
    deadline = time.monotonic() + QA_DEADLINE_SECONDS
    for round_no in range(QA_MAX_ROUNDS + 1):
        rem = deadline - time.monotonic()
        if rem <= 0:
            raise QaFailed("qa deadline exceeded", tokens)
        # Force the closing synthesis on the last allowed round OR once the token ceiling is
        # crossed — no further tool spend, one final tool_choice=none call to answer.
        final = round_no == QA_MAX_ROUNDS or tokens >= QA_MAX_REQUEST_TOKENS
        try:
            result: ChatResult = provider.chat(
                messages, TOOLS, max_tokens=QA_MAX_ANSWER_TOKENS,
                tool_choice="none" if final else "auto",
                timeout=min(QA_LLM_TIMEOUT, rem))
        except LlmUnavailable as e:
            e.tokens = tokens        # earlier rounds already cost money — settle them truthfully
            raise
        tokens += result.prompt_tokens + result.completion_tokens
        metrics["promptTokens"] += result.prompt_tokens
        metrics["completionTokens"] += result.completion_tokens
        metrics["cacheHitTokens"] += result.cache_hit_tokens
        metrics["llmCalls"] += 1
        msg = result.message
        calls = msg.get("tool_calls") or []
        if not calls:
            content = _strip_markdown(str(msg.get("content") or "").strip())
            if not content:
                raise QaFailed("model returned an empty answer", tokens)
            _reject_tool_markup(content, tokens)
            return {"answer": content, "toolTrace": trace, "grounded": bool(trace),
                    "tokens": tokens, **metrics}
        # Every tool_call id MUST get a tool message back (API contract), including the
        # ones past the per-round cap or the deadline — those get an error instead of execution.
        messages.append(msg)
        for i, tc in enumerate(calls):
            fn = tc.get("function") or {}
            if i >= QA_MAX_CALLS_PER_ROUND:
                content = json.dumps({"error": "per-round tool budget exceeded"})
            elif (rem := deadline - time.monotonic()) <= 1:
                content = json.dumps({"error": "deadline exceeded"})
            else:
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                    if not isinstance(args, dict):
                        args = {}
                except ValueError:
                    args = {}
                traced, content = _run_tool(pool, str(fn.get("name") or ""), args,
                                            timeout=min(QA_TOOL_TIMEOUT, rem), budget=rem)
                metrics["toolBytes"] += len(content.encode("utf-8"))
                if traced is not None:
                    trace.append({"tool": traced[0], "label": traced[1], "params": traced[2]})
            messages.append({"role": "tool", "tool_call_id": str(tc.get("id") or ""),
                             "content": content})
    raise QaFailed("model kept requesting tools past the forced-final round", tokens)
