# NCP Damage Calculator API Reference

## Commands

Damage calculation:

```powershell
node scripts\ncp-calc-api.js --input calc.json
```

Batch calculation:

```powershell
node scripts\ncp-calc-api.js batch --input batch.json
```

`batch.json` is an array of the same objects accepted by one calculation.

Speed-line calculation:

```powershell
node scripts\ncp-speedline-api.js --input speed.json
```

Speed-line batch:

```powershell
node scripts\ncp-speedline-api.js batch --input speed-batch.json
```

Speed-line table:

```powershell
node scripts\ncp-speedline-api.js table --input speed-table.json
```

## Pokémon Object

Required:

- `name`: English NCP species/form name, e.g. `Mega Metagross`, `Mega Staraptor`, `Archaludon`.
- `moves`: one to four move names. The calculation uses `move` from the top-level input.

Recommended:

- `ability`: exact English ability name.
- `item`: exact English item name.
- `nature`: English nature name.
- `sps`: Champions stat points object: `hp`, `at`, `df`, `sa`, `sd`, `sp`.

Optional:

- `boosts`: stat stage object: `at`, `df`, `sa`, `sd`, `sp`.
- `status`: `Healthy`, `Burned`, `Poisoned`, etc.
- `curHP`: current HP as raw integer.
- `tera`: boolean.
- `teraType`: type name.

## Field Object

Supported common options:

```json
{
  "weather": "Rain",
  "terrain": "Electric",
  "attackerSide": {"helpingHand": true, "tailwind": true},
  "defenderSide": {"reflect": true, "lightScreen": true, "auroraVeil": true, "stealthRock": true, "spikes": 1}
}
```

Weather examples: `Rain`, `Sun`, `Sand`, `Snow`, or empty string.

Terrain examples: `Electric`, `Grassy`, `Psychic`, `Misty`, or empty string.

## Example: Mega Staraptor vs Archaludon

```json
{
  "attacker": {
    "name": "Mega Staraptor",
    "ability": "Contrary",
    "item": "Staraptorite",
    "nature": "Jolly",
    "sps": {"hp": 2, "at": 32, "df": 0, "sa": 0, "sd": 0, "sp": 32},
    "moves": ["Close Combat"]
  },
  "defender": {
    "name": "Archaludon",
    "ability": "Stamina",
    "item": "Sitrus Berry",
    "nature": "Modest",
    "sps": {"hp": 2, "at": 0, "df": 0, "sa": 32, "sd": 0, "sp": 32},
    "moves": ["Draco Meteor"]
  },
  "move": "Close Combat",
  "field": {}
}
```

## Output

```json
{
  "description": "32 Atk Mega Staraptor Close Combat vs. 2 HP / 0 Def Archaludon",
  "damage": [174, 176, "..."],
  "damagePercent": [104.2, 105.4, "..."],
  "min": 174,
  "max": 206,
  "minPercent": 104.2,
  "maxPercent": 123.4,
  "defenderHP": 167,
  "move": "Close Combat",
  "attacker": "Mega Staraptor",
  "defender": "Archaludon"
}
```

## Speed-Line API

Single input:

```json
{
  "name": "Mega Staraptor",
  "nature": "Jolly",
  "sps": {"sp": 32},
  "ivs": {"sp": 31},
  "boosts": {"sp": 0},
  "ability": "Contrary",
  "item": "",
  "status": "Healthy",
  "field": {"weather": "", "terrain": "", "tailwind": false}
}
```

Defaults match common speedline usage: `nature = Timid`, `sps.sp = 32`, `ivs.sp = 31`, no item, no ability, no field modifier. `Timid` and `Jolly` produce the same speed modifier; choose the nature that matches the actual set. Pass `ability` explicitly when a speed ability should apply, or set `useDefaultAbility: true` only when you intentionally want the NCP default ability inserted.

Single output:

```json
{
  "name": "Mega Staraptor",
  "types": ["Fighting", "Flying"],
  "baseSpeed": 110,
  "nature": "Timid",
  "speedSPs": 32,
  "speedIV": 31,
  "speedBoost": 0,
  "rawSpeed": 178,
  "boostedSpeed": 178,
  "finalSpeed": 178,
  "ability": "Contrary",
  "item": "",
  "status": "Healthy",
  "field": {"weather": "", "terrain": "", "tailwind": false, "swamp": false}
}
```

Table input:

```json
{
  "defaults": {"nature": "Timid", "sps": {"sp": 32}},
  "field": {"weather": "Sand"},
  "filters": {"type": "Ground", "speedMin": 200},
  "sort": "desc",
  "limit": 20
}
```

Supported table filters:

- `type` or `types`: require one or more exact English types.
- `mega`: `true` or `false`.
- `baseSpeedMin`, `baseSpeedMax`.
- `speedMin`, `speedMax`.

Speed modifiers are computed through the same bundled NCP functions used by the damage wrapper: stat stages, Choice Scarf, Iron Ball-style speed-halving items, Quick Feet, Slow Start, Chlorophyll, Swift Swim, Sand Rush, Slush Rush, Surge Surfer, Unburden, Tailwind, swamp, and paralysis.

The speedline implementation follows the Champions speedline convention for the current M-B context.

## Attribution

The bundled formula/data files under `scripts/script_res/` are the NCP VGC Damage Calculator core. See `references/upstream-LICENSE` for the license and contributor attribution.
