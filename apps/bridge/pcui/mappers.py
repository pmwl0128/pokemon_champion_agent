"""Raw skill output -> Web DTO mappers (the backend mapper, apps/design.md §3).

Graduated from packages/protocol/scripts/map_dto.py; the protocol package's golden DTO
fixtures are THIS module's regression suite (apps/bridge/tests/test_mappers.py re-derives
every fixture and compares byte-identically).

Rules: DTOs are camelCase; `name` is ALWAYS the canonical English join key — meta panels
arrive zh/ja-named and resolve through the dex (the only naming authority); a panel name
the dex cannot resolve is a bug and raises rather than shipping a broken join key.
"""
from __future__ import annotations

import re
import sys
import threading

from .paths import SKILLS_ROOT

_DEX_SCRIPTS = SKILLS_ROOT / "pokemon-champions-dex/scripts"
if str(_DEX_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_DEX_SCRIPTS))
import champdex as _dex  # noqa: E402

# The team skill's scripts hold the pure opponent-cache reader (oppcache.py) + check grader
# (checks.py). The KO/check page reuses THEM (canonical logic) rather than re-deriving grades —
# so the team scripts dir joins the path the same way the dex one does. Imported lazily (only the
# matchup endpoint needs it) so an unrelated skill layout change never breaks bridge startup.
_TEAM_SCRIPTS = SKILLS_ROOT / "pokemon-champions-team/scripts"


class MappingError(RuntimeError):
    pass


# THREAD-LOCAL connection cache: sqlite3 connections are thread-affine by default, and the
# server invokes mappers through asyncio.to_thread (a pool of changing threads) — one shared
# cached connection raises ProgrammingError on the second thread (external audit 2026-07-13).
# Read-only DB, bounded pool: one connection per pool thread is cheap and safe.
_tls = threading.local()


def _conn():
    conn = getattr(_tls, "conn", None)
    if conn is None:
        conn = _dex.conn()
        _tls.conn = conn
    return conn


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower().replace("'", "")).strip("-")


def variant_key(variant_id: str) -> str:
    """The skill already emits a lossless canonical id; keep it unchanged across every layer."""
    return variant_id


def opponent_key(value: str) -> str:
    return variant_key(value) if value.startswith("variant:") else slugify(value)


def type_name(t: str | None) -> str | None:
    """Canonical Title-case type/category (common.ts enums). The dex tables already ship
    Title-case, but the meta details store keeps them lowercase and the meta CLI only
    Title-cases on emit — so a mapper fed store rows directly (build_projection.py) would
    otherwise ship enum-violating lowercase. `.capitalize()` is idempotent for the single-
    word type and category vocabularies, so normalizing here is safe on every path."""
    return t.capitalize() if t else t


def named(en: str, zh: str | None, ja: str | None) -> dict:
    out: dict = {"name": en}
    if zh:
        out["nameZh"] = zh
    if ja:
        out["nameJa"] = ja
    return out


def resolve_en(kind: str, name: str) -> str:
    canon = _dex.resolve(_conn(), kind, name)
    if not canon:
        raise MappingError(f"dex cannot resolve {kind} name {name!r}")
    return canon


# --- dex ---------------------------------------------------------------------------------

def _species_ref(name: str) -> dict:
    """Trilingual dex reference + slug for a canonical species name (the opponent-cache matrix key).
    An unknown name stays English-only (never fails the grid)."""
    row = _conn().execute(
        "select display_name, display_name_ja from pokemon where canonical=?", (name,),
    ).fetchone()
    out = named(name, row["display_name"] if row else None,
                row["display_name_ja"] if row else None)
    out["slug"] = slugify(name)
    return out


def _ability_ref(name: str) -> dict:
    """Trilingual ability reference straight from the dex abilities table (all 201 carry
    zh+ja; an unknown name stays English-only rather than failing a whole card)."""
    row = _conn().execute(
        "select display_name, display_name_ja from abilities where canonical=?", (name,),
    ).fetchone()
    return named(name, row["display_name"] if row else None,
                 row["display_name_ja"] if row else None)


