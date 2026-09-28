"""Browser access keys for the public online service.

The store never persists a plaintext credential or device cookie.  Tester keys carry a
non-secret lookup id plus a random secret; only the SHA-256 digest of the whole token is
stored.  A valid tester key binds to the first signed anonymous device id that presents it;
the owner dev key is intentionally reusable across the owner's devices.

A key may carry a UTC-daily token budget, a lifetime (total) token budget, both, or neither.  Daily
usage lives in ``tester_usage`` rows that expire after three days; lifetime spend is a counter on the
key itself, so it survives that expiry and a rotation (the allowance belongs to the key id, not to a
token generation).  ``holder`` is a free-text note of who actually uses the key, kept by hand.

What happens to a key is written to ``tester_events``, an append-only trail that is never pruned and
outlives the key's removal: lifecycle changes (create, rotate, budgets, holder, binding reset,
removal), the first device binding, every settled model spend, and every refusal (another device, a
stale or wrong token for a known id, an exhausted budget).  The requests a key makes are in the
shared API access log (``access_log.py``), where tester rows are kept permanently too.  Devices and
networks appear in both only as short digests — comparable, never the value itself.

This is a separate SQLite database from ``online.db`` so the public quota schema remains
an independently versioned contract.  SQLite transactions also make CLI rotation/removal
safe while the online process is serving requests.
"""
from __future__ import annotations

import argparse
import calendar
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ..paths import data_dir

TOKEN_RE = re.compile(r"pct_([0-9a-f]{16})_([A-Za-z0-9_-]{32,})\Z")
HOLDER_MAX = 120


class AccessDenied(Exception):
    """The supplied credential is missing, unknown, expired, or no longer current."""


class DeviceMismatch(Exception):
    """A valid credential is already bound to a different browser device."""


class TesterBudgetExhausted(Exception):
    """This tester's configured daily or total token allowance cannot cover a reservation."""

    __test__ = False


@dataclass(frozen=True)
class TesterGrant:
    key_id: str
    label: str
    daily_token_budget: int | None
    total_token_budget: int | None = None


@dataclass(frozen=True)
class TesterReservation:
    key_id: str
    day: str
    amount: int
    route: str = ""


def _now() -> int:
    return int(time.time())


def _day() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


def device_tag(device_id: str) -> str:
    """A device as the audit records name it: a short digest, comparable but not reversible."""
    return _digest(device_id).hex()[:12]


_EVENT_FIELDS = ("route", "tokens", "device", "network", "detail")


