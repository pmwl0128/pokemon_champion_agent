#!/usr/bin/env python
"""Canonical evidence / confidence / assumptions vocabulary (design audit point 2; design §15).

The skill's honesty rule (refined from "facts only"): output deterministic facts AND clearly-labelled
heuristic derivations; never an opaque normative score. Several operators grew their own ad-hoc
`confidence` / `confidence_reason` / `notes`, so this module is the single place that defines:

  - the confidence ladder (high / medium / low) and `min_confidence` for combining;
  - the controlled `confidence_reason` vocabulary (so reasons are comparable, not free text);
  - `assumptions`: the explicit heuristic-derivation flags an output relied on, promoted out of prose
    `notes` into a structured list so a reader (or auditor) sees exactly what was assumed vs measured.

Pure helper, no deps. `notes` (free prose) stays allowed for detail; `assumptions` is the structured,
auditable subset that every soft (M2+) output should carry.
"""
from __future__ import annotations

CONFIDENCE_LEVELS = ("high", "medium", "low")
_RANK = {"high": 2, "medium": 1, "low": 0}

# Controlled vocabulary for `confidence_reason` (why an output is below "high").
CONFIDENCE_REASONS = {
    "firepower-factors-not-modeled",   # offense/tune: abilities/items/stats not in the type/SP model
    "incomplete-movesets",             # offense: some members' moves aren't authoritative
    "ability-unspecified",             # defense/speed: ability ambiguous (2+ legal) + undeclared -> left unknown
    "spread-or-nature-inferred",       # speed: Spe SP / nature assumed neutral where unspecified
    "heuristic-role",                  # roles: signals are move/stat/item/ability heuristics, not role labels
    "type-chart-unverified",           # type chart assumed standard Gen6+ (Champions not verified to differ)
    "vs-standard-set",                 # computed against a standard/modal opponent set, not the real one
    "meta-modal-set",                  # attacker/opponent set is the meta marginal mode (not a real joint set)
    "synthetic-attacker",              # no meta set; synthetic max-offense attacker (abilities/items NOT modelled)
    "nature-fixed",                    # tune: nature held fixed; SP-only tuning (no joint nature search)
    "incomplete-set",                  # member's own set is not fully known (completeness < full)
    "small-sample",                    # real-team sample too small to trust
    "sp-inferred",                     # SP spread inferred, not observed
    "cache",                           # served from a rebuilt cache
}


def min_confidence(a: str | None, b: str | None) -> str:
    """The more cautious (lower) of two confidence labels."""
    ra, rb = _RANK.get(a or "medium", 1), _RANK.get(b or "medium", 1)
    return a if ra <= rb else b  # type: ignore[return-value]


def floor_confidence(level: str, cap: str) -> str:
    """Clamp `level` so it never exceeds `cap`."""
    return min_confidence(level, cap)


def make_evidence(*, facts: list | None = None, inputs: list | None = None,
                  assumptions: list[str] | None = None, table: str | None = None,
                  note: str | None = None) -> dict:
    """Build a canonical evidence block. `facts`/`inputs` are sources + values used; `assumptions`
    are the heuristic-derivation flags; `table` names a builtin reference; `note` is free prose."""
    ev: dict = {"facts": facts or []}
    if inputs is not None:
        ev["inputs"] = inputs
    if assumptions is not None:
        ev["assumptions"] = assumptions
    if table is not None:
        ev["table"] = table
    if note is not None:
        ev["note"] = note
    return ev
