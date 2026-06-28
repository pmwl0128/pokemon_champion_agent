#!/usr/bin/env python
from __future__ import annotations

import argparse
import json
import operator
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SKILL_DIR = Path(__file__).resolve().parents[1]
DB_PATH = SKILL_DIR / "data" / "champions_dex.sqlite"

STAT_ALIASES = {
    "hp": "hp",
    "at": "at", "atk": "at", "attack": "at", "攻击": "at", "物攻": "at",
    "df": "df", "def": "df", "defense": "df", "防御": "df", "物防": "df",
    "sa": "sa", "spa": "sa", "spatk": "sa", "特攻": "sa",
    "sd": "sd", "spd": "sd", "spdef": "sd", "特防": "sd",
    "sp": "sp", "spe": "sp", "speed": "sp", "速度": "sp",
}
OPS = {">=": operator.ge, "<=": operator.le, ">": operator.gt, "<": operator.lt, "=": operator.eq, "==": operator.eq}

# Canonical external contract (dev/contracts/conventions.md): smogon stat keys + int power + a
# uniform error shape. The dex DB stores NCP-native short keys; we translate only at CLI emit time.
SHORT_TO_SMOGON = {"hp": "hp", "at": "atk", "df": "def", "sa": "spa", "sd": "spd", "sp": "spe"}


def canonical_stats(raw: dict[str, Any]) -> dict[str, Any]:
    """DB short stat keys (at/df/sa/sd/sp) -> canonical smogon keys (atk/def/spa/spd/spe)."""
    return {smogon: raw[short] for short, smogon in SHORT_TO_SMOGON.items() if short in raw}


def canonical_power(value: Any) -> Any:
    """Move base power as an int (the DB stores it as a string); None when the move has no power."""
    if value in (None, ""):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def not_found(name: str, code: str = "not_found") -> dict[str, Any]:
    return {"ok": False, "query": name, "error": {"code": code, "message": f"not found: {name}"}}


def normalize(text: str) -> str:
    # NFKC folds full-width <-> half-width (Japanese sources vary, e.g. １０ vs 10),
    # so Japanese aliases match regardless of how the query is typed.
    text = unicodedata.normalize("NFKC", str(text))
    return re.sub(r"[\s\-_'’().:：/\\\[\]{}]+", "", text.strip().lower())


def ensure_db() -> None:
    if DB_PATH.exists():
        return
    raise SystemExit(
        f"dex database not found at {DB_PATH}. This skill ships a prebuilt, "
        "read-only database; reinstall the skill to restore it."
    )


def conn() -> sqlite3.Connection:
    ensure_db()
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    return c


def resolve(c: sqlite3.Connection, kind: str, text: str) -> str | None:
    norm = normalize(text)
    row = c.execute(
        "select canonical from aliases where kind=? and normalized=? limit 1",
        (kind, norm),
    ).fetchone()
    if row:
        return row["canonical"]
    table = {"pokemon": "pokemon", "move": "moves", "ability": "abilities", "item": "items"}.get(kind)
    if table:
        row = c.execute(f"select canonical from {table} where lower(canonical)=lower(?) limit 1", (text,)).fetchone()
        if row:
            return row["canonical"]
    return None


# --- Fuzzy resolution (DEFAULT third tier; design: dev/update/dex/fuzzy_resolve_design.md) ----------
# dex is the naming authority, so resolution is fuzzy-tolerant BY DEFAULT: any caller that asks dex to
# resolve a name gets the typo fallback for free, and a caller that needs a miss to stay a miss opts out
# with `--strict` (validation, integrity checks). A wrong fuzzy hit silently mis-resolves a typo to the
# WRONG entity (a different Pokemon/item looks legal), so this layer is conservative: tight
# per-script/per-length max edit distance, Han disabled in v1 (a 1-char diff in a short Chinese name is
# usually a different species), and a hard ambiguity gate that REFUSES rather than guessing when two
# candidates tie. Fuzzy never fires when exact succeeds (exact short-circuits first).
_FUZZY_POOL_CACHE: dict[tuple[str, str], list[tuple[str, str]]] = {}


