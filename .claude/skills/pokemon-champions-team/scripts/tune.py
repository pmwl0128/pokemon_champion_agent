#!/usr/bin/env python
"""tune operator: SP fine-tuning as cliff detection.

First version: survival cliffs (via ncp) and speed cliffs (pure closed form, joined to a KO check).
The threat *targets* come from explicit `build-context.benchmarks`; each target's attacker *set*
(ability / item / nature / spread) is the meta MODAL set (so Huge Power etc. is never silently
dropped), with a synthetic max-offense fallback flagged low-confidence when meta has no data.
Auto-discovering the threat LIST from meta top-K is still a later increment. Output is ranked cliff
cards (facts + minimum SP), never a single "optimal spread".

All external lookups are injected (damage_fn / move_fn / dex_fn / meta_fn) so the logic is
unit-testable without the sibling skills; defaults wire to ncplink + dexlink + metalink.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cliffs import (  # noqa: E402
    SP_CAP, champ_speed, solve_outspeed, solve_min_sp, survival_prob, meets_target, ko_roll,
    defensive_headroom, rank_cards, candidate_natures, weather_speed_mult, effective_speed,
)
from context_profile import get_profile  # noqa: E402
from typechart import effectiveness  # noqa: E402
from rules import get_ruleset  # noqa: E402
from diagnose import _stat_orientation  # noqa: E402  (reuse the base-stat offense lean)
from mega import mega_form_from_maps  # noqa: E402
from battle_effects import INTIMIDATE_BLOCKING_ITEMS, INTIMIDATE_NO_RELIEF_ABILITIES  # noqa: E402
import completeness  # noqa: E402
import team_i18n as i18n  # noqa: E402

SP_TOTAL_CAP = get_ruleset().sp_total_cap   # centralized registration constant (rules.py)
SPREAD_TO_SPS = {"hp": "hp", "atk": "at", "def": "df", "spa": "sa", "spd": "sd", "spe": "sp"}
DEF_SPS = {"physical": "df", "special": "sd"}        # which defensive stat a move pressures
DEF_SPREAD = {"physical": "def", "special": "spd"}   # the same stat as a team-json spread key
# Special-category moves that deal damage against the PHYSICAL defense (Def), not SpD. Category alone
# picks the wrong defensive stat for these, so survival tuning would invest SpD and never move the
# cliff (audit 2026-06-24). The ncp calc already models the damage correctly; this only steers which
# stat the SP search varies.
PHYS_DEF_SPECIAL_MOVES = {"Psyshock", "Psystrike", "Secret Sword"}
# Moves whose damage depends on the defender's current/max HP (or is otherwise not flat per hit), so
# the HP lane's "incoming damage is HP-independent" reuse is invalid — adding HP doesn't create a
# normal survival cliff against them (audit 2026-06-24). Fixed-damage moves (Night Shade/Seismic Toss)
# are HP-independent and stay fine; only HP-proportional ones are excluded here.
# Damage scales with the DEFENDER's HP (so adding HP doesn't form a normal survival cliff). NOTE:
# Final Gambit is NOT here — it deals the ATTACKER's current HP, independent of the defender's, so the
# defender's HP lane is valid (audit 2026-06-24). Endeavor stays: it sets the target to the attacker's
# HP, i.e. damage = defender_HP - attacker_HP, which does scale with the defender's HP.
HP_DEPENDENT_MOVES = {"Super Fang", "Ruination", "Nature's Madness", "Guardian of Alola", "Endeavor"}
OFF_SPS = {"physical": "at", "special": "sa"}
OFF_SPREAD = {"physical": "atk", "special": "spa"}    # offensive stat as a team-json spread key
OFF_NATURE = {"physical": "Adamant", "special": "Modest"}
KILL_HITS = {"ohko": 1, "2hko": 2}                    # benchmark kind -> hits the KO needs
NATURE_LANE_MIN_SAVINGS = 8   # §16.8 importance gate: a nature lane surfaces only if it unlocks an
                              # unreachable/infeasible cliff OR frees at least this many SP

# --- Mega form + ability special-judgment (design §9, re-audit 2026-07-07) -----------------
# A Mega-stone holder is computed as its MEGA form (Mega stats / typing / ability) everywhere — the
# defender we survive on, the attacker we KO with, the speed base. A few abilities act at switch-in
# (BEFORE Mega Evolution) or otherwise describe the pre-Mega form, so the special checks below consider
# BOTH the base (pre-Mega) ability AND the Mega ability — EITHER present counts. A base ability read
# from a meta usage distribution counts only when it is run at >= this share; a member's OWN base
# ability comes from the team-json (the player's declared choice) and needs no usage gate.
SPECIAL_BASE_ABILITY_USAGE_FLOOR = 20.0

# Back-compatible public name; the shared constant mirrors the calculator's Intimidate handler.
INTIMIDATE_IMMUNE_ABILITIES = INTIMIDATE_NO_RELIEF_ABILITIES

# Opponent Choice Scarf is modelled as a faster speed target when it is a TOP-N meta item at > this
# usage (a rank-2/3 item at ~0.3% is noise, not a threat). Single source in metalink so tune's speed
# advice and matchup's check scarf lane agree on the threshold (re-audit 2026-07-07).
from metalink import OPPONENT_SCARF_TOP_N, OPPONENT_SCARF_USAGE_FLOOR  # noqa: E402


def _ability_key(ability: Any) -> str:
    return str(ability or "").strip().casefold()


def _memoized_batch_lookup(fn: Callable | None) -> Callable | None:
    """Cache a sibling batch lookup for the duration of one tune() call."""
    if fn is None:
        return None
    cache: dict[Any, dict[str, Any]] = {}

    def wrapped(names: list[str]) -> dict[str, Any]:
        req = [n for n in (names or []) if n is not None]
        missing = [n for n in req if n not in cache]
        if missing:
            got = fn(missing) or {}
            for n in missing:
                cache[n] = got.get(n, {}) or {}
        return {n: cache.get(n, {}) for n in req}

    return wrapped


def _memoized_meta_lookup(fn: Callable | None) -> Callable | None:
    if fn is None:
        return None
    cache: dict[tuple[str | None, str | None], dict[str, Any] | None] = {}

    def wrapped(species: str | None, fmt: str | None) -> dict[str, Any] | None:
        key = (species, fmt)
        if key not in cache:
            cache[key] = fn(species, fmt)
        return cache[key]

    return wrapped


def _dex_facts(name: str | None, dex_fn: Callable) -> dict[str, Any]:
    if not name:
        return {}
    return (dex_fn([name]) or {}).get(name, {}) or {}


def _base_form_name(name: str | None, dex_fn: Callable,
                    facts: dict[str, Any] | None = None) -> str | None:
    """Return the pre-Mega/base species for a dex-canonical name when the dex exposes it."""
    if not name:
        return None
    facts = facts if facts is not None else _dex_facts(name, dex_fn)
    if facts.get("is_mega") and facts.get("base_species"):
        return facts.get("base_species")
    return name


def _base_form_facts(name: str | None, dex_fn: Callable,
                     facts: dict[str, Any] | None = None) -> tuple[str | None, dict[str, Any]]:
    base = _base_form_name(name, dex_fn, facts)
    if not base:
        return None, {}
    if base == name and facts is not None:
        return base, facts
    bfacts = _dex_facts(base, dex_fn)
    return base, bfacts or (facts or {})


def _norm_field_token(value: Any, mapping: dict[str, str]) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    key = raw.lower().replace("_", " ").replace("-", " ")
    key = key.removesuffix(" terrain").strip()
    return mapping.get(key) or raw[:1].upper() + raw[1:]


def _norm_weather(value: Any) -> str | None:
    return _norm_field_token(value, {
        "rain": "Rain", "sun": "Sun", "sand": "Sand", "sandstorm": "Sand",
        "snow": "Snow", "hail": "Snow", "harsh sun": "Harsh Sun",
        "heavy rain": "Heavy Rain", "strong winds": "Strong Winds",
    })


def _norm_terrain(value: Any) -> str | None:
    return _norm_field_token(value, {
        "electric": "Electric", "grassy": "Grassy", "psychic": "Psychic", "misty": "Misty",
    })


def _mega_form_name(name: str | None, item: str | None, dex_fn: Callable,
                    item_fn: Callable | None, *, facts: dict[str, Any] | None = None) -> str | None:
    """The Mega form `name` becomes while holding `item` (a Mega stone), or None. A species already
    given AS a Mega resolves to itself. Otherwise the item's `required_by` mapping (item_fn) is matched
    to the base species — never a guessed 'Mega X' string (X/Y forms need the exact stone). `facts` may
    pass the already-fetched dex facts for `name` to save a lookup. A single required_by candidate is a
    fallback ONLY while its base_species is unknown — a known, mismatched base means the stone belongs
    to a DIFFERENT species (a wrong-stone member must not resolve into someone else's Mega)."""
    if not name:
        return None
    if facts is None:
        facts = _dex_facts(name, dex_fn)
    if not (item and item_fn):
        return name if facts.get("is_mega") else None
    item_info = item_fn([item]) or {}
    forms = ((item_info.get(item, {}) or {}).get("required_by") or [])
    form_facts = {f: _dex_facts(f, dex_fn) for f in forms}
    return mega_form_from_maps(name, item, facts, item_info, form_facts)


def _form_record(name: str | None, item: str | None, ability: str | None, dex_fn: Callable,
                 item_fn: Callable | None, *, run_form: str | None = None,
                 base_ability: str | None = None) -> dict[str, Any]:
    """Resolve the effective calc form plus the switch-in/base facts.

    This is the single tune-side Mega/run_form resolver. Members and opponent sets differ only in
    whether a `run_form` is present and whether a caller supplied a known pre-Mega `base_ability`; the
    shape consumed downstream is identical.
    """
    facts = _dex_facts(name, dex_fn)
    if facts.get("is_mega"):
        base_name, base_facts = _base_form_facts(name, dex_fn, facts)
        mega_abilities = list(facts.get("abilities") or [])
        base_abilities = set(base_facts.get("abilities") or [])
        mega_ability = ability if ability in mega_abilities else (
            mega_abilities[0] if mega_abilities else ability)
        resolved_base_ability = base_ability or (ability if ability in base_abilities else None)
        return {"name": name, "ability": mega_ability, "base_ability": resolved_base_ability,
                "mega_ability": mega_ability, "is_mega": True, "facts": facts,
                "base_facts": base_facts or facts, "base_name": base_name or name}

    if run_form and run_form != name:
        rfacts = _dex_facts(run_form, dex_fn)
        base_name, base_facts = _base_form_facts(run_form, dex_fn, rfacts)
        run_abilities = list(rfacts.get("abilities") or [])
        base_abilities = set(base_facts.get("abilities") or [])
        # Real-team/meta run_form sets usually carry the actually-run ability. Preserve it if present;
        # otherwise fall back to the run form's first ability.
        resolved = ability if ability else (run_abilities[0] if run_abilities else None)
        resolved_base_ability = base_ability or (ability if ability in base_abilities else None)
        return {"name": run_form, "ability": resolved, "base_ability": resolved_base_ability,
                "mega_ability": resolved if rfacts.get("is_mega") else None,
                "is_mega": bool(rfacts.get("is_mega")), "facts": rfacts,
                "base_facts": base_facts or rfacts, "base_name": base_name or name}

    base_facts = facts
    mform = _mega_form_name(name, item, dex_fn, item_fn, facts=base_facts)
    if mform and mform != name:
        mfacts = _dex_facts(mform, dex_fn)
        mega_ability = (mfacts.get("abilities") or [None])[0]
        return {"name": mform, "ability": mega_ability or ability,
                "base_ability": base_ability or ability, "mega_ability": mega_ability,
                "is_mega": True, "facts": mfacts, "base_facts": base_facts,
                "base_name": name}
    return {"name": name, "ability": ability, "base_ability": base_ability or ability,
            "mega_ability": None, "is_mega": False, "facts": base_facts, "base_facts": base_facts,
            "base_name": name}


def _effective_form(member: dict[str, Any], dex_fn: Callable,
                    item_fn: Callable | None) -> dict[str, Any]:
    """Resolve a member to the FORM used in the damage/speed math: the MEGA form when it holds a
    matching stone (Mega stats + Mega ability), else the base form. Returns
    {name, ability, base_ability, mega_ability, is_mega, facts, base_facts} — `name`/`ability` feed the
    ncp calc, `base_ability` is the team-json/pre-Mega ability (for switch-in special checks), `facts`
    are the resolved form's dex facts (types/stats), and `base_facts` are the PRE-Mega form's (entry
    hazards resolve at switch-in, before Mega Evolution, so hazard typing reads the base form). See
    _special_ability_present for the two-place ability rule."""
    return _form_record(member.get("species"), member.get("item"), member.get("ability"),
                        dex_fn, item_fn, base_ability=member.get("base_ability"))


def _calc_member(member: dict[str, Any], eff: dict[str, Any]) -> dict[str, Any]:
    """The member dict with species/ability overwritten to the effective (Mega) form for the ncp calc;
    spread/item/nature/moves stay as authored."""
    return {**member, "species": eff["name"], "ability": eff["ability"]}


def _special_ability_present(specials: set[str], resolved_ability: str | None,
                             base_ability: str | None, base_pct: float | None,
                             *, base_gated: bool) -> bool:
    """Whether any ability in `specials` is present on the set as MODELLED (§9 two-place rule). The
    resolved (in-calc, post-Mega for a stone holder) ability counts UNCONDITIONALLY — it IS the set the
    damage math runs, so gating it would contradict the calc on the same card. The pre-Mega base
    ability counts unconditionally when declared/observed (an explicit set, a real-team joint set, or
    the member's own team-json: `base_gated=False`), and only at >= the usage floor when it comes from
    a meta marginal (`base_gated=True`, `base_pct` its usage %)."""
    special_keys = {_ability_key(a) for a in specials}
    if _ability_key(resolved_ability) in special_keys:
        return True
    if _ability_key(base_ability) in special_keys:
        if not base_gated:
            return True
        if (base_pct or 0.0) >= SPECIAL_BASE_ABILITY_USAGE_FLOOR:
            return True
    return False


def _invested_stats(spread: dict[str, Any] | None) -> set[str]:
    """Spread (non-HP) stats that carry SP — the 'in use' set for the nature in-use filter (§16.8)."""
    return {k for k, v in (spread or {}).items() if k in ("atk", "def", "spa", "spd", "spe") and v}


def _outcome(min_total: int | None, cur: int, base_sps: dict[str, int]) -> dict[str, Any]:
    """Normalise a solved min-SP into {result, delta_sp, need_total} against the current spend + the
    66 SP budget — the shared verdict for a baseline card and each nature lane (so they compare)."""
    if min_total is None:
        return {"result": "unreachable", "delta_sp": SP_CAP + 1}
    delta = max(0, min_total - cur)
    total_after = sum(base_sps.values()) - cur + max(cur, min_total)
    if delta == 0:
        return {"result": "already", "delta_sp": 0, "need_total": min_total}
    if total_after > SP_TOTAL_CAP:
        return {"result": "infeasible", "delta_sp": delta, "need_total": min_total}
    return {"result": "cliff", "delta_sp": delta, "need_total": min_total}


def _nature_lanes(target_spread_stat: str, current_nature: str | None, cur: int,
                  base_sps: dict[str, int], baseline: dict[str, Any], *, solve_min_fn: Callable,
                  invested: set[str], offense_lean: str | None, meta_natures: set[str]) -> dict[str, Any]:
    """Build the §16.8 nature-lane attachment for one cliff. `solve_min_fn(nature)->min_total|None`
    re-solves the EXISTING 1-D SP cliff under a different nature (no new search dimension). Only
    `propose` lanes are solved; a lane is kept only if it UNLOCKS an unreachable/infeasible baseline
    or frees >= NATURE_LANE_MIN_SAVINGS SP (importance gate). Returns {alternatives, notes, unlock} —
    NEVER a recommended (nature, SP); the caller attaches it as a sub-field, out of the head ranking.
    `meta_natures` is the REALITY GATE (natures real players run on this species, ~2%+): empty -> no
    lanes at all (an off-role nature nobody runs is not a real option)."""
    if not meta_natures:
        return {"alternatives": [], "notes": [], "unlock": False}
    lanes = candidate_natures(target_spread_stat, current_nature, invested_stats=invested,
                              offense_lean=offense_lean, meta_natures=meta_natures)
    base_cost = baseline["delta_sp"]
    base_reachable = baseline["result"] in ("cliff", "already")
    kept: list[dict[str, Any]] = []
    notes: list[str] = []
    unlock = False
    for L in lanes:
        if L["status"] != "propose":          # summarize / locked -> a compact note, not a solved lane
            notes.append(f"{L['nature']} ({L['reason']}) — not auto-proposed")
            continue
        oc = _outcome(solve_min_fn(L["nature"]), cur, base_sps)
        lane_reachable = oc["result"] in ("cliff", "already")
        saves = base_cost - oc["delta_sp"]
        is_unlock = (not base_reachable) and lane_reachable
        if not (is_unlock or saves >= NATURE_LANE_MIN_SAVINGS):
            continue                           # no real impact -> drop (anti nature-creep)
        unlock = unlock or is_unlock
        kept.append({"nature": L["nature"], **oc, "saves_sp": saves, "unlock": is_unlock,
                     "plus_stat": L["plus_stat"], "penalty_stat": L["penalty_stat"],
                     "meta_pct": L.get("meta_pct"),   # carry the real usage % through to the lane (audit 2026-06-24)
                     "opportunity_cost": (f"-10% {L['penalty_stat']} (a whole-spread, single-slot commitment)"
                                          if L["penalty_stat"] else "neutral nature"),
                     "reason": L["reason"]})
    return {"alternatives": kept, "notes": notes, "unlock": unlock}


def _sps_from_spread(spread: dict[str, int] | None) -> dict[str, int]:
    out = {v: 0 for v in SPREAD_TO_SPS.values()}
    for k, v in (spread or {}).items():
        if k in SPREAD_TO_SPS:
            out[SPREAD_TO_SPS[k]] = int(v or 0)
    return out


def _member_ncp(member: dict[str, Any], sps: dict[str, int]) -> dict[str, Any]:
    return {"name": member.get("species"), "ability": member.get("ability"),
            "item": member.get("item"), "nature": member.get("nature") or "Hardy", "sps": sps}


def _attacker_ncp(species: str, category: str, attacker_set: dict[str, Any] | None,
                  meta_set: dict[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
    """Resolve the threatening attacker and return (ncp_attacker, provenance).

    Precedence: an explicit caller `attacker_set` (user/benchmark) wins; otherwise the meta MODAL
    set (real ability/item/nature/spread — this is what stops Huge Power being silently dropped);
    otherwise a synthetic max-offense attacker that models NO ability/item, flagged low-confidence
    so a falsely "survivable" verdict is never presented as solid (audit 2026-06-21)."""
    if attacker_set:
        aset = dict(attacker_set)
        if "sps" not in aset and isinstance(aset.get("spread"), dict):
            aset["sps"] = _sps_from_spread(aset.get("spread"))
        return ({"name": species, **aset},
                {"source": "explicit", "confidence": "high",
                 "note": "attacker set supplied by the caller"})
    if meta_set:
        base_ability = (((meta_set.get("set") or {}).get("ability") or {}).get("name")
                        if isinstance(meta_set.get("set"), dict) else None)
        source = meta_set.get("source") or "meta"
        return ({"name": species, "ability": meta_set.get("ability"), "item": meta_set.get("item"),
                 "nature": meta_set.get("nature") or "Hardy", "sps": meta_set.get("sps") or {},
                 "run_form": meta_set.get("run_form"), "base_ability": base_ability},
                {"source": source, "confidence": meta_set.get("confidence", "medium"),
                 "note": meta_set.get("note"), "prevalence": meta_set.get("prevalence")})
    off = OFF_SPS.get(category, "at")
    return ({"name": species, "ability": None, "item": None,
             "nature": OFF_NATURE.get(category, "Hardy"), "sps": {off: SP_CAP}},
            {"source": "synthetic", "confidence": "low",
             "note": "no meta set for this attacker; synthetic max-offense, abilities/items NOT "
                     "modelled — a real set (e.g. Huge Power) may hit far harder"})


def _meta_set(meta_fn: Callable | None, species: str, fmt: str | None,
              attacker_set: dict[str, Any] | None,
              dex_fn: Callable | None = None) -> dict[str, Any] | None:
    """Fetch the meta modal set, defensively: an explicit set skips it, and a meta outage
    falls through to the synthetic attacker rather than crashing the whole tune call."""
    if attacker_set or not meta_fn:
        return None
    names = [species]
    if dex_fn:
        try:
            base = _base_form_name(species, dex_fn)
            if base and base not in names:
                names.append(base)
        except Exception:
            pass
    for name in names:
        try:
            got = meta_fn(name, fmt)
        except Exception:
            got = None
        if got:
            return got
    return None


def _mega_resolve_attacker(attacker: dict[str, Any], dex_fn: Callable,
                           item_fn: Callable | None) -> dict[str, Any]:
    """Mega-resolve a meta attacker (§9): a stone item swaps it to its Mega form NAME + Mega
    ability (so Mega Staraptor hits as Contrary + Mega stats, Tough Claws boosts contact moves, etc.),
    keeping `base_ability` for the switch-in special check. Returns {**attacker, name, ability,
    base_ability, mega_ability}."""
    rec = _form_record(attacker.get("name"), attacker.get("item"), attacker.get("ability"),
                       dex_fn, item_fn, run_form=attacker.get("run_form"),
                       base_ability=attacker.get("base_ability"))
    return {**attacker, **rec}


def _meta_ability_pct(meta_set: dict[str, Any] | None) -> float | None:
    return ((((meta_set or {}).get("set") or {}).get("ability")) or {}).get("pct")


def _meta_ability_distribution(meta_set: dict[str, Any] | None) -> list[dict[str, Any]]:
    set_block = ((meta_set or {}).get("set") or {})
    if not isinstance(set_block, dict):
        return []
    rows: list[dict[str, Any]] = []
    for row in (set_block.get("abilities") or set_block.get("ability_distribution") or []):
        if isinstance(row, dict) and row.get("name"):
            rows.append({"name": row.get("name"), "pct": row.get("pct")})
    top = set_block.get("ability") or {}
    if isinstance(top, dict) and top.get("name"):
        key = _ability_key(top.get("name"))
        if all(_ability_key(r.get("name")) != key for r in rows):
            rows.append({"name": top.get("name"), "pct": top.get("pct")})
    return rows


def _meta_special_ability_pct(meta_set: dict[str, Any] | None, specials: set[str]) -> float | None:
    special_keys = {_ability_key(a) for a in specials}
    pcts: list[float] = []
    for row in _meta_ability_distribution(meta_set):
        if _ability_key(row.get("name")) not in special_keys:
            continue
        try:
            pcts.append(float(row.get("pct") or 0.0))
        except (TypeError, ValueError):
            pcts.append(0.0)
    return max(pcts) if pcts else None


def _base_ability_gated(prov: dict[str, Any], meta_set: dict[str, Any] | None) -> bool:
    return (prov.get("source") == "meta"
            and not str((meta_set or {}).get("source") or "").startswith("real-team"))


def _hazard_abilities_for_modeled_set(actor: dict[str, Any], meta_set: dict[str, Any] | None,
                                      prov: dict[str, Any]) -> tuple[str, ...]:
    base_ability = actor.get("base_ability")
    base_pct = _meta_ability_pct(meta_set)
    base_gated = _base_ability_gated(prov, meta_set)
    return tuple({a for a in (
        actor.get("ability"),
        base_ability if base_ability and (not base_gated
                                          or (base_pct or 0.0) >= SPECIAL_BASE_ABILITY_USAGE_FLOOR)
        else None,
    ) if a})


def _attacker_intimidatable(attacker: dict[str, Any], base_pct: float | None,
                            base_special_pct: float | None = None,
                            *, base_gated: bool) -> bool:
    """Whether OUR Intimidate lowers this (physical) attacker's Attack: true unless an Intimidate-immune
    ability is present on the MODELLED set (§9) — the resolved (post-Mega) ability unconditionally (it
    is the very ability the damage calc runs), the pre-Mega base ability ungated for an explicit /
    real-team set and at >= the usage floor for a meta marginal."""
    if _special_ability_present(
        INTIMIDATE_IMMUNE_ABILITIES, attacker.get("ability"), attacker.get("base_ability"),
        base_pct, base_gated=base_gated):
        return False
    if str(attacker.get("item") or "").casefold() in INTIMIDATE_BLOCKING_ITEMS:
        return False
    # When the attacker is a pure meta marginal and the modal ability is not the immune one, keep a
    # distribution-level guard for meaningful rank-2 abilities (e.g. Defiant 45%). Real-team joint sets
    # are observed sets, so their actual ability above remains authoritative.
    if base_gated and (base_special_pct or 0.0) >= SPECIAL_BASE_ABILITY_USAGE_FLOOR:
        return False
    return True


def _member_completeness(member: dict[str, Any]) -> tuple[str, str | None]:
    """(confidence cap, note) for tuning off this member's set. Tuning off a set we don't fully
    know (unknown ability/nature/spread) is a guess, so cap confidence accordingly (audit point 8)."""
    has_moves = bool(member.get("moves"))
    lvl = member.get("completeness")
    if completeness.set_authoritative(lvl, has_moves=has_moves):
        # SP is judged separately from the set fields: a TAGGED authoritative member without a spread
        # has an UNKNOWN spread, and `_sps_from_spread` will read it as all-0 — a guess about its real
        # allocation, so drop to low and say so
        # explicitly (audit 2026-07-02). An untagged member is user-authored (absent = real 0 SP).
        if not completeness.spread_authoritative(lvl, has_spread=bool(member.get("spread"))):
            eff = completeness.effective_level(lvl, has_moves=has_moves)
            return "low", (f"member spread unavailable in source (completeness={eff}) — SP assumed 0; "
                           "cliffs are measured from an assumed-0 baseline")
        # Authoritative -> tune off it directly, but earn only its confidence floor: an observed full set
        # is high, a validated-but-reconstructed `extracted_set` is medium. Never claim high for
        # reverse-engineered data, and no "assumed" caveat (it's real, just lower-confidence) — audit 2026-07-01.
        return completeness.confidence_floor(lvl, has_moves=has_moves), None
    eff = completeness.effective_level(lvl, has_moves=has_moves)
    return (completeness.confidence_floor(lvl, has_moves=has_moves),
            f"member set not fully known (completeness={eff}); its ability/nature/spread may be assumed")


def _sr_chip(types: list[str], hp: int, *, abilities: tuple[str, ...] | set[str] = ()) -> int:
    """Stealth Rock chip = 1/8 * Rock effectiveness of max HP (type-based), floored. Entry hazards
    resolve at SWITCH-IN — before Mega Evolution — so `types` must be the PRE-Mega form's and
    `abilities` carries the §9 two-place set (base + resolved): any Magic Guard present -> 0 chip.
    Magic Guard is the only SR-negating ability modelled for now (Heavy-Duty Boots / Air Balloon-vs-SR
    are a deferred increment)."""
    if any((a or "").lower() == "magic guard" for a in abilities):
        return 0
    mult = effectiveness("Rock", [t for t in types if t])
    return int(hp * (1 / 8) * mult)


def _spikes_layers(conds: dict[str, Any]) -> int:
    raw = conds.get("spikes")
    if raw is True:
        return 1
    if raw is False or raw is None:
        return 0
    if isinstance(raw, int):
        return max(0, min(3, raw))
    return 0


def _spikes_chip(types: list[str], hp: int, layers: int, *,
                 abilities: tuple[str, ...] | set[str] = (), item: str | None = None) -> int:
    """Spikes chip on a grounded target. Same switch-in (pre-Mega) basis as _sr_chip: `types` are the
    PRE-Mega form's, `abilities` the §9 two-place set (any airborne/Magic Guard entry -> 0)."""
    if layers <= 0:
        return 0
    ability_ns = {(a or "").lower() for a in abilities}
    item_n = (item or "").lower()
    type_n = {t.lower() for t in types if t}
    if ability_ns & {"levitate", "eelevate", "magic guard"} or item_n in {"heavy-duty boots", "air balloon"}:
        return 0
    if "flying" in type_n:
        return 0
    if layers == 1:
        return max(1, hp // 8)
    if layers == 2:
        return hp // 6
    return hp // 4


def _screen_side(scr: Any, category: str) -> dict[str, bool]:
    """Map a `screens` condition to ncp's defenderSide flags. A bare truthy value picks the
    screen that blocks this category (Reflect vs physical, Light Screen vs special); an explicit
    string ('reflect' / 'light_screen' / 'aurora_veil') is honoured as given."""
    s = (scr if isinstance(scr, str) else "").replace("_", "").replace(" ", "").lower()
    if s in ("auroraveil", "veil"):
        return {"auroraVeil": True}
    if s == "reflect":
        return {"reflect": True}
    if s == "lightscreen":
        return {"lightScreen": True}
    return {"reflect": True} if category == "physical" else {"lightScreen": True}


def _damage_field(conds: dict[str, Any], category: str, fmt: str | None = None, *,
                  use_sr: bool | None = None, spikes: int | None = None) -> dict[str, Any]:
    """Translate explicit benchmark conditions into the ncp field schema (audit 2026-06-21).

    `fmt` sets `field.format` so the engine applies the DOUBLES spread-move reduction (0.75x on
    Earthquake / Rock Slide / Heat Wave ...) — omitting it silently ran every doubles calc in Singles,
    over-stating spread damage and flipping survival verdicts (re-audit 2026-07-07). `use_sr`/`spikes`
    override the raw-conds hazard read so the caller passes the GATED values (Stealth Rock is singles +
    team-carries + Magic-Guard-exempt; Spikes stays default-off) — pass None to fall back to conds.

    Conditions that the engine needs go here: weather (a named string), screens (defender-side
    Reflect / Light Screen / Aurora Veil), Stealth Rock, and Spikes. Entry hazards are residual chip, not a damage
    modifier — it leaves the raw `damage` rolls and `defenderHP` untouched (those are read by the
    static cliffs, which apply hazards themselves via `_sr_chip`/`_spikes_chip`/`eff_hp`) and only feeds the engine's
    recovery-aware `ko_chance`, so the 4d engine KO% accounts for the same hazard chip the static cliff does
    instead of silently reporting a no-SR number (audit 2026-06-27). It rides the DEFENDER side in
    both cliffs: the chipped Pokemon is always the ncp `defender` (survive: our member; kill: the
    target), and ncp reads SR from the side (`defenderSide.stealthRock` -> handlerSide.isSR), never
    a top-level field key. Tailwind / Trick Room don't change damage, so they live in the speed cliff.
    Conditions are applied only when the benchmark sets them explicitly — the format profile informs
    ranking, it never silently turns a condition on/off."""
    field: dict[str, Any] = {}
    if fmt:
        field["format"] = fmt
    weather = _norm_weather(conds.get("weather"))
    if weather:
        field["weather"] = weather
    terrain = _norm_terrain(conds.get("terrain"))
    if terrain:
        field["terrain"] = terrain
    def_side: dict[str, Any] = {}
    scr = conds.get("screens")
    if scr:
        def_side.update(_screen_side(scr, category))
    sr = bool(conds.get("stealth_rock")) if use_sr is None else use_sr
    if sr:
        def_side["stealthRock"] = True
    layers = _spikes_layers(conds) if spikes is None else spikes
    if layers:
        def_side["spikes"] = layers
    if def_side:
        field["defenderSide"] = def_side
    return field


def _survive_min_sp(member: dict[str, Any], nature: str, attacker: dict[str, Any], move: str,
                    field: dict[str, Any], dstat: str, base_sps: dict[str, int], target: str,
                    defender_types: list[str], use_sr: bool, spikes: int, *, damage_fn: Callable,
                    damage_batch_fn: Callable | None, hits: int = 1,
                    precomputed: dict | None = None,
                    hazard_abilities: tuple[str, ...] | set[str] = ()) -> tuple[int | None, dict]:
    """Min `dstat` SP for `member` UNDER `nature` to survive `hits` hits of `attacker` at the target
    probability; returns (min_total, rolls_cache). The defender's nature scales its Def/SpD so each
    nature re-batches; the incoming damage is monotonic in `dstat` SP, so one batch [0..cap] feeds the
    binary search. This is the per-nature kernel the baseline card and every §16.8 nature lane share.

    `hits` is the DEFENSE mirror of the kill cliff's multi-hit band (§9): surviving h hits statically
    (each hit repeats hit 1, entry-hazard chip applied ONCE) means `h*d < eff_hp` for a roll d, i.e.
    `d < ceil(eff_hp/h)`, so the single-hit survival predicate is reused against the per-hit threshold —
    exact for h=1 (byte-identical to survive-1). Ignores between-hit recovery, same boundary as the kill
    side. The damage rolls do NOT depend on `hits`, so the survive-1 rolls_cache can be passed back in as
    `precomputed` for the survive-2 solve — same (attacker, field, nature), no second batch call.

    `defender_types`/`hazard_abilities` feed ONLY the hazard chip and must describe the PRE-Mega
    (switch-in) form: base typing + the §9 two-place ability set. The damage side reads the Mega form
    from `member` (the calc member) via the engine."""
    m = member if nature == (member.get("nature") or "Hardy") else {**member, "nature": nature}

    def _defender(total: int):
        sps = dict(base_sps); sps[dstat] = total
        return _member_ncp(m, sps)

    rolls_cache: dict[int, tuple[list[int], int]] = precomputed if precomputed is not None else {}
    if precomputed is None and damage_batch_fn is not None:
        reqs = [{"attacker": attacker, "defender": _defender(t), "move": move, "field": field}
                for t in range(SP_CAP + 1)]
        for t, r in enumerate(damage_batch_fn(reqs) or []):
            r = r or {}
            hp = int(r.get("defenderHP") or 0)
            # A batch entry with no HP is a calculator error, not a real 0-HP defender; skipping it
            # lets predicate() fall back to a live probe instead of mis-reading "doesn't survive".
            if hp:
                rolls_cache[t] = (list(r.get("damage", [])), hp)

    def predicate(total: int) -> bool:
        if total in rolls_cache:
            rolls, hp = rolls_cache[total]
        else:
            rolls, hp = damage_fn(attacker, _defender(total), move, field)
        if not hp:
            return False
        hazard_chip = (_sr_chip(defender_types, hp, abilities=hazard_abilities) if use_sr else 0) \
            + _spikes_chip(defender_types, hp, spikes, abilities=hazard_abilities, item=m.get("item"))
        eff_hp = hp - hazard_chip
        thr = -(-eff_hp // hits)              # ceil(eff_hp/hits): the per-hit survival threshold
        return meets_target(survival_prob(rolls, thr), target)

    return solve_min_sp(predicate, cap=SP_CAP), rolls_cache


def _survive_card(member: dict[str, Any], b: dict[str, Any], prof, *,
                  damage_fn: Callable, move_fn: Callable, dex_fn: Callable,
                  meta_fn: Callable | None = None, meta_natures: set[str] | None = None,
                  locked: bool = False, damage_batch_fn: Callable | None = None,
                  item_fn: Callable | None = None,
                  team_flags: dict[str, bool] | None = None,
                  effective: dict[str, Any] | None = None) -> dict[str, Any]:
    team_flags = team_flags or {}
    move = b.get("move")
    mi = (move_fn([move]) or {}).get(move, {}) if move else {}
    cat = (mi.get("category") or "").lower()
    # Resolve the DEFENDER to its Mega form when it holds a stone (§9): Mega stats/typing/ability
    # (so Mega Delphox's Levitate makes Ground a 0, not an unreachable survival cliff).
    eff = effective or _effective_form(member, dex_fn, item_fn)
    calc_member = _calc_member(member, eff)
    member_label = eff["name"]
    if cat not in ("physical", "special"):
        return {"aspect": "defense", "kind": "survive", "member": member_label, "vs": b.get("vs"),
                "move": move, "result": "skipped",
                "note": "move missing/non-damaging; cannot solve a survival cliff"}

    dstat, dspread = DEF_SPS[cat], DEF_SPREAD[cat]
    if move in PHYS_DEF_SPECIAL_MOVES:           # special move, but it hits Def — pressure Def, not SpD
        dstat, dspread = "df", "def"
    target = b.get("probability", "guaranteed")
    conds = b.get("conditions") or {}
    # Stealth Rock chipping US needs the OPPONENT's SR (our team-carries gate is for the KILL card),
    # so on the survive side it is an EXPLICIT opt-in and SINGLES-only (re-audit 2026-07-07); a Magic
    # Guard defender takes no chip (handled inside _sr_chip). Spikes stays default-off (conds-driven).
    sr_requested = conds.get("stealth_rock") is True
    sr_ignored = sr_requested and prof.fmt != "single"
    use_sr = sr_requested and prof.fmt == "single"
    spikes = _spikes_layers(conds)
    # field.format makes the engine apply the DOUBLES spread-move reduction (0.75x) — the fix at the
    # heart of this re-audit; without it a doubles Earthquake was scored at full single-target damage.
    field = _damage_field(conds, cat, prof.fmt, use_sr=use_sr, spikes=spikes)

    meta_set = _meta_set(meta_fn, b["vs"], prof.fmt, b.get("attacker_set"), dex_fn=dex_fn)
    attacker0, prov = _attacker_ncp(b["vs"], cat, b.get("attacker_set"), meta_set)
    attacker = _mega_resolve_attacker(attacker0, dex_fn, item_fn)   # Mega Staraptor -> Contrary + Mega stats
    atk_base_pct = _meta_ability_pct(meta_set)
    atk_base_special_pct = _meta_special_ability_pct(meta_set, INTIMIDATE_IMMUNE_ABILITIES)
    # The §9 usage gate applies only to a pre-Mega base ability that is a META MARGINAL; an explicit
    # attacker_set or a real-team joint set is declared/observed and counts ungated.
    atk_base_gated = _base_ability_gated(prov, meta_set)
    mc_conf, mc_note = _member_completeness(member)
    base_sps = _sps_from_spread(member.get("spread"))
    cur = base_sps[dstat]
    # Hazards resolve at SWITCH-IN (pre-Mega): chip typing = the BASE form's, and the immunity check
    # carries the §9 two-place ability set (own declared base ability + the resolved/Mega one, ungated —
    # both are the member's own facts).
    defender_types = list(eff["base_facts"].get("types") or [])
    hazard_abilities = tuple({a for a in (eff["base_ability"], eff["ability"]) if a})

    # Only `dstat` (Def or SpD, never HP) varies across the SP search, so the incoming damage is
    # monotonic in SP and one batch [0..cap] feeds the search (the kernel handles batch-vs-live).
    cur_nature = member.get("nature") or "Hardy"
    # DEFENSE mirror of the kill tiers (§9): solve BOTH surviving 1 hit (avoid the OHKO) and 2 hits
    # (avoid the 2HKO — the opponent's usual 'break the wall' standard). NO-TUNING subsumption: hide the
    # easier survive-1 line ONLY when survive-2 is ALREADY met at the current spread (if you already eat
    # two hits the one-hit line is noise); otherwise show both — survive-1 is the achievable floor when
    # survive-2 needs tuning or is unreachable. Damage rolls don't depend on `hits`, so the survive-1
    # rolls_cache feeds the HP lane unchanged (only the threshold scales with the headline's hit count).
    tiers: dict[int, dict[str, Any]] = {}
    rolls_cache: dict[int, tuple[list[int], int]] = {}
    for h in (1, 2):
        mt, rc = _survive_min_sp(calc_member, cur_nature, attacker, move, field, dstat, base_sps,
                                 target, defender_types, use_sr, spikes, damage_fn=damage_fn,
                                 damage_batch_fn=damage_batch_fn, hits=h,
                                 precomputed=rolls_cache if h == 2 else None,
                                 hazard_abilities=hazard_abilities)
        if h == 1:
            rolls_cache = rc
        t = {"hits": h, "label": "survive 1 hit" if h == 1 else "survive 2 hits",
             **_outcome(mt, cur, base_sps)}
        if t["result"] == "already" and mt is not None:      # slack = pullable SP while still surviving
            t["slack_sp"] = cur - mt
        tiers[h] = t
    survive2_already = tiers[2]["result"] == "already"
    survive_tiers = [tiers[2]] if survive2_already else [tiers[1], tiers[2]]
    headline = tiers[2] if survive2_already else tiers[1]
    head_hits = headline["hits"]

    # HP lane (audit retro 2026-06-22): HP is often the cheaper survival lever and scales BOTH
    # defenses, yet the cliff above tunes only one defensive stat — so a cliff reachable via HP was
    # mis-reported as "unreachable". Incoming damage does NOT depend on the defender's HP, so the
    # rolls at the current Def/SpD are reused unchanged: the HP lane costs ZERO extra ncp calls; only
    # the survival threshold (max HP) moves with HP SP. Reported as an alternative fact, never as the
    # chosen lever (the model picks; competing lanes share the same 66 SP budget).
    cur_hp_sp = base_sps["hp"]
    if cur in rolls_cache:
        cur_rolls, cur_hp = rolls_cache[cur]
    else:                                  # current Def/SpD defender (base_sps[dstat] == cur already)
        cur_rolls, cur_hp = damage_fn(attacker, _member_ncp(calc_member, base_sps), move, field)
    hp_lane: dict[str, Any] | None = None
    if move in HP_DEPENDENT_MOVES:
        # The HP-lane reuse assumes incoming damage is independent of the defender's HP; that's false
        # for HP-proportional moves, so don't offer a misleading HP lane (audit 2026-06-24).
        hp_lane = {"stat": "hp", "result": "n/a",
                   "note": f"{move} damage scales with HP — adding HP doesn't form a survival cliff"}
    elif cur_hp and cur_rolls is not None:
        hp0 = cur_hp - cur_hp_sp                        # max HP at 0 HP SP (Champions: 1 SP = +1 HP)

        def _hp_pred(hp_sp: int) -> bool:
            mhp = hp0 + hp_sp
            hazard_chip = (_sr_chip(defender_types, mhp, abilities=hazard_abilities) if use_sr
                           else 0) + _spikes_chip(defender_types, mhp, spikes,
                                                  abilities=hazard_abilities, item=calc_member.get("item"))
            eff_hp = mhp - hazard_chip
            thr = -(-eff_hp // head_hits)            # ceil(eff_hp/hits): the headline tier's per-hit threshold
            return meets_target(survival_prob(cur_rolls, thr), target)

        min_hp = solve_min_sp(_hp_pred, cap=SP_CAP)
        if min_hp is None:
            hp_lane = {"stat": "hp", "result": "unreachable", "delta_sp": SP_CAP + 1}
        else:
            hp_lane = {"stat": "hp", **_outcome(min_hp, cur_hp_sp, base_sps)}

    # Intimidate lane (§9, doubles only): when our team fields an Intimidate provider AND the
    # physical attacker is not Intimidate-immune (Contrary/Defiant/Clear Body/Mirror Armor on either
    # form), model BOTH 0 and 1 Intimidate (capped at 1) — the -1 Atk relief cliff sits beside the raw
    # cliff so the user sees the range they actually play at, not a false "unreachable".
    intimidate_lane: dict[str, Any] | None = None
    if (cat == "physical" and team_flags.get("intimidate") and headline["result"] != "already"
            and _attacker_intimidatable(attacker, atk_base_pct, atk_base_special_pct,
                                        base_gated=atk_base_gated)):
        boosts = dict(attacker.get("boosts") or {})
        boosts["atk"] = max(-6, min(6, int(boosts.get("atk") or 0) - 1))
        intim_attacker = {**attacker, "boosts": boosts}
        intim_min, _ic = _survive_min_sp(calc_member, cur_nature, intim_attacker, move, field, dstat,
                                         base_sps, target, defender_types, use_sr, spikes,
                                         damage_fn=damage_fn, damage_batch_fn=damage_batch_fn, hits=head_hits,
                                         hazard_abilities=hazard_abilities)
        intimidate_lane = {"stages": 1, **_outcome(intim_min, cur, base_sps)}

    def _hp_suffix() -> str:
        if not hp_lane:
            return ""
        r = hp_lane["result"]
        if r == "n/a":
            return f" | HP lane n/a ({hp_lane.get('note', '')})"
        if r == "already":
            return " | HP lane: already met"
        if r == "unreachable":
            return " | HP lane also can't reach within the cap"
        return f" | HP lane: +{hp_lane['delta_sp']} HP SP (to {hp_lane['need_total']}) [{r}]"

    card: dict[str, Any] = {
        "aspect": "defense", "kind": "survive", "member": member_label, "vs": b.get("vs"), "move": move,
        "category": cat, "stat": dspread, "probability": target,
        "stealth_rock": use_sr, "spikes": spikes,
        "survive_tiers": survive_tiers, "hits": head_hits,
        "headroom": defensive_headroom(eff["facts"].get("stats") or {}),
        "magnitude": 1.0 if target == "guaranteed" else 0.8,
        # Prevalence = how common this threat/set actually is: meta supplies it; otherwise the
        # benchmark was user-deemed relevant (0.7 baseline). `or` also guards an injected meta set
        # that carries an explicit None (a bare .get default would let None crash score_card).
        "prevalence": prov.get("prevalence") or 0.7,
        "decisiveness": 0.8,      # surviving -> you get to act
        # Confidence = the more cautious of the attacker-set confidence and the tuned member's own
        # set completeness (tuning off an unknown spread/ability is a guess).
        "confidence": completeness.min_confidence(prov.get("confidence", "medium"), mc_conf),
        "attacker": {"source": prov.get("source"), "ability": attacker.get("ability"),
                     "item": attacker.get("item"), "nature": attacker.get("nature"),
                     "sps": attacker.get("sps")},
        "hp_lane": hp_lane,
        "assumptions": [f"attacker = {prov.get('source')} set"]
        + (["both survival tiers solved (survive 1 hit / 2 hits); survive-1 is hidden only when survive-2 "
            "is already met without tuning"])
        + (["STATIC 2-hit survival: repeats hit 1 and applies the entry-hazard chip once; ignores "
            "between-hit recovery (Sitrus/Leftovers), ability shifts (Stamina/Multiscale) & field changes "
            "— a heal can flip it. Only survive-1 is exact." ] if head_hits >= 2 else [])
        # The meta attacker stitches independent ability/item/nature marginals onto a real spread row;
        # surface that caveat in assumptions too (matchup already does), not only in evidence.note.
        + (["attacker fields are independent meta marginals — exact ability+item+nature combo may not co-occur"]
           if prov.get("source") == "meta" else [])
        + (["Stealth Rock chip modelled via the type table (opponent SR, singles; chip resolves at "
            "switch-in, so it reads the PRE-Mega typing/abilities)"] if use_sr else [])
        + (["Stealth Rock was explicitly requested but ignored: this tune path only models entry "
            "hazards in singles, so no Stealth Rock chip was applied"] if sr_ignored else [])
        + ([f"{spikes} layer(s) of Spikes chip on grounded targets modelled (pre-Mega form)"] if spikes else [])
        + (["the main cliff assumes 0 Intimidate (conservative); the intimidate lane is the -1 Atk relief"]
           if intimidate_lane else [])
        + ([f"attacker Mega form modelled ({attacker.get('name')}; Mega stats/ability)"]
           if attacker.get("mega_ability") else [])
        + (["Mega form modelled (Mega stats/typing/ability); switch-in abilities also read the base form"]
           if eff["is_mega"] else [])
        + ([mc_note] if mc_note else []),
        "evidence": {"facts": [{"source": "ncp", "ref": "damage rolls"},
                               {"source": "dex", "ref": "defender types/stats"},
                               {"source": "meta", "ref": "attacker modal set"}],
                     "note": (prov.get("note") or "attacker set") + (f" | {mc_note}" if mc_note else "")},
    }
    if sr_ignored:
        card["stealth_rock_requested"] = True
        card["stealth_rock_ignored"] = "doubles_not_modelled"
    if intimidate_lane is not None:
        card["intimidate"] = intimidate_lane

    def _haz_suffix() -> str:
        return (" after Stealth Rock" if use_sr else "") \
            + (f" after {spikes} layer(s) of Spikes" if spikes else "")

    def _stier_phrase(t: dict[str, Any]) -> str:
        r, lab = t["result"], t["label"]
        if r == "already":
            return f"already {lab} ({target}{_haz_suffix()})"
        if r == "unreachable":
            return f"can't {lab} even at {SP_CAP} {dspread} SP"
        if r == "infeasible":
            return f"{lab} needs +{t['delta_sp']} {dspread} SP (to {t['need_total']}) — over the 66 SP budget"
        return f"{lab} at +{t['delta_sp']} {dspread} SP (to {t['need_total']})"

    card.update(result=headline["result"], delta_sp=headline["delta_sp"])
    if headline.get("need_total") is not None:
        card["need_total"] = headline["need_total"]
    if headline.get("slack_sp") is not None:
        card["slack_sp"] = headline["slack_sp"]
    card["note"] = " | ".join(_stier_phrase(t) for t in survive_tiers) + _hp_suffix()

    # Stealth Rock 0/1 dual (§9): when our team-benchmark puts opponent SR on us (opt-in, singles),
    # also solve the headline tier WITHOUT the chip so both hazard states are visible — you may or may not
    # be on SR. Anchored to the headline hits only (NOT crossed with the other tier — §9 no-cross rule).
    if use_sr:
        # The damage rolls don't depend on the chip, so the survive-1 rolls_cache is reused — the
        # no-SR lane costs zero extra engine calls.
        no_sr_min, _ = _survive_min_sp(calc_member, cur_nature, attacker, move, field, dstat, base_sps,
                                       target, defender_types, False, spikes, damage_fn=damage_fn,
                                       damage_batch_fn=damage_batch_fn, hits=head_hits,
                                       precomputed=rolls_cache, hazard_abilities=hazard_abilities)
        card["stealth_rock_lane"] = {"stealth_rock": False, **_outcome(no_sr_min, cur, base_sps)}

    # §16.8 nature lanes: re-solve THIS cliff under candidate natures (reuses the 1-D kernel, no new
    # search dimension) and attach the impactful ones (unlock / save >= floor) as an OPTIONAL sub-field.
    # NEVER enters the head ranking — `nature` is a whole-spread single-slot commitment the model owns.
    # A `locked` member (user declared it won't change) gets no lanes at all.
    if card["result"] in ("cliff", "infeasible", "unreachable") and not locked:
        m_stats = eff["facts"].get("stats") or {}
        lanes = _nature_lanes(
            dspread, cur_nature, cur, base_sps,
            {"result": card["result"], "delta_sp": card["delta_sp"]},
            solve_min_fn=lambda nat: _survive_min_sp(calc_member, nat, attacker, move, field, dstat, base_sps,
                                                     target, defender_types, use_sr, spikes, damage_fn=damage_fn,
                                                     damage_batch_fn=damage_batch_fn, hits=head_hits,
                                                     hazard_abilities=hazard_abilities)[0],
            invested=_invested_stats(member.get("spread")),
            offense_lean=_stat_orientation(m_stats).get("offense_lean"),
            meta_natures=meta_natures or set())
        if lanes["alternatives"]:
            card["nature_alternatives"] = lanes["alternatives"]
        if lanes["notes"]:
            card["nature_notes"] = lanes["notes"]
        if lanes["unlock"]:
            card["nature_unlock"] = True
    return card


def _raw_speed(vs: Any) -> int | None:
    """A benchmark `vs` may be a raw target Speed instead of a species name (schema.md §7)."""
    if isinstance(vs, bool):
        return None
    if isinstance(vs, (int, float)):
        return int(vs)
    if isinstance(vs, str) and vs.strip().lstrip("+").isdigit():
        return int(vs.strip())
    return None


def _outspeed_card(member: dict[str, Any], b: dict[str, Any], prof, *,
                   damage_fn: Callable, move_fn: Callable, dex_fn: Callable,
                   meta_fn: Callable | None = None, meta_natures: set[str] | None = None,
                   locked: bool = False, item_fn: Callable | None = None,
                   team_flags: dict[str, bool] | None = None,
                   effective: dict[str, Any] | None = None) -> dict[str, Any]:
    team_flags = team_flags or {}
    raw_target = _raw_speed(b["vs"])
    eff = effective or _effective_form(member, dex_fn, item_fn)         # my Mega form (Mega base Speed + ability)
    member_label = eff["name"]
    my_base = (eff["facts"].get("stats") or {}).get("spe")
    my_ability = eff["ability"]
    calc_member = _calc_member(member, eff)
    if my_base is None:
        return {"aspect": "speed", "kind": "outspeed", "member": member_label, "vs": b.get("vs"),
                "result": "skipped", "note": "missing base speed for self"}
    facts = dex_fn([b["vs"]]) or {} if raw_target is None else {}

    conds = b.get("conditions") or {}
    trickroom = bool(conds.get("trickroom"))             # opt-in; default off (§9)

    # Target is either a raw Speed value or, for a named species, its conservative max-speed line
    # (max SP + speed nature, to beat the fast variant); distribution coverage is later.
    d_meta = None if raw_target is not None else _meta_set(meta_fn, b["vs"], prof.fmt, None, dex_fn=dex_fn)
    tr_floor_base: int | None = None
    target_is_mega = False
    if raw_target is not None:
        tgt_speed, tgt_label = raw_target, f"{raw_target} Speed"
    else:
        tfacts = facts.get(b["vs"], {}) or {}
        tgt_base = (tfacts.get("stats") or {}).get("spe")
        tgt_name = b["vs"]
        target_item = (d_meta or {}).get("item") if isinstance(d_meta, dict) else None
        tgt_abilities = list(tfacts.get("abilities") or [])
        if tfacts.get("is_mega"):
            target_is_mega = True
            _base_name, _base_facts = _base_form_facts(tgt_name, dex_fn, tfacts)
            base_spe = (_base_facts.get("stats") or {}).get("spe")
            _floor_candidates = [x for x in (tgt_base, base_spe) if x is not None]
            if _floor_candidates:
                tr_floor_base = min(_floor_candidates)
            tgt_abilities += list(_base_facts.get("abilities") or [])
        # Mega-resolve the TARGET (§9 unification — opponents too): the real-team run_form when the
        # library has one, else the meta modal item's stone. The speed line then uses the Mega base
        # Speed, and the weather-ability check reads BOTH forms' abilities (two-place rule) — a base
        # line understates a Mega target (Metagross 70 vs Mega 110) and misses a Mega-only Swift Swim.
        tgt_form = (d_meta or {}).get("run_form") if isinstance(d_meta, dict) else None
        if not tgt_form:
            tgt_form = _mega_form_name(tgt_name, target_item, dex_fn, item_fn, facts=tfacts)
        if tgt_form and tgt_form != tgt_name:
            tform_facts = _dex_facts(tgt_form, dex_fn)
            t_spe = (tform_facts.get("stats") or {}).get("spe")
            if t_spe is not None:
                # Trick Room's floor keeps the SLOWEST plausible form (a Mega can be slower: Abomasnow).
                tr_floor_base = min(x for x in (tr_floor_base, tgt_base, t_spe) if x is not None)
                tgt_base = t_spe
                tgt_name = tgt_form
                target_is_mega = bool(tform_facts.get("is_mega"))
                tgt_abilities += list(tform_facts.get("abilities") or [])
        if tgt_base is None:
            return {"aspect": "speed", "kind": "outspeed", "member": member_label, "vs": b.get("vs"),
                    "result": "skipped", "note": "missing base speed for target"}
        if tr_floor_base is None:
            tr_floor_base = tgt_base
        tgt_speed = champ_speed(tgt_base, SP_CAP, "Jolly")
        tgt_label = f"max-speed {tgt_name}"
        # Opponent Choice Scarf (x1.5): a resolved JOINT set holding Scarf counts even without the
        # marginal top-item flag; a marginal Scarf lane is allowed only when the modelled target is NOT
        # a Mega. A Mega-stone holder cannot also hold Scarf, so stacking the marginal Scarf on the
        # Mega-resolved speed line would synthesize an impossible set.
        scarf = (d_meta or {}).get("choice_scarf") if isinstance(d_meta, dict) else None
        scarf_known = (target_item == "Choice Scarf")
        scarf_marginal = (scarf and (scarf.get("rank") or 99) <= OPPONENT_SCARF_TOP_N
                          and (scarf.get("pct") or 0) > OPPONENT_SCARF_USAGE_FLOOR)
        if not target_is_mega and (scarf_known or scarf_marginal):
            tgt_speed = int(tgt_speed * 1.5)
            pct_note = f"{scarf.get('pct')}% top item" if scarf and scarf.get("pct") is not None else "resolved item"
            tgt_label += f" + Choice Scarf x1.5 ({pct_note})"
        tgt_wmult = max((weather_speed_mult(a, conds.get("weather"), conds.get("terrain"))
                         for a in (tgt_abilities or [None])), default=1)
        if tgt_wmult != 1:
            tgt_speed *= tgt_wmult
            tgt_label += f" (x{tgt_wmult} from its weather/terrain ability)"
    # Opponent Tailwind (x2): modelled but OPT-IN (default off) — only when the benchmark asks, and
    # doubles only (§9). It doubles the target's Speed, including raw-Speed targets.
    if conds.get("opponent_tailwind") and prof.fmt == "double":
        tgt_speed *= 2
        tgt_label += " under their Tailwind (x2)"
    my_nature = member.get("nature")
    base_sps = _sps_from_spread(member.get("spread"))
    cur_sp = base_sps["sp"]
    mc_conf, mc_note = _member_completeness(member)
    # My own weather-speed ability (Swift Swim / Chlorophyll / ...) doubles my Speed when its weather is
    # up (both formats). Folded into self_mult so the cliff is solved off EFFECTIVE Speed, not bare.
    wmult = weather_speed_mult(my_ability, conds.get("weather"), conds.get("terrain"))
    _trig = conds.get("weather") or conds.get("terrain")
    # My Tailwind (x2) comes in two shapes (§9 + schema.md): an EXPLICIT `conditions.tailwind: true`
    # is the user declaring Tailwind IS up — the request always wins, so the MAIN line is solved at x2
    # (no lane needed; this is the pre-refactor behaviour the schema documents). Otherwise the
    # DOUBLES + team-carries gate models it as a DUAL: the raw cliff is the main line, the x2 cliff a
    # lane (both always shown) — you may or may not have Tailwind up.
    tailwind_specified = "tailwind" in conds
    explicit_tailwind = conds.get("tailwind") is True
    my_tailwind = (not tailwind_specified) and team_flags.get("tailwind") and not trickroom

    if trickroom:
        # Trick Room inverts the order: the SLOWER mon acts first, so the goal is to UNDER-speed — and
        # the conservative bound flips with it. To guarantee moving first we must under-speed the
        # target's FLOOR line (0 SP, -Speed nature, slowest form), not the fast line the outspeed goal
        # uses (vs the fast line "already under-speeds" would be the OPTIMISTIC extreme). Scarf /
        # weather / Tailwind only make the target faster (easier to under-speed), so none apply here.
        # Speed SP is a lever to PULL (a -Speed nature under-speeds harder), not add.
        if raw_target is not None:
            tr_target, tr_label = raw_target, f"{raw_target} Speed"
        else:
            tr_target = champ_speed(tr_floor_base, 0, "Brave")
            tr_label = f"floor-speed {b['vs']} (0 SP, -Speed nature, slowest form)"
        my_now = effective_speed(my_base, cur_sp, my_nature, item=member.get("item"),
                                 ability=my_ability, weather=conds.get("weather"),
                                 terrain=conds.get("terrain"), tailwind=explicit_tailwind)
        under = my_now is not None and my_now < tr_target
        tw_tr_note = " under my Tailwind (x2, explicit condition)" if explicit_tailwind else ""
        tr_note = (f"already under-speeds {tr_label} ({my_now} < {tr_target}) — moves first under Trick Room"
                   if under else
                   f"currently {my_now} >= {tr_target}: PULL Speed SP or take a -Speed nature to under-speed "
                   f"{tr_label} under Trick Room")
        return {
            "aspect": "speed", "kind": "outspeed", "member": member_label, "vs": b.get("vs"),
            "trickroom": True, "tailwind": explicit_tailwind,
            "tailwind_mode": "explicit-main" if explicit_tailwind else "none",
            "tailwind_main": explicit_tailwind, "tailwind_lane_available": False,
            "magnitude": 0.7, "prevalence": 0.7, "confidence": mc_conf,
            "result": "already" if under else "unreachable",
            "delta_sp": 0 if under else SP_CAP + 1,
            "needs": None if under else "lower_speed",
            "note": tr_note + tw_tr_note,
            "assumptions": ["Trick Room: UNDER-speeding is the goal (slower acts first)",
                            "target = floor line (0 SP, -Speed nature, slowest form) — the conservative "
                            "bound for under-speeding; the fast line would be optimistic here"]
            + (["my Tailwind applied to the current-speed check (x2 Speed — explicit benchmark condition)"]
               if explicit_tailwind else [])
            + (["Mega form modelled"] if eff["is_mega"] else []) + ([mc_note] if mc_note else []),
            "evidence": {"facts": [{"source": "dex", "ref": "base speeds"},
                                   {"source": "builtin", "ref": "Champions speed formula"}],
                         "note": tr_note + tw_tr_note},
        }

    self_mult = (wmult if wmult else 1) * (2 if explicit_tailwind else 1)
    sol = solve_outspeed(my_base, my_nature, tgt_speed, cap=SP_CAP, self_mult=self_mult,
                         item=member.get("item"))
    sol_tw = solve_outspeed(my_base, my_nature, tgt_speed, cap=SP_CAP, self_mult=self_mult * 2,
                            item=member.get("item")) if my_tailwind else None
    tw_note = (f" under {_trig} ({my_ability} x{wmult} Speed)" if wmult != 1 else "") \
        + (" under my Tailwind (x2, explicit condition)" if explicit_tailwind else "")

    card: dict[str, Any] = {
        "aspect": "speed", "kind": "outspeed", "member": member_label, "vs": b.get("vs"),
        "tailwind": bool(explicit_tailwind or my_tailwind),
        "tailwind_mode": ("explicit-main" if explicit_tailwind else "team-lane" if my_tailwind else "none"),
        "tailwind_main": explicit_tailwind,
        "tailwind_lane_available": bool(my_tailwind),
        "magnitude": 0.7, "prevalence": 0.7,
        "confidence": mc_conf,
        "assumptions": ["target = max-speed +nature (conservative single point)",
                        "main line is SP-only on the current nature; bounded nature lanes are attached "
                        "separately (not a joint nature x SP search)"]
        + (["my Tailwind applied to the MAIN line (x2 Speed — explicit benchmark condition)"]
           if explicit_tailwind else [])
        + (["my Tailwind lane shown as x2 Speed (doubles, team carries Tailwind) — both raw and Tailwind lines"]
           if my_tailwind else [])
        + ([f"my {my_ability} applied (x{wmult} Speed under {_trig})"] if wmult != 1 else [])
        + (["Mega form modelled (Mega base Speed + ability)"] if eff["is_mega"] else [])
        + ([mc_note] if mc_note else []),
        "evidence": {"facts": [{"source": "dex", "ref": "base speeds"},
                               {"source": "builtin", "ref": "Champions speed formula"}],
                     "note": f"vs {tgt_label} +nature target (conservative)" + tw_note
                             + "; distribution coverage is a later increment"
                             + (f" | {mc_note}" if mc_note else "")},
    }
    if my_tailwind:
        # Both lines are ALWAYS presented (§9): even when the x2 line can't reach either, the lane says
        # "unreachable" instead of silently vanishing (the reader must see that Tailwind doesn't save it).
        tw_result = sol_tw.get("result") if sol_tw else None
        _tw_min = sol_tw["sp"] if sol_tw and tw_result in ("outspeed", "tie-only") else None
        lane = {"self_mult": 2,
                "tie_only": bool(tw_result == "tie-only"),
                **_outcome(_tw_min, cur_sp, base_sps)}
        if tw_result == "tie-only":
            lane["result"] = "tie-only"
        card["tailwind_lane"] = lane
    if sol is None:
        card.update(result="unreachable", delta_sp=SP_CAP + 1, decisiveness=0.3,
                    note=f"cannot outspeed {tgt_label} ({tgt_speed}){tw_note} even at {SP_CAP} Speed SP")
    else:
        delta = max(0, sol["sp"] - cur_sp)
        # Spending Speed SP shares the same 66 SP budget as everything else; a cliff that needs more
        # than the budget allows is infeasible, not advice (mirrors the survival path; audit 2026-06-21).
        total_after = sum(base_sps.values()) - cur_sp + max(cur_sp, sol["sp"])
        # Join with a KO check: a speed cliff only matters if moving first flips an outcome.
        decisiveness, ko_note = 0.5, "speed only — couple a move to judge if moving first flips the KO"
        move = b.get("move")
        if move and raw_target is not None:
            ko_note = "speed only — a raw-speed target has no species to run a KO check against"
        if move and raw_target is None:
            mi = (move_fn([move]) or {}).get(move, {})
            cat = (mi.get("category") or "").lower()
            if cat in ("physical", "special"):
                sps = _sps_from_spread(member.get("spread"))
                # Model the opponent with its meta MODAL set (real bulk/ability/item), not a 0-investment
                # naked defender — a naked target turned every fast hit into a false "guaranteed OHKO"
                # (audit retro 2026-06-22). No meta set -> fall back to naked and flag the optimism.
                # Defender is Mega-resolved so a stone-holding target is judged on its Mega bulk/typing.
                if d_meta:
                    defender = _mega_resolve_attacker(
                        {"name": b["vs"], "ability": d_meta.get("ability"), "item": d_meta.get("item"),
                         "nature": d_meta.get("nature") or "Hardy", "sps": d_meta.get("sps") or {},
                         "run_form": d_meta.get("run_form")},
                        dex_fn, item_fn)
                    d_basis = "vs meta modal defender"
                else:
                    defender = {"name": b["vs"], "nature": "Hardy", "sps": {}}
                    d_basis = "vs a 0-investment defender (no meta set) — bulkier real sets may survive"
                # I attack as my Mega form (calc_member); doubles applies the 0.75x spread reduction. (SR
                # rides only the engine ko_chance, not these static rolls, so it isn't wired into this join.)
                rolls, hp = damage_fn(_member_ncp(calc_member, sps), defender, move,
                                      _damage_field(conds, cat, prof.fmt))
                if hp and rolls and min(rolls) >= hp:
                    decisiveness, ko_note = 0.95, f"moving first guarantees the OHKO with {move} — decisive ({d_basis})"
                elif hp and rolls and max(rolls) >= hp:
                    decisiveness, ko_note = 0.7, f"moving first can OHKO with {move} (roll-dependent; {d_basis})"
                else:
                    decisiveness, ko_note = 0.35, f"outspeeding doesn't secure a KO with {move} — matchup stays unclear ({d_basis})"

        card["decisiveness"] = decisiveness
        if delta > 0 and total_after > SP_TOTAL_CAP:
            verb = "tie" if sol["result"] == "tie-only" else "outspeed"
            card.update(result="infeasible", delta_sp=delta, need_total=sol["sp"],
                        note=f"+{delta} Speed SP (to {sol['sp']}) to {verb} {tgt_label} "
                             f"({tgt_speed}) exceeds the 66 SP budget; {ko_note}")
        elif sol["result"] == "tie-only":
            card.update(result="tie-only", delta_sp=delta,
                        note=f"can only tie {tgt_label} ({tgt_speed}){tw_note}; {ko_note}")
        elif delta == 0:
            card.update(result="already", delta_sp=0,
                        note=f"already outspeeds {tgt_label} ({tgt_speed}){tw_note}; {ko_note}")
        else:
            card.update(result="cliff", delta_sp=delta, need_total=sol["sp"],
                        note=f"+{delta} Speed SP (to {sol['sp']}) outspeeds {tgt_label} "
                             f"({tgt_speed}){tw_note}; {ko_note}")

    # §16.8 nature lanes for the Speed cliff (closed-form, near-free): re-solve under candidate natures,
    # attach the impactful ones. A -Speed (Trick Room/weather) member yields no auto speed-nature lane
    # (candidate_natures locks them) yet its EXPLICIT benchmark above is always computed. Locked -> none.
    if card["result"] in ("cliff", "infeasible", "unreachable", "tie-only") and not locked:
        m_stats = eff["facts"].get("stats") or {}

        def _spd_min(nat: str) -> int | None:
            s = solve_outspeed(my_base, nat, tgt_speed, cap=SP_CAP, self_mult=self_mult, item=member.get("item"))
            return s["sp"] if (s and s["result"] == "outspeed") else None

        lanes = _nature_lanes("spe", my_nature, cur_sp, base_sps,
                              {"result": card["result"], "delta_sp": card["delta_sp"]},
                              solve_min_fn=_spd_min, invested=_invested_stats(member.get("spread")),
                              offense_lean=_stat_orientation(m_stats).get("offense_lean"),
                              meta_natures=meta_natures or set())
        if lanes["alternatives"]:
            card["nature_alternatives"] = lanes["alternatives"]
        if lanes["notes"]:
            card["nature_notes"] = lanes["notes"]
        if lanes["unlock"]:
            card["nature_unlock"] = True
    return card


def _kill_min_sp(member: dict[str, Any], nature: str, defender: dict[str, Any], move: str,
                 field: dict[str, Any], off_stat: str, base_sps: dict[str, int], eff_hp: int,
                 hits: int, target: str, *, damage_fn: Callable,
                 damage_batch_fn: Callable | None,
                 precomputed: dict | None = None) -> tuple[int | None, dict, dict]:
    """Min `off_stat` (Atk/SpD... Atk or SpA) SP for `member` UNDER `nature` to KO `defender` (the
    mirror of _survive_min_sp: vary the ATTACKER's offensive stat, damage is monotonic in it, one
    batch [0..cap] feeds the search). KO predicate = ko_roll(rolls,target) * hits >= eff_hp (STATIC).

    Returns (min_sp, rolls_cache, kochance_cache). The batch also carries the engine's recovery-aware
    `ko_chance` per SP point — captured so the caller can annotate the static cliff with the real verdict
    (the static band repeats hit 1 and over-counts KOs vs a recovering target; §7 boundary). The rolls
    don't depend on `eff_hp`/`hits`, so a prior tier's rolls_cache can be passed back as `precomputed`
    (same attacker/field/nature) — e.g. the no-SR dual lane re-solves against a different eff_hp for free."""
    m = member if nature == (member.get("nature") or "Hardy") else {**member, "nature": nature}

    def _attacker(total: int):
        sps = dict(base_sps); sps[off_stat] = total
        return _member_ncp(m, sps)

    rolls_cache: dict[int, list[int]] = precomputed if precomputed is not None else {}
    kochance_cache: dict[int, dict] = {}
    if precomputed is None and damage_batch_fn is not None:
        reqs = [{"attacker": _attacker(t), "defender": defender, "move": move, "field": field}
                for t in range(SP_CAP + 1)]
        for t, r in enumerate(damage_batch_fn(reqs) or []):
            dmg = list((r or {}).get("damage", []))
            if dmg:
                rolls_cache[t] = dmg
            kc = (r or {}).get("ko_chance")
            if kc:
                kochance_cache[t] = kc

    def predicate(total: int) -> bool:
        rolls = rolls_cache.get(total)
        if rolls is None:
            rolls, _hp = damage_fn(_attacker(total), defender, move, field)
        return bool(rolls) and ko_roll(rolls, target) * hits >= eff_hp

    return solve_min_sp(predicate, cap=SP_CAP), rolls_cache, kochance_cache


def _kill_card(member: dict[str, Any], b: dict[str, Any], prof, *,
               damage_fn: Callable, move_fn: Callable, dex_fn: Callable,
               meta_fn: Callable | None = None, meta_natures: set[str] | None = None,
               locked: bool = False, damage_batch_fn: Callable | None = None,
               item_fn: Callable | None = None,
               team_flags: dict[str, bool] | None = None,
               effective: dict[str, Any] | None = None) -> dict[str, Any]:
    """Kill cliff: min Atk/SpA SP for the member's move to break a named target (its meta MODAL
    defensive set, Mega-resolved). BOTH KO tiers are solved — the OHKO and the guaranteed 2HKO (the
    usual 'break the wall' standard) — and shown with a NO-TUNING subsumption: the 2HKO is hidden ONLY
    when the OHKO is ALREADY secured at the current spread (no SP), so the cheaper breakthrough line is
    never buried when the OHKO needs tuning or is out of reach (re-audit 2026-07-07). Mirror of the
    survival cliff on the offense side; benchmark-driven (target is explicit). `slack_sp` on an
    `already` tier is the reverse/over-investment margin (SP pullable while still securing the KO)."""
    team_flags = team_flags or {}
    kind = b.get("kind")
    move = b.get("move")
    mi = (move_fn([move]) or {}).get(move, {}) if move else {}
    cat = (mi.get("category") or "").lower()
    eff = effective or _effective_form(member, dex_fn, item_fn)          # OUR attacker's Mega form (Mega stats/ability)
    calc_member = _calc_member(member, eff)
    member_label = eff["name"]
    base = {"aspect": "offense", "kind": kind, "member": member_label, "vs": b.get("vs"), "move": move}
    if cat not in ("physical", "special"):
        return {**base, "result": "skipped", "note": "move missing/non-damaging; cannot solve a kill cliff"}

    off_stat, off_spread = OFF_SPS[cat], OFF_SPREAD[cat]
    target = b.get("probability", "guaranteed")
    conds = b.get("conditions") or {}
    # OUR Stealth Rock chips the TARGET (helps the KO). An EXPLICIT benchmark condition wins (schema:
    # "the user's request always wins" — `stealth_rock: false` turns the chip OFF even when the team
    # carries SR, `true` asserts the rocks are up); absent, the default is the team-carries gate. Either
    # way it is a SINGLES model (doubles entry hazards are marginal — a capability boundary, not a
    # default). A Magic Guard target is exempt inside _sr_chip. Spikes stays default-off (conds-driven).
    # field.format applies the doubles spread-move reduction to our own move (a spread KO move deals
    # 0.75x too).
    sr_cond = conds.get("stealth_rock")
    sr_ignored = sr_cond is True and prof.fmt != "single"
    use_sr = (bool(sr_cond) if sr_cond is not None else bool(team_flags.get("stealth_rock"))) \
        and prof.fmt == "single"
    spikes = _spikes_layers(conds)
    field = _damage_field(conds, cat, prof.fmt, use_sr=use_sr, spikes=spikes)

    d_meta = _meta_set(meta_fn, b["vs"], prof.fmt, None, dex_fn=dex_fn)
    if d_meta:
        base_ability = (((d_meta.get("set") or {}).get("ability") or {}).get("name")
                        if isinstance(d_meta.get("set"), dict) else None)
        defender0 = {"name": b["vs"], "ability": d_meta.get("ability"), "item": d_meta.get("item"),
                     "nature": d_meta.get("nature") or "Hardy", "sps": d_meta.get("sps") or {},
                     "run_form": d_meta.get("run_form"), "base_ability": base_ability}
        d_prov = {"source": d_meta.get("source") or "meta", "confidence": d_meta.get("confidence", "medium"),
                  "note": d_meta.get("note"), "prevalence": d_meta.get("prevalence")}
    else:
        defender0 = {"name": b["vs"], "nature": "Hardy", "sps": {}}
        d_prov = {"source": "synthetic", "confidence": "low",
                  "note": "no meta set for the target; 0-investment defender — a real bulky set survives more"}
    defender = _mega_resolve_attacker(defender0, dex_fn, item_fn)     # target's Mega form (bulk/ability)

    mc_conf, mc_note = _member_completeness(member)
    base_sps = _sps_from_spread(member.get("spread"))
    cur = base_sps[off_stat]
    cur_nature = member.get("nature") or "Hardy"
    # Hazards chip the target at SWITCH-IN (pre-Mega): typing = the BASE species' (b['vs'] — a
    # Charizard-X target takes SR on Fire/Flying, not Fire/Dragon), and the immunity check carries the
    # §9 two-place ability set — the resolved (in-calc) ability unconditionally, the pre-Mega base
    # ability ungated for a real-team set and at >= the usage floor for a meta marginal.
    target_base_name = defender.get("base_name") or _base_form_name(b["vs"], dex_fn)
    target_types = list((_dex_facts(target_base_name, dex_fn).get("types")) or [])
    d_haz_abilities = _hazard_abilities_for_modeled_set(defender, d_meta, d_prov)

    # Target HP is fixed (nature changes the ATTACKER, not the target); entry hazards chip the
    # target before we hit, which HELPS the KO (the mirror of survive's hazards, which chipped US).
    _probe, target_hp = damage_fn(_member_ncp(calc_member, base_sps), defender, move, field)
    if not target_hp:
        return {**base, "result": "skipped", "note": "could not resolve the target's HP"}
    spikes_chip = _spikes_chip(target_types, target_hp, spikes, abilities=d_haz_abilities,
                               item=defender.get("item"))
    hazard_chip = (_sr_chip(target_types, target_hp, abilities=d_haz_abilities) if use_sr else 0) \
        + spikes_chip
    eff_hp = target_hp - hazard_chip

    # Solve BOTH KO tiers (OHKO, guaranteed 2HKO) at the requested probability.
    ko_min: dict[int, int | None] = {}
    tiers: dict[int, dict[str, Any]] = {}
    rolls_cache: dict[int, list[int]] = {}
    engine_koc: dict[int, dict] = {}
    for h in (1, 2):
        # The rolls don't depend on `hits`, so tier 2 reuses tier 1's batch (mirror of the survive side).
        mt, _c, koc = _kill_min_sp(calc_member, cur_nature, defender, move, field, off_stat, base_sps,
                                   eff_hp, h, target, damage_fn=damage_fn, damage_batch_fn=damage_batch_fn,
                                   precomputed=rolls_cache if h == 2 else None)
        ko_min[h] = mt
        if h == 1:
            rolls_cache, engine_koc = _c, koc
        t = {"hits": h, "label": "OHKO" if h == 1 else "2HKO", "ko_exact": h == 1, **_outcome(mt, cur, base_sps)}
        if t["result"] == "already" and mt is not None:        # slack = pullable SP while still securing it
            t["slack_sp"] = cur - mt
        # The engine ko_chance rides the batch result (per SP point), which tier 2 reuses from tier 1 —
        # read it from the h=1 capture so both tiers stay annotated.
        eng = engine_koc.get(mt) if mt is not None else None
        if eng:
            t["engine_ko_chance"] = eng
        tiers[h] = t
    # No-tuning subsumption: hide the 2HKO ONLY when the OHKO is ALREADY secured without spending SP.
    # Otherwise show both — a 2HKO reachable at a cheaper SP than an OHKO that needs tuning must not
    # be buried (the user's 'break the wall' standard is usually the 2HKO).
    ohko_already = tiers[1]["result"] == "already"
    ko_tiers = [tiers[1]] if ohko_already else [tiers[1], tiers[2]]
    headline = tiers[1] if ohko_already else tiers[2]         # cheapest meaningful tier
    hits, label, min_total = headline["hits"], headline["label"], ko_min[headline["hits"]]

    card: dict[str, Any] = {
        **base, "category": cat, "stat": off_spread, "hits": hits, "probability": target,
        "stealth_rock": use_sr, "spikes": spikes, "ko_tiers": ko_tiers,
        # Only an OHKO is exact. A 2HKO predicate is `ko_roll * 2 >= hp` — static: it repeats the first
        # hit and does NOT model between-turn recovery (Sitrus/Leftovers), ability shifts (Draco Meteor /
        # Stamina / Multiscale), recoil or field changes, so it can claim a KO that a berry denies (audit
        # 2026-06-24). Surfaced as a flag + assumption, not silently sold as a guaranteed 2HKO.
        "ko_exact": hits == 1,
        "magnitude": 1.0 if hits == 1 else 0.8,
        # `or` guards an injected meta set carrying an explicit None (would crash score_card).
        "prevalence": d_prov.get("prevalence") or 0.7,
        "decisiveness": 0.9,                   # securing a KO flips the exchange
        "confidence": completeness.min_confidence(d_prov.get("confidence", "medium"), mc_conf),
        "defender": {"source": d_prov.get("source"), "ability": defender.get("ability"),
                     "item": defender.get("item"), "nature": defender.get("nature"), "sps": defender.get("sps")},
        "assumptions": [f"target = {d_prov.get('source')} defensive set"]
        + (["both KO tiers solved; the 2HKO is hidden only when the OHKO is already secured without tuning"])
        + (["STATIC 2HKO approximation: repeats hit 1; ignores between-turn recovery (Sitrus/Leftovers), "
            "ability shifts (Draco Meteor / Stamina / Multiscale), recoil & field changes — a berry/heal "
            "can deny it. Only OHKO is exact."] if any(t["hits"] >= 2 for t in ko_tiers) else [])
        + (["defender fields are independent meta marginals — exact ability+item+nature combo may not co-occur"]
           if d_prov.get("source") == "meta" else [])
        + (["our Stealth Rock chip on the target modelled (singles; explicit condition wins, else "
            "team-carries; chip resolves at switch-in — pre-Mega typing/abilities)"] if use_sr else [])
        + (["Stealth Rock was explicitly requested but ignored: this tune path only models entry "
            "hazards in singles, so no Stealth Rock chip was applied"] if sr_ignored else [])
        + ([f"{spikes} layer(s) of Spikes chip on grounded targets modelled (pre-Mega form)"] if spikes else [])
        + (["target Mega form modelled (Mega stats/typing/ability)"] if defender.get("mega_ability") else [])
        + (["Mega form modelled for our attacker"] if eff["is_mega"] else [])
        + ([mc_note] if mc_note else []),
        "evidence": {"facts": [{"source": "ncp", "ref": "damage rolls"},
                               {"source": "dex", "ref": "target types/stats"},
                               {"source": "meta", "ref": "target modal defensive set"}],
                     "note": (d_prov.get("note") or "target set") + (f" | {mc_note}" if mc_note else "")},
    }
    if sr_ignored:
        card["stealth_rock_requested"] = True
        card["stealth_rock_ignored"] = "doubles_not_modelled"

    def _hazard_suffix() -> str:
        return (" after Stealth Rock" if use_sr else "") + (f" after {spikes} layer(s) of Spikes" if spikes else "")

    def _tier_phrase(t: dict[str, Any]) -> str:
        r, lab = t["result"], t["label"]
        if r == "already":
            return f"already {lab}s {b['vs']} ({target}{_hazard_suffix()})"
        if r == "unreachable":
            return f"cannot {lab} even at {SP_CAP} {off_spread} SP"
        if r == "infeasible":
            return f"{lab} needs +{t['delta_sp']} {off_spread} SP (to {t['need_total']}) — over the 66 SP budget"
        return f"{lab} at +{t['delta_sp']} {off_spread} SP (to {t['need_total']})"

    card.update(result=headline["result"], delta_sp=headline["delta_sp"])
    if headline.get("need_total") is not None:
        card["need_total"] = headline["need_total"]
    if headline.get("slack_sp") is not None:
        card["slack_sp"] = headline["slack_sp"]
    card["note"] = " | ".join(_tier_phrase(t) for t in ko_tiers)

    # Stealth Rock 0/1 dual (§9, mirror of the survive side): when the SR chip is in the KO math, also
    # solve the headline tier WITHOUT it — the rocks may not be up when the KO matters, and a KO that
    # exists only after the chip must be visible as such. Anchored to the headline hits (no-cross rule);
    # only the SR chip flips (Spikes stays as conditioned). Rolls don't depend on the chip, so the
    # tier-1 rolls_cache is reused — zero extra engine calls.
    if use_sr:
        no_sr_min, _rc, _kc = _kill_min_sp(calc_member, cur_nature, defender, move, field, off_stat,
                                           base_sps, target_hp - spikes_chip, hits, target,
                                           damage_fn=damage_fn, damage_batch_fn=damage_batch_fn,
                                           precomputed=rolls_cache)
        card["stealth_rock_lane"] = {"stealth_rock": False, **_outcome(no_sr_min, cur, base_sps)}

    # Recovery-aware engine verdict at the headline tier's SP (the static multi-hit band over-counts KOs
    # vs a recovering target; §7). Trust ko_chance over the static 2HKO cliff.
    engine_ko = headline.get("engine_ko_chance")
    if engine_ko:
        card["engine_ko_chance"] = engine_ko
    if engine_ko and hits >= 2 and not engine_ko.get("guaranteed"):
        card["assumptions"].append(
            f"engine recovery-aware KO% at {min_total} {off_spread} SP = {engine_ko.get('chance_pct')}% "
            f"(n={engine_ko.get('n')}, NOT guaranteed): the target's between-turn recovery can deny this "
            f"static {label} — trust ko_chance over the static cliff.")

    # §16.8 nature lanes re-solve the HEADLINE tier's cliff under candidate natures.
    if card["result"] in ("cliff", "infeasible", "unreachable") and not locked:
        m_stats = eff["facts"].get("stats") or {}
        lanes = _nature_lanes(
            off_spread, cur_nature, cur, base_sps,
            {"result": card["result"], "delta_sp": card["delta_sp"]},
            solve_min_fn=lambda nat: _kill_min_sp(calc_member, nat, defender, move, field, off_stat, base_sps,
                                                  eff_hp, hits, target, damage_fn=damage_fn,
                                                  damage_batch_fn=damage_batch_fn)[0],
            invested=_invested_stats(member.get("spread")),
            offense_lean=_stat_orientation(m_stats).get("offense_lean"),
            meta_natures=meta_natures or set())
        if lanes["alternatives"]:
            card["nature_alternatives"] = lanes["alternatives"]
        if lanes["notes"]:
            card["nature_notes"] = lanes["notes"]
        if lanes["unlock"]:
            card["nature_unlock"] = True
    return card


def _team_provides_intimidate(team: dict[str, Any], dex_fn: Callable,
                              item_fn: Callable | None,
                              eff_by_member: dict[int, dict[str, Any]] | None = None) -> bool:
    """Does our team carry an Intimidate provider? Checks BOTH each member's declared (base) ability
    AND its Mega ability (a base-Intimidate mon that Megas away still intimidates at switch-in; a base
    mon that Megas INTO Intimidate re-triggers it on Mega Evolution) — §9 both-sides rule."""
    for m in team.get("pokemon", []):
        if _ability_key(m.get("ability")) == "intimidate":
            return True
        eff = (eff_by_member or {}).get(id(m)) or _effective_form(m, dex_fn, item_fn)
        if _ability_key(eff.get("mega_ability")) == "intimidate":
            return True
    return False


def _team_has_move(team: dict[str, Any], move: str) -> bool:
    """Does any team member carry `move` (e.g. Tailwind / Stealth Rock) — the team-carries gate for a
    field effect we can only rely on when we can actually set it up."""
    return any(move in (m.get("moves") or []) for m in team.get("pokemon", []))


def tune(team: dict[str, Any], benchmarks: list[dict[str, Any]], *, fmt: str | None = None,
         damage_fn: Callable, move_fn: Callable, dex_fn: Callable,
         meta_fn: Callable | None = None, nature_dist_fn: Callable | None = None,
         locked: list[str] | None = None, damage_batch_fn: Callable | None = None,
         item_fn: Callable | None = None) -> dict[str, Any]:
    prof = get_profile(fmt or team.get("format"))
    dex_fn = _memoized_batch_lookup(dex_fn) or dex_fn
    move_fn = _memoized_batch_lookup(move_fn) or move_fn
    item_fn = _memoized_batch_lookup(item_fn) if item_fn else None
    meta_fn = _memoized_meta_lookup(meta_fn)
    members = {m.get("species"): m for m in team.get("pokemon", [])}
    member_aliases: dict[int, list[str]] = {}
    member_effective: dict[int, dict[str, Any]] = {}

    def _uniq(names: list[str | None]) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for n in names:
            if n and n not in seen:
                out.append(n)
                seen.add(n)
        return out

    for m in team.get("pokemon", []):
        eff: dict[str, Any] | None = None
        try:
            eff = _effective_form(m, dex_fn, item_fn)
            member_effective[id(m)] = eff
        except Exception:
            pass
        aliases = _uniq([m.get("species"), m.get("name"),
                         eff.get("name") if eff else None,
                         eff.get("base_name") if eff else None])
        member_aliases[id(m)] = aliases
        for a in aliases:
            members.setdefault(a, m)
    # Team-level field gates (computed once): our Intimidate provider and our Tailwind / Stealth Rock
    # setters. A field effect is only modelled when we can actually put it up (re-audit 2026-07-07).
    team_flags = {
        "intimidate": prof.fmt == "double" and _team_provides_intimidate(
            team, dex_fn, item_fn, eff_by_member=member_effective),
        "tailwind": prof.fmt == "double" and _team_has_move(team, "Tailwind"),
        "stealth_rock": prof.fmt == "single" and _team_has_move(team, "Stealth Rock"),
    }
    locked_set = set(locked or [])
    locked_members = {id(m) for m in team.get("pokemon", [])
                      if set(member_aliases.get(id(m), [])) & locked_set}
    nat_cache: dict[str, dict[str, float]] = {}

    def _member_natures(member: dict[str, Any]) -> dict[str, float]:
        """The member species' meta natures -> usage % (best-effort) — the §16.8 reality gate AND the
        source of each lane's `meta_pct`. Keep the DICT (don't collapse to a set): candidate_natures
        uses it as a membership gate (`n in dist`) but also reads the % so a 2%-run lane isn't shown as
        equal to a 60%-run one (audit 2026-06-24 — the old set() dropped meta_pct)."""
        species = member.get("species")
        names = member_aliases.get(id(member), [species])
        # Meta panels usually key a singles Mega under its base species, while the real-team library may
        # surface the Mega name. Try the authored/effective aliases first, then the base alias.
        key = "|".join(n for n in names if n)
        if key not in nat_cache:
            try:
                # Keep the fn's return AS-IS: nature_distribution gives {EN: pct} (carries meta_pct);
                # don't collapse to a set (that dropped the %). candidate_natures handles dict-or-set.
                dist = {}
                if nature_dist_fn:
                    for n in names:
                        dist = nature_dist_fn(n, prof.fmt) or {}
                        if dist:
                            break
                nat_cache[key] = dist
            except Exception:
                nat_cache[key] = {}
        return nat_cache[key]

    cards: list[dict[str, Any]] = []
    notes: list[str] = []
    any_lane = False
    seen_kill_benchmarks: set[str] = set()
    for b in benchmarks:
        sp = b.get("member")
        member = members.get(sp)
        if not member:
            notes.append(f"benchmark member '{sp}' not in team; skipped")
            continue
        kind = b.get("kind")
        m_locked, mnat = id(member) in locked_members, _member_natures(member)
        if kind == "survive":
            cards.append(_survive_card(member, b, prof, damage_fn=damage_fn, move_fn=move_fn,
                                       dex_fn=dex_fn, meta_fn=meta_fn, meta_natures=mnat,
                                       locked=m_locked, damage_batch_fn=damage_batch_fn,
                                       item_fn=item_fn, team_flags=team_flags,
                                       effective=member_effective.get(id(member))))
        elif kind == "outspeed":
            cards.append(_outspeed_card(member, b, prof, damage_fn=damage_fn, move_fn=move_fn,
                                        dex_fn=dex_fn, meta_fn=meta_fn, meta_natures=mnat, locked=m_locked,
                                        item_fn=item_fn, team_flags=team_flags,
                                        effective=member_effective.get(id(member))))
        elif kind in KILL_HITS:                # ohko / 2hko
            # A kill card already solves and displays both OHKO and 2HKO tiers. If the caller supplies
            # the same benchmark twice with only `kind` changed, the second one is a byte-level duplicate
            # apart from the heading and wastes a second [0..32] batch.
            kill_key = json.dumps({k: v for k, v in b.items() if k != "kind"},
                                  sort_keys=True, ensure_ascii=False, default=str)
            if kill_key in seen_kill_benchmarks:
                notes.append(f"duplicate kill benchmark for member '{sp}' vs '{b.get('vs')}' "
                             f"move '{b.get('move')}' skipped; one card already shows OHKO and 2HKO tiers")
                continue
            seen_kill_benchmarks.add(kill_key)
            cards.append(_kill_card(member, b, prof, damage_fn=damage_fn, move_fn=move_fn,
                                    dex_fn=dex_fn, meta_fn=meta_fn, meta_natures=mnat,
                                    locked=m_locked, damage_batch_fn=damage_batch_fn,
                                    item_fn=item_fn, team_flags=team_flags,
                                    effective=member_effective.get(id(member))))
        else:
            notes.append(f"benchmark kind '{kind}' not supported (survive/outspeed/ohko/2hko)")
        any_lane = any_lane or bool(cards and cards[-1].get("nature_alternatives"))

    ranked = rank_cards(cards, prof.aspect_weight)
    notes.append("Cliff cards are objective facts ranked by cheapness x prevalence x magnitude x decisiveness "
                 "(weighted by the format's aspect_priority). Pick which cliffs to spend the 66 SP budget on — "
                 "the tool does not choose for you, and competing cliffs share the budget.")
    if any_lane:
        notes.append("`nature_alternatives` on a card are NATURE LANES: the same cliff solved "
                     "under a different nature, kept only when it unlocks an unreachable cliff or frees >=8 SP. "
                     "They are opportunity-cost facts (the penalty stat is shown), NEVER ranked or recommended — "
                     "a nature change is a whole-spread, single-slot commitment that is yours to make.")
    return {"kind": "tune", "format": prof.fmt, "cards": ranked, "notes": notes}


def format_tune_md(d: dict[str, Any]) -> str:
    lines = [f"# {i18n.t('tn_title', fmt=d['format'])}"]
    if not d["cards"]:
        lines.append("\n" + i18n.t("tn_no_cards"))
    for c in d["cards"]:
        who = f" {c['member']}" if c.get("member") else ""
        head = f"- [{c.get('score', 0):.3f}] **{c['aspect']}/{c['kind']}**{who} vs {c.get('vs')}"
        if c.get("move"):
            head += f" ({c['move']})"
        if c.get("nature_unlock"):
            head += "  " + i18n.t("tn_nature_unlock_tag")
        lines.append(head + f" — {c.get('result')}: {c.get('note', '')}")
        ek = c.get("engine_ko_chance")
        if ek:
            verdict = (i18n.t("tn_guaranteed") if ek.get("guaranteed")
                       else i18n.t("tn_not_guaranteed", pct=ek.get('chance_pct')))
            note = ("  — " + i18n.t("tn_recovery_note")
                    if not ek.get("guaranteed") and c.get("hits", 1) >= 2 else "")
            lines.append(f"    · {i18n.t('tn_engine_ko')}: {verdict}{note}")

        # Secondary lanes (0/1 duals, anchored to the headline tier — never crossed with the other tier).
        def _lane_verdict(L: dict[str, Any]) -> str:
            r = L.get("result")
            if r == "already":
                return f"{r}"
            if r in ("cliff", "infeasible"):
                need = i18n.t("tn_need_to", total=L["need_total"]) if L.get("need_total") is not None else ""
                return f"{r} (+{L.get('delta_sp')} SP{need})"
            return f"{r}"
        for key, lane in (("tn_intimidate_lane", c.get("intimidate")),
                          ("tn_tailwind_lane", c.get("tailwind_lane")),
                          ("tn_sr_lane", c.get("stealth_rock_lane"))):
            if lane:
                lines.append(f"    · {i18n.t(key)}: {_lane_verdict(lane)}")
        for alt in c.get("nature_alternatives", []):
            tag = i18n.t("tn_unlocks") if alt.get("unlock") else i18n.t("tn_saves_sp", n=alt.get('saves_sp'))
            need = i18n.t("tn_need_to", total=alt['need_total']) if alt.get("need_total") is not None else ""
            lines.append(f"    · {i18n.t('tn_nature_lane')} **{alt['nature']}**: {alt['result']} (+{alt.get('delta_sp')} SP{need}; "
                         f"{tag}) — {i18n.t('tn_opportunity_cost')}: {alt['opportunity_cost']}")
        for n in c.get("nature_notes", []):
            lines.append(f"    · {i18n.t('tn_nature_note')}: {n}")
    if d.get("notes"):
        lines.append("\n## " + i18n.t("notes"))
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)