class TesterKeyStore:
    """Persistent tester-key registry, per-key device bindings and their event trail."""

    __test__ = False

    def __init__(self, db_path: Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._con = sqlite3.connect(self.path, check_same_thread=False, timeout=10)
        self._con.execute("PRAGMA journal_mode=WAL")
        self._con.execute("PRAGMA synchronous=NORMAL")
        self._con.execute("PRAGMA busy_timeout=10000")
        with self._con:
            self._con.execute(
                "CREATE TABLE IF NOT EXISTS tester_keys ("
                "id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash BLOB NOT NULL, "
                "generation INTEGER NOT NULL, daily_token_budget INTEGER, "
                "device_hash BLOB, created_at INTEGER NOT NULL, rotated_at INTEGER NOT NULL, "
                "total_token_budget INTEGER, total_spent INTEGER NOT NULL DEFAULT 0, "
                "holder TEXT NOT NULL DEFAULT '', last_used_at INTEGER)"
            )
            # Older stores lack the later columns. They are added in place, keyed on the columns
            # that exist rather than on user_version: an older build reopening the file resets the
            # version, and its explicit column lists ignore the additions.
            columns = {row[1] for row in self._con.execute("PRAGMA table_info(tester_keys)")}
            for name, ddl in (("total_token_budget", "INTEGER"),
                              ("total_spent", "INTEGER NOT NULL DEFAULT 0"),
                              ("holder", "TEXT NOT NULL DEFAULT ''"),
                              ("last_used_at", "INTEGER")):
                if name not in columns:
                    self._con.execute(f"ALTER TABLE tester_keys ADD COLUMN {name} {ddl}")
            self._con.execute(
                "CREATE TABLE IF NOT EXISTS tester_usage ("
                "key_id TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, "
                "spent INTEGER NOT NULL, PRIMARY KEY (key_id, day))"
            )
            self._con.execute(
                "CREATE TABLE IF NOT EXISTS tester_events ("
                "id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, "
                "key_id TEXT NOT NULL, generation INTEGER, kind TEXT NOT NULL, "
                "route TEXT, tokens INTEGER, device TEXT, network TEXT, detail TEXT)"
            )
            self._con.execute(
                "CREATE INDEX IF NOT EXISTS tester_events_key_at ON tester_events (key_id, at)")
            self._con.execute("PRAGMA user_version=3")
        if os.name != "nt":
            # A manual sudo invocation may inherit umask 022 rather than the service's 0077.
            # Tighten the main database and any already-created WAL sidecars explicitly.
            for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm")):
                if candidate.exists():
                    os.chmod(candidate, 0o600)

    # -- event trail ---------------------------------------------------------------------

    def _event(self, key_id: str, kind: str, generation: int | None = None, **fields) -> None:
        """Append one event. Callers hold the lock and an open transaction."""
        unknown = set(fields) - set(_EVENT_FIELDS)
        if unknown:
            raise ValueError(f"unknown event fields: {sorted(unknown)}")
        if generation is None:
            row = self._con.execute(
                "SELECT generation FROM tester_keys WHERE id=?", (key_id,)).fetchone()
            generation = row[0] if row else None
        self._con.execute(
            "INSERT INTO tester_events (at,key_id,generation,kind,route,tokens,device,network,"
            "detail) VALUES (?,?,?,?,?,?,?,?,?)",
            (_now(), key_id, generation, kind, *(fields.get(name) for name in _EVENT_FIELDS)),
        )

    def events(self, key_id: str | None = None, since: int | None = None,
               kind: str | None = None, limit: int = 200) -> list[dict]:
        """Events, newest first."""
        clauses, params = [], []
        if key_id:
            clauses.append("key_id=?")
            params.append(key_id)
        if since is not None:
            clauses.append("at>=?")
            params.append(since)
        if kind:
            clauses.append("kind=?")
            params.append(kind)
        where = f"WHERE {' AND '.join(clauses)} " if clauses else ""
        with self._lock:
            rows = self._con.execute(
                "SELECT id,at,key_id,generation,kind,route,tokens,device,network,detail "
                f"FROM tester_events {where}ORDER BY id DESC LIMIT ?",
                (*params, max(1, int(limit))),
            ).fetchall()
        names = ("id", "at", "keyId", "generation", "kind", "route", "tokens", "device",
                 "network", "detail")
        return [{name: value for name, value in zip(names, row) if value is not None}
                for row in rows]

    # -- lifecycle -----------------------------------------------------------------------

    @staticmethod
    def _new_token(key_id: str) -> str:
        return f"pct_{key_id}_{secrets.token_urlsafe(32)}"

    @staticmethod
    def _validate_budget(value: int | None) -> None:
        if value is not None and value < 0:
            raise ValueError("token budget must be non-negative or unlimited")

    @staticmethod
    def _clean_holder(holder: str) -> str:
        holder = holder.strip()
        if len(holder) > HOLDER_MAX:
            raise ValueError(f"holder must contain at most {HOLDER_MAX} characters")
        return holder

    def create(self, label: str, daily_token_budget: int | None = None,
               total_token_budget: int | None = None, holder: str = "") -> tuple[str, str]:
        label = label.strip()
        if not label or len(label) > 120:
            raise ValueError("label must contain 1..120 characters")
        self._validate_budget(daily_token_budget)
        self._validate_budget(total_token_budget)
        holder = self._clean_holder(holder)
        created = _now()
        while True:
            key_id = secrets.token_hex(8)
            token = self._new_token(key_id)
            try:
                with self._lock, self._con:
                    self._con.execute(
                        "INSERT INTO tester_keys "
                        "(id,label,token_hash,generation,daily_token_budget,device_hash,"
                        "created_at,rotated_at,total_token_budget,total_spent,holder) "
                        "VALUES (?,?,?,1,?,NULL,?,?,?,0,?)",
                        (key_id, label, _digest(token), daily_token_budget, created, created,
                         total_token_budget, holder),
                    )
                    self._event(key_id, "created", 1, detail=json.dumps({
                        "label": label, "holder": holder, "dailyTokenBudget": daily_token_budget,
                        "totalTokenBudget": total_token_budget}, ensure_ascii=False))
                return key_id, token
            except sqlite3.IntegrityError:
                continue

    def rotate(self, key_id: str) -> str:
        token = self._new_token(key_id)
        with self._lock, self._con:
            changed = self._con.execute(
                "UPDATE tester_keys SET token_hash=?, generation=generation+1, "
                "device_hash=NULL, rotated_at=? WHERE id=?",
                (_digest(token), _now(), key_id),
            ).rowcount
            if changed:
                self._event(key_id, "rotated")
        if not changed:
            raise KeyError(key_id)
        return token

    def remove(self, key_id: str) -> None:
        """Revoke a key. Its events stay: after a removal is when they are read."""
        with self._lock, self._con:
            row = self._con.execute(
                "SELECT generation FROM tester_keys WHERE id=?", (key_id,)).fetchone()
            changed = self._con.execute(
                "DELETE FROM tester_keys WHERE id=?", (key_id,)
            ).rowcount
            self._con.execute("DELETE FROM tester_usage WHERE key_id=?", (key_id,))
            if changed:
                self._event(key_id, "removed", row[0] if row else None)
        if not changed:
            raise KeyError(key_id)

    def _set(self, key_id: str, column: str, value, kind: str) -> None:
        with self._lock, self._con:
            changed = self._con.execute(
                f"UPDATE tester_keys SET {column}=? WHERE id=?", (value, key_id),
            ).rowcount
            if changed:
                self._event(key_id, kind, detail=json.dumps(value, ensure_ascii=False))
        if not changed:
            raise KeyError(key_id)

    def set_budget(self, key_id: str, daily_token_budget: int | None) -> None:
        self._validate_budget(daily_token_budget)
        self._set(key_id, "daily_token_budget", daily_token_budget, "daily_budget_set")

    def set_total_budget(self, key_id: str, total_token_budget: int | None) -> None:
        """Set the lifetime allowance. What the key has spent so far counts against the new value."""
        self._validate_budget(total_token_budget)
        self._set(key_id, "total_token_budget", total_token_budget, "total_budget_set")

    def set_holder(self, key_id: str, holder: str) -> None:
        """Record who actually uses the key; an empty string clears it."""
        self._set(key_id, "holder", self._clean_holder(holder), "holder_set")

    def reset_binding(self, key_id: str) -> None:
        """Clear a tester binding without changing its token (rotation is normally safer)."""
        with self._lock, self._con:
            changed = self._con.execute(
                "UPDATE tester_keys SET device_hash=NULL WHERE id=?", (key_id,)
            ).rowcount
            if changed:
                self._event(key_id, "binding_reset")
        if not changed:
            raise KeyError(key_id)

    # -- access --------------------------------------------------------------------------

    def authenticate_tester(self, token: str, device_id: str,
                            network: str | None = None) -> TesterGrant:
        match = TOKEN_RE.fullmatch(token)
        if not match:
            raise AccessDenied("invalid tester key")
        key_id = match.group(1)
        # A refusal is recorded first and raised after the transaction holding the record commits.
        refusal: Exception | None = None
        grant: TesterGrant | None = None
        device_hash = _digest(device_id)
        tag = device_tag(device_id)
        with self._lock, self._con:
            row = self._con.execute(
                "SELECT label,token_hash,daily_token_budget,device_hash,total_token_budget,"
                "generation FROM tester_keys WHERE id=?", (key_id,)
            ).fetchone()
            # Compare against a fixed digest even for an unknown id; callers receive one error.
            stored_hash = bytes(row[1]) if row else bytes(32)
            if not hmac.compare_digest(_digest(token), stored_hash):
                if row is not None:
                    # A known id with the wrong secret: most often a token from before a rotation.
                    self._event(key_id, "invalid_token", row[5], device=tag, network=network)
                refusal = AccessDenied("invalid tester key")
            else:
                bound = bytes(row[3]) if row[3] is not None else None
                if bound is None:
                    changed = self._con.execute(
                        "UPDATE tester_keys SET device_hash=? WHERE id=? AND device_hash IS NULL",
                        (device_hash, key_id),
                    ).rowcount
                    if changed:
                        self._event(key_id, "bound", row[5], device=tag, network=network)
                    else:
                        # A separate management/server process may have won the first-use race
                        # after our SELECT. Only that winner's device may be admitted.
                        current = self._con.execute(
                            "SELECT device_hash FROM tester_keys WHERE id=?", (key_id,)
                        ).fetchone()
                        if current is None:
                            refusal = AccessDenied("tester key was removed")
                        elif current[0] is None or not hmac.compare_digest(
                                bytes(current[0]), device_hash):
                            refusal = DeviceMismatch("tester key is bound to another device")
                elif not hmac.compare_digest(device_hash, bound):
                    refusal = DeviceMismatch("tester key is bound to another device")
                if isinstance(refusal, DeviceMismatch):
                    self._event(key_id, "device_mismatch", row[5], device=tag, network=network)
                if refusal is None:
                    self._con.execute(
                        "UPDATE tester_keys SET last_used_at=? WHERE id=?", (_now(), key_id))
                    grant = TesterGrant(key_id, str(row[0]), row[2], row[4])
        if refusal is not None:
            raise refusal
        assert grant is not None
        return grant

    def reserve(self, key_id: str, amount: int, route: str = "") -> TesterReservation:
        if amount < 0:
            raise ValueError("reservation must be non-negative")
        day = _day()
        cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 3 * 86400))
        refusal: Exception | None = None
        with self._lock, self._con:
            self._con.execute("DELETE FROM tester_usage WHERE day < ?", (cutoff,))
            key_row = self._con.execute(
                "SELECT daily_token_budget,total_token_budget,total_spent "
                "FROM tester_keys WHERE id=?", (key_id,)
            ).fetchone()
            if key_row is None:
                raise AccessDenied("tester key was removed")
            usage = self._con.execute(
                "SELECT reserved,spent FROM tester_usage WHERE key_id=? AND day=?",
                (key_id, day),
            ).fetchone() or (0, 0)
            budget = key_row[0]
            total = key_row[1]
            if budget is not None and int(usage[0]) + int(usage[1]) + amount > int(budget):
                refusal = TesterBudgetExhausted("tester daily token budget exhausted")
            elif total is not None:
                # In-flight reservations are read from the retained daily rows, so one stranded by
                # a crashed request stops counting when its row expires instead of forever.
                in_flight = self._con.execute(
                    "SELECT COALESCE(SUM(reserved),0) FROM tester_usage WHERE key_id=?",
                    (key_id,),
                ).fetchone()[0]
                if int(key_row[2]) + int(in_flight) + amount > int(total):
                    refusal = TesterBudgetExhausted("tester total token budget exhausted")
            if refusal is not None:
                self._event(key_id, "budget_exhausted", route=route or None, tokens=amount,
                            detail=str(refusal))
            else:
                self._con.execute(
                    "INSERT INTO tester_usage (key_id,day,reserved,spent) VALUES (?,?,?,0) "
                    "ON CONFLICT(key_id,day) DO UPDATE SET reserved=reserved+excluded.reserved",
                    (key_id, day, amount),
                )
        if refusal is not None:
            raise refusal
        return TesterReservation(key_id, day, amount, route)

    def settle(self, reservation: TesterReservation, actual_tokens: int) -> None:
        spent = max(0, int(actual_tokens))
        with self._lock, self._con:
            self._con.execute(
                "UPDATE tester_usage SET reserved=MAX(0,reserved-?),spent=spent+? "
                "WHERE key_id=? AND day=?",
                (reservation.amount, spent, reservation.key_id, reservation.day),
            )
            self._con.execute(
                "UPDATE tester_keys SET total_spent=total_spent+? WHERE id=?",
                (spent, reservation.key_id),
            )
            self._event(reservation.key_id, "spend", route=reservation.route or None,
                        tokens=spent)

    def list(self) -> list[dict]:
        day = _day()
        with self._lock:
            rows = self._con.execute(
                "SELECT k.id,k.label,k.generation,k.daily_token_budget,"
                "k.device_hash IS NOT NULL,k.created_at,k.rotated_at,"
                "COALESCE(u.reserved,0),COALESCE(u.spent,0),k.total_token_budget,k.total_spent,"
                "k.holder,k.last_used_at "
                "FROM tester_keys k LEFT JOIN tester_usage u "
                "ON u.key_id=k.id AND u.day=? ORDER BY k.created_at,k.id",
                (day,),
            ).fetchall()
        return [
            {"id": row[0], "label": row[1], "holder": row[11], "generation": row[2],
             "dailyTokenBudget": row[3], "deviceBound": bool(row[4]),
             "createdAt": row[5], "rotatedAt": row[6], "lastUsedAt": row[12],
             "today": {"reserved": row[7], "spent": row[8]},
             "totalTokenBudget": row[9], "totalSpent": row[10]}
            for row in rows
        ]


