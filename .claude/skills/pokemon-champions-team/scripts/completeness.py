#!/usr/bin/env python
"""Completeness semantics for team members.

`completeness` records how much of a member's set we actually know / trust:
  - observed_full_set      : full set observed (moves+item+ability; spread when the source carries
                             one — some real sources don't, see `spread_authoritative`) — high.
  - extracted_set          : reconstructed from a real team but not the owner's own export (community
                             reverse-engineered spread / LLM-from-prose). VALIDATED and usable as a
                             template / tune target — the owner-published pool is too thin to rely on
                             alone — but capped at MEDIUM confidence, never presented as high.
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

import evidence

KNOWN_LEVELS = {"observed_full_set", "observed_species_only", "extracted_set", "inferred_set"}

_CONF_FLOOR = {
    "observed_full_set": "high",
    "extracted_set": "medium",
    "observed_species_only": "low",
    "inferred_set": "low",
}


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


# Trustworthy enough to build a template / tune a spread off of. `extracted_set` qualifies (a validated
# community reconstruction — the owner-published pool is too thin to lean on alone); it is usable, just
# floored to MEDIUM confidence (confidence_floor), never claiming high. `observed_species_only` (no set)
# and `inferred_set` (guessed) stay out. (audit 2026-07-01, user directive: extracted may be tune/
# template-authoritative while staying medium-confidence.)
_AUTHORITATIVE = frozenset({"observed_full_set", "extracted_set"})


def set_authoritative(level: str | None, *, has_moves: bool) -> bool:
    """True when item/ability/nature are trustworthy enough to tune off of. Includes
    `extracted_set` (validated reconstruction); the confidence it earns is still its floor (medium),
    not high — `confidence_floor` carries that, so a caller must not read authoritative as 'high'.
    The SPREAD is judged separately (`spread_authoritative`): an authoritative set may still carry
    no spread at all."""
    return effective_level(level, has_moves=has_moves) in _AUTHORITATIVE


def spread_authoritative(level: str | None, *, has_spread: bool) -> bool:
    """True when the member's SP spread can be trusted as its REAL allocation. Untagged input is
    user-authored, so an absent spread is a real 0-SP state — trusted either way. A TAGGED member
    (pipeline data) without a spread has an UNKNOWN spread: the raw row simply didn't carry one, so
    reading it as 0 SP is a
    guess, never authoritative — consumers must disclose 'SP assumed 0' and drop confidence."""
    if level not in KNOWN_LEVELS:
        return True
    return level in _AUTHORITATIVE and has_spread


def template_eligible(level: str | None) -> bool:
    """A member that may seed a real-team template (M4): an observed full set OR a validated
    community-reconstructed (`extracted_set`) set. An untagged/species-only/inferred member may not.
    Confidence is still capped by `confidence_floor`, so an extracted-only archetype reads medium."""
    return level in _AUTHORITATIVE


def confidence_floor(level: str | None, *, has_moves: bool) -> str:
    """The highest confidence an output about this member should be allowed to claim."""
    return _CONF_FLOOR[effective_level(level, has_moves=has_moves)]


def min_confidence(a: str | None, b: str | None) -> str:
    """The lower (more cautious) of two confidence labels."""
    return evidence.min_confidence(a, b)
