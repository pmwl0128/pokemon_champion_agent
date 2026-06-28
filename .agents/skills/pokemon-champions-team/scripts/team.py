#!/usr/bin/env python
"""Pokemon Champions team CLI (M1).

Commands:
  parse     <file>            Parse team-json or Showdown text -> canonical team-json.
  validate  <file>            Validate a team against Champions rules (uses sibling dex skill).
  diagnose  <file>            [M2] team diagnostics: defense/offense/speed/roles (--aspect; default all).
  select    <file>            [M2/M3] 6v6 selection matrix / candidate fill.

Options:
  --format md|json            md (default) = readable report; json = programmatic.
  --context <file>            build-context JSON (intent/constraints; schema.md §7). Used by validate
                              for owned_only checks; consumed more by M2/M3.

Use --format json for programmatic output.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

sys.path.insert(0, str(Path(__file__).resolve().parent))
from team_io import load_team, load_context, team_from_dict  # noqa: E402
from validate_team import validate, format_report  # noqa: E402
from dexlink import lookup_pokemon, lookup_moves, canonicalize_species, DexUnavailable  # noqa: E402
from diagnose import (  # noqa: E402
    diagnose_defense, format_defense_md, diagnose_offense, format_offense_md,
    diagnose_speed, format_speed_md, diagnose_roles, format_roles_md,
)
from tune import tune as run_tune, format_tune_md  # noqa: E402
from ncplink import damage_vs, damage_batch, NcpUnavailable, NcpInputError  # noqa: E402
from metalink import (  # noqa: E402
    nature_distribution, usage_top_k, MetaUnavailable,   # opponent SETS now resolve via sources (M4)
)
from selection import select as run_select, format_selection_md  # noqa: E402
from matchup import matchup as run_matchup, format_matchup_md  # noqa: E402
from fill import fill as run_fill, format_fill_md  # noqa: E402  (M3: L3 candidate retrieval)
from replace_impact import replace_impact as run_replace, format_replace_impact_md  # noqa: E402  (M3)
from dexlink import lookup_items  # noqa: E402
import sources  # noqa: E402  (M4: real-team joint set ⊕ meta spread resolver)
import repset  # noqa: E402  (real-team library for fill's co-occurrence / sample views)
import oppcache  # noqa: E402  (M5 step 2: opponent standard-set matchup cache)
import contracts  # noqa: E402
import environment  # noqa: E402
import worker  # noqa: E402


def _load_team(path: str):
    """load_team + fuzzy species canonicalization (design §10). Returns (team, name_flags).

    A USER-typed species typo (garchmp -> Garchomp) is auto-corrected here, BEFORE validate/diagnose,
    so every command operates on canonical names and validate stays strict. The corrections
    (name_flags) are surfaced in output, never silent. Ambiguous/unresolved names are left as-is for
    validate to flag (with suggestions). Dex down -> no correction (honest degradation)."""
    loaded = load_team(path)
    try:
        flags = canonicalize_species(loaded)
    except DexUnavailable:
        flags = []
    return loaded, flags


def _emit_name_flags(flags: list[dict]) -> None:
    """Surface auto-corrected species typos to stderr (visible in every output mode, json stdout
    stays clean). validate/diagnose ALSO embed them in their json under `name_resolution`."""
    for line in _name_flag_lines(flags):
        print(line, file=sys.stderr)


def _name_flag_lines(flags: list[dict]) -> list[str]:
    """Human-facing did-you-mean lines for auto-corrected species typos (non-silent, design §10)."""
    return [f'⚠ 已将 "{f["from"]}" 识别为 {f["to"]}（模糊匹配 d={f.get("distance")}，'
            f'置信={f.get("score")}）— 如不对请改用准确名' for f in flags]


def _stamp(context, team=None) -> tuple[dict, list[str]]:
    """Environment stamp (+ mismatch warnings) for the current base; attached to every output.

    season/rule are taken from the build-context first, then the team-json itself (a team that
    declares its own season/rule must not be silently ignored — audit 2026-06-21), then default.
    When BOTH declare them and disagree, the context wins (it is the intent layer), but the team's
    overridden declaration is reported, never silently dropped (audit 2026-06-21).
    """
    ctx_season = getattr(context, "season", None) if context else None
    ctx_rule = getattr(context, "rule", None) if context else None
    team_season = getattr(team, "season", None) if team else None
    team_rule = getattr(team, "rule", None) if team else None
    stamp, warnings = environment.resolve(ctx_season or team_season, ctx_rule or team_rule)
    if ctx_season and team_season and ctx_season != team_season:
        warnings.append(f"team declares season {team_season!r} but build-context says {ctx_season!r}; "
                        f"used {ctx_season!r} (context overrides the team's declaration).")
    if ctx_rule and team_rule and ctx_rule != team_rule:
        warnings.append(f"team declares rule {team_rule!r} but build-context says {ctx_rule!r}; "
                        f"used {ctx_rule!r} (context overrides the team's declaration).")
    return stamp, warnings


def _check_contracts(team_path: str | None, context_path: str | None = None) -> list:
    """Run the executable I/O contract on the raw inputs (team and/or context) as written,
    before any normalization. Returns ContractErrors (team first, then context); [] when clean
    or when the team is non-JSON Showdown text. A malformed JSON file (syntax error, or a JSON
    array where an object is required) yields a FATAL error here so the caller refuses instead of
    crashing in the loader or misreading an array as Showdown text (audit 2026-06-21)."""
    raw_team, errs = _raw_json(team_path)
    if raw_team is not None:
        errs = errs + contracts.check_team(raw_team)
    if context_path:
        raw_ctx, ctx_errs = _raw_json(context_path, json_only=True)
        errs += ctx_errs
        if raw_ctx is not None:
            errs += contracts.check_context(raw_ctx)
    return errs


def _emit_contract_errs(errs: list, fmt: str) -> None:
    """Print contract errors (stderr for md, so they don't corrupt a JSON stdout payload)."""
    if errs:
        print(contracts.format_errors(errs), file=sys.stderr)


def _env_header(stamp: dict, warnings: list[str]) -> str:
    a = stamp.get("as_of") or {}
    line = (f"_Environment: {stamp['season']} / {stamp['rule']} — "
            f"dex {a.get('dex_built_at') or '?'}, meta {a.get('meta_updated_at') or '?'}_")
    ds = stamp.get("data_season")
    if ds is not None and ds != stamp["season"]:
        # The real-team data was served from a historical PARTITION, not the current base — label it
        # so the result is never read as current-season data (audit 2026-06-26).
        line += f"\n_Data partition: {ds} / {stamp.get('data_rule') or 'rule n/a'} (real-team library)_"
    if warnings:
        line += "\n" + "\n".join(f"> ⚠️ {w}" for w in warnings)
    return line


def _raw_json(path: str | None, *, json_only: bool = False) -> tuple[Any, list]:
    """Parse the raw input for the executable contract (run before normalization).

    Returns (parsed, errors):
      - (obj, [])      input parsed as JSON — hand `obj` (any JSON type) to the contract, which
                       checks it really is the right shape;
      - (None, [])     non-JSON text — a team may be a Showdown paste, so let the loader read it;
      - (None, [err])  the input is malformed where it must be JSON: a `{`/`[`-leading file that
                       fails to parse, or (json_only) any non-JSON build-context. We emit a FATAL
                       contract error so the caller refuses, instead of letting load_team()/
                       load_context() throw or silently parsing a JSON array as Showdown text
                       (audit 2026-06-21).
    `json_only` is for the build-context, which has no Showdown form: non-JSON text is malformed there.
    """
    if not path:
        return None, []
    try:
        text = Path(path).read_text(encoding="utf-8").lstrip()
    except OSError:
        return None, []
    if not text.startswith(("{", "[")):
        if json_only:
            return None, [contracts.ContractError(
                contracts.Code.TYPE, "", "build-context must be a JSON object")]
        return None, []                       # Showdown paste — the loader handles it
    try:
        return json.loads(text), []
    except json.JSONDecodeError as e:
        return None, [contracts.ContractError(
            contracts.Code.TYPE, "",
            f"input is not valid JSON ({e.msg} at line {e.lineno} column {e.colno})")]


def cmd_parse(path: str, fmt: str) -> int:
    raw, errs = _raw_json(path)
    if raw is not None:
        errs = errs + contracts.check_team(raw)
    if errs:
        print(contracts.format_errors(errs), file=sys.stderr)
    if contracts.fatal(errs):
        return 1
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    if fmt == "json":
        print(json.dumps(team.to_dict(), ensure_ascii=False, indent=2))
    else:
        d = team.to_dict()
        print(f"Team ({d.get('format') or 'format?'}, {len(d['pokemon'])} Pokemon)")
        for m in d["pokemon"]:
            mv = ", ".join(m.get("moves") or [])
            print(f"- {m['species']} @ {m.get('item') or '-'} | {m.get('ability') or '-'} | {mv}")
    return 0


def cmd_validate(path: str, fmt: str, context_path: str | None) -> int:
    # Contract check first: a malformed shape is more fundamental than legality. On a FATAL
    # contract error we must NOT call load_team — malformed input can make the loader throw
    # (audit 2026-06-21); report the contract failure and stop here instead.
    contract_errs = _check_contracts(path, context_path)
    if contracts.fatal(contract_errs):
        if fmt == "json":
            print(json.dumps({"status": "invalid", "valid": False, "confidence": "high",
                              "errors": [], "warnings": [], "skipped": [],
                              "contract": [e.to_dict() for e in contract_errs]},
                             ensure_ascii=False, indent=2))
        else:
            print(contracts.format_errors(contract_errs))
            print("\nRefusing to validate a malformed team-json (fix the contract errors above).")
        return 1
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    context = load_context(context_path) if context_path else None
    result = validate(team, context)
    stamp, env_warn = _stamp(context, team)
    if fmt == "json":
        out = result.to_dict()
        out["contract"] = [e.to_dict() for e in contract_errs]
        out["environment"] = stamp
        if env_warn:
            out["warnings"] = out.get("warnings", []) + env_warn
        if name_flags:
            out["name_resolution"] = name_flags     # fuzzy species auto-corrections (design §10)
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn))
        if contract_errs:
            print(contracts.format_errors(contract_errs))
            print()
        print(format_report(result))
    return 0 if result.valid else 1


