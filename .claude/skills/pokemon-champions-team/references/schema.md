# Pokemon Champions Team — Schema & Data Pipeline Design

## 1. `team-json` (the canonical team structure)

One team. Used for both validation input and as the unit stored in the sample library.

```json
{
  "schema_version": 1,
  "format": "single",                 // "single" | "double"
  "season": "M-3",                    // nullable for a hand-built team
  "rule": "M-B",                      // nullable for a hand-built team
  "pokemon": [
    {
      "species": "Staraptor",         // dex canonical English name (Mega forms: "Mega Staraptor")
      "item": "Staraptite",           // null if none
      "ability": "Intimidate",
      "moves": ["Close Combat", "Dual Wingbeat", "Protect", "Roost"],
      "nature": "Jolly",              // null if unknown
      "spread": {"hp":0,"atk":32,"def":0,"spa":0,"spd":0,"spe":32},  // SP (Champions), null if unknown
      "tera": null,                   // Champions has no Terastal; kept null for forward-compat
      "completeness": "observed_full_set"  // observed_full_set | observed_species_only | extracted_set | inferred_set (design.md §8)
    }
  ],
  "provenance": null                  // null for hand-built; object below for collected real teams
}
```

Field notes:
- `species` / `item` / `ability` / `moves` use **dex canonical English** so validation and cross-checks
  against `$pokemon-champions-dex` are exact. Limitless decklist `id` (e.g. `staraptor`) maps here.
- `spread` is **SP** (Stat Points), not EVs: each stat 0–32, total ≤66. `nature` applies the ±10%.
- `tera` exists only so importers can round-trip foreign formats; Champions never uses it.
- `completeness` separates two evidence lanes. `observed_species_only` means the slot is only a
  presence/co-occurrence fact (useful for core/sample views); it is **not** a set template. A member is
  eligible for `repset` / opponent resolver / opponent cache only when it is tagged
  `observed_full_set` **and** actually carries `species + ability + nature + moves`.
  `spread` is optional for template eligibility because some real sources expose a joint set but no SP
  spread; those consumers fall back to meta spread instead of inventing one.
  `item` is held to a **team-level** rule (audit 2026-06-26): a member with no item is still
  template-eligible when its team carries items elsewhere (a deliberate no-item build — Acrobatics /
  Unburden — must not be silently dropped), but a team where **every** member is itemless is treated as
  an items-not-captured extraction, so none of its members are template-eligible.

## 2. `provenance` (real-team fact tags — never a strength score)

Attached when a team is collected from a real source. Hand-built teams have `provenance: null`.

```json
{
  "source": "limitless",            // limitless | pokedb | rk9 | limitlessvgc | manual | ...
  "source_id": "6a0f033edfbdf089cbbde57a",
  "source_url": "https://play.limitlesstcg.com/tournament/.../standings",
  "fetched_at": "2026-06-19T00:00:00Z",
  "performance": {
    "kind": "tournament",           // "tournament" | "ladder"
    "record": {"wins": 6, "losses": 1, "ties": 0},  // Limitless returns this object; null otherwise
    "placing": 1,                   // from standings order if the API omits it; else null
    "field_size": 37,               // entrants (evidence weight), else null
    "rating": null                  // ladder rating e.g. 2422.626 (singles), else null
  },
  "player": {"name": "...", "country": "PH"}
}
```

> **Two provenance schemas — build-time (raw) vs shipped (facts-only).** The block above is the
> *build-time* provenance, which exists in TWO dev-side places only (both under `.cache`, gitignored,
> never shipped): the **build-state** `teams_raw/*.jsonl` (admitted teams, full provenance — the
> incremental dedup/admission input the pipeline reads back) and the **quarantine** (rejected teams +
> reasons). The **shipped** `*.jsonl` is a pure FACTS-ONLY projection: the pipeline keeps only
> `provenance.performance` (the fact-tags) + `fetched_at`; `source` / `source_url` / `source_id` /
> `player` / event titles are stripped before writing it. `index.json` likewise carries counts, no
> sources. **The shipped library is never read back as pipeline input** — doing so would collapse every
> team to one `(source,source_id,player)` dedup key and quarantine the whole library as "missing
> provenance" (that is exactly why the build-state exists; audit 2026-06-25).

**Rules for `performance`** (see plan §4.5):
- It is **fact**, surfaced as context ("6-1 in a 37-player M-B event", "ladder rating 2422"),
  **not** normalized into a single number.
