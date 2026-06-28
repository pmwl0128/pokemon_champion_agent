#!/usr/bin/env python
"""Generic persistent worker for a Python sibling CLI (perf ①: amortize process startup).

Imports a target CLI module ONCE, then serves NDJSON requests on stdin:
  request : {"argv": [...], "stdin": "<text>"}   (one JSON object per line)
  reply   : {"ok": bool, "stdout": "<captured>", "error": "<msg>"}  (one line)

For each request it runs the target CLI's own `main()` with that argv (and stdin), capturing
stdout — so the sibling's public CLI contract is unchanged; only the interpreter + import cost is
paid once for the whole session instead of once per call. Exits on EOF or {"argv":["_shutdown"]}.

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
            proto.write(json.dumps({"ok": False, "error": f"bad request: {e}"}) + "\n")
            proto.flush()
            continue
        argv = req.get("argv") or []
        if argv and argv[0] == "_shutdown":
            break
        buf = io.StringIO()
        old_argv, old_stdin = sys.argv, sys.stdin
        sys.argv = [cli_path, *argv]
        sys.stdin = io.StringIO(req.get("stdin") or "")
        try:
            with redirect_stdout(buf):
                rc = mod.main()
            ok = rc in (0, None)
            resp = {"ok": ok, "stdout": buf.getvalue()}
            if not ok:
                resp["error"] = f"exit {rc}"
        except SystemExit as e:
            code = e.code
            ok = code in (0, None)
            resp = {"ok": ok, "stdout": buf.getvalue(), "error": None if ok else f"exit {code}"}
        except Exception as e:                                  # noqa: BLE001
            resp = {"ok": False, "error": str(e), "stdout": buf.getvalue()}
        finally:
            sys.argv, sys.stdin = old_argv, old_stdin
        proto.write(json.dumps(resp, ensure_ascii=False) + "\n")
        proto.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
