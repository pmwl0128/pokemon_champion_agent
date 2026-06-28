#!/usr/bin/env python
"""L3 candidate retrieval — `fill` (design §6 L3 / §13 M3).

Fill a STRUCTURED gap with a candidate POOL, presented in MULTIPLE EXPLICIT ranking VIEWS. The hard
rule (design §0): the skill NEVER emits a composite strength score or a single "best pick". It returns
objective facts + several orderings; the AI weighs and chooses.

Pool = the meta usage list (the viable species), filtered to those that ADDRESS the `need` and respect
owned/avoid/already-on-team. Each candidate carries WHY it matches (resist multiplier / STAB type /
coverage move of a type / role moves it learns / reachable Speed) + the per-view positions:
  - usage              : meta usage rank (the published "most-used" order)
  - co_occurrence      : real-team library teams pairing it with the LOCKED core (synergy fact)
  - tournament_sample  : real-team library appearances (how attested it is)
  - owned              : whether it's in the owned roster (and an owned-only view)

Everything is injectable (dex_fn / ranking_fn / repset_fn) for hermetic tests. No network, no state.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cliffs import champ_speed, SP_CAP  # noqa: E402
from typechart import effectiveness, effectiveness_for_member  # noqa: E402
from diagnose import _ROLE_MOVES, _ROLE_LABELS  # noqa: E402  (reuse the functional-move taxonomy)
import repset  # noqa: E402

POOL_K = 60                       # how deep into the usage ranking we draw the candidate pool from


def _norm(s: str | None) -> str:
    return (s or "").strip().lower()


def _as_list(x: Any) -> list[str]:
    if x is None:
        return []
    return [x] if isinstance(x, str) else list(x)


def _resist_detail(types: list[str], abilities: list[str], atk_type: str) -> dict[str, Any] | None:
    """How (and whether) this species resists `atk_type`, with the BASIS disclosed (audit 2026-06-24):
      - basis="type"    : the type chart already resists (always-on, stable);
      - basis="ability" : only a specific ability gets it under 1.0 (conditional on running THAT ability).
    Returns None if it doesn't resist by any means. We report the basis + which ability so an
    ability-only resist isn't misread as a stable one."""
    type_mult = effectiveness(atk_type, types)
    best, via = type_mult, None
    for ab in (abilities or []):
        m = effectiveness_for_member(types, ab, atk_type)
        if m < best:
            best, via = m, ab
    if best >= 1.0:
        return None
    if type_mult < 1.0:                                  # stable: typing alone resists
        return {"mult": type_mult, "basis": "type", "ability": None}
    return {"mult": best, "basis": "ability", "ability": via}   # only via this ability