def map_pokemon(raw: dict) -> dict:
    slug = slugify(raw["name"])
    out = {
        "key": f"pokemon:{slug}",
        **named(raw["name"], raw.get("display_name"), raw.get("display_name_ja")),
        "slug": slug,
        "nationalDex": raw["national_dex_no"],
        "types": raw["types"],
        "stats": raw["stats"],
        "abilities": [_ability_ref(a) for a in raw["abilities"]],
        "isMega": bool(raw["is_mega"]),
    }
    if raw.get("base_species"):
        out["baseSpecies"] = raw["base_species"]
    if "required_item" in raw:
        out["requiredItem"] = raw["required_item"]
    if raw.get("mega_forms"):
        out["megaForms"] = [{"name": m["name"], "requiredItem": m.get("required_item")}
                            for m in raw["mega_forms"]]
    return out


def _effects(raw: dict) -> dict:
    """Trilingual effect texts (effects_seed.py). Present-only (omit, never null): an
    empty zh move effect is 52poke's "no secondary effect" convention."""
    out = {}
    for src, dst in (("effect_en", "effect"), ("effect_zh", "effectZh"),
                     ("effect_ja", "effectJa")):
        if raw.get(src):
            out[dst] = raw[src]
    return out


def map_move(raw: dict) -> dict:
    return {
        **named(raw["name"], raw.get("display_name"), raw.get("display_name_ja")),
        "type": type_name(raw["type"]),
        "category": type_name(raw["category"]),
        "power": raw.get("power"),
        "accuracy": raw.get("accuracy"),
        "priority": raw.get("priority", 0),
        "pp": raw.get("pp"),
        **_effects(raw),
    }


def map_item(raw: dict) -> dict:
    return {
        "key": f"item:{slugify(raw['name'])}",
        **named(raw["name"], raw.get("display_name"), raw.get("display_name_ja")),
        "requiredBy": raw.get("required_by", []),
        **_effects(raw),
    }


def map_ability(raw: dict) -> dict:
    return {
        **named(raw["name"], raw.get("display_name"), raw.get("display_name_ja")),
        **_effects(raw),
    }


def map_nature(raw: dict) -> dict:
    return {
        **named(raw["name"], raw.get("display_name"), raw.get("display_name_ja")),
        "upStat": raw.get("up_stat"),
        "downStat": raw.get("down_stat"),
    }


def map_resolve_entry(raw: dict) -> dict:
    out = {"query": raw["query"], "ok": raw["ok"], "kind": raw.get("kind", "pokemon"),
           "matchType": raw.get("match_type")}
    for src, dst in (("canonical", "canonical"), ("display_name", "displayName"),
                     ("display_name_ja", "displayNameJa"), ("score", "score"),
                     ("is_mega", "isMega"), ("base_species", "baseSpecies"),
                     ("required_item", "requiredItem"), ("suggestions", "suggestions")):
        if src in raw and raw[src] is not None:
            out[dst] = raw[src]
    return out


# --- meta --------------------------------------------------------------------------------

def map_ranking(raw: dict) -> dict:
    out = {
        "season": raw["season"], "rule": raw["rule"], "format": raw["format"],
        "rows": [{
            "rank": r["rank"], "slug": r["slug"],
            **named(r["name"], r.get("name_zh"), r.get("name_ja")),
        } for r in raw["rows"]],
    }
    if raw.get("updated_at"):                 # optional field: omit when absent, never null
        out["updatedAt"] = raw["updated_at"]
    return out


def _panel_entry(kind: str, e: dict) -> dict:
    en = resolve_en(kind, e.get("name_ja") or e["name"])
    row = {"rank": e["rank"], **named(en, e.get("name"), e.get("name_ja")),
           "percentage": e.get("percentage")}
    if kind == "item":
        # Ship the asset-pack key from the mapper (the single slug authority) so the UI never
        # re-derives it with a second, drift-prone slugify.
        row["key"] = f"item:{slugify(en)}"
    return row


def map_detail(raw: dict) -> dict:
    p = raw["panels"]
    moves = []
    for e in p["moves"]:
        row = _panel_entry("move", e)
        row.update({"type": type_name(e["type"]), "category": type_name(e["category"]),
                    "power": e.get("power")})
        moves.append(row)
    partners = []
    for e in p["partners"]:
        en = resolve_en("pokemon", e.get("name_ja") or e["name"])
        row = {"rank": e["rank"], **named(en, e.get("name"), e.get("name_ja")),
               "slug": slugify(en)}
        if str(e.get("key", "")).isdigit():
            row["nationalDex"] = int(e["key"])
        partners.append(row)
    spreads = [{"rank": e["rank"],
                "spread": {k: v for k, v in e.items()
                           if k in ("hp", "atk", "def", "spa", "spd", "spe") and v},
                "percentage": e.get("percentage")} for e in p["spreads"]]
    return {
        "rank": raw.get("rank"),
        "slug": raw["slug"],
        **named(raw["pokemon_en"], raw.get("pokemon"), raw.get("pokemon_ja")),
        "format": raw["format"], "season": raw["season"], "rule": raw["rule"],
        "panels": {
            "moves": moves,
            "items": [_panel_entry("item", e) for e in p["items"]],
            "abilities": [_panel_entry("ability", e) for e in p["abilities"]],
            "natures": [_panel_entry("nature", e) for e in p["natures"]],
            "partners": partners,
            "spreads": spreads,
        },
    }


