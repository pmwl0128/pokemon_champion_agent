#!/usr/bin/env python
"""Shared host helpers for the quickjs Python CLIs.

The public Python entry points must remain usable in three different hosts:

- a normal terminal, where stdout/stderr are TextIOWrapper objects;
- the team skill's generic resident worker, which replaces stdin/stdout with StringIO;
- a Node-only installation, where the Python entry delegates to the sibling JavaScript CLI.

JSON is emitted as UTF-8 with an explicit LF so Windows text-mode newline translation cannot make
quickjs results differ byte-for-byte from Node results. Schema metadata is adapted at the Python CLI
boundary because it describes the executable host, not the shared calculator engine.
"""
from __future__ import annotations

import copy
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Callable


def _write_bytes(stream: Any, data: bytes) -> None:
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        buffer.write(data)
        buffer.flush()
    else:  # StringIO under pokemon-champions-team/scripts/_serve.py
        stream.write(data.decode("utf-8"))
        stream.flush()


def emit_json(value: Any) -> None:
    payload = (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    _write_bytes(sys.stdout, payload)


def python_schema(schema: Any, cli_name: str, *, drop_serve: bool = False) -> Any:
    """Return truthful schema metadata for a Python host without mutating the JS engine schema."""
    out = copy.deepcopy(schema)
    if not isinstance(out, dict):
        return out
    out["cli"] = cli_name
    commands = out.get("commands")
    if drop_serve and isinstance(commands, dict):
        commands.pop("serve", None)
    return out


def _stdin_bytes() -> bytes:
    buffer = getattr(sys.stdin, "buffer", None)
    if buffer is not None:
        return buffer.read()
    return sys.stdin.read().encode("utf-8")


def run_node_fallback(node_cli: Path, args: list[str], *,
                      schema_adapter: Callable[[Any], Any] | None = None) -> int:
    """Delegate the current Python CLI invocation to Node, preserving output and exit semantics.

    stdin is copied explicitly instead of inherited: the resident worker exposes request stdin as a
    StringIO while its OS-level stdin is the worker protocol pipe. Inheriting that pipe would consume
    protocol messages or deadlock. Commands using --input and schema do not need terminal stdin.
    """
    command = args[0] if args else "one"
    has_input_file = any(flag in args for flag in ("--input", "-i"))
    stdin_data = b"" if command == "schema" or has_input_file else _stdin_bytes()
    try:
        proc = subprocess.run(
            ["node", str(node_cli), *args], input=stdin_data, capture_output=True,
        )
    except FileNotFoundError as e:
        message = f"quickjs-ng is unavailable and Node could not start: {e}\n"
        _write_bytes(sys.stderr, message.encode("utf-8"))
        return 3

    stdout = proc.stdout
    if command == "schema" and schema_adapter is not None and stdout:
        try:
            emit_json(schema_adapter(json.loads(stdout)))
            stdout = b""
        except (UnicodeDecodeError, json.JSONDecodeError):
            pass  # preserve the Node diagnostic verbatim if its schema output was not valid JSON
    if stdout:
        _write_bytes(sys.stdout, stdout)
    if proc.stderr:
        _write_bytes(sys.stderr, proc.stderr)
    return proc.returncode