- **Never merge across formats**: singles ladder `rating` and doubles tournament `record` are
  different metagames and different confounders. Keep them separate; if ranking, use an *ordered
  evidence tier*, not a blended score.

## 3. Persistence layout (multi-season × multi-format × multi-source)

The data layer is **not** tied to today's two sources. It is a stable shape that absorbs:
new seasons (M-1/M-2/M-3/…), both formats, and new sources (online tournaments, official events
via rk9/limitlessvgc, ladder construction sites, future sources).

```text
.cache/pokemon-champions-team/teams_raw/   # BUILD-STATE (dev-only, gitignored, full provenance)
  <season>_<format>.jsonl                   #   admitted teams WITH source/source_id/player — dedup input
data/teams/                                 # SHIPPED (tracked + published, FACTS-ONLY)
  index.json                                #   manifest: per (season, format) -> {season, format, count}
  <season>_<format>.jsonl                   #   one facts-only team-json per line (source/PII scrubbed)
```

- **One JSONL per (season, format)** in each tree. In the **build-state**, multiple sources coexist in
  one file, distinguished by `provenance.source`, and `dedup key = (source, source_id, player)`. In the
  **shipped** file those identifiers are gone — it is a facts-only projection (composition + performance
  fact-tags + `fetched_at`), so it carries no `source` to query or dedup on. Filter shipped data by
  `season` + `rule` + `format` + `performance`; the build-state additionally has `source`.
- This scales to M-1/M-2 singles tournaments, future official doubles data, etc. Old regulations remain
  queryable but are labeled by their `season/rule` and never treated as current.
- The build-state is append-only friendly (real dedup keys); the shipped file is rewritten as a
  projection on every refresh and **must not** be fed back into the pipeline (audit 2026-06-25).

## 4. Source pipeline design (private, under `dev/update/team/`)

Each source is an **adapter** that yields canonical `team-json` with `provenance`. A registry maps
source name → adapter, so adding a source (e.g. official rk9 doubles) is a self-contained drop.

```text
dev/update/team/
  base.py        # Source ABC: fetch(season, rule, fmt) -> Iterable[team-json]; name; formats; seasons
  registry.py    # name -> Source; update.py iterates selected sources
  sources/
    limitless.py # doubles online tournaments (play.limitlesstcg API; M-B via name+date heuristic)
    pokedb.py    # singles ladder constructions (champs.pokedb.tokyo top layer + blog LLM extract)
    # rk9.py / limitlessvgc.py  # official events — added when M-B official data exists
  pipeline.py    # dedup + provenance stamp + season/format routing + throttle + write JSONL/index
```

Cross-source reconciliation follows the Analyzer `meta_ingest/reconcile.py` ethic: an authoritative
source per slice, **directional** agreement checks (not exact-percentage), provenance stamping, and
honest recording when a source is unavailable. Strength signals are never blended into one number.

### Known source facts to honor (2026-06-19)

- **Doubles, current M-B**: `play.limitlesstcg.com` API (no key; one `/standings` call yields full
  6-mon decklists + `record`/`placing`; M-B is **not** a format enum — detect via `date>=2026-06-17`
  + name contains M-B). Rate limit 50/5min.
- **Doubles, future**: official events (Worlds etc.) via **rk9.gg** / `limitlessvgc.com` once M-B is
  used officially (current big events are still M-A).
- **Singles**: ladder constructions are player-published. `champs.pokedb.tokyo` (current Season M-3,
  has trainer/rank/`rating`, `?rule=` filter, crawlable) for the top layer; full sets link out to
  Hatena/note blogs (LLM extraction, on demand). Earlier singles seasons (M-1/M-2) also have events.
- More sources may be added later; the adapter+registry shape is built to absorb them.

## 5. Representative sets (cache input — see design.md §10)

> ✅ **M5 step 1 done** (design.md §10): the query side is live — `team.py repset <species> --game-format
> single|double` returns up to 3 real-team `(item,ability)` archetypes via `repset.representative_sets`.
> Every emitted set carries `cluster / coverage / share / species_sample / species_sample_total /
> item_filter / spread_origin / confidence`.
> ✅ **M5 step 2 done too** — the matchup cache built on top of these standard sets is live; see §6.