def cmd_diagnose(path: str, fmt: str, aspect: str) -> int:
    contract_errs = _check_contracts(path)
    _emit_contract_errs(contract_errs, fmt)
    if contracts.fatal(contract_errs):
        print("Refusing to diagnose a malformed team-json (see contract errors).", file=sys.stderr)
        return 2
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    want_def = aspect in ("defense", "all")
    want_off = aspect in ("offense", "all")
    want_spd = aspect in ("speed", "all")
    want_roles = aspect in ("roles", "all")
    try:
        facts = lookup_pokemon([m.species for m in team.pokemon if m.species])
        move_facts = (lookup_moves(sorted({mv for m in team.pokemon for mv in m.moves}))
                      if (want_off or want_spd) else {})
    except DexUnavailable as e:
        print(f"Dex unavailable: {e}", file=sys.stderr)
        return 2
    out: dict[str, object] = {}
    if want_def:
        out["defense"] = diagnose_defense(team, facts)
    if want_off:
        out["offense"] = diagnose_offense(team, facts, move_facts)
    if want_spd:
        out["speed"] = diagnose_speed(team, facts, move_facts)
    if want_roles:
        out["roles"] = diagnose_roles(team, facts)
    stamp, env_warn = _stamp(None, team)
    out["environment"] = stamp
    if env_warn:
        out["warnings"] = env_warn
    if name_flags:
        out["name_resolution"] = name_flags         # fuzzy species auto-corrections (design §10)
    if fmt == "json":
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn) + "\n")
        blocks = []
        if "defense" in out:
            blocks.append(format_defense_md(out["defense"]))
        if "offense" in out:
            blocks.append(format_offense_md(out["offense"]))
        if "speed" in out:
            blocks.append(format_speed_md(out["speed"]))
        if "roles" in out:
            blocks.append(format_roles_md(out["roles"]))
        print("\n\n".join(blocks))
    return 0


