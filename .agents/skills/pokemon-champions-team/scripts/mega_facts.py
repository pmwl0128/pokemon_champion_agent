#!/usr/bin/env python
"""Mega-slot facts shared by landscape and slate.

This module only counts registered Mega options. It does not decide whether one, two, or more
Mega-capable members is desirable; the battle rule remains selection-side: a registered team may
carry several Mega options, but at most one can Mega Evolve in a battle.
"""
from __future__ import annotations

from collections import Counter
from typing import Any

BUCKETS = ("0", "1", "2", "3_plus")
MEGA_BATTLE_RULE = ("registered team may carry multiple Mega options; in battle, at most one "
                    "selected member may Mega Evolve")


def registered_mega_count(profile: dict[str, Any]) -> int:
    return len(profile.get("mega_usage") or [])


def mega_slot_distribution(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    """Distribution of registered Mega-option counts across observed profiles."""
    sample = len(profiles)
    counts: Counter[str] = Counter()
    total_slots = 0
    for p in profiles:
        n = registered_mega_count(p)
        total_slots += n
        counts["3_plus" if n >= 3 else str(n)] += 1
    return {
        "sample_count": sample,
        "buckets": {
            b: {"count": counts.get(b, 0), "share": round(counts.get(b, 0) / sample, 3) if sample else 0.0}
            for b in BUCKETS
        },
        "average_registered_mega_slots": round(total_slots / sample, 3) if sample else 0.0,
        "battle_rule": MEGA_BATTLE_RULE,
    }


def mega_plan_from_profile(profile: dict[str, Any]) -> dict[str, Any]:
    """Per-candidate registered Mega options, for slate/checkpoint display."""
    options = list(profile.get("mega_usage") or [])
    return {
        "registered_mega_count": len(options),
        "mega_options": options,
        "battle_rule": MEGA_BATTLE_RULE,
    }
