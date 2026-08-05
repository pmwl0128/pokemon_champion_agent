"""Web UEP builder-wizard orchestration (frontend/design.md §7.3): one static form -> the FULL
UEP gate chain -> one team + correctness confirmation. The product shape is fixed — no
candidate comparison, no mid-run questions, no conversation loop — but every deterministic
gate runs for real:

    form -> context-audit + intake done:true -> frame -> grounding (ranking/details)
         -> LLM assemble (ONE candidate; assisted_workflow allows a single-team answer when
            the user explicitly requests one — the web form itself constitutes that request)
         -> slate-evaluate (top-K) -> checkpoint (direct_final constant) -> draft
         -> answer-audit, with at most ONE semantic LLM repair across the whole task (§7.4)

`single_team_requested:true` and `direct_final:true` are PROFILE CONSTANTS here, not user
options. The LLM's only creative step is assemble; it emits STRICT JSON (team plus a bounded
rationale string, never markdown or an unstructured answer). Deterministic operators run
through `team.py session` batches exactly like the local bridge does (§4.1) — controlled
temp files per batch, deleted immediately (§7.3).

If deterministic sanitation changes a generated set, a bounded prose-only call rewrites
the rationale against the exact final team; a stale or malformed rewrite is omitted.

The onboarding contract (§7.3 form mapping): every wizard run answers all nine intake
onboarding IDs — four explicitly from form controls, five as disclosed profile defaults —
and the orchestrator VERIFIES that with `intake --next` (done:true) before generating, so
an intake-catalog drift fails loud here instead of surfacing as an answer-audit violation."""
from __future__ import annotations

import json
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .. import mappers
from .provider import ChatResult, LlmProvider, LlmUnavailable
from .qa import prune, spread_from_sps

BUILDER_DEADLINE_SECONDS = 420.0    # wall clock for the whole pipeline
BUILDER_LLM_TIMEOUT = 90.0
BUILDER_THINKING_LLM_TIMEOUT = 180.0
BUILDER_TEAM_TIMEOUT = 240.0        # per team.py session batch (cold siblings on the VPS)
BUILDER_MAX_TEAM_TOKENS = 1800
BUILDER_THINKING_MAX_TEAM_TOKENS = 8000
BUILDER_MAX_REPAIRS = 1             # LLM repair budget per task (§7.4)
BUILDER_TOP_K = 30                   # slate-evaluate pressure-test scope (disclosed in the UI)

# Grounding trim caps (structural prune — the prompt payload must stay VALID JSON, so no
# byte-level tail cuts here; §9 calibrates the real prompt sizes later).
PRUNE_SKELETON = {"list_cap": 8, "str_cap": 300}
PRUNE_DETAIL = {"list_cap": 10, "str_cap": 120}
PRUNE_PROBLEMS = {"list_cap": 10, "str_cap": 400}
# The model may ONLY pick species whose usage detail is in the prompt (hallucination
# containment) — so the detail set must be broad enough to fill flex slots: skeleton cores
# + anchor + ranking fill-up to this cap.
MAX_DETAIL_SPECIES = 14

# The nine intake onboarding IDs (team skill's `intake.ONBOARDING_IDS`); every run answers
# all of them (form control or profile default) — `intake --next` verifies this stays true.
ONBOARDING_ANSWERED = [
    "format", "use_case", "anchor_pokemon_or_mega", "anchor_theme_or_gameplan",
    "starting_point", "availability_and_avoid", "play_posture", "answer_shape",
    "extra_requirements",
]

# Disclosed profile defaults (§7.3 table). Keys are i18n ids the SPA localizes; the same
# keys go into the draft's `assumptions` as short factual English sentences.
ASSUMPTION_TEXT = {
    "use_case_ladder": "use case defaulted to general ladder play (profile default)",
    "no_theme": "no theme or game plan was specified (profile default)",
    "from_scratch": "built from scratch — no starting team or fixed pool (profile default)",
    "no_benchmarks": "no extra numeric requirements — precise tuning was not run (profile default)",
    "single_candidate": "one candidate generated and pressure-tested against the top-K meta "
                        "(simplified wizard, not a full agent build)",
}


class BuilderFailed(RuntimeError):
    """The pipeline ran but produced no auditable team. `code` is the client-facing error
    code (never contains team/request content — it may end up in a log line); `tokens`
    carries the spend so the caller settles the budget truthfully."""

    def __init__(self, code: str, tokens: int = 0):
        super().__init__(code)
        self.code = code
        self.tokens = tokens


@dataclass
class BuilderForm:
    """The validated, dex-resolved form (server.py resolves names before building)."""
    format: str                             # single | double
    anchor: str | None = None               # canonical species (Mega form allowed)
    anchor_is_mega: bool = False
    posture: str = "balance"                # offense | balance | defense
    owned: list[str] = field(default_factory=list)
    avoid: list[str] = field(default_factory=list)
    wants: list[str] = field(default_factory=list)   # PREFERRED tactic tokens
    lang: str = "zh"                                 # rationale language (entities stay EN)


def make_context(form: BuilderForm) -> tuple[dict, list[str]]:
    """Form -> (build-context, assumption keys). The context is fully structured (the team
    skill never parses free text); profile constants ride along: frame_required makes the
    build flow mandatory, direct_final keeps checkpoint from pausing (§7.3). Preferred
    tactics (`wants`) answer anchor_theme_or_gameplan explicitly — only their absence
    becomes the disclosed no_theme default."""
    ctx: dict[str, Any] = {
        "format": form.format,
        "style_lean": form.posture,
        "meta_conformance": "proven",       # profile default: general ladder play
        "mega_posture": "environment",      # explicit: follow the observed registration
        #                                     distribution (the wizard has no mega knob)
        "frame_required": True,             # build flow: frame + onboarding are mandatory
        "direct_final": True,               # profile constant: no checkpoint pause
    }
    assumptions = ["use_case_ladder"]
    if form.wants:
        ctx["wants"] = list(form.wants)
    else:
        assumptions.append("no_theme")
    if form.anchor:
        ctx["locked"] = [form.anchor]
        if form.anchor_is_mega:
            ctx["keep_mega"] = form.anchor
    if form.owned:
        ctx["owned"] = list(form.owned)
        ctx["owned_only"] = True
    else:
        assumptions.append("from_scratch")
    if form.avoid:
        ctx["avoid"] = list(form.avoid)
    assumptions += ["no_benchmarks", "single_candidate"]
    return ctx, assumptions


# Attribution keys the frame/slate/repset artifacts carry that LABEL a set as real-team
# derived — they must not reach the public progress view (revised §7.1: processed data
# ships, its real-team origin is never labeled). `spread_origin="real-team"`,
# `grounding_ref="repset:..."`, `confidence_reason="observed-sample"` and the
# `observed_facts`/`observed_fillers` blocks all disclose the real-team sampling and are
# stripped alongside the plain source/provenance fields (audit 2026-07-16).
_PROVENANCE_KEYS = {"source", "confidence", "note", "notes", "sample_count",
                    "real_team_backed", "set_source", "set_confidence", "provenance",
                    "evidence", "fetched_at", "spread_origin", "grounding_ref",
                    "confidence_reason", "observed_facts", "observed_fillers"}


def strip_provenance(obj: Any) -> Any:
    """Recursively drop attribution/provenance fields before a processed artifact goes to
    the public progress view (revised §7.1: processed data ships, its real-team origin is
    never labeled)."""
    if isinstance(obj, dict):
        return {k: strip_provenance(v) for k, v in obj.items()
                if k not in _PROVENANCE_KEYS}
    if isinstance(obj, list):
        return [strip_provenance(v) for v in obj]
    return obj


# -- deterministic operators: team.py session batches -------------------------------------

