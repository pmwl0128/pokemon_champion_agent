---
name: pokemon-champions-meta
description: Offline-first Pokémon Champions metagame cache and query API for current and historical seasons/rules in single and double formats. Use when the request is about metagame popularity, distribution, common sets, partners, format comparison, update reports, or current/historical environment summaries; do not trigger merely because an item/ability/nature is mentioned without usage or environment context. Chinese examples include "现在环境哪些常见", "X使用率/排名多少", "X常见配置", "X常带什么道具/常用什么性格/招式", "X常见队友", "单双打环境差异", "这期有什么变化". English examples include "usage/ranking for X", "what does X commonly run", "common items/moves/natures for X", "popular partners", "single vs double meta comparison", "latest meta changes". Japanese examples include "環境で多いポケモン", "Xの採用率/順位", "Xのよくある型", "よく採用される技/持ち物/性格", "相方", "シングルとダブルの違い", "今期の変化".
---

# Pokémon Champions Meta

Query the bundled Pokémon Champions metagame snapshot for rankings, common configurations, partners,
format comparisons, and factual changes between snapshots. This skill answers "what is popular and
how is it used?"; canonical battle facts remain the responsibility of `$pokemon-champions-dex`.

## Workflow

1. Use the current season/rule unless the user explicitly requests a historical context.
2. Use `ranking` for the environment overview and `detail` for one Pokémon's panels.
3. Use `search` for reverse lookup across panel entries and `compare` for single-vs-double facts.
4. Use `report` for snapshot changes. Use `export-excel` only when the user requests workbooks.
5. Keep usage marginals factual: common moves/items/partners are not a guaranteed joint set.

## Commands

Query cached rankings:

```bash
# Uses the current season/rule by default.
python scripts/meta_query.py ranking --format single --limit 20
python scripts/meta_query.py ranking --format double --limit 20
python scripts/meta_query.py ranking --format double --season M-4 --rule M-B --limit 20
```

Query Pokémon details:

```bash
python scripts/meta_query.py detail --format single --pokemon 雷丘
python scripts/meta_query.py detail --format double --pokemon garchomp
```

Reverse-search panel entries or compare formats:

```bash
python scripts/meta_query.py search --format double --panel moves --name 地震
python scripts/meta_query.py search --format both --panel moves --type ground --category physical --min-usage 20
python scripts/meta_query.py search --format single --panel moves --where '{"and":[{"type":"Fire"},{"or":[{"category":"Special"},{"usage":">=20"}]}]}'
python scripts/meta_query.py compare --pokemon 雷丘
python scripts/meta_query.py report --format both
```

Names resolve through the sibling dex in Chinese, English, or Japanese. Fuzzy corrections are always
disclosed: structured detail/compare results carry resolution metadata, while `search` reports a
correction on stderr without contaminating JSON stdout.

Use JSON for downstream processing:

```bash
python scripts/meta_query.py detail --format double --pokemon garchomp --output json
```

## Contract And Output

Treat the executable schema as the authority for commands, flags, fields, boolean query grammar, and
errors:

```bash
python scripts/meta_query.py schema
```

Canonical JSON is language-independent. Human-readable output language precedence is `--lang`, then
`POKEMON_CHAMPIONS_LANG`, then `en`. Read `references/api.md` for detailed command usage and
`references/schema.md` only when the bundled cache layout matters.

## Excel Export

`export-excel` always writes three standalone single-language workbooks (`zh`, `ja`, `en`) to the
chosen output directory, independently of `--lang`:

```bash
python scripts/meta_query.py export-excel --season M-4 --rule M-B
```

This is the only command requiring `openpyxl`; install `requirements.txt` when export is needed. All
query commands use the Python standard library.

## Boundaries

- The shipped snapshot is read-only and queried offline; its date and season/rule stamp define freshness.
- Do not infer legality or learnsets from usage data.
- Do not combine move, item, ability, nature, partner, or spread marginals into an asserted joint set.
- A change report records factual differences between snapshots, not an interpretation of the metagame.
