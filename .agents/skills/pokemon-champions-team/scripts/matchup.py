#!/usr/bin/env python
"""Matchup-vs-meta-top-K (M2 L2; design.md §6 L2) — OBJECTIVE FACTS ONLY.

For each of the team's members, report objective matchup facts against the meta's most-used
Pokemon: who outspeeds whom, how the opponent's STAB types hit us (type level), and how hard our
member's own moves hit the opponent's modal set (damage, via ncp). It assigns NO matchup score,
ranks NO member or opponent, and names NO "best" anything (design §0) — it lays out facts the AI
reasons over.

Discipline / boundary (mirrors metalink.py):
  - the opponent LIST is the meta USAGE ranking — a published fact ("most-used"), not a synthesized
    threat assessment. It is NOT the marginal-mode threat auto-discovery that design §16.1/§10
    forbids for tune's SP optimization: here every opponent is named, and we only *report* facts,
    never optimize a spread against them.
  - each opponent's SET is metalink's modal set (the sanctioned "set for an explicitly-named
    species"), carried with its usage % and the marginal-independence caveat. Matchup facts that
    depend on it are therefore medium/low confidence, never certified.
  - our side uses the registered team's ACTUAL set (the moves/nature/SP as brought).

Speed is the integer-exact Champions closed form (cliffs.champ_speed). Type effectiveness is the
built-in chart (typechart). Damage is the sibling ncp calculator, batched in one subprocess
(ncplink.damage_batch) so a members x opponents matrix is a single node call. All external lookups
are injected (dex_fn / set_fn / damage_fn) so the logic is unit-testable offline.
"""
from __future__ import annotations

from math import ceil
from typing import Any, Callable

from cliffs import champ_speed, effective_speed, solve_outspeed, SPEED_ITEM_MULT, SP_CAP
from typechart import effectiveness_for_member
from rules import get_ruleset

SP_TOTAL_CAP = get_ruleset().sp_total_cap          # 66 SP across all stats (the real spend ceiling)
_NEG_SPE_NATURES = {"Brave", "Relaxed", "Quiet", "Sassy"}   # -Speed: a fast variant is unrealistic

# Any KO that needs 2+ turns is a STATIC approximation: it repeats the first hit's damage and does NOT
# model what actually happens between turns. Only OHKO is exact (audit 2026-06-24 — the calc's raw
# damage band can't be a real "guaranteed 2HKO").
_NHKO_CAVEAT = ("static N-hit approximation — repeats the first hit's damage; ignores between-turn "
                "recovery (Sitrus / Leftovers), attacker/defender ability shifts (Draco Meteor / "
                "Stamina / Multiscale), recoil, status and field changes. Only OHKO is exact.")

# team-json spread keys -> ncp SP keys (metalink already emits ncp keys for opponent sets).
_SPREAD_TO_SPS = {"hp": "hp", "atk": "at", "def": "df", "spa": "sa", "spd": "sd", "spe": "sp"}


def _to_sps(spread: dict[str, Any] | None) -> dict[str, int]:
    if not spread:
        return {}
    return {_SPREAD_TO_SPS[k]: int(v or 0) for k, v in spread.items() if k in _SPREAD_TO_SPS}


def _hko(n: int | None) -> str | None:
    return None if n is None else {1: "OHKO", 2: "2HKO", 3: "3HKO"}.get(n, f"{n}HKO")


def _ko_buckets(min_percent: float | None, max_percent: float | None) -> tuple[int | None, int | None]:
    """(possible, guaranteed) KO-hit counts from the damage band. `possible` uses the best roll (high
    roll, fewest hits); `guaranteed` uses the worst roll (low roll still KOs). Per-hit-independent
    approximation — ignores between-hit Leftovers/Life-Orb recoil (same simplification as the calc)."""
    def hits(p: float | None) -> int | None:
        return ceil(100.0 / p) if (p and p > 0) else None
    return hits(max_percent), hits(min_percent)


def _is_static_nhko(possible: int | None, guaranteed: int | None) -> bool:
    """True when the KO needs 2+ turns (so it's a static multi-turn approximation, not exact)."""
    worst = guaranteed if guaranteed is not None else possible
    return bool(worst and worst >= 2)


