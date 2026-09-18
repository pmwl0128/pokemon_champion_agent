"""Browser access keys for the public online service.

The store never persists a plaintext credential or device cookie.  Tester keys carry a
non-secret lookup id plus a random secret; only the SHA-256 digest of the whole token is
stored.  A valid tester key binds to the first signed anonymous device id that presents it;
the owner dev key is intentionally reusable across the owner's devices.

This is a separate SQLite database from ``online.db`` so the public quota schema remains
an independently versioned contract.  SQLite transactions also make CLI rotation/removal
safe while the online process is serving requests.
"""
from __future__ import annotations

import argparse
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


class AccessDenied(Exception):
    """The supplied credential is missing, unknown, expired, or no longer current."""


class DeviceMismatch(Exception):
    """A valid credential is already bound to a different browser device."""


class TesterBudgetExhausted(Exception):
    """This tester's configured daily token allowance cannot cover a reservation."""

    __test__ = False


@dataclass(frozen=True)
class TesterGrant:
    key_id: str
    label: str
    daily_token_budget: int | None


@dataclass(frozen=True)
class TesterReservation:
    key_id: str
    day: str
    amount: int


def _now() -> int:
    return int(time.time())


def _day() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8")).digest()


class TesterKeyStore:
    """Persistent tester-key registry and per-key device bindings."""

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
                "device_hash BLOB, created_at INTEGER NOT NULL, rotated_at INTEGER NOT NULL)"
            )
            self._con.execute(
                "CREATE TABLE IF NOT EXISTS tester_usage ("
                "key_id TEXT NOT NULL, day TEXT NOT NULL, reserved INTEGER NOT NULL, "
                "spent INTEGER NOT NULL, PRIMARY KEY (key_id, day))"
            )
            self._con.execute("PRAGMA user_version=1")
        if os.name != "nt":
            # A manual sudo invocation may inherit umask 022 rather than the service's 0077.
            # Tighten the main database and any already-created WAL sidecars explicitly.
            for candidate in (self.path, Path(f"{self.path}-wal"), Path(f"{self.path}-shm")):
                if candidate.exists():
                    os.chmod(candidate, 0o600)

    @staticmethod
    def _new_token(key_id: str) -> str:
        return f"pct_{key_id}_{secrets.token_urlsafe(32)}"

    @staticmethod
    def _validate_budget(value: int | None) -> None:
        if value is not None and value < 0:
            raise ValueError("daily token budget must be non-negative or unlimited")

    def create(self, label: str, daily_token_budget: int | None = None) -> tuple[str, str]:
        label = label.strip()
        if not label or len(label) > 120:
            raise ValueError("label must contain 1..120 characters")
        self._validate_budget(daily_token_budget)
        created = _now()
        while True:
            key_id = secrets.token_hex(8)
            token = self._new_token(key_id)
            try:
                with self._lock, self._con:
                    self._con.execute(
                        "INSERT INTO tester_keys "
                        "(id,label,token_hash,generation,daily_token_budget,device_hash,"
                        "created_at,rotated_at) VALUES (?,?,?,1,?,NULL,?,?)",
                        (key_id, label, _digest(token), daily_token_budget, created, created),
                    )
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
        if not changed:
            raise KeyError(key_id)
        return token

    def remove(self, key_id: str) -> None:
        with self._lock, self._con:
            changed = self._con.execute(
                "DELETE FROM tester_keys WHERE id=?", (key_id,)
            ).rowcount
            self._con.execute("DELETE FROM tester_usage WHERE key_id=?", (key_id,))
        if not changed:
            raise KeyError(key_id)

    def set_budget(self, key_id: str, daily_token_budget: int | None) -> None:
        self._validate_budget(daily_token_budget)
        with self._lock, self._con:
            changed = self._con.execute(
                "UPDATE tester_keys SET daily_token_budget=? WHERE id=?",
                (daily_token_budget, key_id),
            ).rowcount
        if not changed:
            raise KeyError(key_id)

    def reset_binding(self, key_id: str) -> None:
        """Clear a tester binding without changing its token (rotation is normally safer)."""
        with self._lock, self._con:
            changed = self._con.execute(
                "UPDATE tester_keys SET device_hash=NULL WHERE id=?", (key_id,)
            ).rowcount
        if not changed:
            raise KeyError(key_id)

    def authenticate_tester(self, token: str, device_id: str) -> TesterGrant:
        match = TOKEN_RE.fullmatch(token)
        if not match:
            raise AccessDenied("invalid tester key")
        key_id = match.group(1)
        with self._lock, self._con:
            row = self._con.execute(
                "SELECT label,token_hash,daily_token_budget,device_hash "
                "FROM tester_keys WHERE id=?", (key_id,)
            ).fetchone()
            # Compare against a fixed digest even for an unknown id; callers receive one error.
            stored_hash = bytes(row[1]) if row else bytes(32)
            if not hmac.compare_digest(_digest(token), stored_hash):
                raise AccessDenied("invalid tester key")
            device_hash = _digest(device_id)
            bound = bytes(row[3]) if row[3] is not None else None
            if bound is None:
                changed = self._con.execute(
                    "UPDATE tester_keys SET device_hash=? WHERE id=? AND device_hash IS NULL",
                    (device_hash, key_id),
                ).rowcount
                # A separate management/server process may have won the first-use race
                # after our SELECT. Only that winner's device may be admitted.
                if not changed:
                    current = self._con.execute(
                        "SELECT device_hash FROM tester_keys WHERE id=?", (key_id,)
                    ).fetchone()
                    if current is None:
                        raise AccessDenied("tester key was removed")
                    if current[0] is None or not hmac.compare_digest(
                            bytes(current[0]), device_hash):
                        raise DeviceMismatch("tester key is bound to another device")
            elif not hmac.compare_digest(device_hash, bound):
                raise DeviceMismatch("tester key is bound to another device")
            return TesterGrant(key_id, str(row[0]), row[2])

    def reserve(self, key_id: str, amount: int) -> TesterReservation:
        if amount < 0:
            raise ValueError("reservation must be non-negative")
        day = _day()
        cutoff = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 3 * 86400))
        with self._lock, self._con:
            self._con.execute("DELETE FROM tester_usage WHERE day < ?", (cutoff,))
            key_row = self._con.execute(
                "SELECT daily_token_budget FROM tester_keys WHERE id=?", (key_id,)
            ).fetchone()
            if key_row is None:
                raise AccessDenied("tester key was removed")
            usage = self._con.execute(
                "SELECT reserved,spent FROM tester_usage WHERE key_id=? AND day=?",
                (key_id, day),
            ).fetchone() or (0, 0)
            budget = key_row[0]
            if budget is not None and int(usage[0]) + int(usage[1]) + amount > int(budget):
                raise TesterBudgetExhausted("tester daily token budget exhausted")
            self._con.execute(
                "INSERT INTO tester_usage (key_id,day,reserved,spent) VALUES (?,?,?,0) "
                "ON CONFLICT(key_id,day) DO UPDATE SET reserved=reserved+excluded.reserved",
                (key_id, day, amount),
            )
        return TesterReservation(key_id, day, amount)

    def settle(self, reservation: TesterReservation, actual_tokens: int) -> None:
        with self._lock, self._con:
            self._con.execute(
                "UPDATE tester_usage SET reserved=MAX(0,reserved-?),spent=spent+? "
                "WHERE key_id=? AND day=?",
                (reservation.amount, max(0, int(actual_tokens)),
                 reservation.key_id, reservation.day),
            )

    def list(self) -> list[dict]:
        day = _day()
        with self._lock:
            rows = self._con.execute(
                "SELECT k.id,k.label,k.generation,k.daily_token_budget,"
                "k.device_hash IS NOT NULL,k.created_at,k.rotated_at,"
                "COALESCE(u.reserved,0),COALESCE(u.spent,0) "
                "FROM tester_keys k LEFT JOIN tester_usage u "
                "ON u.key_id=k.id AND u.day=? ORDER BY k.created_at,k.id",
                (day,),
            ).fetchall()
        return [
            {"id": row[0], "label": row[1], "generation": row[2],
             "dailyTokenBudget": row[3], "deviceBound": bool(row[4]),
             "createdAt": row[5], "rotatedAt": row[6],
             "today": {"reserved": row[7], "spent": row[8]}}
            for row in rows
        ]


