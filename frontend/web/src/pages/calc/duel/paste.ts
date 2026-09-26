/** Pokepaste → roster Pokémon, shared by every calc tool's import.
 *
 * Species go through the dex the page already holds first, then ONE resolver call for whatever is
 * left (a fuzzy or alias spelling is exactly what `resolve` is for; per-name round trips are not).
 * Items, abilities, natures and moves match the local vocabularies in any of the three languages;
 * anything unrecognised is reported back rather than guessed. */
import type { LearnsetDto, NatureDto } from "@pokemon-champions/protocol";
import { parsePokepaste } from "../../../lib/pokepaste.ts";
import type { DexIndexEntry, RuntimeAdapter } from "../../../runtime/adapter.ts";
import { loadLearnset, type ItemRef } from "../../../runtime/projection.ts";
import { TEAM_MAX, type ImportOutcome } from "./TeamBar.tsx";
import { makeMon, withMoves, type MonState } from "./state.ts";

export function matchLocal<T extends { name: string; nameZh?: string; nameJa?: string }>(
  pool: T[], raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  const q = raw.trim();
  if (!q) return undefined;
  const lower = q.toLowerCase();
  return pool.find((x) => x.name.toLowerCase() === lower || x.nameZh === q || x.nameJa === q)
    ?? pool.find((x) => x.name.toLowerCase().replace(/[\s'’.-]/g, "")
      === lower.replace(/[\s'’.-]/g, ""));
}

export async function monsFromPaste(text: string, context: {
  dex: DexIndexEntry[];
  items: ItemRef[];
  natures: NatureDto[];
  adapter: RuntimeAdapter;
  /** Pin the imported builds against the environment auto-fill. */
  pin?: boolean;
}): Promise<{ mons: MonState[]; outcome: ImportOutcome }> {
  const { dex, items, natures, adapter, pin = false } = context;
  const { mons: pasted, rescaledEvs } = parsePokepaste(text);
  if (!pasted.length) return { mons: [], outcome: { added: 0, unresolved: [], rescaledEvs } };

  const resolved = new Map<string, DexIndexEntry>();
  const misses: string[] = [];
  for (const p of pasted) {
    const local = matchLocal(dex, p.species)
      ?? dex.find((e) => e.slug === p.species.trim().toLowerCase());
    if (local) resolved.set(p.species, local);
    else misses.push(p.species);
  }
  if (misses.length) {
    try {
      const entries = await adapter.resolve(misses, "pokemon");
      entries.forEach((entry, i) => {
        const hit = entry.ok && entry.canonical
          ? dex.find((e) => e.name === entry.canonical) : undefined;
        if (hit) resolved.set(misses[i]!, hit);
      });
    } catch (e) {
      console.error("pokepaste species resolution failed:", e);
    }
  }

  const unresolved: string[] = [];
  const mons: MonState[] = [];
  for (const p of pasted.slice(0, TEAM_MAX)) {
    const entry = resolved.get(p.species);
    if (!entry) { unresolved.push(p.species); continue; }
    const next = makeMon(entry.slug);
    next.sps = { ...p.sps };
    if (pin) next.pinned = true;
    const item = matchLocal(items, p.item);
    if (item) next.item = item.name;
    else if (p.item) unresolved.push(p.item);
    const ability = matchLocal(entry.abilities, p.ability);
    if (ability) next.ability = ability.name;
    else if (p.ability) unresolved.push(p.ability);
    const nature = matchLocal(natures, p.nature);
    if (nature) next.nature = nature.name;
    else if (p.nature) unresolved.push(p.nature);
    if (p.moves.length) {
      let pool: LearnsetDto["moves"] = [];
      try {
        pool = (await loadLearnset(entry.slug)).moves;
      } catch (e) {
        console.error(`learnset load failed for ${entry.slug}:`, e);
      }
      const names: string[] = [];
      for (const raw of p.moves) {
        const hit = matchLocal(pool, raw);
        if (hit) names.push(hit.name);
        else unresolved.push(raw);
      }
      next.moves = withMoves(next, names).moves;
    }
    mons.push(next);
  }
  return { mons, outcome: { added: mons.length, unresolved, rescaledEvs } };
}
