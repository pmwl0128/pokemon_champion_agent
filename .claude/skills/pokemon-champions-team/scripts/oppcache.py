#!/usr/bin/env python
"""Opponent standard-set matchup CACHE (M5 step 2; design §9/§10).

A precomputed grid of how the meta top-K's STANDARD sets interact — attacker i's hardest move vs
defender j's standard set, plus the modal speed line, for every ordered pair. It is a fast REFERENCE
("how do the standard meta builds trade?"), NOT the user's own matchup: a real team is always matched
LIVE via matchup.py against its ACTUAL sets. So the whole cache is stamped `low` confidence
(reason=`vs-standard-set`) — every cell is a standard-vs-standard fact, never the user's real board.

This module holds NO battle data. It (a) READS the shipped cache JSON and (b) provides the PURE
`build_matrix` the dev builder (`dev/update/team/cache.py`) calls with injected sibling functions —
the fact-shaping (KO buckets, speed line) lives here so it ships and is unit-tested in the skill,
while the dev side only fetches + writes.

Design discipline (mirrors matchup.py / repset.py):
- FACTS ONLY. No matchup score, no ranking of species, no "best" anything (design §0).
- ATTACKER ROWS ONLY FOR REAL-TEAM-BACKED SPECIES (design §10/§15 Q5): a meta-only species has no
  REAL co-occurring 4-move set (meta gives independent marginals — stitching them is the §10 trap ①
  forbidden move), so it cannot be an attacker. It CAN be a defender (being hit needs only its bulk:
  ability/item/nature/spread, which the meta modal supplies). This is the literal "build a cell only
  for species clearing MIN_SAMPLE" — the MIN_SAMPLE gate sits in repset and decides who is an attacker.
- Single/double NEVER mixed (one cache file per format, built per season).
- Time-validity follows the environment (design §9): the cache serves the CURRENT env only, carries a
  light `built_for` for rebuild/debug, and is rebuilt by dev/update on a base refresh — readers assume
  it is current and do NOT version-check at query time.
"""
from __future__ import annotations

import json
import os
from math import ceil
from pathlib import Path
from typing import Any, Callable

# Disguise (Mimikyu) breaks on the first damaging hit: it blocks that hit ENTIRELY (0 dmg) and Mimikyu
# loses 1/8 max HP, dropping to this fraction (Busted form, rest of battle). The effective KO is then
# 1 blocked turn + the turns to remove this remaining HP at the move's per-turn band.
_DISGUISE_REMAINING_PCT = 87.5

SCRIPTS = Path(__file__).resolve().parent
DEFAULT_CACHE = SCRIPTS.parent / "data" / "opponent_cache"   # ships WITH a snapshot (tracked)

CONFIDENCE = "low"                 # every cell is standard-vs-standard, never the user's real board
CONFIDENCE_REASON = "vs-standard-set"
_NEG_SPE_NATURES = {"Brave", "Relaxed", "Quiet", "Sassy"}   # -Speed modal: a fast variant is unrealistic


# --- read side ---------------------------------------------------------------

def cache_dir() -> Path:
    """The opponent-cache dir (CHAMP_OPPCACHE overrides, for the dev builder + tests)."""
    return Path(os.environ.get("CHAMP_OPPCACHE", DEFAULT_CACHE))


def cache_path(fmt: str, season: str) -> Path:
    return cache_dir() / f"{season}_{fmt}.json"


def load_cache(fmt: str, season: str) -> dict[str, Any] | None:
    """The cached matrix for a (season, format), or None when it has not been built/shipped."""
    p = cache_path(fmt, season)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def attacker_row(cache: dict[str, Any], attacker: str) -> dict[str, Any] | None:
    """The attacker's row (its standard set + every defender cell), or None if it has no row (a
    meta-only species is never an attacker — see module docstring)."""
    cell_row = (cache.get("matrix") or {}).get(attacker)
    if cell_row is None:
        return None
    return {"attacker": attacker, "set": (cache.get("sets") or {}).get(attacker),
            "cells": cell_row}


def cell(cache: dict[str, Any], attacker: str, defender: str) -> dict[str, Any] | None:
    """One ordered (attacker -> defender) cell, or None when the pair is not in the matrix."""
    return ((cache.get("matrix") or {}).get(attacker) or {}).get(defender)


# --- pure builder (shared by the dev builder; injectable for tests) ----------

def _ncp(species: str, s: dict[str, Any]) -> dict[str, Any]:
    """An ncp pokemon dict from a resolved standard set. The ncp NAME (stats/types basis) is the form
    actually RUN: for a singles Mega the matrix key is the meta base name ('Staraptor') but `run_form`
    is 'Mega Staraptor', so the calc must use the Mega's stats (audit 2026-06-25)."""
    return {"name": s.get("run_form") or s.get("species") or species,
            "ability": s.get("ability"), "item": s.get("item"),
            "nature": s.get("nature"), "sps": s.get("sps") or {}}