def _ko_label(possible: int | None, guaranteed: int | None) -> str | None:
    """'2HKO' when the band agrees, else 'possible 2HKO / guaranteed 3HKO' (honest about roll spread).
    A KO needing 2+ turns is tagged '(static approx)' — it isn't an engine-grade probability (audit
    2026-06-24); only OHKO is exact."""
    if possible is None:
        return None
    base = _hko(possible) if possible == guaranteed else (
        f"possible {_hko(possible)} / guaranteed {_hko(guaranteed)}")
    return base + (" (static approx)" if _is_static_nhko(possible, guaranteed) else "")


def _threat_moves(opp_set: dict | None) -> list[dict[str, Any]]:
    """them->us threat surface: the BROAD meta >=15% damaging moves (`threat_moves` from the resolver,
    which already unions in real-team joint moves), falling back to `moves` for a meta-only set. Never
    the real-team JOINT 4-move set alone — that under-covers the threat space (research 2026-06-24)."""
    if not opp_set:
        return []
    return opp_set.get("threat_moves") or opp_set.get("moves") or []


def _dmg_fact(move: str, r: dict[str, Any], **extra: Any) -> dict[str, Any]:
    """One damage fact from an ncp result: roll band + possible/guaranteed KO buckets (both rolls),
    NOT a single max-roll headline. `extra` carries direction-specific fields (e.g. usage_pct)."""
    mn, mx = r.get("minPercent"), r.get("maxPercent")    # CENTRAL (expected-hit) band, for context
    hits, hr = r.get("hits"), r.get("hits_range")
    env_lo, env_hi = r.get("min_env_percent"), r.get("max_env_percent")
    span: dict[str, Any] = {}
    # Variable multi-hit: use the calc's TRUE damage envelope (computed from real per-hit damage — the
    # cumulative escalating sums for Triple Axel, lo/hi x roll for uniform moves), NOT a linear ratio
    # of the central band (which was wrong for escalating-BP moves; audit 2026-06-24). KO buckets then
    # span hit-count variance honestly; the central band is kept for reference.
    if (isinstance(hr, (list, tuple)) and len(hr) == 2 and hr[1] > hr[0]
            and env_lo is not None and env_hi is not None):
        span = {"hits": hits, "hits_range": [hr[0], hr[1]],
                "central_percent": [mn, mx]}
        mn, mx = env_lo, env_hi
    elif isinstance(hits, int) and hits > 1:
        span = {"hits": hits}                       # fixed multi-hit: count only, band already total
    poss, guar = _ko_buckets(mn, mx)
    fact = {"move": move, "min_percent": mn, "max_percent": mx,
            "ko_possible": poss, "ko_guaranteed": guar, "ko": _ko_label(poss, guar),
            "ko_exact": poss == 1 and guar == 1,        # only a clean OHKO is engine-exact
            **span, **extra}
    # The engine's recovery-aware KO verdict (models Sitrus/Leftovers/hazards) — authoritative for the
    # KO QUESTION on N>=2, where the static band can't see between-turn heals (audit 2026-06-24). The
    # static band/buckets stay as the damage RANGE; ko_chance is the real verdict.
    ko_chance = r.get("ko_chance")
    if ko_chance:
        fact["ko_chance"] = ko_chance
    # Static-KO reliability flags from the calc (DETECTED, not modelled): effects that make the static
    # multi-turn KO unreliable + which DIRECTION it's off (self/target stat-change, Stamina, Multiscale,
    # Sash/Disguise, Knock Off, speed-BP, ...). The AI reader uses these to chain explicit-state
    # snapshots or caveat, rather than the tool pretending to simulate (audit 2026-06-24).
    ko_caveats = r.get("ko_caveats")
    if ko_caveats:
        fact["ko_caveats"] = ko_caveats
    if _is_static_nhko(poss, guar):
        fact["ko_caveat"] = _NHKO_CAVEAT + (" See ko_chance for the recovery-aware verdict."
                                            if ko_chance else "")
    return fact


