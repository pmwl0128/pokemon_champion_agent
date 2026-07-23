# Pokémon Champions Meta API

This skill is read-only: it queries the prebuilt data under `data/` and performs no network access.
Run `python scripts/meta_query.py schema` for the authoritative command, flag, field, and error
contract. This file provides usage guidance and export behavior rather than a second machine schema.

## Query

All query commands accept optional `--season` and `--rule`. If neither is passed, the command uses the current season/rule from `data/current.json`. If only `--rule` is passed, it resolves to the current season if the rule matches, otherwise the latest recorded season for that rule.

Ranking:

```bash
python scripts/meta_query.py ranking --format double --limit 20
python scripts/meta_query.py ranking --format double --season M-4 --rule M-B --limit 20
```

Detail:

```bash
python scripts/meta_query.py detail --format single --pokemon 雷丘
python scripts/meta_query.py detail --format double --pokemon garchomp --panel moves --output json
```

Search by panel entry:

```bash
python scripts/meta_query.py search --format double --panel moves --name 近身战
python scripts/meta_query.py search --format single --panel items --name 气势披带
python scripts/meta_query.py search --format both --panel moves --type ground --category physical --min-usage 20
```

Search options can be combined. `--name` may be repeated and all name terms must match one of the entry fields. `--type` and `--category` filter move metadata when the cache provides it.

Compare single and double:

```bash
python scripts/meta_query.py compare --pokemon 雷丘
```

Export Excel:

```bash
# ALWAYS three single-language workbooks, written to the current directory:
#   M-4_YYYYMMDD_zh.xlsx  M-4_YYYYMMDD_ja.xlsx  M-4_YYYYMMDD_en.xlsx
python scripts/meta_query.py export-excel --season M-4 --rule M-B

# Pick the output dir; --report-dir overrides where the report is read from.
python scripts/meta_query.py export-excel --output-dir teams/
```

`export-excel` reads only local data and is a **distribution artifact**: it always writes
**three standalone single-language workbooks** (zh / ja / en), independent of `--lang` / the
env var / `DEFAULT_LANG`. Each workbook is self-contained, with four worksheets in its own
language:

- a lookup sheet (`检索` / `検索` / `Lookup`) first — select one Pokémon to see its Singles and
  Doubles panels plus the current factual changes for that Pokémon;
- two data sheets (`单打`/`双打`, `シングル`/`ダブル`, or `Singles`/`Doubles`) — one row per
  Pokémon. Names and every panel cell are rendered in that file's language via the dex (the
  naming authority): the en file carries no Chinese, the zh/ja files add an English
  cross-reference column. Columns (zh) are `排名`, `中文名`, `英文名`, `招式`, `道具`, `特性`,
  `性格`, `队友`, `SP 分配`; ja/en use the translated headers (ja keeps `日本語名` + `英語名`, en
  is `Name` only). Panel entries are ranked multiline cell text; SP spreads use `H/A/B/C/D/S`.
- an update-report sheet (`更新报告` / `更新レポート` / `Update Report`) — the single and double
  factual change tables plus their tier reference. Reports are read from
  `data/report_<season>_<format>.json` by default.

The files go to the current working directory (the user's project), never into the skill. The
default season/rule is read from `data/current.json`. Before writing, generated report workbooks in
the output directory whose names match `<M-season>_<YYYYMMDD>_{zh,ja,en}.xlsx` are deleted, so stale
triplets do not survive beside the current export.

## Output Formats

`--output md` is default. Use `--output json` for structured downstream use.
`export-excel` always writes the three `.xlsx` files and prints a JSON summary
(`{files:[{lang, output_file, sheets, single_rows, double_rows}], reports_embedded}`).