# Session-op fields team.py treats as file paths (mirror of the local bridge's whitelist):
# the orchestrator materializes inline JSON into controlled temp files per batch and the
# directory dies with the batch (§7.3 controlled temp files).
_FILE_FIELDS = ("file", "context", "slate", "frame_output", "slate_output", "audit_receipt")


def _team_session(pool: Any, ops: list[dict], deadline: float) -> list[dict]:
    rem = deadline - time.monotonic()
    if rem <= 5:
        raise BuilderFailed("deadline")
    with tempfile.TemporaryDirectory(prefix="pcweb-builder-") as tmp:
        tmp_dir = Path(tmp)
        spec_ops = []
        for i, op in enumerate(ops):
            out = dict(op)
            for f in _FILE_FIELDS:
                if f in out and isinstance(out[f], (dict, list)):
                    p = tmp_dir / f"op{i}-{f}.json"
                    p.write_text(json.dumps(out[f], ensure_ascii=False), encoding="utf-8")
                    out[f] = str(p)
            spec_ops.append(out)
        spec = tmp_dir / "session.json"
        spec.write_text(json.dumps(spec_ops, ensure_ascii=False), encoding="utf-8")
        doc = pool.request_json("team", ["session", str(spec)], None,
                                timeout=min(BUILDER_TEAM_TIMEOUT, rem))
    if not isinstance(doc, list) or len(doc) != len(ops):
        raise BuilderFailed("internal")
    return doc


def _op_result(entry: dict, allow_rc: tuple[int, ...] = (0,)) -> dict:
    """Unwrap one session item. Anything unexpected is an ORCHESTRATOR bug (the chain is
    code-driven, not user-driven) -> internal. The message stays content-free."""
    if not isinstance(entry, dict) or "error" in entry or entry.get("rc") not in allow_rc \
            or not isinstance(entry.get("result"), dict):
        raise BuilderFailed("internal")
    result = entry["result"]
    if "refused" in result:
        raise BuilderFailed("internal")
    return result


# -- grounding -----------------------------------------------------------------------------


def _detail_for_model(dto: dict) -> dict:
    """Strip a MAPPED detail DTO to what the assembler needs: ENGLISH canonical names only
    (the model must echo them verbatim — the raw CLI panels are zh/ja and feeding those
    forced the model to translate from main-series memory, i.e. to hallucinate moves the
    Champions learnset does not have), no partners, no localization."""
    panels = dto.get("panels") or {}

    def slim(entries: Any, keep: tuple[str, ...] = ()) -> list[dict]:
        out = []
        for e in entries or []:
            if not isinstance(e, dict):
                continue
            row: dict[str, Any] = {"name": e.get("name"), "percentage": e.get("percentage")}
            for k in keep:
                if e.get(k) is not None:
                    row[k] = e[k]
            out.append(row)
        return out

    return {
        "species": dto.get("name"),
        "rank": dto.get("rank"),
        "moves": slim(panels.get("moves"), ("type", "category", "power")),
        "items": slim(panels.get("items")),
        "abilities": slim(panels.get("abilities")),
        "natures": slim(panels.get("natures")),
        "spreads": (panels.get("spreads") or [])[:4],
    }


def _mega_options(pool: Any, form: BuilderForm, bases: list[str], deadline: float) -> list[dict]:
    """Representative joint sets for the Mega forms around these base species — the model's
    ONLY legal source when it adds a Mega member. The meta side keys usage by BASE species
    (there is no 'Mega Metagross' detail entry), so without this the Mega-registration
    guidance forces the model to invent stones/abilities from main-series memory (the exact
    hallucination the VPS diagnosis caught). dex exact-probing finds the form names; the
    team skill's repset supplies the real-team joint set (ability/stone/moves as one unit)."""
    probes: list[str] = []
    for base in bases:
        if base.startswith("Mega "):
            probes.append(base)     # a Mega skeleton core IS its own offer (wants-driven
            #                         frames lead with Megas — they must reach mega_options)
        else:
            probes += [f"Mega {base}", f"Mega {base} X", f"Mega {base} Y"]
    if form.anchor and form.anchor.startswith("Mega ") and form.anchor not in probes:
        probes.append(form.anchor)
    if not probes:
        return []
    try:
        doc = pool.request_json(
            "dex", ["resolve", *probes[:80], "--format", "json", "--kind", "pokemon"],
            timeout=min(30.0, max(1.0, deadline - time.monotonic())))
    except Exception:
        return []
    megas: list[str] = []
    for e in doc if isinstance(doc, list) else []:
        # raw CLI shape (snake_case) — exact matches only: the X/Y probes fuzzy-hit the
        # plain form otherwise and the plain probe already covers it.
        if isinstance(e, dict) and e.get("ok") and e.get("match_type") == "exact" \
                and e.get("is_mega"):
            name = str(e.get("canonical") or "")
            if name and name not in megas and name not in form.avoid \
                    and (not form.owned or name in form.owned):
                megas.append(name)
    if not megas:
        return []
    ops = [{"op": "repset", "species": m, "format": form.format, "max_clusters": 1}
           for m in megas[:8]]
    try:
        batch = _team_session(pool, ops, deadline)
    except BuilderFailed:
        return []
    options: list[dict] = []
    sampled: set[str] = set()
    for name, entry in zip(megas[:8], batch):
        result = entry.get("result") if isinstance(entry, dict) else None
        arch = (result or {}).get("archetypes") or []
        if not arch or not isinstance(arch[0], dict):
            continue        # no real-team sample — dex fallback below keeps it offerable
        a = arch[0]
        if a.get("species") != name:
            continue        # repset fell back to the base form: no sample for THIS Mega
        sampled.add(name)
        options.append({
            "species": a.get("species") or name,
            "item": a.get("item"),
            "ability": a.get("ability"),
            "nature": a.get("nature"),
            "moves": a.get("moves") or [],
            "spread": spread_from_sps(a.get("sps")),
        })
    # Dex-grounded fallback offers: a thin repset partition (doubles) used to leave
    # mega_options EMPTY, which starves the roster of Megas entirely and every candidate
    # dies on the modal Mega-registration lane (benchmark 2026-07-16: doubles 0/10 megas).
    # The stone + legal ability are dex facts; moves/spread come from the BASE species'
    # usage_details (Mega learnsets match the base) — the prompt says so.
    missing = [m for m in megas[:8] if m not in sampled]
    if missing:
        try:
            doc = pool.request_json(
                "dex", ["batch", "pokemon", *missing, "--format", "json"],
                timeout=min(30.0, max(1.0, deadline - time.monotonic())))
        except Exception:
            doc = []
        for e in doc if isinstance(doc, list) else []:
            if not (isinstance(e, dict) and e.get("name") and e.get("required_item")):
                continue
            options.append({
                "species": e["name"], "item": e["required_item"],
                "ability": (e.get("abilities") or [None])[0],
                "nature": None, "moves": [], "spread": None,
                "note": "no real-team sample: pick moves/nature/spread from the base "
                        "species' usage_details (the Mega learns the same moves)",
            })
    return options


