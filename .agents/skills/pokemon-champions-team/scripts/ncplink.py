#!/usr/bin/env python
"""Bridge to the sibling ncp-damage-calculator skill (damage rolls for survival cliffs).

This skill holds no damage formulas. The tune operator gets damage rolls at query time from the
sibling ncp calculator's public JS API (`node ncp-calc-api.js`, JSON over stdin), so we depend on
its interface, not its internals. Speed cliffs do NOT come through here — Champions speed is a
closed form in cliffs.champ_speed (verified against ncp), which avoids a node call per SP probe.
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import worker

SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_DIR.parent
NCP_CALC = SKILLS_ROOT / "ncp-damage-calculator" / "scripts" / "ncp-calc-api.js"


class NcpUnavailable(RuntimeError):
    """The sibling calculator could not run at all (not installed, node missing, crashed)."""


class NcpInputError(NcpUnavailable):
    """The calculator ran fine but REJECTED the input — an off-roster Pokemon, an unknown move, etc.
    A subclass of NcpUnavailable so existing `except NcpUnavailable` still catches it (no uncaught
    surprises), but a caller can catch it FIRST to report a parameter error instead of mislabeling a
    business/input mistake as 'sibling skill unavailable' (audit 2026-06-28)."""


def _run(payload: Any, command: str = "one") -> Any:
    if not NCP_CALC.exists():
        raise NcpUnavailable(f"sibling ncp calculator not found at {NCP_CALC}")
    stdin_text = json.dumps(payload)
    result: Any = None
    if worker.session_active():             # perf: reuse a resident ncp worker within a session
        try:
            result = json.loads(worker.run_node("ncp", NCP_CALC, [command], stdin_text))
        except (worker.WorkerError, json.JSONDecodeError):
            result = None                   # fall back to a one-shot subprocess (results identical)
    if result is None:
        try:
            proc = subprocess.run(
                ["node", str(NCP_CALC), command],
                input=stdin_text, capture_output=True, text=True, encoding="utf-8",
            )
        except FileNotFoundError as e:  # node not installed
            raise NcpUnavailable(f"node not available: {e}") from e
        if proc.returncode != 0:
            # A non-zero exit can be a genuine crash OR a single-mode input rejection, which the calc
            # emits as a structured {ok:false,error} on stdout (exit 1). Don't mislabel the latter as the
            # skill being down — fall through so the unified check below raises NcpInputError instead.
            try:
                data = json.loads(proc.stdout)
            except json.JSONDecodeError:
                data = None
            if not (isinstance(data, dict) and data.get("ok") is False):
                raise NcpUnavailable(proc.stderr.strip() or "ncp-calc-api.js failed")
            result = data
        else:
            result = json.loads(proc.stdout)
    # Single-mode structured error = a CALLER input error (off-roster name / unknown move). Surface it as
    # NcpInputError so it isn't reported as 'skill unavailable'. Batch keeps inline {error,index} items
    # (fault isolation) and is returned as-is — callers expect per-item errors there.
    if command == "one" and isinstance(result, dict) and result.get("ok") is False:
        err = result.get("error") if isinstance(result.get("error"), dict) else {}
        code = err.get("code")
        msg = err.get("message") or "ncp rejected the input"
        raise NcpInputError(msg + (f" ({code})" if code else ""))
    return result


def damage_vs(attacker: dict[str, Any], defender: dict[str, Any], move: str,
              field: dict[str, Any] | None = None) -> tuple[list[int], int]:
    """Return (sorted damage rolls, defender max HP) for `attacker` hitting `defender` with `move`.

    `attacker`/`defender` are ncp pokemon dicts: name, ability, item, nature, sps, [moves].
    Survival = a roll strictly below max HP (see cliffs.survival_prob).
    """
    payload = {"attacker": attacker, "defender": defender, "move": move, "field": field or {}}
    out = _run(payload)
    return list(out.get("damage", [])), int(out.get("defenderHP") or 0)


def damage_batch(requests: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Run many damage calcs in ONE ncp subprocess (the calculator is parsed once and reused —
    ~5x faster than one subprocess per calc). Prefer this over looping `damage_vs` for a matrix
    such as our picks × meta top-K opponents.

    Each request is `{attacker, defender, move, field?}` (same shape as `damage_vs`'s inputs).
    Returns the raw ncp result dicts aligned 1:1 with `requests`; each has `damage`/`min`/`max`/
    `maxPercent`/`defenderHP`/`description`. A request the calculator rejects (e.g. an off-roster
    name) comes back as `{"error": <message>, "index": i}` rather than voiding the whole batch.
    """
    if not requests:
        return []
    payload = [{"attacker": r["attacker"], "defender": r["defender"],
                "move": r["move"], "field": r.get("field") or {}} for r in requests]
    out = _run(payload, command="batch")
    return list(out) if isinstance(out, list) else []