def map_trend(raw: dict) -> dict:
    periods = [p["date"] for p in raw["periods"]]
    series = []
    for s in raw["series"]:
        slug = s["slug"]
        names = raw.get("names", {}).get(slug, {})
        series.append({
            "slug": slug,
            **named(names.get("en") or slug, names.get("zh"), names.get("ja")),
            "ranks": raw["ranks"].get(slug, []),
        })
    return {"season": raw["season"], "rule": raw["rule"], "format": raw["format"],
            "periods": periods, "series": series}


def map_usage_trend(raw: dict, slug: str) -> dict:
    """Map one Pokemon out of the compact historical usage store.

    The store keeps Japanese source keys so snapshots remain stable across localization
    updates. The Web DTO uses canonical English keys to join the current detail rows.
    """
    pokemon = raw.get("pokemon", {}).get(slug)
    if pokemon is None:
        raise MappingError(f"usage trend not found: {slug}")

    panels: dict[str, list[dict]] = {}
    for panel, kind in (("moves", "move"), ("items", "item"),
                        ("abilities", "ability"), ("natures", "nature")):
        panels[panel] = [
            {"name": resolve_en(kind, source_name), "values": values}
            for source_name, values in pokemon.get(panel, {}).items()
        ]

    stat_keys = ("hp", "atk", "def", "spa", "spd", "spe")
    spreads = []
    for source_key, values in pokemon.get("spreads", {}).items():
        parts = source_key.split("/")
        if len(parts) != len(stat_keys):
            raise MappingError(f"invalid usage spread key: {source_key}")
        try:
            spread = {key: int(value) for key, value in zip(stat_keys, parts) if int(value)}
        except (TypeError, ValueError) as exc:
            raise MappingError(f"invalid usage spread key: {source_key}") from exc
        spreads.append({"spread": spread, "values": values})
    panels["spreads"] = spreads

    # A partial/older store may be missing the top-level metadata or a period's date. Surface it
    # as a MappingError (the endpoint's handled failure) instead of an opaque KeyError/TypeError 500.
    try:
        return {
            "season": raw["season"], "rule": raw["rule"], "format": raw["format"],
            "slug": slug, "periods": [p["date"] for p in raw["periods"]],
            "panels": panels,
        }
    except (KeyError, TypeError) as exc:
        raise MappingError(f"malformed usage trend store metadata: {exc}") from exc


# --- calc --------------------------------------------------------------------------------

def map_damage(raw: dict) -> dict:
    out = {
        "description": raw["description"],
        "damage": raw["damage"],
        "min": raw["min"], "max": raw["max"],
        "minPercent": raw["minPercent"], "maxPercent": raw["maxPercent"],
        "defenderHP": raw["defenderHP"],
        "hits": raw["hits"], "hitsRange": raw["hits_range"],
        "koChance": None, "category": raw["category"],
        "move": raw["move"], "attacker": raw["attacker"], "defender": raw["defender"],
    }
    for src, dst in (("min_env", "minEnv"), ("max_env", "maxEnv"),
                     ("min_env_percent", "minEnvPercent"), ("max_env_percent", "maxEnvPercent")):
        if raw.get(src) is not None:
            out[dst] = raw[src]
    if raw.get("ko_chance"):
        k = raw["ko_chance"]
        # `n` can be None (parseKoChance yields n=None for a non-standard KO string); KoChanceDto.n is
        # optional-NOT-nullable, so a None sinks the SPA's Zod parse of the whole (batched) result — skip
        # it when absent OR None, exactly as the browser twin (calc-engine/index.ts mapDamage) does.
        out["koChance"] = {kk: k[sk] for sk, kk in
                           (("text", "text"), ("n", "n"), ("guaranteed", "guaranteed"),
                            ("chance_pct", "chancePct"))
                           if sk in k and not (sk == "n" and k[sk] is None)}
    if raw.get("ko_caveats"):
        out["koCaveats"] = [{"code": c["code"], "direction": c["direction"],
                             **({"cause": c["cause"]} if c.get("cause") else {})}
                            for c in raw["ko_caveats"]]
    return out


