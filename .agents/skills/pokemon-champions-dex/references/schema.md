# Pokemon Champions Dex Schema

The database is a prebuilt, read-only SQLite file with a JSON export mirror. The skill performs no network access.

## Tables

- `pokemon(canonical, display_name, types_json, stats_json, abilities_json, weight, is_mega, base_species, required_item, source)`
- `moves(canonical, display_name, type, category, power, accuracy, pp, raw_json, source)`
- `abilities(canonical, display_name, source)`
- `items(canonical, display_name, source)`
- `aliases(alias, normalized, kind, canonical, source)`
- `learnsets(pokemon, move, source)`

The `source` columns are present for schema stability but are not populated in the shipped database. `canonical` values are English names; `display_name` prefers simplified Chinese when available and falls back to canonical English. The `aliases` table carries Chinese, English, and Japanese (kana) names for pokemon/moves/abilities/items, so queries in any of the three languages resolve to the same canonical. Japanese aliases are lookup-only — they never become a `display_name`.

## Name Resolution

Normalize names by NFKC-folding (so full-width and half-width characters match, e.g. `１０` = `10`), lowercasing, and removing spaces, hyphens, apostrophes, dots, underscores, and common brackets. Chinese and Japanese characters are preserved. All queries should resolve through `aliases` before matching canonical values.

When an exact alias/canonical match fails, the resolver applies a conservative typo fallback **by default** (bounded edit distance, script- and length-gated; an ambiguous tie refuses rather than guessing). A fuzzy hit tags the result with a `resolution` block; `--strict` disables the fallback (exact only) for callers where a miss must stay a miss. `find`/`reverse` are always exact.

## Multi-Condition Search

Search conditions are ANDed:

- `move <name>`: Pokemon must have the move in `learnsets`.
- `ability <name>`: Pokemon ability list must contain the resolved ability.
- `type <name>`: Pokemon must have that type.
- `stat <expr>`: base stat must satisfy the expression, e.g. `spe>=110`.
- `mega true|false`: filter Mega forms.
- `pokemon/name <text>`: name or alias contains the text after normalization.

When learnsets are unavailable for a Pokemon, move-based reverse searches should not guess. Report that results depend on the coverage of the `learnsets` table.
