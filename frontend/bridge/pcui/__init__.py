"""pcui — the local bridge for the Pokemon Champions web UI (frontend/design.md §4).

`pcui serve` hosts the SPA-facing API on 127.0.0.1: resident NDJSON workers for the query
skills (one-shot subprocess fallback), team ops batched through `team.py session`, a SQLite
session/artifact store with optimistic locking + SSE, and fragment-bootstrap security.
"""

__version__ = "0.1.0"
