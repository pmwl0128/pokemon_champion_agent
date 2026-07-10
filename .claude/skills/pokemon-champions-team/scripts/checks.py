#!/usr/bin/env python
"""Derived CHECK-GRADE classification over `matchup` cell facts (design §5 L2 派生视图).

FACTS-ONLY. A cell's check is an ORDINAL LABEL + the booleans that produced it + evidence_ids +
disclosed caveats. It is NEVER a scalar score and is NEVER summed across members/opponents into a
team "check score" (design §1/§16 — the no-composite red line). A consumer may count grades as a
distribution, but any cross-team/cross-opponent RANKING is the AI's / front-end's judgment, never a
skill-emitted number.

Model (frozen rubric — the audited turn-budget engagement, not a static threshold):
  * The engagement is a 1v1 with the opponent already on field. We evaluate TWO lines:
      - same_field : both already out.        incoming = kill_hits - (we_act_first ? 1 : 0)
      - switch_in  : we pivot in on its move.  incoming = 1 + kill_hits - (we_act_first ? 1 : 0)
    `incoming` = how many enemy hits we must absorb before our KO lands.
  * primary_grade — the ONLY hole-detection axis — is 3-way:
      C2 = switch_in line safe (survive the switch hit + budget) AND we kill  -> "switch-in check"
           (NOT "counter": the engine models no status/recovery/PP/boosts/hazards/multi-turn, so a
           repeatable-wall claim would over-reach).
      C1 = only same_field safe (revenge; cannot pivot in).
      C0 = neither.
    C1 sub-modes (clean_revenge / speed_trade / bulk_revenge / priority_candidate) are UNORDERED
    explanatory descriptors, NOT a strength ladder (they are different failure modes).
  * safe(line) is THREE-VALUED, not a boolean:
      exact_true  : incoming <= 1 — survival rests only on the exact OHKO fact.
      approx_true : incoming >= 2, no survival-worsening ko_caveat — static N-hit approximation.
      uncertain   : incoming >= 2 AND ncp flagged a ko_caveat that could make survival WORSE than the
                    static floor (`understates`/`unclear` direction — Multiscale / Weak Armor / attacker
                    ramp / stat-change ...) — the "repeat hit 1" assumption is unreliable. A caveat that
                    only makes the enemy KO HARDER (`overstates` — Stamina / one-time-survive) does NOT
                    downgrade (we are at-least-as-safe as approx_true).
      false       : the opponent can KO us within the budget (pessimistic: uses ko_possible).
    Hard C2/C1 require safe in {exact_true, approx_true}; `uncertain` never hardens a grade.
    The multi-hit integrity gate REUSES ncp's own ko_caveats detection (design §14 "DETECTED, not
    modelled") rather than a hand-kept unsafe-ability list.
  * Two grades per cell, over two DIFFERENT incoming surfaces so the field names don't lie:
      headline : the opponent's MODAL joint moveset (`opp_set['moves']`) + its MODAL speed.
      strict   : the BROAD threat surface (`defense_damage`, meta >=floor U real joint) + its
                 worst-case FAST speed variant. The pessimistic floor; hole detection uses THIS.
    strict also evaluates meaningful non-modal Choice-Scarf speed and, when matchup supplies it,
    real-team (item,ability) archetypes. Any unavailable archetype lane is declared in
    `strict.missing_lanes` (never silently skipped).
  * resolvability — an ORTHOGONAL multi-turn qualifier, NOT part of the ordinal grade. The grade is a
    single-FRAME fact; a positive read (C2 wall / no-KO stalemate / slow grind) silently assumes the
    opponent neither sets up nor heals. When that is DETECTED false the read is `contested`, unless our
    member negates it — Unaware (纯朴) ignores the opponent's stat changes (hard), Haze/Taunt/phaze
    answer at a tempo cost (soft). DETECTED not modelled (design §14): no boosted-state damage is run.

Pure functions only: this module consumes already-computed matchup cell facts and calls no
dex/meta/ncp sibling. All damage/speed arithmetic happened upstream in `matchup`.
"""
from __future__ import annotations

from typing import Any

from battle_effects import (INTIMIDATE_BACKFIRE_ABILITIES, INTIMIDATE_BLOCKING_ITEMS,
                            INTIMIDATE_NO_RELIEF_ABILITIES, INTIMIDATE_REFLECT_ABILITIES,
                            ko_hits_from_pct)

# Abilities that NULLIFY an incoming priority move (the holder is never hit first by our priority).
_PRIORITY_BLOCK_ABILITIES = {"queenly majesty", "dazzling", "armor tail"}
# Priority moves that only go first IF the target attacks — never hardens a grade (soft candidate only).
_CONDITIONAL_PRIORITY = {"sucker punch", "upper hand"}
# Physical moves whose damage does not use the attacker's Attack stat: Attack-stat-independent (Body
# Press = Defense, Foul Play = the target's Attack) AND fixed/level/counter damage (Seismic Toss, Night
# Shade, Counter, Metal Burst, Endeavor, Super Fang, Final Gambit ...). Intimidate's -1 Atk cannot scale
# any of these, so the switch-in rescale must skip them (a x2/3 here is arithmetically wrong).
_INTIMIDATE_ATTACK_INDEPENDENT = {
    "body press", "foul play", "seismic toss", "night shade", "counter", "mirror coat", "metal burst",
    "endeavor", "super fang", "final gambit", "psywave", "dragon rage", "sonic boom", "bide", "guardian of alola",
}


def _priority_acts_first(move: str | None, ability_blocks: bool, opp_has_priority: bool) -> bool:
    """Shared gate for whether OUR priority move actually strikes first: the foe's ability doesn't block
    it, the foe doesn't itself carry priority (over-claim guard), and the move isn't conditional (Sucker
    Punch fails if the target doesn't attack). Single source so the `priority_first` and `priority_lane`
    guards can never drift apart when a new blocker is added."""
    return (not ability_blocks and not opp_has_priority
            and str(move or "").casefold() not in _CONDITIONAL_PRIORITY)


