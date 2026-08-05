"""Shared request boundary for the authoritative team ``tune`` operator.

Both runtimes accept the same small, path-free body, materialize controlled temporary JSON files,
and invoke the team skill through its public ``session`` command.  The public bridge adds quota and
concurrency around this function; the local bridge keeps the full operator available without those
multi-user controls.
"""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Any, Callable

TUNE_TEAM_MAX = 6
TUNE_BENCHMARK_MAX = 12
TUNE_TIMEOUT = 120.0


class TuneInputError(ValueError):
    """Client-fixable tune request error."""


def _validated_body(body: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not isinstance(body, dict):
        raise TuneInputError("request body must be an object")
    team = body.get("team")
    benchmarks = body.get("benchmarks")
    if not isinstance(team, dict):
        raise TuneInputError("team must be an object")
    members = team.get("pokemon")
    if not isinstance(members, list) or not 1 <= len(members) <= TUNE_TEAM_MAX:
        raise TuneInputError(f"team.pokemon must contain 1 to {TUNE_TEAM_MAX} members")
    if not all(isinstance(member, dict) for member in members):
        raise TuneInputError("every team member must be an object")
    if not isinstance(benchmarks, list) or not 1 <= len(benchmarks) <= TUNE_BENCHMARK_MAX:
        raise TuneInputError(
            f"benchmarks must contain 1 to {TUNE_BENCHMARK_MAX} entries")
    if not all(isinstance(benchmark, dict) for benchmark in benchmarks):
        raise TuneInputError("every benchmark must be an object")
    return team, benchmarks


def run_team_tune(pool: Any, body: Any,
                  workload_fn: Callable[[int], None] | None = None) -> dict[str, Any]:
    team, benchmarks = _validated_body(body)
    # Public callers are charged only after the cheap shape gate and before any subprocess work.
    if workload_fn is not None:
        workload_fn(len(benchmarks))
    with tempfile.TemporaryDirectory(prefix="pcweb-tune-") as tmp:
        tmp_dir = Path(tmp)
        team_path = tmp_dir / "team.json"
        context_path = tmp_dir / "context.json"
        spec_path = tmp_dir / "session.json"
        team_path.write_text(json.dumps(team, ensure_ascii=False), encoding="utf-8")
        context_path.write_text(
            json.dumps({"benchmarks": benchmarks}, ensure_ascii=False), encoding="utf-8")
        spec_path.write_text(json.dumps([{
            "op": "tune", "file": str(team_path), "context": str(context_path),
        }], ensure_ascii=False), encoding="utf-8")
        output = pool.request_json(
            "team", ["session", str(spec_path)], None, TUNE_TIMEOUT)
    entry = output[0] if isinstance(output, list) and output else None
    result = entry.get("result") if isinstance(entry, dict) and entry.get("rc") == 0 else None
    if not isinstance(result, dict):
        message = entry.get("stderr") if isinstance(entry, dict) else "tune session failed"
        raise RuntimeError(str(message or "tune session failed"))
    return result
