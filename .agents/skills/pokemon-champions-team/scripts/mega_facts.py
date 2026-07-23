#!/usr/bin/env python
"""Mega-registration facts shared by landscape, frame, slate and checkpoint.

The distribution and its modal/common/minority/rare labels are descriptive facts over an observed
sample, never a strength score or a legality rule.  Slate may use a reliable observed distribution as
an explicit conformance gate: a candidate outside the common observed lanes needs a declared basis,
while ``off_meta`` or an explicit user posture remains an escape.  The battle rule stays selection-side:
a registered team may carry several Mega options, but at most one can Mega Evolve in a battle.
"""
from __future__ import annotations

from collections import Counter
from typing import Any

BUCKETS = ("0", "1", "2", "3_plus")
MEGA_BATTLE_RULE = ("registered team may carry multiple Mega options; in battle, at most one "
                    "selected member may Mega Evolve")

# A distribution below this sample is surfaced but not load-bearing.  The value matches landscape's
# library-scale thin bar; it is repeated here to keep this low-level module independent of landscape.
OBSERVED_NORM_MIN_SAMPLE = 30
# Mechanical descriptive bands.  They classify observed shares; they do not rank candidates.
OBSERVED_COMMON_SHARE = 0.20
OBSERVED_RARE_SHARE = 0.05


def registered_mega_count(profile: dict[str, Any]) -> int:
    return len(profile.get("mega_usage") or [])


def mega_count_bucket(count: int) -> str:
    """The stable registration bucket used by every distribution/assessment consumer."""
    return "3_plus" if count >= 3 else str(max(0, count))


def mega_slot_distribution(profiles: list[dict[str, Any]]) -> dict[str, Any]:
    """Distribution of registered Mega-option counts across observed profiles."""
    sample = len(profiles)
    counts: Counter[str] = Counter()
    total_slots = 0
    for p in profiles:
        n = registered_mega_count(p)
        total_slots += n
        counts[mega_count_bucket(n)] += 1
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


def observed_registration_reference(distribution: dict[str, Any] | None) -> dict[str, Any]:
    """Normalize a Mega-slot distribution into a facts-only conformance reference.

    ``modal_buckets`` may contain ties.  ``reliable`` controls whether slate may make the reference
    load-bearing; thin samples remain visible with low confidence instead of disappearing.
    """
    d = distribution if isinstance(distribution, dict) else {}
    sample = int(d.get("sample_count") or 0)
    raw = d.get("buckets") if isinstance(d.get("buckets"), dict) else {}
    shares = {
        bucket: float((raw.get(bucket) or {}).get("share") or 0.0)
        for bucket in BUCKETS
    }
    peak = max(shares.values(), default=0.0)
    modal = [bucket for bucket in BUCKETS if peak > 0 and shares[bucket] == peak]
    common = [bucket for bucket in BUCKETS if shares[bucket] >= OBSERVED_COMMON_SHARE]
    minority = [bucket for bucket in BUCKETS
                if OBSERVED_RARE_SHARE <= shares[bucket] < OBSERVED_COMMON_SHARE]
    rare = [bucket for bucket in BUCKETS if shares[bucket] < OBSERVED_RARE_SHARE]
    reliable = sample >= OBSERVED_NORM_MIN_SAMPLE
    return {
        "sample_count": sample,
        "reliable": reliable,
        "confidence": "medium" if reliable else "low",
        "modal_buckets": modal,
        "common_buckets": common,
        "minority_buckets": minority,
        "rare_buckets": rare,
        "bucket_shares": shares,
        "thresholds": {
            "minimum_sample": OBSERVED_NORM_MIN_SAMPLE,
            "common_share": OBSERVED_COMMON_SHARE,
            "rare_share": OBSERVED_RARE_SHARE,
        },
    }


def assess_registration(count: int, distribution: dict[str, Any] | None, *,
                        mega_posture: str | None = None,
                        meta_conformance: str | None = None,
                        deviation_declared: bool = False) -> dict[str, Any]:
    """Assess one candidate against user posture or a reliable observed reference.

    This emits an explainable relation and gate facts only.  It never calls a count "better" and never
    makes a legal/illegal verdict.  Explicit user posture is a hard composition constraint; otherwise
    reliable observed minority/rare lanes need a declared deviation under the default ``proven`` view.
    """
    bucket = mega_count_bucket(count)
    posture = mega_posture or "environment"
    if posture != "environment":
        aligned = ((posture == "none" and count == 0)
                   or (posture == "single" and count == 1)
                   or (posture == "multi" and count >= 2))
        return {
            "registered_mega_count": count,
            "bucket": bucket,
            "source": "user_posture",
            "mega_posture": posture,
            "relation": "aligned" if aligned else "conflict",
            "reliable": True,
            "requires_deviation_ack": False,
            "deviation_declared": False,
            "hard_conflict": not aligned,
        }

    ref = observed_registration_reference(distribution)
    if not ref["reliable"]:
        return {
            "registered_mega_count": count,
            "bucket": bucket,
            "source": "observed_distribution",
            "relation": "unassessed_thin_sample",
            "reliable": False,
            "reference": ref,
            "requires_deviation_ack": False,
            "deviation_declared": deviation_declared,
            "hard_conflict": False,
        }
    if bucket in ref["modal_buckets"]:
        relation = "modal"
    elif bucket in ref["common_buckets"]:
        relation = "common"
    elif bucket in ref["minority_buckets"]:
        relation = "minority"
    else:
        relation = "rare"
    requires = meta_conformance != "off_meta" and relation in {"minority", "rare"}
    return {
        "registered_mega_count": count,
        "bucket": bucket,
        "source": "observed_distribution",
        "relation": relation,
        "observed_share": ref["bucket_shares"][bucket],
        "reliable": True,
        "reference": ref,
        "requires_deviation_ack": requires,
        "deviation_declared": deviation_declared,
        "hard_conflict": bool(requires and not deviation_declared),
    }
