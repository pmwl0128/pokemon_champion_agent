# CLAUDE.md

> Optional starter for Claude Code using the Pokémon Champions skills.
> Copy to your project root to reinforce skill use. The skills also auto-trigger without it.

## Context
- Domain: **Pokémon Champions**, Regulation **M-B** (single & double). Default `season = M-3`.
- Champions differs from standard Pokémon (e.g. **SP** stat points, not EVs; its own Mega set and
  abilities). **Do not answer battle facts from memory** — call the skills; they hold the authoritative
  Champions data.

## Skills (call these for facts)
- **`pokemon-champions-dex`** — roster/types/stats/abilities/learnsets/items/Mega stones, trilingual
  names, reverse search.
- **`pokemon-champions-meta`** — usage rankings, sets (moves/items/abilities/natures/SP spreads),
  partners, single-vs-double. Metagame data is time-sensitive — refresh when freshness matters.
- **`ncp-damage-calculator`** — damage ranges, KO/survival, speed lines. Use it before any claim that
  depends on a KO, a survival, or an outspeed threshold.

## Rules
- **Call skills first** when you need any data; only search the web if a skill returns nothing.
- The skills emit **facts and exact calculations, not a strength score** — present them with their
  evidence and honor each output's confidence and season/rule.