def _ground(pool: Any, form: BuilderForm, skeletons: list[dict], deadline: float) -> dict:
    """Usage grounding for the assemble prompt: per-species usage detail (through the
    bridge mapper, so every name is English canonical) + representative Mega joint sets.
    The species set is the model's ENTIRE roster universe (skeleton cores + anchor +
    ranking fill-up, honoring owned/avoid) — the prompt forbids species outside the input.
    Detail misses are simply absent; the skeleton's set_guidance still grounds those cores."""
    rem = lambda: max(1.0, deadline - time.monotonic())  # noqa: E731
    species: list[str] = []

    def add(name: Any) -> None:
        if isinstance(name, str) and name and name not in species \
                and name not in form.avoid:
            species.append(name)

    add(form.anchor)
    for sk in skeletons:                # ALL skeletons — wants-driven frames fan out wide,
        for cand in (sk.get("core_candidates") or []):  # and every core must be sourced
            add(cand.get("species"))
    # Mega forms have no meta entry (usage is keyed by base species) — their sourcing is
    # mega_options/repset, so they don't consume detail slots.
    detail_names = [n for n in species if not n.startswith("Mega ")]
    try:
        rank = pool.request_json(
            "meta", ["ranking", "--format", form.format, "--limit", "20",
                     "--output", "json"], timeout=min(30.0, rem()))
        top = [r["name"] for r in mappers.map_ranking(rank).get("rows", [])
               if isinstance(r, dict) and r.get("name")]
    except Exception:
        top = []
    for name in top:
        if len(detail_names) >= MAX_DETAIL_SPECIES:
            break
        if form.owned and name not in form.owned:
            continue        # a fixed pool must not tempt the model with outside species
        if name not in detail_names and name not in form.avoid:
            detail_names.append(name)
            add(name)
    details: dict[str, Any] = {}
    for name in detail_names[:MAX_DETAIL_SPECIES]:
        try:
            doc = pool.request_json(
                "meta", ["detail", "--format", form.format, "--pokemon", name,
                         "--output", "json"], timeout=min(30.0, rem()))
            if isinstance(doc, dict) and not doc.get("error"):
                details[name] = prune(_detail_for_model(mappers.map_detail(doc)),
                                      **PRUNE_DETAIL)
        except Exception:
            continue        # unranked/unmappable species: skeleton guidance still stands
    mega_options = _mega_options(pool, form, species, deadline)
    # A locked species with NO grounding anywhere (unranked, no real-team repset sample —
    # e.g. an off-meta Mega) would leave the model nothing but main-series memory, which the
    # prompt forbids and the legality gate then rejects (VPS 2026-07-16: Mega Raichu X
    # failed every attempt on out-of-pool items / illegal ability). Feed its dex facts —
    # legal abilities, learnset, required stone — as the authoritative source instead.
    anchor_facts = None
    if form.anchor and form.anchor not in details             and form.anchor not in {o.get("species") for o in mega_options}:
        try:
            doc = pool.request_json(
                "dex", ["pokemon", form.anchor, "--format", "json"],
                timeout=min(30.0, rem()))
            if isinstance(doc, dict) and doc.get("name"):
                anchor_facts = {
                    "species": doc["name"], "types": doc.get("types") or [],
                    "abilities": doc.get("abilities") or [],
                    "learnset": doc.get("moves") or [],
                }
                if doc.get("required_item"):
                    anchor_facts["required_item"] = doc["required_item"]
        except Exception:
            anchor_facts = None
    return {"usage_details": details, "mega_options": mega_options,
            "anchor_dex_facts": anchor_facts}


# -- the assemble step (the LLM's only creative act) ---------------------------------------

SYSTEM_PROMPT = """\
You are the team-assembly engine of a Pokemon Champions team-building site.

You receive ONE JSON document: the user's structured constraints, frame skeletons grounded
in real ranked teams, and current-season usage details. You output ONE team.

Output STRICT JSON only — a single object, no prose, no markdown:
{"frame_id": "<id of the skeleton you assembled from>",
 "pokemon": [exactly 6 members],
 "rationale": "3-5 sentences on how this team plays: the game plan, the key
  trade-offs you accepted, and what each flexible slot answers. Write it in the
  language given by output_language; name every Pokemon/move/item/ability by its
  ENGLISH CANONICAL name exactly (the site localizes entity names itself)."}
Each member: {"species": "...", "item": "...", "ability": "...", "nature": "...",
 "moves": ["...", up to 4], "spread": {"hp":0,"atk":0,"def":0,"spa":0,"spd":0,"spe":0}}

Rules:
- English canonical names EXACTLY as they appear in the input data. Never invent, translate
  or abbreviate a name.
- Pokemon Champions learnsets, abilities and the item pool DIFFER from the main-series
  games. NEVER rely on memory: every move you give a member MUST appear in that species'
  usage_details "moves" list, its mega_options entry, or a skeleton's set_guidance for
  that species; items, abilities and natures likewise MUST come from that species' input
  data.
- Roster: pick ONLY species that appear in the skeletons' core_candidates, in
  usage_details, in mega_options, or named by "locked"/"anchor_dex_facts". Do not add any
  other species. Every "locked" species MUST be on the team IN THAT EXACT FORM — a locked
  "Mega X" means the Mega form itself (with its stone), never the base X in its place
  (skeleton cores may list the base species; the locked Mega still takes the slot).
- Adding a Mega member: use its "mega_options" entry and copy that joint set
  (species/item/ability/nature/moves/spread) as the baseline — Mega forms are NOT in
  usage_details.
- A mega_options entry with EMPTY moves has no real-team sample: its stone and ability
  are authoritative; take its moves, nature and spread from the BASE species' entry in
  usage_details (a Mega form learns the same moves as its base).
- "anchor_dex_facts" (present when the locked species has no usage/mega_options data) is
  that member's ONLY authoritative source: its ability MUST come from .abilities, every
  move from .learnset, and its item MUST be .required_item when given (its Mega stone).
  Champions' item pool also differs from main-series (e.g. NO Choice Specs / Choice Band):
  when unsure of an item, prefer ones appearing elsewhere in the input data.
- Item Clause: no two members may hold the same item.
- "spread" values are SP points: each stat 0-32, total at most 66 per member. Copy or adapt
  the usage spreads from the input; do not exceed the caps.
- Hard constraints: every "locked" species MUST be on the team; species in "avoid" and
  tactics in "exclude_tactics" MUST NOT appear; when "owned_only" is true use ONLY species
  from "owned". Follow "style_lean" for the overall posture.
- "wants" lists the user's PREFERRED tactics: the skeletons were already selected for
  them — build the team around those tactics (e.g. a trickroom want means a Trick Room
  setter plus slow attackers, per the skeletons and usage details).
- Mega registration count (answer-audit gates on the observed MODAL count): in the
  current meta register exactly TWO different Mega-stone holders in BOTH formats (the
  modal bucket: ~82% of real singles teams, ~56% of doubles). A locked Mega anchor counts
  as one — always add a second from mega_options. Never give two members the same stone.
- Mega registration: observed teams for a skeleton often register SEVERAL Mega-stone
  holders. If a problems document reports "mega_registration" whose reference
  modal_buckets favor more registered Megas than your team has, add Mega species (with
  their stones, from the input data) until you match the modal count.
- If a repair request lists problems with your previous team, fix EVERY listed problem and
  return the full corrected team in the same strict JSON shape.
"""

BUILDER_THINKING_SYSTEM_PROMPT = SYSTEM_PROMPT + """\

Thinking-mode rationale profile — this OVERRIDES only the earlier 3-5-sentence rationale
length; every strict-JSON and factual constraint above remains mandatory. Write `rationale`
as 3 short plain-text paragraphs separated by blank lines, 7-10 sentences total:
1) the concrete game plan and opening/control sequence;
2) each slot's role and the important move/item/ability synergies;
3) key trade-offs visible in the chosen sets and how the flexible choices compensate.
Make every sentence specific to this exact team. Explain the delivered team rather than proposing
later replacements. Do not claim an evaluation or matchup result that is not in the input, and do
not use markdown.
"""


def _extract_json(text: str) -> dict | None:
    """Pull the first balanced JSON object out of a completion (models fence or preface
    JSON out of habit even when told not to)."""
    start = text.find("{")
    while start != -1:
        depth = 0
        in_str = False
        esc = False
        for i in range(start, len(text)):
            ch = text[i]
            if in_str:
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    in_str = False
            elif ch == '"':
                in_str = True
            elif ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    try:
                        doc = json.loads(text[start:i + 1])
                        return doc if isinstance(doc, dict) else None
                    except ValueError:
                        break
        start = text.find("{", start + 1)
    return None