def _dominant_script(s: str) -> str:
    """Classify a normalized query by its single dominant script; mixed -> 'mixed' (fuzzy disabled)."""
    han = kana = latin = False
    for ch in s:
        o = ord(ch)
        if 0x4E00 <= o <= 0x9FFF:
            han = True
        elif 0x3040 <= o <= 0x30FF or 0x31F0 <= o <= 0x31FF:
            kana = True
        elif "a" <= ch <= "z" or "0" <= ch <= "9":
            latin = True
    if sum((han, kana, latin)) != 1:
        return "mixed"
    return "han" if han else ("kana" if kana else "latin")


def _fuzzy_max_distance(script: str, length: int) -> int:
    """Allowed edit distance by script x length. 0 == fuzzy disabled for this query."""
    if script == "latin":
        if length < 4:
            return 0
        return 1 if length <= 5 else 2     # hard cap 2 — never let a long name drift to a neighbour
    if script == "kana":
        return 1 if length >= 4 else 0     # dakuten/長音 typos are 1 char; tighter than latin
    return 0                                # han / mixed / other: disabled in v1 (too short, too risky)


def _capped_levenshtein(a: str, b: str, max_d: int) -> int | None:
    """True Levenshtein distance, or None when it exceeds max_d. Full-row DP with a row-min cutoff
    (NOT a diagonal-band DP — band edge init is error-prone and can yield false positives that match
    unrelated words). Verified row-for-row against an unbounded reference over 200k random cases."""
    la, lb = len(a), len(b)
    if abs(la - lb) > max_d:
        return None
    if la == 0:
        return lb if lb <= max_d else None
    if lb == 0:
        return la if la <= max_d else None
    prev = list(range(lb + 1))
    for i in range(1, la + 1):
        cur = [i] + [0] * lb
        row_min = i
        ai = a[i - 1]
        for j in range(1, lb + 1):
            cost = 0 if ai == b[j - 1] else 1
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
            if cur[j] < row_min:
                row_min = cur[j]
        if row_min > max_d:
            return None
        prev = cur
    return prev[lb] if prev[lb] <= max_d else None


def _fuzzy_pool(c: sqlite3.Connection, kind: str) -> list[tuple[str, str]]:
    """Cached (normalized_alias, canonical) candidate pool for one kind, loaded once per (db, kind).
    The DB is read-only, so a process-lifetime cache is safe; the resident worker reuses it."""
    db = (c.execute("pragma database_list").fetchone() or ("", "", ""))[2] or ""
    key = (db, kind)
    pool = _FUZZY_POOL_CACHE.get(key)
    if pool is None:
        pool = [(r[0], r[1]) for r in
                c.execute("select normalized, canonical from aliases where kind=?", (kind,))]
        _FUZZY_POOL_CACHE[key] = pool
    return pool


def _fuzzy_match(c: sqlite3.Connection, kind: str, norm_text: str) -> dict[str, Any] | None:
    """Best fuzzy canonical for a normalized query, or None. Refuses (canonical=None, ambiguous=True)
    when >=2 distinct canonicals tie at the best distance — never guesses between them."""
    if not norm_text:
        return None
    max_d = _fuzzy_max_distance(_dominant_script(norm_text), len(norm_text))
    if max_d == 0:
        return None
    length = len(norm_text)
    best: dict[str, int] = {}
    for cand_norm, canonical in _fuzzy_pool(c, kind):
        if abs(len(cand_norm) - length) > max_d:
            continue
        d = _capped_levenshtein(norm_text, cand_norm, max_d)
        if d is None:
            continue
        if canonical not in best or d < best[canonical]:
            best[canonical] = d
    if not best:
        return None
    ranked = sorted(best.items(), key=lambda kv: (kv[1], kv[0]))
    best_canon, best_d = ranked[0]
    score = lambda d: round(1 - d / length, 3)  # noqa: E731
    alts = [{"canonical": cn, "distance": d, "score": score(d)} for cn, d in ranked[:3]]
    if len(ranked) >= 2 and ranked[1][1] == best_d:
        return {"canonical": None, "match_type": "fuzzy", "score": score(best_d),
                "distance": best_d, "ambiguous": True, "alternatives": alts}
    return {"canonical": best_canon, "match_type": "fuzzy", "score": score(best_d),
            "distance": best_d, "alternatives": alts}


