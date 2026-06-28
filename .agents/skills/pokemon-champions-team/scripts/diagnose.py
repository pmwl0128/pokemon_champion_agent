#!/usr/bin/env python
"""Team diagnostics (M2). Accepts partial teams (1-6). Each result carries
evidence + confidence + reason (design.md §6/§7). The model decides what to do;
this only reports objective facts. No team-strength score.

Implemented: defense (type-matchup coverage + weakness concentration),
offense (coverage by reliability), speed (team landscape + control inventory, in context),
roles (objective functional signals + compression — never a prescriptive role label/score).
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from team_io import Team  # noqa: E402
from typechart import (  # noqa: E402
    TYPES, effectiveness, effectiveness_for_member, berry_for_attack, ate_skin_type,
)
from cliffs import (  # noqa: E402
    champ_speed, defensive_headroom, SPEED_ITEM_MULT, WEATHER_SPEED_ABILITIES,
)
import completeness  # noqa: E402

WEAK_CONCENTRATION_MIN = 2          # >=2 members weak to a type is worth surfacing
HIGH_SEVERITY_SHARE = 0.5           # >=50% of the team weak == high severity


def _certain_ability(member_ability: str | None, dex_abilities: list | None) -> tuple[str | None, bool]:
    """The ability to use for capability claims: the user's DECLARED ability, or — only when the
    species has exactly ONE legal ability — that sole ability. Otherwise (None, True) = unknown.

    The dex returns the LEGAL ability list, not a usage default, so picking abilities[0] would
    fabricate capabilities the set may not actually have (weather-speed, Intimidate, Levitate
    immunity, Regenerator, ...) and pollute roles' compression. When the ability is ambiguous
    (2+ legal) and undeclared we keep it unknown rather than guess (audit 2026-06-22 / P2-a)."""
    if member_ability:
        return member_ability, False
    ab = [a for a in (dex_abilities or []) if a]
    if len(ab) == 1:
        return ab[0], False
    return None, True


def _fmt_mult(m: float) -> str:
    return f"{m:g}x"


def diagnose_defense(team: Team, facts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Per-attack-type resist/weak/immune tallies + weakness concentration.

    facts: species -> dex fact dict (from dexlink.lookup_pokemon).
    Members whose dex facts are missing/not-found are skipped (validate covers legality);
    they are listed under `skipped` so the report is honest about partial coverage.
    """
    members: list[tuple[str, list[str], str | None, str | None, bool]] = []
    skipped: list[str] = []
    for m in team.pokemon:
        f = facts.get(m.species)
        if not f or not f.get("found"):
            skipped.append(m.species or "(blank)")
            continue
        types = list(f.get("types", []))
        ability, ability_unknown = _certain_ability(m.ability, f.get("abilities"))
        members.append((m.species, types, ability, m.item, ability_unknown))

    by_attack: dict[str, dict[str, Any]] = {}
    for atk in TYPES:
        weak, resist, immune = [], [], []
        neutral = 0
        for name, types, ability, _item, _ in members:
            e = effectiveness_for_member(types, ability, atk)
            if e == 0:
                immune.append(name)
            elif e > 1:
                weak.append(name)
            elif e < 1:
                resist.append(name)
            else:
                neutral += 1
        by_attack[atk] = {"weak": weak, "resist": resist, "immune": immune, "neutral_count": neutral}

    per_member: dict[str, dict[str, list[str]]] = {}
    unknown_ability: list[str] = []
    for name, types, ability, item, is_unknown in members:
        w, r, im = [], [], []
        for atk in TYPES:
            e = effectiveness_for_member(types, ability, atk)
            if e == 0:
                im.append(atk)
            elif e > 1:
                label = f"{atk} {_fmt_mult(e)}"
                berry = berry_for_attack(item, atk)
                if berry:
                    label += f" ({berry}: first hit halved)"
                w.append(label)
            elif e < 1:
                r.append(atk)
        per_member[name] = {"weak": w, "resist": r, "immune": im}
        if is_unknown:
            unknown_ability.append(name)

    size = len(members)
    concentration = []
    for atk, d in by_attack.items():
        wc = len(d["weak"])
        if wc >= WEAK_CONCENTRATION_MIN:
            share = round(wc / size, 2) if size else 0.0
            concentration.append({
                "type": atk, "weak_count": wc, "weak_members": d["weak"],
                "share": share, "severity": "high" if share >= HIGH_SEVERITY_SHARE else "medium",
            })
    concentration.sort(key=lambda x: (-x["weak_count"], x["type"]))

    notes = [
        "Modeled: type chart; immunity abilities (Levitate/absorbs/Sap Sipper/Earth Eater); "
        "damage-factor abilities (Thick Fat/Heatproof/Water Bubble/Purifying Salt/Fluffy); "
        "Filter/Solid Rock (super-effective x0.75); resist berries (annotated, one-time). "
        "NOT modeled — need a physical/special, HP, or move-property axis, so use ncp for exact numbers: "
        "Fur Coat/Ice Scales (phys/spec halving), Multiscale/Marvel Scale (HP/status), "
        "Bulletproof/Soundproof/Overcoat (move-class immunity).",
    ]
    if unknown_ability:
        notes.append(
            "Ability unspecified (2+ legal abilities) for: " + ", ".join(unknown_ability)
            + " — ability-based immunities/resists (e.g. Levitate) NOT applied; specify each "
            "member's ability for exact immunities."
        )
    if skipped:
        notes.append("Skipped (no dex facts): " + ", ".join(skipped) + ".")

    assumptions = [
        "type chart assumed standard Gen6+ (Champions not verified to differ)",
        "type-layer only: phys/spec halving, HP/status, and move-class immunity NOT modelled — use ncp",
    ]
    if unknown_ability:
        assumptions.append("ability left unknown where unspecified + ambiguous (no ability mods applied): "
                           + ", ".join(unknown_ability))

    return {
        "kind": "defense",
        "team_size": size,
        "partial": size < 6,
        "weakness_concentration": concentration,
        "by_attack_type": by_attack,
        "per_member": per_member,
        "skipped": skipped,
        # An unspecified ability on a 2+-ability member means ability immunities/resists (Levitate,
        # Water Absorb, ...) could NOT be applied, so the reported weaknesses may be wrong (a Levitate
        # Rotom shown weak to Ground). That genuinely lowers trust — so confidence drops to medium, it
        # is not hardcoded high while the reason already says ability-unspecified (audit 2026-06-28).
        "confidence": "medium" if unknown_ability else "high",
        "confidence_reason": "ability-unspecified" if unknown_ability else None,
        "assumptions": assumptions,
        "evidence": {
            "facts": [{"source": "dex", "ref": "types + abilities"}],
            "assumptions": assumptions,
            "table": "builtin 18x18 type chart + ability immunity/factor mods",
        },
        "notes": notes,
    }


