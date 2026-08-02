"""Versioned initialization for the writable online SQLite state.

Schema 1 deliberately keeps the three schema-0 tables byte-for-byte compatible.  The
first migration is therefore an explicit recognition gate: an unversioned database is
accepted only when every existing managed table has the exact historical shape.  Missing
managed tables are created, the complete shape is rechecked, and only then is
``PRAGMA user_version`` advanced to 1.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path

CONTRACT_PATH = Path(__file__).with_name("data-contract.json")
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))

TABLES = {
    "qa_quota": (
        "CREATE TABLE IF NOT EXISTS qa_quota ("
        "id TEXT, day TEXT, used INTEGER NOT NULL, PRIMARY KEY (id, day))"
    ),
    "qa_budget": (
        "CREATE TABLE IF NOT EXISTS qa_budget ("
        "day TEXT PRIMARY KEY, reserved INTEGER NOT NULL, spent INTEGER NOT NULL)"
    ),
    "web_jobs": (
        "CREATE TABLE IF NOT EXISTS web_jobs ("
        "id TEXT PRIMARY KEY, created_at REAL NOT NULL, status TEXT NOT NULL, "
        "gates_json TEXT NOT NULL, result_json TEXT, error_code TEXT, "
        "expires_at REAL NOT NULL)"
    ),
}

EXPECTED_COLUMNS = {
    "qa_quota": (
        ("id", "TEXT", 0, 1),
        ("day", "TEXT", 0, 2),
        ("used", "INTEGER", 1, 0),
    ),
    "qa_budget": (
        ("day", "TEXT", 0, 1),
        ("reserved", "INTEGER", 1, 0),
        ("spent", "INTEGER", 1, 0),
    ),
    "web_jobs": (
        ("id", "TEXT", 0, 1),
        ("created_at", "REAL", 1, 0),
        ("status", "TEXT", 1, 0),
        ("gates_json", "TEXT", 1, 0),
        ("result_json", "TEXT", 0, 0),
        ("error_code", "TEXT", 0, 0),
        ("expires_at", "REAL", 1, 0),
    ),
}


def _columns(connection: sqlite3.Connection, table: str) -> tuple[tuple, ...]:
    return tuple(
        (str(row[1]), str(row[2]).upper(), int(row[3]), int(row[5]))
        for row in connection.execute(f'PRAGMA table_info("{table}")')
    )


def validate_schema(connection: sqlite3.Connection) -> None:
    tables = {
        str(row[0]) for row in connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    if tables != set(EXPECTED_COLUMNS):
        raise RuntimeError(
            f"online database has an incompatible table set: {sorted(tables)!r}"
        )
    for table, expected in EXPECTED_COLUMNS.items():
        actual = _columns(connection, table)
        if actual != expected:
            raise RuntimeError(
                f"online database table {table!r} has an incompatible shape: "
                f"expected={expected!r}, actual={actual!r}"
            )


def connect(db_path: Path, *, check_same_thread: bool = False) -> sqlite3.Connection:
    """Open, recognize/migrate, and return one online-state connection."""
    connection = sqlite3.connect(db_path, check_same_thread=check_same_thread)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=NORMAL")
        version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if version not in CONTRACT["migrationFrom"]:
            raise RuntimeError(
                f"online database schema {version} cannot migrate to "
                f"{CONTRACT['targetSchema']}"
            )
        with connection:
            for statement in TABLES.values():
                connection.execute(statement)
            validate_schema(connection)
            if version != CONTRACT["targetSchema"]:
                connection.execute(f"PRAGMA user_version={int(CONTRACT['targetSchema'])}")
        return connection
    except Exception:
        connection.close()
        raise
