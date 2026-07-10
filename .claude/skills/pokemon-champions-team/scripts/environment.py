#!/usr/bin/env python
"""Environment stamp + context consistency.

The skill serves only the CURRENT environment — it does not do version alignment.
But inputs still carry season/rule, and the bases (dex/meta) are time-sensitive, so two things must
hold for results to be explainable and not silently computed against the wrong base:

  1. every output carries the environment it was computed against (season / rule / as_of);
  2. if the build-context names a season/rule that differs from the current base, say so loudly
     (we still compute against the current base — that's all the bases provide — but never silently).

`as_of` is best-effort provenance read from the sibling bases (dex `built_at`, meta `updated_at`).
It is metadata, not battle data, and never required: if a base file isn't readable it's simply None.
The current season/rule are the team skill's declared current environment (tracks CLAUDE.md /
meta `current.json`); the rule constants themselves live in rules.py.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import team_i18n as i18n
from rules import get_ruleset, SEASON_RULE

SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_DIR.parent
_DEX_JSON = SKILLS_ROOT / "pokemon-champions-dex" / "data" / "champions_dex.json"
_META_CURRENT = SKILLS_ROOT / "pokemon-champions-meta" / "data" / "current.json"

_FALLBACK_SEASON_RULE = SEASON_RULE       # single source (rules.py); do not re-declare a local copy
_FALLBACK_CURRENT_SEASON = "M-4"
_FALLBACK_CURRENT_RULE = get_ruleset().rule


def _meta_current() -> tuple[str, str]:
    """Current season/rule from the sibling meta manifest, with a stable fallback for tests/offline."""
    try:
        cur = json.loads(_META_CURRENT.read_text(encoding="utf-8"))
        current = cur.get("current") or {}
        season = current.get("season") or _FALLBACK_CURRENT_SEASON
        rule = current.get("rule") or _FALLBACK_SEASON_RULE.get(season) or _FALLBACK_CURRENT_RULE
        return season, rule
    except Exception:
        return _FALLBACK_CURRENT_SEASON, _FALLBACK_CURRENT_RULE


CURRENT_SEASON, CURRENT_RULE = _meta_current()


def rule_for_season(season: str | None) -> str | None:
    """Known regulation for a season, preferring meta/current.json and falling back to pinned constants."""
    if not season:
        return None
    try:
        cur = json.loads(_META_CURRENT.read_text(encoding="utf-8"))
        row = (cur.get("seasons") or {}).get(season) or {}
        if row.get("rule"):
            return row["rule"]
    except Exception:
        pass
    return _FALLBACK_SEASON_RULE.get(season)


def base_as_of(*, dex_path: Path | None = None, meta_path: Path | None = None) -> dict[str, str | None]:
    """Best-effort base build timestamps for provenance. Read-only; missing files -> None."""
    out: dict[str, str | None] = {"dex_built_at": None, "meta_updated_at": None}
    try:
        out["dex_built_at"] = json.loads((dex_path or _DEX_JSON).read_text(encoding="utf-8")).get("built_at")
    except Exception:
        pass
    try:
        cur = json.loads((meta_path or _META_CURRENT).read_text(encoding="utf-8"))
        season = (cur.get("current") or {}).get("season")
        out["meta_updated_at"] = (cur.get("seasons") or {}).get(season, {}).get("updated_at")
    except Exception:
        pass
    return out


def resolve(season: str | None = None, rule: str | None = None, *,
            as_of: dict | None = None,
            data_season: str | None = None, data_rule: str | None = None,
            data_seasons: list[str] | None = None) -> tuple[dict[str, Any], list[str]]:
    """Return (environment stamp, warnings).

    The dex/meta BASES only serve the current environment, so a build-context that requested a
    different season/rule produces a warning (not a silent substitution) and the stamp's
    `season`/`rule` reflect the current base actually used. `as_of` is injectable for tests.

    `data_season`/`data_rule`/`data_seasons` are for results whose DATA is served from a real-team
    partition or rule pool rather than the current-only bases. A `repset --season M-2` query genuinely
    reads M-2 teams; a default current M-B build query reads the M-B rule pool (M-3 + M-4 when both
    exist). Record that data provenance explicitly instead of pretending it is the top-level current
    season.
    """
    warnings: list[str] = []
    if season and season != CURRENT_SEASON:
        warnings.append(i18n.Msg("env_season_mismatch", season=season, base=CURRENT_SEASON))
    if rule and rule != CURRENT_RULE:
        warnings.append(i18n.Msg("env_rule_mismatch", rule=rule, base=CURRENT_RULE))
    stamp: dict[str, Any] = {
        "season": CURRENT_SEASON,
        "rule": CURRENT_RULE,
        "as_of": as_of if as_of is not None else base_as_of(),
    }
    if data_season is not None or data_rule is not None:
        # The dex used for canonicalization is still current (top-level season/rule), but the real-team
        # DATA is the named partition — surface it explicitly so a consumer/cache never reads the
        # current base stamp as the data's provenance.
        stamp["data_season"] = data_season
        stamp["data_rule"] = data_rule
    if data_seasons is not None:
        stamp["data_seasons"] = list(data_seasons)
    return stamp, warnings
