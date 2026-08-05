"""Generic resident NDJSON worker: load ONE skill CLI as a module, then answer
`{"argv": [...], "stdin": "..."}` request lines with `{"ok", "stdout", "exit"}` —
the module-level initialization (dex SQLite connection, quickjs engine, meta caches)
happens once instead of per call.

Runs as `python _serve.py <path-to-cli.py>`. Protocol invariant: exactly one response
line per request line, errors included — the parent falls back to a one-shot subprocess
on anything unparseable and restarts this worker.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import traceback
from contextlib import redirect_stdout
from pathlib import Path


def load_cli(path: Path):
    spec = importlib.util.spec_from_file_location(path.stem.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    # CLI scripts insert their own script dir on sys.path implicitly when run directly;
    # replicate so their sibling imports (dex_i18n, meta_i18n, ncp_engine...) resolve.
    if str(path.parent) not in sys.path:
        sys.path.insert(0, str(path.parent))
    spec.loader.exec_module(module)          # __name__ != "__main__": main() does not run
    if not hasattr(module, "main"):
        raise SystemExit(f"{path} has no main()")
    return module


def serve(cli_path: Path) -> int:
    module = load_cli(cli_path)
    stdin = sys.stdin
    real_stdout = sys.stdout
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            argv = [str(a) for a in req.get("argv", [])]
            sys.argv = [str(cli_path), *argv]
            sys.stdin = io.StringIO(req.get("stdin") or "")
            buf = io.StringIO()
            code = 0
            try:
                with redirect_stdout(buf):
                    rc = module.main()
                    code = int(rc) if rc is not None else 0
            except SystemExit as e:            # argparse errors etc.
                code = int(e.code) if isinstance(e.code, int) else (0 if e.code is None else 1)
            resp = {"ok": code == 0, "stdout": buf.getvalue(), "exit": code}
        except Exception:                      # worker-side fault: report, parent may restart
            resp = {"ok": False, "stdout": "", "exit": -1,
                    "worker_error": traceback.format_exc(limit=5)}
        finally:
            sys.stdin = stdin
        real_stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
        real_stdout.flush()
    return 0


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stdin.reconfigure(encoding="utf-8")
    raise SystemExit(serve(Path(sys.argv[1]).resolve()))
