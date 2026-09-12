# Pokémon Champions Meta Cache Schema

This reference documents the bundled cache files and their stored rows. For the public CLI contract,
run `python scripts/meta_query.py schema`; its executable self-description and actual output are
authoritative. Stored rows may contain source-oriented names or casing that the CLI normalizes at the
boundary.

Runtime data root: `data/`. This is prebuilt, read-only data.

## Files

- `ranking_<season>_<format>.json`
- `details_<season>_<format>.json`
- `report_<season>_<format>.json`
- `trend_<season>_<format>.json` (current season only; rolling refresh history for chart export)
- `current.json`

`format` is `single` or `double`.

## Ranking Row

```json
{
  "rank": 1,
  "pokemon": "烈咬陆鲨",
  "slug": "garchomp",
  "pokemon_en": "Garchomp",
  "pokemon_ja": "ガブリアス",
  "format": "single",
  "season": "M-4",
  "rule": "M-B"
}
```

## Detail Row

```json
{
  "rank": 1,
  "pokemon": "烈咬陆鲨",
  "slug": "garchomp",
  "pokedex_no": 445,
  "format": "double",
  "season": "M-4",
  "rule": "M-B",
  "panels": {
    "moves": [{"rank": 1, "name": "龙爪", "name_ja": "ドラゴンクロー", "percentage": 89.5, "type": "dragon", "category": "physical", "power": 80, "accuracy": 100}],
    "items": [{"rank": 1, "name": "讲究围巾", "percentage": 14.8}],
    "abilities": [{"rank": 1, "name": "粗糙皮肤", "percentage": 99.8}],
    "natures": [{"rank": 1, "name": "爽朗", "percentage": 66.6}],
    "partners": [{"rank": 1, "name": "风妖精", "slug": "whimsicott", "percentage": null}],
    "spreads": [{"rank": 1, "hp": 2, "atk": 32, "def": 0, "spa": 0, "spd": 0, "spe": 32, "percentage": 56.0}]
  }
}
```

Panel keys are normalized to English: `moves`, `items`, `abilities`, `natures`, `partners`, `spreads`.

A row carries an optional `detail_updated` ISO stamp only when the source provides a real
per-pokemon update time; the file-level `updated_at` is the refresh stamp for every row.

## Current State

`current.json` stores the default context and season/rule mapping. This is an illustrative historical
shape; always read the bundled file for the active values:

```json
{
  "current": {"season": "M-4", "rule": "M-B"},
  "seasons": {
    "M-1": {"rule": "M-A", "label": "Pokémon Champions M-1 / Regulation M-A"},
    "M-2": {"rule": "M-A", "label": "Pokémon Champions M-2 / Regulation M-A"},
    "M-3": {"rule": "M-B", "label": "Pokémon Champions M-3 / Regulation M-B"},
    "M-4": {"rule": "M-B", "label": "Pokémon Champions M-4 / Regulation M-B",
            "updated_at": "2026-08-05T00:00:00+00:00",
            "activated_at": "2026-07-09T11:20:31+00:00"}
  }
}
```

A season entry's timestamps answer different questions and are not interchangeable. `updated_at` is
the UPSTREAM data stamp — when the snapshot this file describes was aggregated — and moves with every
refresh; `created_at` (when present) records when the entry was first written. `activated_at` is when
this checkout first made the season current: written once, never rewritten by a later refresh of the
same season. Only `activated_at` anchors the seven-day cross-regulation team handover window, so a
stale or future upstream stamp can neither shorten nor extend it. Any of the three may be absent —
entries that became current before a field existed simply do not carry it, which is why the bundled
file's older seasons have no `activated_at`.

Queries with no `--season` or `--rule` resolve through `current`. Same-rule historical seasons remain
queryable while their files are retained. On a rule rollover, the update pipeline prunes stale-rule
meta snapshots; entries can remain in `current.json` as known season/rule mappings without implying
that their ranking/detail files still ship.
