---
name: pokemon-champions-dex
description: Offline-first Pokemon Champions battle dex lookup with trilingual aliases (Chinese / English / Japanese), batch queries, and multi-condition reverse search. Use when you need to check Pokemon Champions or Regulation M-B battle-dex facts such as Pokemon/forms, Chinese/English/Japanese names, types, base stats, abilities, moves, learnsets, Mega stones, item availability, or to answer queries like "who learns Close Combat and is Flying type" while building or reviewing teams.
---

# Pokemon Champions Dex

Use this skill to query a local Pokemon Champions battle dex before making team-building claims. It is separate from environment usage/ranking data: it answers "what can this Pokemon be or learn?" rather than "what is popular?".

## Quick Start

Run the query CLI:

```bash
python scripts/champdex.py pokemon 姆克鹰 Mega-Staraptor 巨金怪
python scripts/champdex.py move 近身战 Close-Combat
python scripts/champdex.py ability 唱反调 Contrary
```

Names resolve in Chinese, English, or Japanese (kana), so Japanese-source inputs work directly. Full-width and half-width forms both match (`１０まんボルト` = `10まんボルト`):

```bash
python scripts/champdex.py pokemon ガブリアス ミミッキュ
python scripts/champdex.py move じしん 10まんボルト
python scripts/champdex.py find type 龍 learns じしん
```

Name lookups are typo-tolerant by default: an exact match is used when present, otherwise a close misspelling resolves to the nearest entity and the result carries a `resolution` block flagging the correction; an ambiguous tie refuses rather than guessing (and returns `suggestions`). Pass `--strict` to disable the fallback when a miss must stay a miss (validation/integrity). `find`/`reverse` are always exact.

Use batch mode when a prompt lists many Pokemon, moves, abilities, or items:

```bash
python scripts/champdex.py batch pokemon 姆克鹰 巨金怪 弃世猴 洗衣机
```

Use `find` or `reverse` for reverse and multi-condition lookup:

```bash
python scripts/champdex.py find move 近身战 type 飞行
python scripts/champdex.py find ability 唱反调 type 飞行
python scripts/champdex.py find type 水 type 地面 stat spe>=70
python scripts/champdex.py reverse move Close-Combat --format json
```

The positional condition grammar is `field value field value ...`. Supported fields are `pokemon`, `move`, `ability`, `item`, `type`, `stat`, `mega`, and `name`. Stat conditions accept `hp>=80`, `atk>120`, `spe<=70`, plus aliases `at/atk`, `df/def`, `sa/spa`, `sd/spd`, `sp/spe`.

## Data Files

The skill ships a prebuilt, read-only database. It performs no network access and does not regenerate its own data.

- `data/champions_dex.sqlite`: primary offline database (queried by `champdex.py`).
- `data/champions_dex.json`: portable JSON export.

Read `references/schema.md` when you need to understand database fields or query behavior.

## Team-Building Usage

When building or reviewing a team, query this skill for factual checks before claiming:

- a Pokemon's Champions typing, stats, ability, or Mega stone;
- whether a Pokemon/form can use a move in Champions;
- which Pokemon satisfy a combined constraint such as `move 近身战 type 飞行`;
- Chinese/English/Japanese name resolution for screenshots, Japanese-source data, or user shorthand.

Do not infer strategic roles from this skill. It intentionally does not generate role tags because Pokemon sets are flexible and tags can bias team-building reasoning.