_SP_KEYS = ("hp", "atk", "def", "spa", "spd", "spe")


def _clamp_sp(v: Any) -> int:
    """One spread value -> a clamped 0-32 int. Defensive like _spread_from_sps: a model that
    emits a non-numeric spread value ("max", a nested object) must degrade that stat to 0,
    not crash the whole build into a generic 'internal' failure (it should reach the parse-
    retry / legality gate instead)."""
    try:
        return max(0, min(32, int(v or 0)))
    except (TypeError, ValueError):
        return 0


def _clean_members(doc: dict) -> tuple[list[dict], str | None]:
    """Normalize the model's member list into team-json members (unknown fields dropped,
    spreads clamped). Returns (members, frame_id)."""
    members: list[dict] = []
    for raw in (doc.get("pokemon") or [])[:6]:
        if not isinstance(raw, dict) or not isinstance(raw.get("species"), str):
            continue
        spread = raw.get("spread") if isinstance(raw.get("spread"), dict) else {}
        moves = [m for m in (raw.get("moves") or []) if isinstance(m, str) and m][:4]
        members.append({
            "species": raw["species"].strip(),
            "item": raw["item"].strip() if isinstance(raw.get("item"), str) else None,
            "ability": raw["ability"].strip() if isinstance(raw.get("ability"), str) else None,
            "nature": raw["nature"].strip() if isinstance(raw.get("nature"), str) else None,
            "moves": moves,
            "spread": {k: _clamp_sp(spread.get(k)) for k in _SP_KEYS},
            "tera": None,
            "completeness": "inferred_set",
        })
    fid = doc.get("frame_id")
    return members, fid if isinstance(fid, str) and fid else None


def canonicalize_members(pool: Any, members: list[dict], deadline: float) -> None:
    """Snap the model's names to dex canonical via the resolver (one call per kind).
    Misses stay as-is — slate-evaluate's legality gate reports them and the repair round
    shows the model exactly what did not resolve."""
    buckets: dict[str, set[str]] = {"pokemon": set(), "item": set(), "ability": set(),
                                    "nature": set(), "move": set()}
    for m in members:
        buckets["pokemon"].add(m["species"])
        if m["item"]:
            buckets["item"].add(m["item"])
        if m["ability"]:
            buckets["ability"].add(m["ability"])
        if m["nature"]:
            buckets["nature"].add(m["nature"])
        buckets["move"].update(m["moves"])
    canon: dict[tuple[str, str], str] = {}
    for kind, names in buckets.items():
        pending = [n for n in names if n and not n.startswith("-")]
        if not pending:
            continue
        try:
            doc = pool.request_json(
                "dex", ["resolve", *pending[:100], "--format", "json", "--kind", kind],
                timeout=min(30.0, max(1.0, deadline - time.monotonic())))
        except Exception:
            continue
        for entry in doc if isinstance(doc, list) else []:
            if isinstance(entry, dict) and entry.get("ok") and entry.get("canonical"):
                canon[(kind, str(entry.get("query")))] = str(entry["canonical"])
    for m in members:
        m["species"] = canon.get(("pokemon", m["species"]), m["species"])
        if m["item"]:
            m["item"] = canon.get(("item", m["item"]), m["item"])
        if m["ability"]:
            m["ability"] = canon.get(("ability", m["ability"]), m["ability"])
        if m["nature"]:
            m["nature"] = canon.get(("nature", m["nature"]), m["nature"])
        m["moves"] = [canon.get(("move", mv), mv) for mv in m["moves"]]


class _Assembler:
    """Holds the conversation across generate + (at most one) repair, so the repair call
    reuses the same prefix (provider-side caching) and the model sees its own prior team."""

    def __init__(self, provider: LlmProvider, deadline: float):
        self.provider = provider
        self.deadline = deadline
        system_prompt = (BUILDER_THINKING_SYSTEM_PROMPT
                         if getattr(provider, "thinking_enabled", False)
                         else SYSTEM_PROMPT)
        self.messages: list[dict] = [{"role": "system", "content": system_prompt}]
        self.tokens = 0
        self.metrics = {"promptTokens": 0, "completionTokens": 0, "cacheHitTokens": 0,
                        "llmCalls": 0}

    def _chat(self) -> str:
        rem = self.deadline - time.monotonic()
        if rem <= 1:
            raise BuilderFailed("deadline", self.tokens)
        try:
            thinking = getattr(self.provider, "thinking_enabled", False)
            result: ChatResult = self.provider.chat(
                self.messages, [],
                max_tokens=(BUILDER_THINKING_MAX_TEAM_TOKENS
                            if thinking else BUILDER_MAX_TEAM_TOKENS),
                tool_choice="none",
                timeout=min(BUILDER_THINKING_LLM_TIMEOUT if thinking
                            else BUILDER_LLM_TIMEOUT, rem))
        except LlmUnavailable as e:
            e.tokens = self.tokens
            raise
        self.tokens += result.prompt_tokens + result.completion_tokens
        self.metrics["promptTokens"] += result.prompt_tokens
        self.metrics["completionTokens"] += result.completion_tokens
        self.metrics["cacheHitTokens"] += result.cache_hit_tokens
        self.metrics["llmCalls"] += 1
        content = str(result.message.get("content") or "")
        self.messages.append({"role": "assistant", "content": content})
        return content

    def ask(self, payload: dict) -> tuple[list[dict], str | None, str]:
        """One user turn -> normalized members (+ the model's own build rationale, "" when
        absent). A malformed completion gets ONE immediate re-ask (cheap parse retry,
        distinct from the semantic repair budget)."""
        self.messages.append(
            {"role": "user", "content": json.dumps(payload, ensure_ascii=False)})
        for attempt in (0, 1):
            doc = _extract_json(self._chat())
            if doc is not None:
                members, fid = _clean_members(doc)
                if len(members) == 6:
                    rationale = doc.get("rationale")
                    return members, fid, (rationale.strip()
                                          if isinstance(rationale, str) else "")
            if attempt == 0:
                self.messages.append({"role": "user", "content":
                                      "Invalid output. Reply with ONLY the strict JSON "
                                      "object: {\"frame_id\": ..., \"pokemon\": [6 members], "
                                      "\"rationale\": \"...\"}."})
        raise BuilderFailed("generation_failed", self.tokens)

    def refresh_rationale(self, members: list[dict], language: str,
                          fixes: list[str]) -> str:
        """Rewrite prose after deterministic set changes without letting it mutate the team.

        This is not a semantic repair attempt: the already-sanitized team is immutable input
        and the only accepted output field is ``rationale``. Any malformed or visibly stale
        result degrades to no rationale instead of showing advice for the pre-fix set.
        """
        thinking = getattr(self.provider, "thinking_enabled", False)
        length_profile = (
            "3 short plain-text paragraphs separated by blank lines, 7-10 sentences total"
            if thinking else "3-5 sentences")
        self.messages.append({"role": "user", "content": json.dumps({
            "final_team": members,
            "deterministic_fixes": fixes,
            "output_language": language,
            "instruction": (
                "The deterministic validator changed the team after your draft. Describe ONLY "
                f"this exact final_team in {length_profile}. Do not change any set and do not "
                "describe a removed item, ability, move, or its tactical effect. For example, "
                "a member moved off Choice Scarf is not a scarf speed-control user. Reply with "
                "strict JSON only: {\"rationale\": \"...\"}. Keep every Pokemon/move/item/"
                "ability name in ENGLISH CANONICAL form; write the surrounding prose in "
                "output_language."
            ),
        }, ensure_ascii=False)})
        doc = _extract_json(self._chat())
        rationale = doc.get("rationale") if isinstance(doc, dict) else None
        if not isinstance(rationale, str) or not rationale.strip():
            return ""
        rationale = rationale.strip()
        # Reject the clearest stale shape even if the model ignored the explicit instruction:
        # the changed member and its removed canonical entity in the same sentence.
        sentences = [s for s in re.split(r"[.!?。！？]", rationale) if s]
        for fix in fixes:
            match = re.match(r"^(.+?): (?:item|ability) (.+?) -> .+? \(", fix)
            removed = [match.group(2)] if match else []
            if not match:
                match = re.match(r"^(.+?): moves (.+?) dropped \(", fix)
                removed = match.group(2).split(", ") if match else []
            if match and any(
                    match.group(1) in sentence
                    and any(entity in sentence for entity in removed)
                    for sentence in sentences):
                return ""
        return rationale


