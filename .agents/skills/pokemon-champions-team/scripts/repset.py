#!/usr/bin/env python
"""Representative-set reader over the real-team library (data/teams/<season>_<format>.jsonl).

Real teams are REAL JOINT objects: each member's ability/item/nature/moves co-occur, which the meta
usage panels (independent marginals) cannot give — so this is the higher-accuracy source for those
fields and the cure for the marginal-stitch problem (design §10/§16.1). When the library is empty
for a format (e.g. singles before a usable source exists), every function returns None/[] and the
resolver falls back to meta: the system stays stable with no real data.

Boundaries (design §16.1 / dev §8):
- FACTS ONLY. `count`/`sample`/`share` and the performance tags (placing/record/rating) are
  provenance, never a synthetic strength score.
- NEVER merged across single/double (different metagames) — keyed by format, loaded per format.
- The SP/spread dimension is carried per source: yakkun singles pages DO expose a real Champions SP
  spread, so `sps` is the modal spread AMONG the teams running the modal set (it co-occurs — not a
  marginal stitch). Sources without a spread (Limitless doubles decklists) yield `sps: None` and the
  resolver falls back to the meta spread. Never invent a spread.

This module holds NO battle data — only the reader/aggregator over the dev-built library.
"""
from __future__ import annotations

import json
import os
from collections import Counter
from pathlib import Path
from typing import Any

SCRIPTS = Path(__file__).resolve().parent
DEFAULT_DATA = SCRIPTS.parent / "data" / "teams"   # ships WITH a snapshot (tracked); maintainer refreshes via dev/update/team

# --------------------------------------------------------------------------- #
# Sample-sufficiency criteria (design §15 Q5 — the M5 trigger, resolved 2026-06-25).
#
# The bar is PER SPECIES (and per archetype cluster), not a single per-format gate: the doubles
# library (2879 teams, 96 species at >=10 occurrences) and the singles library (44 teams, only 5
# species at >=10) have wildly different per-species density, so a global "is the format ready" switch
# would either starve singles or trust noise. Instead every representative set is emitted only when its
# own sample clears MIN_SAMPLE, and confidence is folded from BOTH sample size and modal share — a
# thin or fragmented species reads `low`, never silently masquerading as solid. The future cache layer
# (M5 step 2, design §9) builds a cell ONLY for species clearing MIN_SAMPLE and stamps every cell
# `low` (reason=vs-standard-set) regardless, so this same per-species bar governs cache admission.
# --------------------------------------------------------------------------- #
# A species/archetype seen in fewer than this many real teams is too thin to trust as
# "representative" — the resolver falls back to meta below it. Tunable; deliberately conservative for
# early M-B samples.
MIN_SAMPLE = 3
# Up to this many (item, ability) archetypes are surfaced per species (design §10 trap ②). A species
# often runs genuinely distinct builds; collapsing to one global modal hides that bimodality.
MAX_CLUSTERS = 3
# Sample-size -> confidence (crude tiers, honest about small samples; not a Wilson interval because
# we are choosing a modal set, not estimating a win rate).
_CONF_TIERS = ((10, "high"), (5, "medium"), (MIN_SAMPLE, "low"))

# team-json/smogon spread keys -> ncp SP keys, so a real-team spread is emitted in the SAME shape as a
# meta `sps` (mirrors metalink.SPREAD_TO_SPS) and consumers (matchup/tune) treat both interchangeably.
_SPS_KEYS = {"hp": "hp", "atk": "at", "def": "df", "spa": "sa", "spd": "sd", "spe": "sp"}
_TEMPLATE_COMPLETENESS = "observed_full_set"


def data_dir() -> Path:
    """The real-team library dir (CHAMP_TEAM_DATA overrides, matching the dev pipeline)."""
    return Path(os.environ.get("CHAMP_TEAM_DATA", DEFAULT_DATA))


def load_teams(fmt: str, season: str | None = None) -> list[dict[str, Any]]:
    """All stored teams for a format (optionally one season). [] when the library is absent/empty.

    season=None reads every season's file for the format — callers that must not mix regulations
    pass the current season explicitly (the resolver does)."""
    d = data_dir()
    if not d.exists():
        return []
    pattern = f"{season}_{fmt}.jsonl" if season else f"*_{fmt}.jsonl"
    teams: list[dict[str, Any]] = []
    for jf in sorted(d.glob(pattern)):
        for line in jf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line:
                teams.append(json.loads(line))
    return teams


_CONF_ORDER = {"low": 0, "medium": 1, "high": 2}