def map_speedline(raw: dict) -> dict:
    return {k: raw[k] for k in ("name", "types", "baseSpeed", "nature", "speedSPs",
                                "speedIV", "speedBoost", "rawSpeed", "boostedSpeed",
                                "finalSpeed")}


# --- learnset (straight from the dex DB — static data, no CLI hop needed) -----------------

def learnset_dto(canonical: str) -> dict:
    """LearnsetDto for one pokemon: learnable moves joined with the move catalog, trilingual,
    sorted by canonical name (the UI re-sorts/filters as it likes)."""
    rows = _conn().execute(
        "select m.canonical, m.display_name, m.display_name_ja, m.type, m.category, m.power, "
        "m.accuracy from learnsets l join moves m on m.canonical = l.move "
        "where l.pokemon = ? order by m.canonical", (canonical,),
    ).fetchall()
    moves = []
    for r in rows:
        entry = named(r["canonical"], r["display_name"], r["display_name_ja"])
        try:
            power: int | None = int(r["power"])
        except (TypeError, ValueError):
            power = None
        try:
            accuracy: float | None = float(r["accuracy"])
        except (TypeError, ValueError):
            accuracy = None
        entry.update({"type": type_name(r["type"]), "category": type_name(r["category"]),
                      "power": power, "accuracy": accuracy})
        moves.append(entry)
    return {"slug": slugify(canonical), "moves": moves}


# --- opponent matchup cache (M5) — KO matrix + derived check view ------------------------
# The team skill owns the fact-shaping: oppcache.py reads the shipped cache and derives the
# C2/C1/C0 check grid (checks.py). The bridge reuses those pure functions (never re-implements a
# grade) and only maps their output to camelCase DTOs — the same "map, never recompute" discipline
# as map_detail. The team scripts dir is added to sys.path lazily on the first matchup request.

_SP_NCP_TO_SMOGON = {"hp": "hp", "at": "atk", "df": "def", "sa": "spa", "sd": "spd", "sp": "spe"}


def _oppcache_mod():
    if str(_TEAM_SCRIPTS) not in sys.path:
        sys.path.insert(0, str(_TEAM_SCRIPTS))
    import oppcache  # noqa: E402
    return oppcache


def load_oppcache(fmt: str, rule: str) -> dict | None:
    """The shipped opponent cache for (rule, format), or None when it has not been built."""
    return _oppcache_mod().load_cache(fmt, rule)


def derive_oppcheck_grid(cache: dict) -> dict:
    """The lean variant x variant grade grid the UI renders (see oppcache.derive_check_grid)."""
    return _oppcache_mod().derive_check_grid(cache)


def map_oppcheck_grid(cache: dict, derived: dict) -> dict:
    """Encode the grid's keys; everything else is already minimal.

    Damage/speed are deliberately NOT here.  The checks page can render the representative grid
    from this compact document and lazy-load the much larger KO matrix only when a cell is opened.
    """
    grid = {}
    for ai, row in (derived.get("grid") or {}).items():
        grid[opponent_key(ai)] = {
            opponent_key(dj): {
                "grade": c.get("grade"),
                **({"c0Kind": c["c0_kind"]} if c.get("c0_kind") else {}),
                **({"contested": True} if c.get("contested") else {}),
            } for dj, c in row.items()}
    return {
        "format": derived.get("format") or (cache.get("built_for") or {}).get("format") or "single",
        "confidence": derived.get("confidence") or "",
        "confidenceReason": derived.get("confidence_reason") or "",
        "species": _species_columns(cache.get("species") or [], cache.get("sets")),
        "grid": grid,
    }


