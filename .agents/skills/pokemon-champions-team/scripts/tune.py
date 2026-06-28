#!/usr/bin/env python
"""tune operator (design.md §16): SP fine-tuning as cliff detection.

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

import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cliffs import (  # noqa: E402
    SP_CAP, champ_speed, solve_outspeed, solve_min_sp, survival_prob, meets_target, ko_roll,
    defensive_headroom, rank_cards, candidate_natures, weather_speed_mult,
)
from context_profile import get_profile  # noqa: E402
from typechart import effectiveness  # noqa: E402
from rules import get_ruleset  # noqa: E402
from diagnose import _stat_orientation  # noqa: E402  (reuse the base-stat offense lean, design §16.8)
import completeness  # noqa: E402

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
        return ({"name": species, **attacker_set},
                {"source": "explicit", "confidence": "high",
                 "note": "attacker set supplied by the caller"})
    if meta_set:
        return ({"name": species, "ability": meta_set.get("ability"), "item": meta_set.get("item"),
                 "nature": meta_set.get("nature") or "Hardy", "sps": meta_set.get("sps") or {}},
                {"source": "meta", "confidence": meta_set.get("confidence", "medium"),
                 "note": meta_set.get("note"), "prevalence": meta_set.get("prevalence")})
    off = OFF_SPS.get(category, "at")
    return ({"name": species, "ability": None, "item": None,
             "nature": OFF_NATURE.get(category, "Hardy"), "sps": {off: SP_CAP}},
            {"source": "synthetic", "confidence": "low",
             "note": "no meta set for this attacker; synthetic max-offense, abilities/items NOT "
                     "modelled — a real set (e.g. Huge Power) may hit far harder"})


def _meta_set(meta_fn: Callable | None, species: str, fmt: str | None,
              attacker_set: dict[str, Any] | None) -> dict[str, Any] | None:
    """Fetch the meta modal set, defensively: an explicit set skips it, and a meta outage
    falls through to the synthetic attacker rather than crashing the whole tune call."""
    if attacker_set or not meta_fn:
        return None
    try:
        return meta_fn(species, fmt)
    except Exception:
        return None


def _member_completeness(member: dict[str, Any]) -> tuple[str, str | None]:
    """(confidence cap, note) for tuning off this member's set. Tuning off a set we don't fully
    know (unknown ability/nature/spread) is a guess, so cap confidence accordingly (audit point 8)."""
    has_moves = bool(member.get("moves"))
    lvl = member.get("completeness")
    if completeness.set_authoritative(lvl, has_moves=has_moves):
        return "high", None
    eff = completeness.effective_level(lvl, has_moves=has_moves)
    return (completeness.confidence_floor(lvl, has_moves=has_moves),
            f"member set not fully known (completeness={eff}); its ability/nature/spread may be assumed")


def _sr_chip(types: list[str], hp: int) -> int:
    """Stealth Rock chip = 1/8 * Rock effectiveness of max HP (type-based), floored."""
    mult = effectiveness("Rock", [t for t in types if t])
    return int(hp * (1 / 8) * mult)


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


def _damage_field(conds: dict[str, Any], category: str) -> dict[str, Any]:
    """Translate explicit benchmark conditions into the ncp field schema (audit 2026-06-21).

    Conditions that the engine needs go here: weather (a named string), screens (defender-side
    Reflect / Light Screen / Aurora Veil), and Stealth Rock. SR is residual chip, not a damage
    modifier — it leaves the raw `damage` rolls and `defenderHP` untouched (those are read by the
    static cliffs, which apply SR themselves via `_sr_chip`/`eff_hp`) and only feeds the engine's
    recovery-aware `ko_chance`, so the 4d engine KO% accounts for the same SR the static cliff does
    instead of silently reporting a no-SR number (audit 2026-06-27). It rides the DEFENDER side in
    both cliffs: the chipped Pokemon is always the ncp `defender` (survive: our member; kill: the
    target), and ncp reads SR from the side (`defenderSide.stealthRock` -> handlerSide.isSR), never
    a top-level field key. Tailwind / Trick Room don't change damage, so they live in the speed cliff.
    Conditions are applied only when the benchmark sets them explicitly — the format profile informs
    ranking, it never silently turns a condition on/off."""
    field: dict[str, Any] = {}
    weather = conds.get("weather")
    if isinstance(weather, str) and weather:
        field["weather"] = weather
    def_side: dict[str, Any] = {}
    scr = conds.get("screens")
    if scr:
        def_side.update(_screen_side(scr, category))
    if conds.get("stealth_rock"):
        def_side["stealthRock"] = True
    if def_side:
        field["defenderSide"] = def_side
    return field


def _survive_min_sp(member: dict[str, Any], nature: str, attacker: dict[str, Any], move: str,
                    field: dict[str, Any], dstat: str, base_sps: dict[str, int], target: str,
                    defender_types: list[str], use_sr: bool, *, damage_fn: Callable,
                    damage_batch_fn: Callable | None) -> tuple[int | None, dict]:
    """Min `dstat` SP for `member` UNDER `nature` to meet the survival target vs `attacker`; returns
    (min_total, rolls_cache). The defender's nature scales its Def/SpD so each nature re-batches; the
    incoming damage is monotonic in `dstat` SP, so one batch [0..cap] feeds the binary search. This is
    the per-nature kernel the baseline card and every §16.8 nature lane share."""
    m = member if nature == (member.get("nature") or "Hardy") else {**member, "nature": nature}

    def _defender(total: int):
        sps = dict(base_sps); sps[dstat] = total
        return _member_ncp(m, sps)

    rolls_cache: dict[int, tuple[list[int], int]] = {}
    if damage_batch_fn is not None:
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
        eff_hp = hp - (_sr_chip(defender_types, hp) if use_sr else 0)
        return meets_target(survival_prob(rolls, eff_hp), target)

    return solve_min_sp(predicate, cap=SP_CAP), rolls_cache


def _survive_card(member: dict[str, Any], b: dict[str, Any], prof, *,
                  damage_fn: Callable, move_fn: Callable, dex_fn: Callable,
                  meta_fn: Callable | None = None, meta_natures: set[str] | None = None,
                  locked: bool = False,
                  damage_batch_fn: Callable | None = None) -> dict[str, Any]:
    move = b.get("move")
    mi = (move_fn([move]) or {}).get(move, {}) if move else {}
    cat = (mi.get("category") or "").lower()
    if cat not in ("physical", "special"):
        return {"aspect": "defense", "kind": "survive", "vs": b.get("vs"), "move": move,
                "result": "skipped", "note": "move missing/non-damaging; cannot solve a survival cliff"}

    dstat, dspread = DEF_SPS[cat], DEF_SPREAD[cat]
    if move in PHYS_DEF_SPECIAL_MOVES:           # special move, but it hits Def — pressure Def, not SpD
        dstat, dspread = "df", "def"
    target = b.get("probability", "guaranteed")
    conds = b.get("conditions") or {}
    # Conditions are applied only when the benchmark sets them explicitly (the user's request wins;
    # the profile informs ranking, not application). Stealth Rock is chip damage handled below;
    # weather/screens go through the ncp field schema.
    use_sr = bool(conds.get("stealth_rock"))
    field = _damage_field(conds, cat)

    meta_set = _meta_set(meta_fn, b["vs"], prof.fmt, b.get("attacker_set"))
    attacker, prov = _attacker_ncp(b["vs"], cat, b.get("attacker_set"), meta_set)
    mc_conf, mc_note = _member_completeness(member)
    base_sps = _sps_from_spread(member.get("spread"))
    cur = base_sps[dstat]
    defender_types = ((dex_fn([member["species"]]) or {}).get(member["species"], {}) or {}).get("types", [])

    # Only `dstat` (Def or SpD, never HP) varies across the SP search, so the incoming damage is
    # monotonic in SP and one batch [0..cap] feeds the search (the kernel handles batch-vs-live).
    cur_nature = member.get("nature") or "Hardy"
    min_total, rolls_cache = _survive_min_sp(member, cur_nature, attacker, move, field, dstat,
                                             base_sps, target, defender_types, use_sr,
                                             damage_fn=damage_fn, damage_batch_fn=damage_batch_fn)

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
        cur_rolls, cur_hp = damage_fn(attacker, _member_ncp(member, base_sps), move, field)
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
            eff = mhp - (_sr_chip(defender_types, mhp) if use_sr else 0)
            return meets_target(survival_prob(cur_rolls, eff), target)

        min_hp = solve_min_sp(_hp_pred, cap=SP_CAP)
        if min_hp is None:
            hp_lane = {"stat": "hp", "result": "unreachable", "delta_sp": SP_CAP + 1}
        else:
            hp_delta = max(0, min_hp - cur_hp_sp)
            hp_after = sum(base_sps.values()) - cur_hp_sp + max(cur_hp_sp, min_hp)
            hp_res = "already" if hp_delta == 0 else ("infeasible" if hp_after > SP_TOTAL_CAP else "cliff")
            hp_lane = {"stat": "hp", "result": hp_res, "delta_sp": hp_delta, "need_total": min_hp}

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
        "aspect": "defense", "kind": "survive", "vs": b.get("vs"), "move": move,
        "category": cat, "stat": dspread, "probability": target,
        "stealth_rock": use_sr, "headroom": defensive_headroom(
            ((dex_fn([member["species"]]) or {}).get(member["species"], {}) or {}).get("stats", {})),
        "magnitude": 1.0 if target == "guaranteed" else 0.8,
        # Prevalence = how common this threat/set actually is: meta supplies it; otherwise the
        # benchmark was user-deemed relevant (0.7 baseline).
        "prevalence": prov.get("prevalence", 0.7),
        "decisiveness": 0.8,      # surviving -> you get to act
        # Confidence = the more cautious of the attacker-set confidence and the tuned member's own
        # set completeness (tuning off an unknown spread/ability is a guess).
        "confidence": completeness.min_confidence(prov.get("confidence", "medium"), mc_conf),
        "attacker": {"source": prov.get("source"), "ability": attacker.get("ability"),
                     "item": attacker.get("item"), "nature": attacker.get("nature"),
                     "sps": attacker.get("sps")},
        "hp_lane": hp_lane,
        "assumptions": [f"attacker = {prov.get('source')} set"]
        # The meta attacker stitches independent ability/item/nature marginals onto a real spread row;
        # surface that caveat in assumptions too (matchup already does), not only in evidence.note.
        + (["attacker fields are independent meta marginals — exact ability+item+nature combo may not co-occur"]
           if prov.get("source") == "meta" else [])
        + (["Stealth Rock chip modelled via the type table"] if use_sr else [])
        + ([mc_note] if mc_note else []),
        "evidence": {"facts": [{"source": "ncp", "ref": "damage rolls"},
                               {"source": "dex", "ref": "defender types/stats"},
                               {"source": "meta", "ref": "attacker modal set"}],
                     "note": (prov.get("note") or "attacker set") + (f" | {mc_note}" if mc_note else "")},
    }
    if min_total is None:
        card.update(result="unreachable", delta_sp=SP_CAP + 1,
                    note=f"cannot reach '{target}' survival even at {SP_CAP} {dspread} SP" + _hp_suffix())
    else:
        delta = max(0, min_total - cur)
        total_after = sum(base_sps.values()) - cur + max(cur, min_total)
        if delta == 0:
            card.update(result="already", note=f"current {cur} {dspread} SP already meets '{target}'",
                        delta_sp=0, slack_sp=cur - min_total)
        elif total_after > SP_TOTAL_CAP:
            card.update(result="infeasible", delta_sp=delta,
                        note=f"needs +{delta} {dspread} SP (to {min_total}) but that exceeds the 66 SP budget"
                             + _hp_suffix())
        else:
            card.update(result="cliff", delta_sp=delta, need_total=min_total,
                        note=f"+{delta} {dspread} SP (to {min_total}) reaches '{target}' survival"
                             + (" after Stealth Rock" if use_sr else "") + _hp_suffix())

    # §16.8 nature lanes: re-solve THIS cliff under candidate natures (reuses the 1-D kernel, no new
    # search dimension) and attach the impactful ones (unlock / save >= floor) as an OPTIONAL sub-field.
    # NEVER enters the head ranking — `nature` is a whole-spread single-slot commitment the model owns.
    # A `locked` member (user declared it won't change) gets no lanes at all.
    if card["result"] in ("cliff", "infeasible", "unreachable") and not locked:
        m_stats = ((dex_fn([member["species"]]) or {}).get(member["species"], {}) or {}).get("stats", {})
        lanes = _nature_lanes(
            dspread, cur_nature, cur, base_sps,
            {"result": card["result"], "delta_sp": card["delta_sp"]},
            solve_min_fn=lambda nat: _survive_min_sp(member, nat, attacker, move, field, dstat, base_sps,
                                                     target, defender_types, use_sr, damage_fn=damage_fn,
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
                   locked: bool = False) -> dict[str, Any]:
    raw_target = _raw_speed(b["vs"])
    lookup = [member["species"]] + ([] if raw_target is not None else [b["vs"]])
    facts = dex_fn(lookup) or {}
    my_base = ((facts.get(member["species"], {}) or {}).get("stats") or {}).get("spe")
    if my_base is None:
        return {"aspect": "speed", "kind": "outspeed", "vs": b.get("vs"),
                "result": "skipped", "note": "missing base speed for self"}

    conds = b.get("conditions") or {}
    # Trick Room inverts the speed objective (slower acts first), so an "outspeed" cliff no longer
    # applies — surface that honestly instead of computing a misleading normal-order line.
    if conds.get("trickroom"):
        return {"aspect": "speed", "kind": "outspeed", "vs": b.get("vs"), "result": "skipped",
                "note": "Trick Room inverts speed order; a normal outspeed cliff doesn't apply "
                        "(under-speeding is the goal) — not modelled in v1"}

    # Target is either a raw Speed value or, for a named species, its conservative max-speed line
    # (max SP + speed-boosting nature, to beat the fast variant); distribution coverage is later.
    if raw_target is not None:
        tgt_speed, tgt_label = raw_target, f"{raw_target} Speed"
    else:
        tgt_base = ((facts.get(b["vs"], {}) or {}).get("stats") or {}).get("spe")
        if tgt_base is None:
            return {"aspect": "speed", "kind": "outspeed", "vs": b.get("vs"),
                    "result": "skipped", "note": "missing base speed for target"}
        tgt_speed = champ_speed(tgt_base, SP_CAP, "Jolly")
        tgt_label = f"max-speed {b['vs']}"
        # Apply the TARGET's own weather/terrain speed ability when the benchmark's weather/terrain is
        # up: ignoring an opponent Swift Swim in rain isn't "conservative", it under-states the target
        # and can produce a false already/outspeed (audit 2026-06-24). Take the max over its dex
        # abilities (assume the fast variant — that's the conservative outspeed target).
        tgt_wmult = max((weather_speed_mult(a, conds.get("weather"), conds.get("terrain"))
                         for a in (((facts.get(b["vs"], {}) or {}).get("abilities")) or [None])), default=1)
        if tgt_wmult != 1:
            tgt_speed *= tgt_wmult
            tgt_label += f" (x{tgt_wmult} from its weather/terrain ability)"
    my_nature = member.get("nature")
    base_sps = _sps_from_spread(member.get("spread"))
    cur_sp = base_sps["sp"]
    mc_conf, mc_note = _member_completeness(member)
    # Tailwind on my side doubles my final Speed; apply it when the benchmark asks for it.
    self_mult = 2 if conds.get("tailwind") else 1
    tw_note = " under my Tailwind" if conds.get("tailwind") else ""
    # My own weather-speed ability (Swift Swim / Chlorophyll / Sand Rush / Slush Rush / Surge Surfer)
    # doubles my Speed when its weather is up — fold it into self_mult so the outspeed cliff is solved
    # off effective Speed, not bare Speed (audit 2026-06-24; mirrors the Choice Scarf / Tailwind fixes).
    # Scope = MY ability only; the target stays the conservative max-speed line (its own weather ability
    # is not modelled, kept deliberately conservative).
    wmult = weather_speed_mult(member.get("ability"), conds.get("weather"), conds.get("terrain"))
    self_mult *= wmult
    _trig = conds.get("weather") or conds.get("terrain")
    wx_note = (f" under {_trig} ({member.get('ability')} x{wmult} Speed)" if wmult != 1 else "")
    tw_note += wx_note
    # Apply my own always-on Speed item (Choice Scarf) — solving the cliff off bare Speed ignored it
    # and over-stated the SP needed (audit retro 2026-06-22).
    sol = solve_outspeed(my_base, my_nature, tgt_speed, cap=SP_CAP, self_mult=self_mult,
                         item=member.get("item"))

    card: dict[str, Any] = {
        "aspect": "speed", "kind": "outspeed", "vs": b.get("vs"), "tailwind": bool(conds.get("tailwind")),
        "magnitude": 0.7, "prevalence": 0.7,
        # Base speeds are exact, but my current Speed SP / nature come from the member's set; if that
        # set isn't fully known the cliff is computed off assumed values, so cap confidence.
        "confidence": mc_conf,
        "assumptions": ["target = max-speed +nature (conservative single point)",
                        "main line is SP-only on the current nature; bounded nature lanes are attached "
                        "separately (not a joint nature x SP search)"]
        + (["my Tailwind applied (x2 Speed)"] if conds.get("tailwind") else [])
        + ([f"my {member.get('ability')} applied (x{wmult} Speed under {_trig})"] if wmult != 1 else [])
        + ([mc_note] if mc_note else []),
        "evidence": {"facts": [{"source": "dex", "ref": "base speeds"},
                               {"source": "builtin", "ref": "Champions speed formula"}],
                     "note": f"vs {tgt_label} +nature target (conservative)" + tw_note
                             + "; distribution coverage is a later increment"
                             + (f" | {mc_note}" if mc_note else "")},
    }
    if sol is None:
        card.update(result="unreachable", delta_sp=SP_CAP + 1, decisiveness=0.3,
                    note=f"cannot outspeed {tgt_label} ({tgt_speed}){tw_note} even at {SP_CAP} Speed SP")
    else:
        delta = max(0, sol["sp"] - cur_sp)
        # Spending Speed SP shares the same 66 SP budget as everything else; a cliff that needs more
        # than the budget allows is infeasible, not advice (mirrors the survival path; audit 2026-06-21).
        total_after = sum(base_sps.values()) - cur_sp + max(cur_sp, sol["sp"])
        # Join with a KO check (design.md §16.2): a speed cliff only matters if moving first flips an outcome.
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
                d_meta = _meta_set(meta_fn, b["vs"], prof.fmt, None)
                if d_meta:
                    defender = {"name": b["vs"], "ability": d_meta.get("ability"), "item": d_meta.get("item"),
                                "nature": d_meta.get("nature") or "Hardy", "sps": d_meta.get("sps") or {}}
                    d_basis = "vs meta modal defender"
                else:
                    defender = {"name": b["vs"], "nature": "Hardy", "sps": {}}
                    d_basis = "vs a 0-investment defender (no meta set) — bulkier real sets may survive"
                rolls, hp = damage_fn(_member_ncp(member, sps), defender, move, {})
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
        m_stats = (facts.get(member["species"], {}) or {}).get("stats", {})

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
                 damage_batch_fn: Callable | None) -> tuple[int | None, dict, dict]:
    """Min `off_stat` (Atk/SpD... Atk or SpA) SP for `member` UNDER `nature` to KO `defender` (the
    mirror of _survive_min_sp: vary the ATTACKER's offensive stat, damage is monotonic in it, one
    batch [0..cap] feeds the search). KO predicate = ko_roll(rolls,target) * hits >= eff_hp (STATIC).

    Returns (min_sp, rolls_cache, kochance_cache). The batch also carries the engine's recovery-aware
    `ko_chance` per SP point — captured so the caller can annotate the static cliff with the real verdict
    (the static band repeats hit 1 and over-counts KOs vs a recovering target; §7 boundary)."""
    m = member if nature == (member.get("nature") or "Hardy") else {**member, "nature": nature}

    def _attacker(total: int):
        sps = dict(base_sps); sps[off_stat] = total
        return _member_ncp(m, sps)

    rolls_cache: dict[int, list[int]] = {}
    kochance_cache: dict[int, dict] = {}
    if damage_batch_fn is not None:
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
               locked: bool = False, damage_batch_fn: Callable | None = None) -> dict[str, Any]:
    """Kill cliff (design §16.2): min Atk/SpA SP for the member's move to OHKO/2HKO a named target
    (its meta MODAL defensive set). Mirror of the survival cliff on the offense side; benchmark-driven
    (the target is explicit), so it never auto-discovers threats (§16.1). `slack_sp` on an `already`
    card is the reverse/over-investment 'margin' signal (SP pullable while still securing the KO)."""
    kind = b.get("kind")
    move = b.get("move")
    mi = (move_fn([move]) or {}).get(move, {}) if move else {}
    cat = (mi.get("category") or "").lower()
    base = {"aspect": "offense", "kind": kind, "vs": b.get("vs"), "move": move}
    if cat not in ("physical", "special"):
        return {**base, "result": "skipped", "note": "move missing/non-damaging; cannot solve a kill cliff"}

    off_stat, off_spread = OFF_SPS[cat], OFF_SPREAD[cat]
    hits, label = KILL_HITS.get(kind, 1), kind.upper()
    target = b.get("probability", "guaranteed")
    conds = b.get("conditions") or {}
    use_sr = bool(conds.get("stealth_rock"))
    field = _damage_field(conds, cat)          # weather + the TARGET's screens reduce our damage

    d_meta = _meta_set(meta_fn, b["vs"], prof.fmt, None)
    if d_meta:
        defender = {"name": b["vs"], "ability": d_meta.get("ability"), "item": d_meta.get("item"),
                    "nature": d_meta.get("nature") or "Hardy", "sps": d_meta.get("sps") or {}}
        d_prov = {"source": "meta", "confidence": d_meta.get("confidence", "medium"),
                  "note": d_meta.get("note"), "prevalence": d_meta.get("prevalence")}
    else:
        defender = {"name": b["vs"], "nature": "Hardy", "sps": {}}
        d_prov = {"source": "synthetic", "confidence": "low",
                  "note": "no meta set for the target; 0-investment defender — a real bulky set survives more"}

    mc_conf, mc_note = _member_completeness(member)
    base_sps = _sps_from_spread(member.get("spread"))
    cur = base_sps[off_stat]
    cur_nature = member.get("nature") or "Hardy"
    target_types = ((dex_fn([b["vs"]]) or {}).get(b["vs"], {}) or {}).get("types", [])

    # Target HP is fixed (nature changes the ATTACKER, not the target); Stealth Rock chips the target
    # before we hit, which HELPS the KO (the mirror of survive's SR, which chipped US).
    _probe, target_hp = damage_fn(_member_ncp(member, base_sps), defender, move, field)
    if not target_hp:
        return {**base, "result": "skipped", "note": "could not resolve the target's HP"}
    eff_hp = target_hp - (_sr_chip(target_types, target_hp) if use_sr else 0)

    min_total, _cache, kochance_cache = _kill_min_sp(
        member, cur_nature, defender, move, field, off_stat, base_sps,
        eff_hp, hits, target, damage_fn=damage_fn, damage_batch_fn=damage_batch_fn)

    card: dict[str, Any] = {
        **base, "category": cat, "stat": off_spread, "hits": hits, "probability": target,
        "stealth_rock": use_sr,
        # Only an OHKO is exact. A 2HKO predicate is `ko_roll * 2 >= hp` — static: it repeats the first
        # hit and does NOT model between-turn recovery (Sitrus/Leftovers), ability shifts (Draco Meteor /
        # Stamina / Multiscale), recoil or field changes, so it can claim a KO that a berry denies (audit
        # 2026-06-24). Surfaced as a flag + assumption, not silently sold as a guaranteed 2HKO.
        "ko_exact": hits == 1,
        "magnitude": 1.0 if hits == 1 else 0.8,
        "prevalence": d_prov.get("prevalence", 0.7),
        "decisiveness": 0.9,                   # securing a KO flips the exchange
        "confidence": completeness.min_confidence(d_prov.get("confidence", "medium"), mc_conf),
        "defender": {"source": d_prov.get("source"), "ability": defender.get("ability"),
                     "item": defender.get("item"), "nature": defender.get("nature"), "sps": defender.get("sps")},
        "assumptions": [f"target = {d_prov.get('source')} defensive set"]
        + ([f"STATIC {label} approximation: repeats hit 1; ignores between-turn recovery "
            "(Sitrus/Leftovers), ability shifts (Draco Meteor / Stamina / Multiscale), recoil & field "
            "changes — a berry/heal can deny this KO. Only OHKO is exact."] if hits >= 2 else [])
        + (["defender fields are independent meta marginals — exact ability+item+nature combo may not co-occur"]
           if d_prov.get("source") == "meta" else [])
        + (["Stealth Rock chip on the target modelled via the type table"] if use_sr else [])
        + ([mc_note] if mc_note else []),
        "evidence": {"facts": [{"source": "ncp", "ref": "damage rolls"},
                               {"source": "dex", "ref": "target types/stats"},
                               {"source": "meta", "ref": "target modal defensive set"}],
                     "note": (d_prov.get("note") or "target set") + (f" | {mc_note}" if mc_note else "")},
    }
    if min_total is None:
        card.update(result="unreachable", delta_sp=SP_CAP + 1,
                    note=f"cannot {label} {b['vs']} with {move} even at {SP_CAP} {off_spread} SP "
                         f"({target}{' after Stealth Rock' if use_sr else ''})")
    else:
        delta = max(0, min_total - cur)
        total_after = sum(base_sps.values()) - cur + max(cur, min_total)
        if delta == 0:
            card.update(result="already", delta_sp=0, slack_sp=cur - min_total,
                        note=f"current {cur} {off_spread} SP already {label}s {b['vs']} ({target}); "
                             f"{cur - min_total} {off_spread} SP is slack (pullable, still {label}s)")
        elif total_after > SP_TOTAL_CAP:
            card.update(result="infeasible", delta_sp=delta,
                        note=f"needs +{delta} {off_spread} SP (to {min_total}) to {label} {b['vs']} but that "
                             f"exceeds the 66 SP budget")
        else:
            card.update(result="cliff", delta_sp=delta, need_total=min_total,
                        note=f"+{delta} {off_spread} SP (to {min_total}) {label}s {b['vs']} ({target}"
                             f"{' after Stealth Rock' if use_sr else ''})")

    # Annotate the static cliff with the engine's recovery-aware verdict at the solved SP (mirrors
    # matchup: static band = the headline, ko_chance = the real verdict). The static multi-hit predicate
    # repeats hit 1 and ignores between-turn recovery, so a berry/heal can deny a 2HKO it claims (§7).
    engine_ko = kochance_cache.get(min_total) if min_total is not None else None
    if engine_ko:
        card["engine_ko_chance"] = engine_ko
        if hits >= 2 and not engine_ko.get("guaranteed"):
            card["assumptions"].append(
                f"engine recovery-aware KO% at {min_total} {off_spread} SP = {engine_ko.get('chance_pct')}% "
                f"(n={engine_ko.get('n')}, NOT guaranteed): the target's between-turn recovery can deny this "
                f"static {label} — trust ko_chance over the static cliff.")

    if card["result"] in ("cliff", "infeasible", "unreachable") and not locked:
        m_stats = ((dex_fn([member["species"]]) or {}).get(member["species"], {}) or {}).get("stats", {})
        lanes = _nature_lanes(
            off_spread, cur_nature, cur, base_sps,
            {"result": card["result"], "delta_sp": card["delta_sp"]},
            solve_min_fn=lambda nat: _kill_min_sp(member, nat, defender, move, field, off_stat, base_sps,
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


def tune(team: dict[str, Any], benchmarks: list[dict[str, Any]], *, fmt: str | None = None,
         damage_fn: Callable, move_fn: Callable, dex_fn: Callable,
         meta_fn: Callable | None = None, nature_dist_fn: Callable | None = None,
         locked: list[str] | None = None, damage_batch_fn: Callable | None = None) -> dict[str, Any]:
    prof = get_profile(fmt or team.get("format"))
    members = {m.get("species"): m for m in team.get("pokemon", [])}
    locked_set = set(locked or [])
    nat_cache: dict[str, dict[str, float]] = {}

    def _member_natures(species: str) -> dict[str, float]:
        """The member species' meta natures -> usage % (best-effort) — the §16.8 reality gate AND the
        source of each lane's `meta_pct`. Keep the DICT (don't collapse to a set): candidate_natures
        uses it as a membership gate (`n in dist`) but also reads the % so a 2%-run lane isn't shown as
        equal to a 60%-run one (audit 2026-06-24 — the old set() dropped meta_pct)."""
        if species not in nat_cache:
            try:
                # Keep the fn's return AS-IS: nature_distribution gives {EN: pct} (carries meta_pct);
                # don't collapse to a set (that dropped the %). candidate_natures handles dict-or-set.
                nat_cache[species] = nature_dist_fn(species, prof.fmt) if nature_dist_fn else {}
            except Exception:
                nat_cache[species] = {}
        return nat_cache[species]

    cards: list[dict[str, Any]] = []
    notes: list[str] = []
    any_lane = False
    for b in benchmarks:
        sp = b.get("member")
        member = members.get(sp)
        if not member:
            notes.append(f"benchmark member '{sp}' not in team; skipped")
            continue
        kind = b.get("kind")
        m_locked, mnat = sp in locked_set, _member_natures(sp)
        if kind == "survive":
            cards.append(_survive_card(member, b, prof, damage_fn=damage_fn, move_fn=move_fn,
                                       dex_fn=dex_fn, meta_fn=meta_fn, meta_natures=mnat,
                                       locked=m_locked, damage_batch_fn=damage_batch_fn))
        elif kind == "outspeed":
            cards.append(_outspeed_card(member, b, prof, damage_fn=damage_fn, move_fn=move_fn,
                                        dex_fn=dex_fn, meta_fn=meta_fn, meta_natures=mnat, locked=m_locked))
        elif kind in KILL_HITS:                # ohko / 2hko
            cards.append(_kill_card(member, b, prof, damage_fn=damage_fn, move_fn=move_fn,
                                    dex_fn=dex_fn, meta_fn=meta_fn, meta_natures=mnat,
                                    locked=m_locked, damage_batch_fn=damage_batch_fn))
        else:
            notes.append(f"benchmark kind '{kind}' not supported (survive/outspeed/ohko/2hko)")
        any_lane = any_lane or bool(cards and cards[-1].get("nature_alternatives"))

    ranked = rank_cards(cards, prof.aspect_weight)
    notes.append("Cliff cards are objective facts ranked by cheapness x prevalence x magnitude x decisiveness "
                 "(weighted by the format's aspect_priority). Pick which cliffs to spend the 66 SP budget on — "
                 "the tool does not choose for you, and competing cliffs share the budget.")
    if any_lane:
        notes.append("`nature_alternatives` on a card are NATURE LANES (design §16.8): the same cliff solved "
                     "under a different nature, kept only when it unlocks an unreachable cliff or frees >=8 SP. "
                     "They are opportunity-cost facts (the penalty stat is shown), NEVER ranked or recommended — "
                     "a nature change is a whole-spread, single-slot commitment that is yours to make.")
    return {"kind": "tune", "format": prof.fmt, "cards": ranked, "notes": notes}


def format_tune_md(d: dict[str, Any]) -> str:
    lines = [f"# Tune — SP fine-tuning cliffs ({d['format']})"]
    if not d["cards"]:
        lines.append("\nNo cliff cards (no benchmarks resolved).")
    for c in d["cards"]:
        head = f"- [{c.get('score', 0):.3f}] **{c['aspect']}/{c['kind']}** vs {c.get('vs')}"
        if c.get("move"):
            head += f" ({c['move']})"
        if c.get("nature_unlock"):
            head += "  [a nature lane can UNLOCK this]"
        lines.append(head + f" — {c.get('result')}: {c.get('note', '')}")
        ek = c.get("engine_ko_chance")
        if ek:
            verdict = ("guaranteed" if ek.get("guaranteed")
                       else f"{ek.get('chance_pct')}% (NOT guaranteed)")
            note = ("  — recovery (berry/Leftovers) can deny the static KO; trust this"
                    if not ek.get("guaranteed") and c.get("hits", 1) >= 2 else "")
            lines.append(f"    · engine KO% (recovery-aware) at the cliff: {verdict}{note}")
        for alt in c.get("nature_alternatives", []):
            tag = "UNLOCKS" if alt.get("unlock") else f"saves {alt.get('saves_sp')} SP"
            need = f" to {alt['need_total']}" if alt.get("need_total") is not None else ""
            lines.append(f"    · nature lane **{alt['nature']}**: {alt['result']} (+{alt.get('delta_sp')} SP{need}; "
                         f"{tag}) — opportunity cost: {alt['opportunity_cost']}")
        for n in c.get("nature_notes", []):
            lines.append(f"    · nature note: {n}")
    if d.get("notes"):
        lines.append("\n## Notes")
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)
