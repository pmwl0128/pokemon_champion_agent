---
name: pokemon-champions-meta
description: Offline-first Pokemon Champions metagame cache and query API for current and historical seasons/rules, including M-3/M-B single and double formats. Use when you need cached usage rankings, top Pokemon details, moves/items/abilities/natures/partners/SP spreads, single-vs-double comparisons, or environment summaries while building or reviewing Pokemon Champions teams.
---

# Pokemon Champions Meta

Use this skill for Pokemon Champions metagame usage data. It is separate from `$pokemon-champions-dex`: this skill answers "what is popular and how is it used?", while the dex skill answers "what exists and what can it learn?".

## Quick Start

Query cached rankings:

```bash
# Uses the current season/rule by default.
python scripts/meta_query.py ranking --format single --limit 20
python scripts/meta_query.py ranking --format double --limit 20
python scripts/meta_query.py ranking --format double --season M-3 --rule M-B --limit 20
```

Query Pokemon details:

```bash
python scripts/meta_query.py detail --format single --pokemon 雷丘
python scripts/meta_query.py detail --format double --pokemon garchomp
```

Names resolve through the dex (Chinese / English / Japanese), and a misspelled query is typo-tolerant. A correction is **never silent**: when a typo is auto-resolved, `detail`/`compare` add `query`, `resolved_name`, and a `name_resolution` block (`{match_type, score, distance, from}`) so you can tell an exact lookup from a correction. An exact query carries none of these.

Reverse-search panel entries:

```bash
python scripts/meta_query.py search --format double --panel moves --name 地震
python scripts/meta_query.py search --format both --panel moves --type ground --category physical --min-usage 20
```

Compare formats:

```bash
python scripts/meta_query.py compare --pokemon 雷丘
```

Export JSON for programmatic use:

```bash
python scripts/meta_query.py detail --format double --pokemon garchomp --output json
```

Export a human-readable Excel workbook (one file, written to the current working directory — never into the skill):

```bash
# Combined workbook with three tabs: 单打 + 双打 data, plus a 更新报告 tab that has a
# name lookup (single/double side-by-side) and the embedded update report.
python scripts/meta_query.py export-excel --season M-3 --rule M-B
```

> Dependency: `export-excel` is the **only** command that needs a third-party library —
> `openpyxl` (see `requirements.txt`). Install it with `pip install -r requirements.txt` (or
> `pip install openpyxl`). Every other command is stdlib-only and works without it.

## Data Layout

The skill ships prebuilt, read-only data and performs no network access.

- Structured runtime data lives under `data/`.
- English slugs are the primary IDs.
- Each season/format is a separate file: `ranking_<season>_<format>.json`, `details_<season>_<format>.json`, `long_<season>_<format>.csv`, `spreads_<season>_<format>.csv`.
- `report_<season>_<format>.json` — the factual **update report** (significant ranking / move / item / nature / EV-spread changes vs the previous snapshot), regenerated on each refresh. AI can read it directly; the Excel export embeds it automatically.
- The default season/rule and season-to-rule mapping live in `data/current.json`; no-argument queries resolve through this file.
- Refreshes are maintained by the project-level `update/` pipeline, not by this skill's query scripts. The updater defaults to a full single/double refresh; `--ranking-limit 0` and `--detail-limit 0` mean all rows exposed by the source.
- Use `$pokemon-champions-dex` or `champdex.py` only for base dex facts or name aliases not present in the metagame cache.

Read `references/api.md` for command/API details and `references/schema.md` for cache formats.
