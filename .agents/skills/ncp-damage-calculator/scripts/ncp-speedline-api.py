#!/usr/bin/env python
"""Node-free speed CLI: the same calculation/query contract as ncp-speedline-api.js (one/batch/table/
compare/resolve/schema), backed by quickjs-ng (ncp_engine) instead of Node.

Requires `pip install quickjs-ng`; absent it automatically delegates to the Node CLI. Compatible with
the team skill's resident worker (_serve.py reuses the engine singleton)."""
from __future__ import annotations

import sys
from pathlib import Path

from ncp_cli_runtime import emit_json, python_schema, run_node_fallback
from ncp_engine import Engine, EngineUnavailable

_engine: Engine | None = None
_NODE_CLI = Path(__file__).with_suffix(".js")


def _get_engine() -> Engine:
    global _engine
    if _engine is None:
        _engine = Engine(with_speed=True)
    return _engine


def _read_payload(args: list[str]) -> str:
    for flag in ("--input", "-i"):
        if flag in args:
            return Path(args[args.index(flag) + 1]).read_text(encoding="utf-8")
    return sys.stdin.read()


def main() -> int:
    args = sys.argv[1:]
    command = args[0] if args else "one"
    if command not in ("one", "batch", "table", "compare", "resolve", "schema"):
        emit_json({"ok": False, "query": command,
            "error": {"code": "bad_input",
                      "message": f"unknown command '{command}'; expected one|batch|table|compare|resolve|schema"}})
        return 1
    try:
        eng = _get_engine()
    except EngineUnavailable:
        return run_node_fallback(
            _NODE_CLI, args,
            schema_adapter=lambda value: python_schema(value, "ncp-speedline-api.py"),
        )
    if command == "schema":
        emit_json(python_schema(eng.speed_schema(), "ncp-speedline-api.py"))
        return 0
    res = eng.run_speed(command, _read_payload(args))
    emit_json(res["output"])
    return int(res["exit"])


if __name__ == "__main__":
    raise SystemExit(main())