def _speed_coverage(my_speed: int | None, my_base: int | None, my_spe_sp: int, nature: str | None,
                    item: str | None, opp_lines: list[dict[str, int | None]],
                    total_sp: int = 0) -> dict[str, Any] | None:
    """§16.5 speed-as-coverage: where the member sits in the opponent speed FIELD. Each opponent is NOT
    a single point but a small spread — its MODAL speed (typical build) and its WORST-CASE fast variant
    (max Spe SP + a speed-positive nature, x1.5 if it runs Choice Scarf). We report coverage at BOTH so
    'I outspeed the modal' isn't misread as 'I outspeed all of it', plus the opponents whose fast
    variant FLIPS the matchup (audit 2026-06-24). `opp_lines` = [{modal, fast}], already excluding
    no-meta-set opponents (unknown speed must not count). Jumps are checked vs the 66 SP TOTAL budget.

    Scope honesty: EQUAL-WEIGHT across opponents — meta exposes no per-species usage %, so the field
    isn't usage-weighted (we will NOT fabricate a weight from rank). modal/fast is the realistic
    envelope, not a full nature/item/SP probability distribution."""
    modal = [o["modal"] for o in opp_lines if o.get("modal") is not None]
    if my_speed is None or my_base is None or not modal:
        return None
    of = len(modal)
    out = sum(1 for s in modal if my_speed > s)
    ties = sum(1 for s in modal if my_speed == s)
    # Worst case: count vs each opponent's FAST variant (fall back to its modal when no fast line).
    fast = [(o.get("fast") if o.get("fast") is not None else o["modal"])
            for o in opp_lines if o.get("modal") is not None]
    out_worst = sum(1 for s in fast if my_speed > s)
    flips = sum(1 for o in opp_lines if o.get("modal") is not None and o.get("fast") is not None
                and my_speed > o["modal"] and my_speed <= o["fast"])
    other_sp = max(0, total_sp - my_spe_sp)            # SP spent outside Speed (fixed while Speed varies)
    # Next clusters = distinct MODAL speeds we don't yet beat (the actionable, typical arms race),
    # ascending; cost the cheapest few jumps within the 66 SP budget. Fast variants are often
    # unreachable even maxed, so the worst-case numbers above carry that risk instead of empty jumps.
    jumps: list[dict[str, Any]] = []
    for tgt in sorted({s for s in modal if s >= my_speed})[:3]:
        sol = solve_outspeed(my_base, nature, tgt, item=item)
        if sol and sol["result"] == "outspeed":
            new_speed = sol["achieved"]
            total_after = other_sp + sol["sp"]
            jumps.append({"clears": tgt, "speed_sp": sol["sp"],
                          "delta_sp": max(0, sol["sp"] - my_spe_sp), "achieved": new_speed,
                          "outspeeds_after": sum(1 for s in modal if new_speed > s),
                          "outspeeds_after_worst": sum(1 for s in fast if new_speed > s),
                          "total_sp_after": total_after,
                          "feasible": total_after <= SP_TOTAL_CAP})
    return {"outspeeds": out, "ties": ties, "of": of, "percent": round(100.0 * out / of, 1),
            "outspeeds_worst": out_worst, "percent_worst": round(100.0 * out_worst / of, 1),
            "fast_variant_flips": flips,        # opponents I beat at modal speed but lose to fast variant
            "weighting": "equal-weight across top-K opponents (meta has no per-species usage %)",
            "anchors": {"speed_0_sp": champ_speed(my_base, 0, nature),
                        "speed_max_sp": champ_speed(my_base, SP_CAP, nature)},
            "next_jumps": jumps,
            "note": "speed field coverage at MODAL (typical) and WORST-CASE fast variant (max Spe + "
                    "speed nature, x1.5 if Choice Scarf). `fast_variant_flips` = opponents you outspeed "
                    "at modal but lose to their fast build — the multi-peak that a single point hides. "
                    "Equal-weight across opponents (no per-species usage %); next_jumps target the next "
                    "MODAL clusters (the actionable, typical arms race) and are checked vs the 66 SP "
                    "budget — each jump also reports outspeeds_after_worst (its coverage vs the fast "
                    "variants). Stable stances: full-speed entry vs bypassing speed (priority / Tailwind "
                    "/ Trick Room / switching)."}


