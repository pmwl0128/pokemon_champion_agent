import type { DexIndexEntry } from "../runtime/adapter.ts";
import type { ItemRef } from "../runtime/projection.ts";

/** Slug and name lookups over one dex / item list, built once per list. These run for every mon on
 * every render of the calculator pages; a linear `find` over a thousand-entry dex each time was a
 * measurable share of opening a tab. First match wins, as `find` did. */
const dexLookups = new WeakMap<readonly DexIndexEntry[], { bySlug: Map<string, DexIndexEntry>; byName: Map<string, DexIndexEntry> }>();
const itemLookups = new WeakMap<readonly ItemRef[], Map<string, ItemRef>>();

export function dexLookup(dex: readonly DexIndexEntry[]) {
  let hit = dexLookups.get(dex);
  if (!hit) {
    hit = { bySlug: new Map(), byName: new Map() };
    for (const entry of dex) {
      if (!hit.bySlug.has(entry.slug)) hit.bySlug.set(entry.slug, entry);
      if (!hit.byName.has(entry.name)) hit.byName.set(entry.name, entry);
    }
    dexLookups.set(dex, hit);
  }
  return hit;
}

export function itemLookup(items: readonly ItemRef[]): Map<string, ItemRef> {
  let hit = itemLookups.get(items);
  if (!hit) {
    hit = new Map();
    for (const item of items) if (!hit.has(item.name)) hit.set(item.name, item);
    itemLookups.set(items, hit);
  }
  return hit;
}

/** The Mega form this side's held stone unlocks for its species, or null. The engine does
 * NOT auto-mega on a held stone (measured: Garchomp+Garchompite still computes base-102
 * Speed), so the tabs substitute the Mega form themselves and badge the sprite. */
export function megaFor(slug: string, item: string, dex: DexIndexEntry[],
                        items: ItemRef[]): DexIndexEntry | null {
  if (!slug || !item) return null;
  const { bySlug, byName } = dexLookup(dex);
  const base = bySlug.get(slug);
  const target = itemLookup(items).get(item)?.requiredBy?.[0];
  if (!base || !target) return null;
  const mega = byName.get(target);
  return mega && mega.isMega && mega.baseSpecies === base.name ? mega : null;
}