def _disguise_adjust(off: dict[str, Any]) -> dict[str, Any]:
    """Effective KO vs a DISGUISED Mimikyu. Disguise BLOCKS the first damaging move entirely (0 dmg) and
    breaks, costing Mimikyu 1/8 max HP (→ ~87.5% HP, Busted form). So a naive "+1 hit" is WRONG: a hit
    big enough that the 1/8 chip + one real hit already KOs needs FEWER turns than nominal+1 (e.g. a 90%
    move is a real 2-turn KO, not 3), and a weak move can land on the nominal count. The honest model is
    `1 blocked turn + ceil(remaining 87.5% / per-turn damage band)`.

    NARROW labelling exception keyed on ability=Disguise (Mimikyu's whole value), computed from the
    nominal band at the cache layer — NOT a general recompute of one-time-survive effects into the calc,
    which design §7 deliberately rejects (Sash/Sturdy/... would all follow → re-simulating the engine).
    Assumes Mimikyu starts disguised (true at the start of an engagement — the standard-set cell case).
    The raw `ko`/`ko_chance` ignore Disguise and OVERSTATE; read this vs Mimikyu instead."""
    def turns(p: Any) -> int | None:                 # 1 blocked turn + turns to remove the remaining HP
        return (1 + ceil(_DISGUISE_REMAINING_PCT / p)) if (p and p > 0) else None
    return {
        "effective_ko_possible": turns(off.get("max_percent")),      # best roll (fewest turns)
        "effective_ko_guaranteed": turns(off.get("min_percent")),    # worst roll (most turns)
        "note": "Disguise BLOCKS the first damaging move entirely (0 dmg) and breaks — Mimikyu loses "
                "1/8 max HP (→ ~87.5% HP, Busted form rest of battle). Effective KO = 1 blocked turn + "
                "turns to remove the remaining 87.5% at the band above. NOT nominal+1 (a hard hit + the "
                "1/8 chip can KO sooner). The raw ko/ko_chance ignore Disguise and overstate.",
    }