The **live `repset` shape** (one archetype object, ncp-key spread): `species`, `format`, `source:
"real-team"`, `ability`/`item`/`nature`/`moves` (the co-occurring joint set), `cluster:
{item,ability}` (the cluster key; `null` + `fragmented:true` on the no-dominant-archetype fallback),
`sps` (real co-occurring SP spread in ncp keys, or `null` when the source has none → use meta spread),
`spread_origin: "real-team" | null`, `count`/`sample` (modal-set count within the cluster / cluster
size), `share` (count/sample within cluster), `coverage` (cluster size / **the queried pool** —
`species_sample`; **`null` on the fragmented fallback** — it is a whole-pool entry, not a cluster
covering 100%, so the honest figure is `share`), `species_sample` (the queried pool size: the
**item-filtered subpool** when `item_filter` is set, e.g. a doubles Mega isolated by its stone — NOT the
whole base species), `species_sample_total` (the whole-species count, == `species_sample` unless an
item filter narrows the pool), `item_filter` (the item the pool was filtered to, or `null`),
`confidence` (sample-size ∧ modal-share folded). When `item_filter` is set, read `coverage`/
`species_sample` against the filtered pool, never as base-species coverage (audit 2026-06-26). The blueprint object below predates this and
uses the cache's flattened `set_id`/`origin`/`meta_version` framing — kept for the §6 cache contract.

> **CLI canonicalization (audit 2026-06-25)**: `team.py repset <species>` resolves the raw species via
> dex first (Chinese/Japanese aliases → canonical English) so the library's English keys match. Mega
> resolution is **format-aware**: the doubles source stores a Mega as base + stone (CLI queries the base
> with an `item_filter = required_item`), the singles source stores the `Mega X` species directly (used
> as-is). The output `query` block echoes `{species, resolved, item_filter}` for transparency.
>
> **Historical-season provenance (audit 2026-06-26)**: `repset --season <old>` reads that season's
> PARTITION of the real-team library (the library is partitioned by season+format), so the `environment`
> stamp records `data_season`/`data_rule` as the data's real provenance instead of mislabeling it as the
> current base. A historical partition does NOT emit the "computed against the current base" warning
> (that warning is for the current-only dex/meta bases). `data_rule` is `null` for older seasons (the
> library tracks rule only implicitly per file — it is not fabricated).

Per meta member, 1–3 representative sets derived from real teams (joint sets) + meta usage (SP fill).
Only template-eligible members enter these counts: `observed_full_set` plus real
`species/ability/item/nature/moves` fields. Presence-only rows, extracted/inferred rows, and mislabeled
rows with missing set fields remain available to presence/co-occurrence consumers but do not inflate
`sample`, do not trigger singles Mega run-form remapping, and do not create opponent-cache attacker rows.

```json
{
  "species": "Charizard",            // dex canonical, form-specific
  "format": "double",
  "meta_version": "M-3_double_2026-06-19",
  "sets": [
    {
      "set_id": "charizard-y-sun",
      "item": "Charizardite Y", "ability": "Drought",
      "moves": ["Heat Wave", "Solar Beam", "Protect", "Tailwind"],
      "nature": "Modest",
      "spread": {"hp":4,"atk":0,"def":0,"spa":32,"spd":0,"spe":30},
      "origin": "mixed",             // real-team | usage | mixed (moves real, SP usage)
      "spread_origin": "usage",      // real-team | real-team-blog | usage  (the live resolver emits
                                     // real-team when a source carries a co-occurring spread, e.g.
                                     // yakkun singles; usage when the spread is a meta marginal)
      "sample_size": 24,             // teams in this archetype group
      "coverage": 0.62,              // fraction of this species' real usage this set covers
      "confidence": "high"           // high | low (per design.md §8 Step 4)
    }
  ]
}
```

## 6. Opponent standard-set matchup cache (M5 step 2 — LIVE; design.md §9/§10)

> ✅ **Done (2026-06-25)**: `team.py oppmatrix [species] --game-format single|double [--vs def]` reads
> a precomputed standard-vs-standard grid over the meta top-K. Built by `dev/update/update.py
> team-cache` (read side + pure `build_matrix` in `scripts/oppcache.py`); ships as
> `data/opponent_cache/<season>_<format>.json`. The blueprint that originally lived here (cells keyed by
> `set_id`, `ko` probability dict, tailwind speeds) is superseded by the LIVE shape below.

The **live cache shape** — the matrix is keyed by dex-canonical **species** (not synthetic set_ids):

