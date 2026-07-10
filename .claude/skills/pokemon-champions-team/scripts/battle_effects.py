"""Small shared battle-mechanic constants + arithmetic used by multiple team operators."""

from math import ceil


def ko_hits_from_pct(pct: float | None) -> int | None:
    """N-hit KO count from a per-hit damage percent — ceil(100/pct). The single source for the plain
    (non-recovery, per-hit-independent) KO-bucket arithmetic shared by `matchup._ko_buckets` and the
    `checks` Intimidate rescale, so the two never drift (oppcache's Disguise `turns()` is a DIFFERENT
    formula — 1 + ceil(87.5/pct) — and is intentionally not folded in here)."""
    return ceil(100.0 / pct) if isinstance(pct, (int, float)) and pct > 0 else None


# Intimidate does not produce a -1 Attack relief against these abilities. This mirrors the
# vendored calculator's checkIntimidate handler: some merely BLOCK the drop (net 0), some BACKFIRE
# (the target ends a net +Attack), and Mirror Armor REFLECTS the drop back onto our own member.
INTIMIDATE_NO_RELIEF_ABILITIES = {
    "clear body",
    "contrary",
    "defiant",
    "full metal body",
    "guard dog",
    "hyper cutter",
    "inner focus",
    "mirror armor",
    "oblivious",
    "own tempo",
    "scrappy",
    "white smoke",
}
# Of the no-relief set, these turn Intimidate into a NET +Attack for the target (Contrary/Guard Dog
# reverse it to +1; Defiant lets the drop land then answers with +2, netting +1) — not merely "blocked".
INTIMIDATE_BACKFIRE_ABILITIES = {"contrary", "defiant", "guard dog"}
# Mirror Armor bounces the -1 back onto the intimidating member (us): the foe is unaffected, we take it.
INTIMIDATE_REFLECT_ABILITIES = {"mirror armor"}

INTIMIDATE_BLOCKING_ITEMS = {"clear amulet"}