def resolve_rich(c: sqlite3.Connection, kind: str, text: str, *, fuzzy: bool = True) -> dict[str, Any]:
    """Unified resolution result. Exact short-circuits (fuzzy never fires on a hit). Fuzzy is ON by
    default (dex owns resolution quality); pass fuzzy=False for strict callers (validation/integrity).
    With fuzzy=False this is just `resolve()` wrapped in metadata; bare `resolve()` is always exact."""
    canon = resolve(c, kind, text)
    norm = normalize(text)
    if canon:
        return {"canonical": canon, "match_type": "exact", "score": 1.0,
                "distance": 0, "query_norm": norm, "alternatives": []}
    if fuzzy:
        fm = _fuzzy_match(c, kind, norm)
        if fm is not None:
            fm["query_norm"] = norm
            fm.setdefault("alternatives", [])
            return fm
    return {"canonical": None, "match_type": None, "score": 0.0,
            "distance": None, "query_norm": norm, "alternatives": []}


def row_to_pokemon(row: sqlite3.Row, c: sqlite3.Connection, include_moves: bool = False) -> dict[str, Any]:
    data = {
        "name": row["canonical"],
        "display_name": row["display_name"],
        "types": json.loads(row["types_json"] or "[]"),
        "stats": canonical_stats(json.loads(row["stats_json"] or "{}")),
        "abilities": json.loads(row["abilities_json"] or "[]"),
        "is_mega": bool(row["is_mega"]),
        "base_species": row["base_species"],
        "required_item": row["required_item"],
    }
    if include_moves:
        moves = [r["move"] for r in c.execute("select move from learnsets where pokemon=? order by move", (row["canonical"],))]
        data["moves"] = moves
    return data


def get_one(c: sqlite3.Connection, kind: str, name: str, fuzzy: bool = True) -> dict[str, Any]:
    rr = resolve_rich(c, kind, name, fuzzy=fuzzy)
    canonical = rr["canonical"]
    if canonical is None:
        nf = not_found(name)
        if fuzzy and rr.get("alternatives"):
            # Non-silent: a miss under fuzzy carries did-you-mean candidates (and flags genuine
            # ambiguity) so the caller decides — it never auto-resolves to one of them.
            nf["suggestions"] = rr["alternatives"]
            if rr.get("ambiguous"):
                nf["error"]["code"] = "ambiguous"
        return nf

    if kind == "pokemon":
        row = c.execute("select * from pokemon where canonical=?", (canonical,)).fetchone()
        entity = row_to_pokemon(row, c, include_moves=True) if row else None
    elif kind == "move":
        row = c.execute("select * from moves where canonical=?", (canonical,)).fetchone()
        if row:
            users = [r["pokemon"] for r in c.execute("select pokemon from learnsets where move=? order by pokemon", (canonical,))]
            entity = {
                "name": row["canonical"], "display_name": row["display_name"], "type": row["type"],
                "category": row["category"], "power": canonical_power(row["power"]), "accuracy": row["accuracy"],
                "pp": row["pp"], "priority": row["priority"], "known_users": users,
            }
        else:
            entity = None
    elif kind == "ability":
        row = c.execute("select * from abilities where canonical=?", (canonical,)).fetchone()
        if row:
            users = []
            for p in c.execute("select * from pokemon"):
                abilities = json.loads(p["abilities_json"] or "[]")
                if canonical in abilities:
                    users.append(p["canonical"])
            entity = {"name": row["canonical"], "display_name": row["display_name"], "known_users": users}
        else:
            entity = None
    elif kind == "item":
        row = c.execute("select * from items where canonical=?", (canonical,)).fetchone()
        if row:
            holders = [r["canonical"] for r in c.execute("select canonical from pokemon where required_item=? order by canonical", (canonical,))]
            entity = {"name": row["canonical"], "display_name": row["display_name"], "required_by": holders}
        else:
            entity = None
    else:
        raise ValueError(f"unknown kind: {kind}")

    if entity is None:
        return not_found(name)
    if rr["match_type"] == "fuzzy":
        # Tag the correction so callers can record provenance and cap confidence (never silent).
        entity["resolution"] = {"match_type": "fuzzy", "score": rr["score"],
                                "distance": rr["distance"], "from": rr["query_norm"]}
    return entity


