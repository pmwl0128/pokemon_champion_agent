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
