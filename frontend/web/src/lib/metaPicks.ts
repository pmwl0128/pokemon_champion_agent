/** What a reader has ticked on a metagame detail page, and the rules for ticking it.
 *
 * The page is a set of usage panels, each a ranked list of the things people actually run. Picking
 * across them assembles one concrete question — "this ability, this spread, these four moves,
 * against these opponents" — which is exactly the shape the calculator takes. The caps are the
 * calculator's own: four move slots, and six mons a side (this Pokemon plus five partners on one
 * side, six KO opponents on the other).
 *
 * Nothing here is a claim about the metagame: a panel's leader is the most-used option, not the
 * option that goes with the others. That is why picking is an act the reader performs rather than a
 * default the page applies (dev/design.md §8 on stitched sets). */
import type { SpSpread } from "@pokemon-champions/protocol";

export interface MetaPicks {
  ability: string | null;
  item: string | null;
  nature: string | null;
  spread: SpSpread | null;
  moves: string[];
  /** Partner slugs — they join this Pokemon on the attacking side. */
  partners: string[];
  /** Opponent slugs from BOTH KO panels, sharing one budget: they are one defending team, and
   * whether a name got there by knocking this Pokemon out or by being knocked out does not make it
   * two rosters. */
  ko: string[];
}

export const NO_PICKS: MetaPicks = {
  ability: null, item: null, nature: null, spread: null, moves: [], partners: [], ko: [],
};

/** The calculator's own limits, which is why they are what the page enforces. */
export const PICK_LIMITS = { moves: 4, partners: 5, ko: 6 } as const;

/** Click the picked one again to clear it. */
export function toggleOne<T>(current: T | null, value: T, same: (a: T, b: T) => boolean
  = (a, b) => a === b): T | null {
  return current !== null && same(current, value) ? null : value;
}

/** Add until the cap, and always allow removal — a full list must never be a stuck list. */
export function toggleMany(list: string[], value: string, limit: number): string[] {
  if (list.includes(value)) return list.filter((x) => x !== value);
  return list.length >= limit ? list : [...list, value];
}

export function countPicks(picks: MetaPicks): number {
  return (picks.ability ? 1 : 0) + (picks.item ? 1 : 0) + (picks.nature ? 1 : 0)
    + (picks.spread ? 1 : 0) + picks.moves.length + picks.partners.length + picks.ko.length;
}

/** Stable identity for an SP spread, used both as a React key and to compare picks. */
export function spreadKey(spread: SpSpread): string {
  return ["hp", "atk", "def", "spa", "spd", "spe"]
    .map((key) => spread[key as keyof SpSpread] ?? 0).join("/");
}