def parse_conditions(tokens: list[str]) -> list[tuple[str, str]]:
    if len(tokens) % 2 != 0:
        raise SystemExit("find/reverse needs field value pairs, e.g. find move 近身战 type 飞行")
    return [(tokens[i].lower(), tokens[i + 1]) for i in range(0, len(tokens), 2)]


def stat_ok(stats: dict[str, Any], expr: str) -> bool:
    m = re.match(r"^([A-Za-z\u4e00-\u9fff]+)\s*(>=|<=|==|=|>|<)\s*(\d+)$", expr.strip())
    if not m:
        raise SystemExit(f"bad stat expression: {expr}")
    stat = STAT_ALIASES.get(normalize(m.group(1)))
    if not stat:
        raise SystemExit(f"unknown stat: {m.group(1)}")
    value = int(stats.get(stat, 0))
    return OPS[m.group(2)](value, int(m.group(3)))


def find(c: sqlite3.Connection, conditions: list[tuple[str, str]]) -> dict[str, Any]:
    rows = list(c.execute("select * from pokemon order by canonical"))
    learnset_warning = False
    resolved_conditions = []
    # find/reverse are exact-only (no fuzzy), so a condition value that isn't a known alias (妖精 typed
    # as 仙, a misspelled move) resolves to None and would silently filter on the raw garbage -> Count 0,
    # indistinguishable from a genuine empty result. Record those so the caller can tell "no matches"
    # from "bad filter keyword" (audit 2026-06-28). exact-only is unchanged; this only adds a signal.
    unresolved: list[dict[str, str]] = []

    for field, value in conditions:
        if field in {"move", "moves", "learns", "会"}:
            move = resolve(c, "move", value)
            if move is None:
                unresolved.append({"field": "move", "value": value})
                move = value
            users = {r["pokemon"] for r in c.execute("select pokemon from learnsets where move=?", (move,))}
            rows = [r for r in rows if r["canonical"] in users]
            if not users:
                learnset_warning = True
            resolved_conditions.append(("move", move))
        elif field in {"ability", "特性"}:
            ability = resolve(c, "ability", value)
            if ability is None:
                unresolved.append({"field": "ability", "value": value})
                ability = value
            rows = [r for r in rows if ability in json.loads(r["abilities_json"] or "[]")]
            resolved_conditions.append(("ability", ability))
        elif field in {"type", "属性"}:
            typ = resolve(c, "type", value)
            if typ is None:
                unresolved.append({"field": "type", "value": value})
                typ = value
            rows = [r for r in rows if typ in json.loads(r["types_json"] or "[]")]
            resolved_conditions.append(("type", typ))
        elif field in {"pokemon", "name", "宝可梦"}:
            n = normalize(value)
            matched = set()
            for a in c.execute("select canonical from aliases where kind='pokemon' and normalized like ?", (f"%{n}%",)):
                matched.add(a["canonical"])
            rows = [r for r in rows if r["canonical"] in matched or n in normalize(r["canonical"]) or n in normalize(r["display_name"])]
            resolved_conditions.append(("name", value))
        elif field in {"mega", "超级"}:
            want = normalize(value) not in {"false", "no", "0", "否", "不是"}
            rows = [r for r in rows if bool(r["is_mega"]) == want]
            resolved_conditions.append(("mega", str(want)))
        elif field in {"stat", "stats", "能力"}:
            rows = [r for r in rows if stat_ok(json.loads(r["stats_json"] or "{}"), value)]
            resolved_conditions.append(("stat", value))
        elif field in {"item", "道具"}:
            item = resolve(c, "item", value)
            if item is None:
                unresolved.append({"field": "item", "value": value})
                item = value
            rows = [r for r in rows if r["required_item"] == item]
            resolved_conditions.append(("item", item))
        else:
            raise SystemExit(f"unknown condition field: {field}")

    return {
        "conditions": resolved_conditions,
        "count": len(rows),
        "learnset_warning": learnset_warning,
        "unresolved_conditions": unresolved,
        "results": [row_to_pokemon(r, c, include_moves=False) for r in rows],
    }


