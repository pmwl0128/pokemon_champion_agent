#!/usr/bin/env python
"""team-json + Showdown-text parsing/serialization (M1.1).

Accepts two inputs and normalizes both to the canonical team-json shape
(see references/schema.md):
  - team-json  : our own structure (a dict with a "pokemon" list).
  - Showdown   : the common paste format, blank-line separated members.

Showdown EV lines are read into `spread` as Champions SP (1 SP = +1 stat); Champions
has no IVs/EVs, so any "IVs" line is ignored. This module does no legality checks.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any

STATS = ["hp", "atk", "def", "spa", "spd", "spe"]
_EV_TOKEN = {"hp": "hp", "atk": "atk", "at": "atk", "def": "def", "df": "def",
             "spa": "spa", "spatk": "spa", "spd": "spd", "spdef": "spd",
             "spe": "spe", "spd.": "spd"}


@dataclass
class TeamMember:
    species: str
    item: str | None = None
    ability: str | None = None
    moves: list[str] = field(default_factory=list)
    nature: str | None = None
    spread: dict[str, int] | None = None
    tera: str | None = None
    completeness: str | None = None    # observed_full_set | observed_species_only | extracted_set | inferred_set


@dataclass
class Team:
    pokemon: list[TeamMember]
    format: str | None = None          # "single" | "double"
    season: str | None = None
    rule: str | None = None
    provenance: dict[str, Any] | None = None
    schema_version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "format": self.format,
            "season": self.season,
            "rule": self.rule,
            "pokemon": [asdict(m) for m in self.pokemon],
            "provenance": self.provenance,
        }


# --------------------------------------------------------------------------- #
# team-json
# --------------------------------------------------------------------------- #

def _member_from_dict(d: dict[str, Any]) -> TeamMember:
    return TeamMember(
        species=str(d.get("species") or d.get("name") or "").strip(),
        item=d.get("item"),
        ability=d.get("ability"),
        moves=list(d.get("moves") or d.get("attacks") or []),
        nature=d.get("nature"),
        spread=d.get("spread"),
        tera=d.get("tera"),
        completeness=d.get("completeness"),
    )


def team_from_dict(d: dict[str, Any]) -> Team:
    members = [_member_from_dict(m) for m in (d.get("pokemon") or d.get("decklist") or [])]
    return Team(
        pokemon=members,
        format=d.get("format"),
        season=d.get("season"),
        rule=d.get("rule"),
        provenance=d.get("provenance"),
        schema_version=int(d.get("schema_version", 1)),
    )


# --------------------------------------------------------------------------- #
# Showdown text
# --------------------------------------------------------------------------- #

def _parse_spread(line: str) -> dict[str, int]:
    spread = {s: 0 for s in STATS}
    for amount, label in re.findall(r"(\d+)\s+([A-Za-z.]+)", line):
        key = _EV_TOKEN.get(label.lower().rstrip("."))
        if key:
            spread[key] = int(amount)
    return spread


def _parse_member_block(block: str) -> TeamMember | None:
    lines = [ln.rstrip() for ln in block.splitlines() if ln.strip()]
    if not lines:
        return None
    m = TeamMember(species="")
    head = lines[0]
    if "@" in head:
        name, item = head.split("@", 1)
        m.species, m.item = name.strip(), item.strip()
    else:
        m.species = head.strip()
    # Showdown header forms: "Species", "Nickname (Species)", optionally "... (M)/(F)".
    # Strip the gender marker first, then if a "(Species)" suffix remains it is the real
    # species and the leading text is just a nickname (dex can't resolve "Nick (Garchomp)").
    m.species = re.sub(r"\s*\((?:M|F)\)\s*$", "", m.species).strip()
    nick = re.match(r"^.+?\s*\(([^()]+)\)\s*$", m.species)
    if nick:
        m.species = nick.group(1).strip()
    for ln in lines[1:]:
        low = ln.lower()
        if low.startswith("ability:"):
            m.ability = ln.split(":", 1)[1].strip()
        elif low.startswith("evs:") or low.startswith("sp:"):
            m.spread = _parse_spread(ln.split(":", 1)[1])
        elif low.startswith("ivs:") or low.startswith("level:") or low.startswith("tera type:"):
            continue
        elif low.endswith("nature"):
            m.nature = ln.rsplit(" ", 1)[0].strip()
        elif ln.lstrip().startswith("-"):
            mv = ln.lstrip()[1:].strip()
            if mv:
                m.moves.append(mv)
    return m if m.species else None


def team_from_showdown(text: str) -> Team:
    blocks = re.split(r"\n\s*\n", text.strip())
    members = [mm for mm in (_parse_member_block(b) for b in blocks) if mm]
    return Team(pokemon=members)


# --------------------------------------------------------------------------- #
# Entry points
# --------------------------------------------------------------------------- #

def parse_text(text: str) -> Team:
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return team_from_dict(json.loads(text))
    return team_from_showdown(text)


def load_team(path: str | Path) -> Team:
    p = Path(path)
    return parse_text(p.read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# build-context (intent layer — schema.md §7). AI translates conversation intent
# into this structured object; the skill never parses free text.
# --------------------------------------------------------------------------- #

@dataclass
class BuildContext:
    season: str | None = None
    rule: str | None = None
    format: str | None = None
    locked: list[str] = field(default_factory=list)      # members the user will not change
    owned_only: bool = False                             # restrict to owned roster
    owned: list[str] = field(default_factory=list)       # owned species (canonical or dex-resolvable)
    wants: list[str] = field(default_factory=list)       # tactics: weather/trickroom/tailwind/...
    keep_mega: str | None = None
    avoid: list[str] = field(default_factory=list)
    benchmarks: list[dict[str, Any]] = field(default_factory=list)   # SP-tuning targets (schema §7, design §16)
    need: dict[str, Any] = field(default_factory=dict)               # L3 fill gap spec (design §6/§13 M3):
    #   {resist: type|[types], offense_type: type|[types], coverage_move_type: type|[types],
    #    role: name|[names], min_speed: int}
    replace: dict[str, Any] = field(default_factory=dict)            # L3 replace-impact (design §6/§13 M3):
    #   {member: "<species to remove>", with: <full team-json member: species + set>}


def context_from_dict(d: dict[str, Any]) -> BuildContext:
    return BuildContext(
        season=d.get("season"), rule=d.get("rule"), format=d.get("format"),
        locked=list(d.get("locked") or []),
        owned_only=bool(d.get("owned_only", False)),
        owned=list(d.get("owned") or []),
        wants=list(d.get("wants") or []),
        keep_mega=d.get("keep_mega"),
        avoid=list(d.get("avoid") or []),
        benchmarks=list(d.get("benchmarks") or []),
        need=dict(d.get("need") or {}),
        replace=dict(d.get("replace") or {}),
    )


def load_context(path: str | Path) -> BuildContext:
    return context_from_dict(json.loads(Path(path).read_text(encoding="utf-8")))


def read_owned(path: str | Path) -> list[str]:
    """Read pokemon_owned.md (one plain name per line, '#' comments ignored).

    Convenience helper; the AI may instead resolve names and fill build-context.owned directly.
    """
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]
