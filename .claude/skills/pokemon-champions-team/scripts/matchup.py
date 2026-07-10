#!/usr/bin/env python
"""Matchup-vs-meta-top-K (M2 L2) — OBJECTIVE FACTS ONLY.

For each of the team's members, report objective matchup facts against the meta's most-used
Pokemon: who outspeeds whom, how the opponent's STAB types hit us (type level), and how hard our
member's own moves hit the opponent's modal set (damage, via ncp). It assigns NO matchup score,
ranks NO member or opponent, and names NO "best" anything — it lays out facts the AI
reasons over.

Discipline / boundary (mirrors metalink.py):
  - the opponent LIST is the meta USAGE ranking — a published fact ("most-used"), not a synthesized
    threat assessment. It is NOT the marginal-mode threat auto-discovery that this skill
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

from typing import Any, Callable

from cliffs import (champ_speed, effective_speed, fast_variant_speed, solve_outspeed,
                    SPEED_ITEM_MULT, SPE_DOWN_NATURES, SP_CAP)
from metalink import (SPREAD_TO_SPS as _SPREAD_TO_SPS,
                      OPPONENT_SCARF_USAGE_FLOOR as _SCARF_LANE_FLOOR)
from typechart import effectiveness_for_member
from rules import get_ruleset
from battle_effects import ko_hits_from_pct
import checks
import team_i18n as i18n

SP_TOTAL_CAP = get_ruleset().sp_total_cap          # 66 SP across all stats (the real spend ceiling)

# A real (item,ability) archetype covering fewer than this share of the species' real teams is a fringe
# build — grading the strict floor against it would OVER-pessimise (design §17). repset already gates
# MIN_SAMPLE; this second floor keeps a rare third archetype from dragging the whole floor down.
_ARCHETYPE_COVERAGE_FLOOR = 0.15


def _archetype_variants(name: str, fmt: str, modal: dict[str, Any],
                        archetypes_fn: Callable) -> list[dict[str, Any]] | None:
    """The opponent's EXTRA real-team (item,ability) archetypes beyond its modal set (design §17 item ①).

    Each is the modal set's enriched surface (its `threat_moves` / `run_form` / `choice_scarf`) with the
    archetype's own item / ability / nature / sps / moves overriding — so grading it re-prices the SAME
    broad threat surface under a different real build (Choice Band vs Assault Vest ...), which is exactly
    what changes both our KO on it and its hit on us.

    Returns None when repset has NO usable read (species below MIN_SAMPLE, or a `fragmented` species with
    no clear archetype) — the lane stays UNevaluated and `strict.missing_lanes` keeps disclosing it. A
    LIST (possibly empty) when repset DID resolve: empty means the modal is the only real archetype
    (nothing extra), a filled list is the distinct extras above the coverage floor."""
    try:
        arch = archetypes_fn(name, fmt) or []
    except Exception:
        return None
    if not arch or (len(arch) == 1 and arch[0].get("fragmented")):
        return None                              # no clear archetype to expand -> lane stays disclosed
    seen = {(modal.get("item"), modal.get("ability"))}     # skip the archetype the modal already IS
    out: list[dict[str, Any]] = []
    for a in arch:
        key = (a.get("item"), a.get("ability"))
        if key in seen or (a.get("coverage") or 0) < _ARCHETYPE_COVERAGE_FLOOR:
            continue                             # already the modal, a dup, or a fringe build
        seen.add(key)
        out.append({**modal, "item": a.get("item"), "ability": a.get("ability"),
                    # sps missing from the archetype -> inherit the MODAL investment, never 0-EV: a 0-SP
                    # defender is both softer AND hits softer, which only ever FAILS to depress the
                    # pessimistic floor (an under-pessimism the floor exists to avoid, design §17).
                    "nature": a.get("nature"), "sps": a.get("sps") or modal.get("sps") or {},
                    "moves": a.get("moves") or modal.get("moves"),
                    # RE-PRICE THE SAME broad surface (the modal's threat_moves dicts) under this
                    # archetype's item/ability — pin it so the `moves` override can't shrink the incoming
                    # surface to the archetype's 4 joint moves (that would flatter the floor).
                    "threat_moves": _threat_moves(modal),
                    "cluster": a.get("cluster") or {"item": a.get("item"), "ability": a.get("ability")},
                    "coverage": a.get("coverage"), "confidence": a.get("confidence")})
    return out

# Any KO that needs 2+ turns is a STATIC approximation: it repeats the first hit's damage and does NOT
# model what actually happens between turns. Only OHKO is exact (audit 2026-06-24 — the calc's raw
# damage band can't be a real "guaranteed 2HKO").
_NHKO_CAVEAT = ("static N-hit approximation — repeats the first hit's damage; ignores between-turn "
                "recovery (Sitrus / Leftovers), attacker/defender ability shifts (Draco Meteor / "
                "Stamina / Multiscale), recoil, status and field changes. Only OHKO is exact.")

def _to_sps(spread: dict[str, Any] | None) -> dict[str, int]:
    if not spread:
        return {}
    return {_SPREAD_TO_SPS[k]: int(v or 0) for k, v in spread.items() if k in _SPREAD_TO_SPS}


def _hko(n: int | None) -> str | None:
    return None if n is None else {1: "OHKO", 2: "2HKO", 3: "3HKO"}.get(n, f"{n}HKO")


def _ko_buckets(min_percent: float | None, max_percent: float | None) -> tuple[int | None, int | None]:
    """(possible, guaranteed) KO-hit counts from the damage band. `possible` uses the best roll (high
    roll, fewest hits); `guaranteed` uses the worst roll (low roll still KOs). Per-hit-independent
    approximation — ignores between-hit Leftovers/Life-Orb recoil (same simplification as the calc).
    Shares the ceil(100/pct) arithmetic with the checks Intimidate rescale via battle_effects."""
    return ko_hits_from_pct(max_percent), ko_hits_from_pct(min_percent)


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


def member_actor(m: dict[str, Any]) -> dict[str, Any]:
    """A team member's REGISTERED set as an ncp actor. The single construction shared by the battery
    and the answer-audit's claim recompute — the same coordinates must rebuild the same sets."""
    return {"name": m["species"], "ability": m.get("ability"), "item": m.get("item"),
            "nature": m.get("nature"), "sps": _to_sps(m.get("spread"))}


