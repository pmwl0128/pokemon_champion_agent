#!/usr/bin/env python
"""Executable I/O contracts for the team skill (design audit 2026-06-21, point 5).

The skill passes loose dicts between modules and to/from the sibling skills, which is how the
field-drift bugs got in (raw-speed `vs`, NCP `screens` vs `defenderSide`, condition keys). This
module is the single, *executable* source of truth for those shapes: enumerated field values,
stable error codes, and validators that return structured `ContractError`s instead of silently
accepting malformed input. It is enforced at the CLI boundary (team.py) so internal callers stay
lenient and unit-testable.

stdlib-only by design: a skill must run under a bare `python` via subprocess, so no pydantic /
third-party deps (same constraint as the rest of scripts/). The validators ARE the schema.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# --- versioning -------------------------------------------------------------
SCHEMA_VERSION = 1                      # the version this skill emits
SUPPORTED_SCHEMA_VERSIONS = {1}        # versions it accepts as input

# --- enumerated field values (the contract) ---------------------------------
FORMATS = {"single", "double"}
COMPLETENESS = {"observed_full_set", "observed_species_only", "extracted_set", "inferred_set"}
BENCHMARK_KINDS = {"survive", "outspeed", "ohko", "2hko"}
PROBABILITIES = {"guaranteed", "likely", "any"}
CONFIDENCE = {"high", "medium", "low"}
CONDITION_KEYS = {"stealth_rock", "tailwind", "trickroom", "weather", "terrain", "screens"}
SCREEN_VALUES = {"reflect", "light_screen", "aurora_veil"}    # plus bare boolean true
STAT_KEYS = {"hp", "atk", "def", "spa", "spd", "spe"}
TEAM_FIELDS = {"schema_version", "format", "season", "rule", "pokemon", "decklist", "provenance"}
MEMBER_FIELDS = {"species", "name", "item", "ability", "moves", "attacks", "nature",
                 "spread", "tera", "completeness"}
CONTEXT_FIELDS = {"season", "rule", "format", "locked", "owned_only", "owned", "wants",
                  "keep_mega", "avoid", "benchmarks", "need", "replace"}
BENCHMARK_FIELDS = {"member", "kind", "vs", "move", "conditions", "probability", "attacker_set"}


# --- error model ------------------------------------------------------------
class Code:
    SCHEMA_VERSION = "E_SCHEMA_VERSION"   # unsupported schema_version
    TYPE = "E_TYPE"                       # wrong JSON type for a field
    ENUM = "E_ENUM"                       # value outside the allowed set
    MISSING = "E_MISSING"                 # required field absent/empty
    RANGE = "E_RANGE"                     # numeric out of range
    UNKNOWN_FIELD = "W_UNKNOWN_FIELD"     # field not in the contract (warning)
    SUSPECT = "W_SUSPECT"                 # legal-shaped but likely wrong (warning)


@dataclass
class ContractError:
    code: str
    path: str
    message: str
    severity: str = "error"              # "error" | "warning"

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "path": self.path, "message": self.message, "severity": self.severity}


def fatal(errors: list[ContractError]) -> bool:
    return any(e.severity == "error" for e in errors)


# --- small helpers ----------------------------------------------------------
def _is_str(v: Any) -> bool:
    return isinstance(v, str)


def _is_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _err(out: list[ContractError], code: str, path: str, msg: str) -> None:
    out.append(ContractError(code, path, msg))


def _warn(out: list[ContractError], code: str, path: str, msg: str) -> None:
    out.append(ContractError(code, path, msg, severity="warning"))


def _check_version(d: dict, out: list[ContractError]) -> None:
    v = d.get("schema_version", SCHEMA_VERSION)
    if not _is_int(v) or v not in SUPPORTED_SCHEMA_VERSIONS:
        _err(out, Code.SCHEMA_VERSION, "schema_version",
             f"unsupported schema_version {v!r}; this skill supports {sorted(SUPPORTED_SCHEMA_VERSIONS)}")


def _check_unknown(d: dict, allowed: set[str], path: str, out: list[ContractError]) -> None:
    for k in d:
        if k not in allowed:
            _warn(out, Code.UNKNOWN_FIELD, f"{path}.{k}" if path else k, f"unknown field `{k}`")


# --- public validators ------------------------------------------------------
def check_team(d: Any) -> list[ContractError]:
    """Validate a team-json dict against the contract. Returns [] when clean."""
    out: list[ContractError] = []
    if not isinstance(d, dict):
        _err(out, Code.TYPE, "", "team-json must be a JSON object")
        return out
    _check_version(d, out)
    _check_unknown(d, TEAM_FIELDS, "", out)
    fmt = d.get("format")
    if fmt is not None and fmt not in FORMATS:
        _err(out, Code.ENUM, "format", f"format must be one of {sorted(FORMATS)}; got {fmt!r}")
    members = d.get("pokemon", d.get("decklist"))
    if not isinstance(members, list) or not members:
        _err(out, Code.MISSING, "pokemon", "team-json needs a non-empty `pokemon` list")
        return out
    for i, m in enumerate(members):
        _check_member(m, f"pokemon[{i}]", out)
    return out


def _check_member(m: Any, path: str, out: list[ContractError]) -> None:
    if not isinstance(m, dict):
        _err(out, Code.TYPE, path, "member must be a JSON object")
        return
    _check_unknown(m, MEMBER_FIELDS, path, out)
    species = m.get("species") or m.get("name")
    if not _is_str(species) or not species.strip():
        _err(out, Code.MISSING, f"{path}.species", "member needs a non-empty `species`")
    for key in ("item", "ability", "nature"):
        if m.get(key) is not None and not _is_str(m[key]):
            _err(out, Code.TYPE, f"{path}.{key}", f"`{key}` must be a string or null")
    moves = m.get("moves", m.get("attacks"))
    if moves is not None:
        if not isinstance(moves, list) or any(not _is_str(x) for x in moves):
            _err(out, Code.TYPE, f"{path}.moves", "`moves` must be a list of strings")
    sp = m.get("spread")
    if sp is not None:
        if not isinstance(sp, dict):
            _err(out, Code.TYPE, f"{path}.spread", "`spread` must be an object of stat -> SP")
        else:
            for k, v in sp.items():
                if k not in STAT_KEYS:
                    _warn(out, Code.UNKNOWN_FIELD, f"{path}.spread.{k}", f"unknown stat `{k}`")
                elif not _is_int(v):
                    # A wrong TYPE (e.g. "32", 32.0, true) is a type error, not a range error: every
                    # other field in this contract reports a type mismatch as E_TYPE, and an LLM/API
                    # caller auto-repairs a type fault differently from a bound fault (audit 2026-06-28).
                    _err(out, Code.TYPE, f"{path}.spread.{k}", "SP must be an integer")
                elif v < 0:
                    _err(out, Code.RANGE, f"{path}.spread.{k}", "SP must be a non-negative integer")
    comp = m.get("completeness")
    if comp is not None and comp not in COMPLETENESS:
        _err(out, Code.ENUM, f"{path}.completeness", f"completeness must be one of {sorted(COMPLETENESS)}")
    if m.get("tera"):
        _warn(out, Code.SUSPECT, f"{path}.tera", "Champions has no Terastallization; `tera` should be null")


def check_context(d: Any) -> list[ContractError]:
    """Validate a build-context dict (including its benchmarks)."""
    out: list[ContractError] = []
    if not isinstance(d, dict):
        _err(out, Code.TYPE, "", "build-context must be a JSON object")
        return out
    _check_unknown(d, CONTEXT_FIELDS, "", out)
    fmt = d.get("format")
    if fmt is not None and fmt not in FORMATS:
        _err(out, Code.ENUM, "format", f"format must be one of {sorted(FORMATS)}; got {fmt!r}")
    if d.get("owned_only") is not None and not isinstance(d.get("owned_only"), bool):
        _err(out, Code.TYPE, "owned_only", "`owned_only` must be a boolean")
    for key in ("locked", "owned", "wants", "avoid"):
        if d.get(key) is not None and (not isinstance(d[key], list) or any(not _is_str(x) for x in d[key])):
            _err(out, Code.TYPE, key, f"`{key}` must be a list of strings")
    benches = d.get("benchmarks")
    if benches is not None:
        if not isinstance(benches, list):
            _err(out, Code.TYPE, "benchmarks", "`benchmarks` must be a list")
        else:
            for i, b in enumerate(benches):
                out.extend(check_benchmark(b, f"benchmarks[{i}]"))
    if d.get("need") is not None:
        out.extend(check_need(d["need"]))
    if d.get("replace") is not None:
        out.extend(check_replace(d["replace"]))
    return out


REPLACE_FIELDS = {"member", "with"}


def check_replace(r: Any, path: str = "replace") -> list[ContractError]:
    """Validate the L3 replace-impact spec: {member: <species to remove>, with: <a team-json member>}."""
    out: list[ContractError] = []
    if not isinstance(r, dict):
        _err(out, Code.TYPE, path, "`replace` must be an object")
        return out
    _check_unknown(r, REPLACE_FIELDS, path, out)
    if not _is_str(r.get("member")) or not r["member"].strip():
        _err(out, Code.MISSING, f"{path}.member", "`replace.member` (the species to remove) is required")
    w = r.get("with")
    if w is None:
        _err(out, Code.MISSING, f"{path}.with", "`replace.with` (the candidate member) is required")
    elif isinstance(w, str):
        # Common shorthand mistake: a bare name string. Say exactly what shape is expected rather than
        # the generic "member must be a JSON object" (audit 2026-06-28).
        _err(out, Code.TYPE, f"{path}.with",
             '`replace.with` must be a full member object, e.g. {"species": "Mimikyu"}, not a bare name string')
    else:
        _check_member(w, f"{path}.with", out)          # the candidate must be a valid team-json member
    return out


NEED_FIELDS = {"resist", "offense_type", "role", "min_speed"}


def check_need(n: Any, path: str = "need") -> list[ContractError]:
    """Validate the L3 `fill` gap spec (design §6/§13). Keeps fill a safe CLI/front-end entry: a bad
    `min_speed` (e.g. "fast") would otherwise ValueError mid-run (audit 2026-06-24)."""
    out: list[ContractError] = []
    if not isinstance(n, dict):
        _err(out, Code.TYPE, path, "`need` must be an object")
        return out
    _check_unknown(n, NEED_FIELDS, path, out)
    for key in ("resist", "offense_type", "role"):
        v = n.get(key)
        if v is not None and not (_is_str(v) or (isinstance(v, list) and all(_is_str(x) for x in v))):
            _err(out, Code.TYPE, f"{path}.{key}", f"`{key}` must be a string or list of strings")
    ms = n.get("min_speed")
    if ms is not None and not _is_int(ms):
        _err(out, Code.TYPE, f"{path}.min_speed", "`min_speed` must be an integer")
    return out


def check_benchmark(b: Any, path: str = "benchmark") -> list[ContractError]:
    """Validate one tune benchmark. Encodes the `vs`/`conditions`/`screens` contract that drifted."""
    out: list[ContractError] = []
    if not isinstance(b, dict):
        _err(out, Code.TYPE, path, "benchmark must be a JSON object")
        return out
    _check_unknown(b, BENCHMARK_FIELDS, path, out)
    if not _is_str(b.get("member")) or not b["member"].strip():
        _err(out, Code.MISSING, f"{path}.member", "benchmark needs a `member`")
    kind = b.get("kind")
    if kind not in BENCHMARK_KINDS:
        _err(out, Code.ENUM, f"{path}.kind", f"kind must be one of {sorted(BENCHMARK_KINDS)}; got {kind!r}")
    # `vs`: a species name, or a raw Speed number for outspeed only.
    vs = b.get("vs")
    vs_is_num = _is_int(vs) or isinstance(vs, float)
    if vs is None or (not _is_str(vs) and not vs_is_num):
        _err(out, Code.TYPE, f"{path}.vs", "`vs` must be a species name (or a raw Speed number for outspeed)")
    elif vs_is_num and kind != "outspeed":
        _err(out, Code.TYPE, f"{path}.vs", f"a raw-Speed `vs` is only valid for kind=outspeed, not {kind!r}")
    if kind in ("survive", "ohko", "2hko") and not _is_str(b.get("move")):
        _err(out, Code.MISSING, f"{path}.move", f"kind={kind} needs a `move`")
    prob = b.get("probability")
    if prob is not None and prob not in PROBABILITIES:
        _err(out, Code.ENUM, f"{path}.probability", f"probability must be one of {sorted(PROBABILITIES)}")
    conds = b.get("conditions")
    if conds is not None:
        if not isinstance(conds, dict):
            _err(out, Code.TYPE, f"{path}.conditions", "`conditions` must be an object")
        else:
            for k, v in conds.items():
                if k not in CONDITION_KEYS:
                    _err(out, Code.ENUM, f"{path}.conditions.{k}",
                         f"unknown condition `{k}`; allowed: {sorted(CONDITION_KEYS)}")
                elif k == "weather" and not (_is_str(v) or isinstance(v, bool)):
                    _err(out, Code.TYPE, f"{path}.conditions.weather", "`weather` must be a string or boolean")
                elif k == "terrain" and not _is_str(v):
                    _err(out, Code.TYPE, f"{path}.conditions.terrain",
                         "`terrain` must be a string naming the field (e.g. \"electric\" for Surge Surfer)")
                elif k == "screens" and not (isinstance(v, bool) or (_is_str(v) and v in SCREEN_VALUES)):
                    _err(out, Code.ENUM, f"{path}.conditions.screens",
                         f"`screens` must be true or one of {sorted(SCREEN_VALUES)}")
                elif k in ("stealth_rock", "tailwind", "trickroom") and not isinstance(v, bool):
                    _err(out, Code.TYPE, f"{path}.conditions.{k}", f"`{k}` must be a boolean")
    return out


def check_evidence(e: Any, path: str = "evidence") -> list[ContractError]:
    """Light validation for an output-side evidence block (facts + note + optional confidence)."""
    out: list[ContractError] = []
    if not isinstance(e, dict):
        _err(out, Code.TYPE, path, "evidence must be a JSON object")
        return out
    if "facts" in e and not isinstance(e["facts"], list):
        _err(out, Code.TYPE, f"{path}.facts", "`facts` must be a list")
    conf = e.get("confidence")
    if conf is not None and conf not in CONFIDENCE:
        _err(out, Code.ENUM, f"{path}.confidence", f"confidence must be one of {sorted(CONFIDENCE)}")
    return out


def format_errors(errors: list[ContractError]) -> str:
    if not errors:
        return "Contract: OK"
    lines = ["# Contract check"]
    for e in errors:
        tag = "ERROR" if e.severity == "error" else "warn "
        lines.append(f"- [{tag}] {e.code} @ {e.path or '(root)'}: {e.message}")
    return "\n".join(lines)
