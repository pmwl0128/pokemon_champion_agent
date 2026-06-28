#!/usr/bin/env python
"""Per-format environment priors for the tune operator (design.md §16.3/§16.4).

These are **human-experience seed defaults**, not derived facts: they only allocate the tune
operator's probing effort and default ordering — they never suppress a computed cliff. Later they
can be refreshed from meta (prevalence of SR / tailwind / weather setters); meta-thin -> fall back
here.

Two knobs per format:
  - aspect_priority: relative weight of offense / defense / speed cliffs when ranking.
  - conditions:      prevalence weight (0..1) of each field condition, used to decide which speed
                     contexts are worth probing and how to order/annotate. NOTE: a benchmark's
                     explicit `conditions` are always applied by the tune operator (the user's
                     request wins); the profile never silently turns a condition on or off in a
                     damage/speed calc — it only informs ranking and default probing (audit 2026-06-21).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

PRIMARY_MIN = 0.5      # prevalence >= this -> model by default (primary)
SECONDARY_MIN = 0.1    # prevalence in [this, PRIMARY_MIN) -> annotation-only (secondary); below -> ignored


@dataclass(frozen=True)
class ContextProfile:
    fmt: str
    aspect_priority: dict[str, float]      # offense / defense / speed -> weight
    conditions: dict[str, float]           # condition -> meta prevalence (0..1)

    def aspect_weight(self, aspect: str) -> float:
        return self.aspect_priority.get(aspect, 0.5)

    def condition_tier(self, name: str) -> str:
        p = self.conditions.get(name, 0.0)
        if p >= PRIMARY_MIN:
            return "primary"
        if p >= SECONDARY_MIN:
            return "secondary"
        return "ignored"


# Seed defaults (human experience, 2026-06-20). Refreshable from meta later.
_SINGLE = ContextProfile(
    fmt="single",
    # Singles: offense and defense roughly equal; speed is an arms race (handled as coverage, §16.5).
    aspect_priority={"offense": 0.8, "defense": 0.8, "speed": 0.6},
    # Tailwind ~ absent in singles; Trick Room uncommon; weather reduced; SR present but minor.
    conditions={"stealth_rock": 0.2, "tailwind": 0.02, "trickroom": 0.15, "weather": 0.3, "screens": 0.2},
)
_DOUBLE = ContextProfile(
    fmt="double",
    # Doubles: offense judgment is the priority; defense matters but ranks lower (§16.3).
    aspect_priority={"offense": 1.0, "defense": 0.5, "speed": 0.9},
    # Tailwind is a primary speed context; SR is essentially never run.
    conditions={"stealth_rock": 0.02, "tailwind": 0.6, "trickroom": 0.35, "weather": 0.5, "screens": 0.3},
)

_PROFILES = {"single": _SINGLE, "double": _DOUBLE}


def get_profile(fmt: str | None) -> ContextProfile:
    """Return the seed profile for a format; defaults to singles when unknown."""
    return _PROFILES.get((fmt or "single").lower(), _SINGLE)


def speed_contexts(fmt: str | None) -> list[dict[str, Any]]:
    """Default speed-line contexts to evaluate, derived from the profile (design.md §16.5).

    Always includes neutral speed; adds tailwind / trick-room only where the format makes them
    realistic (primary/secondary), so singles don't waste effort on tailwind lines.
    """
    prof = get_profile(fmt)
    out: list[dict[str, Any]] = [{"label": "neutral", "field": {}}]
    if prof.condition_tier("tailwind") != "ignored":
        out.append({"label": "tailwind", "field": {"tailwind": True}})
    if prof.condition_tier("trickroom") != "ignored":
        out.append({"label": "trickroom", "field": {"trickroom": True}})
    return out
