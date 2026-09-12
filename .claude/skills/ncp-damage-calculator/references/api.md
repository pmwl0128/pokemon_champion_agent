# NCP Damage Calculator API Reference

This reference explains supported inputs and common examples. The executable contracts are
authoritative: run `python scripts/ncp-calc-api.py schema` and
`python scripts/ncp-speedline-api.py schema` before constructing unfamiliar payloads. (Install the
preferred runtime with `python -m pip install -r requirements.txt`. The Python CLIs host the vendored
NCP JavaScript in-process via `quickjs-ng` — no Node needed; without it the
same Python entries automatically delegate to the Node CLIs `node scripts/ncp-calc-api.js`, whose
calculation/query results are identical. Each `schema` truthfully names its own runtime entry.)

## Contents

- [Commands](#commands)
- [Pokémon Object](#pokémon-object)
- [Field Object](#field-object)
- [Damage Example](#example-mega-staraptor-vs-archaludon)
- [Damage Output](#output)
- [Speed-Line API](#speed-line-api)
- [Attribution](#attribution)

## Commands

Damage calculation:

```powershell
python scripts\ncp-calc-api.py --input calc.json
```

Batch calculation:

```powershell
python scripts\ncp-calc-api.py batch --input batch.json
```

`batch.json` is an array of the same objects accepted by one calculation.

Name resolution (align a dex-canonical or typed name to the exact NCP pokedex key — case/space/hyphen-insensitive, with did-you-mean candidates on a miss; never hand-scan the data files):

```powershell
'["garchomp","Rotom Wash","Mega Charizard X"]' | python scripts\ncp-calc-api.py resolve
```

Returns a 1:1 list `[{query, ok, name, match: exact|normalized}]`, or `{ok:false, error, suggestions}` on a miss; feed the returned `name` back to `one`/`batch`. Both CLIs also emit their full contract via `python scripts\ncp-calc-api.py schema` (and `ncp-speedline-api.py schema`).

Speed-line calculation:

```powershell
python scripts\ncp-speedline-api.py --input speed.json
```

Speed-line batch:

```powershell
python scripts\ncp-speedline-api.py batch --input speed-batch.json
```

Speed-line table:

```powershell
python scripts\ncp-speedline-api.py table --input speed-table.json
```

## Pokémon Object

Required:

- `name`: English NCP species/form name, e.g. `Mega Metagross`, `Mega Staraptor`, `Archaludon`.
- `moves`: one to four move names. The calculation uses `move` from the top-level input.

Recommended:

- `ability`: exact English ability name.
- `item`: exact English item name.
- `nature`: English nature name.
- `sps`: Champions stat points object with the canonical smogon keys `hp`, `atk`, `def`, `spa`, `spd`, `spe` (`spe` = Speed, `spa` = Special Attack). The legacy short keys `at/df/sa/sd/sp` are still accepted but not recommended.

Optional:

- `boosts`: stat stage object: `atk`, `def`, `spa`, `spd`, `spe` (legacy `at/df/sa/sd/sp` also accepted).
- `status`: `Healthy`, `Burned`, `Poisoned`, etc.
- `curHP`: current HP as raw integer.
- `tera`: boolean.
- `teraType`: type name.
- `abilityOn`: whether a conditionally-activated ability has already triggered. Most abilities default
  to active. The ones whose trigger a single damage frame cannot observe default to inactive, matching
  the upstream calculator's unchecked toggles: Flash Fire, Plus, Minus, Trace, Stakeout, Sand Spit,
  Battle Bond, Electromorphosis, Wind Power and Seed Sower. Pass `true` to model them as active.

## On-Field State

Before the damage frame is computed the wrapper resolves the state both Pokémon bring onto the field,
so these do not have to be pre-baked into `boosts`, `item`, `ability` or the field:

- copied and suppressed abilities (Trace, Neutralizing Gas, Klutz),
- type changes from Mimicry, Forecast and Terastallization,
- weather suppression from Air Lock and Cloud Nine,
- terrain seeds, Protosynthesis and Quark Drive, Intrepid Sword and Dauntless Shield, Wind Rider,
  Download, Embody Aspect and Battle Bond,
- Infiltrator ignoring the defender's screens,
- Heavy Metal, Light Metal and Float Stone feeding the weight-based base powers,
- the item, field and status modifiers on Speed that the speed-ratio moves read.

The two switch-in effects that move the **other** side's stat stages, Intimidate and Supersweet Syrup,
are also resolved. Set the top-level `switch_in_drops` to `false` when the caller already encodes that
drop in `boosts`, otherwise it is counted twice. Nothing else on the list is switchable.

## Field Object

Supported common options:

```json
{
  "weather": "Rain",
  "terrain": "Electric",
  "attackerSide": {"helping_hand": true, "tailwind": true},
  "defenderSide": {"reflect": true, "light_screen": true, "aurora_veil": true, "stealth_rock": true, "spikes": 1}
}
```

Side-option keys are canonically snake_case. The wrapper accepts legacy camelCase spellings for
compatibility, but new callers should emit the canonical form shown above.

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
    "sps": {"hp": 2, "atk": 32, "def": 0, "spa": 0, "spd": 0, "spe": 32},
    "moves": ["Close Combat"]
  },
  "defender": {
    "name": "Archaludon",
    "ability": "Stamina",
    "item": "Sitrus Berry",
    "nature": "Modest",
    "sps": {"hp": 2, "atk": 0, "def": 0, "spa": 32, "spd": 0, "spe": 32},
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
  "sps": {"spe": 32},
  "ivs": {"spe": 31},
  "boosts": {"spe": 0},
  "ability": "Contrary",
  "item": "",
  "status": "Healthy",
  "field": {"weather": "", "terrain": "", "tailwind": false}
}
```

Defaults match common speedline usage: `nature = Timid`, `sps.spe = 32`, `ivs.spe = 31`, no item, no ability, no field modifier. `Timid` and `Jolly` produce the same speed modifier; choose the nature that matches the actual set. Pass `ability` explicitly when a speed ability should apply, or set `useDefaultAbility: true` only when you intentionally want the NCP default ability inserted.

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
  "defaults": {"nature": "Timid", "sps": {"spe": 32}},
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

The speedline implementation follows the Champions speedline convention for the active rule data.

## Attribution

The bundled formula/data files under `scripts/script_res/` are the NCP VGC Damage Calculator core. See `references/upstream-LICENSE` for the license and contributor attribution.