def cmd_tune(path: str, fmt: str, context_path: str | None) -> int:
    if not context_path:
        print("tune needs --context with a `benchmarks` list (schema.md §7).", file=sys.stderr)
        return 2
    # Contract-check BOTH inputs (the team is fed to the damage/speed math, not just the context).
    contract_errs = _check_contracts(path, context_path)
    _emit_contract_errs(contract_errs, fmt)
    if contracts.fatal(contract_errs):
        print("refusing to tune on malformed input (see contract errors).", file=sys.stderr)
        return 2
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    context = load_context(context_path)
    if not context.benchmarks:
        print("no benchmarks in build-context; nothing to tune.", file=sys.stderr)
        return 2
    stamp, env_warn = _stamp(context, team)             # season needed before resolving opponent sets
    season = stamp.get("season")
    # tune's defender/attacker set resolves through the M4 resolver too (real-team joint ⊕ meta spread),
    # so survive/kill cliffs tune against a real co-occurring set when the library has it (handoff §5.1).
    def meta_fn(species: str, fmt_: str | None) -> dict | None:
        return sources.resolve_opponent_set(species, fmt_, season=season)
    try:
        out = run_tune(team.to_dict(), context.benchmarks, fmt=context.format,
                       damage_fn=damage_vs, move_fn=lookup_moves, dex_fn=lookup_pokemon,
                       meta_fn=meta_fn, nature_dist_fn=nature_distribution,
                       locked=context.locked, damage_batch_fn=damage_batch)
    except NcpInputError as e:
        # The calculator ran but rejected a benchmark input (e.g. an off-roster Pokemon or unknown
        # move) — a parameter problem, NOT the skill being down. Say so, don't mislabel it.
        print(f"ncp rejected a benchmark input (off-roster Pokemon / unknown move?): {e}", file=sys.stderr)
        return 2
    except (DexUnavailable, NcpUnavailable) as e:
        print(f"sibling skill unavailable: {e}", file=sys.stderr)
        return 2
    out["environment"] = stamp
    if env_warn:
        out["warnings"] = (out.get("warnings") or []) + env_warn
    if fmt == "json":
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn) + "\n")
        print(format_tune_md(out))
    return 0


def cmd_select(path: str, fmt: str, context_path: str | None) -> int:
    contract_errs = _check_contracts(path, context_path)
    _emit_contract_errs(contract_errs, fmt)
    if contracts.fatal(contract_errs):
        print("refusing to select on malformed input (see contract errors).", file=sys.stderr)
        return 2
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    context = load_context(context_path) if context_path else None
    try:
        # Selection enumerates picks of the REGISTERED team; it must not present them as "legal"
        # without a legality check. Validate first and attach the verdict so an invalid/unknown
        # team is flagged, not silently enumerated as if legal (audit 2026-06-21).
        legality = validate(team, context)
        out = run_select(team.to_dict(), fmt=(context.format if context else None),
                         dex_fn=lookup_pokemon, item_fn=lookup_items,
                         legality_status=legality.status)
    except DexUnavailable as e:
        print(f"sibling dex unavailable: {e}", file=sys.stderr)
        return 2
    stamp, env_warn = _stamp(context, team)
    out["environment"] = stamp
    out["legality"] = {"status": legality.status, "valid": legality.valid,
                       "confidence": legality.confidence, "errors": legality.errors}
    warns = list(env_warn)
    if legality.status != "valid":
        warns.append(f"registered team legality is '{legality.status}' (not certified valid) — "
                     "these pick subsets assume a legal team; resolve validation first.")
    if warns:
        out["warnings"] = (out.get("warnings") or []) + warns
    if fmt == "json":
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn) + "\n")
        if legality.status != "valid":
            print(f"> ⚠️ registered team legality is **{legality.status}** (not certified valid); "
                  "run `validate` — picks below assume a legal team.\n")
        print(format_selection_md(out))
    return 0