def run_form_name(name: str, s: dict[str, Any] | None) -> str:
    """The form a resolved opponent actually RUNS as (a singles Mega is ranked under the base name
    but battles as 'Mega X') — the single rule the battery AND the answer-audit's recompute share
    for dex fact lookups on the opponent side."""
    return (s or {}).get("run_form") or name


def set_actor(name: str, s: dict[str, Any] | None) -> dict[str, Any]:
    """A resolved opponent's MODAL set as an ncp actor (run_form-aware: a singles Mega is ranked
    under the base name but runs as 'Mega X')."""
    s = s or {}
    return {"name": run_form_name(name, s), "ability": s.get("ability"), "item": s.get("item"),
            "nature": s.get("nature"), "sps": s.get("sps") or {}}


def pair_speed(member: dict[str, Any], member_base: int | None,
               opp_set: dict[str, Any] | None, opp_base: int | None) -> dict[str, Any]:
    """The speed half of ONE matchup cell — member's effective Speed (registered set, always-on item)
    vs the opponent's modal speed and its worst-case fast variant. Extracted as the re-runnable pair
    the spd:{fmt}:{member}|{opponent} evidence coordinates recompute."""
    my_spe_sp = int((member.get("spread") or {}).get("spe") or 0)
    my_speed = effective_speed(member_base, my_spe_sp, member.get("nature"),
                               item=member.get("item"), ability=member.get("ability"))
    s = opp_set
    o_nat = (s or {}).get("nature")
    o_spe_sp = int(((s or {}).get("sps") or {}).get("sp") or 0)
    o_item = (s or {}).get("item")
    o_speed = effective_speed(opp_base, o_spe_sp, o_nat, item=o_item) if opp_base is not None else None
    # Worst-case FAST variant (multi-peak, §16.5): max Spe SP + a speed nature, x1.5 if the modal
    # set runs Choice Scarf. Skipped for a -Spe modal; never below the modal speed. (shared: cliffs)
    o_fast = fast_variant_speed(opp_base, o_speed, o_nat, item=o_item)
    # Non-modal Choice Scarf lane: when the opponent runs Scarf at a meaningful rate but it isn't the
    # modal item (so o_fast above did NOT fold in the x1.5), expose the scarf-variant speed separately.
    # checks grades the pessimistic strict floor against it — a real evaluation, not a bare disclosure.
    o_scarf = None
    cs = (s or {}).get("choice_scarf")
    if (opp_base is not None and o_nat not in SPE_DOWN_NATURES and o_item not in SPEED_ITEM_MULT
            and isinstance(cs, dict) and float(cs.get("pct") or 0) >= _SCARF_LANE_FLOOR):
        o_scarf = effective_speed(opp_base, SP_CAP, "Jolly", item="Choice Scarf")
    faster = None
    if my_speed is not None and o_speed is not None:
        faster = "member" if my_speed > o_speed else "opponent" if my_speed < o_speed else "tie"
    my_scarf = member_base is not None and member.get("item") in SPEED_ITEM_MULT
    return {"member": my_speed, "opponent": o_speed, "opponent_fast": o_fast, "faster": faster,
            "opponent_scarf": o_scarf,      # non-modal Scarf speed (>= floor usage), else None
            "member_item_applied": member.get("item") if my_scarf else None,
            "opponent_item_applied": o_item if (o_item in SPEED_ITEM_MULT) else None,
            "opponent_speed_basis": "modal" if s else "neutral 0-SP"}