def _map_offense(off: dict | None) -> dict | None:
    if not off:
        return None
    out = {
        "move": off["move"],
        "minPercent": off["min_percent"], "maxPercent": off["max_percent"],
        "koPossible": off.get("ko_possible"), "koGuaranteed": off.get("ko_guaranteed"),
        "ko": off.get("ko") or "", "koExact": bool(off.get("ko_exact")),
        "category": type_name(off.get("category")), "koChance": None,
    }
    kc = off.get("ko_chance")
    if kc:
        out["koChance"] = {dst: kc[src] for src, dst in
                           (("text", "text"), ("n", "n"), ("guaranteed", "guaranteed"),
                            ("chance_pct", "chancePct")) if src in kc}
    cav = off.get("ko_caveats")
    if cav:
        out["koCaveats"] = [{"code": c["code"], "direction": c["direction"],
                             **({"cause": c["cause"]} if c.get("cause") else {})} for c in cav]
    da = off.get("disguise_adjusted")
    if da:
        out["disguiseAdjusted"] = {"effectiveKoPossible": da.get("effective_ko_possible"),
                                   "effectiveKoGuaranteed": da.get("effective_ko_guaranteed"),
                                   "note": da.get("note") or ""}
    return out


def map_oppko_grid(cache: dict) -> dict:
    """Map only the facts the KO overview paints.

    The full cache is intentionally separate: speed, moves, caveats and processed sets are useful
    only after a user opens a cell, while eagerly shipping them made the default KO page parse a
    7–14 MB document before it could render.
    """
    bf = cache.get("built_for") or {}
    grid: dict = {}
    for ai, cells in (cache.get("matrix") or {}).items():
        row: dict = {}
        for dj, cell in cells.items():
            offense = (cell or {}).get("offense")
            chance = (offense or {}).get("ko_chance") or {}
            row[opponent_key(dj)] = (None if offense is None else [
                offense.get("min_percent"), offense.get("max_percent"),
                offense.get("ko_possible"), offense.get("ko_guaranteed"),
                chance.get("n"), chance.get("guaranteed"), chance.get("chance_pct"),
            ])
        grid[opponent_key(ai)] = row
    return {
        "format": bf.get("format") or "single",
        "confidence": cache.get("confidence") or "",
        "confidenceReason": cache.get("confidence_reason") or "",
        "species": _species_columns(cache.get("species") or [], cache.get("sets")),
        "grid": grid,
    }


def _map_opp_speed(sp: dict | None) -> dict:
    sp = sp or {}
    return {"attacker": sp.get("attacker"), "defender": sp.get("defender"),
            "faster": sp.get("faster")}


def _map_sps(sps: dict | None) -> dict | None:
    if not sps:
        return None
    out: dict = {}
    for k, v in sps.items():
        kk = _SP_NCP_TO_SMOGON.get(k, k)
        if kk in ("hp", "atk", "def", "spa", "spd", "spe") and isinstance(v, int):
            out[kk] = v
    return out or None


def _map_opp_set(s: dict | None) -> dict:
    s = s or {}
    out = {"species": s.get("species") or "", "runForm": s.get("run_form"),
           "ability": s.get("ability"), "item": s.get("item"), "nature": s.get("nature"),
           "moves": s.get("moves"), "sps": _map_sps(s.get("sps")),
           "source": s.get("source"), "confidence": s.get("confidence"),
           "realTeamBacked": bool(s.get("real_team_backed")), "note": s.get("note")}
    if s.get("variant_id"):
        out["isModal"] = bool(s.get("is_modal"))
        out["coverage"] = s.get("coverage")
        out["sampleCount"] = s.get("variant_sample")
        out["representativeCount"] = s.get("variant_count")
        out["clusterBasis"] = s.get("cluster_basis")
        out["representedCoverage"] = s.get("represented_coverage")
        out["unrepresentedCoverage"] = s.get("unrepresented_coverage")
        profile = s.get("speed_profile")
        if isinstance(profile, dict):
            out["speedProfile"] = {
                "sample": profile.get("sample"),
                "minSpeSp": profile.get("min_spe_sp"),
                "maxSpeSp": profile.get("max_spe_sp"),
                "natures": profile.get("natures") or [],
                "heterogeneous": bool(profile.get("heterogeneous")),
            }
        if s.get("base_ability"):     # pre-Mega ability — fires on switch-in, before Mega evolution
            out["baseAbility"] = s["base_ability"]
    return out


def _species_row(r: dict) -> dict:
    name = r.get("species") or ""
    row = {"rank": r.get("rank"), **_species_ref(name),
           "realTeamBacked": bool(r.get("real_team_backed")),
           "setSource": r.get("set_source"), "setConfidence": r.get("set_confidence")}
    if r.get("run_form"):
        row["runForm"] = r["run_form"]
    return row


