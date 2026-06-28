#!/usr/bin/env python
"""Provenance-aware opponent-set resolver: real-team JOINT set first, meta marginals as fallback.

The accuracy ranking (discussed 2026-06-22) is: a REAL team's joint {ability,item,nature,moves}
beats meta's independent marginals (no §10 stitch) and can be skill-segmented. Some real teams
(Limitless doubles) carry NO spread, so for those the SP/spread still comes from meta; sources that
DO expose a spread (yakkun singles) supply a real co-occurring spread. So the resolved opponent set
is a per-field MERGE:

    ability / item / nature / moves  <- real-team representative set (when sample is sufficient)
    sps (spread)                     <- real-team modal spread when the source carries one (yakkun
                                        singles — co-occurs with the set); else meta modal (the only
                                        spread for Limitless doubles)
    fallback (no real-team data)     <- meta modal set as-is (today's behaviour)
    fallback (no meta either)        <- None (caller's synthetic max-offense path handles it)

Every result carries its per-field provenance + confidence; this never emits a strength score, and
single/double are never mixed (repset is loaded per format with the current season).

Consumers (matchup / tune) inject `resolve_opponent_set` instead of calling metalink directly, so
they upgrade automatically once the real-team library is populated — with an empty library the
result is byte-identical to the meta path, which is exactly how the no-real-data case stays stable.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parent))
import repset  # noqa: E402
from metalink import canonical_attacker_set, canonical_attacker_sets  # noqa: E402

_CONF_ORDER = {"low": 0, "medium": 1, "high": 2}


def _cap(conf: str, ceiling: str) -> str:
    """The lower of two confidence levels."""
    return conf if _CONF_ORDER.get(conf, 0) <= _CONF_ORDER.get(ceiling, 0) else ceiling


def _merge_set(species: str, rep: dict | None, meta: dict | None,
               run_form: str | None = None) -> dict[str, Any] | None:
    """Per-field merge: real-team JOINT {ability,item,nature,moves} + a SPREAD whose origin depends on
    the source. yakkun singles carry a real co-occurring spread (rep['sps']); Limitless doubles don't,
    so their spread is the meta modal (a marginal stitched on). Shared by the single and batch
    resolvers. With no real-team data -> meta as-is (byte-identical to the pre-resolver behaviour, so
    the system stays stable on an empty library)."""
    if not rep:
        return meta

    rep_sps = rep.get("sps") or {}
    if rep_sps:
        # The spread is part of the SAME real joint set (it co-occurs with the modal ability/item/
        # nature/moves), so the marginal-stitch cap does NOT apply — keep repset's sample/share conf.
        sps = rep_sps
        conf = rep["confidence"]
        spread_origin = rep.get("spread_origin") or "real-team"
        source = "real-team"
        spread_prov = f"real-team modal joint (co-occurs with the set; {rep['count']}/{rep['sample']})"
        spread_note = " | spread from the same real-team joint set (co-occurs — confidence not capped)"
    else:
        # No real spread (Limitless doubles): the rep fields are a real joint object, but the SPREAD is
        # only a meta MARGINAL stitched on — not verified to co-occur with that real set. So cap the
        # whole set's confidence at `medium` when the spread is meta-derived (a high-sample real core
        # doesn't make the stitched spread certain; audit 2026-06-24). No spread at all -> low.
        sps = (meta or {}).get("sps") or {}
        has_meta_spread = bool(sps)
        conf = _cap(rep["confidence"], "medium") if has_meta_spread else "low"
        spread_origin = "usage" if has_meta_spread else None
        source = "real-team+meta-spread" if has_meta_spread else "real-team (no spread)"
        spread_prov = ("meta modal (marginal — not verified to co-occur)" if has_meta_spread
                       else "unavailable (no meta spread)")
        spread_note = (" | spread from meta modal (marginal stitch — confidence capped)" if has_meta_spread
                       else " | no meta spread available — spread unknown")
    # them->us THREAT surface must stay BROAD: the real-team JOINT set is ONE build, so using its 4
    # moves as the threat list would MISS moves other variants run (research 2026-06-24 — real-team
    # marginals ~= meta's, but a single joint set under-covers the threat space; defense stays
    # conservative). Keep the meta >=15% damaging surface and union in any real-team joint move not
    # already there. `moves` = what the modal set RUNS (joint); `threat_moves` = what it can HIT with.
    meta_moves = [m for m in ((meta or {}).get("moves") or []) if isinstance(m, dict)]
    meta_move_names = {m.get("name") for m in meta_moves}
    threat_moves = list(meta_moves) + [{"name": mv, "pct": None}
                                       for mv in (rep["moves"] or []) if mv not in meta_move_names]
    return {
        "species": species,
        # The form actually RUN, when it differs from the meta label: singles rank a Mega under the base
        # name ('Staraptor') but the library stores 'Mega Staraptor', so the real set is the Mega's and
        # consumers must use the Mega's stats/types (audit 2026-06-25). None when there is no remap.
        "run_form": run_form if (run_form and run_form != species) else None,
        "ability": rep["ability"], "item": rep["item"], "nature": rep["nature"],
        "moves": rep["moves"],                        # the real co-occurring set (what it RUNS)
        "threat_moves": threat_moves,                 # broad meta surface U joint (what it can HIT with)
        "sps": sps,                                   # real co-occurring spread (yakkun) or meta modal
        "confidence": conf,
        "prevalence": (meta or {}).get("prevalence", 0.5),
        "prevalence_basis": (meta or {}).get("prevalence_basis", "real-team set (no meta usage)"),
        "source": source,
        "provenance": {
            "set_fields": f"real-team modal joint {rep['count']}/{rep['sample']} "
                          f"(share {rep.get('share')}, {rep['confidence']})",
            "spread": spread_prov,
            "spread_origin": spread_origin,
        },
        "note": rep["note"] + spread_note,
    }


def _rep_for(species: str, fmt: str, season: str | None,
             repset_fn: Callable[..., dict | None] | None) -> tuple[dict | None, str]:
    """(representative set, run_form). On the real path the meta name is first resolved to the form it is
    actually run as (`repset.dominant_form`) — a singles Mega is ranked under the base name but stored as
    'Mega X', so a base name like 'Staraptor' must query 'Mega Staraptor' or it falsely reads as having
    no real data (audit 2026-06-25). An injected repset_fn (tests) controls its own scoping/naming, so
    no remap is applied there. Returns run_form == species when there is no remap."""
    # season=None propagated to repset reads EVERY season's file (cross-regulation pollution). The guard
    # sits on the real-library path only; an injected repset_fn controls its own scoping (audit 2026-06-23).
    if repset_fn is None:
        if not season:
            raise ValueError("an explicit season is required for the real-team library "
                             "(season=None would read every season -> cross-regulation pollution)")
        run_form = repset.dominant_form(species, fmt, season=season)
        fn = repset.representative_set
    else:
        run_form = species
        fn = repset_fn
    # NARROW catch: an absent library already returns []/None without raising (repset.load_teams), so the
    # only expected throws here are a corrupt/unreadable library file — fall back to meta for those. A
    # code bug (KeyError/TypeError/...) MUST propagate, not masquerade as an empty library (audit 2026-06-25).
    try:
        return fn(run_form, fmt, season=season), run_form
    except (OSError, json.JSONDecodeError):
        return None, run_form


def resolve_opponent_set(species: str, fmt: str | None, *, season: str | None = None,
                         repset_fn: Callable[..., dict | None] | None = None,
                         meta_fn: Callable[..., dict | None] = canonical_attacker_set
                         ) -> dict[str, Any] | None:
    """Resolve ONE opponent's set: real-team joint set ⊕ meta spread. repset_fn/meta_fn injectable for
    tests. Returns None only when BOTH sources are empty."""
    if not fmt:
        raise ValueError("resolve_opponent_set requires an explicit format (no single/double default)")
    rep, run_form = _rep_for(species, fmt, season, repset_fn)
    try:
        meta = meta_fn(species, fmt)              # meta ranks under the META name (the base for a Mega)
    except Exception:
        meta = None
    return _merge_set(species, rep, meta, run_form=run_form)


def resolve_opponent_sets(species_list: list[str], fmt: str | None, *, season: str | None = None,
                          repset_fn: Callable[..., dict | None] | None = None,
                          meta_batch_fn: Callable[..., dict] = canonical_attacker_sets
                          ) -> dict[str, dict | None]:
    """BATCH resolver (matchup's injection point): one batched meta call for ALL species + a per-species
    real-team read, merged per field. Same result as calling resolve_opponent_set per species, but the
    meta side is a single sibling call instead of N (the prerequisite for wiring matchup without
    degrading to N subprocesses — handoff §5.1). Empty real-team library -> byte-identical to the meta
    batch path."""
    if not fmt:
        raise ValueError("resolve_opponent_sets requires an explicit format (no single/double default)")
    names = list(species_list)
    try:
        metas = meta_batch_fn(names, fmt) or {}
    except Exception:
        metas = {}
    def _resolve(sp: str) -> dict | None:
        rep, run_form = _rep_for(sp, fmt, season, repset_fn)
        return _merge_set(sp, rep, metas.get(sp), run_form=run_form)
    return {sp: _resolve(sp) for sp in names}