def budget_arg(raw: str) -> int | None:
    if raw.lower() in {"unlimited", "none", "infinite"}:
        return None
    value = int(raw)
    if value < 0:
        raise argparse.ArgumentTypeError("budget must be non-negative or 'unlimited'")
    return value


def since_arg(raw: str) -> int:
    """A UTC date (YYYY-MM-DD) as the epoch second it starts."""
    try:
        return calendar.timegm(time.strptime(raw, "%Y-%m-%d"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("since must be a UTC date YYYY-MM-DD") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage device-bound tester access keys")
    parser.add_argument("--db", type=Path, default=data_dir() / "tester-keys.db")
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create")
    create.add_argument("--label", required=True)
    create.add_argument("--holder", default="")
    create.add_argument("--daily-token-budget", type=budget_arg, default=None)
    create.add_argument("--total-token-budget", type=budget_arg, default=None)
    rotate = commands.add_parser("rotate")
    rotate.add_argument("id")
    remove = commands.add_parser("remove")
    remove.add_argument("id")
    budget = commands.add_parser("set-budget")
    budget.add_argument("id")
    budget.add_argument("daily_token_budget", type=budget_arg)
    total = commands.add_parser("set-total-budget")
    total.add_argument("id")
    total.add_argument("total_token_budget", type=budget_arg)
    holder = commands.add_parser("set-holder")
    holder.add_argument("id")
    holder.add_argument("holder")
    reset = commands.add_parser("reset-binding")
    reset.add_argument("id")
    commands.add_parser("list")
    events = commands.add_parser("events")
    events.add_argument("--key")
    events.add_argument("--since", type=since_arg)
    events.add_argument("--kind")
    events.add_argument("--limit", type=int, default=200)

    ns = parser.parse_args(argv)
    store = TesterKeyStore(ns.db)
    try:
        if ns.command == "create":
            key_id, token = store.create(ns.label, ns.daily_token_budget, ns.total_token_budget,
                                         ns.holder)
            result = {"id": key_id, "token": token, "holder": ns.holder.strip(),
                      "dailyTokenBudget": ns.daily_token_budget,
                      "totalTokenBudget": ns.total_token_budget}
        elif ns.command == "rotate":
            result = {"id": ns.id, "token": store.rotate(ns.id)}
        elif ns.command == "remove":
            store.remove(ns.id)
            result = {"id": ns.id, "removed": True}
        elif ns.command == "set-budget":
            store.set_budget(ns.id, ns.daily_token_budget)
            result = {"id": ns.id, "dailyTokenBudget": ns.daily_token_budget}
        elif ns.command == "set-total-budget":
            store.set_total_budget(ns.id, ns.total_token_budget)
            result = {"id": ns.id, "totalTokenBudget": ns.total_token_budget}
        elif ns.command == "set-holder":
            store.set_holder(ns.id, ns.holder)
            result = {"id": ns.id, "holder": ns.holder.strip()}
        elif ns.command == "reset-binding":
            store.reset_binding(ns.id)
            result = {"id": ns.id, "deviceBound": False}
        elif ns.command == "events":
            result = {"events": store.events(ns.key, ns.since, ns.kind, ns.limit)}
        else:
            result = {"keys": store.list()}
    except (KeyError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
