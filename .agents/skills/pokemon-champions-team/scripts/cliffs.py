#!/usr/bin/env python
"""Pure cliff math for the tune operator (design.md §16) — no ncp/meta/dex calls here.

Everything in this module is deterministic and unit-testable in isolation:
  - Champions speed is a closed form (verified against ncp), so speed cliffs need no calculator.
  - Survival cliffs are solved by a monotonic min-SP search over a damage predicate the caller
    supplies (tune.py wires that to ncp); the search logic itself is pure.
  - headroom + ranking are pure scoring helpers.
"""
from __future__ import annotations

from typing import Callable

from rules import get_ruleset

# Single source of truth for the per-stat SP cap: the registration ruleset (rules.py). Previously
# this was a second hardcoded `32` that had to be hand-synced with rules.sp_per_stat_cap; a future
# ruleset change now updates both at once (audit 2026-06-21).
SP_CAP = get_ruleset().sp_per_stat_cap

# Natures that shift Speed by +/-10% (Champions uses the standard nature table).
_SPE_UP = {"Timid", "Hasty", "Jolly", "Naive"}
_SPE_DOWN = {"Brave", "Relaxed", "Quiet", "Sassy"}

# Full standard nature table: nature -> (boosted stat +10%, penalised stat -10%). Spread keys
# (atk/def/spa/spd/spe; HP never participates). Neutral natures shift nothing. Single source of truth
# for the nature-lane logic (design §16.8) — kept here next to champ_speed (the other nature math).
NATURE_MOD: dict[str, tuple[str | None, str | None]] = {
    "Adamant": ("atk", "spa"), "Lonely": ("atk", "def"), "Brave": ("atk", "spe"), "Naughty": ("atk", "spd"),
    "Bold": ("def", "atk"), "Impish": ("def", "spa"), "Relaxed": ("def", "spe"), "Lax": ("def", "spd"),
    "Modest": ("spa", "atk"), "Mild": ("spa", "def"), "Quiet": ("spa", "spe"), "Rash": ("spa", "spd"),
    "Calm": ("spd", "atk"), "Gentle": ("spd", "def"), "Sassy": ("spd", "spe"), "Careful": ("spd", "spa"),
    "Timid": ("spe", "atk"), "Hasty": ("spe", "def"), "Jolly": ("spe", "spa"), "Naive": ("spe", "spd"),
    "Hardy": (None, None), "Docile": (None, None), "Serious": (None, None),
    "Bashful": (None, None), "Quirky": (None, None),
}
_LEAN_OFFENSE = {"physical": {"atk"}, "special": {"spa"}, "mixed": {"atk", "spa"}}
_UNUSED_OFFENSE = {"physical": "spa", "special": "atk"}   # the offensive stat safe to penalise


def nature_mod(nature: str | None, stat: str) -> int:
    """+1 if `nature` boosts `stat`, -1 if it penalises it, 0 otherwise (incl. neutral natures)."""
    plus, minus = NATURE_MOD.get(nature, (None, None))
    return 1 if plus == stat else -1 if minus == stat else 0


