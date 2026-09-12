---
name: ncp-damage-calculator
description: Run Pokémon Champions damage and speed-line calculations using the bundled NCP VGC Damage Calculator formulas. Use when the request asks for a concrete damage, KO, survival, or speed-order calculation between specified Pokémon, moves, spreads, field states, items, abilities, or stat stages. For broad team-building or tuning, use the team skill first and let it delegate exact calc checks. Chinese examples include "X用Y打Z多少", "X能确一/二确Z吗", "Z吃得下X的Y吗", "X快过Z吗", "多少SP能快过/抗住". English examples include "calc X's move into Y", "does this OHKO/2HKO", "can Y survive this hit", "does X outspeed Y", "what spread reaches this benchmark". Japanese examples include "XのYでZにどれくらい入る？", "確定一発/二発？", "ZはYを耐える？", "XはZを抜ける？", "このラインに必要なSPは？".
---

# NCP Damage Calculator

Compute Pokémon Champions damage ranges and speed lines with the bundled NCP VGC Damage Calculator
core. Use exact calculations whenever a claim depends on damage, KO, survival, or move order.

## Workflow

1. Resolve Chinese or Japanese names through `$pokemon-champions-dex`; the NCP wrapper itself uses
   English calculator keys.
2. Run the wrapper's `resolve` command to align canonical English names to exact NCP keys.
3. Supply the actual item, ability, nature, SP spread, stat stages, status, and relevant field state.
4. Use the damage API for a concrete attack, or the speed API for one Pokémon, a table, or a direct
   comparison.
5. Report assumptions with the result. A successful calculation does not establish Champions legality.

## Damage

Run one calculation with JSON on stdin or use `batch` with a JSON array:

```powershell
@'
{
  "attacker": {
    "name": "Mega Metagross",
    "ability": "Tough Claws",
    "item": "Metagrossite",
    "nature": "Jolly",
    "sps": {"hp": 2, "atk": 32, "def": 0, "spa": 0, "spd": 0, "spe": 32},
    "moves": ["Earthquake"]
  },
  "defender": {
    "name": "Mega Raichu Y",
    "ability": "No Guard",
    "item": "Raichunite Y",
    "nature": "Timid",
    "sps": {"hp": 2, "atk": 0, "def": 0, "spa": 32, "spd": 0, "spe": 32},
    "moves": ["Zap Cannon"]
  },
  "move": "Earthquake",
  "field": {}
}
'@ | python scripts\ncp-calc-api.py
```

The result includes all rolls, percentage rolls, min/max values, defender HP, and the calculator
description.

## Speed

Query one speed line:

```powershell
@'
{"name":"Mega Staraptor"}
'@ | python scripts\ncp-speedline-api.py
```

Query a filtered table or compare two complete speed states. `compare` also reports move order under
Trick Room:

```powershell
@'
{"filters":{"type":"Flying","speedMin":170},"limit":20}
'@ | python scripts\ncp-speedline-api.py table
@'
{"a":{"name":"Garchomp","nature":"Jolly","sps":{"spe":32}},
 "b":{"name":"Archaludon","nature":"Modest","item":"Choice Scarf","sps":{"spe":32}}}
'@ | python scripts\ncp-speedline-api.py compare
```

## Name Resolution

Do not scan vendored data files manually. Resolve calculator keys through the CLI; `--kind` defaults
to `pokemon`:

```powershell
'["garchomp","Rotom Wash","Mega Charizard X"]' | python scripts\ncp-calc-api.py resolve
'["close combat","earthquake"]'                | python scripts\ncp-calc-api.py resolve --kind move
'["choice scarf","lifeorb"]'                   | python scripts\ncp-calc-api.py resolve --kind item
'["roughskin","intimidate"]'                   | python scripts\ncp-calc-api.py resolve --kind ability
```

## Contract

Treat the executable schemas as authoritative for commands, input fields, output fields, and errors:

```powershell
python scripts\ncp-calc-api.py schema
python scripts\ncp-speedline-api.py schema
```

Read `references/api.md` when field options, batch shapes, speed modifiers, or a complete example are
needed. It is explanatory documentation, not a second contract.

## Caveats

- The wrapper vendors, rather than reimplements, the NCP core. Attribution and its upstream license
  are in `references/upstream-LICENSE`.
- The Python CLIs host that vendored JavaScript in-process via `quickjs-ng`
  (`python -m pip install -r requirements.txt`),
  so no Node runtime is needed. If quickjs-ng is not installed, those same Python entries automatically
  delegate to the Node CLIs (`node scripts\ncp-calc-api.js` / `ncp-speedline-api.js`); calculation and
  query results are identical.
- It targets Pokémon Champions at level 50 with Champions stat points; canonical keys are
  `hp/atk/def/spa/spd/spe`.
- NCP contains entries beyond the Champions-legal roster. Use `$pokemon-champions-team` or the dex for
  legality.
- On-field state is resolved before the damage frame: Intimidate, terrain seeds, Trace, Air Lock,
  Infiltrator, weight and paradox abilities all apply on their own. Pass `switch_in_drops: false`
  when the caller already encodes Intimidate in `boosts`. See `references/api.md`.
- Damage results model the fields exposed by the API, not every possible residual or multi-turn effect.
- Speed defaults are 31 Speed IV, 32 Speed SP, and a positive Speed nature unless explicitly replaced.