def _addresses(need: dict[str, Any], fact: dict[str, Any],
               coverage: dict[str, list[str]] | None = None) -> dict[str, Any] | None:
    """How this candidate addresses each requested need criterion, or None if it fails ANY (AND).
    Objective facts only — never a score. `coverage` (when supplied) maps a dex move-type -> the
    candidate's learnset DAMAGING moves of that type, the bridge that makes `coverage_move_type` real."""
    types = fact.get("types") or []
    abilities = fact.get("abilities") or []
    learn = {_norm(m) for m in (fact.get("moves") or [])}
    base_spe = (fact.get("stats") or {}).get("spe")
    out: dict[str, Any] = {}

    for t in _as_list(need.get("resist")):                       # wants a resist/immunity to type t
        detail = _resist_detail(types, abilities, t)
        if detail is None:
            return None
        out.setdefault("resist", {})[t] = detail

    for t in _as_list(need.get("offense_type")):                 # wants a STAB type t (typing proxy)
        if t not in types:
            return None
        out.setdefault("offense_type", {})[t] = "STAB (typing proxy — actual moveset not checked)"

    # coverage_move_type: wants an ACTUAL damaging move of type t in the learnset (the real coverage
    # check the STAB proxy can't do — e.g. a non-Ice mon that learns Ice Beam). `coverage` is resolved
    # via the dex move->type bridge in `fill()`; matched case-insensitively against the requested type.
    for t in _as_list(need.get("coverage_move_type")):
        hit = next(((ctype, mvs) for ctype, mvs in (coverage or {}).items()
                    if ctype.lower() == t.lower() and mvs), None)
        if hit is None:
            return None
        ctype, mvs = hit
        # STAB vs non-STAB is the value distinction the bare move list hides: a STAB hit is worth FAR
        # more than the nominal 1.5x over a non-STAB coverage move (a core dimension — design §M2, never
        # collapsed to 1.5x), since non-STAB coverage costs a moveslot and only helps vs specific targets.
        # We surface the FACT (stab bool); the AI weighs it (the tool never scores).
        out.setdefault("coverage_move_type", {})[ctype] = {
            "moves": sorted(mvs),
            "stab": any(ctype.lower() == ot.lower() for ot in types),
        }

    for role in _as_list(need.get("role")):                      # wants a functional role
        hits = sorted(m for m in (_ROLE_MOVES.get(role) or set()) if m in learn)
        if not hits:
            return None
        out.setdefault("role", {})[role] = {"label": _ROLE_LABELS.get(role, role), "moves": hits}

    ms = need.get("min_speed")
    if ms is not None:
        if base_spe is None:
            return None
        reach = champ_speed(base_spe, SP_CAP, "Jolly")           # max-Spe +nature line
        if reach < int(ms):
            return None
        out["min_speed"] = {"target": int(ms), "max_reachable": reach}

    return out


