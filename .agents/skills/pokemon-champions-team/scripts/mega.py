#!/usr/bin/env python
"""Shared Mega-form matching helpers for team operators.

The dex is still the authority; these helpers only keep the stone -> form -> base-species matching
rule byte-identical across validate / selection / tune.
"""
from __future__ import annotations

from typing import Any


def base_of_form_name(form_name: str | None) -> str | None:
    """Fallback base species from a Mega form name when dex facts are incomplete."""
    if not form_name:
        return None
    n = form_name.strip()
    if n.startswith("Mega "):
        n = n[5:]
        if n.endswith((" X", " Y", " Z")):
            n = n[:-2]
    return n or None


def form_base_species(form_name: str | None, form_fact: dict[str, Any] | None = None) -> str | None:
    fact = form_fact or {}
    return fact.get("base_species") or fact.get("name") or base_of_form_name(form_name)


def mega_form_from_maps(species: str | None, item: str | None, own_fact: dict[str, Any] | None,
                        item_info: dict[str, dict[str, Any]],
                        form_facts: dict[str, dict[str, Any]]) -> str | None:
    """Return the Mega form a species/item pair resolves to, or None.

    A member already authored as a Mega form resolves to itself. Otherwise each item `required_by`
    form must match the member's base species. The form's dex `base_species` wins; `base_of_form_name`
    is only a fallback for incomplete facts.
    """
    if not species:
        return None
    own_fact = own_fact or {}
    if own_fact.get("is_mega"):
        return species
    if not item:
        return None
    for form in (item_info.get(item, {}) or {}).get("required_by", []):
        base = form_base_species(form, form_facts.get(form, {}) or {})
        if base == species:
            return form
    return None


def effective_form_ability(ability: str | None,
                           form_fact: dict[str, Any] | None) -> str | None:
    """Resolve an authored ability onto the actual run form.

    A base-form ability carried beside ``run_form`` or a Mega Stone is registration metadata, not the
    ability used by the damage/speed actor. Preserve it only when the run form can actually have it;
    otherwise use that form's first dex ability.
    """
    abilities = list((form_fact or {}).get("abilities") or [])
    if ability in abilities or not abilities:
        return ability
    return abilities[0]


def effective_member_from_maps(member: dict[str, Any],
                               facts: dict[str, dict[str, Any]],
                               item_info: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Return a registered member rewritten to its actual calculation form.

    This is the shared base+stone rule for matchup, answer-audit (through matchup), and tune. Rich
    callers may retain additional pre-Mega facts, but the actor's species/ability must come from this
    same pure resolution.
    """
    effective = dict(member)
    species = member["species"]
    items = item_info or {}
    run_form = mega_form_from_maps(
        species, member.get("item"), facts.get(species), items, facts
    ) if items else (species if (facts.get(species) or {}).get("is_mega") else None)
    if run_form and run_form != species:
        effective["species"] = run_form
        effective["ability"] = effective_form_ability(
            effective.get("ability"), facts.get(run_form)
        )
    elif run_form == species:
        effective["ability"] = effective_form_ability(
            effective.get("ability"), facts.get(species)
        )
    return effective