```json
{
  "kind": "opponent-cache",
  "built_for": {"season": "M-3", "rule": "M-B", "format": "single",
                "built_at": "2026-06-25T...Z", "top_k": 20},
  // The skill serves only the CURRENT environment; rebuilt by update/ on a base refresh / rule switch.
  // Queries assume it is current — NO multi-version staleness check at query time (design.md §9).
  "species": [{"rank": 7, "species": "Staraptor", "real_team_backed": true,
               "set_source": "real-team", "set_confidence": "low",
               "run_form": "Mega Staraptor"}],     // run_form: present when the form actually run differs
                                                    // from the meta key (singles Mega ranked under base)
  "sets": {"Staraptor": {"species": "Mega Staraptor",  // the REAL run form (calc used its stats)
                        "ability": "...", "item": "...", "nature": "...",
                        "moves": ["..."],          // the real joint set — null for defender-only species
                        "sps": {"hp": 32, "df": 25}, "source": "real-team",
                        "confidence": "low", "real_team_backed": true, "note": "..."}},
  "matrix": {                                       // matrix[attacker][defender] = ordered-pair cell
    "Garchomp": {
      "Mimikyu": {
        "offense": {"move": "Earthquake", "min_percent": 64.4, "max_percent": 77.3,
                    "ko_possible": 2, "ko_guaranteed": 2, "ko": "2HKO (static approx)",
                    "ko_exact": false, "ko_chance": {...}, "ko_caveats": [...],
                    "disguise_adjusted": {           // ONLY when the defender's ability is Disguise:
                      "effective_ko_possible": 3,    // 1 blocked turn + ceil(remaining 87.5% / per-turn
                      "effective_ko_guaranteed": 3,  // band) — NOT nominal+1 (the 1/8 break-chip can KO
                      "note": "..."}},               // sooner). Labelling exception, not an engine
                                                     // recompute (design §7); read this vs Mimikyu.
        "speed": {"attacker": 122, "defender": 148, "faster": "defender"}
      }
    }
  },
  "confidence": "low", "confidence_reason": "vs-standard-set",   // EVERY cell, stated once at top
  "notes": ["..."]
}
```

- One file per `(season, format)`; the two metagames are never mixed. Built from the meta usage ranking
  (the opponent universe), the real-team library, dex facts, and one batched ncp call. Per-format top-k
  (single 50 / double 60) — the libraries differ ~50x in density (design §15 Q5).
- **Singles Mega names are resolved to the form actually run** in the shared resolver
  (`sources._rep_for` → `repset.dominant_form`): meta ranks a singles Mega under the BASE name but the
  library stores `Mega X`, so the resolved set keeps `species` = the meta label and adds `run_form` =
  the real Mega; the calc/speed/types use `run_form`. Fixed in the resolver, so **`matchup` gets the
  same correction** (its cells carry `opponent_run_form`). Audit 2026-06-25.
- **Auto-rebuilt** after any base refresh: `update.py {meta,dex,ncp,all}` rebuilds the cache once
  (`--no-cache` to skip) since it is a derived artifact of those bases (design §9); recompute is local.
- **Attacker rows exist ONLY for real-team-backed species** (a real co-occurring 4-move set, sample ≥
  `MIN_SAMPLE`). A meta-only species has no real joint move set — meta marginals can't be stitched into
  one (design §10 trap ①) — so it appears as a **defender only** (`real_team_backed:false`, `moves:null`).
  This is the literal "build a cell only for species clearing `MIN_SAMPLE`" (design §15 Q5).
- `offense` reuses the live `matchup` damage fact (full roll band + possible/guaranteed KO buckets;
  only OHKO exact, 2+ turn KO is a static approximation flagged `ko_caveat`). `speed` is the modal line.
- **Cells are ALWAYS `low` confidence** (`vs-standard-set`): a reference grid of standard sets, NOT the
  user's team. The user's own matchup is always computed LIVE via `team.py matchup` on actual sets.

## 7. build-context (intent layer — design.md §5)

The AI translates the conversation's intent into this structured object and passes it with `team-json`.
It is **structured constraints, not natural language** — the skill never parses free text.