def map_oppcache(cache: dict) -> dict:
    """Map the cache to its wire DTO.

    The grid is keyed by VARIANT (one row/column per real build), so the wire key losslessly encodes
    `variant_id`, not of the species — several rows share a species and a species-keyed map would
    collapse them onto each other. `species` groups those variants back up for the UI: each entry
    lists its builds with `isModal` (what to show by default) and `coverage` (how common it is), so
    the default view is one column per Pokémon and switching a build is a pure re-index of data the
    client already holds."""
    bf = cache.get("built_for") or {}
    species_rows = cache.get("species") or []
    sets_in = cache.get("sets") or {}

    def _key(row_or_id: Any) -> str:
        """Wire key for a matrix row: encoded variant id when expanded, species slug otherwise."""
        value = str(row_or_id)
        return opponent_key(value)

    out_sets = {_key(k): _map_opp_set(s) for k, s in sets_in.items()}
    out_matrix: dict = {}
    for ai, cells in (cache.get("matrix") or {}).items():
        out_matrix[_key(ai)] = {
            _key(dj): {"offense": _map_offense((c or {}).get("offense")),
                       "speed": _map_opp_speed((c or {}).get("speed"))}
            for dj, c in cells.items()}

    # Group variant rows under their species, preserving the cache's stable order.
    grouped: dict[str, dict] = {}
    for r in species_rows:
        name = r.get("species") or ""
        vid = r.get("variant_id")
        entry = grouped.get(name)
        if entry is None:
            entry = grouped[name] = {**_species_row(r), "variants": []}
        # The species row inherits the MODAL build's provenance, so a collapsed view reads the
        # default build rather than whichever variant happened to sort first.
        if vid and r.get("is_modal"):
            entry.update({k: v for k, v in _species_row(r).items() if k != "variants"})
        if vid:
            s = sets_in.get(vid) or {}
            entry["variants"].append({
                "key": _key(vid), "item": s.get("item"), "ability": s.get("ability"),
                "isModal": bool(r.get("is_modal")), "coverage": r.get("coverage"),
                **({"runForm": s["run_form"]} if s.get("run_form") else {}),
                **({"baseAbility": s["base_ability"]} if s.get("base_ability") else {}),
            })
        else:                       # legacy species-keyed cache: one implicit variant
            entry["variants"].append({"key": _key(name), "item": None, "ability": None,
                                      "isModal": True, "coverage": None})
    # Modal first, then by coverage: the UI labels builds A/B/C BY POSITION, so an unordered list
    # would make "A" mean nothing (Garchomp's 67.8% build sorted behind its 8.9% one).
    for entry in grouped.values():
        vs = entry.get("variants")
        if vs:
            vs.sort(key=lambda v: (not v.get("isModal"), -(v.get("coverage") or 0)))
    return {
        "season": bf.get("season") or "", "rule": bf.get("rule") or "",
        "format": bf.get("format") or "single",
        "builtAt": bf.get("built_at") or "", "topK": bf.get("top_k") or len(grouped),
        "variantCount": bf.get("variant_count") or len(species_rows),
        "confidence": cache.get("confidence") or "",
        "confidenceReason": cache.get("confidence_reason") or "",
        "species": list(grouped.values()),
        "sets": out_sets, "matrix": out_matrix,
    }


def _map_check(chk: dict | None) -> dict | None:
    if not chk:
        return None
    verdict = (chk.get("resolvability") or {}).get("verdict")
    details = []
    for detail in chk.get("caveat_details") or []:
        if not isinstance(detail, dict) or not isinstance(detail.get("code"), str):
            continue
        params = detail.get("params") if isinstance(detail.get("params"), dict) else {}
        details.append({"code": detail["code"],
                        "params": {str(k): v for k, v in params.items()
                                   if v is None or isinstance(v, (str, int, float, bool))}})
    return {
        "grade": chk.get("grade"),
        "c1Mode": chk.get("c1_mode"),
        "c0Kind": chk.get("c0_kind"),
        "resolvability": verdict if verdict in ("clean", "contested") else "clean",
        "caveats": chk.get("caveats") or [],
        "caveatDetails": details,
    }


