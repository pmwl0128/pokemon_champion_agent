#!/usr/bin/env python
"""The one canonical content hash the receipt chain uses for "the same content".

Shared so frame's frame_receipt, slate's slate_receipt, and the answer-audit bait-and-switch check can
never drift to different hashing — a change here changes all three together, by construction (they used
to hold byte-identical copies). Leaf module: depends only on the stdlib, so any operator can import it.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def content_hash(obj: Any, n: int = 16) -> str:
    """sha256 of the canonical JSON (sorted keys, non-ASCII preserved, non-JSON coerced via str),
    truncated to `n` hex chars. THE notion of content identity for receipts."""
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False,
                                     default=str).encode("utf-8")).hexdigest()[:n]
