"""Deterministic content id for a shipped team — computed at READ time, never stored (decision B,
dev/design.md). The id is a pure projection of a team's facts, so it stays consistent with the
facts-only library by construction (no field↔content drift, no migration when the library refreshes).

FROZEN SPEC — `compute_id_v1` is a contract (dev/conventions.md). Changing what it hashes
changes every id, so DO NOT edit it in place: add `compute_id_v2` and bump the caller. Properties the
spec guarantees:
  - member order-independent   (members are sorted; a team is a SET of 6 builds)
  - move order-independent      (each member's moves are sorted)
  - config-difference sensitive (item/ability/nature/moves/spread all feed the hash, so two builds that
                                 differ in any one of them get DIFFERENT ids — the 4 perish-song variants
                                 are 4 ids, not 1)
  - namespaced by season+format (the same 6 builds in single vs double, or M-2 vs M-3, are distinct ids;
                                 an id therefore maps to exactly one library file, so `show` self-locates)
"""
from __future__ import annotations

import hashlib
import json
from typing import Any

ID_VERSION = "v1"
ID_PREFIX = "t_"
_HEX_LEN = 10   # 40-bit content hash: ample for a few-thousand-team library, short enough to quote


def _member_fingerprint(m: dict[str, Any]) -> list[Any]:
    """The facts that make one build distinct, normalized order-independent. Presence-only members
    (no ability/item/moves) still fingerprint by species — the id must cover the WHOLE library, not
    only full-set teams (dedup.exact_template_key returns None for those; this never does)."""
    moves = sorted(x for x in (m.get("moves") or []) if x)
    spread = sorted((m.get("spread") or {}).items())
    return [
        m.get("species") or "",
        m.get("item") or "",
        m.get("ability") or "",
        m.get("nature") or "",
        moves,
        spread,
    ]


def compute_id_v1(team: dict[str, Any]) -> str:
    """Stable content id `t_<10 hex>` for a shipped team dict. Read-time only; see module docstring."""
    payload = [
        team.get("season") or "",
        team.get("format") or "",
        sorted((_member_fingerprint(m) for m in team.get("pokemon", [])), key=repr),
    ]
    blob = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha1(blob.encode("utf-8")).hexdigest()[:_HEX_LEN]
    return f"{ID_PREFIX}{digest}"


# Current-version alias so callers don't pin a version unless they mean to.
compute_id = compute_id_v1
