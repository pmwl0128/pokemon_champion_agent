#!/usr/bin/env python
"""Deterministic team-level legality validation (M1.2).

Champions rules enforced here (facts pulled from the sibling dex skill):
  - Roster legality : every species must exist in the Champions dex (catches phantom /
                      pre-evolution / removed Pokemon — the dex already is the roster).
  - Move legality   : every move must be in that species' cached learnset.
  - Move count      : at most `moves_per_pokemon` (4) moves per member, and they must be
                      distinct (dex-independent, definitive — like the SP caps).
  - Ability legality: ability must be one the species can have (when dex lists abilities).
  - Mega item match : if a member is given as a Mega FORM, its item must be that form's stone.
  - Species Clause  : each base species at most once.
  - Item Clause     : each held item at most once across the team.
  - SP caps         : each stat <= 32 SP, total <= 66 SP.
  - Team size       : 3..6 members.

NOT a team-registration rule (so NOT enforced here): "one Mega per battle". Champions is
6-bring-3 (singles) / bring-4 (doubles), so carrying several Mega stones in the registered team
is legal and common — only one may Mega Evolve once selected. That belongs to selection analysis
(M2/M3), not legality.

The model decides strength; this module only decides legality and returns concrete
repairs. Unknown facts (e.g. dex unavailable) are reported as warnings, not silent passes.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from team_io import Team, STATS, BuildContext  # noqa: E402
from dexlink import lookup_pokemon, lookup_items, DexUnavailable  # noqa: E402
from rules import get_ruleset  # noqa: E402


@dataclass
class ValidationResult:
    """Three-state legality (audit 2026-06-21): valid / invalid / unknown.

    A clean pass is only reported when every legality check actually ran. If a check could not run
    (e.g. the dex was unavailable), its result is unknown — NOT silently valid — so a team with
    unverified legality never comes back `valid=true, confidence=high`. `confidence` follows from
    what was actually checked, it is not a fixed constant.
    """
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)   # checks that could not run

    def err(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def skip(self, msg: str) -> None:
        self.skipped.append(msg)
        self.warnings.append(f"Skipped: {msg}")

    @property
    def status(self) -> str:
        # A concrete violation is definitive even if other checks were skipped; absent any
        # violation, an incomplete check set means we cannot certify legality.
        if self.errors:
            return "invalid"
        if self.skipped:
            return "unknown"
        return "valid"

    @property
    def valid(self) -> bool:
        """Back-compat boolean: True only for a fully-checked clean pass (unknown is not valid)."""
        return self.status == "valid"

    @property
    def confidence(self) -> str:
        # invalid: we found a real violation -> high. valid: every check ran clean -> high.
        # unknown: legality couldn't be fully established -> low.
        return "low" if self.status == "unknown" else "high"

    def to_dict(self) -> dict[str, Any]:
        return {"status": self.status, "valid": self.valid, "confidence": self.confidence,
                "errors": self.errors, "warnings": self.warnings, "skipped": self.skipped}


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


def validate(team: Team, context: BuildContext | None = None) -> ValidationResult:
    r = ValidationResult()
    rs = get_ruleset(getattr(context, "season", None) if context else None,
                     getattr(context, "rule", None) if context else None)

    # team size (dex-independent, definitive)
    n = len(team.pokemon)
    if n < rs.team_min or n > rs.team_max:
        r.err(f"Team has {n} Pokemon; Champions teams register {rs.team_min}-{rs.team_max}.")

    # dex facts (one batch call). If the dex is down, roster/move/ability/Mega/base-species checks
    # cannot run -> record them as skipped (status becomes 'unknown', never a silent 'valid').
    species_names = [m.species for m in team.pokemon if m.species]
    dex_ok = True
    try:
        facts = lookup_pokemon(species_names)
    except DexUnavailable as e:
        r.skip(f"roster/move/ability/Mega/Species-Clause legality — dex unavailable ({e})")
        facts = {}
        dex_ok = False

    # Mega abilities: a base-form member holding a Mega stone may legally run the MEGA form's ability
    # (e.g. Charizard @ Charizardite Y with Drought, Metagross @ Metagrossite with Tough Claws). Resolve
    # each held stone -> Mega form -> that form's abilities, keyed by base species, and allow the
    # ability to be in (base ∪ mega). Without this, real Mega sets were flagged illegal (the M4
    # admission gate surfaced this against real tournament teams, 2026-06-22). Species Clause (enforced
    # below) means at most one member per base species, so keying the allowance by base is safe.
    # Bind the Mega-ability allowance to the member's OWN held stone, NOT a team-wide union by base
    # species: keying by base let Charizard @ Charizardite Y borrow Mega Charizard X's Tough Claws off
    # a teammate's Charizardite X (audit 2026-06-23). A stone enables exactly its Mega form(s).
    # AND gate it by base species: a stone only grants its Mega form's ability to the species that can
    # actually Mega-evolve into that form. Without this, Garchomp @ Charizardite Y + Drought passed as
    # high-confidence valid — a non-Charizard can hold the stone but never becomes Mega Charizard Y, so
    # it can't have Drought (audit 2026-06-24). Stored as norm(stone) -> [(form base species, abilities)].
    stone_form_abil: dict[str, list[tuple[str, set[str]]]] = {}
    held_stones = sorted({m.item for m in team.pokemon if m.item})
    if dex_ok and held_stones:
        try:
            item_facts = lookup_items(held_stones)
            forms = sorted({f for it in item_facts.values() for f in (it.get("required_by") or [])})
            form_info = {f: ff for f, ff in (lookup_pokemon(forms) if forms else {}).items()
                         if ff.get("found")}
            for stone, it in item_facts.items():
                entries: list[tuple[str, set[str]]] = []
                for f in (it.get("required_by") or []):
                    ff = form_info.get(f)
                    if not ff:
                        continue
                    fbase = _norm(ff.get("base_species") or ff.get("name") or f)
                    fabil = {_norm(a) for a in (ff.get("abilities") or [])}
                    if fabil:
                        entries.append((fbase, fabil))
                if entries:
                    stone_form_abil[_norm(stone)] = entries
        except DexUnavailable:
            pass

    base_seen: dict[str, list[str]] = {}
    item_seen: dict[str, list[str]] = {}

    for m in team.pokemon:
        sp = m.species or "(blank)"
        fact = facts.get(m.species)

        # roster legality
        if fact is not None:
            if not fact.get("found"):
                r.err(f"`{sp}` is not in the Champions dex (illegal / pre-evolution / wrong name).")
            else:
                # move legality vs cached learnset
                learn = {_norm(x) for x in fact.get("moves", [])}
                if learn:
                    for mv in m.moves:
                        if _norm(mv) not in learn:
                            r.err(f"`{sp}` cannot learn `{mv}` (not in Champions learnset).")
                # ability legality (base abilities + the Mega form's abilities for THIS member's stone,
                # but only when the stone's Mega form shares THIS member's base species — a foreign
                # stone grants nothing, see stone_form_abil above).
                base = fact.get("base_species") or fact.get("name") or sp
                abil = {_norm(x) for x in fact.get("abilities", [])}
                mega_ab: set[str] = set()
                for fbase, fabil in (stone_form_abil.get(_norm(m.item), []) if m.item else []):
                    if fbase == _norm(base):
                        mega_ab |= fabil
                allowed = abil | mega_ab
                if m.ability and allowed and _norm(m.ability) not in allowed:
                    r.err(f"`{sp}` cannot have ability `{m.ability}`.")
                # mega item match
                req = fact.get("required_item")
                if fact.get("is_mega") and req and _norm(m.item) != _norm(req):
                    r.err(f"`{sp}` (Mega) requires item `{req}`, found `{m.item}`.")
                base_seen.setdefault(_norm(base), []).append(sp)
        elif dex_ok:
            # dex is up but this name wasn't resolvable (e.g. blank species); group by raw name.
            base_seen.setdefault(_norm(sp), []).append(sp)

        # item clause bookkeeping (dex-independent)
        if m.item:
            item_seen.setdefault(_norm(m.item), []).append(sp)

        # move count + uniqueness (dex-independent, definitive — a learnset-legal set can still be
        # illegal by carrying >4 moves or the same move twice; the learnset loop above never caught
        # that, so e.g. 6 legal moves or 4x Protect passed as valid/high. audit 2026-06-28).
        if m.moves:
            if len(m.moves) > rs.moves_per_pokemon:
                r.err(f"`{sp}` has {len(m.moves)} moves; max {rs.moves_per_pokemon}.")
            seen_moves: set[str] = set()
            dups: list[str] = []
            for mv in m.moves:
                k = _norm(mv)
                if k and k in seen_moves:
                    dups.append(mv)
                else:
                    seen_moves.add(k)
            if dups:
                r.err(f"`{sp}` carries duplicate move(s): {', '.join(dups)} (each move at most once).")

        # SP caps (dex-independent, definitive)
        if m.spread:
            over = [s.upper() for s in STATS if int(m.spread.get(s, 0)) > rs.sp_per_stat_cap]
            total = sum(int(m.spread.get(s, 0)) for s in STATS)
            if over:
                r.err(f"`{sp}` SP over {rs.sp_per_stat_cap} on: {', '.join(over)}.")
            if total > rs.sp_total_cap:
                r.err(f"`{sp}` SP total {total} exceeds cap {rs.sp_total_cap}.")

    # item pool legality (dex is the authority for the Champions item pool)
    held = sorted({m.item for m in team.pokemon if m.item})
    if held:
        try:
            for it, f in lookup_items(held).items():
                if not f.get("found"):
                    r.err(f"Item `{it}` is not in the Champions item pool.")
        except DexUnavailable as e:
            r.skip(f"item-pool legality — dex unavailable ({e})")

    # owned-only check (from build-context; owned list is AI-supplied / read_owned helper).
    # owned_only with an EMPTY owned list cannot be certified — every member is unverifiable —
    # so it is skipped (status 'unknown'), never silently passed as valid (audit 2026-06-21).
    if context and context.owned_only:
        if not context.owned:
            r.skip("owned-only requested but the owned list is empty — ownership not verifiable.")
        else:
            try:
                owned_base = {
                    (f.get("base_species") or f.get("name"))
                    for f in lookup_pokemon(context.owned).values() if f.get("found")
                }
                for m in team.pokemon:
                    ff = facts.get(m.species)
                    base = (ff.get("base_species") or ff.get("name")) if ff and ff.get("found") else m.species
                    if base not in owned_base:
                        r.err(f"`{m.species}` is not in your owned list (owned_only).")
            except DexUnavailable as e:
                r.skip(f"owned-only check — dex unavailable ({e})")

    # species clause (base resolution needs the dex; skipped above if it was down)
    if rs.species_clause and dex_ok:
        for base, owners in base_seen.items():
            if len(owners) > 1:
                r.err(f"Species Clause: {', '.join(owners)} share a base species; keep at most one.")

    # item clause (dex-independent)
    if rs.item_clause:
        for item, owners in item_seen.items():
            if len(owners) > 1:
                r.err(f"Item Clause: item held by {', '.join(owners)}; each item at most once.")

    # missing vs illegal: on a low-trust/incomplete set, ABSENT fields are unknown, not legal.
    # (Untagged sets are treated as user-authored = trusted, so they don't trip this.)
    # This is recorded as a SKIP, not a mere warning: a team whose sets are incomplete cannot be
    # certified `valid/high` on the strength of the few fields that happen to be present — its
    # status must drop to 'unknown' (confidence low) so an incomplete team is never green-lit
    # (audit 2026-06-21).
    incomplete = [m.species or "(blank)" for m in team.pokemon
                  if m.completeness in ("observed_species_only", "extracted_set", "inferred_set")]
    if incomplete:
        r.skip("legality only partially certifiable — incomplete/low-trust sets whose absent fields "
               "(moves/item/ability) are unknown, not certified legal: " + ", ".join(incomplete) + ".")

    return r


def format_report(r: ValidationResult) -> str:
    head = {"valid": "VALID", "invalid": "INVALID", "unknown": "UNKNOWN (incomplete)"}[r.status]
    lines = [f"# Team validation: {head}  (confidence: {r.confidence})"]
    if r.errors:
        lines.append("\n## Errors")
        lines += [f"- {e}" for e in r.errors]
    if r.skipped:
        lines.append("\n## Not checked (legality could not be established)")
        lines += [f"- {s}" for s in r.skipped]
    other_warnings = [w for w in r.warnings if not w.startswith("Skipped: ")]
    if other_warnings:
        lines.append("\n## Warnings")
        lines += [f"- {w}" for w in other_warnings]
    if r.status == "valid":
        lines.append("\nNo legality issues found (all checks ran).")
    return "\n".join(lines)