def _species_columns(species_rows: list[dict], sets: dict | None = None) -> list[dict]:
    """One entry per species (preferring its modal row) WITH its build list, so a grid keyed by
    variant is still presented as one row/column per Pokemon and switched build-by-build.

    Builds are ordered modal-first (coverage desc), which is what makes a positional label stable:
    the UI names them A/B/C by index rather than by item, because an item name is long, differs per
    language, and says nothing about how common the build is.
    """
    sets = sets or {}
    out: dict[str, dict] = {}
    variants: dict[str, list[dict]] = {}
    for r in species_rows:
        name = r.get("species") or ""
        if name not in out or r.get("is_modal"):
            out[name] = _species_row(r)
        vid = r.get("variant_id")
        if vid:
            st = sets.get(vid) or {}
            variants.setdefault(name, []).append({
                "key": variant_key(vid), "isModal": bool(r.get("is_modal")),
                "coverage": r.get("coverage"),
                "item": st.get("item"), "ability": st.get("ability"),
                **({"runForm": st["run_form"]} if st.get("run_form") else {}),
                **({"baseAbility": st["base_ability"]} if st.get("base_ability") else {}),
            })
    for name, row in out.items():
        vs = variants.get(name)
        if vs:
            vs.sort(key=lambda v: (not v["isModal"], -(v.get("coverage") or 0)))
            row["variants"] = vs
    return list(out.values())


# --- team diagnose report (online deterministic surface, design §7.5) ---------------------

def _str_list(v) -> list:
    """Errors/warnings arrive as localized-at-the-boundary strings; anything structured is
    serialized rather than dropped (facts must not vanish in the mapper)."""
    import json as _json
    return [x if isinstance(x, str) else _json.dumps(x, ensure_ascii=False)
            for x in (v or [])]


def _incomplete_members(rows) -> list:
    """The members whose moveset isn't authoritative (offense/roles skip them, so a reported
    gap may be a phantom). Each carries its effective completeness tier for the UI caveat."""
    return [{"species": r.get("species") or "", "completeness": str(r.get("completeness") or "")}
            for r in (rows or []) if isinstance(r, dict) and r.get("species")]


