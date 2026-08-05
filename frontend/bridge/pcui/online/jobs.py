"""Short-lived web_jobs task state for the builder wizard (frontend/design.md §7.3).

One build spans queueing, several UEP gates and SSE progress pushes, so the online API
keeps ONE transient row per job: status + gate timeline + (on success) the result payload.
This is task state, NOT history: rows are deleted at TTL, there is no per-user listing,
and request/answer bodies never hit the application log (§7.4). Quota/budget settlement is
owned by the request handler that runs the job — this store only tracks presentation
state. A process restart drops whatever was queued/running (the orchestrator task is gone
with it); startup clears those zombie rows and the visitor simply retries."""
from __future__ import annotations

import json
import secrets
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .database import connect

JOB_TTL_SECONDS = 15 * 60

# The wizard's gate timeline (§7.3 orchestration order). "context" covers context-audit +
# the intake done:true verification; "audit" covers checkpoint + draft + answer-audit.
GATES = ("context", "frame", "ground", "generate", "evaluate", "audit")

TERMINAL = ("done", "failed")


class JobStore:
    """SQLite-backed job rows + an in-process change callback (the SSE bridge). All writes
    notify `on_change(job_id)` so subscribers re-read the snapshot — the row is tiny."""

    def __init__(self, db_path: Path, on_change: Callable[[str], None] | None = None):
        self._lock = threading.Lock()
        self._on_change = on_change
        self._con = connect(db_path)
        # Per-process tiebreaker so two creates landing in the same time.time() tick (.time() can
        # resolve coarsely on Windows) still order strictly: a sits ahead of b in the queue.
        self._seq = 0
        with self._con:
            # A restart orphans queued/running rows (their orchestrator task is gone).
            # web_jobs is not history — drop them instead of surfacing zombie state.
            self._con.execute("DELETE FROM web_jobs WHERE status NOT IN ('done','failed')")

    def set_on_change(self, cb: Callable[[str], None]) -> None:
        self._on_change = cb

    def _notify(self, job_id: str) -> None:
        if self._on_change is not None:
            try:
                self._on_change(job_id)
            except Exception:
                pass  # a broken subscriber must never fail the pipeline

    @staticmethod
    def _fresh_gates() -> list[dict]:
        return [{"gate": g, "status": "pending"} for g in GATES]

    def sweep(self) -> None:
        """Drop expired rows. Called on every job-facing request — traffic keeps it clean;
        an idle process simply keeps a few dead rows until the next visitor."""
        with self._lock, self._con:
            self._con.execute("DELETE FROM web_jobs WHERE expires_at < ?", (time.time(),))

    def create(self) -> str:
        job_id = secrets.token_hex(8)
        now = time.time()
        self._seq += 1
        # Fractional sequence keeps wall-clock ordering for TTL comparison while guaranteeing a
        # strict total order across same-tick creations in THIS store. The step (1e-6) clears
        # float64 ULP at wall-clock magnitude (~2e-7 at 1.7e9s) so successive ties cannot collapse
        # back onto an identical created_at.
        created_at = now + self._seq * 1e-6
        with self._lock, self._con:
            self._con.execute(
                "INSERT INTO web_jobs (id, created_at, status, gates_json, expires_at) "
                "VALUES (?, ?, 'queued', ?, ?)",
                (job_id, created_at, json.dumps(self._fresh_gates()), now + JOB_TTL_SECONDS))
        self._notify(job_id)
        return job_id

    def snapshot(self, job_id: str) -> dict[str, Any] | None:
        """The client-facing view: {id, status, gates, queuePosition, result?, errorCode?}.
        None for unknown/expired ids."""
        with self._lock:
            row = self._con.execute(
                "SELECT status, gates_json, result_json, error_code, created_at, expires_at "
                "FROM web_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None or row[5] < time.time():
                return None
            status, gates_json, result_json, error_code, created_at = row[:5]
            position = 0
            if status == "queued":
                position = self._con.execute(
                    "SELECT COUNT(*) FROM web_jobs WHERE status='queued' AND created_at < ?",
                    (created_at,)).fetchone()[0]
        out: dict[str, Any] = {"id": job_id, "status": status,
                               "gates": json.loads(gates_json),
                               "queuePosition": position}
        if result_json:
            out["result"] = json.loads(result_json)
        if error_code:
            out["errorCode"] = error_code
        return out

    def queued_count(self) -> int:
        with self._lock:
            return self._con.execute(
                "SELECT COUNT(*) FROM web_jobs WHERE status='queued'").fetchone()[0]

    # -- transitions (each notifies the SSE bridge) ----------------------------------------

    def _update(self, job_id: str, **cols: Any) -> None:
        sets = ", ".join(f"{k}=?" for k in cols)
        with self._lock, self._con:
            self._con.execute(f"UPDATE web_jobs SET {sets} WHERE id=?",
                              (*cols.values(), job_id))
        self._notify(job_id)

    def set_running(self, job_id: str) -> None:
        self._update(job_id, status="running")

    def set_gate(self, job_id: str, gate: str, status: str,
                 detail: dict | None = None, raw: dict | None = None) -> None:
        """Mark one gate running/done/failed; earlier gates left as they are. `detail` is
        the gate's fact summary; `raw` is the gate's PROCESSED artifact (pruned +
        provenance-stripped, revised §7.1 — per-species processed data is public), shown
        by the SPA as a collapsible JSON block."""
        with self._lock:
            row = self._con.execute("SELECT gates_json FROM web_jobs WHERE id=?",
                                    (job_id,)).fetchone()
            if row is None:
                return
            gates = json.loads(row[0])
            for entry in gates:
                if entry["gate"] == gate:
                    entry["status"] = status
                    if detail is not None:
                        entry["detail"] = detail
                    if raw is not None:
                        entry["raw"] = raw
            with self._con:
                self._con.execute("UPDATE web_jobs SET gates_json=? WHERE id=?",
                                  (json.dumps(gates, ensure_ascii=False), job_id))
        self._notify(job_id)

    def finish(self, job_id: str, result: dict) -> None:
        """Success: store the result payload and restart the TTL clock so the visitor has
        the full window to read it (the run itself may have eaten minutes of it)."""
        self._update(job_id, status="done",
                     result_json=json.dumps(result, ensure_ascii=False),
                     expires_at=time.time() + JOB_TTL_SECONDS)

    def fail(self, job_id: str, error_code: str) -> None:
        self._update(job_id, status="failed", error_code=error_code)

    def delete(self, job_id: str) -> None:
        with self._lock, self._con:
            self._con.execute("DELETE FROM web_jobs WHERE id=?", (job_id,))