def matchup(team: dict[str, Any], top_k: list[dict[str, Any]], *, fmt: str | None = None,
            dex_fn: Callable, sets_fn: Callable,
            damage_fn: Callable | None = None) -> dict[str, Any]:
    """Build the member x top-K matchup fact grid.

    `top_k` is a list of meta ranking rows ({rank, pokemon_en, ...}); the opponent list is that
    usage ranking, untouched. Injected, all batched to one call each: `dex_fn(names)->facts`,
    `sets_fn(species_list,fmt)->{species: modal set|None}` (metalink.canonical_attacker_sets), and
    `damage_fn(requests)->results` (ncplink.damage_batch; None to skip damage).
    """
    fmt = (fmt or team.get("format") or "single").lower()
    members = [m for m in team.get("pokemon", []) if m.get("species")]

    # Opponents: keep the ranking order; resolve each to a canonical species via its English name.
    opponents: list[dict[str, Any]] = []
    for row in top_k:
        name = row.get("pokemon_en") or row.get("pokemon") or row.get("slug")
        if name:
            opponents.append({"rank": row.get("rank"), "name": name})

    # Two independent fetches: the dex facts (types + base Speed for members + opponents) and the
    # opponents' modal sets. Neither depends on the other, so run them concurrently — they are
    # separate sibling processes (dex vs meta+dex) and overlap while each waits on its subprocess.
    names = sorted({m["species"] for m in members} | {o["name"] for o in opponents})
    opp_names = [o["name"] for o in opponents]
    import concurrent.futures as _cf
    with _cf.ThreadPoolExecutor(max_workers=2) as _ex:
        facts_fut = _ex.submit(dex_fn, names)
        sets_fut = _ex.submit(sets_fn, opp_names, fmt)
        facts = facts_fut.result() or {}
        opp_sets = sets_fut.result() or {}

    # A singles Mega is ranked under the BASE name but RUN as 'Mega X' (the resolver's `run_form`): use
    # the run form's dex facts (Mega stats/types differ) and ncp name, or speed/type/damage would use the
    # base form (audit 2026-06-25). One extra dex call only when such an opponent is present.
    run_forms = {o["name"]: ((opp_sets.get(o["name"]) or {}).get("run_form") or o["name"])
                 for o in opponents}
    extra = sorted({rf for rf in run_forms.values() if rf not in facts})
    if extra:
        facts.update(dex_fn(extra) or {})

    def runform(on: str) -> str:
        return run_forms.get(on, on)

    def base_spe(sp: str) -> int | None:
        return ((facts.get(sp, {}) or {}).get("stats") or {}).get("spe")

    def types_of(sp: str) -> list[str]:
        return list((facts.get(sp, {}) or {}).get("types") or [])

    # --- damage, both directions, batched in ONE ncp call ---------------------------------------
    # we->them key: (member, opponent, our move); them->us key: (opponent, member, their move).
    # Status moves come back 0 and drop out. Both directions need the opponent's MODAL set: offense
    # for the defender basis, defense for the attacker + its modal moves. With no meta set there is no
    # basis (a bare neutral 0-SP stand-in inflates damage and invents a KO), so skip the opponent.
    dmg_index: dict[tuple[str, str, str], int] = {}
    def_index: dict[tuple[str, str, str], int] = {}
    requests: list[dict[str, Any]] = []
    if damage_fn is not None:
        for m in members:
            mine = {"name": m["species"], "ability": m.get("ability"), "item": m.get("item"),
                    "nature": m.get("nature"), "sps": _to_sps(m.get("spread"))}
            for o in opponents:
                s = opp_sets.get(o["name"])
                if not s:
                    continue
                opp = {"name": runform(o["name"]), "ability": s.get("ability"), "item": s.get("item"),
                       "nature": s.get("nature"), "sps": s.get("sps") or {}}
                # we -> them: our member's moves vs the opponent's modal set
                for mv in (m.get("moves") or []):
                    dmg_index[(m["species"], o["name"], mv)] = len(requests)
                    requests.append({"attacker": mine, "defender": opp, "move": mv})
                # them -> us: the opponent's BROAD threat surface (meta >=15% damaging moves U any
                # real-team joint move) vs our member — defense stays conservative and doesn't narrow to
                # the single real-team build (research 2026-06-24). The numbers are exact ncp arithmetic
                # of a partly-stitched set (spread/ability/item may be meta marginals), not a guaranteed
                # real build.
                for mvrow in _threat_moves(s):
                    def_index[(o["name"], m["species"], mvrow["name"])] = len(requests)
                    requests.append({"attacker": opp, "defender": mine, "move": mvrow["name"]})
    results = damage_fn(requests) if (damage_fn is not None and requests) else []

    def best_offense(member: dict[str, Any], opp_name: str) -> dict[str, Any] | None:
        """we->them: our hardest-hitting move (by max roll) vs the opponent, with both KO buckets."""
        best_r = best_mv = None
        for mv in (member.get("moves") or []):
            idx = dmg_index.get((member["species"], opp_name, mv))
            if idx is None or idx >= len(results):
                continue
            r = results[idx] or {}
            if r.get("error") or r.get("maxPercent") is None:
                continue
            if best_r is None or r["maxPercent"] > best_r["maxPercent"]:
                best_r, best_mv = r, mv
        return _dmg_fact(best_mv, best_r) if best_r else None

    def incoming(member: dict[str, Any], opp_name: str, opp_set: dict | None) -> dict[str, Any] | None:
        """them->us: ncp damage for EACH of the opponent's modal damaging moves vs our member (the
        usage-floored threat surface), each carrying its usage %; `worst` = highest max roll. Returns
        None with no modal set (no attacker basis) — the cell keeps its type-level defense fallback."""
        if not opp_set:
            return None
        facts = []
        for mvrow in _threat_moves(opp_set):
            idx = def_index.get((opp_name, member["species"], mvrow["name"]))
            if idx is None or idx >= len(results):
                continue
            r = results[idx] or {}
            if r.get("error") or r.get("maxPercent") is None:
                continue
            facts.append(_dmg_fact(mvrow["name"], r, usage_pct=mvrow.get("pct")))
        if not facts:
            return None
        facts.sort(key=lambda f: f["max_percent"], reverse=True)
        return {"moves": facts, "worst": facts[0]}

    # --- assemble per (member, opponent) ---------------------------------------------------------
    any_modal = False
    grid: list[dict[str, Any]] = []
    for m in members:
        sp = m["species"]
        my_types = types_of(sp)
        my_base = base_spe(sp)
        my_spe_sp = int((m.get("spread") or {}).get("spe") or 0)
        # Effective Speed (Choice Scarf etc. applied) — the number that actually decides who moves
        # first. Weather/Tailwind aren't part of a matchup cell, so they stay off here; Choice Scarf
        # is always-on and MUST be counted (audit retro 2026-06-22).
        my_speed = effective_speed(my_base, my_spe_sp, m.get("nature"),
                                   item=m.get("item"), ability=m.get("ability"))
        my_scarf = my_base is not None and m.get("item") in SPEED_ITEM_MULT
        cells: list[dict[str, Any]] = []
        for o in opponents:
            on = o["name"]
            s = opp_sets.get(on)
            if s:
                any_modal = True
            # Speed: opponent uses its modal nature + Spe SP + modal item (so a modal Choice Scarf is
            # counted too); if no modal set, neutral 0-SP (flagged).
            o_base = base_spe(runform(on))
            o_nat = (s or {}).get("nature")
            o_spe_sp = int(((s or {}).get("sps") or {}).get("sp") or 0)
            o_item = (s or {}).get("item")
            o_speed = effective_speed(o_base, o_spe_sp, o_nat, item=o_item) if o_base is not None else None
            # Worst-case FAST variant (multi-peak, §16.5): max Spe SP + a speed nature, x1.5 if the modal
            # set runs Choice Scarf. Skipped for a -Spe modal (Trick Room / slow build — a fast variant
            # is unrealistic); never below the modal speed.
            o_fast = o_speed
            if o_base is not None and o_speed is not None and o_nat not in _NEG_SPE_NATURES:
                scarf = o_item if (o_item in SPEED_ITEM_MULT) else None
                o_fast = max(o_speed, effective_speed(o_base, SP_CAP, "Jolly", item=scarf))
            faster = None
            if my_speed is not None and o_speed is not None:
                faster = "member" if my_speed > o_speed else "opponent" if my_speed < o_speed else "tie"
            # Defense (them -> us): opponent STAB types vs our member types, type level only.
            opp_types = types_of(runform(on))
            def_pairs = [(t, effectiveness_for_member(my_types, m.get("ability"), t)) for t in opp_types]
            worst = max((e for _, e in def_pairs), default=None)
            cells.append({
                "opponent": on, "usage_rank": o["rank"],
                "opponent_run_form": runform(on) if runform(on) != on else None,   # singles Mega run form
                "set_confidence": (s or {}).get("confidence") if s else None,
                "set_note": (s or {}).get("note") if s else "no meta set — speed uses neutral 0-SP, no damage",
                "speed": {"member": my_speed, "opponent": o_speed, "opponent_fast": o_fast, "faster": faster,
                          "member_item_applied": m.get("item") if my_scarf else None,
                          "opponent_item_applied": o_item if (o_item in SPEED_ITEM_MULT) else None,
                          "opponent_speed_basis": "modal" if s else "neutral 0-SP"},
                "defense_type": {"opponent_stab_types": opp_types,
                                 "max_effectiveness_vs_member": worst,
                                 "by_type": [{"type": t, "x": e} for t, e in def_pairs]},
                "offense": best_offense(m, on) if damage_fn is not None else None,
                "defense_damage": incoming(m, on, s) if damage_fn is not None else None,
            })
        # Coverage counts ONLY opponents whose speed comes from a real meta set; a no-set opponent's
        # speed is unknown and its neutral-0-SP stand-in must not count as 'outspept' (audit 2026-06-24).
        opp_lines = [{"modal": c["speed"]["opponent"], "fast": c["speed"]["opponent_fast"]}
                     for c in cells if c["speed"]["opponent_speed_basis"] == "modal"]
        total_sp = sum(int(v or 0) for v in (m.get("spread") or {}).values())
        coverage = _speed_coverage(my_speed, my_base, my_spe_sp, m.get("nature"), m.get("item"),
                                   opp_lines, total_sp=total_sp)
        grid.append({"member": sp, "base_speed": my_base, "speed": my_speed, "types": my_types,
                     "speed_coverage": coverage, "cells": cells})

    notes = [
        f"{fmt}: each member vs the top {len(opponents)} most-used Pokemon (meta usage ranking). "
        "Objective facts only — no matchup score, no ranking of members/opponents, no best pick (design §0).",
        "Opponent LIST = meta usage ranking (a published fact: 'most-used', not 'biggest threat'). "
        "Opponent SET = metalink modal set for that named species (usage %, marginal-independence "
        "caveat per opponent) — matchup facts depending on it are medium/low confidence, not certified.",
        "Speed is integer-exact (Champions closed form) with always-on Choice Scarf applied on BOTH "
        "sides (our registered item, the opponent's modal item); our side uses the registered set, "
        "the opponent its modal nature + Spe SP (neutral 0-SP when it has no meta set). Weather-speed "
        "abilities and Tailwind are field-dependent and NOT applied in a matchup cell.",
        "`speed_coverage` (§16.5): EQUAL-WEIGHT coverage over the top-K modal speeds (NOT a usage-weighted "
        "multi-peak field; no-meta-set opponents excluded), + the cheapest Spe-SP jumps to the next "
        "clusters, each checked vs the 66 SP total budget (feasible flag) — marginal arms-race cost made "
        "explicit, not a creep recommendation. Full usage-weighted field model is a later increment.",
        "offense (we->them) = our member's own moves vs the opponent's modal set; defense_damage "
        "(them->us) = EVERY opponent modal damaging move at/above the usage floor vs our member, each "
        "with its usage %, `worst` = hardest max roll. Both directions give the full roll band plus "
        "ko_possible (best roll) AND ko_guaranteed (worst roll still KOs). ONLY OHKO is exact: any 2+ "
        "turn KO is a STATIC approximation (`ko_caveat`/`ko_exact`) — it repeats hit 1 and ignores "
        "between-turn recovery / ability / field shifts (audit 2026-06-24).",
        "them->us moves are usage MARGINALS (the threat surface, each move's own %, not a guaranteed "
        "co-occurring set), so defense_damage is medium/low confidence; defense_type (STAB type "
        "effectiveness) is the no-set fallback and is always present. STILL DEFERRED: lead/back, "
        "doubles spread/partner, and speed-control (tailwind/trick-room) are not modelled.",
    ]
    if damage_fn is None:
        notes.append("damage skipped (ncp unavailable): offense and defense_damage omitted, "
                     "defense is type-level only.")

    confidence = "low" if not any_modal else "medium"
    return {"kind": "matchup", "format": fmt, "top_k": len(opponents),
            "members": grid, "notes": notes, "confidence": confidence,
            "confidence_reason": "vs-standard-set",
            "evidence": {"facts": [{"source": "meta", "ref": "usage ranking (opponent list)"},
                                   {"source": "meta", "ref": "modal set + top moves per opponent (metalink)"},
                                   {"source": "dex", "ref": "types / base Speed"},
                                   {"source": "ncp", "ref": "we->them and them->us max damage"}],
                         "assumptions": ["opponent runs its meta modal set",
                                         "KO buckets give both possible (best roll) and guaranteed (worst roll)",
                                         "them->us = opponent damaging moves >= usage floor (usage marginals)"]}}