def build_matrix(sets: dict[str, dict[str, Any]], dex_facts: dict[str, dict[str, Any]],
                 attackers: set[str] | list[str], rows: list[dict[str, Any]], *,
                 fmt: str, season: str, rule: str, built_at: str,
                 damage_fn: Callable[[list[dict[str, Any]]], list[dict[str, Any]]],
                 dmg_fact_fn: Callable[..., dict[str, Any]] | None = None,
                 speed_fn: Callable[..., int | None] | None = None) -> dict[str, Any]:
    """Build the standard-vs-standard matchup matrix. PURE given its injected sibling functions.

    `sets`     = {species: resolved standard set} (sources.resolve_opponent_set output; ability/item/
                 nature/sps for every defender, plus a real `moves` list for real-team-backed species).
    `dex_facts`= {species: {stats:{spe}, types}} for the speed line.
    `attackers`= the species that get an OFFENSE row — exactly the real-team-backed ones (repset
                 returned a set, i.e. sample >= MIN_SAMPLE). Meta-only species appear as defenders only.
    `rows`     = the meta usage ranking rows ({rank, species}), in order — fixes the species order and
                 carries the usage rank as a provenance fact.
    Cells carry the attacker's hardest move (by max roll) vs the defender + the modal speed line. Every
    cell is `low` confidence (reason=`vs-standard-set`); the flag sits once at the top level."""
    from matchup import _dmg_fact as _default_dmg_fact   # reuse the KO-bucket / multi-hit logic
    from cliffs import effective_speed as _default_speed, SP_CAP, SPEED_ITEM_MULT
    dmg_fact_fn = dmg_fact_fn or _default_dmg_fact
    speed_fn = speed_fn or _default_speed
    attackers = set(attackers)

    ordered = [r for r in rows if (r.get("species") or r.get("pokemon_en")) in sets]
    species = [r.get("species") or r.get("pokemon_en") for r in ordered]
    sp_set = set(species)

    def base_spe(sp: str) -> int | None:
        return ((dex_facts.get(sp, {}) or {}).get("stats") or {}).get("spe")

    def spd(sp: str) -> int | None:
        s = sets.get(sp) or {}
        return speed_fn(base_spe(sp), int((s.get("sps") or {}).get("sp") or 0),
                        s.get("nature"), item=s.get("item"))

    def fast_spd(sp: str, modal: int | None) -> int | None:
        """Worst-case FAST variant of a defender (§16.5, mirrors matchup): max-Spe SP + a speed nature,
        x1.5 if the modal set runs Choice Scarf. So a slow MODAL line doesn't hide that the species CAN
        run faster. Skipped (== modal) for a -Spe modal (Trick Room / slow build) or unknown base."""
        s = sets.get(sp) or {}
        base = base_spe(sp)
        if base is None or modal is None or s.get("nature") in _NEG_SPE_NATURES:
            return modal
        scarf = s.get("item") if (s.get("item") in SPEED_ITEM_MULT) else None
        return max(modal, speed_fn(base, SP_CAP, "Jolly", item=scarf))

    speeds = {sp: spd(sp) for sp in species}
    fast_speeds = {sp: fast_spd(sp, speeds[sp]) for sp in species}

    # ONE batched ncp call for the whole matrix: every (attacker-move, defender) request, indexed.
    index: dict[tuple[str, str, str], int] = {}
    requests: list[dict[str, Any]] = []
    for ai in species:
        if ai not in attackers:
            continue
        atk = _ncp(ai, sets[ai])
        for dj in species:
            if dj == ai:
                continue
            dfd = _ncp(dj, sets[dj])
            for mv in (sets[ai].get("moves") or []):
                if not mv:
                    continue
                index[(ai, dj, mv)] = len(requests)
                requests.append({"attacker": atk, "defender": dfd, "move": mv})
    results = damage_fn(requests) if requests else []

    def best_offense(ai: str, dj: str) -> dict[str, Any] | None:
        best_r = best_mv = None
        for mv in (sets[ai].get("moves") or []):
            idx = index.get((ai, dj, mv))
            if idx is None or idx >= len(results):
                continue
            r = results[idx] or {}
            if r.get("error") or r.get("maxPercent") is None:
                continue
            if best_r is None or r["maxPercent"] > best_r["maxPercent"]:
                best_r, best_mv = r, mv
        return dmg_fact_fn(best_mv, best_r) if best_r else None

    matrix: dict[str, dict[str, Any]] = {}
    for ai in species:
        if ai not in attackers:
            continue
        cells: dict[str, Any] = {}
        for dj in species:
            if dj == ai:
                continue
            a_spe, d_spe = speeds.get(ai), speeds.get(dj)
            faster = None
            if a_spe is not None and d_spe is not None:
                faster = "attacker" if a_spe > d_spe else "defender" if a_spe < d_spe else "tie"
            off = best_offense(ai, dj)
            # Disguise backdoor: a Mimikyu defender eats the first hit, so annotate the effective KO
            # (design §7 boundary: label it, don't recompute the whole engine — see _disguise_adjust).
            if off and (sets.get(dj) or {}).get("ability") == "Disguise":
                off["disguise_adjusted"] = _disguise_adjust(off)
            d_fast = fast_speeds.get(dj)
            cells[dj] = {
                "offense": off,
                # `defender_fast` = the defender's worst-case fast variant (§16.5); `fast_flips` marks the
                # multi-peak a single modal point hides: attacker outspeeds the modal but NOT the fast build.
                "speed": {"attacker": a_spe, "defender": d_spe, "defender_fast": d_fast, "faster": faster,
                          "fast_flips": bool(a_spe is not None and d_spe is not None and d_fast is not None
                                             and a_spe > d_spe and a_spe <= d_fast)},
            }
        matrix[ai] = cells

    sets_out = {sp: _set_provenance(sp, sets[sp], sp in attackers) for sp in species}

    def _row(r: dict[str, Any]) -> dict[str, Any]:
        name = r.get("species") or r.get("pokemon_en")
        s = sets.get(name) or {}
        out = {"rank": r.get("rank"), "species": name, "real_team_backed": name in attackers,
               "set_source": s.get("source"), "set_confidence": s.get("confidence")}
        if s.get("run_form"):                  # transparent: ranked under the base, run as the Mega
            out["run_form"] = s["run_form"]
        return out

    species_rows = [_row(r) for r in ordered]
    return {
        "kind": "opponent-cache",
        "built_for": {"season": season, "rule": rule, "format": fmt,
                      "built_at": built_at, "top_k": len(species)},
        "species": species_rows,
        "sets": sets_out,
        "matrix": matrix,
        "confidence": CONFIDENCE,
        "confidence_reason": CONFIDENCE_REASON,
        "notes": [
            f"{fmt}: standard-set vs standard-set matchup grid over the meta top-{len(species)} "
            "(usage ranking). Objective facts only — no matchup score, no ranking, no best pick "
            "(design §0). This is a REFERENCE grid, not your team: match your real team LIVE.",
            "ATTACKER rows exist ONLY for real-team-backed species (a real co-occurring 4-move set, "
            "sample >= MIN_SAMPLE). A meta-only species has no real joint move set (meta marginals "
            "can't be stitched into one — design §10 trap ①), so it appears as a DEFENDER only.",
            "offense = the attacker's hardest move (by max roll) vs the defender's standard set: full "
            "roll band + ko_possible (best roll) / ko_guaranteed (worst roll). ONLY OHKO is exact; any "
            "2+ turn KO is a static approximation (see ko_caveat). speed = modal speed line "
            "(Choice Scarf applied), faster = attacker/defender/tie at MODAL; defender_fast = the "
            "defender's worst-case fast variant (max Spe + speed nature, x1.5 if Choice Scarf, §16.5) "
            "and fast_flips marks where the attacker beats the modal but loses to that fast build.",
            f"EVERY cell is {CONFIDENCE} confidence (reason={CONFIDENCE_REASON}): these are STANDARD "
            "sets, not the opponents' actual builds nor yours. The defender's spread/ability/item are "
            "the resolved standard set (real-team co-occurring for backed species, else meta modal).",
            "Time-validity follows the environment (design §9): rebuilt by dev/update on a base "
            "refresh; readers assume it is current and do not version-check.",
        ],
    }