def fill(team: dict[str, Any], need: dict[str, Any], *, fmt: str | None = None,
         dex_fn: Callable[[list[str]], dict[str, dict]],
         ranking_fn: Callable[[str | None, int], list[dict]],
         repset_fn: Callable[..., list[dict]] | None = None,
         move_fn: Callable[[list[str]], dict[str, dict]] | None = None,
         season: str | None = None,
         owned: list[str] | None = None, owned_only: bool = False,
         avoid: list[str] | None = None, locked: list[str] | None = None,
         pool_k: int = POOL_K) -> dict[str, Any]:
    """Build the candidate pool for `need` and present it in multiple explicit views (no score)."""
    fmt = (fmt or team.get("format") or "single").lower()
    if not need:
        return {"kind": "fill", "format": fmt, "need": need, "candidates": [], "views": {},
                "notes": ["no `need` given — nothing to fill"], "confidence": "low"}

    on_team = {_norm(m.get("species")) for m in team.get("pokemon", []) if m.get("species")}
    avoid_n = {_norm(a) for a in (avoid or [])}
    owned_n = {_norm(o) for o in (owned or [])}
    core = [s for s in (locked or [m.get("species") for m in team.get("pokemon", [])]) if s]

    # `owned_only` is a HARD constraint (design / project rules): with no owned roster we CANNOT fill
    # from it, so return empty + a warning rather than silently dropping the restriction (audit
    # 2026-06-24 — the old `and owned_n` short-circuit degraded owned_only to an unrestricted pool).
    if owned_only and not owned_n:
        return {"kind": "fill", "format": fmt, "need": need, "candidates": [], "views": {},
                "pool_considered": 0, "candidate_count": 0,
                "notes": ["owned_only is set but no owned roster was provided — cannot fill from owned. "
                          "Pass build-context.owned (or pokemon_owned.md via team_io.read_owned)."],
                "confidence": "low", "confidence_reason": "owned-roster-missing"}

    # Usage ranking — for ranks (a view/fact). When owned_only, the candidate POOL is the OWNED roster
    # itself (not meta∩owned): an owned, gap-filling mon outside the usage top-K must NOT vanish (audit
    # 2026-06-24). Otherwise the pool is the usage top-K (the viable field).
    rows = ranking_fn(fmt, pool_k) or []
    rank_of: dict[str, Any] = {}
    for row in rows:
        nm = row.get("pokemon_en") or row.get("pokemon") or row.get("slug")
        if nm:
            rank_of.setdefault(nm, row.get("rank"))

    pool = list(owned) if owned_only else [r.get("pokemon_en") or r.get("pokemon") or r.get("slug")
                                           for r in rows]
    names = [nm for nm in pool if nm and _norm(nm) not in on_team and _norm(nm) not in avoid_n]

    facts = dex_fn(names) or {}

    # coverage_move_type bridge: resolve each candidate's learnset move NAMES to dex (type, category)
    # ONCE (one batch lookup over the union), then keep only DAMAGING moves -> {dex_type: [moves]} per
    # species. This is what lets the need match a real coverage move, not just the candidate's STAB.
    wants_coverage = bool(_as_list(need.get("coverage_move_type")))
    cov_by_species: dict[str, dict[str, list[str]]] = {}
    if wants_coverage:
        if move_fn is None:
            return {"kind": "fill", "format": fmt, "need": need, "candidates": [], "views": {},
                    "pool_considered": len(names), "candidate_count": 0,
                    "notes": ["coverage_move_type needs the dex move->type bridge (move_fn). cmd_fill "
                              "wires it; an injected fill() must pass move_fn to use this criterion."],
                    "confidence": "low", "confidence_reason": "move-bridge-missing"}
        all_moves = sorted({mv for nm in names for mv in ((facts.get(nm) or {}).get("moves") or [])})
        move_facts = move_fn(all_moves) or {}
        for nm in names:
            cov: dict[str, list[str]] = {}
            for mv in ((facts.get(nm) or {}).get("moves") or []):
                mf = move_facts.get(mv) or {}
                if mf.get("category") in ("Physical", "Special") and mf.get("type"):
                    cov.setdefault(mf["type"], []).append(mv)
            cov_by_species[_norm(nm)] = cov

    # Real-team library (co-occurrence + sample); empty/absent -> those views simply stay 0 (honest).
    teams = []
    if repset_fn is not None:
        try:
            teams = repset_fn(fmt, season=season) or []
        except Exception:
            teams = []
    elif season:
        try:
            teams = repset.load_teams(fmt, season=season)
        except Exception:
            teams = []
    core_n = {_norm(c) for c in core}

    def _counts(species: str) -> tuple[int, int]:
        sample = co = 0
        sp = _norm(species)
        for t in teams:
            members = {_norm(m.get("species")) for m in t.get("pokemon", []) if m.get("species")}
            if sp in members:
                sample += 1
                if core_n and core_n <= members:           # contains the WHOLE locked core too
                    co += 1
        return sample, co

    candidates: list[dict[str, Any]] = []
    for nm in names:
        fact = facts.get(nm) or {}
        if not fact.get("found", True) and "types" not in fact:
            continue
        addresses = _addresses(need, fact, cov_by_species.get(_norm(nm)))
        if addresses is None:
            continue
        sample, co = _counts(nm)
        base_spe = (fact.get("stats") or {}).get("spe")
        candidates.append({
            "species": nm,
            "types": fact.get("types") or [],
            "max_speed": champ_speed(base_spe, SP_CAP, "Jolly") if base_spe is not None else None,
            "addresses": addresses,
            "usage_rank": rank_of.get(nm),
            "co_occurrence": co,
            "tournament_sample": sample,
            "owned": _norm(nm) in owned_n if owned_n else None,
        })

    # Explicit, SEPARATE orderings — never merged into one score (design §0).
    by_usage = [c["species"] for c in sorted(candidates, key=lambda c: (c["usage_rank"] is None, c["usage_rank"] or 1e9))]
    by_cooc = [c["species"] for c in sorted(candidates, key=lambda c: -c["co_occurrence"]) if c["co_occurrence"]]
    by_sample = [c["species"] for c in sorted(candidates, key=lambda c: -c["tournament_sample"]) if c["tournament_sample"]]
    owned_view = [c["species"] for c in candidates if c.get("owned")]

    candidates.sort(key=lambda c: (c["usage_rank"] is None, c["usage_rank"] or 1e9))   # default = usage order (a fact, not advice)

    notes = [
        "Candidate pool = meta usage list filtered to those that ADDRESS the need; NOT the whole dex.",
        "Multiple EXPLICIT views (usage / co_occurrence / tournament_sample / owned) — NO composite "
        "score and NO single best pick (design §0). Default list order is usage rank, a fact not a ranking.",
        "offense_type is a STAB/typing proxy (the candidate's OWN type). coverage_move_type is the real "
        "check: it lists the actual learnset DAMAGING moves of the wanted type (dex move->type bridge), "
        "so a non-STAB coverage move (e.g. Ice Beam on a non-Ice mon) counts — each match flags `stab`. "
        "STAB is worth FAR more than the nominal 1.5x over non-STAB coverage (a core dimension, never "
        "collapsed to 1.5x): non-STAB coverage costs a moveslot and only helps vs specific targets. "
        "Fact only — weigh STAB vs non-STAB accordingly. resist discloses its basis: 'type' (stable) "
        "vs 'ability' (only if it runs that ability).",
    ]
    if owned_only:
        notes.append("owned_only: the pool IS the owned roster (filtered to the need); usage rank is "
                     "just a fact-label and may be null for off-meta owned mons.")
    if not teams:
        notes.append("co_occurrence / tournament_sample are 0 (no real-team library for this format/season).")

    confidence = "low" if not facts else "medium"
    return {
        "kind": "fill", "format": fmt, "need": need,
        "pool_considered": len(names), "candidate_count": len(candidates),
        "candidates": candidates,
        "views": {"usage": by_usage, "co_occurrence": by_cooc,
                  "tournament_sample": by_sample, "owned": owned_view},
        "notes": notes,
        "confidence": confidence, "confidence_reason": "vs-usage-pool",
        "evidence": {"facts": [{"source": "meta", "ref": "usage ranking (candidate pool + usage view)"},
                               {"source": "dex", "ref": "types / stats / abilities / learnset (need match)"},
                               {"source": "real-team", "ref": "co-occurrence + sample (when library present)"}]},
    }


