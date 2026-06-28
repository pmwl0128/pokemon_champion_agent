#!/usr/bin/env python
"""Champions registration rule constants, centralized (design.md §8; audit 2026-06-21).

These are the registration-period constants the validator (and tune's budget check) enforce.
Centralizing them here — instead of hardcoding in validate_team / tune — keeps those modules in
agreement and makes a future (season, rule) change a one-place edit. Lookup falls back to the
current M-B ruleset when the season/rule is unknown.

This is a small, stable policy table, not battle data, so holding it here does not violate the
"no duplicate data" rule (same rationale as the type chart living in typechart.py).
"""
from __future__ import annotations

from dataclasses import dataclass


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
