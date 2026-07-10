# Pokemon Champions Meta Cache Schema

This reference documents the bundled cache files and their stored rows. For the public CLI contract,
run `python scripts/meta_query.py schema`; its executable self-description and actual output are
authoritative. Stored rows may contain source-oriented names or casing that the CLI normalizes at the
boundary.

Runtime data root: `data/`. This is prebuilt, read-only data.

## Files

- `ranking_<season>_<format>.json`
- `details_<season>_<format>.json`
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
  "detail_updated": "2026-06-18T07:53:51.288+00:00",
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

## Current State

`current.json` stores the default context and season/rule mapping:

```json
{
  "current": {"season": "M-4", "rule": "M-B"},
  "seasons": {
    "M-1": {"rule": "M-A", "label": "Pokemon Champions M-1 / Regulation M-A"},
    "M-2": {"rule": "M-A", "label": "Pokemon Champions M-2 / Regulation M-A"},
    "M-3": {"rule": "M-B", "label": "Pokemon Champions M-3 / Regulation M-B"},
    "M-4": {"rule": "M-B", "label": "Pokemon Champions M-4 / Regulation M-B"}
  }
}
```

Queries with no `--season` or `--rule` resolve through `current`. Historical seasons remain queryable as long as their data files remain under `data/`.