# --------------------------------------------------------------------------------------------------
# engagement primitives
# --------------------------------------------------------------------------------------------------
def _kill_hits(offense: dict[str, Any] | None) -> tuple[int | None, bool]:
    """Our KO turn count plus whether the kill is a hard fact.

    Static `ko_guaranteed` remains the fallback. A recovery-aware engine verdict supersedes it when
    it proves the threshold later, or disproves certainty at that same/later threshold. Relevant
    dynamic-distribution caveats that can overstate the KO also make the kill uncertain.
    """
    if not offense:
        return None, False
    g = offense.get("ko_guaranteed")
    p = offense.get("ko_possible")
    hits = g if isinstance(g, int) and g > 0 else None
    certain = hits is not None

    chance = offense.get("ko_chance")
    if isinstance(chance, dict) and isinstance(chance.get("n"), int) and chance["n"] > 0:
        n = chance["n"]
        if chance.get("guaranteed") is True:
            # OHKO remains exact unless a detected one-time-survive caveat says otherwise. For N>=2,
            # the engine's recovery-aware threshold is the more faithful turn count.
            if hits != 1:
                hits, certain = n, True
        elif hits is None or (hits != 1 and n >= hits):
            # The engine found only a chance at the static guarantee (or later): that threshold is not
            # a hard kill. Keep the earliest engine-supported turn count as soft information.
            hits, certain = n, False

    if hits is None and isinstance(p, int) and p > 0:
        hits, certain = p, False
    if hits is None:
        return None, False

    if certain:
        cav = _relevant_ko_caveats(offense)
        if hits == 1:
            # A true 1-hit KO faints the target before a PER-HIT +Def effect (Stamina / Weak Armor) can
            # matter, so those caveats are inert here — mirror `_survive`'s required>=2 boundary. A
            # one-time-survive caveat (Sturdy / Sash / Disguise / Multiscale) DOES survive the OHKO and
            # must still block certainty.
            cav = [c for c in cav if c.get("code") not in _PHYS_DEF_CAVEATS]
        blocking = [c for c in cav
                    if str(c.get("direction") or "unclear").casefold() != "understates"]
        if blocking:
            certain = False
    return hits, certain