```json
{
  "season": "M-3", "rule": "M-B", "format": "double",
  "locked": ["Garchomp"],                 // members the user will not change
  "owned_only": true,                     // restrict to the owned roster
  "owned": ["Garchomp", "Whimsicott"],    // owned species (canonical or dex-resolvable); AI fills from
                                          // pokemon_owned.md (team_io.read_owned helper) or resolves itself
  "wants": ["tailwind"],                  // desired tactics: weather/trickroom/tailwind/...
  "keep_mega": "Garchomp",                // a Mega to preserve, if any
  "avoid": [],                            // species/items the user wants excluded
  "need": {                               // L3 `fill` gap spec (design §6/§13 M3); AI translates a
    "resist": "Water",                    //   diagnosed gap. Keys (AND-combined): resist (type|[types]),
    "offense_type": "Fire",               //   offense_type (type|[types], STAB/typing proxy = own type),
    "coverage_move_type": "Ice",          //   coverage_move_type (type|[types]; REAL learnset damaging
                                          //     move of that type via dex move->type bridge; each match
                                          //     flags stab — non-STAB coverage is worth far less than STAB),
    "role": "speed_control",              //   role (pivot/hazard_set/hazard_control/speed_control/...),
    "min_speed": 120                      //   min_speed (int, max-Spe +nature line must reach it)
  },
  "replace": {                            // L3 `replace`-impact (design §6/§13 M3): objective before/
    "member": "Rotom-Wash",               //   after diff of swapping a member for a CONCRETE candidate
    "with": {"species": "Incineroar", "ability": "Intimidate", "item": "Sitrus Berry",
             "nature": "Careful", "spread": {"hp": 32, "spd": 16},
             "moves": ["Flare Blitz", "Parting Shot", "Fake Out", "Knock Off"]}
  },
  "benchmarks": [                         // SP fine-tuning targets (design.md §16); AI translates intent
    {"member": "Incineroar", "kind": "survive",  "vs": "Garchomp", "move": "Earthquake",
     "conditions": {"stealth_rock": false}, "probability": "guaranteed"},
    {"member": "Garchomp",   "kind": "outspeed", "vs": "Dragapult", "conditions": {"tailwind": false}}
    // kind: survive | outspeed | ohko | 2hko ; vs = canonical species (or a raw Speed number for outspeed);
    // conditions are applied when set explicitly here; probability: guaranteed | likely | any
  ]
}
```

`benchmarks` is the entry point for the `tune` operator (design.md §16). Each is a declarative
**cliff target**; `tune` reports the minimum SP to cross it (or the slack if already past), never a
single "optimal spread". `conditions` keys (stealth_rock / tailwind / trickroom / weather / terrain /
screens) are **applied only when explicitly set here** — the user's request always wins. The format's
`context_profile` informs ranking and which contexts are worth probing by default, but it never
silently turns a condition on or off in a damage/speed calc. Notes:
- `weather` takes a named string (e.g. `"rain"`); `screens` takes `true` (the calc picks Reflect vs
  a physical hit, Light Screen vs a special one) or an explicit `"reflect" | "light_screen" | "aurora_veil"`.
- `terrain` takes a named string (e.g. `"electric"`); it triggers a terrain-keyed Speed ability in an
  `outspeed` cliff (Surge Surfer x2 under Electric Terrain), the terrain analogue of `weather`.
- `tailwind: true` doubles your Speed in an `outspeed` cliff; `trickroom: true` inverts the speed
  objective, so an `outspeed` cliff is reported `skipped` (not modelled in v1) rather than misleading.

> **Executable contract (2026-06-21)**: this schema is enforced in code by `scripts/contracts.py`
> (stdlib-only, no pydantic), not just documented here. It validates team-json, build-context, and
> benchmarks — enumerated `format`/`kind`/`probability`/`completeness`/`conditions`/`screens`, the
> `vs` raw-Speed-only-for-outspeed rule, and `schema_version` (supported: 1) — returning coded
> `ContractError`s (`E_TYPE`/`E_ENUM`/`E_MISSING`/`E_RANGE`/`E_SCHEMA_VERSION`/`W_*`). `team.py`
> runs it at the CLI boundary: `validate` reports contract errors alongside legality, `tune` refuses
> a malformed build-context. Keep this doc and `contracts.py` in sync.

## 8. evidence (output-side, lightweight — design.md §7)

Every diagnose / candidate / key-calc result carries an `evidence` block so the AI's claims
("why this", "handles whom", "outspeeds whom") are traceable. This is NOT champions-data's claims-json
protocol (no forced AI output format, no retry loop) — it is the skill attaching its sources to its own output.

```json
{
  "result": "...",                        // the fact/verdict
  "confidence": "low",                    // high | medium | low
  "confidence_reason": "vs-standard-set", // small-sample | sp-inferred | cache | heuristic-role | vs-standard-set | null
  "evidence": {
    "facts": [{"source": "dex", "ref": "Garchomp.types", "value": ["Dragon", "Ground"]}],
    "calc": {"source": "ncp", "inputs": {"attacker": "...", "defender": "...", "move": "..."}, "result": "..."}
  }
}
```

