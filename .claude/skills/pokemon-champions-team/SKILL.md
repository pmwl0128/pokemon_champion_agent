---
name: pokemon-champions-team
description: Pokemon Champions single/double team building, legality validation, and team diagnostics. Use to parse a team (team-json or Showdown text), validate it against Champions rules (Species/Item Clause, SP caps, roster/learnset/item-pool legality, Mega form/stone match), diagnose coverage/speed/role gaps, analyze 6v6 selection, compare matchups vs the meta top-K (damage/speed/KO both ways), fine-tune SP/EV spreads to survival/speed/KO benchmarks (cliff detection), and retrieve candidate Pokemon to fill a diagnosed gap or diff a replacement's impact. Builds on the dex/meta/damage skills for all facts; holds no duplicate battle data. Also the home of the real-team sample library (tournament + ladder) used as factual reference, never as a synthetic strength score.
---

# Pokemon Champions Team

Build and review Pokemon Champions single and double teams. This skill is an **orchestrator**:
deterministic scripts emit verifiable facts and legality verdicts; strength trade-offs are left to the
model. It does **not** invent a "team strength score".

Facts always come from the sibling skills — this skill stores no duplicate battle data:

- `$pokemon-champions-dex` — roster, types, stats, abilities, learnsets, Mega stones, name resolution.
- `$pokemon-champions-meta` — usage / partners / spreads for the current season/rule.
- `$ncp-damage-calculator` — damage ranges, KO/survival, speed lines.

## Status

Route is M1–M5, risk-increasing (see `references/design.md` §13). M1–M4 are implemented; M5 step 1
(the representative-set query — up-to-3 real-team archetypes per species) and M5 step 2 (the opponent
standard-set matchup cache) are both done.

| Stage | CLI | State |
|---|---|---|
| M1 I/O + hard validation: team-json/Showdown, build-context, completeness, validate (incl item pool), owned | `team.py parse` / `validate [--context]` | implemented |
| M2 diagnose (evidence+confidence+reason) | `team.py diagnose [--aspect defense\|offense\|speed\|roles\|all]` | **defense + offense + speed + roles done** (offense models -ate skins, completeness-aware gaps; speed = landscape + control inventory; roles = objective functional signals + compression, no role labels/score) |
| M2 selection: 6-pick-3/4, one-Mega, form resolution, objective facts (no score) | `team.py select [--context]` | **v1 done** (speed-control deferred) |
| M2 matchup: each member vs meta top-K — exact speed, type, **we→them and them→us** ncp damage, speed_coverage; objective facts (no score) | `team.py matchup [--top-k N] [--context]` | **done** (precise them→us threat face ≥15% usage ∪ real-team joint; min–max + possible/guaranteed KO buckets; speed as field coverage) |
| M2.5 tune: SP fine-tuning as cliff detection — survival + join-speed + kill (ohko/2hko) + slack + nature lanes | `team.py tune --context ctx.json` | **done** (explicit `benchmarks`; SP×nature as bounded discrete lanes, never a top-ranked spread) |
| M3 candidates: multi-view ranking + replace-impact diff (no blended score) | `team.py fill` / `replace` | **done** (`fill` multi-view candidate pool; `replace` objective before/after diagnose diff) |
| M4 real-team library → opponent-set resolver (real joint ⊕ meta spread) | wired into `matchup`/`tune` | **done** (singles + doubles libraries ship as data; facts only, confidence-capped) |
| M5 step 1 representative sets: up-to-3 real-team (item,ability) archetypes per species, each with cluster/coverage/share/spread_origin/confidence; facts only, no score | `team.py repset <species> --game-format single\|double` | **done** (`representative_sets`; prevalence-ordered multi-view, fragmented fallback; spread from real co-occurring SP when source has one) |
| M5 step 2 opponent cache: precomputed standard-set matchup matrix over meta top-K (offense band/KO + speed line per ordered pair); cell low confidence (vs-standard-set) | `team.py oppmatrix [species] --game-format single\|double [--vs def]` | **done** (ships as data per format; attacker rows only for real-team-backed species; rebuilt by `update.py team-cache`; a reference grid, NOT your team) |