def cmd_matchup(path: str, fmt: str, context_path: str | None, top_k: int) -> int:
    contract_errs = _check_contracts(path, context_path)
    _emit_contract_errs(contract_errs, fmt)
    if contracts.fatal(contract_errs):
        print("refusing to run matchup on malformed input (see contract errors).", file=sys.stderr)
        return 2
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    context = load_context(context_path) if context_path else None
    fmt_battle = (context.format if context and context.format else None) or team.format
    stamp, env_warn = _stamp(context, team)            # season needed before resolving opponent sets
    season = stamp.get("season")
    try:
        rows = usage_top_k(fmt_battle, top_k)
    except MetaUnavailable as e:
        print(f"meta unavailable (matchup needs the usage ranking): {e}", file=sys.stderr)
        return 2
    # Opponent sets resolve through the M4 resolver: the real-team JOINT set (ability/item/nature/moves)
    # ⊕ the meta modal SPREAD, in ONE batched meta call (handoff §5.1). With an empty real-team library
    # this is byte-identical to the bare meta path. Memoized so the no-ncp fallback reuses it.
    sets_cache: dict[str, dict | None] = {}

    def sets_fn(names: list[str], fmt_: str | None) -> dict[str, dict | None]:
        missing = [n for n in names if n not in sets_cache]
        if missing:
            sets_cache.update(sources.resolve_opponent_sets(missing, fmt_, season=season))
        return {n: sets_cache.get(n) for n in names}

    try:
        out = run_matchup(team.to_dict(), rows, fmt=fmt_battle, dex_fn=lookup_pokemon,
                          sets_fn=sets_fn, damage_fn=damage_batch)
    except NcpUnavailable as e:
        out = run_matchup(team.to_dict(), rows, fmt=fmt_battle, dex_fn=lookup_pokemon,
                          sets_fn=sets_fn, damage_fn=None)
        out["warnings"] = (out.get("warnings") or []) + [f"ncp unavailable, damage skipped: {e}"]
    except MetaUnavailable as e:
        print(f"sibling meta unavailable: {e}", file=sys.stderr)
        return 2
    except DexUnavailable as e:
        print(f"sibling dex unavailable: {e}", file=sys.stderr)
        return 2
    out["environment"] = stamp                          # stamp/env_warn computed above (before resolving)
    if env_warn:
        out["warnings"] = (out.get("warnings") or []) + env_warn
    if fmt == "json":
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn) + "\n")
        print(format_matchup_md(out))
    return 0


def cmd_replace(path: str, fmt: str, context_path: str | None) -> int:
    """L3 replace-impact (M3): objective before/after diff of swapping one member for a candidate.
    No 'better/worse' verdict (design §0)."""
    contract_errs = _check_contracts(path, context_path)
    _emit_contract_errs(contract_errs, fmt)
    if contracts.fatal(contract_errs):
        print("refusing to run replace on malformed input (see contract errors).", file=sys.stderr)
        return 2
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    context = load_context(context_path) if context_path else None
    spec = context.replace if context else {}
    if not spec or not spec.get("member") or not spec.get("with"):
        print("replace needs --context with `replace: {member, with: <candidate member>}` (schema §7).",
              file=sys.stderr)
        return 2
    stamp, env_warn = _stamp(context, team)

    def _validate_after(after_dict: dict) -> dict:
        # Legality bottom-line: run the real validator on the prospective after-team (iron rule —
        # never present a diff on an illegal team as clean fact).
        r = validate(team_from_dict(after_dict), context)
        return {"status": r.status, "errors": list(r.errors), "warnings": list(r.warnings)}

    try:
        out = run_replace(team.to_dict(), spec["member"], spec["with"],
                          dex_fn=lookup_pokemon, move_fn=lookup_moves, validate_fn=_validate_after)
    except DexUnavailable as e:
        print(f"sibling dex unavailable: {e}", file=sys.stderr)
        return 2
    out["environment"] = stamp
    if env_warn:
        out["warnings"] = (out.get("warnings") or []) + env_warn
    if fmt == "json":
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn) + "\n")
        print(format_replace_impact_md(out))
    return 0