def candidate_natures(target_stat: str, current_nature: str | None, *,
                      invested_stats: set[str], offense_lean: str | None,
                      meta_natures: set[str]) -> list[dict]:
    """Bounded nature lanes that improve `target_stat` vs `current_nature` (design §16.8) — PURE, no SP
    solving here. **REALITY GATE FIRST**: a candidate is considered only if it appears in `meta_natures`
    (the natures real players actually run on this species, ~2%+ usage). Natures nobody runs — most of
    the abstract table, e.g. a -Def or off-role nature on a sweeper — are NEVER proposed; this replaces
    the old synthetic 'defense-reducing is rare' heuristic with real usage. Among the meta-real, targeted
    candidates (the +target natures + the de-penalty lane that keeps the current boost) it classifies
    each `propose` | `summarize` | `locked` (penalty hits a stat THIS build uses / -Speed lockdown).
    Returns [] when meta lists no improving alternative (incl. a meta miss — lanes can't be grounded)."""
    if not meta_natures:
        return []                                        # no real usage data -> no grounded lanes
    offense_stats = _LEAN_OFFENSE.get(offense_lean or "", set())
    cur_plus, cur_minus = NATURE_MOD.get(current_nature, (None, None))
    cur_is_spe_down = cur_minus == "spe"
    safe = _UNUSED_OFFENSE.get(offense_lean or "")

    names: list[str] = [n for n, (p, _m) in NATURE_MOD.items() if p == target_stat]
    if cur_minus == target_stat and cur_plus and safe:   # de-penalty lane: keep cur boost, penalty -> safe
        names += [n for n, (p, m) in NATURE_MOD.items() if p == cur_plus and m == safe]

    lanes: list[dict] = []
    seen: set[str] = set()
    for n in names:
        if n == current_nature or n in seen or n not in meta_natures:   # REALITY GATE: real players only
            continue
        seen.add(n)
        plus, minus = NATURE_MOD[n]
        if nature_mod(n, target_stat) <= nature_mod(current_nature, target_stat):
            continue                                     # must STRICTLY improve the target
        if cur_is_spe_down:
            # -Speed (Trick Room / weather) build: the slow is load-bearing. A nature that KEEPS it slow
            # (-Spe) fits and is proposed; one that would change Speed is locked (don't auto-un-slow it).
            if minus == "spe":
                status, reason = "propose", "keeps the build slow (-Speed); fits a Trick Room/weather build"
            else:
                status, reason = "locked", "member is -Speed (suspected Trick Room/weather build); speed-nature lanes not auto-proposed"
        elif not minus:
            status, reason = "propose", "neutral nature"
        elif minus == safe:                              # the ONE genuinely-free penalty: the offensive
            #                                              stat this build doesn't attack with (e.g. -SpA on a pure physical attacker)
            status, reason = "propose", f"meta-run nature; penalty -{minus} lands on the offensive stat this build doesn't use"
        elif minus in invested_stats:
            status, reason = "summarize", f"meta-run nature, but its penalty -{minus} hits an invested stat"
        elif minus in offense_stats:
            status, reason = "summarize", f"meta-run nature, but its penalty -{minus} hits your offensive stat"
        else:
            # def/spd = defensive bulk, spe = Speed (on a non-slow build): USED even when uninvested (an
            # uninvested defensive stat still takes hits), so this is a cost to weigh, never 'free' — the
            # mislabel ('a stat this build doesn't use') was the audit 2026-06-24 finding.
            cost = "defensive bulk" if minus in ("def", "spd") else "Speed" if minus == "spe" else f"-{minus}"
            status, reason = "summarize", f"meta-run nature; penalty -{minus} costs {cost} (used even when uninvested)"
        # Carry the real meta usage % of this nature on the species (when meta_natures is the dict from
        # nature_distribution) so a 2%-run lane isn't read as equal to a 60%-run one (audit 2026-06-24).
        meta_pct = meta_natures.get(n) if isinstance(meta_natures, dict) else None
        lanes.append({"nature": n, "plus_stat": plus, "penalty_stat": minus, "status": status,
                      "reason": reason, "meta_pct": meta_pct})
    return lanes


def champ_speed(base: int, sp: int, nature: str | None = None) -> int:
    """Champions raw Speed: floor((floor((base*2+31)/2) + 5 + sp) * natureMod). Integer-exact."""
    val = ((base * 2 + 31) * 50) // 100 + 5 + sp
    if nature in _SPE_UP:
        return val * 11 // 10
    if nature in _SPE_DOWN:
        return val * 9 // 10
    return val


# Single source of truth for speed modifiers, shared by every operator that compares Speed
# (matchup's "who is faster", diagnose's speed landscape). Keeping these here — next to champ_speed —
# stops the bug where matchup computed bare Speed while diagnose applied Choice Scarf, so the same
# Pokemon was reported at two different speeds (audit retro 2026-06-22).
SPEED_ITEM_MULT = {"Choice Scarf": 1.5}                 # always-on item Speed multipliers
WEATHER_SPEED_ABILITIES = {                              # ability -> (weather that triggers it, mult)
    "Swift Swim": ("rain", 2.0), "Chlorophyll": ("sun", 2.0),
    "Sand Rush": ("sandstorm", 2.0), "Slush Rush": ("snow/hail", 2.0),
    # token is the bare keyword (like the weather ones) so a natural conditions.terrain="electric"
    # matches; the verbose "electric terrain" still matches via substring (audit 2026-06-24).
    "Surge Surfer": ("electric", 2.0),
}