def _confidence(sample: int, share: float = 1.0) -> str:
    """Confidence from BOTH the sample size AND the modal share. A heavily-fragmented modal — e.g. 10
    distinct sets where the top one is only 1/10 (share 0.1) — is NOT representative even with a large
    sample, so it can't read 'high' on sample count alone (audit 2026-06-24). Take the lower of the
    sample tier and the share tier."""
    s_tier = "low"
    for thr, lvl in _CONF_TIERS:
        if sample >= thr:
            s_tier = lvl
            break
    sh_tier = "high" if share >= 0.5 else "medium" if share >= 0.34 else "low"
    return s_tier if _CONF_ORDER[s_tier] <= _CONF_ORDER[sh_tier] else sh_tier


def _modal_spread(members: list[dict[str, Any]]) -> tuple[dict[str, int] | None, int]:
    """Modal SP spread (ncp keys) among `members`, with its count; (None, 0) when none carry a spread.
    Called only on the teams running the modal joint set, so the chosen spread co-occurs with that set
    (not a marginal). Members with no spread (Limitless doubles) are skipped."""
    spreads = [m.get("spread") for m in members if m.get("spread")]
    if not spreads:
        return None, 0
    top, cnt = Counter(tuple(sorted(s.items())) for s in spreads).most_common(1)[0]
    sps = {_SPS_KEYS[k]: int(v) for k, v in top if k in _SPS_KEYS}
    return (sps or None), cnt


def _joint_key(m: dict[str, Any]) -> tuple:
    """A member's full REAL JOINT identity: ability+item+nature+sorted moves co-occur (no stitch)."""
    return (m.get("ability"), m.get("item"), m.get("nature"),
            tuple(sorted(mv for mv in (m.get("moves") or []) if mv)))


def _team_has_item(team: dict[str, Any]) -> bool:
    """True if ANY member of `team` carries an item — i.e. the source actually captured item data for
    this team. Used to tell an INTENTIONAL itemless set (a member with no item on a team that DID record
    items elsewhere — e.g. an Acrobatics/Unburden user) from a team whose items were simply never
    scraped (every member itemless)."""
    return any(m.get("item") for m in team.get("pokemon", []))


def _template_eligible_member(m: dict[str, Any], *, team_has_item: bool) -> bool:
    """True when a member has enough observed fields to build a representative set template.

    `completeness` is a source-level claim; this also checks the actual fields so mislabeled or
    species-only rows cannot inflate samples or emit empty/None modal sets. Spread is intentionally
    optional because Limitless doubles has real joint ability/item/nature/moves but no SP spread.

    `item` is held to a FINER rule than a bare non-null check (audit 2026-06-26): a member with no item
    is still a complete set when its team carries items elsewhere (a deliberate no-item build like
    Acrobatics Talonflame — losing those silently under-counts a real archetype), but when the WHOLE team
    is itemless the items were never captured, so its members are not template-eligible. `team_has_item`
    carries that team-level signal from `_team_has_item`.
    """
    moves = [mv for mv in (m.get("moves") or []) if mv]
    return (
        m.get("completeness") == _TEMPLATE_COMPLETENESS
        and bool(m.get("species"))
        and bool(m.get("ability"))
        and bool(m.get("nature"))
        and bool(moves)
        and (bool(m.get("item")) or team_has_item)
    )