# Two build-aware filler tables (design §7.4). Both are permutations of the SAME
# pool-verified item set, so for any team up to 6 a free option always exists and
# the member's lean only decides ORDER. Offense-flavored items (Life Orb, Choice
# Scarf) sit last in the defensive table and vice-versa, so a wall never gets a
# Life Orb whose recoil bleeds its bulk (user-reported) and an attacker never gets
# Leftovers as an early pick. The type-specific "nice to have" fillers (a STAB
# type-boost item, a weakness-resist berry) are intentionally dropped: they need
# per-species type/weakness resolution — too costly for a legality filler, and five
# generic picks per lean are enough. Rocky Helmet is NOT in the Champions item pool
# (verified against the dex) — do not add it back.
_OFFENSIVE_FILLERS = ["Life Orb", "Choice Scarf", "Focus Sash", "Lum Berry", "Sitrus Berry", "Leftovers"]
_DEFENSIVE_FILLERS = ["Sitrus Berry", "Leftovers", "Lum Berry", "Focus Sash", "Choice Scarf", "Life Orb"]
_OFFENSIVE_FLAVOR = {"Life Orb", "Choice Scarf"}     # in a collision, keep on the attacker
_DEFENSIVE_FLAVOR = {"Leftovers", "Sitrus Berry"}    # in a collision, keep on the wall


def _is_offensive(member: dict) -> bool:
    sp = member.get("spread") or {}
    return (sp.get("atk") or 0) + (sp.get("spa") or 0) >= 32


def _filler_order(member: dict) -> list[str]:
    """The filler table matching the member's build lean (see the two tables above)."""
    return _OFFENSIVE_FILLERS if _is_offensive(member) else _DEFENSIVE_FILLERS


def _item_suits(item: str, member: dict) -> bool:
    """Whether `item` matches the member's lean — decides which side of an Item Clause
    collision keeps the item (the one it suits) and which one swaps to a filler."""
    if item in _OFFENSIVE_FLAVOR:
        return _is_offensive(member)
    if item in _DEFENSIVE_FLAVOR:
        return not _is_offensive(member)
    return True                              # neutral filler suits either lean


def sanitize_members(pool: Any, members: list[dict], deadline: float) -> list[str]:
    """Deterministic legality pre-fix after canonicalize: illegal ability -> the species'
    legal list, wrong/out-of-pool item -> required stone or a safe pool item, learnset-
    illegal moves dropped when legal ones remain. Keeps the single LLM repair round for
    semantic problems instead of main-series-memory slips (design §7.4). Returns
    disclosure strings for the progress detail."""
    fixes: list[str] = []
    species = sorted({m["species"] for m in members if m.get("species")})
    facts: dict[str, dict] = {}
    try:
        doc = pool.request_json(
            "dex", ["batch", "pokemon", *species[:12], "--format", "json"],
            timeout=min(30.0, max(1.0, deadline - time.monotonic())))
        for e in doc if isinstance(doc, list) else []:
            if isinstance(e, dict) and e.get("name"):
                facts[str(e["name"])] = e
    except Exception:
        return fixes            # no dex facts -> let the legality gate speak
    items = sorted({m["item"] for m in members if m.get("item")})
    legal_items: set[str] = set()
    if items:
        try:
            doc = pool.request_json(
                "dex", ["resolve", *items[:12], "--format", "json", "--kind", "item"],
                timeout=min(30.0, max(1.0, deadline - time.monotonic())))
            for e in doc if isinstance(doc, list) else []:
                if isinstance(e, dict) and e.get("ok") and e.get("canonical"):
                    legal_items.add(str(e["canonical"]))
        except Exception:
            legal_items = set(items)    # can't verify -> don't touch
    held = {m["item"] for m in members if m.get("item")}
    for m in members:
        f = facts.get(m.get("species") or "")
        if not f:
            continue
        legal_abilities = [a for a in (f.get("abilities") or []) if a]
        if legal_abilities and m.get("ability") not in legal_abilities:
            fixes.append(f"{m['species']}: ability {m.get('ability')} -> "
                         f"{legal_abilities[0]} (not a legal ability)")
            m["ability"] = legal_abilities[0]
        required = f.get("required_item")
        if required and m.get("item") != required:
            fixes.append(f"{m['species']}: item {m.get('item')} -> {required} "
                         "(Mega stone required)")
            held.discard(m.get("item") or "")
            m["item"] = required
            held.add(required)
        elif m.get("item") and m["item"] not in legal_items:
            bad = m["item"]
            pick = next((it for it in _filler_order(m) if it not in held), None)
            if pick:
                fixes.append(f"{m['species']}: item {bad} -> {pick} "
                             "(not in the Champions item pool)")
                held.discard(bad)
                m["item"] = pick
                held.add(pick)
        learnset = set(f.get("moves") or [])
        if learnset and m.get("moves"):
            legal_moves = [mv for mv in m["moves"] if mv in learnset]
            if legal_moves and len(legal_moves) < len(m["moves"]):
                dropped = [mv for mv in m["moves"] if mv not in learnset]
                fixes.append(f"{m['species']}: moves {', '.join(dropped)} dropped "
                             "(not in its Champions learnset)")
                m["moves"] = legal_moves
    # Item Clause with build-aware, two-sided resolution. Each item may appear once.
    # A member holding ITS OWN required Mega stone is exempt: per-species and unique, never
    # swapped. A member holding a DIFFERENT species' stone always swaps (only the owner may
    # carry it) — else an earlier wrong holder shadows the real holder and strips its stone,
    # or, sorting first, leaves BOTH on the same unique stone (audit 2026-07-16).
    # For a plain-item collision BOTH holders are weighed: the member the item suits keeps it
    # and the OTHER swaps (not "first wins" — that let an attacker grab a wall's Leftovers).
    # `taken` is seeded with every final item up front, so a swap can never re-collide with a
    # member processed later — the "Leftovers duplicated again" report.
    required_stones = {f.get("required_item") for f in facts.values() if f.get("required_item")}

    def _own_stone(m: dict) -> str | None:
        own = (facts.get(m.get("species") or "") or {}).get("required_item")
        return own if own and m.get("item") == own else None

    holders: dict[str, list[int]] = {}
    for i, m in enumerate(members):
        it = m.get("item")
        if it and not _own_stone(m) and it not in required_stones:
            holders.setdefault(it, []).append(i)     # plain-item holders, grouped by item
    keeper = {it: next((i for i in idxs if _item_suits(it, members[i])), idxs[0])
              for it, idxs in holders.items()}
    taken = {m.get("item") for m in members if _own_stone(m)} | set(holders)
    for i, m in enumerate(members):
        it = m.get("item")
        if not it or _own_stone(m):
            continue
        foreign_stone = it in required_stones
        if not foreign_stone and keeper.get(it) == i:
            continue                                 # this holder is the one that keeps the item
        pick = next((x for x in _filler_order(m) if x not in taken), None)
        if pick:
            why = "Mega stone of another species" if foreign_stone else "Item Clause duplicate"
            fixes.append(f"{m['species']}: item {it} -> {pick} ({why})")
            m["item"] = pick
            taken.add(pick)
    return fixes