def cmd_fill(path: str, fmt: str, context_path: str | None) -> int:
    """L3 candidate retrieval (M3): given a structured `need` (build-context), return the candidate
    pool in multiple explicit views. No composite score / single best pick (design §0)."""
    contract_errs = _check_contracts(path, context_path)
    _emit_contract_errs(contract_errs, fmt)
    if contracts.fatal(contract_errs):
        print("refusing to run fill on malformed input (see contract errors).", file=sys.stderr)
        return 2
    team, name_flags = _load_team(path)
    _emit_name_flags(name_flags)
    context = load_context(context_path) if context_path else None
    if not context or not context.need:
        print("fill needs --context with a `need` spec "
              "(resist/offense_type/coverage_move_type/role/min_speed; schema §7).", file=sys.stderr)
        return 2
    fmt_battle = (context.format if context.format else None) or team.format
    stamp, env_warn = _stamp(context, team)
    season = stamp.get("season")
    try:
        out = run_fill(team.to_dict(), context.need, fmt=fmt_battle,
                       dex_fn=lookup_pokemon, ranking_fn=usage_top_k, repset_fn=repset.load_teams,
                       move_fn=lookup_moves,
                       season=season, owned=context.owned, owned_only=context.owned_only,
                       avoid=context.avoid, locked=context.locked)
    except MetaUnavailable as e:
        print(f"meta unavailable (fill needs the usage ranking): {e}", file=sys.stderr)
        return 2
    except DexUnavailable as e:
        print(f"sibling dex unavailable: {e}", file=sys.stderr)
        return 2
    out["environment"] = stamp
    if env_warn:
        out["warnings"] = (out.get("warnings") or []) + env_warn
    if fmt == "json":
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, env_warn) + "\n")
        print(format_fill_md(out))
    return 0


def _dispatch_session_op(cmd: dict) -> int:
    """Run one operator inside a session, always as json. Returns its exit code."""
    op = cmd.get("op")
    f = cmd.get("file")
    ctx = cmd.get("context")
    if op == "parse":
        return cmd_parse(f, "json")
    if op == "validate":
        return cmd_validate(f, "json", ctx)
    if op == "diagnose":
        return cmd_diagnose(f, "json", cmd.get("aspect", "all"))
    if op == "tune":
        return cmd_tune(f, "json", ctx)
    if op == "select":
        return cmd_select(f, "json", ctx)
    if op == "matchup":
        return cmd_matchup(f, "json", ctx, int(cmd.get("top_k", 8)))
    if op == "fill":
        return cmd_fill(f, "json", ctx)
    if op == "replace":
        return cmd_replace(f, "json", ctx)
    raise ValueError(f"unknown session op: {op!r}")