def _threat_moves(opp_set: dict | None) -> list[dict[str, Any]]:
    """them->us threat surface: the BROAD meta >=15% damaging moves (`threat_moves` from the resolver,
    which already unions in real-team joint moves), falling back to `moves` for a meta-only set. Never
    the real-team JOINT 4-move set alone — that under-covers the threat space (research 2026-06-24)."""
    if not opp_set:
        return []
    return opp_set.get("threat_moves") or opp_set.get("moves") or []


def dmg_fact(move: str, r: dict[str, Any], **extra: Any) -> dict[str, Any]:
    """One damage fact from an ncp result: roll band + possible/guaranteed KO buckets (both rolls),
    NOT a single max-roll headline. `extra` carries direction-specific fields (e.g. usage_pct).
    Public: the single source of the damage-fact shape — oppcache reuses it, and the answer-audit's
    claim recompute must produce the SAME keys the battery produced."""
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
    if r.get("category"):                               # Physical/Special — lets checks tell whether a
        fact["category"] = r["category"]                # +Def caveat (Stamina) is even relevant to THIS hit
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


def best_offense(moves: list[str], result_fn: Callable[[str], dict[str, Any] | None],
                 dmg_fact_fn: Callable[..., dict[str, Any]] = dmg_fact) -> dict[str, Any] | None:
    """Hardest-hitting move by max roll from a precomputed damage result lookup."""
    best_r = best_mv = None
    for mv in moves:
        r = result_fn(mv) or {}
        if r.get("error") or r.get("maxPercent") is None:
            continue
        if best_r is None or r["maxPercent"] > best_r["maxPercent"]:
            best_r, best_mv = r, mv
    return dmg_fact_fn(best_mv, best_r) if best_r else None


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
            damage_fn: Callable | None = None, move_fn: Callable | None = None,
            archetypes_fn: Callable | None = None) -> dict[str, Any]:
    """Build the member x top-K matchup fact grid.

    `top_k` is a list of meta ranking rows ({rank, pokemon_en, ...}); the opponent list is that
    usage ranking, untouched. Injected, all batched to one call each: `dex_fn(names)->facts`,
    `sets_fn(species_list,fmt)->{species: modal set|None}` (metalink.canonical_attacker_sets), and
    `damage_fn(requests)->results` (ncplink.damage_batch; None to skip damage).

    `archetypes_fn(species, fmt)->[repset archetype sets]` (optional; repset.representative_sets) turns
    on the strict-floor archetype lane (design §17 item ①): each opponent's EXTRA real (item,ability)
    archetypes are re-priced over the broad threat surface, and every check's `primary_grade` becomes
    the pessimistic FLOOR across the modal set AND those archetypes. None (or no ncp) leaves the lane
    disclosed as unevaluated, exactly as before.
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

    # Move priorities (signed): our KO move's priority lets a SLOW member still act first (checks reads
    # it into we_act_first); the opponents' threat-move priorities gate that upgrade OFF when the foe
    # also carries priority (don't over-claim "we're first"). One batched dex call over every move seen.
    move_prio: dict[str, int] = {}
    if move_fn is not None:
        all_moves = {mv for m in members for mv in (m.get("moves") or [])}
        all_moves |= {mvrow["name"] for o in opponents for mvrow in _threat_moves(opp_sets.get(o["name"]))}
        if all_moves:
            for name, mf in (move_fn(sorted(all_moves)) or {}).items():
                p = (mf or {}).get("priority")
                if isinstance(p, int):
                    move_prio[name] = p

    # A singles Mega is ranked under the BASE name but RUN as 'Mega X' (the resolver's `run_form`): use
    # the run form's dex facts (Mega stats/types differ) and ncp name, or speed/type/damage would use the
    # base form (audit 2026-06-25). One extra dex call only when such an opponent is present.
    run_forms = {o["name"]: run_form_name(o["name"], opp_sets.get(o["name"]))
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

    # Strict-floor archetype lane (design §17 item ①): each opponent's EXTRA real (item,ability)
    # archetypes beyond its modal set. None per opponent = repset had no usable read (lane stays
    # disclosed); a list (possibly empty) = evaluated. Off entirely without archetypes_fn or damage.
    opp_variants: dict[str, list[dict[str, Any]] | None] = {}
    if archetypes_fn is not None and damage_fn is not None:
        for o in opponents:
            s = opp_sets.get(o["name"])
            # look up archetypes under the RUN FORM (a singles Mega's real teams are stored as 'Mega X',
            # not the base ranking name) — the variants still inherit the modal's run_form/threat surface.
            opp_variants[o["name"]] = (_archetype_variants(runform(o["name"]), fmt, s, archetypes_fn)
                                       if s else None)

    # --- damage, both directions, batched in ONE ncp call ---------------------------------------
    # we->them key: (member, opponent, our move); them->us key: (opponent, member, their move).
    # Status moves come back 0 and drop out. Both directions need the opponent's MODAL set: offense
    # for the defender basis, defense for the attacker + its modal moves. With no meta set there is no
    # basis (a bare neutral 0-SP stand-in inflates damage and invents a KO), so skip the opponent.
    # A single keyspace indexes BOTH the modal set (arch_id None) and each extra archetype (arch_id vi),
    # so lookups are one dict + one .get() with no modal-vs-archetype branch that could drift (the branch
    # drift previously risked a variant silently dropping — the lane's "never flatter" guard).
    dmg_index: dict[tuple[str, str, int | None, str], int] = {}   # (member, opp, arch_id|None, move)
    def_index: dict[tuple[str, str, int | None, str], int] = {}   # (opp, member, arch_id|None, move)
    requests: list[dict[str, Any]] = []
    if damage_fn is not None:
        for m in members:
            mine = member_actor(m)
            for o in opponents:
                s = opp_sets.get(o["name"])
                if not s:
                    continue
                # modal (arch_id None) + each extra archetype re-price BOTH directions over the SAME broad
                # threat surface with that build's real item/ability/sps (Choice Band vs Assault Vest change
                # our KO AND its hit). Defense stays the conservative meta >=15% U real-joint surface, never
                # narrowing to a single real build (research 2026-06-24); the numbers are exact ncp of a
                # partly-stitched set (spread/ability/item may be meta marginals), not a guaranteed real build.
                actors = [(None, set_actor(o["name"], s), s)]
                actors += [(vi, set_actor(o["name"], var), var)
                           for vi, var in enumerate(opp_variants.get(o["name"]) or [])]
                for aid, actor, aset in actors:
                    for mv in (m.get("moves") or []):              # we -> them
                        dmg_index[(m["species"], o["name"], aid, mv)] = len(requests)
                        requests.append({"attacker": mine, "defender": actor, "move": mv})
                    for mvrow in _threat_moves(aset):              # them -> us
                        def_index[(o["name"], m["species"], aid, mvrow["name"])] = len(requests)
                        requests.append({"attacker": actor, "defender": mine, "move": mvrow["name"]})
    results = damage_fn(requests) if (damage_fn is not None and requests) else []

    def best_member_offense(member: dict[str, Any], opp_name: str,
                            arch_id: int | None = None) -> dict[str, Any] | None:
        """we->them: our hardest-hitting move (by max roll) vs the opponent, with both KO buckets.
        `arch_id` re-prices vs an extra archetype's defensive profile instead of the modal set."""
        def result_for(mv: str) -> dict[str, Any] | None:
            idx = dmg_index.get((member["species"], opp_name, arch_id, mv))
            if idx is None or idx >= len(results):
                return None
            return results[idx]

        moves = member.get("moves") or []
        off = best_offense(moves, result_for)
        if off and off.get("move") in move_prio:
            off["priority"] = move_prio[off["move"]]      # our KO move's speed-priority stage (signed)
        # the best PRIORITY move's KO — may be weaker than `off` but strikes first (a revenge lane the
        # neutral frame's hardest-hit selection would otherwise hide). Attached only when it differs.
        prio_moves = [mv for mv in moves if move_prio.get(mv, 0) > 0]
        if off is not None and prio_moves:
            po = best_offense(prio_moves, result_for)
            if po and po["move"] != off.get("move"):
                po["priority"] = move_prio.get(po["move"], 0)
                off["priority_offense"] = po
        return off

    def incoming(member: dict[str, Any], opp_name: str, opp_set: dict | None,
                 arch_id: int | None = None) -> dict[str, Any] | None:
        """them->us: ncp damage for EACH of the opponent's modal damaging moves vs our member (the
        usage-floored threat surface), each carrying its usage %; `worst` = highest max roll. Returns
        None with no modal set (no attacker basis) — the cell keeps its type-level defense fallback.
        `arch_id` re-prices the SAME surface with an extra archetype's offensive profile."""
        if not opp_set:
            return None
        facts = []
        for mvrow in _threat_moves(opp_set):
            idx = def_index.get((opp_name, member["species"], arch_id, mvrow["name"]))
            if idx is None or idx >= len(results):
                continue
            r = results[idx] or {}
            if r.get("error") or r.get("maxPercent") is None:
                continue
            facts.append(dmg_fact(mvrow["name"], r, usage_pct=mvrow.get("pct")))
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
        cells: list[dict[str, Any]] = []
        for o in opponents:
            on = o["name"]
            s = opp_sets.get(on)
            if s:
                any_modal = True
            # Speed: opponent uses its modal nature + Spe SP + modal item (so a modal Choice Scarf is
            # counted too); if no modal set, neutral 0-SP (flagged). One shared pair construction —
            # pair_speed — is the same function the answer-audit's spd recompute runs.
            o_base = base_spe(runform(on))
            # Defense (them -> us): opponent STAB types vs our member types, type level only.
            opp_types = types_of(runform(on))
            def_pairs = [(t, effectiveness_for_member(my_types, m.get("ability"), t)) for t in opp_types]
            worst = max((e for _, e in def_pairs), default=None)
            cell = {
                "opponent": on, "usage_rank": o["rank"],
                "opponent_run_form": runform(on) if runform(on) != on else None,   # singles Mega run form
                "set_confidence": (s or {}).get("confidence") if s else None,
                "set_note": (s or {}).get("note") if s else "no meta set — speed uses neutral 0-SP, no damage",
                "speed": pair_speed(m, my_base, s, o_base),
                "defense_type": {"opponent_stab_types": opp_types,
                                 "max_effectiveness_vs_member": worst,
                                 "by_type": [{"type": t, "x": e} for t, e in def_pairs]},
                "offense": best_member_offense(m, on) if damage_fn is not None else None,
                "defense_damage": incoming(m, on, s) if damage_fn is not None else None,
                # does THIS opponent carry a priority move? gates our priority-first upgrade off (don't
                # claim we act first when the foe also has priority) — checks reads it.
                "opponent_has_priority": any(move_prio.get(mvrow["name"], 0) > 0
                                             for mvrow in _threat_moves(s)),
            }
            # strict-floor archetype grades (design §17 item ①): re-price each EXTRA archetype (its own
            # item/ability/sps) and grade its strict floor. `variants is None` => lane unevaluated (repset
            # thin) -> archetypes stays None; a list (possibly empty) => evaluated. Each grade is a pure
            # build_check over the archetype's re-priced cell (no recursion — archetypes left None there).
            archetype_lanes = None
            arch_partial = False
            variants = opp_variants.get(on) if damage_fn is not None else None
            if variants is not None:
                archetype_lanes = []
                for vi, var in enumerate(variants):
                    v_off, v_dd = best_member_offense(m, on, arch_id=vi), incoming(m, on, var, arch_id=vi)
                    if v_off is None and v_dd is None:
                        arch_partial = True              # a real archetype whose ncp requests ALL failed —
                        continue                         # evaluated-but-dropped, disclosed via completeness
                    v_cell = {"opponent": on, "usage_rank": o["rank"],
                              "speed": pair_speed(m, my_base, var, o_base),
                              "defense_type": cell["defense_type"],
                              "offense": v_off, "defense_damage": v_dd,
                              "opponent_has_priority": cell["opponent_has_priority"]}
                    v_chk = checks.build_check(v_cell, sp, var, fmt, member_set=m)
                    if v_chk:
                        archetype_lanes.append({
                            "cluster": var.get("cluster"), "coverage": var.get("coverage"),
                            "confidence": var.get("confidence"), "grade": v_chk["strict"]["grade"],
                            "we_act_first_fast": v_chk["predicates"]["we_act_first_fast"],
                            "c0_kind": v_chk.get("c0_kind"),
                            "resolvability": v_chk.get("resolvability")})
            # Derived CHECK grade (facts-only ordinal label + predicates, design §5 派生视图; checks.py).
            # A pure post-classification over this cell's own facts + the pre-graded archetype lane.
            cell["check"] = (checks.build_check(cell, sp, s, fmt, member_set=m, archetypes=archetype_lanes,
                                                archetypes_partial=arch_partial)
                             if damage_fn is not None else None)
            cells.append(cell)
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
        "Objective facts only — no matchup score, no ranking of members/opponents, no best pick.",
        "Opponent LIST = meta usage ranking (a published fact: 'most-used', not 'biggest threat'). "
        "Opponent SET = metalink modal set for that named species (usage %, marginal-independence "
        "caveat per opponent) — matchup facts depending on it are medium/low confidence, not certified.",
        "Speed is integer-exact (Champions closed form) with always-on Choice Scarf applied on BOTH "
        "sides (our registered item, the opponent's modal item); our side uses the registered set, "
        "the opponent its modal nature + Spe SP (neutral 0-SP when it has no meta set). Weather-speed "
        "abilities and Tailwind are field-dependent and NOT applied in a matchup cell.",
        "damage = the turn the move FIRES, no field up; turn costs are not modelled (a charge move "
        "like Solar Beam / Electro Shot spends a turn charging unless its weather is up — and Solar "
        "Beam halves in rain/sand/hail), so a cell's max damage can overstate one-turn output. For "
        "field-explicit numbers run ncp with `field` set.",
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

    if damage_fn is not None:
        notes.append(
            "`check` (per cell) + `check_coverage` (roll-up) are a DERIVED classification over these "
            "same facts (checks.py): C2=safe switch-in check / C1=same-field revenge only / C0=none; "
            "an ordinal LABEL with predicates + a turn budget, NEVER a score and NEVER summed into a "
            "team 'check score'. `check_coverage.holes` = top-K opponents with no safe switch-in "
            "check (best strict grade in {C1,C0}). primary_grade reads the pessimistic FLOOR across the "
            "opponent's modal set AND its real (item,ability) archetypes (strict.archetypes discloses "
            "each; strict.grade keeps the modal grade with its evidence). The archetype lane is NOT "
            f"exhaustive: it is the repset's top clusters filtered to >={_ARCHETYPE_COVERAGE_FLOOR:.0%} "
            "team coverage (a rarer breaking build is deliberately not floored in — it would over-"
            "pessimise), so `complete` means 'the material archetypes', not 'every possible set'. "
            "strict.missing_lanes discloses any lane still unevaluated (e.g. repset_archetypes when the "
            "library is too thin) — an absent lane lowers confidence, never flatters the grade.")

    confidence = "low" if not any_modal else "medium"
    return {"kind": "matchup", "format": fmt, "top_k": len(opponents),
            "members": grid,
            "check_coverage": checks.coverage_summary(grid) if damage_fn is not None else None,
            "notes": notes, "confidence": confidence,
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
    lines = ["# " + i18n.t('mu_header', top_k=d['top_k'], fmt=d['format'],
                           conf=d['confidence'], confidence=i18n.t('confidence'))]
    for mrow in d["members"]:
        spe = f"{mrow['speed']}" if mrow.get("speed") is not None else "?"
        lines.append(f"\n## {mrow['member']}  " + i18n.t(
            'mu_member_header', base=mrow.get('base_speed'), spe=spe,
            types='/'.join(mrow.get('types') or []) or '?'))
        cov = mrow.get("speed_coverage")
        if cov:
            # `of` lives on the coverage object, not each jump (the old `j['of']` raised KeyError and
            # crashed the whole Markdown render; audit 2026-06-24). Infeasible jumps (over the 66 SP
            # total budget) are flagged, not shown as plain advice.
            jt = "; ".join(
                f"+{j['delta_sp']} Spe SP → "
                + i18n.t('mu_clears', clears=j['clears'])
                + f" ({j['outspeeds_after']}/{cov['of']})"
                + ("" if j.get("feasible", True)
                   else i18n.t('mu_infeasible', total=j.get('total_sp_after')))
                for j in cov.get("next_jumps", []))
            if jt:
                tail = i18n.t('mu_next_jumps', jt=jt)
            elif cov["outspeeds"] == cov["of"]:
                tail = i18n.t('mu_already_clears')
            else:
                tail = i18n.t('mu_no_jump')
            worst = (i18n.t('mu_worst_case', n=cov['outspeeds_worst'], of=cov['of'])
                     + (i18n.t('mu_flip', flips=cov['fast_variant_flips'])
                        if cov.get("fast_variant_flips") else "")
                     ) if "outspeeds_worst" in cov else ""
            lines.append("- " + i18n.t('mu_speed_field', out=cov['outspeeds'], of=cov['of'],
                                       percent=cov['percent'])
                         + (i18n.t('mu_ties', ties=cov['ties']) if cov.get("ties") else "")
                         + worst + tail)
        for c in mrow["cells"]:
            sp = c["speed"]
            arrow = {"member": i18n.t('mu_cmp_outspeeds'),
                     "opponent": i18n.t('mu_cmp_slower'),
                     "tie": i18n.t('mu_cmp_tie')}.get(sp["faster"], i18n.t('mu_cmp_unknown'))
            off = c.get("offense")
            off_txt = (i18n.t('mu_we_them', move=off['move'],
                              min=off['min_percent'], max=off['max_percent'])
                       + (f" ({off['ko']})" if off.get("ko") else "")) if off else ""
            dd = c.get("defense_damage")
            if dd:
                w = dd["worst"]
                used = (i18n.t('mu_used', pct=f"{w['usage_pct']:.0f}")
                        if w.get("usage_pct") is not None else "")
                more = (i18n.t('mu_more', n=len(dd['moves']) - 1)
                        if len(dd["moves"]) > 1 else "")
                dd_txt = (i18n.t('mu_them_us', move=w['move'],
                                 min=w['min_percent'], max=w['max_percent'])
                          + (f" ({w['ko']}{used})" if w.get("ko") else "") + more)
            else:
                dd_txt = ""
            dt = c["defense_type"]
            def_txt = i18n.t('mu_their_stab',
                             types=('/'.join(dt['opponent_stab_types']) or '—'),
                             x=_x(dt['max_effectiveness_vs_member']))
            rank = f"#{c['usage_rank']}" if c.get("usage_rank") else ""
            lines.append(f"- vs **{c['opponent']}** {rank}: {arrow} "
                         f"({sp['member']} vs {sp['opponent']}){off_txt}{dd_txt}{def_txt}")
    if d.get("notes"):
        lines.append("\n## " + i18n.t('notes'))
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)


