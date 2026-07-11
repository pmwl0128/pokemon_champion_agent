#!/usr/bin/env python
"""Node-free damage CLI: the same calculation/resolve contract as ncp-calc-api.js (one/batch/
resolve/schema), backed by quickjs-ng (ncp_engine) hosting the SAME vendored JS instead of Node.

Requires `pip install quickjs-ng`; when it is absent this entry automatically delegates to the Node
CLI. Compatible with the team skill's resident worker (_serve.py imports this module once and calls
main() per request, reusing the engine singleton)."""
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
        _engine = Engine()
    return _engine


def _read_payload(args: list[str]) -> str:
    for flag in ("--input", "-i"):
        if flag in args:
            return Path(args[args.index(flag) + 1]).read_text(encoding="utf-8")
    return sys.stdin.read()


def main() -> int:
    args = sys.argv[1:]
    command = args[0] if args else "one"
    if command not in ("one", "batch", "resolve", "schema"):
        emit_json({"ok": False, "query": command,
            "error": {"code": "bad_input",
                      "message": f"unknown command '{command}'; expected one|batch|resolve|schema"}})
        return 1
    try:
        eng = _get_engine()
    except EngineUnavailable:
        return run_node_fallback(
            _NODE_CLI, args,
            schema_adapter=lambda value: python_schema(value, "ncp-calc-api.py", drop_serve=True),
        )
    if command == "schema":
        emit_json(python_schema(eng.calc_schema(), "ncp-calc-api.py", drop_serve=True))
        return 0
    kind = args[args.index("--kind") + 1] if "--kind" in args else ""
    res = eng.run_calc(command, _read_payload(args), kind)
    emit_json(res["output"])
    return int(res["exit"])


if __name__ == "__main__":
    raise SystemExit(main())
