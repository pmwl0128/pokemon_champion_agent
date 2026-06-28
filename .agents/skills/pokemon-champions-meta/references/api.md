# Pokemon Champions Meta API

This skill is read-only: it queries the prebuilt data under `data/` and performs no network access. Refresh the data from the project-level `update/` pipeline; update defaults are full refreshes for both single and double formats.

## Query

All query commands accept optional `--season` and `--rule`. If neither is passed, the command uses the current season/rule from `data/current.json`. If only `--rule` is passed, it resolves to the current season if the rule matches, otherwise the latest recorded season for that rule.

Ranking:

```bash
python scripts/meta_query.py ranking --format double --limit 20
python scripts/meta_query.py ranking --format double --season M-3 --rule M-B --limit 20
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
# One combined workbook, written to the current directory (e.g. M-3_YYYYMMDD.xlsx):
python scripts/meta_query.py export-excel --season M-3 --rule M-B

# Explicit path / output dir; --report-dir overrides where the report is read from.
python scripts/meta_query.py export-excel --output-file teams/meta.xlsx
```

`export-excel` reads only local data and writes a single workbook with three
worksheets:

- `单打` and `双打` — one row per Pokemon, columns `排名`, `中文名`, `英文名`,
  `招式`, `道具`, `特性`, `性格`, `队友`, `努力值`. Panel entries are ranked
  multiline cell text; SP spreads use `H/A/B/C/D/S`.
- `更新报告` — a name-lookup block (type/pick a 中文名 to see its single and
  double data side-by-side, so Ctrl-F never collides with the 队友 column) plus
  the single and double **update reports** rendered side-by-side. The report is
  read from `data/report_<season>_<format>.json` by default.

The output file goes to the current working directory (the user's project), never
into the skill. The default season/rule is read from `data/current.json`.

## Output Formats

`--output md` is default. Use `--output json` for structured downstream use.
`export-excel` always writes `.xlsx` and prints a JSON summary with the output
path, the sheet list, single/double row counts, and which reports were embedded.