def format_fill_md(d: dict[str, Any]) -> str:
    need = ", ".join(f"{k}={v}" for k, v in (d.get("need") or {}).items()) or "(none)"
    lines = [f"# Fill candidates — need: {need} ({d['format']}) — objective facts, multiple views, unranked"]
    if not d.get("candidates"):
        lines.append("\n_No candidates in the usage pool address this need._")
        return "\n".join(lines + ["", *(f"- {n}" for n in d.get("notes", []))])
    lines.append(f"\n{d['candidate_count']} of {d.get('pool_considered')} pool species address it. "
                 "Views (each a separate ordering, NOT a combined score):")
    for c in d["candidates"]:
        bits = []
        a = c["addresses"]
        if a.get("resist"):
            bits.append("resists " + ", ".join(
                f"{t} {d['mult']:g}x ({'via ' + d['ability'] if d['basis'] == 'ability' else 'typing'})"
                for t, d in a["resist"].items()))
        if a.get("offense_type"):
            bits.append("STAB " + "/".join(a["offense_type"]))
        if a.get("coverage_move_type"):
            bits.append("coverage " + ", ".join(
                f"{t} {'STAB' if d['stab'] else 'non-STAB'} ({', '.join(d['moves'])})"
                for t, d in a["coverage_move_type"].items()))
        if a.get("role"):
            bits.append("; ".join(f"{v['label']} ({', '.join(v['moves'])})" for v in a["role"].values()))
        if a.get("min_speed"):
            bits.append(f"max Spe {a['min_speed']['max_reachable']} ≥ {a['min_speed']['target']}")
        own = " [owned]" if c.get("owned") else ""
        lines.append(f"- **{c['species']}** ({'/'.join(c['types']) or '?'}){own}: " + "; ".join(bits)
                     + f"  — usage #{c['usage_rank']}, co-occ {c['co_occurrence']}, sample {c['tournament_sample']}")
    lines += ["", "Views:"]
    for v, order in d["views"].items():
        if order:
            lines.append(f"- {v}: {', '.join(order[:8])}")
    lines += ["", *(f"> {n}" for n in d.get("notes", []))]
    return "\n".join(lines)