# -- slate / audit problem extraction ------------------------------------------------------


def _slate_problems(slate_out: dict) -> dict | None:
    """None when candidate 0 survived with a valid legality verdict; otherwise a clipped,
    model-facing problem document for the repair round."""
    cands = slate_out.get("candidates") or []
    cand = cands[0] if cands and isinstance(cands[0], dict) else {}
    legality = cand.get("legality") or {}
    survived = 0 in (slate_out.get("survivors") or [])
    if survived and legality.get("status") == "valid":
        return None
    return {
        "legality_errors": legality.get("errors") or [],
        "legality_status": legality.get("status"),
        "funnel_flags": cand.get("funnel_flags") or [],
        "mega_registration": cand.get("mega_registration_assessment"),
    }


def _audit_problems(audit_out: dict) -> dict | None:
    if audit_out.get("pass") is True:
        return None
    return {"audit_violations": audit_out.get("violations") or []}


# -- draft ---------------------------------------------------------------------------------


THREAT_GRADING_METHOD = "guaranteed-ohko-impact-v1"
THREAT_ORDERING = [
    "affected_member_count_desc",
    "usage_rank_asc",
    "route_count_desc",
    "opponent_name_asc",
]


def _threat_grade(affected: int) -> str:
    """Factual breadth band, not a strength score: G3=3+ members, G2=2, G1=1."""
    return "G3" if affected >= 3 else "G2" if affected == 2 else "G1"


def grade_matchup_threats(mr: dict, team_size: int = 6) -> dict:
    """Grade every guaranteed-OHKO fact with a reconstructible lexicographic rule.

    The battery supplies retained observed variants only. We never synthesize a worst set and never
    combine the dimensions into a numeric score. Every tie-break field and every source route remains
    public in the DTO, so `worst` can be reconstructed from `opponents`.
    """
    top_k = int(mr.get("top_k") or BUILDER_TOP_K)
    raw = mr.get("opponents_with_guaranteed_ohko_on_us") or {}
    rows = []
    if isinstance(raw, dict):
        for opponent, raw_routes in raw.items():
            if not isinstance(opponent, str) or not isinstance(raw_routes, list):
                continue
            routes = []
            for fact in raw_routes:
                if (not isinstance(fact, dict) or not fact.get("member") or not fact.get("move")
                        or not fact.get("evidence_id")):
                    continue
                route = {
                    "member": str(fact["member"]),
                    "move": str(fact["move"]),
                    "evidenceId": str(fact["evidence_id"]),
                    "usageRank": (int(fact["meta_position"])
                                  if isinstance(fact.get("meta_position"), int) else None),
                    "opponentVariant": fact.get("opponent_variant"),
                    "opponentIsModal": (bool(fact["opponent_is_modal"])
                                        if fact.get("opponent_is_modal") is not None else None),
                }
                routes.append(route)
            if not routes:
                continue
            routes.sort(key=lambda r: (
                r["member"].casefold(), str(r.get("opponentVariant") or ""),
                r["move"].casefold(), r["evidenceId"]))
            affected_members = sorted({r["member"] for r in routes}, key=str.casefold)
            usage_ranks = [r["usageRank"] for r in routes if r["usageRank"] is not None]
            variants = {r["opponentVariant"] for r in routes if r["opponentVariant"]}
            rows.append({
                "opponent": opponent,
                "grade": _threat_grade(len(affected_members)),
                "affectedMembers": affected_members,
                "affectedMemberCount": len(affected_members),
                "usageRank": min(usage_ranks) if usage_ranks else None,
                "routeCount": len(routes),
                "variantCount": len(variants) if variants else 1,
                "routes": routes,
            })
    rows.sort(key=lambda row: (
        -row["affectedMemberCount"],
        row["usageRank"] if row["usageRank"] is not None else 10 ** 9,
        -row["routeCount"],
        row["opponent"].casefold(),
    ))
    worst = None
    if rows:
        first = rows[0]
        worst = {
            "opponent": first["opponent"],
            "grade": first["grade"],
            "basis": {
                "affectedMemberCount": first["affectedMemberCount"],
                "teamSize": team_size,
                "usageRank": first["usageRank"],
                "routeCount": first["routeCount"],
            },
        }
    return {
        "method": THREAT_GRADING_METHOD,
        "ordering": THREAT_ORDERING,
        "scope": {"topK": top_k, "teamSize": team_size,
                  "variantBasis": "retained_observed_variants"},
        "worst": worst,
        "opponents": rows,
    }


def _worst_matchup_fact(mr: dict) -> str:
    """One transparent sentence from the public threat assessment."""
    assessment = grade_matchup_threats(mr)
    worst = assessment["worst"]
    if worst:
        basis = worst["basis"]
        rank = f", usage rank {basis['usageRank']}" if basis["usageRank"] is not None else ""
        return (f"{worst['opponent']} is the lexicographic worst guaranteed-OHKO threat "
                f"({worst['grade']}: {basis['affectedMemberCount']}/{basis['teamSize']} members"
                f"{rank}, {basis['routeCount']} verified routes; method {THREAT_GRADING_METHOD})")
    top_k = assessment["scope"]["topK"]
    return (f"no guaranteed OHKO threat surfaced within the top-{top_k} battery; "
            "matchups outside that scope are unverified")


def _mega_option_names(plan: dict) -> str:
    names = []
    for opt in plan.get("mega_options") or []:
        if isinstance(opt, dict):
            names.append(str(opt.get("species") or opt.get("member") or opt.get("stone")))
        else:
            names.append(str(opt))
    return ", ".join(n for n in names if n) or "the assembled Mega holders"