def format_defense_md(d: dict[str, Any]) -> str:
    lines = [f"# Defense ({d['team_size']} Pokemon{', partial' if d['partial'] else ''}) — confidence {d['confidence']}"]
    conc = d["weakness_concentration"]
    if conc:
        lines.append("\n## Weakness concentration (shared weaknesses are the real risk)")
        for c in conc:
            lines.append(f"- **{c['type']}**: {c['weak_count']}/{d['team_size']} weak "
                         f"({c['severity']}) — {', '.join(c['weak_members'])}")
    else:
        lines.append("\nNo attacking type hits 2+ members for super-effective. Defensively spread.")
    lines.append("\n## Per member")
    for name, pm in d["per_member"].items():
        weak = ", ".join(pm["weak"]) or "—"
        immune = ", ".join(pm["immune"])
        lines.append(f"- **{name}**: weak {weak}" + (f"; immune {immune}" if immune else ""))
    if d["notes"]:
        lines.append("\n## Notes")
        lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Offense: attacking coverage by reliability, with STAB as the core axis.
# --------------------------------------------------------------------------- #

def _norm_type(t: str | None) -> str | None:
    if not t:
        return None
    return t[:1].upper() + t[1:].lower()


def diagnose_offense(team: Team, facts: dict[str, dict[str, Any]],
                     move_facts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Which defending types the team can hit super-effectively, classified by reliability.

    STAB is the decisive axis (NOT a 1.5x number): a STAB super-effective source is reliable
    firepower; only-non-STAB coverage is thin (move slots + the attacker's stats/ability/item
    all have to line up). Actual damage also depends on factors not modeled here (Adaptability /
    -ate / Technician, Choice items / Life Orb / type gems, base stats) — use ncp for KO numbers.
    """
    # Collect each member's attacking (physical/special) moves with type + STAB flag.
    attackers: list[tuple[str, set[str], list[dict[str, Any]]]] = []
    skipped: list[str] = []
    incomplete_members: list[dict[str, str]] = []
    unknown_moves: list[str] = []
    ate_used: list[str] = []
    for m in team.pokemon:
        f = facts.get(m.species)
        if not f or not f.get("found"):
            skipped.append(m.species or "(blank)")
            continue
        # A member whose moveset isn't authoritative (species-only / inferred) tells us nothing
        # about coverage — counting it would turn "unknown moves" into a phantom "hard gap".
        if not completeness.moveset_authoritative(m.completeness, has_moves=bool(m.moves)):
            incomplete_members.append({
                "species": m.species or "(blank)",
                "completeness": completeness.effective_level(m.completeness, has_moves=bool(m.moves)),
            })
            continue
        ptypes = {_norm_type(t) for t in f.get("types", [])}
        # Ability gates the -ate skin re-typing; use it only when certain (declared or sole legal
        # ability), else None — picking abilities[0] could fake a Pixilate skin (audit 2026-06-22).
        ability, _ability_unknown = _certain_ability(m.ability, f.get("abilities"))
        atks: list[dict[str, Any]] = []
        for mv in m.moves:
            mf = move_facts.get(mv)
            if not mf or not mf.get("found"):
                unknown_moves.append(mv)
                continue
            if (mf.get("category") or "").lower() not in ("physical", "special"):
                continue  # status move
            mtype = _norm_type(mf.get("type"))
            if not mtype:
                continue
            # -ate skins re-type Normal damaging moves and grant STAB (e.g. Sylveon's
            # Hyper Voice is Fairy, not Normal) — without this, coverage/STAB are misjudged.
            skin = ate_skin_type(ability, mtype)
            ate = bool(skin)
            if skin:
                mtype = skin
                if m.species not in ate_used:
                    ate_used.append(m.species)
            atks.append({"move": mv, "type": mtype, "stab": mtype in ptypes, "ate": ate})
        attackers.append((m.species, ptypes, atks))

    by_def: dict[str, dict[str, Any]] = {}
    hard_gaps, thin, centralized = [], [], []
    for D in TYPES:
        sources = []
        for mon, _pt, atks in attackers:
            for a in atks:
                if effectiveness(a["type"], [D]) >= 2:
                    sources.append({"mon": mon, "move": a["move"], "type": a["type"],
                                    "stab": a["stab"], "ate": a.get("ate", False)})
        has_stab = any(s["stab"] for s in sources)
        # "centralized" means a single MEMBER carries this coverage, so losing that one member loses
        # the type — it is about who bears the coverage, not how many moves do. Count distinct
        # bearers, not source moves: one Garchomp with both Earthquake and Bulldoze is still a single
        # point of failure for Ground coverage, not redundant coverage (audit 2026-06-21).
        bearers = {s["mon"] for s in sources}
        if not sources:
            cls = "hard_gap"
            hard_gaps.append(D)
        elif len(bearers) == 1:
            cls = "centralized"
            mon = next(iter(bearers))
            centralized.append({"type": D, "mon": mon, "stab": has_stab})
        elif has_stab:
            cls = "covered"
        else:
            cls = "thin"
            thin.append(D)
        by_def[D] = {"class": cls, "has_stab": has_stab, "sources": sources}

    notes = [
        "STAB is treated as a reliability signal, not a 1.5x number: a STAB super-effective source "
        "is reliable firepower; only-non-STAB coverage is 'thin'.",
        "Firepower factors NOT modeled (use ncp for KO numbers): abilities (Adaptability / -ate skins / "
        "Technician / Sheer Force), items (Choice / Life Orb / type-boost / gems), and base stats.",
        "Coverage is judged from the team's ACTUAL moves (team-json), not the full learnset.",
    ]
    if ate_used:
        notes.append("-ate skin ability re-typed Normal moves (counted as the new type + STAB) for: "
                     + ", ".join(ate_used) + ".")
    if unknown_moves:
        notes.append("Moves not found in dex (ignored): " + ", ".join(sorted(set(unknown_moves))) + ".")
    if skipped:
        notes.append("Skipped (no dex facts): " + ", ".join(skipped) + ".")

    # Gaps are only trustworthy if every counted member has an authoritative moveset; otherwise a
    # reported "hard gap" may just be a member whose moves we don't know (design audit point 8).
    gaps_confirmed = not incomplete_members
    confidence = "medium" if gaps_confirmed else "low"
    confidence_reason = "firepower-factors-not-modeled" if gaps_confirmed else "incomplete-movesets"
    if incomplete_members:
        names = ", ".join(f"{m['species']} ({m['completeness']})" for m in incomplete_members)
        notes.append("Coverage gaps are NOT confirmed: these members have no authoritative moveset, "
                     "so their offense is unknown (not counted): " + names + ".")

    assumptions = [
        "STAB treated as a reliability signal, not a 1.5x number",
        "firepower factors NOT modelled (Adaptability/-ate/Technician, Choice/Life Orb/gems, base stats) — use ncp",
        "coverage judged from the team's actual moves, not the full learnset",
    ]
    if not gaps_confirmed:
        assumptions.append("gaps unconfirmed: members with non-authoritative movesets are not counted")
    if ate_used:
        assumptions.append("-ate skin re-typed Normal moves (new type + STAB) for: " + ", ".join(ate_used))

    return {
        "kind": "offense",
        "team_size": len(attackers),
        "partial": len(attackers) < 6,
        "hard_gaps": hard_gaps,
        "thin": thin,
        "centralized": centralized,
        "by_defense_type": by_def,
        "gaps_confirmed": gaps_confirmed,
        "incomplete_members": incomplete_members,
        "confidence": confidence,
        "confidence_reason": confidence_reason,
        "assumptions": assumptions,
        "evidence": {
            "facts": [{"source": "dex", "ref": "pokemon types + move type/category"}],
            "assumptions": assumptions,
            "table": "builtin type chart; STAB = move type in attacker's types",
        },
        "notes": notes,
    }


def _src_str(s: dict[str, Any]) -> str:
    tag = "STAB" if s["stab"] else "non-STAB"
    if s.get("ate"):
        tag += ", -ate"
    return f"{s['mon']} ({s['move']}, {tag})"


def format_offense_md(d: dict[str, Any]) -> str:
    # Every type below is a DEFENDING type the team is (or isn't) able to hit super-effectively.
    lines = [f"# Offense ({d['team_size']} Pokemon{', partial' if d['partial'] else ''}) — "
             f"confidence {d['confidence']} ({d['confidence_reason']})",
             "_Types below are defending types your team hits super-effectively._"]
    if d.get("incomplete_members"):
        names = ", ".join(f"{m['species']} ({m['completeness']})" for m in d["incomplete_members"])
        lines.append(f"\n> ⚠️ Gaps NOT confirmed — incomplete movesets not counted: {names}.")
    if d["hard_gaps"]:
        head = "Hard gaps" if d.get("gaps_confirmed", True) else "Possible gaps (unconfirmed)"
        lines.append(f"\n## {head} — no super-effective answer vs these defending types")
        lines.append("- " + ", ".join(d["hard_gaps"]))
    if d["thin"]:
        lines.append("\n## Thin — only non-STAB coverage (firepower likely soft)")
        for D in d["thin"]:
            srcs = ", ".join(_src_str(s) for s in d["by_defense_type"][D]["sources"])
            lines.append(f"- vs **{D}**-types: {srcs}")
    if d["centralized"]:
        lines.append("\n## Centralized — a single attacker covers this defending type")
        for c in d["centralized"]:
            tag = "STAB" if c["stab"] else "non-STAB"
            lines.append(f"- vs **{c['type']}**-types: only {c['mon']} ({tag})")
    covered = [D for D, v in d["by_defense_type"].items() if v["class"] == "covered"]
    if covered:
        lines.append("\n## Covered — a STAB super-effective source exists vs: " + ", ".join(covered))
    lines.append("\n## Notes")
    lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Speed: the team's own speed landscape + control inventory, contextualized.
#
# Complementary to `matchup` (which compares each member against meta opponents): speed diagnose
# stays team-internal and needs no meta/ncp — Champions Speed is the integer-exact closed form
# (cliffs.champ_speed, verified against ncp), so the raw landscape is computed, not estimated.
# It reports HOW field conditions reshape that landscape and WHAT speed control the team itself
# carries, all as objective facts — never a "fast enough" score.
# --------------------------------------------------------------------------- #

# Speed modifiers are owned by cliffs.py (single source of truth, shared with matchup) so the two
# operators can never disagree on a Pokemon's Speed again (audit retro 2026-06-22).
_WEATHER_SPEED_ABILITIES = WEATHER_SPEED_ABILITIES
_SPEED_ITEMS = SPEED_ITEM_MULT
# Abilities that boost Speed under a non-weather trigger (annotated, not folded into the number).
_OTHER_SPEED_ABILITIES = {
    "Unburden": ("after its item is consumed", 2.0),
    "Protosynthesis": ("in sun / on Booster Energy, only if Speed is its highest stat", 1.5),
    "Quark Drive": ("on Electric Terrain / Booster Energy, only if Speed is its highest stat", 1.5),
}
# Move names that are speed control (the move being in the moveset is the fact we report).
_SPEED_CONTROL_MOVES = {
    "tailwind": "doubles your side's Speed", "trick room": "reverses the turn order (slower acts first)",
    "icy wind": "lowers foes' Speed", "electroweb": "lowers foes' Speed", "bulldoze": "lowers foes' Speed",
    "rock tomb": "lowers foe Speed", "low sweep": "lowers foe Speed", "scary face": "sharply lowers foe Speed",
    "string shot": "lowers foes' Speed", "cotton spore": "sharply lowers foes' Speed",
    "thunder wave": "paralysis (halves Speed)", "glare": "paralysis (halves Speed)",
    "nuzzle": "paralysis (halves Speed)", "sticky web": "lowers grounded switch-ins' Speed",
    "quash": "moves a foe last", "after you": "moves an ally next",
}
# A priority ATTACKING move lets a member strike before a faster foe, so the neutral base-Speed
# landscape can read "slower" yet the member still hits first. The priority STAGE is an authoritative
# dex field (Serebii speed-priority brackets, signed int; 0 == normal) — we never hand-maintain it here.
# We surface the FACT (the damaging move is in the set + its dex stage); we do NOT predict turn order —
# that also depends on the foe's own priority, ability-granted priority (Prankster/Gale Wings), and field.
# Excluded because their high stage doesn't mean reliable strike-first damage:
#   Fake Out  (击掌奇袭, +3): first turn out only, a flinch utility that doesn't aim to KO.
#   Upper Hand (快手还击, +3): only triggers when the foe is itself about to use a priority move.
_PRIORITY_ATTACK_EXCLUDE = {"fake out", "upper hand"}


def diagnose_speed(team: Team, facts: dict[str, dict[str, Any]],
                   move_facts: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """The team's Speed landscape (neutral closed-form), plus how conditions reshape it and what
    speed control the team carries. Members with no dex facts are skipped (listed honestly).

    Speed uses each member's actual Spe SP + nature when given; when a member declares no spread or
    no nature, neutral (0 Spe SP / neutral nature) is assumed and the member is flagged — the report
    stays honest rather than inventing a spread.

    move_facts (query-name -> dex move dict incl. signed `priority`) is optional: when supplied, each
    member's damaging positive-priority moves are surfaced so a slower member that can still strike
    first is not misread. Without it, priority_moves is simply empty.
    """
    move_facts = move_facts or {}
    members: list[dict[str, Any]] = []
    skipped: list[str] = []
    assumed: list[str] = []
    unknown_ability: list[str] = []
    for m in team.pokemon:
        f = facts.get(m.species)
        if not f or not f.get("found"):
            skipped.append(m.species or "(blank)")
            continue
        base = ((f.get("stats") or {}).get("spe"))
        spread = m.spread or {}
        spe_sp = int(spread.get("spe") or 0)
        sp_known = "spe" in spread
        nature_known = m.nature is not None
        if not sp_known or not nature_known:
            assumed.append(m.species)
        speed = champ_speed(base, spe_sp, m.nature) if base is not None else None

        ability, ability_unknown = _certain_ability(m.ability, f.get("abilities"))
        if ability_unknown:
            unknown_ability.append(m.species)
        modifiers: list[dict[str, Any]] = []
        scarf_speed = None
        if m.item in _SPEED_ITEMS and speed is not None:
            mult = _SPEED_ITEMS[m.item]
            scarf_speed = int(speed * mult)
            modifiers.append({"source": m.item, "kind": "item", "mult": mult,
                              "trigger": "always (locked into one move)", "speed": scarf_speed})
        if ability in _WEATHER_SPEED_ABILITIES:
            trig, mult = _WEATHER_SPEED_ABILITIES[ability]
            modifiers.append({"source": ability, "kind": "ability", "mult": mult, "trigger": trig,
                              "speed": int(speed * mult) if speed is not None else None})
        if ability in _OTHER_SPEED_ABILITIES:
            trig, mult = _OTHER_SPEED_ABILITIES[ability]
            modifiers.append({"source": ability, "kind": "ability", "mult": mult, "trigger": trig,
                              "speed": int(speed * mult) if speed is not None else None})

        # Damaging moves with a positive dex priority stage (excluding the two too-conditional ones).
        priority_moves: list[dict[str, Any]] = []
        for mv in (m.moves or []):
            key = (mv or "").strip().lower()
            mf = move_facts.get(mv) or {}
            pr = mf.get("priority")
            cat = (mf.get("category") or "").lower()
            if (isinstance(pr, int) and pr > 0 and cat in ("physical", "special")
                    and key not in _PRIORITY_ATTACK_EXCLUDE):
                priority_moves.append({"move": mv, "priority": pr})
        priority_moves.sort(key=lambda p: (-p["priority"], p["move"]))

        members.append({
            "species": m.species, "base_speed": base, "speed": speed,
            "spe_sp": spe_sp, "nature": m.nature,
            "assumed_neutral": (not sp_known or not nature_known),
            "ability": ability, "ability_unknown": ability_unknown,
            "modifiers": modifiers,
            "priority_moves": priority_moves,
        })

    # Neutral landscape ordering (fastest first); members with unknown base Speed sort last.
    ranked = [x for x in members if x["speed"] is not None]
    ranked.sort(key=lambda x: (-x["speed"], x["species"]))
    order = [{"species": x["species"], "speed": x["speed"]} for x in ranked]
    order_under_trick_room = [{"species": x["species"], "speed": x["speed"]}
                              for x in sorted(ranked, key=lambda x: (x["speed"], x["species"]))]

    # Speed-control inventory carried by the team (objective: move in moveset / dex ability / item).
    control_moves, control_abilities, control_items = [], [], []
    present_species = {x["species"] for x in members}
    for m in team.pokemon:
        if m.species not in present_species:
            continue
        for mv in (m.moves or []):
            key = (mv or "").strip().lower()
            if key in _SPEED_CONTROL_MOVES:
                control_moves.append({"species": m.species, "move": mv,
                                      "effect": _SPEED_CONTROL_MOVES[key]})
    for x in members:
        ab = x["ability"]
        if ab in _WEATHER_SPEED_ABILITIES:
            trig, mult = _WEATHER_SPEED_ABILITIES[ab]
            control_abilities.append({"species": x["species"], "ability": ab,
                                      "effect": f"x{mult:g} Speed in {trig}"})
        elif ab in _OTHER_SPEED_ABILITIES:
            trig, mult = _OTHER_SPEED_ABILITIES[ab]
            control_abilities.append({"species": x["species"], "ability": ab,
                                      "effect": f"x{mult:g} Speed {trig}"})
        if any(md["kind"] == "item" for md in x["modifiers"]):
            control_items.append({"species": x["species"], "item": next(
                md["source"] for md in x["modifiers"] if md["kind"] == "item")})

    notes = [
        "Speed is the integer-exact Champions closed form (base + Spe SP + nature), verified against ncp.",
        "Tailwind doubles your whole side's Speed (relative order within the side is unchanged); "
        "Trick Room reverses turn order so the SLOWER Pokemon moves first; paralysis halves Speed.",
        "Per-opponent speed comparisons (who outspeeds which meta threat) are the `matchup` operator's "
        "job — this is the team-internal landscape + the speed control you carry.",
    ]
    if any(x["priority_moves"] for x in members):
        notes.append("Priority attacking moves (dex priority stage, Serebii brackets) let a member strike "
                     "BEFORE a faster foe — the base-Speed order above does not reflect this. Some are still "
                     "conditional (Sucker Punch only if the foe attacks; Grassy Glide only on Grassy Terrain), "
                     "and turn order also depends on the foe's own priority and ability-granted priority "
                     "(Prankster/Gale Wings/Triage), none of which is modeled here. Fake Out (+3, first turn "
                     "only) and Upper Hand (+3, only vs a foe's priority move) are excluded as too situational.")
    if assumed:
        notes.append("Assumed neutral (0 Spe SP / neutral nature) where unspecified: "
                     + ", ".join(sorted(set(assumed))) + " — give each member's spread + nature for exact Speed.")
    if unknown_ability:
        notes.append("Ability unspecified (2+ legal abilities) for: " + ", ".join(sorted(set(unknown_ability)))
                     + " — weather-speed / other ability speed signals are NOT reported for them "
                     "(dex lists legal abilities, not a usage default); specify the ability.")
    if skipped:
        notes.append("Skipped (no dex facts): " + ", ".join(skipped) + ".")

    assumptions = [
        "Speed = Champions closed form (base + Spe SP + nature); exact, no ncp needed",
        "field modifiers (Scarf/weather abilities/Tailwind/Trick Room) are annotated, not folded into one number",
    ]
    if assumed:
        assumptions.append("neutral 0-Spe-SP / neutral nature assumed where unspecified: "
                           + ", ".join(sorted(set(assumed))))

    # Below high when the base number is itself assumed (spread/nature inferred) OR when an unspecified
    # 2+-ability member could hide a conditional speed mod (Swift Swim / Unburden / Protosynthesis), so
    # the landscape may understate a member's speed. Reason is a single controlled token (evidence.
    # CONFIDENCE_REASONS), so when both apply we surface the spread/nature cause (it moves the base
    # number directly) and keep the ability cause in the notes (audit 2026-06-28).
    if assumed:
        confidence, confidence_reason = "medium", "spread-or-nature-inferred"
    elif unknown_ability:
        confidence, confidence_reason = "medium", "ability-unspecified"
    else:
        confidence, confidence_reason = "high", None
    return {
        "kind": "speed",
        "team_size": len(members),
        "partial": len(members) < 6,
        "order": order,
        "order_under_trick_room": order_under_trick_room,
        "members": members,
        "speed_control": {"moves": control_moves, "abilities": control_abilities, "items": control_items},
        "skipped": skipped,
        "confidence": confidence,
        "confidence_reason": confidence_reason,
        "assumptions": assumptions,
        "evidence": {
            "facts": [{"source": "dex", "ref": "base Speed + abilities + types"}],
            "inputs": [{"source": "team-json", "ref": "Spe SP + nature + item + moves"}],
            "assumptions": assumptions,
            "table": "builtin Champions Speed closed form (cliffs.champ_speed)",
        },
        "notes": notes,
    }


def format_speed_md(d: dict[str, Any]) -> str:
    lines = [f"# Speed ({d['team_size']} Pokemon{', partial' if d['partial'] else ''}) — "
             f"confidence {d['confidence']}"]
    if d["order"]:
        lines.append("\n## Speed order (neutral, fastest first)")
        for i, e in enumerate(d["order"], 1):
            member = next(m for m in d["members"] if m["species"] == e["species"])
            tag = " *(assumed neutral)*" if member["assumed_neutral"] else ""
            mods = "".join(
                f" — {md['source']} {md['speed']} ({md['trigger']})" if md.get("speed") is not None
                else f" — {md['source']} ({md['trigger']})"
                for md in member["modifiers"])
            lines.append(f"{i}. **{e['species']}** {e['speed']}{tag}{mods}")
    unknown = [m["species"] for m in d["members"] if m["speed"] is None]
    if unknown:
        lines.append("- (base Speed unknown, not ranked): " + ", ".join(unknown))
    prio = [m for m in d["members"] if m.get("priority_moves")]
    if prio:
        lines.append("\n## Priority attacking moves (can strike before a faster foe)")
        for m in prio:
            moves = ", ".join(f"{pm['move']} (+{pm['priority']})" for pm in m["priority_moves"])
            lines.append(f"- **{m['species']}**: {moves}")
    sc = d["speed_control"]
    if sc["moves"] or sc["abilities"] or sc["items"]:
        lines.append("\n## Speed control on the team")
        for c in sc["moves"]:
            lines.append(f"- {c['species']}: **{c['move']}** — {c['effect']}")
        for c in sc["abilities"]:
            lines.append(f"- {c['species']}: **{c['ability']}** — {c['effect']}")
        for c in sc["items"]:
            lines.append(f"- {c['species']}: **{c['item']}**")
    else:
        lines.append("\n## Speed control on the team\n- none detected (no Tailwind/Trick Room/speed-drop "
                     "moves, scarf, or weather-speed abilities)")
    lines.append("\n## Notes")
    lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Roles: OBJECTIVE functional signals only.
#
# design.md is explicit that pinning a "role label" on a Pokemon is subjective, error-prone, and
# slips into a strength judgment (§16 note). So this operator NEVER says "X is a wall" or "you are
# missing a pivot, add one". It reports verifiable signals — functional moves carried, base-stat
# orientation, item/ability signals — and a neutral present/not-detected checklist of functional
# categories. The model decides actual roles and what (if anything) to change. No score, no
# prescription. Confidence is 'low' (reason heuristic-role): these are signals, not assignments.
# --------------------------------------------------------------------------- #

# Functional move groups, keyed by lowercase move name. A move may appear in two groups
# (e.g. Sticky Web is both a hazard and speed control) — both signals are reported.
_ROLE_MOVES: dict[str, set[str]] = {
    "setup": {
        "swords dance", "dragon dance", "nasty plot", "calm mind", "bulk up", "quiver dance",
        "shell smash", "work up", "coil", "hone claws", "agility", "rock polish", "autotomize",
        "tail glow", "growth", "shift gear", "victory dance", "clangorous soul", "no retreat",
        "belly drum", "geomancy", "cosmic power", "iron defense", "acid armor", "curse",
    },
    "pivot": {"u-turn", "volt switch", "flip turn", "teleport", "parting shot", "baton pass"},
    "hazard_set": {"stealth rock", "spikes", "toxic spikes", "sticky web"},
    "hazard_control": {"rapid spin", "defog", "mortal spin", "tidy up", "court change"},
    "recovery": {
        "recover", "roost", "synthesis", "moonlight", "morning sun", "slack off", "soft-boiled",
        "milk drink", "rest", "wish", "shore up", "strength sap", "life dew", "jungle healing",
        "lunar blessing", "heal order", "purify",
    },
    "speed_control": {
        "tailwind", "trick room", "icy wind", "electroweb", "thunder wave", "glare", "nuzzle",
        "sticky web", "scary face", "bulldoze", "rock tomb", "low sweep", "cotton spore",
        "string shot", "quash", "after you",
    },
    "redirection": {"follow me", "rage powder", "spotlight", "ally switch"},
    "screens": {"reflect", "light screen", "aurora veil"},
    "status": {
        "will-o-wisp", "toxic", "thunder wave", "glare", "spore", "sleep powder", "stun spore",
        "yawn", "taunt", "encore", "disable", "haze", "clear smog", "roar", "whirlwind",
        "perish song", "heal bell", "aromatherapy", "fake out",
    },
    "protect": {
        "protect", "detect", "spiky shield", "king's shield", "baneful bunker", "silk trap",
        "burning bulwark",
    },
    # Doubles partner semantics — moves that BUFF or ENABLE an ALLY (not afflict a foe): the
    # doubles-specific support signal (§16.3). Some also live in recovery/speed_control (a move may be
    # in two groups). A signal only — never a "this mon is the support" label.
    "partner_support": {
        "helping hand", "coaching", "decorate", "aromatic mist", "gear up", "magnetic flux",
        "heal pulse", "pollen puff", "life dew", "jungle healing", "after you",
    },
    # Side-wide protection (doubles): guards the WHOLE side for a turn, distinct from single self-protect.
    "side_protect": {"wide guard", "quick guard", "mat block"},
}
_ROLE_LABELS = {
    "setup": "setup", "pivot": "pivot", "hazard_set": "hazard setter",
    "hazard_control": "hazard control", "recovery": "recovery", "speed_control": "speed control",
    "redirection": "redirection (doubles)", "screens": "screens", "status": "status/utility",
    "protect": "protect", "partner_support": "partner support (doubles)",
    "side_protect": "side protection (doubles)",
}
# Item signals (objective: the item is declared). Mega stones are intentionally omitted — Mega is
# handled by validate/selection, not a role signal.
_ITEM_SIGNALS = {
    "Choice Band": "choice-locked physical", "Choice Specs": "choice-locked special",
    "Choice Scarf": "choice-locked + x1.5 Speed", "Assault Vest": "special bulk (no status moves)",
    "Eviolite": "bulk (not-fully-evolved)", "Focus Sash": "survives one hit from full HP",
    "Life Orb": "extra power (recoil)", "Leftovers": "passive recovery",
    "Black Sludge": "passive recovery (Poison)", "Sitrus Berry": "one-time recovery",
    "Rocky Helmet": "contact chip", "Mental Herb": "anti-Taunt/Encore (one-time)",
    "Safety Goggles": "weather/powder immunity",
}
# Ability signals well-understood as team functions (objective: declared / dex ability).
_ABILITY_SIGNALS = {
    "Intimidate": "lowers foe Attack on entry (support)", "Regenerator": "heals on switch (longevity pivot)",
    "Prankster": "priority status", "Drizzle": "rain setter", "Drought": "sun setter",
    "Sand Stream": "sandstorm setter", "Snow Warning": "snow setter",
    "Electric Surge": "Electric Terrain setter", "Grassy Surge": "Grassy Terrain setter",
    "Misty Surge": "Misty Terrain setter", "Psychic Surge": "Psychic Terrain setter",
    "Levitate": "Ground immunity (defensive)", "Magic Bounce": "reflects status/hazards",
    "Unaware": "ignores stat changes (wall)", "Multiscale": "halves damage at full HP (wall)",
}
# Items / abilities that ALSO fulfil a checklist category, so team coverage agrees with the
# per-member item/ability signals instead of contradicting them ("Leftovers — passive recovery"
# while "recovery: not detected"). Only clean, unambiguous mappings (audit 2026-06-22 / P2-b).
_ITEM_COVERAGE = {
    "Choice Scarf": {"speed_control"},
    "Leftovers": {"recovery"}, "Black Sludge": {"recovery"}, "Sitrus Berry": {"recovery"},
}
# Weather-speed abilities (from the shared cliffs map) all count as speed control for coverage.
_ABILITY_COVERAGE = {ab: {"speed_control"} for ab in WEATHER_SPEED_ABILITIES}
# The functional categories shown in the team checklist (present vs not-detected, neutral framing).
_CHECKLIST = ["speed_control", "hazard_set", "hazard_control", "pivot", "recovery",
              "redirection", "screens", "status", "setup", "protect"]


def _stat_orientation(stats: dict[str, Any]) -> dict[str, Any]:
    """Base-stat offensive lean + bulk tier. A signal, NOT a role label."""
    at = stats.get("atk") or 0
    sa = stats.get("spa") or 0
    if at and sa and at >= sa * 1.15:
        lean = "physical"
    elif at and sa and sa >= at * 1.15:
        lean = "special"
    elif at or sa:
        lean = "mixed"
    else:
        lean = "unknown"
    return {"offense_lean": lean, "atk": at, "spa": sa, "bulk": defensive_headroom(stats)}


def diagnose_roles(team: Team, facts: dict[str, dict[str, Any]]) -> dict[str, Any]:
    """Objective functional signals per member + a neutral team coverage checklist + compression.

    Move signals come from move NAMES (no dex move lookup needed); stat orientation + bulk come from
    dex base stats; item/ability signals from the declared set. Members whose moveset is not
    authoritative still get stat/item/ability signals, but their move signals are flagged unknown so
    the coverage checklist does not report a phantom gap (mirrors offense's gaps_confirmed).
    """
    members: list[dict[str, Any]] = []
    skipped: list[str] = []
    incomplete_members: list[dict[str, str]] = []
    for m in team.pokemon:
        f = facts.get(m.species)
        if not f or not f.get("found"):
            skipped.append(m.species or "(blank)")
            continue
        moves_authoritative = completeness.moveset_authoritative(
            m.completeness, has_moves=bool(m.moves))
        tags: dict[str, list[str]] = {}
        if moves_authoritative:
            for mv in (m.moves or []):
                key = (mv or "").strip().lower()
                for tag, names in _ROLE_MOVES.items():
                    if key in names:
                        tags.setdefault(tag, []).append(mv)
        else:
            incomplete_members.append({
                "species": m.species or "(blank)",
                "completeness": completeness.effective_level(m.completeness, has_moves=bool(m.moves)),
            })
        ability, ability_unknown = _certain_ability(m.ability, f.get("abilities"))
        item_signal = _ITEM_SIGNALS.get(m.item) if m.item else None
        ability_signal = _ABILITY_SIGNALS.get(ability) if ability else None
        # Functional categories this member contributes to via its item / ability (not just moves),
        # so the coverage checklist agrees with the per-member signals shown (audit 2026-06-22 / P2-b).
        item_tags = _ITEM_COVERAGE.get(m.item, set()) if m.item else set()
        ability_tags = _ABILITY_COVERAGE.get(ability, set()) if ability else set()
        # Distinct functional signals this member carries (for compression counting).
        signal_tags = set(tags)
        if item_signal:
            signal_tags.add("item:" + (m.item or ""))
        if ability_signal:
            signal_tags.add("ability:" + (ability or ""))
        members.append({
            "species": m.species,
            "stat_orientation": _stat_orientation(f.get("stats") or {}),
            "move_signals": {t: tags[t] for t in tags},
            "moves_authoritative": moves_authoritative,
            "item": m.item, "item_signal": item_signal, "item_tags": sorted(item_tags),
            "ability": ability, "ability_unknown": ability_unknown, "ability_signal": ability_signal,
            "ability_tags": sorted(ability_tags),
            "signal_count": len(signal_tags),
        })

    # Team functional coverage: present (with bearers) vs not-detected. Bearers come from moves AND
    # the item/ability contributors, so the checklist agrees with the per-member signals (a member
    # holding Leftovers now counts under recovery). Each bearer is tagged with its source. Neutral
    # framing — a not-detected category is an objective absence, NOT a prescription to add one.
    # Doubles also checklists the partner-support + side-protection categories (singles don't run them,
    # so they'd be phantom 'not detected' gaps there — §16.3 doubles aspect).
    checklist = list(_CHECKLIST)
    if (team.format or "").lower() == "double":
        checklist += ["partner_support", "side_protect"]
    coverage: dict[str, dict[str, Any]] = {}
    for tag in checklist:
        bearers: list[dict[str, str]] = []
        for mm in members:
            srcs = []
            if tag in mm["move_signals"]:
                srcs.append("move")
            if tag in mm["item_tags"]:
                srcs.append(f"item:{mm['item']}")
            if tag in mm["ability_tags"]:
                srcs.append(f"ability:{mm['ability']}")
            if srcs:
                bearers.append({"species": mm["species"], "via": ", ".join(srcs)})
        coverage[tag] = {"label": _ROLE_LABELS[tag], "present": bool(bearers), "bearers": bearers}
    not_detected = [coverage[t]["label"] for t in checklist if not coverage[t]["present"]]

    # Compression: members carrying multiple distinct functional signals (objective count).
    compression = sorted(
        [{"species": mm["species"], "signal_count": mm["signal_count"],
          "signals": (sorted(mm["move_signals"]) + ([f"item:{mm['item']}"] if mm["item_signal"] else [])
                      + ([f"ability:{mm['ability']}"] if mm["ability_signal"] else []))}
         for mm in members if mm["signal_count"] >= 2],
        key=lambda x: (-x["signal_count"], x["species"]))

    coverage_confirmed = not incomplete_members
    notes = [
        "These are OBJECTIVE signals (functional moves carried, base-stat orientation, item/ability "
        "signals), NOT role assignments — the model decides actual roles and what to change.",
        "A 'not detected' category is a neutral fact (this functional move/ability/item isn't on the "
        "team), NOT a recommendation to add it.",
        "Stat orientation is a base-stat lean, not a build: a physical-leaning species can still run a "
        "special set. Doubles roles also depend on the partner (a lone set can be ambiguous).",
    ]
    if incomplete_members:
        names = ", ".join(f"{m['species']} ({m['completeness']})" for m in incomplete_members)
        notes.append("Move signals NOT counted for members without an authoritative moveset (coverage "
                     "'not detected' may be incomplete): " + names + ".")
    if skipped:
        notes.append("Skipped (no dex facts): " + ", ".join(skipped) + ".")

    assumptions = [
        "role signals are heuristic (move-name / base-stat / item / ability derived), not role labels",
        "stat orientation is a base-stat lean, not the member's actual physical/special split",
    ]
    if not coverage_confirmed:
        assumptions.append("coverage gaps unconfirmed: members with non-authoritative movesets not counted")

    return {
        "kind": "roles",
        "team_size": len(members),
        "partial": len(members) < 6,
        "members": members,
        "coverage": coverage,
        "not_detected": not_detected,
        "compression": compression,
        "coverage_confirmed": coverage_confirmed,
        "incomplete_members": incomplete_members,
        "skipped": skipped,
        "confidence": "low",
        "confidence_reason": "heuristic-role",
        "assumptions": assumptions,
        "evidence": {
            "facts": [{"source": "dex", "ref": "base stats + abilities"}],
            "inputs": [{"source": "team-json", "ref": "moves + item + ability"}],
            "assumptions": assumptions,
            "table": "builtin functional move taxonomy + item/ability signal map",
        },
        "notes": notes,
    }


def format_roles_md(d: dict[str, Any]) -> str:
    lines = [f"# Roles ({d['team_size']} Pokemon{', partial' if d['partial'] else ''}) — "
             f"confidence {d['confidence']} ({d['confidence_reason']})",
             "_Objective signals only — the model decides actual roles; nothing here is a recommendation._"]
    if d.get("incomplete_members"):
        names = ", ".join(f"{m['species']} ({m['completeness']})" for m in d["incomplete_members"])
        lines.append(f"\n> ⚠️ Move signals not counted (no authoritative moveset): {names}.")
    lines.append("\n## Per member")
    for mm in d["members"]:
        so = mm["stat_orientation"]
        sig = []
        for tag, mvs in mm["move_signals"].items():
            sig.append(f"{_ROLE_LABELS.get(tag, tag)} ({', '.join(mvs)})")
        if mm["item_signal"]:
            sig.append(f"item: {mm['item']} — {mm['item_signal']}")
        if mm["ability_signal"]:
            sig.append(f"ability: {mm['ability']} — {mm['ability_signal']}")
        if mm.get("ability_unknown"):
            sig.append("ability: unspecified (2+ legal; ability signals omitted)")
        sig_str = "; ".join(sig) if sig else "no functional signals detected"
        lines.append(f"- **{mm['species']}** [{so['offense_lean']} lean, {so['bulk']} bulk]: {sig_str}")
    lines.append("\n## Team functional coverage (moves + items + abilities; present / not detected — neutral facts)")
    # Iterate the coverage dict itself (insertion-ordered: singles checklist, then the doubles-only
    # partner_support / side_protect when present) so the doubles categories actually render here — not
    # the singles-only _CHECKLIST, which silently dropped them from the MD section (audit 2026-06-27).
    for tag in d["coverage"]:
        c = d["coverage"][tag]
        if c["present"]:
            bearers = ", ".join(f"{b['species']} ({b['via']})" for b in c["bearers"])
            lines.append(f"- [x] {c['label']}: {bearers}")
        else:
            lines.append(f"- [ ] {c['label']}: not detected")
    if d["compression"]:
        lines.append("\n## Compression (members carrying multiple functional signals)")
        for c in d["compression"]:
            lines.append(f"- **{c['species']}** ({c['signal_count']}): {', '.join(c['signals'])}")
    lines.append("\n## Notes")
    lines += [f"- {n}" for n in d["notes"]]
    return "\n".join(lines)
