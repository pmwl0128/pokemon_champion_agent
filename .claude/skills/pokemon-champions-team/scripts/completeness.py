#!/usr/bin/env python
"""Completeness semantics for team members (design.md §8; design audit 2026-06-21, point 8).

`completeness` records how much of a member's set we actually know / trust:
  - observed_full_set      : full set observed (moves+item+ability+spread) — trust everything.
  - extracted_set          : LLM-extracted from prose — fields present but lower trust.
  - observed_species_only  : only the species is known (usage list / team preview) — no moveset.
  - inferred_set           : guessed — neither moves nor set are authoritative.

Until now this field had no consumers, so half-structured singles data could be treated as a
complete set (e.g. offense reporting "hard gaps" for a species whose moves we never knew). This
module is the single place that turns the level into the booleans/confidence the operators use, so
"missing" (unknown) is never silently read as "absent" (a real gap) or "illegal".

Untagged input (level is None) is treated as a user-authored full set — trusted. The pollution risk
is *tagged* pipeline/extraction data (M4 sets completeness explicitly); we honor those tags and trust
the user otherwise. Note `moveset_authoritative` still requires moves to actually be present, so a
bare untagged species (no moves) is correctly NOT counted as offense coverage. Pure helper, no deps.
"""
from __future__ import annotations

KNOWN_LEVELS = {"observed_full_set", "observed_species_only", "extracted_set", "inferred_set"}

_CONF_FLOOR = {
    "observed_full_set": "high",
    "extracted_set": "medium",
    "observed_species_only": "low",
    "inferred_set": "low",
}
_CONF_RANK = {"high": 2, "medium": 1, "low": 0}


def effective_level(level: str | None, *, has_moves: bool) -> str:
    """Resolve the level. Untagged input is user-authored -> trusted as a full set; explicit tags
    (set by the data pipeline / extraction) are honored. `has_moves` is accepted for a uniform
    signature and used by the move-specific check below."""
    return level if level in KNOWN_LEVELS else "observed_full_set"


def moveset_authoritative(level: str | None, *, has_moves: bool) -> bool:
    """True when the member's listed moves can be trusted as its real coverage.
    species_only has no moves; inferred moves are guesses — both are NOT authoritative."""
    lvl = effective_level(level, has_moves=has_moves)
    return has_moves and lvl in ("observed_full_set", "extracted_set")


def set_authoritative(level: str | None, *, has_moves: bool) -> bool:
    """True when item/ability/nature/spread are trustworthy enough to tune off of."""
    return effective_level(level, has_moves=has_moves) == "observed_full_set"


def template_eligible(level: str | None) -> bool:
    """Only an explicitly observed full set may become a real-team template (M4)."""
    return level == "observed_full_set"


def confidence_floor(level: str | None, *, has_moves: bool) -> str:
    """The highest confidence an output about this member should be allowed to claim."""
    return _CONF_FLOOR[effective_level(level, has_moves=has_moves)]


def min_confidence(a: str | None, b: str | None) -> str:
    """The lower (more cautious) of two confidence labels."""
    ra, rb = _CONF_RANK.get(a or "medium", 1), _CONF_RANK.get(b or "medium", 1)
    return a if ra <= rb else b
