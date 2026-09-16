# Pokémon Champions Meta Cache Schema

This reference documents the bundled cache files and their stored rows. For the public CLI contract,
run `python scripts/meta_query.py schema`; its executable self-description and actual output are
authoritative. Stored rows may contain source-oriented names or casing that the CLI normalizes at the
boundary.

Runtime data root: `data/`. This is prebuilt, read-only data.

## Files

- `ranking_<season>_<format>.json`
- `details_<season>_<format>.json`
- `ko_<season>_<format>.json` (KO axis; its own upstream and snapshot clock)
- `report_<season>_<format>.json`
- `trend_<season>_<format>.json` (current season only; rolling refresh history for chart export)
- `usage_trend_<season>_<format>.json` (rolling per-panel history: percentages, plus teammate RANKS)
- `ko_trend_<season>_<format>.json` (the KO axis's own rolling history, on the KO snapshot clock)
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

## KO File

A SECOND data axis, not a panel of `details`. It answers "who knocks out whom", comes from a
different upstream than the usage data, and advances on its own snapshot clock — so its `updated_at`
is its own and must be quoted separately.

```json
{
  "version": 1,
  "season": "M-6", "rule": "M-C", "format": "double",
  "updated_at": "2026-09-15T01:46:15+00:00",
  "snapshot": {"id": 3107, "taken_at": "2026-09-15T01:46:15+00:00", "verified": true},
  "coverage": {
    "opponents": "ranked",
    "opponent_identity": "national_dex",
    "opponent_depth": 30,
    "opponent_form_collapsed": 688,
    "move_share": "absent",
    "move_depth": null,
    "rows": 262,
    "rows_with_move_share": 0
  },
  "rows": [
    {
      "rank": 2, "pokemon": "大狃拉", "slug": "sneasler",
      "pokemon_en": "Sneasler", "pokemon_ja": "オオニューラ", "pokedex_no": 903,
      "panels": {
        "ko_targets": [{"rank": 1, "key": "727", "name": "炽焰咆哮虎", "name_ja": "ガオガエン", "name_en": "Incineroar"}],
        "koed_by":    [{"rank": 1, "key": "373", "name": "暴飞龙", "name_ja": "ボーマンダ", "name_en": "Salamence"}],
        "ko_moves": null,
        "koed_by_moves": null
      }
    }
  ]
}
```

`ko_targets` is whom this Pokémon knocks out (source: "Most KOs"); `koed_by` is who knocks it out
("Most KO'd By"). Four rules govern reading this file:

- **Ordering, not share.** Object entries deliberately have NO `percentage` field — the source
  publishes a ranked list and no count. Do not derive one, and do not read the list as a win rate.
- **`null` means not collected.** `ko_moves` / `koed_by_moves` are a reserved tier. While
  `coverage.move_share` is `absent` they are `null`; an empty list would mean the source reported
  none. When the tier ships, `move_share` becomes `ranked_pct` and the panels hold move entries in
  the same shape as `details`' `moves` panel (with `percentage`).
- **Objects are species-level.** `key` is the national dex number and there is no form: the source
  drops it. The names come from the dex at whatever precision that number allows: the base-form row
  when there is one, the single form when the dex ships the species as exactly one (#670 can only
  mean Floette-Eternal), and otherwise the BARE species name in every language (南瓜怪人 /
  Gourgeist). Only that last case is ambiguous, and only it carries `form_rep` — the form the dex
  points that bare name at — for consumers that need one form to draw or link to. `name_en` is the
  species-level join key, so it equals `form_rep`'s species, not `form_rep`.
- **A repeat is flagged, not removed.** The same `key` can appear twice in one list because the
  underlying rows are per-form; both entries are kept (each is a separate observation) and both carry
  `"form_collapsed": true`. `coverage.opponent_form_collapsed` counts them file-wide.

Row subjects ARE form-level and identified by the dex canonical (`pokemon_en`), which is how this
file joins `ranking`/`details`. `slug` is copied from the usage file for convenience and is empty
when the usage snapshot does not carry that Pokémon.

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