def weather_speed_mult(ability: str | None, weather: str | None, terrain: str | None = None) -> int:
    """The Speed multiplier a weather-speed ability grants when its trigger is up, else 1. Matches ANY
    of the ability's trigger tokens (e.g. Slush Rush triggers under both 'snow' AND 'hail' — the old
    `split('/')[0]` only matched 'snow', so Hail silently didn't activate it; audit 2026-06-24). The
    trigger may be a TERRAIN, not weather: Surge Surfer keys off Electric Terrain, so `terrain` is
    checked alongside `weather` — without it a legal `conditions.terrain` benchmark could never fire it
    (audit 2026-06-24). Shared by effective_speed and tune's outspeed solver so they agree."""
    trig = WEATHER_SPEED_ABILITIES.get(ability)
    if not trig:
        return 1
    cond = " ".join(s for s in (str(weather or ""), str(terrain or "")) if s).lower()
    return int(trig[1]) if any(tok in cond for tok in trig[0].lower().split("/")) else 1


def effective_speed(base: int | None, sp: int, nature: str | None = None, *,
                    item: str | None = None, ability: str | None = None,
                    weather: str | None = None, tailwind: bool = False) -> int | None:
    """champ_speed plus the modifiers that actually decide who moves first: an always-on Speed item
    (Choice Scarf), a weather-speed ability when its weather is up, and Tailwind. `weather`/`tailwind`
    default off, so a field-agnostic caller (matchup) still gets the Choice Scarf correction right.
    Returns None when base Speed is unknown."""
    if base is None:
        return None
    spd = champ_speed(base, sp, nature)
    mult = SPEED_ITEM_MULT.get(item)
    if mult:
        spd = int(spd * mult)
    wmult = weather_speed_mult(ability, weather)
    if wmult != 1:
        spd = int(spd * wmult)
    if tailwind:
        spd *= 2
    return spd


def solve_outspeed(base: int, nature: str | None, target_speed: int,
                   *, cap: int = SP_CAP, self_mult: int = 1, item: str | None = None) -> dict | None:
    """Minimum Speed SP for `base`/`nature` to strictly exceed `target_speed`.

    `self_mult` scales the solver's own final speed (e.g. 2 when MY side has Tailwind up); `item`
    applies an always-on Speed item (Choice Scarf) — without it a scarfed Pokemon's outspeed cliff
    was solved off its bare Speed, over-stating the SP it needs (audit retro 2026-06-22). Item is
    applied first (integer round), then `self_mult`, matching effective_speed().
    Returns {sp, achieved, result} where result is 'outspeed' (strictly faster) or, if even the
    bare minimum already ties, flags the tie. None if uncapped (can't reach even at the cap).
    """
    item_mult = SPEED_ITEM_MULT.get(item)

    def spd(sp: int) -> int:
        s = champ_speed(base, sp, nature)
        if item_mult:
            s = int(s * item_mult)
        return s * self_mult

    if spd(cap) <= target_speed:
        # Can't outspeed even maxed; report whether the cap at least ties.
        if spd(cap) == target_speed:
            return {"sp": cap, "achieved": spd(cap), "result": "tie-only"}
        return None
    lo, hi = 0, cap
    while lo < hi:
        mid = (lo + hi) // 2
        if spd(mid) > target_speed:
            hi = mid
        else:
            lo = mid + 1
    return {"sp": lo, "achieved": spd(lo), "result": "outspeed"}


# --------------------------------------------------------------------------- #
# Survival cliffs
# --------------------------------------------------------------------------- #

def survival_prob(damage_rolls: list[int], hp: int) -> float:
    """Fraction of damage rolls the defender survives (damage strictly below max HP)."""
    if not damage_rolls:
        return 1.0
    return sum(1 for d in damage_rolls if d < hp) / len(damage_rolls)

# Discrete probability cliffs (design.md §16.2): "guaranteed" = survive every roll.
PROB_TARGETS = {"guaranteed": 1.0, "likely": 13 / 16, "any": 1 / 16}


def meets_target(prob: float, target: str) -> bool:
    return prob >= PROB_TARGETS.get(target, 1.0) - 1e-9