def cmd_session(spec_path: str) -> int:
    """Run several operators in ONE process under a persistent-worker session (perf ①+④).

    `spec_path` is a JSON list of commands, e.g.
      [{"op":"validate","file":"team.json","context":"ctx.json"},
       {"op":"matchup","file":"team.json","top_k":8}]
    Output is a JSON list aligned to the input, each {op, rc, result} (or {op, error}). The sibling
    skills (dex/meta/ncp) stay resident for the whole list, so their startup is paid once."""
    import io
    from contextlib import redirect_stdout
    try:
        spec = json.loads(Path(spec_path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        print(f"cannot read session spec: {e}", file=sys.stderr)
        return 2
    if not isinstance(spec, list):
        print("session spec must be a JSON list of {op, ...} commands", file=sys.stderr)
        return 2
    results: list[dict] = []
    with worker.session():
        for cmd in spec:
            if not isinstance(cmd, dict):
                results.append({"op": None,
                                "error": f"command must be a JSON object, got {type(cmd).__name__}"})
                continue
            op = cmd.get("op")
            buf = io.StringIO()
            try:
                with redirect_stdout(buf):
                    rc = _dispatch_session_op(cmd)
                payload = buf.getvalue().strip()
                results.append({"op": op, "rc": rc,
                                "result": json.loads(payload) if payload else None})
            except Exception as e:  # noqa: BLE001
                results.append({"op": op, "error": str(e)})
    print(json.dumps(results, ensure_ascii=False, indent=2))
    return 0


def _canonicalize_repset_species(species: str, fmt: str) -> tuple[str, str | None, list[str]]:
    """Resolve a raw CLI species (Chinese/Japanese alias, or a Mega display name) to the key the
    real-team library actually stores, returning (resolved_name, item_filter, warnings).

    The library stores dex-canonical English names, so without this an alias like '烈咬陆鲨' or a Mega
    name silently returns [] (audit 2026-06-25). Mega resolution is FORMAT-AWARE because the two sources
    encode Megas differently: the doubles source (Limitless) stores a Mega as the BASE species + its
    stone item (so we query the base, filtered to required_item), while the singles source (yakkun)
    stores the 'Mega X' species directly (so the dex canonical name matches as-is)."""
    warns: list[str] = []
    try:
        info = lookup_pokemon([species]).get(species, {})
    except DexUnavailable:
        warns.append("dex unavailable — querying the library by the raw name (aliases/Mega unresolved).")
        return species, None, warns
    if not info.get("found"):
        warns.append(f"dex did not resolve {species!r} — querying the library by the raw name "
                     "(a non-canonical alias may return an empty result).")
        return species, None, warns
    if info.get("is_mega"):
        if fmt == "double":
            # doubles store the Mega as base + stone; isolate it by the required item.
            return info.get("base_species") or info["name"], info.get("required_item"), warns
        return info["name"], None, warns         # singles store the 'Mega X' species directly
    return info.get("name") or species, None, warns


def _format_repset_md(species: str, fmt: str, archetypes: list[dict], resolved: str | None = None,
                      item_filter: str | None = None) -> str:
    """Human-readable archetype report. Objective FACTS only — coverage/share/sample are provenance,
    NEVER a strength score, and archetypes are listed by real-team prevalence, not 'best'."""
    title = species
    if resolved and resolved != species:
        flt = f" @ {item_filter}" if item_filter else ""
        title = f"{species} → {resolved}{flt}"
    if not archetypes:
        return (f"No real-team representative set for **{title}** ({fmt}): fewer than the minimum "
                f"sample of real teams run it. Resolve opponent sets via meta fallback instead.")
    lines = [f"### {title} — real-team archetypes ({fmt})",
             "_Co-occurring builds from the real-team library, by prevalence. Facts, not a ranking._\n"]
    if item_filter:
        # The pool is the item-filtered subpool (doubles-Mega isolation), NOT the whole base species.
        # Spell that out so `covers ... of teams` below is read against the filtered pool, never as
        # base-species coverage (audit 2026-06-26).
        total = archetypes[0].get("species_sample_total")
        pool = archetypes[0].get("species_sample")
        if total is not None and pool is not None:
            lines.append(f"_Pool filtered to `{item_filter}`: {pool} of {total} {resolved} real teams "
                         f"hold it — coverage/sample below are within this filtered pool._\n")
    for i, a in enumerate(archetypes, 1):
        cl = a.get("cluster")
        if cl:
            head = f"**#{i}** item=`{cl['item']}` / ability=`{cl['ability']}`"
            cov = a.get("coverage")
            # coverage is denominated on the (item-filtered) species pool, so name THAT pool size
            # (`species_sample`), not the cluster size (`sample`) — else "covers 0.6 of the 3 teams" when
            # the pool is 5 (audit 2026-06-26: matches the 9856e9d denominator-honesty fix).
            pool_n = a.get("species_sample", a["sample"])
            pool_word = f" of the {pool_n} {item_filter}-pool teams" if item_filter else " of teams"
            cov_s = f", covers {cov}{pool_word}" if cov is not None else ""
        else:
            # Fragmented fallback: no dominant (item,ability) archetype. Do NOT claim a cluster
            # coverage — the global modal is on share=count/sample of the pool, not 100% (audit).
            head = f"**#{i}** fragmented — no dominant item/ability archetype (pool {a['sample']} teams)"
            cov_s = ""
        lines.append(f"{head} — {a['nature']} · modal set {a['count']}/{a['sample']} "
                     f"(share {a['share']}{cov_s}) · confidence **{a['confidence']}**")
        lines.append(f"  - moves: {', '.join(a['moves']) or '—'}")
        sps = a.get("sps")
        if sps:
            lines.append(f"  - SP spread (real co-occurring): {sps}  _[spread_origin=real-team]_")
        else:
            lines.append("  - SP spread: not in source (use meta spread)")
    return "\n".join(lines)


def cmd_repset(species: str, fmt: str | None, season: str | None, max_clusters: int,
               out_fmt: str) -> int:
    """Query the real-team library for a species' up-to-N (item,ability) archetypes (design §10).

    Facts only: every set carries cluster/coverage/share/sample/spread_origin/confidence and is NEVER a
    strength score. Format is REQUIRED (no single/double default — never mix metagames); season defaults
    to the current base (an empty library yields an empty result, not an error). The raw species is
    canonicalized via dex first so aliases and Mega names resolve to the library's storage key."""
    if not fmt:
        print("repset requires --game-format single|double (metagames are never mixed).",
              file=sys.stderr)
        return 2
    if max_clusters < 1:
        print("repset --max-clusters must be >= 1.", file=sys.stderr)
        return 2
    season = season or environment.CURRENT_SEASON
    try:
        resolved, item_filter, name_warns = _canonicalize_repset_species(species, fmt)
        archetypes = repset.representative_sets(resolved, fmt, season=season,
                                                max_clusters=max_clusters, item=item_filter)
    except Exception as e:
        print(f"repset failed: {e}", file=sys.stderr)
        return 2
    # repset reads the real-team library PARTITION for `season` (not the current-only bases), so stamp
    # the actual data season/rule as provenance instead of mislabeling a historical query as the current
    # base (audit 2026-06-26). The library tracks rule only implicitly (file = season+format), so the
    # rule is known for the current season and left None — not fabricated — for older ones.
    data_rule = environment.CURRENT_RULE if season == environment.CURRENT_SEASON else None
    stamp, env_warn = environment.resolve(data_season=season, data_rule=data_rule)
    warns = list(name_warns) + list(env_warn)
    payload = {
        "query": {"species": species, "resolved": resolved, "item_filter": item_filter,
                  "format": fmt, "season": season, "max_clusters": max_clusters},
        "archetypes": archetypes,
        "environment": stamp,
        "note": "real-team (item,ability)-clustered archetypes by prevalence; facts only, no strength "
                "score; empty when the library is too thin (resolve via meta fallback).",
    }
    if warns:
        payload["warnings"] = warns
    if out_fmt == "json":
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, warns) + "\n")
        print(_format_repset_md(species, fmt, archetypes, resolved, item_filter))
    return 0


