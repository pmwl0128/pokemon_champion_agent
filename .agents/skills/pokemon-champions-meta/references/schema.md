# Pokemon Champions Meta Schema

Runtime data root: `data/`. This is prebuilt, read-only data.

## Files

- `ranking_<season>_<format>.json`
- `details_<season>_<format>.json`
- `long_<season>_<format>.csv`
- `spreads_<season>_<format>.csv`
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
  "season": "M-3",
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
  "season": "M-3",
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
  "current": {"season": "M-3", "rule": "M-B"},
  "seasons": {
    "M-3": {"rule": "M-B", "label": "Pokemon Champions M-3 / Regulation M-B"}
  }
}
```

Queries with no `--season` or `--rule` resolve through `current`. Historical seasons remain queryable as long as their data files remain under `data/`.
