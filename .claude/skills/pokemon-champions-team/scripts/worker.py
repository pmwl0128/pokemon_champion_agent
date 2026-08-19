#!/usr/bin/env python
"""Persistent sibling workers for a team-skill SESSION (perf ①+④).

A team build runs several operators (validate / diagnose / matchup / tune / select), each of which
spawns sibling processes (dex / meta / ncp). Today every call is a fresh process: the dominant cost
is interpreter/data-load startup, paid ~once per call. A `session()` keeps each sibling resident and
routes all calls in the session to it, so that startup is paid once. Every sibling — including ncp,
now that its calc runs in-process via quickjs-ng (ncp-calc-api.py) — runs through the generic
`_serve.py` wrapper (its own Python CLI, just resident).

The team CLI opens a session around EVERY operator, not just the `session` batch op: a single
operator already makes many sibling calls internally, so one-shot dispatch paid that startup per
call (measured: `matchup --top-k 8` 18.1s -> 3.6s, byte-identical). Sessions therefore nest, and
only the outermost exit tears the workers down.

Safety: this is purely a performance path. The bridges call `run_*` only inside an active session and
ALWAYS fall back to a one-shot subprocess on any worker error, so results are identical and a worker
crash never breaks a query. Outside a session nothing here runs.

`WorkerError` means the WORKER failed — the pipe broke, it produced no line, the line was not a
valid envelope, or the CLI crashed without an exit code. A CLI that exits non-zero with a canonical
error object on stdout is NOT a worker failure: `run_python` returns its `(exit, stdout)` unchanged,
exactly like a one-shot subprocess would. Collapsing the two used to disable the key for the rest of
the session, so a single benign `bad_input` sent every later call in that session back to paying
process startup — the precise cost this module exists to remove.
"""
from __future__ import annotations

import json
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any

_SERVE = Path(__file__).resolve().parent / "_serve.py"

_lock = threading.Lock()
_active = False
_depth = 0                      # nesting depth; only the outermost session tears workers down
_workers: dict[str, "Worker"] = {}
_failed: set[str] = set()       # keys disabled for this session after a failure (use one-shot instead)


class WorkerError(RuntimeError):
    pass


class Worker:
    """One resident sibling process speaking NDJSON: {"argv","stdin"} -> {"ok","stdout","exit"}."""

    def __init__(self, spawn_argv: list[str]):
        try:
            self.proc = subprocess.Popen(
                spawn_argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                text=True, encoding="utf-8", bufsize=1,
            )
        except OSError as e:
            raise WorkerError(f"worker failed to start: {e}") from e
        self._lock = threading.Lock()       # one in-flight request per worker (serialize callers)

    def request(self, argv: list[str], stdin_text: str = "") -> tuple[int, str]:
        """`(exit code, stdout)` for one request, the same pair a one-shot subprocess would give.

        Raises `WorkerError` only when the worker itself failed (see the module docstring); a
        non-zero exit with a well-formed envelope is returned, not raised.
        """
        with self._lock:
            if self.proc.poll() is not None or not self.proc.stdin or not self.proc.stdout:
                raise WorkerError("worker exited")
            try:
                self.proc.stdin.write(json.dumps({"argv": argv, "stdin": stdin_text}, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
            except (BrokenPipeError, OSError, UnicodeError) as e:
                raise WorkerError(f"worker pipe broke: {e}") from e
            if not line:
                raise WorkerError("worker produced no output")
            try:
                resp = json.loads(line)
            except (json.JSONDecodeError, UnicodeError) as e:
                raise WorkerError(f"worker produced malformed JSON: {e}") from e
            if not isinstance(resp, dict):
                raise WorkerError("worker response must be a JSON object")
            if resp.get("ok") is not True:
                detail = resp.get("error")
                raise WorkerError(detail if isinstance(detail, str) and detail else "worker error")
            stdout = resp.get("stdout", "")
            if not isinstance(stdout, str):
                raise WorkerError("worker response stdout must be a string")
            exit_code = resp.get("exit")
            # bool is an int subclass, so it would slip through a bare isinstance check.
            if not isinstance(exit_code, int) or isinstance(exit_code, bool):
                raise WorkerError("worker response exit must be an integer")
            return exit_code, stdout

    def close(self) -> None:
        # Take the same lock `request` holds: `_shutdown` is a write on the very pipe an in-flight
        # request is mid-conversation on, and interleaving the two would corrupt the NDJSON stream
        # for a reader that is still waiting for its own reply line.
        with self._lock:
            # Ask a live worker to exit; for a dead one (e.g. crashed on import) skip straight to
            # closing the pipes so a broken-pipe finalizer can't surface later as an ignored OSError.
            if self.proc.poll() is None:
                try:
                    if self.proc.stdin:
                        self.proc.stdin.write(json.dumps({"argv": ["_shutdown"]}) + "\n")
                        self.proc.stdin.flush()
                    self.proc.wait(timeout=2)
                except Exception:                               # noqa: BLE001
                    self.proc.kill()
            for stream in (self.proc.stdin, self.proc.stdout):
                try:
                    if stream:
                        stream.close()
                except (OSError, ValueError):
                    pass


def session_active() -> bool:
    with _lock:
        return _active


class session:
    """Context manager: keep sibling workers resident for its duration, tear them down on exit.

    Re-entrant on purpose: the CLI opens one around every operator, and `session` (the batch op)
    opens its own inside that. Only the outermost exit tears the workers down — otherwise the inner
    block would close workers the outer scope still counts on and silently drop back to one-shot.
    """

    def __enter__(self) -> "session":
        global _active, _depth
        with _lock:
            _depth += 1
            _active = True
        return self

    def __exit__(self, *exc: Any) -> bool:
        global _active, _depth
        with _lock:
            _depth -= 1
            if _depth > 0:
                return False
            _active = False
            for w in _workers.values():
                w.close()
            _workers.clear()
            _failed.clear()
        return False


def _get(key: str, spawn_argv: list[str]) -> "Worker":
    with _lock:
        if key in _failed:
            raise WorkerError(f"{key} worker disabled for this session (earlier failure)")
        w = _workers.get(key)
        if w is None or w.proc.poll() is not None:
            # Close the dead one before dropping the reference: its stdin/stdout are still open
            # file objects, and letting the GC find them leaks a pair of handles per replacement.
            if w is not None:
                w.close()
            w = Worker(spawn_argv)
            _workers[key] = w
        return w


def _call(key: str, spawn_argv: list[str], argv: list[str],
          stdin_text: str) -> tuple[int, str]:
    """Send one request to the keyed worker.

    On a WORKER failure — never on a non-zero CLI exit — disable the key for the rest of the session
    (so we don't respawn a broken worker every call) and re-raise so the bridge falls back to a
    one-shot subprocess.
    """
    try:
        return _get(key, spawn_argv).request(argv, stdin_text)
    except WorkerError:
        with _lock:
            _failed.add(key)
        raise


def run_python(key: str, cli_path: Path | str, argv: list[str],
               stdin_text: str = "") -> tuple[int, str]:
    """Run a Python sibling CLI via its resident worker.

    Returns `(exit code, stdout)` — the same pair the one-shot subprocess path produces, so a caller
    handles both identically. Raises `WorkerError` only if the worker failed.
    """
    return _call(key, [sys.executable, str(_SERVE), str(cli_path)], argv, stdin_text)
