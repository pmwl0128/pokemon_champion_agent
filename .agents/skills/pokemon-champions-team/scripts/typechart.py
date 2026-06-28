#!/usr/bin/env python
"""18x18 type-effectiveness chart + key ability modifiers (rule constants).

The matrix is a fixed Pokemon rule (Champions does not change type effectiveness), so it is
built into the skill — it is NOT updatable battle data, so this does not duplicate dex/meta.
dex provides each Pokemon's types/abilities; this module turns them into resist/weak/immune.

Ability modifiers cover the cases that materially change defense (immunities/absorbs and the
common halving abilities). Finer ability nuances are intentionally out of scope for now and
flagged by the caller.
"""
from __future__ import annotations

TYPES: list[str] = [
    "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground",
    "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
]

# attacker -> {defender: multiplier}; entries of 1.0 omitted.
TYPE_CHART: dict[str, dict[str, float]] = {
    "Normal": {"Rock": 0.5, "Ghost": 0.0, "Steel": 0.5},
    "Fire": {"Fire": 0.5, "Water": 0.5, "Grass": 2, "Ice": 2, "Bug": 2, "Rock": 0.5, "Dragon": 0.5, "Steel": 2},
    "Water": {"Fire": 2, "Water": 0.5, "Grass": 0.5, "Ground": 2, "Rock": 2, "Dragon": 0.5},
    "Electric": {"Water": 2, "Electric": 0.5, "Grass": 0.5, "Ground": 0.0, "Flying": 2, "Dragon": 0.5},
    "Grass": {"Fire": 0.5, "Water": 2, "Grass": 0.5, "Poison": 0.5, "Ground": 2, "Flying": 0.5,
              "Bug": 0.5, "Rock": 2, "Dragon": 0.5, "Steel": 0.5},
    "Ice": {"Fire": 0.5, "Water": 0.5, "Grass": 2, "Ice": 0.5, "Ground": 2, "Flying": 2, "Dragon": 2, "Steel": 0.5},
    "Fighting": {"Normal": 2, "Ice": 2, "Poison": 0.5, "Flying": 0.5, "Psychic": 0.5, "Bug": 0.5,
                 "Rock": 2, "Ghost": 0.0, "Dark": 2, "Steel": 2, "Fairy": 0.5},
    "Poison": {"Grass": 2, "Poison": 0.5, "Ground": 0.5, "Rock": 0.5, "Ghost": 0.5, "Steel": 0.0, "Fairy": 2},
    "Ground": {"Fire": 2, "Electric": 2, "Grass": 0.5, "Poison": 2, "Flying": 0.0, "Bug": 0.5, "Rock": 2, "Steel": 2},
    "Flying": {"Electric": 0.5, "Grass": 2, "Fighting": 2, "Bug": 2, "Rock": 0.5, "Steel": 0.5},
    "Psychic": {"Fighting": 2, "Poison": 2, "Psychic": 0.5, "Dark": 0.0, "Steel": 0.5},
    "Bug": {"Fire": 0.5, "Grass": 2, "Fighting": 0.5, "Poison": 0.5, "Flying": 0.5, "Psychic": 2,
            "Ghost": 0.5, "Dark": 2, "Steel": 0.5, "Fairy": 0.5},
    "Rock": {"Fire": 2, "Ice": 2, "Fighting": 0.5, "Ground": 0.5, "Flying": 2, "Bug": 2, "Steel": 0.5},
    "Ghost": {"Normal": 0.0, "Psychic": 2, "Ghost": 2, "Dark": 0.5},
    "Dragon": {"Dragon": 2, "Steel": 0.5, "Fairy": 0.0},
    "Dark": {"Fighting": 0.5, "Psychic": 2, "Ghost": 2, "Dark": 0.5, "Fairy": 0.5},
    "Steel": {"Fire": 0.5, "Water": 0.5, "Electric": 0.5, "Ice": 2, "Rock": 2, "Steel": 0.5, "Fairy": 2},
    "Fairy": {"Fire": 0.5, "Fighting": 2, "Poison": 0.5, "Dragon": 2, "Dark": 2, "Steel": 0.5},
}

