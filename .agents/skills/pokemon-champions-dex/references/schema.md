# Pokémon Champions Dex Data Model And Query Semantics

This reference documents the bundled read-only database and the non-obvious semantics built on it.
For the live CLI command and output contract, run `python scripts/champdex.py schema`; that executable
self-description and the CLI behavior are authoritative if this prose ever differs.

The database is a prebuilt, read-only SQLite file with a JSON export mirror. The skill performs no network access.

## Tables

- `pokemon(canonical, display_name, display_name_ja, national_dex_no, types_json, stats_json, abilities_json, weight, is_mega, base_species, required_item, source)`
- `moves(canonical, display_name, display_name_ja, type, category, power, accuracy, pp, priority, raw_json, source)`
- `abilities(canonical, display_name, display_name_ja, source)`
- `items(canonical, display_name, display_name_ja, source)`
- `natures(canonical, display_name, display_name_ja, up_stat, down_stat, source)` — the 25 natures; `up_stat`/`down_stat` are smogon stat keys (null for the 5 neutral natures)
- `aliases(alias, normalized, kind, canonical, source)`
- `learnsets(pokemon, move, source)`

The `source` columns are present for schema stability but are not populated in the shipped database. `canonical` values are English names; `display_name` is the authoritative simplified-Chinese name and falls back to canonical English when absent. `display_name_ja` (on pokemon, moves, abilities, items and natures) is the authoritative Japanese name, and `pokemon.national_dex_no` the National Pokédex number. The `aliases` table carries Chinese (including full/half-width, traditional and pre-rename variants), English, and Japanese (kana) names for pokemon/moves/abilities/items, so queries in any of the three languages — and older spellings — resolve to the same canonical. Aliases are lookup-only — they never become a `display_name`.

## Name Resolution

Normalize names by NFKC-folding (so full-width and half-width characters match, e.g. `１０` = `10`), lowercasing, and removing spaces, hyphens, apostrophes, dots, underscores, and common brackets. Chinese and Japanese characters are preserved. All queries should resolve through `aliases` before matching canonical values.

When an exact alias/canonical match fails, the resolver applies a conservative typo fallback **by default** (bounded edit distance, script- and length-gated; an ambiguous tie refuses rather than guessing). A fuzzy hit tags the result with a `resolution` block; `--strict` disables the fallback (exact only) for callers where a miss must stay a miss. `find`/`reverse` are always exact.

## Multi-Condition Search

Search conditions are ANDed:

- `move <name>`: Pokémon must have the move in `learnsets`.
- `ability <name>`: Pokémon ability list must contain the resolved ability.
- `type <name>`: Pokémon must have that type.
- `stat <expr>`: base stat must satisfy the expression, e.g. `spe>=110`.
- `mega true|false`: filter Mega forms.
- `pokemon/name <text>`: name or alias contains the text after normalization.

When learnsets are unavailable for a Pokémon, move-based reverse searches should not guess. Report that results depend on the coverage of the `learnsets` table.
