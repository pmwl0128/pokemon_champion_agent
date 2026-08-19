#!/usr/bin/env python
"""Generic persistent worker for a Python sibling CLI (perf ①: amortize process startup).

Imports a target CLI module ONCE, then serves NDJSON requests on stdin:
  request : {"argv": [...], "stdin": "<text>"}          (one JSON object per line)
  reply   : {"ok": bool, "stdout": "<captured>", "exit": int|null, "error": "<msg>"}   (one line)

For each request it runs the target CLI's own `main()` with that argv (and stdin), capturing
stdout — so the sibling's public CLI contract is unchanged; only the interpreter + import cost is
paid once for the whole session instead of once per call.

`ok` answers "did the worker run the CLI and get an exit code from it", NOT "did the CLI exit 0".
A CLI that exits 1 with a canonical `{"ok":false,"error":{...}}` object on stdout is a DOMAIN result
(conventions.md §3.1: such errors stay on `stdout` and must not degrade into an `error` string), so
it replies `ok:true` with that stdout and `exit:1`, exactly like the one-shot CLI would. Only a CLI
that crashes without an exit code — or a malformed request line — is `ok:false`. Collapsing the two
made every benign `bad_input` look like a broken worker to the caller.

Exits on EOF or `{"argv":["_shutdown"]}`, which is acknowledged before the loop stops.

This is launched by the team skill's worker.py and is never imported as part of normal queries.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path


def _load(cli_path: str):
    # The sibling CLI imports its own neighbour modules (e.g. meta_query -> meta_common); add its
    # directory to sys.path so those resolve, just as running `python <cli>` directly would.
    cli_dir = str(Path(cli_path).resolve().parent)
    if cli_dir not in sys.path:
        sys.path.insert(0, cli_dir)
    spec = importlib.util.spec_from_file_location("_sibling_cli", cli_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)            # runs the CLI's top-level setup (imports, data) once
    return mod


def _exit_code(code: object) -> int:
    """A CLI's exit status as an int, following `SystemExit`'s own rules.

    `main()` returning None and `SystemExit(None)` both mean 0; a string payload means "print it and
    exit 1". Anything else non-integer is a CLI defect, reported as 1 rather than guessed at.
    """
    if code is None:
        return 0
    if isinstance(code, bool):                          # bool is an int subclass; not an exit code
        return 1
    if isinstance(code, int):
        return code
    return 1


def main() -> int:
    cli_path = sys.argv[1]
    mod = _load(cli_path)
    proto = sys.stdout                      # the protocol channel (after the CLI reconfigured it)
    # readline() loop, NOT `for line in sys.stdin`: the latter read-aheads and would deadlock.
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:                                  # noqa: BLE001
            proto.write(json.dumps(
                {"ok": False, "error": f"bad request: {e}", "stdout": "", "exit": None}) + "\n")
            proto.flush()
            continue
        argv = req.get("argv") or []
        if argv and argv[0] == "_shutdown":
            # §3.1: acknowledge first, then stop reading — anything already buffered behind it must
            # not run. A caller that does not wait for this line is unaffected; one that does can
            # tell an orderly shutdown from a worker that died mid-request.
            proto.write(json.dumps({"ok": True, "stdout": "", "exit": 0}) + "\n")
            proto.flush()
            break
        buf = io.StringIO()
        old_argv, old_stdin = sys.argv, sys.stdin
        sys.argv = [cli_path, *argv]
        sys.stdin = io.StringIO(req.get("stdin") or "")
        try:
            with redirect_stdout(buf):
                rc = mod.main()
            resp = {"ok": True, "stdout": buf.getvalue(), "exit": _exit_code(rc)}
        except SystemExit as e:
            # A CLI that calls sys.exit() answered the request; its status is the answer.
            resp = {"ok": True, "stdout": buf.getvalue(), "exit": _exit_code(e.code)}
        except Exception as e:                                  # noqa: BLE001
            # No exit code exists: the CLI crashed rather than returning a result.
            resp = {"ok": False, "error": str(e), "stdout": buf.getvalue(), "exit": None}
        finally:
            sys.argv, sys.stdin = old_argv, old_stdin
        proto.write(json.dumps(resp, ensure_ascii=False) + "\n")
        proto.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
