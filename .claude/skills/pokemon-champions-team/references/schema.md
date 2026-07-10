# Pokemon Champions Team Public Data Contracts

This reference documents durable domain objects and the bundled facts-only caches needed by an
installed skill. It intentionally excludes source adapters, refresh procedures, tests, and private
development history. Run `python scripts/team.py schema` for the authoritative live command and
payload contract; run `python scripts/team.py vocab` for enumerated intent fields and their consumers.

## Contents

- [`team-json`](#1-team-json-the-canonical-team-structure)
- [`provenance`](#2-provenance-real-team-fact-tags--never-a-strength-score)
- [Shipped library layout](#3-shipped-library-layout)
- [Representative sets](#4-representative-sets)
- [Opponent matchup cache](#5-opponent-standard-set-matchup-cache)
- [`build-context`](#6-build-context-intent-layer)
- [Evidence](#7-evidence-output-side-lightweight)
- [Frame](#8-frame-assembly-front-door)

## 1. `team-json` (the canonical team structure)

One team. Used for both validation input and as the unit stored in the sample library.

```json
{
  "schema_version": 1,
  "format": "single",                 // "single" | "double"
  "season": "M-4",                    // nullable for a hand-built team
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
      "completeness": "observed_full_set"  // observed_full_set | observed_species_only | extracted_set | inferred_set
    }
  ],
  "provenance": null                  // null for hand-built; object below for collected real teams
}
```

Field notes:
- `species` / `item` / `ability` / `moves` use **dex canonical English** so validation and cross-checks
  against `$pokemon-champions-dex` are exact. Raw importer identifiers are normalized here before
  anything ships.
- `spread` is **SP** (Stat Points), not EVs: each stat 0–32, total ≤66. `nature` applies the ±10%.
- `tera` exists only so importers can round-trip foreign formats; Champions never uses it.
- `completeness` separates the evidence lanes. `observed_species_only` means the slot is only a
  presence/co-occurrence fact (useful for core/sample views); it is **not** a set template. A member is
  eligible for `repset` / opponent resolver / opponent cache when it is tagged `observed_full_set`
  (owner-observed — confidence floor high) **or** `extracted_set` (a validated community
  reconstruction — usable as a template/tune target but confidence-capped **medium**, never presented
  as an owner's own export) **and** actually carries `species + ability + nature + moves`.
  `inferred_set` (guessed) never qualifies.
  `spread` is optional for template eligibility because some real sources expose a joint set but no SP
  spread; those consumers fall back to meta spread instead of inventing one — and a tagged member
  with NO spread has an UNKNOWN spread (tune reads it as assumed-0, low confidence, disclosed),
  while spread-carrying members feed the shape-aggregated spread stats
  (`spread_shape*`/`spread_count`/`spread_sample`/`spread_confidence`).
  `item` is held to a **team-level** rule: a member with no item is still
  template-eligible when its team carries items elsewhere (a deliberate no-item build — Acrobatics /
  Unburden — must not be silently dropped), but a team where **every** member is itemless is treated as
  an items-not-captured extraction, so none of its members are template-eligible.

## 2. `provenance` (real-team fact tags — never a strength score)

Attached when a team is collected from a real source. Hand-built teams have `provenance: null`.
The shipped skill keeps only facts that are safe to show and query.

```json
{
  "fetched_at": "2026-06-19T00:00:00Z",
  "performance": {
    "kind": "tournament",           // "tournament" | "community" | "ladder"; consumed by
                                    // the ordered evidence-tier view
    "record": {"wins": 6, "losses": 1, "ties": 0},
    "placing": 1,
    "field_size": 37,               // entrants (evidence weight), else null
    "rating": null                  // ladder rating e.g. 2422.626 (singles), else null
  }
}
```

The shipped `*.jsonl` is a facts-only projection. It contains no source identifier, URL, person,
event title, or other source-locating field. It keeps `fetched_at` plus the whitelisted
`provenance.performance` facts (`kind`, `record`, `placing`, `field_size`, `rating`, and `votes`).
`index.json` carries aggregate counts and environment labels only.

**Rules for `performance`:**
- It is **fact**, surfaced as context ("6-1 in a 37-player M-B event", "ladder rating 2422"),
  **not** normalized into a single number.
- **Never merge across formats**: singles ladder `rating` and doubles tournament `record` are
  different metagames and different confounders. Keep them separate; if ranking, use an *ordered
  evidence tier*, not a blended score.

## 3. Shipped Library Layout

```text
data/teams/
  index.json
  <season>_<format>.jsonl
```

- One JSONL file represents one `(season, format)` partition and contains one `team-json` per line.
- Filter and label evidence by `season`, `rule`, `format`, and `performance`.
- Runtime consumers may merge partitions sharing the same rule; old regulations remain explicitly
  labeled and are not treated as current.

## 4. Representative Sets

`team.py repset <species> --game-format single|double` returns up to three real-team
`(item, ability)` archetypes. Every emitted set carries `cluster`, `coverage`, `share`,
`species_sample`, `species_sample_total`, `item_filter`, `spread_origin`, and `confidence`.

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
`species_sample` against the filtered pool, never as whole-species coverage.

> **CLI canonicalization:** `team.py repset <species>` resolves the raw species via
> dex first (Chinese/Japanese aliases → canonical English) so the library's English keys match. Mega
> resolution is **format-aware**: the doubles source stores a Mega as base + stone (CLI queries the base
> with an `item_filter = required_item`), the singles source stores the `Mega X` species directly (used
> as-is). The output `query` block echoes `{species, resolved, item_filter}` for transparency.
>
> **Real-team provenance**: `repset --season <old>` reads that exact season partition and records
> `data_season`/`data_rule`; omitting `--season` reads the current-rule pool and records
> `data_rule` + `data_seasons`. A historical partition does NOT emit the "computed against the current
> base" warning (that warning is for the current-only dex/meta bases). `data_rule` is sourced from
> `index.json` / the pinned season-rule map and is `null` only for genuinely unmapped future labels.

Per meta member, one to three representative sets are derived from real teams (joint sets), with meta
usage used only where the output explicitly identifies a fallback such as SP fill.
Only template-eligible members enter these counts: `observed_full_set` OR `extracted_set` (validated
community reconstruction — participates in `sample`, but an all-extracted archetype is
confidence-capped **medium** via the completeness floor) plus real `species/ability/item/nature/moves`
fields. Presence-only rows, `inferred_set` rows, and mislabeled rows with missing set fields remain
available to presence/co-occurrence consumers but do not inflate `sample`, do not trigger singles Mega
run-form remapping, and do not create opponent-cache attacker rows.

## 5. Opponent Standard-Set Matchup Cache

`team.py oppmatrix [species] --game-format single|double [--vs defender] [--as-checks]` reads a
precomputed standard-vs-standard grid over the meta top-K from
`data/opponent_cache/<season>_<format>.json`.

The **live cache shape** — the matrix is keyed by dex-canonical **species** (not synthetic set_ids):

```json
{
  "kind": "opponent-cache",
  "built_for": {"season": "M-4", "rule": "M-B", "format": "single",
                "data_rule": "M-B", "data_seasons": ["M-3", "M-4"],
                "built_at": "2026-07-08T...Z", "top_k": 20},
  // Queries use the shipped environment stamp; no multi-version staleness check runs at query time.
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
                                                     // recompute; read this vs Mimikyu.
        "speed": {"attacker": 122, "defender": 148, "faster": "defender"}
      }
    }
  },
  "confidence": "low", "confidence_reason": "vs-standard-set",   // EVERY cell, stated once at top
  "notes": ["..."]
}
```

- One file per `(season, format)` cache target; the two metagames are never mixed. Built from the meta
  usage ranking (the opponent universe), the same-rule real-team library pool, dex facts, and one batched
  ncp call. Per-format top-k (single 50 / double 60) — the libraries differ ~50x in density.
- **Singles Mega names are resolved to the form actually run** by the shared form resolver: meta ranks
  a singles Mega under the BASE name but the
  library stores `Mega X`, so the resolved set keeps `species` = the meta label and adds `run_form` =
  the real Mega; the calc/speed/types use `run_form`. Fixed in the resolver, so **`matchup` gets the
  same correction** (its cells carry `opponent_run_form`).
- **Attacker rows exist ONLY for real-team-backed species** with a real co-occurring four-move set
  meeting the configured minimum sample size. A meta-only species has no real joint move set — meta marginals can't be stitched into
  one — so it appears as a **defender only** (`real_team_backed:false`, `moves:null`).
  It therefore appears only as a defender.
- `offense` reuses the live `matchup` damage fact (full roll band + possible/guaranteed KO buckets;
  only OHKO exact, 2+ turn KO is a static approximation flagged `ko_caveat`). `speed` is the modal line.
- **Cells are ALWAYS `low` confidence** (`vs-standard-set`): a reference grid of standard sets, NOT the
  user's team. The user's own matchup is always computed LIVE via `team.py matchup` on actual sets.
- `--as-checks` derives an attacker×attacker C2/C1/C0 reference grid: the forward cell is our offense,
  the reverse cell is the incoming move. Meta-only defenders have no reverse attacker row and are
  excluded. `species` and `--vs` retain their normal row/cell filtering semantics in this view.

## 6. build-context (Intent Layer)

The AI translates the conversation's intent into this structured object and passes it with `team-json`.
It is **structured constraints, not natural language** — the skill never parses free text.

```json
{
  "season": "M-4", "rule": "M-B", "format": "double",
  "locked": ["Garchomp"],                 // members the user will not change
  "owned_only": true,                     // restrict to the owned roster
  "owned": ["Garchomp", "Whimsicott"],    // owned species (canonical or dex-resolvable); the AI gathers
                                          // these from the user's input in ANY format and resolves them
                                          // via the dex — there is no required input file
  "wants": ["tailwind"],                  // desired tactics: weather/trickroom/tailwind/...
  "keep_mega": "Garchomp",                // a Mega to preserve, if any
  "avoid": [],                            // species/items the user wants excluded
  "prefer": ["Mimikyu"],                  // SOFT includes — "想尽量带". The AI tries to honor these but
                                          //   may drop one (with a stated reason) when it does not fit;
                                          //   contrast `locked` (HARD, never changed). dex-resolvable names
  "avoid_soft": ["Gengar"],               // SOFT excludes — "尽量别用", prefer's mirror: honored when
                                          //   composing (slate echoes hits as a fact, never eliminates);
                                          //   contrast `avoid` (HARD: observed excludes / slate eliminates)
  "exclude_tactics": ["stall",            // tactic tokens the user does NOT want (the assisted flow's "不想用受队/
                      "trickroom"],       //   空间/天气…"). Enumerated vocab: stall | trickroom | weather |
                                          //   tailwind | screens | pivot | setup | hazards. AI-side intent
                                          //   (honored in composition + which fill views to request); no
                                          //   operator mechanically filters on it yet
  "meta_conformance": "proven",           // posture knob proven | off_meta: flips the landscape
                                          //   observed_cores VIEW to rare-first (an ordering, never a
                                          //   score; landscape is the only mechanical consumer)
  "style_lean": "defense",                // posture knob offense | balance | defense (主动进攻/平衡轮换/
                                          //   稳健防守) — the USER's stated structural posture, a lens the
                                          //   AI reads profile/landscape FACTS through. AI-side intent: no
                                          //   operator filters or orders by it; the skill never labels a team
  "need": {                               // L3 `fill` gap spec; AI translates a
    "resist": "Water",                    //   diagnosed gap. Keys (AND-combined): resist (type|[types]),
    "offense_type": "Fire",               //   offense_type (type|[types], STAB/typing proxy = own type),
    "coverage_move_type": "Ice",          //   coverage_move_type (type|[types]; REAL learnset damaging
                                          //     move of that type via dex move->type bridge; each match
                                          //     flags stab — non-STAB coverage is worth far less than STAB),
    "role": "speed_control",              //   role (pivot/hazard_set/hazard_control/speed_control/...),
    "min_speed": 120                      //   min_speed (int, max-Spe +nature line must reach it)
  },
  "replace": {                            // L3 `replace`-impact: objective before/
    "member": "Rotom-Wash",               //   after diff of swapping a member for a CONCRETE candidate
    "with": {"species": "Incineroar", "ability": "Intimidate", "item": "Sitrus Berry",
             "nature": "Careful", "spread": {"hp": 32, "spd": 16},
             "moves": ["Flare Blitz", "Parting Shot", "Fake Out", "Knock Off"]}
  },
  "benchmarks": [                         // SP fine-tuning targets; AI translates intent
    {"member": "Incineroar", "kind": "survive",  "vs": "Garchomp", "move": "Earthquake",
     "conditions": {"stealth_rock": false, "spikes": 0}, "probability": "guaranteed"},
    {"member": "Garchomp",   "kind": "outspeed", "vs": "Dragapult", "conditions": {"tailwind": false}}
    // kind: survive | outspeed | ohko | 2hko ; vs = canonical species (or a raw Speed number for outspeed);
    // conditions are applied when set explicitly here; probability: guaranteed | likely | any
  ],
  "frame_required": true,                 // build-flow backstop: slate refuses without --frame-output,
                                          //   answer-audit requires a frame fingerprint in the receipt chain
  "direct_final": false,                  // checkpoint: user explicitly delegated final convergence
  "skip_checkpoint": false                // checkpoint: user explicitly requested no mid-build pause
}
```

`benchmarks` is the entry point for the `tune` operator. Each is a declarative
**cliff target**; `tune` reports the minimum SP to cross it (or the slack if already past), never a
single "optimal spread". `conditions` keys (stealth_rock / spikes / tailwind / opponent_tailwind /
trickroom / weather / terrain / screens) are **applied only when explicitly set here** — the user's
request always wins over any default gate. The format's `context_profile` informs ranking and which
contexts are worth probing by default, but it never silently turns a condition on or off in a
damage/speed calc. Two field effects also have TEAM-CARRIES defaults when the condition is absent
(explicit values still override them): my Tailwind (doubles + a team Tailwind setter -> a raw/x2 dual
lane on outspeed cards) and my Stealth Rock on kill cards (singles + a team SR setter -> the chip is
applied, with a no-SR dual lane). Notes:
- `weather` takes a named string (e.g. `"rain"`); `screens` takes `true` (the calc picks Reflect vs
  a physical hit, Light Screen vs a special one) or an explicit `"reflect" | "light_screen" | "aurora_veil"`.
- `stealth_rock` is a SINGLES model on both sides (doubles entry hazards are marginal — a capability
  boundary, so an explicit `true` in doubles is dropped, not honoured). Survive side: opponent rocks
  chip US (opt-in via this key). Kill side: OUR rocks chip the target — explicit value wins, else the
  team-carries default; when the chip is on, a `stealth_rock_lane` carries the no-chip line.
- `spikes` takes `true` (one layer) or an explicit layer count `0 | 1 | 2 | 3`; it means Spikes only,
  not Toxic Spikes or Sticky Web.
- `terrain` takes a named string (e.g. `"electric"`); it triggers a terrain-keyed Speed ability in an
  `outspeed` cliff (Surge Surfer x2 under Electric Terrain), the terrain analogue of `weather`.
- `tailwind: true` declares MY Tailwind is up: the outspeed MAIN line is solved at x2 Speed (any
  format — the user's assertion wins). When absent, doubles + a team Tailwind setter yields the
  raw/x2 dual (`tailwind_lane`) instead. `opponent_tailwind: true` doubles the TARGET's Speed
  (doubles only; default off).
- `trickroom: true` inverts the speed objective: the cliff reports whether the member already
  UNDER-speeds the target's floor line (0 SP, -Speed nature, slowest form — the conservative bound
  for moving first under Trick Room); Speed SP becomes a lever to pull, not add.

> **Executable contract:** this schema is enforced in code by `scripts/contracts.py`
> (stdlib-only, no pydantic), not just documented here. It validates team-json, build-context, and
> benchmarks — enumerated `format`/`kind`/`probability`/`completeness`/`conditions`/`screens`/`exclude_tactics`, the
> `vs` raw-Speed-only-for-outspeed rule, and `schema_version` (supported: 1) — returning coded
> `ContractError`s (`E_TYPE`/`E_ENUM`/`E_MISSING`/`E_RANGE`/`E_SCHEMA_VERSION`/`W_*`). `team.py`
> runs it at the CLI boundary: `validate` reports contract errors alongside legality, and `tune`
> refuses a malformed build-context.

## 7. Evidence (Output-Side, Lightweight)

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

## 8. Frame (Assembly Front Door)

The `frame` operator emits data-grounded skeletons for the AI to assemble on. Authoritative shapes
come from `team.py schema` (`commands.frame`, `commands.slate-evaluate`, and
`context_specs.draft_spec`); the essentials are:

```json
{
  "kind": "frame", "format": "double", "anchor": ["Maushold"], "order": "common_first",
  "pool_size": 223, "partitioned": true, "frames_total": 11, "frames_shown": 11,
  "thin": false, "meta_fallback": false,
  "skeletons": [{
    "frame_id": "fa1a799e1ab",                 // MECHANICAL hash, never a team-name/type label
    "structural_profile": {"speed_control_modes": {...}, "structural_signals": {...},
                           "role_composition_norms": {...}},   // profile FACTS, no archetype label
    "prevalence": {"count": 48, "share": 0.215},               // a VIEW ordering, never a score
    "core_candidates": [{
      "species": "Maushold", "role": "anchor",  // or "core-partner"
      "within_group_share": 1.0, "pool_share": 1.0,   // two views (glue vs archetype-defining), no composite
      "grounding": {"primary": {"item": "...", "ability": "...", "nature": "...", "moves": [...],
                                "sps": {...}, "share": ..., "confidence": ...},
                    "clusters": [{"item": "...", "ability": "..."}],   // the (item,ability) the slate binding accepts
                    "set_source": "group|species-overall", "grounding_ref": "repset:Maushold:double"},
      "set_guidance": {"moves": [...], "nature": "...", "sps": {...}},   // REFERENCE, not a hard lock
      "confidence": "medium"
      // grounding=null (+ set_guidance=null) when no real joint set exists (thin/off-meta) — build it
      // yourself + disclose; NEVER stitch a joint set from meta marginals
    }],
    "flex_slots": {"open_count": 5},           // 2nd Mega / coverage / utility are YOURS (>=1 always open)
    "observed_facts": {"observed_mega_slots": {...},   // a FACT, NOT a reserved second-Mega slot
                       "observed_fillers": [...],      // how real teams vary here — not a to-fill list
                       "role_composition_norms": {...}}
  }],
  "frame_receipt": {"kind": "frame_receipt", "fingerprint": "...", "audit_fingerprint": "...", "framed_at": "..."}
}
```

- Ordering is PREVALENCE under the `meta_conformance` knob (common_first / rare_first); an ANCHOR
  build shows every frame meeting the minimum sample threshold (`frames_shown == frames_total`) so an off-meta frame is
  never dropped. `frame_receipt` extends the chain (audit → frame →
  slate); its fingerprint is TAMPER-EVIDENT (slate recomputes it from the saved skeletons).
- Build-flow contexts/slates should carry `frame_required:true`. With that flag, `slate-evaluate`
  refuses a missing `--frame-output`, and `answer-audit` reports a violation if the saved slate output
  has no `frame_fingerprint` in its receipt chain.

**The two fields the AI PRODUCES for the binding:**
- `slate.frame_bindings[i]` (aligned with `teams[i]`): `{frame_id, off_meta?:[species], deviations?:
  [{species, reason}], off_meta_build?:bool}`. `frame_id` declares which skeleton the candidate builds
  on; a core-bearer (member ∈ that frame's `core_candidates`) whose `(item,ability)` is outside its
  repset `clusters` is a deviation — RED (no `off_meta`/`deviations` ack) eliminates in the funnel,
  YELLOW (acknowledged) survives. `off_meta_build:true` = a deliberate off-meta build (no core-bearer
  binding). Only `(item,ability)` is checked — `set_guidance` is soft.
- `draft.frame_deviations`: `[str | {species, note}]` — REQUIRED disclosure when a frame-bound slate
  flagged a YELLOW deviation / off-frame advisory on a recommended SURVIVOR (name the species). A
  filled-check at answer-audit, never a veto.

For the final answer shape, initialize the draft with
`team.py draft-init --slate slate.json --slate-output slate_out.json [--recommended I J]`, then fill
the substantive empty fields before `answer-audit`. The helper copies selected survivor teams and
the saved `slate_receipt`; it does not choose winners or write the convergence judgment.