def map_diagnose_report(team: dict, validate_raw: dict, diagnose_raw: dict) -> dict:
    """validate + diagnose(all) -> DiagnoseReportDto: the disclosure-safe per-aspect facts
    the diagnose page renders. Species names stay English canonical (the SPA localizes)."""
    defense = diagnose_raw.get("defense") or {}
    bat = defense.get("by_attack_type") or {}
    by_attack = [{"type": t,
                  "weak": list(e.get("weak") or []),
                  "resist": list(e.get("resist") or []),
                  "immune": list(e.get("immune") or []),
                  "neutralCount": int(e.get("neutral_count") or 0)}
                 for t, e in (bat.items() if isinstance(bat, dict) else [])
                 if isinstance(e, dict)]
    offense = diagnose_raw.get("offense") or {}
    attack_types = offense.get("attack_types") or {}
    speed = diagnose_raw.get("speed") or {}

    def order(rows) -> list:
        return [{"species": r.get("species") or "", "speed": r.get("speed")}
                for r in (rows or []) if isinstance(r, dict) and r.get("species")]

    members = [{"species": m.get("species") or "",
                "baseSpeed": m.get("base_speed"), "speed": m.get("speed"),
                "speSp": m.get("spe_sp"), "nature": m.get("nature"),
                "assumedNeutral": m.get("assumed_neutral")}
               for m in (speed.get("members") or [])
               if isinstance(m, dict) and m.get("species")]
    roles = diagnose_raw.get("roles") or {}
    coverage = [{"key": k, "label": str(e.get("label") or k),
                 "present": bool(e.get("present")),
                 # The skill keeps required|optional for CLI compatibility. Do not expose those
                 # prescriptive words to UI/LLM consumers: these are attention levels, not proof
                 # that every team requires a role. NOT_CHECKED roles are simply omitted.
                 "expectation": ("situational" if e.get("expectation") == "optional"
                                 else "priority"),
                 **({"expectationReason": str(e["expectation_reason"])}
                    if e.get("expectation_reason") else {}),
                 "bearers": [{"species": b.get("species") or "", "via": b.get("via")}
                             for b in (e.get("bearers") or []) if isinstance(b, dict)]}
                for k, e in (roles.get("coverage") or {}).items() if isinstance(e, dict)]
    role_members = [{"species": m.get("species") or "",
                     "signals": [str(s) for s in (m.get("signals") or [])]}
                    for m in (roles.get("compression") or [])
                    if isinstance(m, dict) and m.get("species")]
    cc_raw = diagnose_raw.get("check_coverage") or {}
    # Per-opponent member cells (the same facts the matchup grid exposes), keyed by the
    # opponent species so each roll-up row can open a clickable detail.
    cells_by_opp: dict = {}
    for mrow in cc_raw.get("members") or []:
        if not isinstance(mrow, dict):
            continue
        member = mrow.get("member") or ""
        for c in mrow.get("cells") or []:
            if not isinstance(c, dict) or not c.get("opponent"):
                continue
            sp = c.get("speed") or {}
            dd = c.get("defense_damage") or {}
            cells_by_opp.setdefault(c["opponent"], []).append({
                "member": member,
                "variantId": c.get("opponent_variant") or c.get("opponent"),
                "coverage": c.get("opponent_coverage"),
                "offense": _map_offense(c.get("offense")),
                "incoming": _map_offense(dd.get("worst")),
                "speed": {"member": sp.get("member"), "opponent": sp.get("opponent"),
                          "faster": sp.get("faster")},
                "check": _map_check(c.get("check")),
            })
    by_opp = []
    for o in ((cc_raw.get("check_coverage") or {}).get("by_opponent") or []):
        if not isinstance(o, dict) or not o.get("opponent"):
            continue
        witnesses = [str(s) for s in
                     ((o.get("observed_floor") or {}).get("witness_variant_ids") or [])]
        witness_set = set(witnesses)
        floor_by = []
        for variant in o.get("variants") or []:
            if not isinstance(variant, dict) or variant.get("variant_id") not in witness_set:
                continue
            for member in variant.get("best_by") or []:
                if member not in floor_by:
                    floor_by.append(member)
        by_opp.append({
            "opponent": o.get("opponent") or "",
            "usageRank": o.get("usage_rank"),
            "observedFloor": (o.get("observed_floor") or {}).get("grade"),
            "witnessVariantIds": witnesses,
            "floorBy": floor_by,
            "representativeGrade": (o.get("representative") or {}).get("grade"),
            "representedCoverage": (o.get("coverage") or {}).get("represented"),
            "calculationComplete": bool(o.get("calculation_complete")),
            "cells": cells_by_opp.get(o.get("opponent"), []),
        })
    checks = {"topK": int(cc_raw.get("top_k") or 0) or len(by_opp),
              "confidence": str(cc_raw.get("confidence") or ""),
              "byOpponent": by_opp} if by_opp else None
    issues = []
    for msg in validate_raw.get("messages") or []:
        if not isinstance(msg, dict) or not isinstance(msg.get("code"), str):
            continue
        severity = msg.get("severity")
        if severity not in ("error", "warning", "skipped"):
            continue
        params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
        issues.append({"severity": severity, "code": msg["code"],
                       "params": {str(k): v for k, v in params.items()
                                  if v is None or isinstance(v, (str, int, float, bool))}})
    return {
        "team": team,
        "legality": {
            "status": str(validate_raw.get("status") or "unknown"),
            "confidence": validate_raw.get("confidence"),
            "errors": _str_list(validate_raw.get("errors")),
            "warnings": _str_list(validate_raw.get("warnings")),
            "issues": issues,
        },
        "defense": {"byAttackType": by_attack},
        "offense": {
            "hardGaps": [str(t) for t in (offense.get("hard_gaps") or [])],
            "stabTypes": [str(t) for t in (attack_types.get("stab") or [])],
            "otherTypes": [str(t) for t in (attack_types.get("other") or [])],
            # Fidelity with the skill's ⚠️ banner: a listed hard gap is only trustworthy when
            # every counted member has an authoritative moveset. When some don't, their offense
            # is UNKNOWN (not counted) and a gap may be a phantom — the SPA must say so instead
            # of presenting an unconfirmed gap as fact (audit 2026-07-16).
            "gapsConfirmed": bool(offense.get("gaps_confirmed", True)),
            "incompleteMembers": _incomplete_members(offense.get("incomplete_members")),
        },
        "speed": {"order": order(speed.get("order")),
                  "orderUnderTrickRoom": order(speed.get("order_under_trick_room")),
                  "members": members},
        "roles": {"coverage": coverage, "members": role_members,
                  # Same caveat for the role checklist: a "not detected" role is only reliable
                  # when every member's moveset is authoritative — otherwise a move signal may
                  # simply be unknown, not absent (mirrors the skill's ⚠️ role banner).
                  "coverageConfirmed": bool(roles.get("coverage_confirmed", True)),
                  "incompleteMembers": _incomplete_members(roles.get("incomplete_members"))},
        **({"checks": checks} if checks else {}),
    }