def _set_provenance(species: str, s: dict[str, Any], real_team_backed: bool) -> dict[str, Any]:
    """The standard set as stored in the cache — the fields a reader needs to interpret a cell. `species`
    is the matrix key (the meta label); `run_form` is the form actually run when it differs (a singles
    Mega ranked under the base name) — the calc used the run form's stats, so it is surfaced here."""
    return {
        "species": s.get("species") or species,
        "run_form": s.get("run_form"),
        "ability": s.get("ability"), "item": s.get("item"), "nature": s.get("nature"),
        "moves": s.get("moves") if real_team_backed else None,   # real joint set only for attackers
        "sps": s.get("sps") or None,
        "source": s.get("source"),
        "confidence": s.get("confidence"),
        "real_team_backed": real_team_backed,
        "note": s.get("note"),
    }


# --- markdown formatter ------------------------------------------------------

def _ko(off: dict[str, Any] | None) -> str:
    if not off:
        return "—"
    txt = f"{off['move']} {off['min_percent']}–{off['max_percent']}%"
    txt += f" ({off['ko']})" if off.get("ko") else ""
    da = off.get("disguise_adjusted")
    if da:
        eff = da.get("effective_ko_guaranteed") or da.get("effective_ko_possible")
        txt += f" [Disguise: ~{eff} hits effective]" if eff else " [Disguise: +1 hit effective]"
    return txt


def format_oppcache_md(cache: dict[str, Any], attacker: str | None = None,
                       defender: str | None = None) -> str:
    bf = cache.get("built_for", {})
    head = (f"# Opponent standard-set matrix ({bf.get('format')}) — top-{bf.get('top_k')}, "
            f"{cache.get('confidence')} confidence ({cache.get('confidence_reason')}); facts, not a score")
    lines = [head, f"_built_for {bf.get('season')}/{bf.get('rule')} @ {bf.get('built_at')} — "
             "standard-vs-standard reference; match your real team live._\n"]
    matrix = cache.get("matrix") or {}
    sets = cache.get("sets") or {}

    def one_attacker(ai: str) -> list[str]:
        row = matrix.get(ai)
        if row is None:
            s = sets.get(ai) or {}
            why = ("not real-team-backed (meta-only — no real joint move set, defender only)"
                   if s else "not in the cached top-K")
            return [f"## {ai}\n- no attacker row: {why}."]
        s = sets.get(ai) or {}
        out = [f"## {ai} — {s.get('item')} / {s.get('ability')} / {s.get('nature')} "
               f"(set {s.get('confidence')}, {s.get('source')})",
               f"  - moves: {', '.join(s.get('moves') or []) or '—'}"]
        items = [(defender, row.get(defender))] if defender else sorted(row.items())
        for dj, c in items:
            if c is None:
                out.append(f"- vs **{dj}**: not in matrix")
                continue
            sp = c["speed"]
            arrow = {"attacker": "outspeeds", "defender": "slower than",
                     "tie": "speed-ties"}.get(sp.get("faster"), "speed ?")
            out.append(f"- vs **{dj}**: {arrow} ({sp.get('attacker')} vs {sp.get('defender')}); "
                       f"we→them: {_ko(c.get('offense'))}")
        return out

    if attacker:
        lines += one_attacker(attacker)
    else:
        for ai in matrix:
            lines += one_attacker(ai)
    if not matrix:
        lines.append("\n(empty matrix — no real-team-backed attacker in the current library.)")
    return "\n".join(lines)