def _x(mult: float | None) -> str:
    if mult is None:
        return "?"
    return f"{mult:g}x"


def format_matchup_md(d: dict[str, Any]) -> str:
    lines = [f"# Matchup vs meta top-{d['top_k']} ({d['format']}) — objective facts, unranked "
             f"(opponent sets = meta modal, {d['confidence']} confidence; not a score)"]
    for mrow in d["members"]:
        spe = f"{mrow['speed']}" if mrow.get("speed") is not None else "?"
        lines.append(f"\n## {mrow['member']}  (base Spe {mrow.get('base_speed')}, set Spe {spe}; "
                     f"types {'/'.join(mrow.get('types') or []) or '?'})")
        cov = mrow.get("speed_coverage")
        if cov:
            # `of` lives on the coverage object, not each jump (the old `j['of']` raised KeyError and
            # crashed the whole Markdown render; audit 2026-06-24). Infeasible jumps (over the 66 SP
            # total budget) are flagged, not shown as plain advice.
            jt = "; ".join(
                f"+{j['delta_sp']} Spe SP → clears {j['clears']} ({j['outspeeds_after']}/{cov['of']})"
                + ("" if j.get("feasible", True) else f" [INFEASIBLE: total {j.get('total_sp_after')}>66 SP]")
                for j in cov.get("next_jumps", []))
            if jt:
                tail = f"; next jumps: {jt}"
            elif cov["outspeeds"] == cov["of"]:
                tail = "; already clears the field's top cluster"
            else:
                tail = "; no Spe-SP jump clears the next cluster within the cap"
            worst = (f"; worst-case **{cov['outspeeds_worst']}/{cov['of']}** vs fast variants"
                     + (f" ({cov['fast_variant_flips']} flip)" if cov.get("fast_variant_flips") else "")
                     ) if "outspeeds_worst" in cov else ""
            lines.append(f"- speed field: outspeeds **{cov['outspeeds']}/{cov['of']}** ({cov['percent']}%) at modal"
                         + (f", ties {cov['ties']}" if cov.get("ties") else "") + worst + tail)
        for c in mrow["cells"]:
            sp = c["speed"]
            arrow = {"member": "outspeeds", "opponent": "slower than", "tie": "speed-ties"}.get(sp["faster"], "speed ?")
            off = c.get("offense")
            off_txt = (f"; we→them: {off['move']} {off['min_percent']}–{off['max_percent']}%"
                       + (f" ({off['ko']})" if off.get("ko") else "")) if off else ""
            dd = c.get("defense_damage")
            if dd:
                w = dd["worst"]
                used = f", {w['usage_pct']:.0f}% used" if w.get("usage_pct") is not None else ""
                more = f" (+{len(dd['moves']) - 1} more)" if len(dd["moves"]) > 1 else ""
                dd_txt = (f"; them→us: {w['move']} {w['min_percent']}–{w['max_percent']}%"
                          + (f" ({w['ko']}{used})" if w.get("ko") else "") + more)
            else:
                dd_txt = ""
            dt = c["defense_type"]
            def_txt = (f"; their STAB {('/'.join(dt['opponent_stab_types']) or '—')} "
                       f"×{_x(dt['max_effectiveness_vs_member'])} vs us")
            rank = f"#{c['usage_rank']}" if c.get("usage_rank") else ""
            lines.append(f"- vs **{c['opponent']}** {rank}: {arrow} "
                         f"({sp['member']} vs {sp['opponent']}){off_txt}{dd_txt}{def_txt}")
    if d.get("notes"):
        lines.append("\n## Notes")
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)
