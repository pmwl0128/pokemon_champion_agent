#!/usr/bin/env python
"""Bridge to the sibling pokemon-champions-dex skill.

This skill holds no battle data. Legality facts (roster, types, abilities, learnsets,
Mega items) are read at query time from the sibling dex skill via its public CLI
(`champdex.py ... --format json`), so we depend on its interface, not its internals.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import worker

SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_DIR.parent
DEX_CLI = SKILLS_ROOT / "pokemon-champions-dex" / "scripts" / "champdex.py"


class DexUnavailable(RuntimeError):
    pass


def _run(args: list[str]) -> Any:
    if not DEX_CLI.exists():
        raise DexUnavailable(f"sibling dex skill not found at {DEX_CLI}")
    argv = [*args, "--format", "json"]
    if worker.session_active():             # perf: reuse a resident dex worker within a session
        try:
            return json.loads(worker.run_python("dex", DEX_CLI, argv))
        except (worker.WorkerError, json.JSONDecodeError):
            pass                            # fall back to a one-shot subprocess (results identical)
    proc = subprocess.run(
        [sys.executable, str(DEX_CLI), *argv],
        stdin=subprocess.DEVNULL, capture_output=True, text=True, encoding="utf-8",
    )
    if proc.returncode != 0:
        raise DexUnavailable(proc.stderr.strip() or "champdex.py failed")
    return json.loads(proc.stdout)


def lookup_pokemon(names: list[str], *, fuzzy: bool = False) -> dict[str, dict[str, Any]]:
    """Resolve each name to dex facts. Returns query-name -> fact dict.

    Fact dict keys: found, name (canonical), display_name, types, stats, abilities,
    moves (cached learnset), is_mega, base_species, required_item.

    With `fuzzy=True` the dex applies its conservative typo fallback (design §10): a confident-unique
    hit carries a `resolution` block ({match_type,score,distance,from}); a miss may carry `suggestions`
    (did-you-mean) and, on an ambiguous tie, resolves to NO name (found False) — never a guess. Used at
    runtime for USER-typed species. The dex resolves fuzzily by default, so this bridge passes --strict
    when fuzzy=False: team canonicalizes species once (fuzzy+flagged) at load, then treats everything
    downstream as exact facts — a silent later correction would mask a real problem.
    """
    if not names:
        return {}
    args = ["batch", "pokemon", *names]
    if not fuzzy:
        args.append("--strict")
    rows = _run(args)
    if isinstance(rows, dict):
        rows = [rows]
    out: dict[str, dict[str, Any]] = {}
    for name, row in zip(names, rows):
        if row.get("error"):
            out[name] = {"found": False, "query": name}
            if row.get("suggestions"):
                out[name]["suggestions"] = row["suggestions"]
        else:
            out[name] = {
                "found": True,
                "name": row.get("name"),
                "display_name": row.get("display_name"),
                "types": row.get("types", []),
                "stats": row.get("stats", {}),
                "abilities": row.get("abilities", []),
                "moves": row.get("moves", []),
                "is_mega": row.get("is_mega", False),
                "base_species": row.get("base_species"),
                "required_item": row.get("required_item"),
            }
            if row.get("resolution"):
                out[name]["resolution"] = row["resolution"]
    return out


def canonicalize_species(team: Any, *, fuzzy: bool = True) -> list[dict[str, Any]]:
    """Rewrite each member's species to dex canonical IN PLACE, fuzzy-tolerant (design §10), and return
    the typo corrections as [{from,to,match_type,score,distance}].

    Auto-corrects a confident-unique typo (garchmp -> Garchomp) and flags it; an exact-alias
    normalization (rotom-wash -> Rotom-Wash) is applied silently (no flag). Ambiguous / unresolved
    species are left verbatim so `validate` still flags them (with did-you-mean suggestions) — the
    correction never guesses. Returns [] if the dex is unavailable (caller degrades honestly)."""
    members = [m for m in getattr(team, "pokemon", []) if getattr(m, "species", "")]
    if not members:
        return []
    facts = lookup_pokemon([m.species for m in members], fuzzy=fuzzy)
    flags: list[dict[str, Any]] = []
    for m in members:
        f = facts.get(m.species) or {}
        if not f.get("found") or not f.get("name") or f["name"] == m.species:
            continue
        if f.get("resolution"):                       # fuzzy typo -> visible flag
            r = f["resolution"]
            flags.append({"from": m.species, "to": f["name"], "match_type": r.get("match_type"),
                          "score": r.get("score"), "distance": r.get("distance")})
        m.species = f["name"]                          # exact-alias or fuzzy -> canonical downstream
    return flags


def lookup_items(names: list[str]) -> dict[str, dict[str, Any]]:
    """Resolve held items against the Champions item pool (dex is the authority).

    Returns query-name -> {found, name, display_name, required_by}. `found` False means the
    item is not in the Champions item pool (illegal to hold). `required_by` lists the Mega
    forms that need this item (non-empty => the item is a Mega stone), so callers can map a
    base species + stone to its Mega form without a second lookup.
    """
    if not names:
        return {}
    # Strict: item legality / Mega-stone mapping are facts — a silent fuzzy correction here would pass an
    # illegal or misspelled item, or feed the calculator the wrong stone. (dex defaults to fuzzy now.)
    rows = _run(["batch", "item", *names, "--strict"])
    if isinstance(rows, dict):
        rows = [rows]
    out: dict[str, dict[str, Any]] = {}
    for name, row in zip(names, rows):
        out[name] = {
            "found": not row.get("error"),
            "name": row.get("name"),
            "display_name": row.get("display_name"),
            "required_by": row.get("required_by", []),
        }
    return out


def lookup_abilities(names: list[str]) -> dict[str, dict[str, Any]]:
    """Resolve ability names (any of the dex's trilingual aliases) to the English canonical.

    Returns query-name -> {found, name}. Used to translate the meta skill's JP/zh ability
    names into the English names the ncp calculator expects.
    """
    if not names:
        return {}
    # Strict: these ability names feed the damage calculator; a silent fuzzy mis-translation would
    # corrupt a damage fact. (dex defaults to fuzzy now.)
    rows = _run(["batch", "ability", *names, "--strict"])
    if isinstance(rows, dict):
        rows = [rows]
    out: dict[str, dict[str, Any]] = {}
    for name, row in zip(names, rows):
        out[name] = {"found": not row.get("error"), "name": row.get("name")}
    return out


def lookup_moves(names: list[str]) -> dict[str, dict[str, Any]]:
    """Resolve moves to dex facts. Returns query-name -> {found, name, type, category, power, priority}.

    Used by offense diagnosis to tell attacking moves (physical/special) from status, get each move's
    type, and judge STAB; `priority` (signed speed-priority stage, 0 == normal) feeds the speed
    landscape so a slower member carrying a priority attacker is surfaced.
    """
    if not names:
        return {}
    # Strict: move type/category/priority drive offense diagnosis facts; no silent correction. (dex
    # defaults to fuzzy now.)
    rows = _run(["batch", "move", *names, "--strict"])
    if isinstance(rows, dict):
        rows = [rows]
    out: dict[str, dict[str, Any]] = {}
    for name, row in zip(names, rows):
        out[name] = {
            "found": not row.get("error"),
            "name": row.get("name"),
            "type": row.get("type"),
            "category": row.get("category"),
            "power": row.get("power"),
            "priority": row.get("priority"),
        }
    return out


if __name__ == "__main__":  # tiny smoke test
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(lookup_pokemon(sys.argv[1:] or ["Garchomp"]), ensure_ascii=False, indent=2))