def _fill_draft(skeleton: dict, assumptions: list[str], slate_out: dict) -> dict:
    """Complete the draft-init skeleton with the wizard's profile facts. Everything here is
    DETERMINISTIC — the orchestrator stands in for the agent (design §13) by filling the
    honesty scaffold from slate facts, never by inventing judgment: trade-offs, worst
    matchups and provenance sentences all quote the battery/overlap facts; the wizard makes
    NO numeric claims (claims stay empty — nothing to recompute) and the onboarding summary
    lists all nine IDs (form controls + disclosed profile defaults)."""
    draft = json.loads(json.dumps(skeleton))    # deep copy — never mutate the op result
    draft["single_team_requested"] = True
    draft["assumptions"] = [ASSUMPTION_TEXT[k] for k in assumptions]
    # P4.5 transparency gate: every off-frame/off-meta pick the frame binding flagged must
    # be NAMED in the draft's disclosure pool (the gate is transparency, not a veto) — a
    # user-locked off-meta anchor otherwise fails answer-audit (benchmark 2026-07-16).
    fb = (slate_out.get("candidates") or [{}])[0].get("frame_binding")
    fb = fb if isinstance(fb, dict) else {}
    flagged = [d.get("species") for d in (fb.get("deviations") or []) if isinstance(d, dict)]
    flagged += [a.get("species") for a in (fb.get("advisories") or []) if isinstance(a, dict)]
    if flagged:
        draft["frame_deviations"] = [
            f"{sp}: off-frame pick made deliberately (user anchor or usage-grounded fill; "
            "wizard profile disclosure)"
            for sp in dict.fromkeys(sp for sp in flagged if sp)]
    draft["claims"] = []
    draft["context_summary"] = ("web wizard build: structured form constraints with "
                                "disclosed profile defaults; single final team requested")
    draft["onboarding_summary"] = {
        "status": "completed",
        "answered": list(ONBOARDING_ANSWERED),
        "note": "web wizard: explicit form controls (format, anchor, posture, availability)"
                " + disclosed profile defaults for the remaining dimensions",
    }
    if isinstance(draft.get("tuning_summary"), dict) \
            and draft["tuning_summary"].get("status") == "not_run":
        draft["tuning_summary"]["reason"] = ("wizard profile: no extra numeric requirements"
                                             " were given, so precise tuning was not run "
                                             "(disclosed on the result page)")
    candidates = slate_out.get("candidates") if isinstance(
        slate_out.get("candidates"), list) else []

    def _cand(idx: Any) -> dict:
        c = candidates[idx] if isinstance(idx, int) and 0 <= idx < len(candidates) else {}
        return c if isinstance(c, dict) else {}

    for rec in draft.get("recommended") or []:
        if not isinstance(rec, dict):
            continue
        cand = _cand(rec.get("slate_index"))
        mr = cand.get("matchup_risk") if isinstance(cand.get("matchup_risk"), dict) else {}
        rec["tradeoffs"] = [
            f"worst matchup: {_worst_matchup_fact(mr)}",
            f"pressure-tested against the top-{mr.get('top_k') or BUILDER_TOP_K} meta only "
            "— the wizard's check scope is limited and disclosed",
        ]
        plan = cand.get("mega_plan") if isinstance(cand.get("mega_plan"), dict) else {}
        if "mega_registration_rationale" in rec:
            rec["mega_registration_rationale"] = {
                "primary": f"registered Mega options follow the assembled sets: "
                           f"{_mega_option_names(plan)}",
                "alternative_plan": "the second registered Mega is the in-match fallback "
                                    "when the primary's matchup is unfavorable",
                "opportunity_cost": "each registered Mega binds its holder's item slot to "
                                    "the stone",
            }
        if "mega_registration_deviation" in rec:
            assess = cand.get("mega_registration_assessment") \
                if isinstance(cand.get("mega_registration_assessment"), dict) else {}
            rec["mega_registration_deviation"] = {
                "reason": "the wizard adopted the generated registration as-is",
                "evidence": f"slate mega assessment: {prune(assess, list_cap=4, str_cap=200)}",
                "opportunity_cost": "deviating from the observed registration norm gives up "
                                    "its sample-backed track record",
            }
        overlap = cand.get("library_overlap") \
            if isinstance(cand.get("library_overlap"), dict) else {}
        if "observed_provenance" in rec:
            rec["observed_provenance"] = (
                "assembled from current-season usage data; overlaps stored observed "
                f"team(s) {overlap.get('verbatim_ids') or overlap.get('species_ids') or []}"
                " — the overlap is disclosed, adopted because the slate facts fit the "
                "requested profile")
        if "adoption_review" in rec:
            rec["adoption_review"] = {
                "status": "accepted_as_is",
                "checked_modification_types": ["item", "moves", "spread"],
                "attempted_changes": [],
                "reason": "the usage-grounded set matched an observed team verbatim; the "
                          "wizard adopts proven joint sets rather than perturbing them "
                          "without a benchmark reason",
                "evidence": f"slate battery: {_worst_matchup_fact(mr)}; legality "
                            f"{(cand.get('legality') or {}).get('status', 'unknown')}",
            }
    if isinstance(draft.get("convergence_rationale"), dict):
        for key, entry in draft["convergence_rationale"].items():
            if not isinstance(entry, dict):
                continue
            try:
                mr = _cand(int(key)).get("matchup_risk") or {}
            except (TypeError, ValueError):
                mr = {}
            entry["worst_matchup"] = _worst_matchup_fact(mr if isinstance(mr, dict) else {})
            entry["accepted_by_constraint"] = (
                "single-candidate wizard profile: the one assembled candidate — the user "
                "explicitly requested one final team via the form")
            entry["opportunity_cost"] = (
                "no alternative candidates were assembled to compare against "
                "(wizard scope, disclosed)")
    return draft


# -- pipeline ------------------------------------------------------------------------------


