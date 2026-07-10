#!/usr/bin/env python
"""Champions registration rule constants, centralized.

These are the registration-period constants the validator (and tune's budget check) enforce.
Centralizing them here — instead of hardcoding in validate_team / tune — keeps those modules in
agreement and makes a future (season, rule) change a one-place edit. Lookup falls back to the
current M-B ruleset when the season/rule is unknown.

This is a small, stable policy table, not battle data, so holding it here does not violate the
"no duplicate data" rule (same rationale as the type chart living in typechart.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RuleSet:
    rule: str
    sp_per_stat_cap: int      # max SP on a single stat
    sp_total_cap: int         # max SP across all six stats
    team_min: int             # registered team size lower bound
    team_max: int             # registered team size upper bound
    species_clause: bool      # each base species at most once
    item_clause: bool         # each held item at most once
    moves_per_pokemon: int = 4  # max moves on a single member (and they must be distinct)


# Current default ruleset. This is the single source for the per-stat SP cap: `cliffs.SP_CAP`
# derives from `get_ruleset().sp_per_stat_cap` rather than re-declaring 32 (audit 2026-06-21).
_M_B = RuleSet(rule="M-B", sp_per_stat_cap=32, sp_total_cap=66,
               team_min=3, team_max=6, species_clause=True, item_clause=True,
               moves_per_pokemon=4)

_RULES: dict[str, RuleSet] = {"M-B": _M_B}
_DEFAULT = _M_B


def get_ruleset(season: str | None = None, rule: str | None = None) -> RuleSet:
    """Return the registration ruleset for (season, rule); falls back to current M-B."""
    return _RULES.get((rule or "").upper(), _DEFAULT)


# season -> its regulation. THE one-place edit for a new season: repset.load_teams_for_rule and the
# environment season->rule fallback both read this instead of re-declaring their own copy (audit 2026-07-08).
SEASON_RULE: dict[str, str] = {"M-1": "M-A", "M-2": "M-A", "M-3": "M-B", "M-4": "M-B"}


def rule_for_season(season: str | None) -> str | None:
    """The regulation a season ran under from the static registration table, or None when unmapped."""
    return SEASON_RULE.get(season) if season else None


# The canonical smogon-style SP stat keys (contracts.STAT_KEYS aliases this). Scope note: this is
# the KEY SET only — the smogon->ncp key MAPPINGS (metalink/repset/tune/matchup *_TO_SPS) and the
# parse-order list (team_io.STATS) are separate, deliberately local tables.
SPREAD_STAT_KEYS = frozenset({"hp", "atk", "def", "spa", "spd", "spe"})


def legal_spread(spread: dict[str, Any] | None, rs: RuleSet | None = None) -> bool:
    """True when an SP spread respects the ruleset caps (each stat within the per-stat cap, total
    within the budget). THE shared predicate — consumers must call this rather than re-deriving
    32/66 locally, or the legality claim drifts from the rules source (audit 2026-07-02).

    Strict on SHAPE, not just values: every key must be a known stat and every value a real int
    (bools excluded) — an unknown key or a stringly value makes the WHOLE spread illegal, because a
    consumer (repset) would otherwise drop the unknown key from the emitted line yet still count the
    row as a legal sample. This predicate gates dirty source data, so it must never raise."""
    rs = rs or get_ruleset()
    total = 0
    for k, v in (spread or {}).items():
        if (k not in SPREAD_STAT_KEYS or isinstance(v, bool) or not isinstance(v, int)
                or not 0 <= v <= rs.sp_per_stat_cap):
            return False
        total += v
    return total <= rs.sp_total_cap