def _resolution_md(data: dict[str, Any]) -> list[str]:
    """The fuzzy-correction provenance line for an entity panel — empty for an exact hit. Surfacing it in
    md keeps the 'a correction is never silent' promise at the DEFAULT (md) layer, not only in json."""
    r = data.get("resolution")
    if not r:
        return []
    return [f"- resolved: `{r.get('from', '')}` → {data.get('name')} "
            f"({r.get('match_type')}, distance {r.get('distance')}, score {r.get('score')})"]


def format_md(data: Any) -> str:
    if isinstance(data, list):
        return "\n\n".join(format_md(x) for x in data)
    if "results" in data:
        lines = [f"Conditions: {', '.join(f'{k}={v}' for k, v in data['conditions'])}", f"Count: {data['count']}"]
        if data.get("unresolved_conditions"):
            # find/reverse are exact-only: an unresolved keyword filtered on raw text, so Count may be 0
            # because the FILTER is invalid, not because nothing matched — say which (audit 2026-06-28).
            bad = ", ".join(f"{c['field']}={c['value']}" for c in data["unresolved_conditions"])
            lines.append(f"Note: unrecognized condition keyword(s) — not a known alias, matched literally "
                         f"(a 0 count may be the keyword, not the data): {bad}")
        if data.get("learnset_warning"):
            lines.append("Note: no learnset rows matched; this Pokemon may have no cached learnset coverage.")
        for p in data["results"]:
            lines.append(f"- {p['display_name']} / {p['name']} | {'/'.join(p['types'])} | stats {p['stats']} | abilities {', '.join(p['abilities'])}" + (f" | item {p['required_item']}" if p.get("required_item") else ""))
        return "\n".join(lines)
    if data.get("error"):
        err = data["error"]
        msg = err.get("message") if isinstance(err, dict) else err
        # Batch error items carry their input position (contract §3); keep that anchor in md so a caller
        # can align the failure to the Nth argument. Did-you-mean suggestions (ambiguous tie / near miss)
        # are surfaced too, so a miss is never silent at the md layer (audit 2026-06-28).
        prefix = f"[{data['index']}] " if "index" in data else ""
        line = f"{prefix}{data.get('query')}: {msg}"
        sugg = data.get("suggestions")
        if sugg:
            cands = ", ".join(f"{s.get('canonical')} (distance {s.get('distance')})" for s in sugg)
            line += f" — did you mean: {cands}"
        return line
    if "types" in data:
        lines = [
            f"## {data['display_name']} / {data['name']}",
            f"- Types: {'/'.join(data['types'])}",
            f"- Stats: {data['stats']}",
            f"- Abilities: {', '.join(data['abilities'])}",
            f"- Mega: {data['is_mega']}",
        ]
        if data.get("required_item"):
            lines.append(f"- Required item: {data['required_item']}")
        if data.get("moves") is not None:
            lines.append(f"- Cached moves ({len(data['moves'])}): {', '.join(data['moves']) if data['moves'] else '(none cached)'}")
        lines += _resolution_md(data)
        return "\n".join(lines)
    if "known_users" in data:
        # Priority shown only when non-zero (0 == normal); signed so -7 Trick Room / +2 Extreme Speed read right.
        prio = data.get("priority")
        prio_line = [f"- priority: {prio:+d}"] if isinstance(prio, int) and prio != 0 else []
        return "\n".join([
            f"## {data.get('display_name')} / {data.get('name')}",
            *(f"- {k}: {data[k]}" for k in ["type", "category", "power", "accuracy", "pp"] if k in data),
            *prio_line,
            f"- Known users ({len(data['known_users'])}): {', '.join(data['known_users']) if data['known_users'] else '(none cached)'}",
            *_resolution_md(data),
        ])
    if "required_by" in data:
        return "\n".join([
            f"## {data['display_name']} / {data['name']}",
            f"- Required by: {', '.join(data['required_by']) if data['required_by'] else '(none)'}",
            *_resolution_md(data),
        ])
    return json.dumps(data, ensure_ascii=False, indent=2)


def emit(data: Any, fmt: str) -> None:
    if fmt == "json":
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print(format_md(data))