def _worst_incoming(moves: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """The hardest-hitting incoming move (highest max roll) — what a SAFE switch-in must survive."""
    facts = [m for m in (moves or []) if m.get("max_percent") is not None]
    if not facts:
        return None
    return max(facts, key=lambda f: f["max_percent"])


def incoming_hits_required(line: str, kill_hits: int | None, we_act_first: bool) -> int | None:
    """Enemy hits we must absorb before our KO lands (the audited turn budget).
    same_field: kill_hits - (first?1:0) ; switch_in: 1 + kill_hits - (first?1:0). Floors at 0."""
    if kill_hits is None:
        return None
    base = kill_hits - (1 if we_act_first else 0)
    if line == "switch_in":
        base += 1
    return max(0, base)


# ncp caveat codes whose effect is a +Def buff that keys off DEFENSE and so ONLY bites a PHYSICAL hit
# (Stamina = +1 Def per physical hit; Weak Armor = -1 Def per physical hit). Against a SPECIAL move the
# defender's Def change is irrelevant, so such a caveat is spurious and must NOT block a hard grade —
# the Stamina/Iron-Defense category lesson: a +Def effect does not touch a special attacker (design §14).
_PHYS_DEF_CAVEATS = {"defender_stamina", "defender_weak_armor"}


def _relevant_ko_caveats(worst: dict[str, Any] | None) -> list[dict[str, Any]]:
    """ncp's ko_caveats for THIS incoming move, minus the ones its damage category makes inert. A +Def
    caveat cannot affect a Special hit, so dropping it stops a false `uncertain` (the category fix)."""
    cav = (worst or {}).get("ko_caveats") or []
    if str((worst or {}).get("category") or "").casefold() == "special":
        cav = [c for c in cav if c.get("code") not in _PHYS_DEF_CAVEATS]
    return cav


def _survive(required: int | None, worst: dict[str, Any] | None) -> str:
    """Three-valued survival verdict over the worst incoming move (design: exact/approx/uncertain/
    false). Safety is PESSIMISTIC — it uses ko_possible (a roll that KILLS within budget = not safe),
    and it prefers the recovery-aware ko_chance verdict for the N>=2 window when the calc supplies it."""
    if required is None:
        return "false"                                   # we cannot even guarantee a kill -> not safe
    if required == 0:
        return "exact_true"                              # we KO before the enemy acts
    if worst is None:
        return "exact_true"                              # no damaging incoming move on this surface
    # Recovery-aware verdict first (models Sitrus/Leftovers/hazards) when present, for the N>=2 window.
    chance = worst.get("ko_chance")
    enemy_ko = worst.get("ko_possible")                  # pessimistic: best enemy roll
    if required >= 2 and isinstance(chance, dict) and isinstance(chance.get("n"), int):
        static_poss = enemy_ko                           # the envelope-widened static bucket
        enemy_ko = chance["n"]                            # dynamic threshold, not min(static, dynamic)
        # ko_chance is the recovery-aware verdict on the CENTRAL (expected-hit) band; for a VARIABLE
        # multi-hit move ko_possible carries the TRUE damage envelope (most hits x best roll -> fewest
        # KO turns) the central verdict can miss. Keep the envelope as a pessimistic floor so a variable
        # multi-hit foe is not credited a slower KO than its own envelope allows (ncp API contract: widen
        # KO over the envelope, not the central band).
        if worst.get("hits_range") and isinstance(static_poss, int) and static_poss < enemy_ko:
            enemy_ko = static_poss
    if isinstance(enemy_ko, int) and enemy_ko <= required:
        return "false"                                   # enemy can KO within the budget
    if required <= 1:
        return "exact_true"                              # surviving exactly one hit rests on the exact OHKO fact
    # required >= 2: static N-hit approximation. A DETECTED category-relevant caveat makes the "repeat
    # hit 1" assumption unreliable -> uncertain — BUT only when it could make survival WORSE than this
    # static floor. A caveat whose direction only makes the enemy KO HARDER (`overstates` — defender
    # Stamina, one-time-survive) leaves us at-least-as-safe as approx_true, so it must NOT downgrade to
    # uncertain (mirror of `_kill_hits`, whose favorable direction is the opposite `understates`); an
    # `understates` (Weak Armor / Multiscale / attacker ramp) or `unclear`/absent direction still gates.
    blocking = [c for c in _relevant_ko_caveats(worst)
                if str(c.get("direction") or "unclear").casefold() != "overstates"]
    if blocking:
        return "uncertain"
    return "approx_true"


_SAFE_HARD = {"exact_true", "approx_true"}


def line_result(line: str, offense: dict[str, Any] | None,
                incoming_moves: list[dict[str, Any]] | None, we_act_first: bool) -> dict[str, Any]:
    """One engagement line's outcome: the turn budget, the three-valued safety verdict, and whether
    we actually secure the kill. `passes` = safe (hard) AND we secure a GUARANTEED kill — a best-roll
    (ko_possible-only) kill is pessimistically NOT a hard grade (mirrors survival's ko_possible floor);
    it is surfaced separately as `kill_uncertain` so the info is not lost, never hardening C1/C2."""
    kill, kill_certain = _kill_hits(offense)
    req = incoming_hits_required(line, kill, we_act_first)
    worst = _worst_incoming(incoming_moves)
    safe = _survive(req, worst)
    rel = _relevant_ko_caveats(worst)
    return {
        "line": line,
        "safe": safe,
        "incoming_hits_required": req,
        "our_kill_hits": kill,
        "kill_certain": kill_certain,
        "kill_uncertain": kill is not None and not kill_certain,   # best-roll kill only (not guaranteed)
        "we_act_first": we_act_first,
        "integrity_gate": ("blocked:" + ",".join(
            sorted({str(c.get("cause") or c.get("code") or "caveat") for c in rel}))
            ) if (safe == "uncertain" and rel) else None,
        "passes": safe in _SAFE_HARD and kill is not None and kill_certain,
    }


def grade_over_surface(offense: dict[str, Any] | None, incoming_moves: list[dict[str, Any]] | None,
                       we_act_first: bool, resist_stab: bool) -> dict[str, Any]:
    """Grade ONE (surface, speed) scenario. Returns primary grade (C2/C1/C0), both line results, and
    the UNORDERED descriptors (c1_mode / c2_basis) + predicates."""
    same = line_result("same_field", offense, incoming_moves, we_act_first)
    switch = line_result("switch_in", offense, incoming_moves, we_act_first)
    kill, _ = _kill_hits(offense)
    if switch["passes"]:
        grade = "C2"
    elif same["passes"]:
        grade = "C1"
    else:
        grade = "C0"
    c1_mode = c2_basis = None
    if grade == "C1":
        if we_act_first and kill == 1:
            c1_mode = "clean_revenge"
        elif we_act_first and kill == 2:
            c1_mode = "speed_trade"
        elif not we_act_first:
            c1_mode = "bulk_revenge"
        else:
            c1_mode = "same_field"
    elif grade == "C2":
        c2_basis = "type_advantaged" if resist_stab else "bulk"
    return {
        "grade": grade, "c1_mode": c1_mode, "c2_basis": c2_basis,
        "lines": {"same_field": same, "switch_in": switch},
        "predicates": {"we_act_first": we_act_first, "resist_stab": resist_stab,
                       "type_advantaged": resist_stab},
    }


_GRADE_RANK = {"C0": 0, "C1": 1, "C2": 2}


# --------------------------------------------------------------------------------------------------
# cell -> check object
# --------------------------------------------------------------------------------------------------
def _modal_incoming(cell: dict[str, Any],
                    opp_set: dict[str, Any] | None) -> tuple[list[dict[str, Any]], bool]:
    """The HEADLINE incoming surface + whether it is a DISTINCT modal read. Returns (surface, is_modal):
    the broad `defense_damage` facts filtered down to the opponent's MODAL joint moveset — a subset of an
    already-computed list, no extra ncp. `is_modal` is False when it FALLS BACK to the broad surface (no
    distinct joint set, or the joint moves are all non-damaging / absent from the damage facts) so the
    caller can label the headline honestly instead of claiming a modal read it never evaluated."""
    dd = (cell.get("defense_damage") or {}).get("moves") or []
    joint = {m for m in (opp_set or {}).get("moves") or [] if isinstance(m, str)}
    if not joint:
        return dd, False
    subset = [f for f in dd if f.get("move") in joint]
    return (subset, True) if subset else (dd, False)


def _broad_incoming(cell: dict[str, Any]) -> list[dict[str, Any]]:
    """The STRICT incoming surface: the full broad threat surface matchup already computed."""
    return (cell.get("defense_damage") or {}).get("moves") or []


def _eid(fmt: str, attacker: str, defender: str, move: str | None) -> str | None:
    return f"ncp:{fmt}:{attacker}|{defender}|{move}" if move else None


# The top-level cell keys build_check consumes. A consumer that SYNTHESISES a cell (oppcache._synth_cell;
# matchup builds them inline) must supply every one — even as None — so a future key added to build_check's
# contract fails LOUDLY in the derived views instead of silently reading as None (a quietly weaker grade).
REQUIRED_CELL_KEYS = frozenset({
    "offense", "defense_damage", "opponent", "speed", "defense_type", "opponent_has_priority",
})


def assert_cell_contract(cell: dict[str, Any]) -> None:
    """Raise if a synthesised cell omits a key build_check reads (present-with-None is fine). Turns a
    silently-degraded derived grade into a loud failure the moment build_check's contract grows a key."""
    missing = REQUIRED_CELL_KEYS - set(cell)
    if missing:
        raise KeyError(f"synthesised check cell missing required build_check keys: {sorted(missing)}")


def build_check(cell: dict[str, Any], member: str, opp_set: dict[str, Any] | None,
                fmt: str, member_set: dict[str, Any] | None = None,
                archetypes: list[dict[str, Any]] | None = None,
                archetypes_partial: bool = False) -> dict[str, Any] | None:
    """The `check` sub-object for one matchup cell. Returns None when damage is unavailable (no
    offense/defense to grade on) — the cell keeps its raw facts and simply carries no grade.

    `member` is the species NAME (evidence_ids); `member_set` (optional) is our full set — its
    ability + moves drive the multi-turn resolvability gate's OUR-negation leg (Unaware / Haze / ...).

    `archetypes` is the repset (item,ability) lane (design §17). None (the default) = the lane was NOT
    evaluated (thin/absent repset), so it stays disclosed in `strict.missing_lanes` and `primary_grade`
    rests on the modal set alone (the pre-existing behaviour — every legacy caller keeps it). A LIST
    (even empty) = the lane WAS evaluated: each entry is a pre-graded EXTRA archetype
    ({cluster, coverage, confidence, grade, we_act_first_fast}) matchup computed with that archetype's
    own item/ability/spread. Then `primary_grade` (the hole-detection axis) becomes the pessimistic
    FLOOR across the modal grade AND every archetype grade — a real build that breaks the check drops
    the floor — while `strict.grade` keeps the MODAL grade (its lines + evidence_ids), and
    `strict.archetypes` discloses each. An empty list = repset resolved but the modal is the only real
    archetype (nothing extra to worsen the floor), which still clears the missing lane (evaluated)."""
    if cell.get("offense") is None and cell.get("defense_damage") is None:
        return None
    opp = cell.get("opponent")
    speed = cell.get("speed") or {}
    offense = cell.get("offense")
    resist_stab = (cell.get("defense_type") or {}).get("max_effectiveness_vs_member")
    # < 1, not <= 1: a NEUTRAL (1.0x) matchup is not "resisting" the opponent's best type — only a
    # genuinely reduced multiplier is. Counting 1.0x as resist mislabels a neutral C2 as type_advantaged.
    resist_stab = (resist_stab is not None and resist_stab < 1)

    # Priority: our KO move's speed-priority stage lets a SLOW member still act first — but only when the
    # foe can't block it (Queenly Majesty / Dazzling / Armor Tail) AND doesn't itself carry priority, and
    # the move isn't conditional (Sucker Punch fails if the target doesn't attack). It only ever UPGRADES
    # who-acts-first (never claims we're slower). A conditional/blocked case stays a soft candidate.
    our_prio = (offense or {}).get("priority") or 0
    opp_ability = str((opp_set or {}).get("ability") or "").casefold()
    prio_move = str((offense or {}).get("move") or "").casefold()
    ability_blocks = opp_ability in _PRIORITY_BLOCK_ABILITIES
    opp_has_priority = bool(cell.get("opponent_has_priority"))
    priority_first = our_prio > 0 and _priority_acts_first(prio_move, ability_blocks, opp_has_priority)
    priority_kill_candidate = our_prio > 0 and not ability_blocks
    # A NEGATIVE-priority KO move (our best-damage move is Avalanche / Focus Punch ...) strikes in a late
    # bracket, so raw Speed must NOT claim we act first. Priority only ever UPGRADES who-acts-first
    # (design §17 "只上不下"); a negative bracket just blocks the Speed-based first read.
    speed_first_ok = our_prio >= 0

    # headline: modal moveset + modal speed order (priority upgrades a slow member to first).
    we_first_modal = (speed.get("faster") == "member" and speed_first_ok) or priority_first
    modal_surface, modal_is_distinct = _modal_incoming(cell, opp_set)
    headline = grade_over_surface(offense, modal_surface, we_first_modal, resist_stab)

    # strict: broad surface + worst-case fast speed (member must beat the opponent's fast variant AND,
    # when the foe runs Choice Scarf at meaningful usage, its x1.5 scarf variant too — a tie counts as
    # NOT first). This is the pessimistic floor hole-detection reads.
    m_spe, o_fast = speed.get("member"), speed.get("opponent_fast")
    o_scarf = speed.get("opponent_scarf")                # non-modal Scarf speed when it is a real lane
    fast_threshold = o_fast
    if o_scarf is not None and (fast_threshold is None or o_scarf > fast_threshold):
        fast_threshold = o_scarf
    we_first_fast = (bool(m_spe is not None and fast_threshold is not None and m_spe > fast_threshold)
                     and speed_first_ok) or priority_first
    strict = grade_over_surface(offense, _broad_incoming(cell), we_first_fast, resist_stab)

    # strict completeness: matchup folds a meaningful non-modal Scarf variant into `opponent_scarf`.
    # The repset archetype lane is evaluated only when the caller supplies a list (including empty).
    missing: list[str] = [] if archetypes is not None else ["repset_archetypes"]
    if archetypes is not None and archetypes_partial:
        missing.append("repset_archetypes_partial")     # a real archetype's ncp requests ALL failed —
                                                         # evaluated but not fully covered, not a clean lane
    completeness = "incomplete" if missing else "complete"

    # Archetype floor (design §17): primary_grade — the hole-detection axis — is the PESSIMISTIC grade
    # across the modal set AND every real archetype (a build that breaks the check drops the floor).
    # `strict.grade` stays the MODAL grade (it owns the displayed lines + evidence_ids); the archetype
    # grades are DISCLOSED facts (like resolvability / intimidate_lane — no evidence_id of their own).
    arch_lanes = None
    strict_floor = strict["grade"]
    if archetypes is not None:
        arch_lanes = [{"cluster": a.get("cluster"), "coverage": a.get("coverage"),
                       "confidence": a.get("confidence"), "grade": a.get("grade"),
                       "we_act_first_fast": a.get("we_act_first_fast"), "c0_kind": a.get("c0_kind"),
                       "resolvability": a.get("resolvability")}
                      for a in archetypes]
        for a in arch_lanes:
            if a.get("grade") and _GRADE_RANK[a["grade"]] < _GRADE_RANK[strict_floor]:
                strict_floor = a["grade"]

    fragility = _fragility(headline, strict, offense, cell, opp_set, resist_stab,
                           we_first_modal, we_first_fast, completeness)

    # C0 sub-kind (ORTHOGONAL to the ordinal — it never re-ranks C0): a defensive STALEMATE (we can't
    # reliably close, but the opponent can't 2HKO us either — a wall that just can't finish) vs an
    # outright LOSS. The wall test uses a fixed switch-in defensive budget of 2 (survive the switch hit
    # + one follow-up), INDEPENDENT of our kill, so a walled-but-can't-KO cell no longer collapses into
    # the kill-tied _survive (design §17 — resolves the C0-loss vs C0-wall ambiguity).
    # C0 already means NO winning line (we never cleanly close — a fast certain kill that we survive
    # would have passed to C1/C2). So the split is purely defensive: do they break us in the near term?
    # A slow guaranteed kill (7HKO) is NOT "closing" and must not disqualify the wall.
    worst_broad = _worst_incoming(_broad_incoming(cell))
    modal_c0_kind = None
    if strict["grade"] == "C0":
        modal_c0_kind = "wall_no_ko" if _survive(2, worst_broad) in _SAFE_HARD else "loss"
    c0_kind = None
    if strict_floor == "C0":
        floor_kinds = ([modal_c0_kind] if strict["grade"] == "C0" else []) + [
            a.get("c0_kind") for a in (arch_lanes or []) if a.get("grade") == "C0"]
        c0_kind = ("loss" if "loss" in floor_kinds else
                   "wall_no_ko" if "wall_no_ko" in floor_kinds else None)

    modal_resolvability = _resolvability(
        offense, strict, cell, opp_set, member_set, modal_c0_kind, priority_first=priority_first)
    resolvability = _floor_resolvability(
        modal_resolvability, strict["grade"], strict_floor, arch_lanes, c0_kind)
    intimidate_lane = _intimidate_switch_in(cell, offense, opp_set, member_set, we_first_fast)

    # priority revenge lane (soft): our best PRIORITY move striking first — a weaker move than our
    # hardest hit, but it can revenge a fast frail threat the neutral best-damage grade misses. Grade it
    # with we_act_first forced True (gated like priority_first); informational, never hardens the grade.
    prio_off = (offense or {}).get("priority_offense")
    priority_lane = None
    if prio_off and _priority_acts_first(prio_off.get("move"), ability_blocks, opp_has_priority):
        pg = grade_over_surface(prio_off, _broad_incoming(cell), True, resist_stab)
        priority_lane = {"move": prio_off.get("move"), "priority": prio_off.get("priority"),
                         "grade": pg["grade"],
                         "switch_in_passes": pg["lines"]["switch_in"]["passes"],
                         "same_field_passes": pg["lines"]["same_field"]["passes"],
                         "note": "best PRIORITY move striking first; SOFT lane — never hardens the grade"}

    off_move = (offense or {}).get("move")
    evidence = [e for e in (
        _eid(fmt, member, opp, off_move),
        _eid(fmt, opp, member, (worst_broad or {}).get("move")),
        f"spd:{fmt}:{member}|{opp}",
    ) if e]

    caveats: list[str] = []
    for scen in (headline, strict):
        sw = scen["lines"]["switch_in"]
        if sw["safe"] == "approx_true":
            caveats.append(f"{scen is strict and 'strict' or 'headline'}: switch_in "
                           f"incoming={sw['incoming_hits_required']} static approx (only OHKO exact)")
        if sw["integrity_gate"]:
            caveats.append(f"switch_in survival uncertain — {sw['integrity_gate']}")
    if completeness == "incomplete":
        caveats.append("strict floor incomplete — unevaluated lanes: " + ", ".join(missing))
    if arch_lanes and _GRADE_RANK[strict_floor] < _GRADE_RANK[strict["grade"]]:
        worst = min((a for a in arch_lanes if a.get("grade")),
                    key=lambda a: _GRADE_RANK[a["grade"]])
        caveats.append(f"a real archetype {worst.get('cluster')} (coverage {worst.get('coverage')}) "
                       f"drops the strict floor to {strict_floor} from the modal {strict['grade']} — "
                       "primary_grade reads this pessimistic floor")
    if our_prio > 0 and not priority_first and speed.get("faster") != "member":
        why = ("blocked by opponent " + opp_ability if ability_blocks
               else "conditional (only if the foe attacks)" if prio_move in _CONDITIONAL_PRIORITY
               else "opponent also carries priority")
        caveats.append(f"our priority KO move is not counted as acting-first — {why}")
    if resolvability["verdict"] == "contested":
        caveats.append("multi-turn: " + resolvability["note"])

    return {
        "primary_grade": strict_floor,                   # hole-detection axis = the pessimistic floor
                                                         # across the modal set AND every real archetype
        "headline": {"grade": headline["grade"], "c1_mode": headline["c1_mode"],
                     "c2_basis": headline["c2_basis"],
                     "surface": "modal_joint_moves" if modal_is_distinct else "broad_fallback",
                     "lines": headline["lines"]},
        "strict": {"grade": strict["grade"], "c1_mode": strict["c1_mode"],
                   "c2_basis": strict["c2_basis"], "surface": "broad_threat_surface",
                   "completeness": completeness, "missing_lanes": missing,
                   "archetypes": arch_lanes,             # per-archetype strict facts (null = unevaluated)
                   "floor_grade": strict_floor,          # == primary_grade; worst of modal + archetypes
                   "modal_resolvability": modal_resolvability,
                   "lines": strict["lines"]},
        "predicates": {**headline["predicates"],
                       "we_act_first_fast": we_first_fast,
                       "priority_first": priority_first,
                       "priority_kill_candidate": priority_kill_candidate},
        "condition_profile": "neutral",
        "c0_kind": c0_kind,                              # loss | wall_no_ko | null (only meaningful on C0)
        "set_fragility": fragility,
        "resolvability": resolvability,                  # qualifier aligned to primary_grade / floor
        "intimidate_lane": intimidate_lane,              # soft -1 Atk switch-in read (null unless we have it)
        "priority_lane": priority_lane,                  # soft: best priority move striking first (null if none)
        "vs_set": {"set_confidence": (opp_set or {}).get("confidence"),
                   "source": (opp_set or {}).get("note")},
        "evaluated_surface": {"floor": "matchup-default",
                              "note": "does not enumerate rare coverage moves below the usage floor"},
        "evidence_ids": evidence,
        "caveats": caveats,
    }


def _fragility(headline: dict[str, Any], strict: dict[str, Any], offense: dict[str, Any] | None,
               cell: dict[str, Any], opp_set: dict[str, Any] | None, resist_stab: bool,
               we_first_modal: bool, we_first_fast: bool, completeness: str) -> dict[str, Any]:
    """Why (and how far) the grade drops from headline to strict — an ENUM + reason list, NEVER a
    numeric tier gap (a distance integer is a latent score; audit). Attributes the drop to speed
    (fast/scarf variant flips who-acts-first) vs coverage (a broad-surface move the modal set omits)
    by re-grading each axis in isolation."""
    if _GRADE_RANK[strict["grade"]] >= _GRADE_RANK[headline["grade"]]:
        tag = "stable" if completeness == "complete" else "low_confidence"
        reason = [] if completeness == "complete" else ["strict_incomplete"]
        return {"tag": tag, "from": headline["grade"], "to": strict["grade"], "reason": reason}
    reason: list[str] = []
    # speed-only demotion: modal surface but the fast speed order.
    if we_first_modal != we_first_fast:
        speed_only = grade_over_surface(offense, _modal_incoming(cell, opp_set)[0], we_first_fast, resist_stab)
        if _GRADE_RANK[speed_only["grade"]] < _GRADE_RANK[headline["grade"]]:
            reason.append("scarf_speed")
    # coverage-only demotion: broad surface but the modal speed order.
    cover_only = grade_over_surface(offense, _broad_incoming(cell), we_first_modal, resist_stab)
    if _GRADE_RANK[cover_only["grade"]] < _GRADE_RANK[headline["grade"]]:
        reason.append("coverage_move")
    if not reason:
        reason.append("combined")
    if completeness == "incomplete":
        reason.append("strict_incomplete")
    tag = ("speed_fragile" if reason == ["scarf_speed"]
           else "coverage_fragile" if reason == ["coverage_move"]
           else "fragile")
    return {"tag": tag, "from": headline["grade"], "to": strict["grade"], "reason": reason}


# --------------------------------------------------------------------------------------------------
# multi-turn resolvability gate (design §17) — a FACTS-ONLY qualifier, ORTHOGONAL to C2/C1/C0.
# The ordinal grade is a single-FRAME KO/survival fact; a POSITIVE multi-turn read (a C2 switch-in
# wall, a no-KO stalemate, a slow grind-down) silently assumes the opponent neither sets up nor heals.
# When that assumption is DETECTED false (opponent carries setup/recovery on its evaluated moves) the
# read is `contested` — UNLESS our member structurally negates it: Unaware (纯朴) ignores the
# opponent's stat changes entirely (setup can't break the wall; Iron Defense + Body Press can't either,
# because we ignore the attacker's Def boost), while Haze/Clear Smog/phaze/Taunt/Encore answer it at a
# tempo cost. DETECTED, not modelled (design §14): NO boosted-state damage is recomputed — we surface
# the capability and who negates it, never a simulated trajectory.
# --------------------------------------------------------------------------------------------------
_OFFENSE_SETUP = {                      # boosts an ATTACKING stat -> escalating offense THROUGH a wall
    "swords dance", "dragon dance", "nasty plot", "calm mind", "quiver dance", "bulk up", "work up",
    "tail glow", "growth", "shell smash", "victory dance", "clangorous soul", "no retreat", "coil",
    "howl", "meditate", "sharpen", "fillet away", "belly drum", "geomancy", "take heart",
    "curse", "hone claws", "tidy up",   # +Atk setup (Curse also +Def, Tidy Up also +Spe — both listed
                                        # in the defensive/speed tables too)
    "torch song", "meteor beam",        # damage-AND-boost moves that ramp SpA each use
}
_SPEED_SETUP = {                        # can invalidate a check that relies on moving first
    "agility", "autotomize", "clangorous soul", "dragon dance", "fillet away", "flame charge",
    "geomancy", "no retreat", "quiver dance", "rapid spin", "rock polish", "scale shot",
    "shell smash", "shift gear", "tidy up", "trailblaze", "victory dance",
}
_DEFENSE_SETUP = {                      # boosts a DEFENSIVE stat — inert alone; a threat only paired with
    "iron defense", "acid armor", "cotton guard", "barrier", "amnesia", "cosmic power", "stockpile",
    "defense curl", "harden", "stuff cheeks", "shelter", "curse",    # ...a defensive-stat->offense
                                                                     # converter (Curse feeds Body Press)
}
_DEF_TO_OFFENSE = {"body press", "stored power", "power trip"}   # turns a defensive/any boost into damage
_UNAWARE_BP_BYPASS = {"stored power", "power trip"}  # boosts still raise these moves' base power
_RECOVERY = {                           # opponent out-sustains our chip -> a slow-KO claim is unreliable
    "recover", "roost", "synthesis", "moonlight", "morning sun", "slack off", "soft-boiled",
    "milk drink", "rest", "wish", "shore up", "strength sap", "life dew", "jungle healing",
    "lunar blessing", "heal order", "purify",
}
# our anti-setup ANSWERS (moves): haze/clear smog reset or strip boosts; phazing forces the boosted mon
# out; taunt blocks future setup AND recovery; encore locks a non-attacking setup move. A tempo/timing
# cost -> softens `contested` (disclosed), never silently erases it.
_ANTI_SETUP_MOVES = {"haze", "clear smog", "roar", "whirlwind", "dragon tail", "circle throw",
                     "taunt", "encore"}
_ANTI_RECOVERY_MOVES = {"taunt", "roar", "whirlwind", "dragon tail", "circle throw"}  # block/skip the heal
_ANTI_SETUP_ABILITY = {"unaware"}       # 纯朴: ignores the opponent's stat changes entirely (both ways)


def _floor_resolvability(modal: dict[str, Any], modal_grade: str, floor_grade: str,
                         archetypes: list[dict[str, Any]] | None,
                         c0_kind: str | None) -> dict[str, Any]:
    """Align the public qualifier with the same modal/archetype floor as `primary_grade`. The floor lane
    is the modal set PLUS any real archetype tied at the floor grade; the qualifier reads the PESSIMISTIC
    verdict across them, so a clean modal wall that a same-floor-grade real archetype contests still
    surfaces as `contested` (it is not hidden behind the modal reading clean)."""
    floor_rows = [a for a in (archetypes or []) if a.get("grade") == floor_grade]
    resolved = [(a, a.get("resolvability")) for a in floor_rows
                if isinstance(a.get("resolvability"), dict)]
    contested = [(a, r) for a, r in resolved if r.get("verdict") == "contested"]
    contested_floor = [{"cluster": a.get("cluster"), "applies_to": r.get("applies_to")}
                       for a, r in contested]

    def _qual(verdict: str, applies_to: str | None, active: bool,
              archetype_floor: list, note: str) -> dict[str, Any]:
        """Single source for the floor-qualifier shape — a future resolvability key is added here ONCE,
        never missed in one of the cold branches below."""
        return {"verdict": verdict, "applies_to": applies_to, "active": active,
                "opponent": {}, "our_negation": {}, "archetype_floor": archetype_floor, "note": note}

    if floor_grade == modal_grade:
        # Floor is the modal lane; its own read qualifies it, but a real archetype TIED at the same grade
        # whose positive read is contested makes the floor contested too (else it hides behind the modal).
        if modal.get("verdict") == "contested" or not contested:
            return modal
        return _qual("contested", modal.get("applies_to"), True, contested_floor,
                     "a real archetype tied at the floor grade has its positive read contested by "
                     "detected setup/recovery (the modal read is clean); inspect strict.archetypes")
    if floor_grade == "C0" and c0_kind == "loss":
        return _qual("clean", None, False, [a.get("cluster") for a in floor_rows],
                     "the archetype floor is a loss, so there is no positive multi-turn read to qualify")
    if contested:
        return _qual("contested", "archetype_floor", True, contested_floor,
                     "a floor-defining real archetype has a positive read contested by its "
                     "detected setup/recovery; inspect strict.archetypes")
    active = [(a, r) for a, r in resolved if r.get("active")]
    return _qual("clean", "archetype_floor" if active else None, bool(active),
                 [a.get("cluster") for a in floor_rows],
                 "floor-defining archetype reads are clean" if active
                 else "no positive floor-archetype multi-turn read to qualify")


def _resolvability(offense: dict[str, Any] | None, strict: dict[str, Any], cell: dict[str, Any],
                   opp_set: dict[str, Any] | None, member_set: dict[str, Any] | None,
                   c0_kind: str | None = None, *, priority_first: bool = False) -> dict[str, Any]:
    """Qualify the cell's POSITIVE multi-turn read (C2 wall / stalemate / slow grind) as clean vs
    contested by DETECTING opponent setup/recovery and OUR negation of it. Facts only — no boosted
    damage is recomputed; a `contested` verdict names the capability and who (if anyone) answers it."""
    # opponent capability over the SAME move names the grade already saw (modal joint U broad surface).
    opp_moves = {m.lower() for m in ((opp_set or {}).get("moves") or []) if isinstance(m, str)}
    opp_moves |= {(f.get("move") or "").lower() for f in _broad_incoming(cell)}
    off_setup = sorted(opp_moves & _OFFENSE_SETUP)
    speed_setup = sorted(opp_moves & _SPEED_SETUP)
    def_setup = sorted(opp_moves & _DEFENSE_SETUP)
    converters = sorted(opp_moves & _DEF_TO_OFFENSE)
    recovery = sorted(opp_moves & _RECOVERY)
    defense_conversion = bool(def_setup) and bool(converters)
    speed_escalation = (bool(speed_setup) and strict["predicates"].get("we_act_first")
                        and not priority_first)
    # Stored Power / Power Trip scale with the TOTAL boost count (Speed boosts included), which Unaware
    # does not ignore — so an Agility (speed-only) + Stored Power line still escalates through a wall.
    bp_bypass = bool((set(off_setup) | set(def_setup) | set(speed_setup)) and (opp_moves & _UNAWARE_BP_BYPASS))
    offense_escalation = bool(off_setup) or defense_conversion or speed_escalation or bp_bypass

    # which positive/neutral read (if any) is at risk. Qualified claims: a C2 switch-in wall, a slow
    # (>=2-hit) grind we survive, or a defensive STALEMATE (`c0_kind == wall_no_ko` — we can't close but
    # they can't 2HKO us). A plain loss and a clean fast (OHKO) revenge carry no multi-turn claim.
    kill, _ = _kill_hits(offense)
    sw, sf = strict["lines"]["switch_in"], strict["lines"]["same_field"]
    we_survive = sf["safe"] in _SAFE_HARD or sw["safe"] in _SAFE_HARD
    if strict["grade"] == "C2":
        claim = "switch_in_wall"
    elif kill is not None and kill >= 2 and we_survive:
        claim = "slow_grind"
    elif c0_kind == "wall_no_ko":
        claim = "stalemate"
    else:
        claim = None
    if claim is None:
        return {"verdict": "clean", "applies_to": None, "active": False,
                "opponent": {}, "our_negation": {}, "note": "no positive multi-turn claim to qualify"}

    # recovery bites only a claim that ASSERTS a KO we must grind for (a fast OHKO or a pure stalemate
    # is unaffected by the opponent healing).
    recovery_threat = (bool(recovery) and claim in ("switch_in_wall", "slow_grind")
                       and kill is not None and kill >= 2)
    if not (offense_escalation or recovery_threat):
        note = ("opponent recovery detected but it does not threaten a stalemate (a mutual non-KO draw)"
                if recovery and claim == "stalemate"
                else "no setup/recovery that threatens this read on the opponent's evaluated moves")
        return {"verdict": "clean", "applies_to": claim, "active": True,
                "opponent": ({"recovery": recovery} if recovery else {}), "our_negation": {}, "note": note}

    # our negation. Unaware HARD-answers every stat-boost escalation leg (it ignores the boosts); moves
    # SOFT-answer at a tempo cost. Unaware does NOT stop recovery (only Taunt/phaze do).
    our_ability = ((member_set or {}).get("ability") or "").lower()
    our_moves = {m.lower() for m in ((member_set or {}).get("moves") or []) if isinstance(m, str)}
    hard = our_ability in _ANTI_SETUP_ABILITY
    setup_answers = sorted(our_moves & _ANTI_SETUP_MOVES)
    recov_answers = sorted(our_moves & _ANTI_RECOVERY_MOVES)
    # Unaware clears ordinary attacking-stat escalation and Body Press's Defense-stage scaling, but it
    # does not ignore Speed for turn order or the boost-count base-power scaling of Stored Power/Power Trip.
    setup_unnegated = offense_escalation and (not hard or speed_escalation or bp_bypass)
    recovery_unnegated = recovery_threat and not recov_answers

    reasons: list[str] = []
    if offense_escalation:
        reasons.append("opponent_offense_setup" if off_setup else
                       "opponent_def_setup+converter" if defense_conversion else
                       "opponent_speed_setup")
        if speed_escalation:
            reasons.append("speed_setup_can_flip_turn_order")
        if bp_bypass:
            reasons.append("stored_power_or_power_trip_scales_through_unaware")
    if recovery_threat:
        reasons.append("opponent_recovery")

    our_neg: dict[str, Any] = {}
    if hard and offense_escalation:
        our_neg["ability"] = ("Unaware (partial: Speed order and Stored Power/Power Trip base power "
                              "are not ignored)" if (speed_escalation or bp_bypass) else "Unaware")
    answers = sorted(set(setup_answers) | set(recov_answers))
    if answers:
        our_neg["moves"] = answers

    contested = setup_unnegated or recovery_unnegated
    if not contested:
        verdict = "clean"
        note = ("our Unaware ignores the relevant opponent stat changes — setup cannot break this wall"
                if hard else "our moves answer the detected threat before it snowballs")
    else:
        verdict = "contested"
        note = ("DETECTED opponent " + " + ".join(reasons) + "; the static grade assumes neither — treat "
                "the positive read as contested"
                + (f" (we carry a tempo-cost answer: {', '.join(answers)})" if answers else ""))
    return {
        "verdict": verdict, "applies_to": claim, "active": True,
        "opponent": {k: v for k, v in (("offense_setup", off_setup), ("speed_setup", speed_setup),
                                       ("defense_setup", def_setup),
                                       ("converters", converters), ("recovery", recovery)) if v},
        "our_negation": our_neg, "note": note,
    }


# --------------------------------------------------------------------------------------------------
# Intimidate lane (design §17) — a SOFT `with_own_intimidate` switch-in read, never hardens the grade.
# When OUR member has Intimidate, switching in drops a physical attacker's Attack one stage: damage is
# linear in Attack so a -1 hit is exactly x2/3. We recompute ONLY the switch-in survival over the
# physical incoming (scaled x2/3), gated OFF by an Intimidate-immune foe. Pure arithmetic — no extra ncp.
# --------------------------------------------------------------------------------------------------
def _intimidate_switch_in(cell: dict[str, Any], offense: dict[str, Any] | None,
                          opp_set: dict[str, Any] | None, member_set: dict[str, Any] | None,
                          we_first: bool) -> dict[str, Any] | None:
    """The switch-in survival WITH our Intimidate applied (physical incoming x2/3). None when our member
    has no Intimidate. Informational only: a softer switch-in read, never folded into primary_grade."""
    if str((member_set or {}).get("ability") or "").casefold() != "intimidate":
        return None
    opp_ab = str((opp_set or {}).get("ability") or "").casefold()
    opp_item = str((opp_set or {}).get("item") or "").casefold()
    if opp_ab in INTIMIDATE_NO_RELIEF_ABILITIES:
        if opp_ab in INTIMIDATE_BACKFIRE_ABILITIES:
            why = f"opponent {opp_ab} turns Intimidate into a NET +Attack — the drop backfires, not just blocked"
        elif opp_ab in INTIMIDATE_REFLECT_ABILITIES:
            why = f"opponent {opp_ab} reflects the Intimidate drop back onto our member (the foe keeps full Attack)"
        else:
            why = f"opponent {opp_ab} is immune to the Intimidate Attack drop (net 0, no -1)"
        return {"applicable": False, "reason": why}
    if opp_item in INTIMIDATE_BLOCKING_ITEMS:
        return {"applicable": False, "reason": f"opponent {opp_item} blocks the Intimidate Attack drop"}
    broad = _broad_incoming(cell)
    physical = [f for f in broad if str(f.get("category") or "").casefold() == "physical"
                and str(f.get("move") or "").casefold() not in _INTIMIDATE_ATTACK_INDEPENDENT]
    if opp_ab == "competitive" and any(
            str(f.get("category") or "").casefold() == "special" for f in broad):
        return {"applicable": False,
                "reason": "opponent Competitive raises SpA after Intimidate; mixed threat surface not rescaled"}
    if not physical:
        return {"applicable": False, "reason": "no physical threat on the evaluated surface"}
    multiplier = 1 / 2 if opp_ab == "simple" else 2 / 3
    phys_ids = {id(f) for f in physical}     # identity, not dict-equality: O(1) and no equal-entry collision
    scaled: list[dict[str, Any]] = []
    for f in broad:
        if id(f) not in phys_ids:
            scaled.append(f)
            continue
        g = dict(f)
        for k in ("max_percent", "min_percent"):
            if isinstance(f.get(k), (int, float)):
                g[k] = f[k] * multiplier
        g["ko_possible"], g["ko_guaranteed"] = ko_hits_from_pct(g.get("max_percent")), ko_hits_from_pct(g.get("min_percent"))
        g.pop("ko_chance", None)             # the recovery-aware verdict is stale once we rescale damage
        scaled.append(g)
    line = line_result("switch_in", offense, scaled, we_first)
    return {"applicable": True,
            "switch_in": {"safe": line["safe"], "passes": line["passes"],
                           "incoming_hits_required": line["incoming_hits_required"]},
            "note": f"Attack-based physical incoming rescaled x{multiplier:g} (-1 Atk) on the switch-in; "
                    "SOFT lane — never hardens the grade. APPROXIMATE: scales the already-rounded damage "
                    "percent (not the integer per-hit pipeline) and drops the recovery-aware ko_chance, so "
                    "a band that straddles a KO boundary can read a turn off — informational only"}


# --------------------------------------------------------------------------------------------------
# coverage roll-up (per opponent, across the team) — the headline PRODUCT: where the holes are
# --------------------------------------------------------------------------------------------------
def coverage_summary(members: list[dict[str, Any]]) -> dict[str, Any]:
    """Per-opponent: the best strict primary grade any member reaches + who, and the explicit HOLE
    list (opponents whose best strict grade is only C1 (revenge-only) or C0 (none)). Facts only —
    a per-opponent label table + a distribution, NOT a team score and NOT a ranking of opponents."""
    per_opp: dict[str, dict[str, Any]] = {}
    order: list[str] = []
    for mrow in members:
        who = mrow.get("member")
        for c in mrow.get("cells", []):
            chk = c.get("check")
            if not chk:
                continue
            opp = c.get("opponent")
            if opp not in per_opp:
                per_opp[opp] = {"opponent": opp, "usage_rank": c.get("usage_rank"),
                                "best_strict": "C0", "best_switch_in_by": [],
                                "best_modal_headline": "C0", "modal_headline_by": [], "fragile": [],
                                "contested": [], "wall_no_ko_by": []}
                order.append(opp)
            e = per_opp[opp]
            g = chk["primary_grade"]
            if g == "C0" and chk.get("c0_kind") == "wall_no_ko" and who not in e["wall_no_ko_by"]:
                e["wall_no_ko_by"].append(who)             # walls it but can't KO (a stalemate, not a loss)
            if _GRADE_RANK[g] > _GRADE_RANK[e["best_strict"]]:
                e["best_strict"] = g
                e["best_switch_in_by"] = [who] if g == "C2" else []
            elif g == e["best_strict"] == "C2":
                e["best_switch_in_by"].append(who)
            res = chk.get("resolvability") or {}
            if res.get("verdict") == "contested" and all(
                    who != x.split(":", 1)[0] for x in e["contested"]):
                e["contested"].append(f"{who}:{res.get('applies_to')}")
            mh = chk["headline"]["grade"]                # the MODAL-surface overall grade (not a strict
            if _GRADE_RANK[mh] > _GRADE_RANK[e["best_modal_headline"]]:   # switch-in and not a same-field
                e["best_modal_headline"] = mh            # line — named honestly so a hole row does not
                e["modal_headline_by"] = [who]           # read a modal C2 as a strict answer
            elif mh == e["best_modal_headline"] and mh != "C0":
                e["modal_headline_by"].append(who)
            frag = (chk.get("set_fragility") or {}).get("tag")
            if frag in ("speed_fragile", "coverage_fragile", "fragile") and who not in e["fragile"]:
                e["fragile"].append(f"{who}:{frag}")
    rows = [per_opp[o] for o in order]
    holes = [r for r in rows if _GRADE_RANK[r["best_strict"]] <= 1]      # C1 or C0 = no hard check
    dist: dict[str, int] = {"C2": 0, "C1": 0, "C0": 0}
    for r in rows:
        dist[r["best_strict"]] += 1
    return {
        "by_opponent": rows,
        "holes": [{"opponent": r["opponent"], "usage_rank": r["usage_rank"],
                   "best_strict": r["best_strict"], "best_modal_headline": r["best_modal_headline"],
                   "modal_headline_by": r["modal_headline_by"], "wall_no_ko_by": r["wall_no_ko_by"]}
                  for r in holes],
        "grade_distribution": dist,      # a COUNT, not a score; no cross-team ranking is emitted
        "note": ("best_strict = strongest strict (pessimistic-floor) grade any member reaches vs that "
                 "opponent; a HOLE = best_strict in {C1,C0} (no safe switch-in check). "
                 "`best_modal_headline` is the MODAL-set overall grade (a typical-set read, may exceed "
                 "best_strict — NOT a strict answer). `wall_no_ko_by` = members that WALL the opponent "
                 "(survive it) but can't KO — a stalemate, NOT a loss (distinct from a plain C0). "
                 "`contested` lists members whose positive read that opponent's DETECTED setup/recovery "
                 "undermines (a C2 wall / a stalemate is not clean if it is also contested; design §17). "
                 "C2/C1/C0 is an ordinal LABEL, never summed into a team score — cross-team comparison "
                 "is the reader's judgment (design §1/§16)."),
    }
