#!/usr/bin/env python
"""Bridge to the sibling ncp-damage-calculator skill (damage rolls for survival cliffs).

This skill holds no damage formulas. The tune operator gets damage rolls at query time from the
sibling ncp calculator's public CLI (JSON over stdin), so we depend on its interface, not its
internals. The calc runs in-process via quickjs-ng (the Python `ncp-calc-api.py`); when quickjs-ng
isn't installed we fall back to the Node CLI (`ncp-calc-api.js`) — both emit identical JSON. Speed
cliffs do NOT come through here — Champions speed is a closed form in cliffs.champ_speed (verified
against ncp), which avoids a calc call per SP probe.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

import worker

SKILL_DIR = Path(__file__).resolve().parents[1]
SKILLS_ROOT = SKILL_DIR.parent
_CALC_SCRIPTS = SKILLS_ROOT / "ncp-damage-calculator" / "scripts"
NCP_CALC_PY = _CALC_SCRIPTS / "ncp-calc-api.py"    # quickjs-ng runtime (preferred, no Node needed)
NCP_CALC_JS = _CALC_SCRIPTS / "ncp-calc-api.js"    # Node fallback (used only if quickjs-ng is absent)


class NcpUnavailable(RuntimeError):
    """The sibling calculator could not run at all — neither the quickjs-ng runtime nor Node worked."""


class NcpInputError(NcpUnavailable):
    """The calculator ran fine but REJECTED the input — an off-roster Pokemon, an unknown move, etc.
    A subclass of NcpUnavailable so existing `except NcpUnavailable` still catches it (no uncaught
    surprises), but a caller can catch it FIRST to report a parameter error instead of mislabeling a
    business/input mistake as 'sibling skill unavailable' (audit 2026-06-28)."""


def _oneshot(command: str, stdin_text: str) -> Any:
    """Run the calc once, preferring the Python CLI (which itself delegates to Node when quickjs-ng
    is absent). Keep a direct Node candidate as a last-resort compatibility path if the Python entry
    is missing or fails before it can answer. Whichever runtime answers, result JSON is identical.

    A runtime that produces valid JSON on stdout is the answer — including a structured {ok:false}
    input error (calc emits that on exit 1). A runtime that can't run at all yields no JSON, so we try
    the next candidate; if none work, the calculator is genuinely unavailable."""
    last_err = ""
    for argv, present in (([sys.executable, str(NCP_CALC_PY), command], NCP_CALC_PY.exists()),
                          (["node", str(NCP_CALC_JS), command], NCP_CALC_JS.exists())):
        if not present:
            continue
        try:
            proc = subprocess.run(argv, input=stdin_text, capture_output=True, text=True, encoding="utf-8")
        except FileNotFoundError as e:      # interpreter/runtime not installed -> try the next candidate
            last_err = str(e)
            continue
        try:
            return json.loads(proc.stdout)  # valid JSON (result OR structured error) = this runtime answered
        except json.JSONDecodeError:
            last_err = proc.stderr.strip() or f"{argv[0]} produced no JSON output"
    raise NcpUnavailable(last_err or "no calc runtime available (install quickjs-ng, or Node)")


def _run(payload: Any, command: str = "one") -> Any:
    stdin_text = json.dumps(payload)
    result: Any = None
    if worker.session_active():             # perf: reuse a resident ncp worker within a session
        try:
            # The exit code is deliberately ignored, exactly as `_oneshot` ignores `returncode`:
            # calc emits a structured {ok:false} object AND exits 1 for a caller input error, and
            # that JSON is the answer. The classification below turns it into NcpInputError.
            _code, out = worker.run_python("ncp", NCP_CALC_PY, [command], stdin_text)
            result = json.loads(out)
        except (worker.WorkerError, json.JSONDecodeError):
            result = None                   # fall back to a one-shot subprocess (results identical)
    if result is None:
        result = _oneshot(command, stdin_text)
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
