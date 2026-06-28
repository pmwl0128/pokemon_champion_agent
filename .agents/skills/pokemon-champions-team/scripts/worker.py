#!/usr/bin/env python
"""Persistent sibling workers for a team-skill SESSION (perf ①+④).

A team build runs several operators (validate / diagnose / matchup / tune / select), each of which
spawns sibling processes (dex / meta / ncp). Today every call is a fresh process: the dominant cost
is interpreter/data-load startup, paid ~once per call. A `session()` keeps each sibling resident and
routes all calls in the session to it, so that startup is paid once. Python siblings run through the
generic `_serve.py` wrapper (their own CLI, just resident); ncp runs `ncp-calc-api.js serve`.

Safety: this is purely a performance path. The bridges call `run_*` only inside an active session and
ALWAYS fall back to a one-shot subprocess on any worker error, so results are identical and a worker
crash never breaks a query. Outside a session nothing here runs.
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
_workers: dict[str, "Worker"] = {}
_failed: set[str] = set()       # keys disabled for this session after a failure (use one-shot instead)


class WorkerError(RuntimeError):
    pass


class Worker:
    """One resident sibling process speaking NDJSON: {"argv","stdin"} -> {"ok","stdout","error"}."""

    def __init__(self, spawn_argv: list[str]):
        self.proc = subprocess.Popen(
            spawn_argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            text=True, encoding="utf-8", bufsize=1,
        )
        self._lock = threading.Lock()       # one in-flight request per worker (serialize callers)

    def request(self, argv: list[str], stdin_text: str = "") -> str:
        with self._lock:
            if self.proc.poll() is not None or not self.proc.stdin or not self.proc.stdout:
                raise WorkerError("worker exited")
            try:
                self.proc.stdin.write(json.dumps({"argv": argv, "stdin": stdin_text}, ensure_ascii=False) + "\n")
                self.proc.stdin.flush()
                line = self.proc.stdout.readline()
            except (BrokenPipeError, OSError) as e:
                raise WorkerError(f"worker pipe broke: {e}") from e
            if not line:
                raise WorkerError("worker produced no output")
            resp = json.loads(line)
            if not resp.get("ok"):
                raise WorkerError(resp.get("error") or "worker error")
            return resp.get("stdout", "")

    def close(self) -> None:
        # Ask a live worker to exit; for a dead one (e.g. crashed on import) skip straight to
        # closing the pipes so a broken-pipe finalizer can't surface later as an ignored OSError.
        if self.proc.poll() is None:
            try:
                if self.proc.stdin:
                    self.proc.stdin.write(json.dumps({"argv": ["_shutdown"]}) + "\n")
                    self.proc.stdin.flush()
                self.proc.wait(timeout=2)
            except Exception:                                   # noqa: BLE001
                self.proc.kill()
        for stream in (self.proc.stdin, self.proc.stdout):
            try:
                if stream:
                    stream.close()
            except (OSError, ValueError):
                pass


def session_active() -> bool:
    return _active


class session:
    """Context manager: keep sibling workers resident for its duration, tear them down on exit."""

    def __enter__(self) -> "session":
        global _active
        _active = True
        return self

    def __exit__(self, *exc: Any) -> bool:
        global _active
        _active = False
        with _lock:
            for w in _workers.values():
                w.close()
            _workers.clear()
            _failed.clear()
        return False


def _get(key: str, spawn_argv: list[str]) -> "Worker":
    if key in _failed:
        raise WorkerError(f"{key} worker disabled for this session (earlier failure)")
    with _lock:
        w = _workers.get(key)
        if w is None or w.proc.poll() is not None:
            w = Worker(spawn_argv)
            _workers[key] = w
        return w


def _call(key: str, spawn_argv: list[str], argv: list[str], stdin_text: str) -> str:
    """Send one request to the keyed worker. On any failure, disable the key for the rest of the
    session (so we don't respawn a broken worker every call) and re-raise so the bridge falls back."""
    try:
        return _get(key, spawn_argv).request(argv, stdin_text)
    except WorkerError:
        _failed.add(key)
        raise


def run_python(key: str, cli_path: Path | str, argv: list[str], stdin_text: str = "") -> str:
    """Run a Python sibling CLI via its resident worker. Returns stdout text; raises WorkerError."""
    return _call(key, [sys.executable, str(_SERVE), str(cli_path)], argv, stdin_text)


def run_node(key: str, cli_path: Path | str, argv: list[str], stdin_text: str = "") -> str:
    """Run the ncp node CLI via its resident `serve` worker. Returns stdout text; raises WorkerError."""
    return _call(key, ["node", str(cli_path), "serve"], argv, stdin_text)