def cmd_oppmatrix(species: str | None, fmt: str | None, season: str | None,
                  vs: str | None, out_fmt: str) -> int:
    """Read the precomputed opponent standard-set matchup cache (M5 step 2; design §9). FACTS ONLY —
    a standard-vs-standard reference grid, every cell `low` confidence (reason=vs-standard-set); it is
    NOT your team (match a real team LIVE via `matchup`). Format is REQUIRED (metagames never mixed);
    season defaults to the current base. With no `species` the whole matrix prints; with `species` only
    that attacker's row; with `--vs` only the one ordered (attacker -> defender) cell. The cache is
    built by the dev pipeline (`update.py team-cache`); a missing file is reported, not an error."""
    if not fmt:
        print("oppmatrix requires --game-format single|double (metagames are never mixed).",
              file=sys.stderr)
        return 2
    season = season or environment.CURRENT_SEASON
    cache = oppcache.load_cache(fmt, season)
    stamp, env_warn = environment.resolve(season, None)
    if cache is None:
        msg = (f"No opponent-cache for {season}/{fmt} — build it with "
               f"`python dev/update/update.py team-cache --format {fmt}`.")
        if out_fmt == "json":
            print(json.dumps({"ok": False, "query": {"format": fmt, "season": season},
                              "error": {"code": "no_cache", "message": msg}}, ensure_ascii=False, indent=2))
        else:
            print(_env_header(stamp, env_warn) + "\n\n" + msg)
        return 0
    # Canonicalize raw species/defender (alias / Mega) to the cache's keys (meta canonical English),
    # then map to the actual matrix key: a singles Mega is keyed under its meta BASE name with
    # run_form='Mega X', so a 'Mega Staraptor' query must resolve to the 'Staraptor' row (audit).
    warns: list[str] = list(env_warn)
    atk = _resolve_cache_key(cache, _canonicalize_oppmatrix_name(species, warns)) if species else None
    dfd = _resolve_cache_key(cache, _canonicalize_oppmatrix_name(vs, warns)) if vs else None
    if dfd and not atk:
        print("oppmatrix --vs needs an attacker species too.", file=sys.stderr)
        return 2
    if out_fmt == "json":
        if atk and dfd:
            payload: dict = {"attacker": atk, "defender": dfd, "cell": oppcache.cell(cache, atk, dfd)}
        elif atk:
            payload = {"attacker": atk, "row": oppcache.attacker_row(cache, atk)}
        else:
            payload = cache
        payload = {"query": {"species": species, "resolved_attacker": atk, "resolved_defender": dfd,
                             "format": fmt, "season": season},
                   "built_for": cache.get("built_for"), "confidence": cache.get("confidence"),
                   "confidence_reason": cache.get("confidence_reason"), **payload}
        if warns:
            payload["warnings"] = warns
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(_env_header(stamp, warns) + "\n")
        print(oppcache.format_oppcache_md(cache, attacker=atk, defender=dfd))
    return 0


def _canonicalize_oppmatrix_name(name: str, warns: list[str]) -> str:
    """Resolve a raw alias / Mega display name to the cache's key (the meta canonical English name).
    On a dex miss, keep the raw name (the lookup just won't match — reported, not fatal)."""
    try:
        info = lookup_pokemon([name]).get(name, {})
    except DexUnavailable:
        warns.append("dex unavailable — querying the cache by the raw name (aliases/Mega unresolved).")
        return name
    if info.get("found"):
        return info.get("name") or name
    warns.append(f"dex did not resolve {name!r} — querying the cache by the raw name.")
    return name


def _resolve_cache_key(cache: dict, canonical: str) -> str:
    """Map a dex-canonical name to the matrix key it actually lives under.

    A singles Mega is ranked by meta under its BASE name (e.g. 'Staraptor') with the row's
    ``run_form`` set to the Mega ('Mega Staraptor'); the matrix is keyed by that base name. So a
    'Mega Staraptor' query — already a valid dex canonical — must reverse-resolve to the 'Staraptor'
    row. Direct hit wins first; otherwise look for the species whose run_form == the query."""
    if canonical is None:
        return canonical
    sets = cache.get("sets") or {}
    if canonical in sets:
        return canonical
    for key, s in sets.items():
        if (s or {}).get("run_form") == canonical:
            return key
    return canonical


def cmd_planned(name: str) -> int:
    print(f"`{name}` is planned (M3) and not implemented yet.", file=sys.stderr)
    return 2