## Quick Start

```bash
# Parse a team from Showdown text or team-json into canonical team-json:
python scripts/team.py parse path/to/team.txt --format json

# Validate a team against Champions rules (uses the sibling dex skill for facts):
python scripts/team.py validate path/to/team.json
python scripts/team.py validate path/to/team.json --context path/to/context.json

# Diagnose defense / offense / speed / roles (accepts partial teams; --aspect picks one or all):
python scripts/team.py diagnose path/to/team.json
python scripts/team.py diagnose path/to/team.json --aspect roles

# Selection matrix: enumerate legal 6-pick-3 (singles) / pick-4 (doubles), one-Mega, objective facts:
python scripts/team.py select path/to/team.json --context path/to/context.json

# Matchup: each member vs the meta's most-used Pokemon (speed / type / we->them damage), no score:
python scripts/team.py matchup path/to/team.json --top-k 8

# Representative sets: a species' up-to-3 real-team (item,ability) archetypes by prevalence (facts,
# not a ranking; spread from real co-occurring SP when the source carries one):
python scripts/team.py repset Garchomp --game-format double

# Opponent matrix: the precomputed standard-set matchup grid over the meta top-K (offense band/KO +
# speed line per ordered pair). A reference grid, NOT your team — match a real team live via `matchup`.
# No species = whole matrix; a species = its attacker row; --vs = one (attacker -> defender) cell:
python scripts/team.py oppmatrix Garchomp --game-format single
python scripts/team.py oppmatrix Garchomp --game-format single --vs Mimikyu

# Session: run several operators on one team in ONE process (siblings stay resident — much faster
# than separate calls). The spec is a JSON list; output is a JSON list of {op, rc, result}:
#   [{"op":"validate","file":"team.json"},
#    {"op":"diagnose","file":"team.json"},
#    {"op":"matchup","file":"team.json","top_k":8},
#    {"op":"tune","file":"team.json","context":"ctx.json"}]
python scripts/team.py session path/to/spec.json
```

For a full build that runs validate + diagnose + matchup + tune + select on one team, prefer a single
`session` call: the dex / meta / ncp siblings are loaded once and reused, cutting wall-clock by ~70%
versus invoking each operator as its own process. Results are identical to the per-operator calls.

`--format md` (default) prints a readable report; `--format json` is for programmatic use.

## Data

- `data/teams/` — **real-team sample library** (tournament + ladder), one `<season>_<format>.jsonl`
  per context, each line a `team-json`. This is **factual reference** (cores, performance metadata),
  never a synthetic strength score. It **ships as a snapshot** (facts-only: source identifiers and
  PII are stripped — see `references/schema.md` §2); the maintainer refreshes it via the private
  `dev/update/team/` pipeline, not at query time.
- `data/opponent_cache/` — **opponent standard-set matchup cache** (M5 step 2), one
  `<season>_<format>.json` per context: a precomputed standard-vs-standard grid over the meta top-K
  (offense band/KO + speed line per ordered pair). Every cell is **low** confidence
  (`vs-standard-set`) — a reference grid, never your team. Served as the current environment (design
  §9); the maintainer rebuilds it via `dev/update/update.py team-cache`. Read via `team.py oppmatrix`.
- The skill ships query/validation scripts; it does **not** regenerate dex/meta/damage data.

Read `references/design.md` for the full design (philosophy, L1/L2/L3 operators, precomputed
matchup cache, representative-set algorithm, iterative loop) and `references/schema.md` for the
`team-json` structure, the multi-source data pipeline, persistence layout, and cache contracts.

## Principles

- Deterministic facts only; the model decides strength. Never emit a single team-strength number.
- Real performance data (records, placings, ladder rating) is kept as **fact tags** with provenance,
  not normalized into a score, and **never merged across single/double** (different metagames).
- Old-regulation data (M-A and earlier) is always labeled and never treated as current.
