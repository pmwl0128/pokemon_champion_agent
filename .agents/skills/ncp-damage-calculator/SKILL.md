---
name: ncp-damage-calculator
description: Run Pokémon Champions damage and speed-line calculations using the bundled NCP VGC Damage Calculator formulas. Use when building or reviewing Pokémon Champions teams, checking M-B/M-3 matchup damage ranges, comparing EV/SP spreads, validating KO ranges, testing weather/screens/items/abilities, querying speed tiers, checking whether one Pokémon outspeeds another, or answering whether one Pokémon survives or KOs another.
---

# NCP Damage Calculator

Use this skill to compute Pokémon Champions damage ranges from the bundled NCP VGC Damage Calculator code. Prefer it over mental estimates whenever a team-building recommendation depends on a damage threshold.
Also use it for speed-line checks, especially when Choice Scarf, Tailwind, weather abilities, terrain abilities, paralysis, or speed stages affect matchup decisions.

## Quick Start

Run the CLI with JSON on stdin:

```powershell
@'
{
  "attacker": {
    "name": "Mega Metagross",
    "ability": "Tough Claws",
    "item": "Metagrossite",
    "nature": "Jolly",
    "sps": {"hp": 2, "at": 32, "df": 0, "sa": 0, "sd": 0, "sp": 32},
    "moves": ["Earthquake"]
  },
  "defender": {
    "name": "Mega Raichu Y",
    "ability": "No Guard",
    "item": "Raichunite Y",
    "nature": "Timid",
    "sps": {"hp": 2, "at": 0, "df": 0, "sa": 32, "sd": 0, "sp": 32},
    "moves": ["Zap Cannon"]
  },
  "move": "Earthquake",
  "field": {}
}
'@ | node scripts\ncp-calc-api.js
```

The output includes raw damage rolls, percent rolls, min/max percent, defender HP, and a calculator description.

Speed-line query:

```powershell
@'
{"name":"Mega Staraptor"}
'@ | node scripts\ncp-speedline-api.js
```

Speed table query:

```powershell
@'
{"filters":{"type":"Flying","speedMin":170},"limit":20}
'@ | node scripts\ncp-speedline-api.js table
```

## Workflow

1. Convert the matchup into calculator names in English, e.g. `Mega Staraptor`, `Archaludon`, `Mega Raichu Y`.
2. Use Champions stat points in `sps`: `hp`, `at`, `df`, `sa`, `sd`, `sp`; typical max investment is `32`.
3. Set nature names in English: `Jolly`, `Adamant`, `Timid`, `Modest`, `Bold`, `Careful`, etc.
4. Set relevant ability and item explicitly, especially for new Mega abilities.
5. Run one matchup with `node ...\ncp-calc-api.js`, or run a JSON array with `node ...\ncp-calc-api.js batch`.
6. For speed thresholds, run `node ...\ncp-speedline-api.js`, `batch`, or `table`.
7. Use results as a reference, not as a substitute for game-rule validation when mechanics are newly released.

## Input Details

Read `references/api.md` when you need field options, batch format, speed-line options, or example matchups.

Core input shape:

```json
{
  "attacker": {"name": "Mega Staraptor", "ability": "Contrary", "item": "Staraptorite", "nature": "Jolly", "sps": {"hp": 2, "at": 32, "df": 0, "sa": 0, "sd": 0, "sp": 32}, "moves": ["Close Combat"]},
  "defender": {"name": "Archaludon", "ability": "Stamina", "item": "Sitrus Berry", "nature": "Modest", "sps": {"hp": 2, "at": 0, "df": 0, "sa": 32, "sd": 0, "sp": 32}, "moves": ["Draco Meteor"]},
  "move": "Close Combat",
  "field": {"weather": "", "terrain": ""}
}
```

## Caveats

- This wrapper vendors the NCP VGC Damage Calculator formula/data files (see `references/upstream-LICENSE` for attribution); it does not reimplement the damage formula.
- It currently targets `gen = 10` / Pokémon Champions using Champions stat points.
- Use exact English species, move, item, and ability names from the NCP data. If a name fails, inspect the bundled `scripts/script_res/pokedex.js`, `move_data.js`, `move_data_za.js`, `item_data.js`, or `ability_data.js`.
- The wrapper is intentionally minimal: it computes direct damage ranges. It does not yet report full KO-chance text, residual damage sequencing, or UI-only advanced toggles unless represented in the JSON field options.
- The speed-line wrapper follows the Champions convention of level 50, default 31 speed IV, default 32 speed SPs, and default positive speed nature for table-style speedline checks.