def _budget_arg(raw: str) -> int | None:
    if raw.lower() in {"unlimited", "none", "infinite"}:
        return None
    value = int(raw)
    if value < 0:
        raise argparse.ArgumentTypeError("budget must be non-negative or 'unlimited'")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Manage device-bound tester access keys")
    parser.add_argument("--db", type=Path, default=data_dir() / "tester-keys.db")
    commands = parser.add_subparsers(dest="command", required=True)

    create = commands.add_parser("create")
    create.add_argument("--label", required=True)
    create.add_argument("--daily-token-budget", type=_budget_arg, default=None)
    rotate = commands.add_parser("rotate")
    rotate.add_argument("id")
    remove = commands.add_parser("remove")
    remove.add_argument("id")
    budget = commands.add_parser("set-budget")
    budget.add_argument("id")
    budget.add_argument("daily_token_budget", type=_budget_arg)
    reset = commands.add_parser("reset-binding")
    reset.add_argument("id")
    commands.add_parser("list")

    ns = parser.parse_args(argv)
    store = TesterKeyStore(ns.db)
    try:
        if ns.command == "create":
            key_id, token = store.create(ns.label, ns.daily_token_budget)
            result = {"id": key_id, "token": token,
                      "dailyTokenBudget": ns.daily_token_budget}
        elif ns.command == "rotate":
            result = {"id": ns.id, "token": store.rotate(ns.id)}
        elif ns.command == "remove":
            store.remove(ns.id)
            result = {"id": ns.id, "removed": True}
        elif ns.command == "set-budget":
            store.set_budget(ns.id, ns.daily_token_budget)
            result = {"id": ns.id, "dailyTokenBudget": ns.daily_token_budget}
        elif ns.command == "reset-binding":
            store.reset_binding(ns.id)
            result = {"id": ns.id, "deviceBound": False}
        else:
            result = {"keys": store.list()}
    except (KeyError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