def _members_of(species: str, teams: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for t in teams:
        thi = _team_has_item(t)
        out.extend(m for m in t.get("pokemon", [])
                   if m.get("species") == species and _template_eligible_member(m, team_has_item=thi))
    return out


def _build_modal_set(species: str, fmt: str, members: list[dict[str, Any]]) -> dict[str, Any]:
    """Modal joint set over `members`, with share/confidence denominated by len(members). Reused by the
    global-modal path (members = ALL of the species) and the per-cluster path (members = one cluster),
    so a cluster's `share`/`confidence` reflect the archetype's own density. Assumes members non-empty."""
    sample = len(members)
    counts = Counter(_joint_key(m) for m in members)
    top_key, cnt = counts.most_common(1)[0]
    ability, item, nature, moves = top_key
    # Spread is taken ONLY over the teams running this exact set, so it co-occurs with it (real joint).
    winners = [m for m in members if _joint_key(m) == top_key]
    sps, spread_cnt = _modal_spread(winners)
    spread_note = (f"spread co-occurs (modal {spread_cnt}/{len(winners)} of the set)." if sps
                   else "spread not in source.")
    return {
        "species": species, "source": "real-team", "format": fmt,
        "ability": ability, "item": item, "nature": nature, "moves": list(moves),
        "sps": sps,                               # real co-occurring spread (yakkun) or None (doubles)
        "spread_origin": "real-team" if sps else None,
        "count": cnt, "sample": sample, "share": round(cnt / sample, 3),
        "confidence": _confidence(sample, cnt / sample),
        "note": (f"real-team modal joint set: {cnt}/{sample} teams ({species}, {fmt}); "
                 f"ability/item/nature/moves co-occur (no marginal stitch). {spread_note}"),
    }


def representative_set_from_teams(species: str, fmt: str, teams: list[dict[str, Any]], *,
                                  min_sample: int = MIN_SAMPLE) -> dict[str, Any] | None:
    """The most-common REAL JOINT set ({ability,item,nature,moves}) actually run for `species`.

    Returns None when fewer than `min_sample` real occurrences exist (too thin to trust). Pure /
    injectable for tests. `sps` is the modal SP spread among the teams running this exact set when the
    source exposes one (yakkun singles), else None (Limitless doubles) — see module docstring. This is
    the SINGLE global modal (the opponent-set resolver's choice); for the up-to-3 archetype split use
    `representative_sets_from_teams`."""
    members = _members_of(species, teams)
    if len(members) < min_sample:
        return None
    return _build_modal_set(species, fmt, members)


def representative_sets_from_teams(species: str, fmt: str, teams: list[dict[str, Any]], *,
                                   min_sample: int = MIN_SAMPLE,
                                   max_clusters: int = MAX_CLUSTERS,
                                   item: str | None = None) -> list[dict[str, Any]]:
    """Up to `max_clusters` REAL archetypes for `species`, split by (item, ability) cluster (design §10
    trap ②). A species commonly runs genuinely distinct builds (e.g. Choice Scarf vs Assault Vest);
    one global modal would hide that bimodality. Each archetype = the modal joint set WITHIN its
    (item, ability) cluster, ranked by cluster size; only clusters with >= `min_sample` teams qualify.

    `item` (optional) restricts to members holding that item before clustering — used to resolve a Mega
    in the doubles library, which stores it as base species + stone (so item=required_item isolates the
    Mega's archetypes; audit 2026-06-25). `max_clusters` must be >= 1; <1 yields [] (no archetype
    requested), never the fragmented fallback.

    Per-set fields beyond the global-modal shape: `cluster` ({item,ability}); `coverage` (the cluster's
    share of the QUERIED pool); `species_sample` (that pool's size); `species_sample_total` (the
    whole-species count, == `species_sample` unless an `item` filter narrows the pool); `item_filter`
    (the item the pool was filtered to, or None). When `item` is set, `coverage`/`species_sample` are
    denominated on the filtered subpool (e.g. a doubles Mega isolated by its stone), NOT the whole
    species — so consumers must read coverage against `pool_label`/`item_filter`, never as base-species
    coverage (audit 2026-06-26). `share`/`confidence` are denominated WITHIN the cluster. Returns [] when
    the species itself is below `min_sample`. When no single (item,ability)
    cluster reaches the bar (a fragmented species that still clears `min_sample` overall), falls back to
    a single global modal entry flagged `fragmented` (cluster=None, coverage=None) — honest degrade,
    never fabrication (§10 trap ④)."""
    if max_clusters < 1:
        return []
    all_members = _members_of(species, teams)
    species_total = len(all_members)          # the WHOLE-species count, before any item filter
    if item is not None:
        members = [m for m in all_members if m.get("item") == item]
    else:
        members = all_members
    sample = len(members)                     # the QUERIED pool: the item-filtered subpool when an item
    if sample < min_sample:                   # filter is active (doubles-Mega isolation), else == species_total
        return []
    # When an item filter narrows the pool, `coverage`/`species_sample` are denominated on THAT subpool,
    # not the whole species — so a doubles-Mega query ("Mega Charizard Y" -> Charizard @ Charizardite Y)
    # must label its denominator as the filtered pool, never as base Charizard's full real teams. The
    # honest figure is carried in the note (`pool_label`) plus `item_filter`/`species_sample_total`
    # so a consumer/cache can never read the cluster coverage as a base-species coverage (audit 2026-06-26).
    pool_label = f"{species} @ {item}" if item is not None else species
    clusters: dict[tuple, list[dict[str, Any]]] = {}
    for m in members:
        clusters.setdefault((m.get("item"), m.get("ability")), []).append(m)
    ranked = sorted(clusters.items(), key=lambda kv: len(kv[1]), reverse=True)
    out: list[dict[str, Any]] = []
    for (c_item, ability), cms in ranked:
        if len(out) >= max_clusters:      # checked BEFORE building so max_clusters is an exact ceiling
            break
        if len(cms) < min_sample:
            continue
        s = _build_modal_set(species, fmt, cms)
        s["cluster"] = {"item": c_item, "ability": ability}
        s["coverage"] = round(len(cms) / sample, 3)
        s["species_sample"] = sample                  # the queried pool (filtered subpool when item-filtered)
        s["species_sample_total"] = species_total     # the whole-species count (== species_sample if no filter)
        s["item_filter"] = item
        s["note"] = (f"real-team archetype item={c_item!r}/ability={ability!r}: covers {len(cms)}/{sample}"
                     f" of {pool_label} real teams ({fmt}); modal joint set {s['count']}/{len(cms)} within"
                     f" it (co-occur). {'spread co-occurs.' if s['sps'] else 'spread not in source.'}")
        out.append(s)
    if not out:
        g = _build_modal_set(species, fmt, members)
        g["cluster"] = None
        # NOT a cluster -> cluster `coverage` is undefined (None). Reusing 1.0 read as "this set is on
        # 100% of teams", but it is only on count/sample of them (audit 2026-06-25). `share`
        # (count/sample) carries the honest figure; MD/consumers render fragmented distinctly.
        g["coverage"] = None
        g["species_sample"] = sample
        g["species_sample_total"] = species_total
        g["item_filter"] = item
        g["fragmented"] = True
        g["note"] = (f"real-team: no single item/ability archetype reaches the sample bar ({sample} "
                     f"teams across {len(clusters)} item/ability combos, {pool_label}, {fmt}); global modal"
                     f" shown — treat as fragmented. " + g["note"])
        out = [g]
    return out


def representative_set(species: str, fmt: str, *, season: str | None = None,
                       min_sample: int = MIN_SAMPLE) -> dict[str, Any] | None:
    """Load the format's library (one season when given) and return the modal joint set, or None."""
    return representative_set_from_teams(
        species, fmt, load_teams(fmt, season), min_sample=min_sample)


def representative_sets(species: str, fmt: str, *, season: str | None = None,
                        min_sample: int = MIN_SAMPLE,
                        max_clusters: int = MAX_CLUSTERS,
                        item: str | None = None) -> list[dict[str, Any]]:
    """Load the format's library (one season when given) and return up to `max_clusters` archetypes."""
    return representative_sets_from_teams(
        species, fmt, load_teams(fmt, season), min_sample=min_sample, max_clusters=max_clusters,
        item=item)


def dominant_form_from_teams(species: str, fmt: str, teams: list[dict[str, Any]], *,
                             min_sample: int = MIN_SAMPLE) -> str:
    """The library form a meta BASE name is actually RUN as. Pure / injectable for tests.

    The SINGLES library stores a Mega as the `Mega X` species (op.gg/yakkun normalization), while the
    meta usage ranking ranks it under the BASE name — so a base name like 'Staraptor' would miss its
    real teams stored under 'Mega Staraptor' (audit 2026-06-25: Metagross/Staraptor/Blaziken were
    wrongly read as 'no real data'). Return the base name UNLESS a `Mega <base>` form is real-team-backed
    (>= min_sample) AND at least as common as the base — then that Mega is the form the opponent runs.
    The DOUBLES library stores a Mega as base species + stone (under the base name), so no `Mega X` key
    exists and the base is always returned (the fix is singles-only by construction, not by a fmt check)."""
    counts: Counter = Counter()
    for t in teams:
        thi = _team_has_item(t)
        for m in t.get("pokemon", []):
            if _template_eligible_member(m, team_has_item=thi):
                counts[m.get("species")] += 1
    base_n = counts.get(species, 0)
    megas = [(sp, c) for sp, c in counts.items() if sp.startswith("Mega " + species)]
    if megas:
        best_form, best_c = max(megas, key=lambda kv: kv[1])
        if best_c >= min_sample and best_c >= base_n:
            return best_form
    return species


def dominant_form(species: str, fmt: str, *, season: str | None = None,
                  min_sample: int = MIN_SAMPLE,
                  teams: list[dict[str, Any]] | None = None) -> str:
    """Load the format's library (or use the passed `teams`) and resolve a meta base name to the form it
    is actually run as (see `dominant_form_from_teams`)."""
    teams = load_teams(fmt, season) if teams is None else teams
    return dominant_form_from_teams(species, fmt, teams, min_sample=min_sample)
