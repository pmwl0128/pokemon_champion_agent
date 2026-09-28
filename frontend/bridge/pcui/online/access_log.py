"""Metadata log of the online API's metered requests, kept for later review (design §7.4).

One row per request to a metered entry point (QA, builder, diagnose, actual matchup, tune), whoever
made it: an anonymous visitor, a tester key, the owner dev key or the deploy smoke. A row says who
(access kind, tester key id, device digest, network digest), what (method, route), how it ended
(HTTP status, or the terminal event's status for a streamed answer, plus the error code) and how long
it took. Request bodies, answers and raw addresses are never written: the device is a digest of the
signed anonymous cookie id and the network is the limiter's day-keyed IP digest, so rows can be
grouped by device, and by network within one UTC day, but not traced back.

Retention depends on who the row is about. Visitor and owner rows age out, deploy smoke rows sooner,
tester rows are kept: they are the audit trail of a credential that was handed to a person. Expired
rows are pruned from the write path at most once an hour.

This is its own SQLite file beside ``online.db`` (the quota store keeps its versioned data contract)
and ``tester-keys.db``.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import threading
import time
from pathlib import Path

from ..paths import data_dir
from .tester_keys import since_arg

DAY = 86400
# Days a row is kept, by access kind; None keeps it. A kind not listed here is kept like a visitor.
RETENTION_DAYS: dict[str, int | None] = {"visitor": 90, "dev": 90, "smoke": 14, "tester": None}
PRUNE_EVERY = 3600

_COLUMNS = ("at", "access", "key_id", "device", "network", "method", "route", "status", "code",
            "duration_ms")


class AccessLog:
    __test__ = False

    def __init__(self, db_path: Path, retention: dict[str, int | None] | None = None):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.retention = dict(RETENTION_DAYS if retention is None else retention)
        self._lock = threading.Lock()
        self._pruned_at = 0.0
        self._con = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
        self._con.execute("PRAGMA journal_mode=WAL")
        self._con.execute("PRAGMA synchronous=NORMAL")
        self._con.execute("PRAGMA busy_timeout=10000")
        with self._con:
            self._con.execute(
                "CREATE TABLE IF NOT EXISTS api_requests ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, "
                "access TEXT NOT NULL, key_id TEXT, device TEXT, network TEXT, "
                "method TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL, "
                "code TEXT, duration_ms INTEGER NOT NULL)"
            )
            self._con.execute("CREATE INDEX IF NOT EXISTS api_requests_at ON api_requests (at)")
            self._con.execute(
                "CREATE INDEX IF NOT EXISTS api_requests_key ON api_requests (key_id, at)")
            self._con.execute(
                "CREATE INDEX IF NOT EXISTS api_requests_device ON api_requests (device, at)")
            self._con.execute("PRAGMA user_version=1")
        if os.name != "nt":
            for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm")):
                if candidate.exists():
                    os.chmod(candidate, 0o600)

    def record(self, *, access: str, route: str, method: str, status: int, duration_ms: int,
               key_id: str | None = None, device: str | None = None, network: str | None = None,
               code: str | None = None, at: int | None = None) -> None:
        now = time.time()
        with self._lock, self._con:
            self._con.execute(
                f"INSERT INTO api_requests ({','.join(_COLUMNS)}) VALUES "
                f"({','.join('?' * len(_COLUMNS))})",
                (int(now if at is None else at), access, key_id, device, network, method, route,
                 int(status), code, max(0, int(duration_ms))),
            )
            if now - self._pruned_at >= PRUNE_EVERY:
                self._pruned_at = now
                self._prune(int(now))

    def _prune(self, now: int) -> int:
        removed = 0
        for kind, days in self.retention.items():
            if days is not None:
                removed += self._con.execute(
                    "DELETE FROM api_requests WHERE access=? AND at<?",
                    (kind, now - days * DAY)).rowcount
        # A kind with no rule of its own ages out like a visitor.
        listed = list(self.retention)
        default = self.retention.get("visitor", 90)
        if default is not None and listed:
            removed += self._con.execute(
                f"DELETE FROM api_requests WHERE access NOT IN ({','.join('?' * len(listed))}) "
                "AND at<?", (*listed, now - default * DAY)).rowcount
        return removed

    def prune(self, now: int | None = None) -> int:
        with self._lock, self._con:
            return self._prune(int(time.time() if now is None else now))

    def query(self, *, key_id: str | None = None, access: str | None = None,
              device: str | None = None, route: str | None = None, since: int | None = None,
              limit: int = 200) -> list[dict]:
        """Rows, newest first."""
        clauses, params = [], []
        for column, value in (("key_id", key_id), ("access", access), ("device", device),
                              ("route", route)):
            if value:
                clauses.append(f"{column}=?")
                params.append(value)
        if since is not None:
            clauses.append("at>=?")
            params.append(since)
        where = f"WHERE {' AND '.join(clauses)} " if clauses else ""
        with self._lock:
            rows = self._con.execute(
                f"SELECT id,{','.join(_COLUMNS)} FROM api_requests {where}ORDER BY id DESC LIMIT ?",
                (*params, max(1, int(limit))),
            ).fetchall()
        names = ("id", "at", "access", "keyId", "device", "network", "method", "route", "status",
                 "code", "durationMs")
        return [{name: value for name, value in zip(names, row) if value is not None}
                for row in rows]

    def summary(self, since: int | None = None) -> list[dict]:
        """Per UTC day, access kind and route: requests, refusals, distinct devices, time spent."""
        where, params = ("WHERE at>=? ", (since,)) if since is not None else ("", ())
        with self._lock:
            rows = self._con.execute(
                "SELECT strftime('%Y-%m-%d', at, 'unixepoch') AS day, access, route, COUNT(*), "
                "SUM(status>=400), COUNT(DISTINCT device), SUM(duration_ms) "
                f"FROM api_requests {where}GROUP BY day, access, route "
                "ORDER BY day DESC, access, route", params,
            ).fetchall()
        return [{"day": row[0], "access": row[1], "route": row[2], "requests": row[3],
                 "refused": row[4], "devices": row[5], "durationMs": row[6]} for row in rows]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Read the online API access log")
    parser.add_argument("--db", type=Path, default=data_dir() / "access-log.db")
    commands = parser.add_subparsers(dest="command", required=True)
    query = commands.add_parser("query")
    query.add_argument("--key")
    query.add_argument("--access", choices=sorted(RETENTION_DAYS))
    query.add_argument("--device")
    query.add_argument("--route")
    query.add_argument("--since", type=since_arg)
    query.add_argument("--limit", type=int, default=200)
    summary = commands.add_parser("summary")
    summary.add_argument("--since", type=since_arg)
    commands.add_parser("prune")

    ns = parser.parse_args(argv)
    log = AccessLog(ns.db)
    if ns.command == "query":
        result = {"requests": log.query(key_id=ns.key, access=ns.access, device=ns.device,
                                        route=ns.route, since=ns.since, limit=ns.limit)}
    elif ns.command == "summary":
        result = {"summary": log.summary(ns.since)}
    else:
        result = {"removed": log.prune()}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