def format_check_coverage_md(d: dict[str, Any]) -> str:
    """The derived CHECK coverage map (`--as-checks`): per-opponent best strict grade + who + the
    HOLE list. A facts grid (grades are canonical tokens); no matchup score, no opponent ranking."""
    cov = d.get("check_coverage")
    head = "# " + i18n.t('chkcov_title', fmt=d['format'], top_k=d['top_k'], conf=d['confidence'])
    if not cov:
        return head + "\n\n_" + i18n.t('chkcov_none') + "_"
    dist = cov.get("grade_distribution") or {}
    lines = [head,
             "\n_" + i18n.t('chkcov_legend', c2=dist.get('C2', 0), c1=dist.get('C1', 0),
                            c0=dist.get('C0', 0)) + "_",
             "\n" + i18n.t('chkcov_header'),
             "|---:|---|:--:|---|---|---|---|"]
    for r in cov.get("by_opponent", []):
        rank = r.get("usage_rank")
        lines.append(
            f"| {rank if rank is not None else ''} | {r['opponent']} | **{r['best_strict']}** | "
            f"{', '.join(r.get('best_switch_in_by') or []) or '—'} | "
            f"{', '.join(r.get('modal_headline_by') or []) or '—'} | "
            f"{', '.join(r.get('fragile') or []) or '—'} | "
            f"{', '.join(r.get('contested') or []) or '—'} |")
    contested = [r for r in cov.get("by_opponent", []) if r.get("contested")]
    if contested:
        lines.append("\n## " + i18n.t('chkcov_contested_title'))
        for r in contested:
            lines.append(f"- **{r['opponent']}** (#{r.get('usage_rank')}): {', '.join(r['contested'])}"
                         " — " + i18n.t('chkcov_contested_suffix'))
    holes = cov.get("holes") or []
    lines.append("\n## " + i18n.t('chkcov_holes_title'))
    if holes:
        for h in holes:
            lines.append(f"- **{h['opponent']}** (#{h.get('usage_rank')}): "
                         + i18n.t('chkcov_hole_line', best_strict=h['best_strict'],
                                  best_modal=h['best_modal_headline'])
                         + (" " + i18n.t('chkcov_by', who=', '.join(h['modal_headline_by']))
                            if h.get("modal_headline_by") else "")
                         + (" · " + i18n.t('chkcov_walled', who=', '.join(h['wall_no_ko_by']))
                            if h.get("wall_no_ko_by") else ""))
    else:
        lines.append("- " + i18n.t('chkcov_holes_none'))
    if cov.get("note"):
        lines.append("\n> " + cov["note"])
    return "\n".join(lines)