def ko_roll(damage_rolls: list[int], target: str) -> int:
    """Representative single-hit damage for a KO target (kill cliffs, design §16.2): the worst roll
    for 'guaranteed', the best for 'any', the ~13/16 roll for 'likely'. The kill predicate is then
    `ko_roll * hits >= effective_hp` — a per-hit-independent NHKO model (exact for a guaranteed OHKO:
    min roll >= HP; the standard N x roll >= HP approximation for multi-hit; ignores between-hit
    recovery). Monotonic in the attacker's offensive SP, so solve_min_sp binary-searches it."""
    if not damage_rolls:
        return 0
    s = sorted(damage_rolls)
    if target == "any":
        return s[-1]
    if target == "likely":
        return s[min(len(s) - 1, max(0, len(s) - round(len(s) * 13 / 16)))]
    return s[0]   # 'guaranteed' (default): the worst roll must still KO


def solve_min_sp(predicate: Callable[[int], bool], *, cap: int = SP_CAP) -> int | None:
    """Smallest SP in [0, cap] for which `predicate` holds, assuming it is monotonic in SP
    (more defensive SP -> never less survivable). None if it never holds within the cap."""
    if predicate(0):
        return 0
    if not predicate(cap):
        return None
    lo, hi = 0, cap
    while lo < hi:
        mid = (lo + hi) // 2
        if predicate(mid):
            hi = mid
        else:
            lo = mid + 1
    return lo


# --------------------------------------------------------------------------- #
# Per-mon headroom (objective, stat-derived prior — NOT a role label; design.md §16.3)
# --------------------------------------------------------------------------- #

def defensive_headroom(stats: dict[str, int]) -> str:
    """Rough 'is defensive tuning even worth probing' signal from base stats.

    Low = bulk so low that small SP rarely crosses a survival cliff (e.g. Mega Raichu); the tune
    operator still does a shallow pass to catch the rare cheap-cliff-vs-common-threat exception.
    Heuristic and only used for ranking/annotation — it never suppresses a computed cliff.
    """
    hp = stats.get("hp", 0)
    df = stats.get("df", stats.get("def", 0))
    sd = stats.get("sd", stats.get("spd", 0))
    # Effective-bulk proxy (HP weighted with the better defense); thresholds are deliberate, coarse.
    bulk = hp + max(df, sd) * 0.7 + min(df, sd) * 0.3
    if bulk < 150:
        return "low"
    if bulk < 230:
        return "medium"
    return "high"


# --------------------------------------------------------------------------- #
# Ranking (design.md §16.3): value = magnitude x prevalence x decisiveness x cheapness,
# weighted by the format's aspect_priority. Transparent score, multi-view — never a single pick.
# --------------------------------------------------------------------------- #

def cheapness(delta_sp: int, *, cap: int = SP_CAP) -> float:
    """1.0 for a free cliff, decaying toward 0 as the SP cost approaches the cap."""
    if delta_sp <= 0:
        return 1.0
    return max(0.0, 1.0 - delta_sp / (cap + 1))


def _reachable_delta(card: dict) -> int:
    """Cheapest SP cost across the card's REACHABLE lanes. A survive card whose Def/SpD lane is
    unreachable but whose HP lane is a reachable cliff must rank by the HP cost, not the unreachable
    SP_CAP+1 — else a cheap, achievable cliff is mis-ranked to ~0 (audit 2026-06-23)."""
    deltas = []
    if card.get("result") in ("cliff", "already"):
        deltas.append(card.get("delta_sp", 0))
    hp = card.get("hp_lane")
    if isinstance(hp, dict) and hp.get("result") in ("cliff", "already"):
        deltas.append(hp.get("delta_sp", 0))
    return min(deltas) if deltas else card.get("delta_sp", 0)


def score_card(card: dict, aspect_weight: float) -> float:
    return round(
        aspect_weight
        * card.get("magnitude", 0.5)
        * card.get("prevalence", 0.5)
        * card.get("decisiveness", 0.5)
        * cheapness(_reachable_delta(card)),
        4,
    )


def rank_cards(cards: list[dict], aspect_weight_of: Callable[[str], float]) -> list[dict]:
    """Attach a transparent `score` to each card and sort high-to-low. Pure ordering, no facts dropped."""
    for c in cards:
        c["score"] = score_card(c, aspect_weight_of(c.get("aspect", "")))
    return sorted(cards, key=lambda c: (-c["score"], c.get("delta_sp", 0), c.get("aspect", "")))