# Machine-readable I/O contract (dev/contracts/conventions.md), emitted by `schema` so an AI caller
# can learn the team CLI's commands + shapes without reading source. Pinned by the team contract test.
TEAM_SCHEMA = {
    "skill": "pokemon-champions-team",
    "contract": "dev/contracts/conventions.md",
    "input": "team-json or Showdown-text file; member: {species|name, ability, item, nature, "
             "spread:{hp,atk,def,spa,spd,spe}, moves:[str], tera, completeness}",
    "stat_keys": ["hp", "atk", "def", "spa", "spd", "spe"],
    "commands": {
        "parse": "<file> -> {schema_version, format, season, rule, pokemon:[member], provenance}",
        "validate": "<file> [--context] -> {status: valid|invalid|unknown, valid, confidence, errors, warnings}",
        "diagnose": "<file> [--aspect defense|offense|speed|roles|all] -> per-aspect objective signals + evidence",
        "select": "<file> -> 6->3 (single) / ->4 (double) objective facts (no strength score)",
        "matchup": "<file> [--top-k N] -> member x meta top-K speed/type/damage matrix",
        "tune": "<file> --context <benchmarks.json> -> SP cliff cards (multi-view, never a single best)",
        "fill": "<file> --context <need.json> -> candidate pool for a structured gap "
                "(need: resist/offense_type/role/min_speed) in multiple explicit views (no score)",
        "replace": "<file> --context <{replace:{member,with}}> -> objective before/after diff of a "
                   "swap (defense/offense/speed/roles); never a better/worse verdict",
        "repset": "<species> --game-format single|double [--season] [--max-clusters N] -> up to N "
                  "real-team (item,ability) archetypes by prevalence, each with cluster/coverage/share/"
                  "sample/spread_origin/confidence; facts only, no strength score; [] when too thin",
        "oppmatrix": "[species] --game-format single|double [--vs <defender>] [--season] -> precomputed "
                     "standard-set matchup matrix over meta top-K (offense band/KO + speed line per "
                     "ordered pair); attacker rows only for real-team-backed species; EVERY cell low "
                     "confidence (vs-standard-set); a reference grid, NOT your team (match live)",
        "session": "<spec.json> -> batched ops in one process",
        "schema": "this contract",
    },
    "note": "member identity accepts `name` or the Showdown `species` (normalized to species). validate's "
            "three-state result is a domain result, NOT the uniform error shape (conventions §3).",
}


def _positive_int(s: str) -> int:
    """argparse type for counts that must be >= 1 (e.g. repset --max-clusters)."""
    v = int(s)
    if v < 1:
        raise argparse.ArgumentTypeError(f"must be >= 1 (got {v})")
    return v


def main() -> int:
    p = argparse.ArgumentParser(description="Pokemon Champions team CLI.")
    p.add_argument("command",
                   choices=["parse", "validate", "diagnose", "tune", "select", "matchup", "fill", "replace",
                            "repset", "oppmatrix", "session", "schema"])
    p.add_argument("file", nargs="?",
                   help="team-json/Showdown file; for `repset` it is the SPECIES name, for `oppmatrix` "
                        "the (optional) attacker species")
    p.add_argument("--format", choices=["md", "json"], default="md")
    p.add_argument("--context", help="build-context JSON file (intent/constraints)")
    p.add_argument("--aspect", choices=["defense", "offense", "speed", "roles", "all"], default="all",
                   help="diagnose: which aspect(s) to run")
    p.add_argument("--top-k", type=int, default=8,
                   help="matchup: how many most-used Pokemon to compare against (default 8)")
    p.add_argument("--game-format", choices=["single", "double"],
                   help="repset/oppmatrix: which metagame to read (never mixed)")
    p.add_argument("--vs", help="oppmatrix: defender species for a single (attacker -> defender) cell")
    p.add_argument("--season", help="repset/oppmatrix: season to read (default: current base)")
    p.add_argument("--max-clusters", type=_positive_int, default=3,
                   help="repset: max (item,ability) archetypes to surface (default 3; must be >= 1). "
                        "Values > 3 expand the long tail — a debug/exploration view, not the M5 'up to 3'.")
    ns = p.parse_args()
    if ns.command == "schema":
        print(json.dumps(TEAM_SCHEMA, ensure_ascii=False, indent=2))
        return 0
    if not ns.file and ns.command != "oppmatrix":     # oppmatrix's species is optional (whole matrix)
        target = "species (for command 'repset')" if ns.command == "repset" else "file"
        p.error(f"the following arguments are required: {target} (for command '{ns.command}')")
    if ns.command == "parse":
        return cmd_parse(ns.file, ns.format)
    if ns.command == "validate":
        return cmd_validate(ns.file, ns.format, ns.context)
    if ns.command == "diagnose":
        return cmd_diagnose(ns.file, ns.format, ns.aspect)
    if ns.command == "tune":
        return cmd_tune(ns.file, ns.format, ns.context)
    if ns.command == "select":
        return cmd_select(ns.file, ns.format, ns.context)
    if ns.command == "matchup":
        return cmd_matchup(ns.file, ns.format, ns.context, ns.top_k)
    if ns.command == "fill":
        return cmd_fill(ns.file, ns.format, ns.context)
    if ns.command == "replace":
        return cmd_replace(ns.file, ns.format, ns.context)
    if ns.command == "repset":
        return cmd_repset(ns.file, ns.game_format, ns.season, ns.max_clusters, ns.format)
    if ns.command == "oppmatrix":
        return cmd_oppmatrix(ns.file, ns.game_format, ns.season, ns.vs, ns.format)
    if ns.command == "session":
        return cmd_session(ns.file)
    return cmd_planned(ns.command)


if __name__ == "__main__":
    raise SystemExit(main())