# Machine-readable I/O contract (dev/contracts/conventions.md), emitted by the `schema` command so an
# AI caller can learn the exact format without reading source. Pinned by the dex contract test.
SCHEMA = {
    "skill": "pokemon-champions-dex",
    "contract": "dev/contracts/conventions.md",
    "stat_keys": ["hp", "atk", "def", "spa", "spd", "spe"],
    "error_shape": {"ok": False, "query": "<input>", "error": {"code": "not_found", "message": "<str>"}},
    "commands": {
        "pokemon|move|ability|item": "<name ...> [--format md|json] [--strict]; >1 name -> list; a miss -> error_shape",
        "batch": "<kind> <name ...> [--strict]; always a list; misses inline as error_shape",
        "find|reverse": "<field> <value> ...; ANDed -> {conditions, count, learnset_warning, unresolved_conditions:[{field,value}], results:[pokemon]} (exact only, never fuzzy; unresolved_conditions lists condition keywords that are not a known alias — they filter literally, so a 0 count there is the keyword, not the data)",
        "schema": "this contract",
    },
    "fuzzy": {
        "default": "pokemon/move/ability/item/batch resolve with a conservative typo fallback BY DEFAULT "
                   "(dex owns naming); exact short-circuits, so a correct name is unaffected. Never fires on a hit.",
        "strict": "--strict disables the fallback (exact only) for callers where a miss must stay a miss "
                  "(validation, integrity). find/reverse are always exact regardless.",
        "on_hit": "entity gains `resolution: {match_type:'fuzzy', score:float, distance:int, from:'<normalized query>'}`",
        "on_miss": "error_shape may gain `suggestions:[{canonical,distance,score}]`; ambiguous ties set error.code='ambiguous' and resolve to NO canonical",
        "discipline": "ambiguity (>=2 canonicals tie at best distance) -> refuse, never guess; Han disabled, Kana<=1, Latin<=2 edit distance, length-gated",
    },
    "shapes": {
        "pokemon": {"name": "English canonical", "display_name": "str", "types": ["Type"],
                    "stats": "{hp,atk,def,spa,spd,spe: int}", "abilities": ["str"], "is_mega": "bool",
                    "base_species": "str", "required_item": "str|null", "moves": ["str (pokemon/batch only)"]},
        "move": {"name": "str", "type": "Type (Title-case)", "category": "Physical|Special|Status",
                 "power": "int|null", "priority": "int (signed speed-priority stage; 0 == normal)",
                 "known_users": ["str"]},
        "ability": {"name": "str", "known_users": ["str"]},
        "item": {"name": "str", "required_by": ["str"]},
    },
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Query the offline Pokemon Champions dex.")
    parser.add_argument("command", choices=["pokemon", "move", "ability", "item", "batch", "find", "reverse", "schema"])
    parser.add_argument("args", nargs="*")
    parser.add_argument("--format", choices=["md", "json"], default="md")
    parser.add_argument("--strict", action="store_true",
                        help="disable the fuzzy fallback (exact only) for pokemon/move/ability/item/batch; "
                             "use when a miss must stay a miss (validation, integrity checks)")
    # Deprecated: fuzzy is now the default, so --fuzzy is a harmless no-op kept for back-compat.
    parser.add_argument("--fuzzy", action="store_true", help=argparse.SUPPRESS)
    ns = parser.parse_args()
    fuzzy = not ns.strict
    if ns.command == "schema":
        print(json.dumps(SCHEMA, ensure_ascii=False, indent=2))
        return 0
    c = conn()
    try:
        if ns.command == "batch":
            if len(ns.args) < 2:
                raise SystemExit("batch needs kind and names, e.g. batch pokemon 姆克鹰 巨金怪")
            kind, names = ns.args[0], ns.args[1:]
            data = []
            for i, n in enumerate(names):
                row = get_one(c, kind, n, fuzzy=fuzzy)
                if isinstance(row, dict) and row.get("ok") is False:
                    row["index"] = i      # batch error items carry their position (contract §3)
                data.append(row)
        elif ns.command in {"pokemon", "move", "ability", "item"}:
            data = [get_one(c, ns.command, n, fuzzy=fuzzy) for n in ns.args]
            if len(data) == 1:
                data = data[0]
        else:
            data = find(c, parse_conditions(ns.args))
        emit(data, ns.format)
    finally:
        c.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