def build(pool: Any, provider: LlmProvider, form: BuilderForm,
          progress: Callable[[str, str, dict | None], None]) -> dict:
    """Run the full wizard pipeline. Returns {"team", "legality", "audit", "assumptions",
    "repaired", "tokens", ...metrics}; raises BuilderFailed / LlmUnavailable with the spend
    attached. `progress(gate, status, detail)` mirrors the jobs.GATES timeline; `detail`
    is each gate's disclosure-trimmed fact summary (species names in English canonical —
    the SPA localizes; never a full frame/slate artifact, §7.1 boundary)."""
    deadline = time.monotonic() + BUILDER_DEADLINE_SECONDS
    ctx, assumptions = make_context(form)

    # Gate 1: context-audit (front gate) + intake done:true verification, one batch.
    progress("context", "running", None)
    batch = _team_session(pool, [
        {"op": "context-audit", "context": ctx},
        {"op": "intake", "format": form.format, "next": True, "context": ctx,
         "answered": list(ONBOARDING_ANSWERED)},
    ], deadline)
    audit_ctx = _op_result(batch[0])
    intake_out = _op_result(batch[1])
    receipt = audit_ctx.get("audit_receipt")
    gaps = [g for g in (audit_ctx.get("gaps") or []) if isinstance(g, dict)]
    blocking = [g for g in gaps if g.get("level") == "blocking"]
    if not isinstance(receipt, dict) or intake_out.get("done") is not True or blocking:
        # The form guarantees coverage; failing here means catalog/contract drift — a
        # server-side condition, never the visitor's fault.
        raise BuilderFailed("internal")
    progress("context", "done", {
        "safeDefaults": len([g for g in gaps if g.get("level") == "safe_default"]),
        "conflicts": len([g for g in gaps if g.get("level") == "conflict"]),
    })

    # Gate 2: frame (assembly front-door) — repset-grounded skeletons.
    progress("frame", "running", None)
    frame_out = _op_result(_team_session(pool, [
        {"op": "frame", "format": form.format, "context": ctx, "audit_receipt": audit_ctx},
    ], deadline)[0])
    skeletons = [s for s in (frame_out.get("skeletons") or []) if isinstance(s, dict)]
    if not skeletons:
        raise BuilderFailed("no_frame")     # constraints too tight for any grounded frame
    core_names: list[str] = []
    for sk in skeletons:
        for cand in (sk.get("core_candidates") or []):
            name = cand.get("species") if isinstance(cand, dict) else None
            if isinstance(name, str) and name and name not in core_names:
                core_names.append(name)
    progress("frame", "done", {"skeletons": len(skeletons), "coreSpecies": core_names[:8]},
             {"skeletons": [strip_provenance(prune(sk, **PRUNE_SKELETON))
                            for sk in skeletons[:6]]})

    # Grounding: ranking + usage details for the species the skeletons propose.
    progress("ground", "running", None)
    grounding = _ground(pool, form, skeletons, deadline)
    progress("ground", "done", {
        "detailSpecies": list(grounding["usage_details"].keys()),
        "megaOptions": [str(o.get("species")) for o in grounding["mega_options"]],
    }, strip_provenance({
        # exactly what the assemble prompt will see (already pruned) — "what the AI read"
        "usageDetails": grounding["usage_details"],
        "megaOptions": grounding["mega_options"],
        **({"anchorDexFacts": grounding["anchor_dex_facts"]}
           if grounding.get("anchor_dex_facts") else {}),
    }))

    # Assemble (LLM, one candidate) + evaluate/audit with a shared single-repair budget.
    progress("generate", "running", None)
    assembler = _Assembler(provider, deadline)
    known_ids = {s.get("frame_id") for s in skeletons}
    payload = {
        "constraints": ctx,
        "skeletons": [prune(s, **PRUNE_SKELETON) for s in skeletons[:3]],
        "usage_details": grounding["usage_details"],
        "mega_options": grounding["mega_options"],
        "instruction": "Assemble ONE team for these constraints.",
    }
    if grounding.get("anchor_dex_facts"):
        payload["anchor_dex_facts"] = grounding["anchor_dex_facts"]
    payload["output_language"] = form.lang
    members, frame_id, rationale = assembler.ask(payload)
    canonicalize_members(pool, members, deadline)
    fixes = sanitize_members(pool, members, deadline)
    if fixes and rationale:
        try:
            rationale = assembler.refresh_rationale(members, form.lang, fixes)
        except (BuilderFailed, LlmUnavailable):
            rationale = ""
    progress("generate", "done", {"team": [m["species"] for m in members],
                                  **({"fixes": fixes} if fixes else {})},
             {"team": members, **({"fixes": fixes} if fixes else {})})

    repairs = 0
    while True:
        if frame_id not in known_ids:
            frame_id = skeletons[0].get("frame_id")
        team_json = {"schema_version": 1, "format": form.format, "season": None,
                     "rule": None, "pokemon": members, "provenance": None}
        skeleton_species = {c.get("species")
                            for s in skeletons if s.get("frame_id") == frame_id
                            for c in (s.get("core_candidates") or [])}
        binding = {
            "frame_id": frame_id,
            "off_meta": [],
            "off_meta_build": False,
            "deviations": [{"species": m["species"],
                            "reason": "assembled from current-season usage details"}
                           for m in members if m["species"] not in skeleton_species],
        }
        # The slate gate wants the BARE receipt object (it reads .fingerprint directly);
        # the frame op above took the full context-audit output. Both bind the same chain.
        slate_doc = {"context": ctx, "audit_receipt": receipt,
                     "teams": [team_json], "frame_bindings": [binding]}

        progress("evaluate", "running", None)
        slate_out = _op_result(_team_session(pool, [
            {"op": "slate-evaluate", "file": slate_doc, "top_k": BUILDER_TOP_K,
             "frame_output": frame_out},
        ], deadline)[0])
        problems = _slate_problems(slate_out)
        fail_code = "generation_failed"

        audit_out: dict | None = None
        checkpoint_out: dict | None = None
        if problems is None:
            slate_cand = (slate_out.get("candidates") or [{}])[0]
            progress("evaluate", "done", {
                "legality": str((slate_cand.get("legality") or {}).get("status") or ""),
                "megaCount": int((slate_cand.get("mega_plan") or {})
                                 .get("registered_mega_count") or 0),
            }, strip_provenance(prune({
                "legality": slate_cand.get("legality"),
                "megaRegistration": slate_cand.get("mega_registration_assessment"),
                "matchupRisk": slate_cand.get("matchup_risk"),
                "funnelFlags": slate_cand.get("funnel_flags"),
            }, list_cap=8, str_cap=240)))
            progress("audit", "running", None)
            # checkpoint (direct_final constant — records open decisions, never pauses the
            # wizard) + the draft skeleton, one batch; then the back gate.
            batch = _team_session(pool, [
                {"op": "checkpoint", "file": slate_out, "slate": slate_doc},
                {"op": "draft-init", "slate": slate_doc, "slate_output": slate_out,
                 "recommended": [0]},
            ], deadline)
            checkpoint_out = _op_result(batch[0], allow_rc=(0, 2))
            draft_skeleton = _op_result(batch[1]).get("draft")
            if not isinstance(draft_skeleton, dict):
                raise BuilderFailed("internal", assembler.tokens)
            draft = _fill_draft(draft_skeleton, assumptions, slate_out)
            audit_out = _op_result(_team_session(pool, [
                {"op": "answer-audit", "file": draft, "slate": slate_doc,
                 "slate_output": slate_out},
            ], deadline)[0])
            problems = _audit_problems(audit_out)
            fail_code = "audit_failed"
            if problems is None:
                progress("audit", "done", None,
                         {"checked": audit_out.get("checked") or {},
                          "violations": []})
                cand = (slate_out.get("candidates") or [{}])[0]
                legality = cand.get("legality") or {}
                # The proposed set began as an inference, but after deterministic legality,
                # slate and answer-audit pass it is now the concrete validated configuration
                # delivered to the user. Diagnose must count its exact moves/items instead of
                # treating the hand-off as six species-only guesses.
                for member in members:
                    if member.get("completeness") == "inferred_set":
                        member["completeness"] = "extracted_set"
                # Structured worst-matchup coordinates (battery fact): the result page
                # deep-links them into the damage calculator (design §13 calc hand-off).
                mr = cand.get("matchup_risk") if isinstance(
                    cand.get("matchup_risk"), dict) else {}
                team_size = len([m for m in members if m.get("species")])
                threat_assessment = grade_matchup_threats(mr, team_size=team_size)
                threat_rows = [
                    {"opponent": row["opponent"], "member": route["member"],
                     "move": route["move"]}
                    for row in threat_assessment["opponents"] for route in row["routes"]
                ]
                worst = None
                if threat_assessment["worst"]:
                    worst_row = threat_assessment["opponents"][0]
                    route = worst_row["routes"][0]
                    worst = {"opponent": worst_row["opponent"],
                             "member": route["member"], "move": route["move"]}
                return {
                    "team": team_json,
                    # Disclosure-safe extras (§7.1: counting facts + the model's OWN prose;
                    # never joint sets / frame / slate artifacts): the assembler's build
                    # rationale, the full guaranteed-OHKO threat list, the mega count.
                    **({"rationale": rationale} if rationale else {}),
                    "threats": threat_rows[:5],
                    "matchupThreats": threat_assessment,
                    "megaCount": int((cand.get("mega_plan") or {})
                                     .get("registered_mega_count") or 0),
                    "legality": {"status": str(legality.get("status") or "valid"),
                                 "confidence": legality.get("confidence")},
                    "worstMatchup": worst,
                    "audit": {"pass": True,
                              "checked": audit_out.get("checked") or {}},
                    "checkpointDecisions": len((checkpoint_out or {}).get(
                        "open_decisions") or []),
                    "assumptions": assumptions,
                    "slateTopK": BUILDER_TOP_K,
                    "repaired": repairs > 0,
                    "tokens": assembler.tokens,
                    **assembler.metrics,
                }

        # One shared LLM repair across slate + audit failures (§7.4).
        if repairs >= BUILDER_MAX_REPAIRS:
            # journalctl-visible post-mortem: WHAT failed, not just that it failed
            print(f"builder {fail_code}: team={[m.get('species') for m in members]} "
                  f"problems={json.dumps(prune(problems, **PRUNE_PROBLEMS), ensure_ascii=False)[:800]}",
                  file=sys.stderr, flush=True)
            raise BuilderFailed(fail_code, assembler.tokens)
        repairs += 1
        progress("evaluate", "running", None)
        members, frame_id, rationale = assembler.ask({
            "problems": prune(problems, **PRUNE_PROBLEMS),
            "instruction": "Your previous team FAILED these deterministic checks. Fix every "
                           "listed problem and return the full corrected team — resubmitting "
                           "an unchanged team is a failure; every member named in the "
                           "problems MUST change accordingly, using only input data.",
        })
        canonicalize_members(pool, members, deadline)
        fixes = sanitize_members(pool, members, deadline)
        if fixes and rationale:
            try:
                rationale = assembler.refresh_rationale(members, form.lang, fixes)
            except (BuilderFailed, LlmUnavailable):
                rationale = ""
        progress("generate", "done", {"team": [m["species"] for m in members],
                                      **({"fixes": fixes} if fixes else {})},
                 {"team": members, **({"fixes": fixes} if fixes else {})})
