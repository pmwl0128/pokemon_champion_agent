"""Session/artifact store (apps/design.md §4.2): one SQLite file, three relations.

- artifacts: immutable, content-addressed (sha256 over kind + NUL + raw payload), shared
  across sessions; `raw_payload` keeps the EXACT bytes (audit receipts must round-trip).
- session_artifacts: append-only ledger (session_id, sequence).
- sessions: heads (kind -> artifact hash) + revision in ONE row — optimistic locking is a
  single-row compare-and-swap; a stale writer gets a Conflict with the current state.

Listeners registered via `subscribe` receive every committed artifact append (the SSE feed).
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

Event = dict
Listener = Callable[[Event], None]


class Conflict(Exception):
    def __init__(self, session_id: str, expected: int, actual: int):
        super().__init__(f"session {session_id}: expected revision {expected}, actual {actual}")
        self.session_id, self.expected, self.actual = session_id, expected, actual


class NotFound(Exception):
    pass


_SCHEMA = """
create table if not exists artifacts(
  hash text primary key,
  kind text not null,
  raw_payload blob not null,
  created_at text not null
);
create table if not exists session_artifacts(
  session_id text not null,
  sequence integer not null,
  kind text not null,
  artifact_hash text not null references artifacts(hash),
  created_at text not null,
  primary key(session_id, sequence)
);
create table if not exists sessions(
  id text primary key,
  created_at text not null,
  revision integer not null default 0,
  heads_json text not null default '{}',
  meta_json text not null default '{}'
);
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def artifact_hash(kind: str, payload: bytes) -> str:
    return hashlib.sha256(kind.encode("utf-8") + b"\0" + payload).hexdigest()


class Store:
    def __init__(self, path: Path | str):
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("pragma journal_mode=wal")
        self._conn.executescript(_SCHEMA)
        self._lock = threading.Lock()
        self._listeners: list[Listener] = []

    # -- sessions ------------------------------------------------------------------

    def create_session(self, meta: dict | None = None) -> dict:
        sid = uuid.uuid4().hex[:12]
        with self._lock, self._conn:
            self._conn.execute(
                "insert into sessions(id, created_at, meta_json) values(?,?,?)",
                (sid, _now(), json.dumps(meta or {}, ensure_ascii=False)))
        return self.get_session(sid)

    @staticmethod
    def _row_to_session(row: sqlite3.Row) -> dict:
        return {"id": row["id"], "createdAt": row["created_at"], "revision": row["revision"],
                "heads": json.loads(row["heads_json"]), "meta": json.loads(row["meta_json"])}

    def get_session(self, session_id: str) -> dict:
        # Reads take the lock too: the connection is shared (check_same_thread=False), so an
        # unsynchronized read on another thread could observe a writer's mid-transaction state.
        with self._lock:
            row = self._conn.execute(
                "select * from sessions where id=?", (session_id,)).fetchone()
        if row is None:
            raise NotFound(session_id)
        return self._row_to_session(row)

    def list_sessions(self) -> list[dict]:
        # One query builds every session (previously a select-ids then per-row get_session
        # N+1, also re-probed on every CLI liveness check).
        with self._lock:
            rows = self._conn.execute(
                "select * from sessions order by created_at desc").fetchall()
        return [self._row_to_session(r) for r in rows]

    # -- artifacts -----------------------------------------------------------------

    def append_artifact(self, session_id: str, kind: str, payload: bytes,
                        expected_revision: int) -> dict:
        """CAS append: store the immutable artifact, extend the ledger, and move the
        session head — all in one transaction guarded by the revision the writer saw."""
        h = artifact_hash(kind, payload)
        with self._lock, self._conn:
            row = self._conn.execute(
                "select revision, heads_json from sessions where id=?", (session_id,)).fetchone()
            if row is None:
                raise NotFound(session_id)
            if row["revision"] != expected_revision:
                raise Conflict(session_id, expected_revision, row["revision"])
            self._conn.execute(
                "insert or ignore into artifacts(hash, kind, raw_payload, created_at) "
                "values(?,?,?,?)", (h, kind, payload, _now()))
            seq = self._conn.execute(
                "select coalesce(max(sequence), -1) + 1 from session_artifacts "
                "where session_id=?", (session_id,)).fetchone()[0]
            self._conn.execute(
                "insert into session_artifacts(session_id, sequence, kind, artifact_hash, "
                "created_at) values(?,?,?,?,?)", (session_id, seq, kind, h, _now()))
            heads = json.loads(row["heads_json"])
            heads[kind] = h
            new_rev = row["revision"] + 1
            self._conn.execute("update sessions set heads_json=?, revision=? where id=?",
                               (json.dumps(heads, ensure_ascii=False), new_rev, session_id))
        event = {"sessionId": session_id, "kind": kind, "artifactHash": h,
                 "revision": new_rev, "sequence": seq}
        for fn in list(self._listeners):
            fn(event)
        return event

    def get_artifact(self, h: str) -> dict:
        with self._lock:
            row = self._conn.execute(
                "select * from artifacts where hash=?", (h,)).fetchone()
        if row is None:
            raise NotFound(h)
        return {"hash": row["hash"], "kind": row["kind"], "createdAt": row["created_at"],
                "payload": bytes(row["raw_payload"])}

    def session_ledger(self, session_id: str) -> list[dict]:
        # camelCase like every other store output (sessions, append events) — this crosses
        # the wire as LedgerEntryDto, not as a raw sqlite row.
        with self._lock:
            rows = self._conn.execute(
                "select sequence, kind, artifact_hash, created_at from session_artifacts "
                "where session_id=? order by sequence", (session_id,)).fetchall()
        return [{"sequence": r["sequence"], "kind": r["kind"],
                 "artifactHash": r["artifact_hash"], "createdAt": r["created_at"]}
                for r in rows]

    def changes_since_revision(self, session_id: str, revision: int) -> list[dict]:
        """Committed ledger entries after a caller's revision baseline.

        Revision increments once per append and sequence starts at zero, so a writer that read
        revision N has seen sequences 0..N-1. This is conflict evidence only: the opaque store never
        decides whether different artifact kinds are semantically mergeable.
        """
        with self._lock:
            rows = self._conn.execute(
                "select sequence, kind, artifact_hash, created_at from session_artifacts "
                "where session_id=? and sequence>=? order by sequence",
                (session_id, max(0, revision))).fetchall()
        return [{"sequence": r["sequence"], "kind": r["kind"],
                 "artifactHash": r["artifact_hash"], "createdAt": r["created_at"]}
                for r in rows]

    # -- events --------------------------------------------------------------------

    def subscribe(self, fn: Listener) -> Callable[[], None]:
        self._listeners.append(fn)
        return lambda: self._listeners.remove(fn)

    def close(self) -> None:
        self._conn.close()
