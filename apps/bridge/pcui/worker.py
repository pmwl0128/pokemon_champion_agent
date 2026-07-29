"""Resident worker pool over `_serve.py` processes, with one-shot subprocess fallback.

One worker per query CLI (dex/meta/calc/speedline). Requests are serialized per worker
(these CLIs answer in milliseconds once resident; parallelism across skills still holds).
Any protocol fault kills + lazily restarts the worker and serves THIS request through
`runner.run_cli`, so results never depend on worker health (apps/design.md §4.1)."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import runner
from .paths import CLIS, PROJECT_ROOT, WORKER_CLIS

_SERVE = Path(__file__).with_name("_serve.py")


class WorkerError(RuntimeError):
    """A request could not be served (timeout, or the one-shot fallback also failed). Raised
    instead of letting a bare exception escape as an unshaped HTTP 500 — the server maps it
    to a structured error response."""


class _Worker:
    def __init__(self, cli_id: str):
        self.cli_id = cli_id
        self.lock = threading.Lock()
        self.proc: subprocess.Popen | None = None
        self.last_used = 0.0        # monotonic ts of the last request (for idle reclamation)

    def reap_if_idle(self, max_idle: float, now: float) -> None:
        """Kill this worker's process if it has sat idle past `max_idle` seconds (online idle
        reclamation, §8). Non-blocking on the lock: if a request holds it the worker is busy,
        i.e. not idle, so we skip. The next request lazily respawns."""
        if not self.lock.acquire(blocking=False):
            return
        try:
            if (self.proc is not None and self.proc.poll() is None
                    and now - self.last_used > max_idle):
                self._kill()
        finally:
            self.lock.release()

    def _spawn(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(_SERVE), str(CLIS[self.cli_id])],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, encoding="utf-8", bufsize=1, cwd=PROJECT_ROOT,
        )

    def _kill(self) -> None:
        if self.proc is not None:
            try:
                self.proc.kill()
            except OSError:
                pass
        self.proc = None

    def request(self, argv: list[str], stdin: str | None, timeout: float) -> dict:
        with self.lock:
            self.last_used = time.monotonic()
            timed_out = False
            try:
                if self.proc is None or self.proc.poll() is not None:
                    self._spawn()
                line = json.dumps({"argv": argv, "stdin": stdin}, ensure_ascii=False)
                self.proc.stdin.write(line + "\n")
                self.proc.stdin.flush()

                def _fire() -> None:
                    nonlocal timed_out
                    timed_out = True
                    self._kill()
                timer = threading.Timer(timeout, _fire)
                timer.start()
                try:
                    out = self.proc.stdout.readline()
                finally:
                    timer.cancel()
                if timed_out:
                    # The request already burned the whole timeout budget. Retrying it through
                    # a one-shot subprocess with a FRESH full timeout would spend the budget a
                    # second time (~2x wall clock) and re-run any side effects — so fail here
                    # instead of degrading. Only fast protocol faults (below) fall back.
                    raise WorkerError(
                        f"{self.cli_id} {argv[:2]} timed out after {timeout:.0f}s")
                resp = json.loads(out)
                if resp.get("worker_error"):
                    raise RuntimeError(resp["worker_error"])
                return resp
            except WorkerError:
                raise
            except Exception:
                # Fast protocol fault (worker crashed / emitted garbage): degrade THIS request
                # to a one-shot subprocess and lazily restart the worker next time. Bound the
                # fallback's own failure so it never escapes as an unshaped 500.
                self._kill()
                try:
                    return runner.run_cli(self.cli_id, argv, stdin, timeout=timeout)
                except (subprocess.TimeoutExpired, runner.SkillError) as e:
                    raise WorkerError(f"{self.cli_id} {argv[:2]} failed: {e}") from e


# Memory ceiling for the deterministic lane, not a backstop above the semaphores.
#
# A one-shot `team.py session` is a whole process tree (fresh interpreter + skill import + its
# lazily spawned dex/meta/ncp siblings). design §9.1: concurrent trees share NOTHING, so total
# RSS is strictly linear in this number, and it is the same limit the lane semaphores and the
# deterministic executor width are all spending — raising any one of them without raising the
# others just moves the queue somewhere less visible.
#
# Size it from the host with `apps/bridge/tools/capacity_benchmark.py`. On the 2-vCPU host the
# deterministic optimum is 2 in flight (throughput peaks there and falls past it), and the lane
# semaphores already hold that line; 4 leaves room for the builder's own tree plus a transient
# overlap without letting an unbounded fan-out reach the cgroup. Per-request RSS varies with the
# operator mix — a validate that only touches dex is far cheaper than a tune that loads the calc
# engine — so re-measure rather than scaling this by core count alone.
ONESHOT_LIMIT = int(os.environ.get("PCUI_ONESHOT_LIMIT") or 4)
_ONESHOT_WAIT = 30.0


class WorkerPool:
    def __init__(self) -> None:
        self._workers = {cli_id: _Worker(cli_id) for cli_id in WORKER_CLIS}
        self._oneshot = threading.BoundedSemaphore(ONESHOT_LIMIT)

    def request(self, cli_id: str, argv: list[str], stdin: str | None = None,
                timeout: float = 60.0) -> dict:
        """{ok, stdout, exit} for one CLI invocation. Non-worker CLIs (team) go straight
        to a subprocess — resident team workers are an explicit anti-pattern (§4.1 🚩)."""
        w = self._workers.get(cli_id)
        if w is None:
            # Bounded, never indefinite: a caller blocked here is holding one of the event
            # loop's few `to_thread` slots, so exhaustion must surface as an error rather than
            # silently converting into unbounded queueing.
            if not self._oneshot.acquire(timeout=min(timeout, _ONESHOT_WAIT)):
                raise WorkerError(
                    f"{cli_id} {argv[:2]} rejected: more than {ONESHOT_LIMIT} concurrent "
                    f"one-shot skill processes")
            try:
                return runner.run_cli(cli_id, argv, stdin, timeout=timeout)
            finally:
                self._oneshot.release()
        return w.request(argv, stdin, timeout)

    def request_json(self, cli_id: str, argv: list[str], stdin: str | None = None,
                     timeout: float = 60.0):
        return json.loads(self.request(cli_id, argv, stdin, timeout)["stdout"])

    def reap_idle(self, max_idle_seconds: float) -> None:
        """Reclaim every resident worker idle past the threshold (online-only, §8). Cheap and
        lock-safe; a busy worker is skipped and a reclaimed one respawns on its next request."""
        now = time.monotonic()
        for w in self._workers.values():
            w.reap_if_idle(max_idle_seconds, now)

    def shutdown(self) -> None:
        for w in self._workers.values():
            with w.lock:
                w._kill()