# Abilities that grant immunity to an attacking type (set multiplier to 0).
IMMUNITY_ABILITIES: dict[str, str] = {
    # Verified against the Champions dex (2026-06-19). Abilities whose carriers are not in the
    # Champions roster (e.g. Storm Drain, Well-Baked Body) are intentionally omitted as dead code.
    "Levitate": "Ground",
    "Water Absorb": "Water", "Dry Skin": "Water",
    "Volt Absorb": "Electric", "Lightning Rod": "Electric", "Motor Drive": "Electric",
    "Flash Fire": "Fire",
    "Sap Sipper": "Grass", "Earth Eater": "Ground",
}

# Abilities that scale incoming damage from a type (multiplicative). Fluffy doubles Fire
# (its contact halving is a move-property, not a type, so it is out of scope here).
FACTOR_ABILITIES: dict[str, dict[str, float]] = {
    "Thick Fat": {"Fire": 0.5, "Ice": 0.5},
    "Heatproof": {"Fire": 0.5},
    "Water Bubble": {"Fire": 0.5},
    "Purifying Salt": {"Ghost": 0.5},
    "Fluffy": {"Fire": 2.0},
}

# Abilities that scale ALL super-effective (>1x) hits by 0.75 (does not change weak/resist class).
SUPEREFFECTIVE_REDUCE_ABILITIES: set[str] = {"Filter", "Solid Rock"}

# "-ate" skin abilities convert the user's Normal-type damaging moves to another type (and add
# a damage boost). They change a move's effective ATTACKING type, so they belong to the type
# layer's offense side, mirroring the defensive factor abilities above. Only abilities with a
# carrier in the Champions roster are listed (Galvanize/Normalize have none — verified 2026-06-19).
ATE_SKIN_ABILITIES: dict[str, str] = {
    "Pixilate": "Fairy",      # Sylveon, Mega Gardevoir, Mega Altaria
    "Refrigerate": "Ice",     # Aurorus, Mega Glalie
    "Aerilate": "Flying",     # Mega Pinsir
}


def ate_skin_type(ability: str | None, move_type: str | None) -> str | None:
    """Return the converted attacking type if an -ate skin re-types this Normal move, else None."""
    if ability and move_type == "Normal":
        return ATE_SKIN_ABILITIES.get(ability)
    return None

# Resist berries: each halves one type's super-effective hit, ONE TIME. Verified 18/18 in dex.
# Handled as an annotation in diagnose (does NOT change the weak/resist classification).
RESIST_BERRIES: dict[str, str] = {
    "Occa Berry": "Fire", "Passho Berry": "Water", "Wacan Berry": "Electric", "Rindo Berry": "Grass",
    "Yache Berry": "Ice", "Chople Berry": "Fighting", "Kebia Berry": "Poison", "Shuca Berry": "Ground",
    "Coba Berry": "Flying", "Payapa Berry": "Psychic", "Tanga Berry": "Bug", "Charti Berry": "Rock",
    "Kasib Berry": "Ghost", "Haban Berry": "Dragon", "Colbur Berry": "Dark", "Babiri Berry": "Steel",
    "Chilan Berry": "Normal", "Roseli Berry": "Fairy",
}


def berry_for_attack(item: str | None, attack: str) -> str | None:
    """Return the held resist-berry name if it cushions `attack`, else None."""
    return item if item and RESIST_BERRIES.get(item) == attack else None


def effectiveness(attack: str, defenders: list[str]) -> float:
    """Plain type multiplier of `attack` against a (1-2) type defender."""
    m = 1.0
    row = TYPE_CHART.get(attack, {})
    for d in defenders:
        m *= row.get(d, 1.0)
    return m


def effectiveness_for_member(defenders: list[str], ability: str | None, attack: str) -> float:
    """Type multiplier including immunity/factor/super-effective-reduce ability modifiers.

    Resist berries are NOT applied here (they are one-time; diagnose annotates them instead).
    """
    if ability and IMMUNITY_ABILITIES.get(ability) == attack:
        return 0.0
    base = effectiveness(attack, defenders)
    if ability:
        factor = FACTOR_ABILITIES.get(ability, {}).get(attack)
        if factor is not None:
            base *= factor
        if ability in SUPEREFFECTIVE_REDUCE_ABILITIES and base > 1:
            base *= 0.75
    return base
