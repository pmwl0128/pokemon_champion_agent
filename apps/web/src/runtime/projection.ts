/** Static-projection data both runtimes share (dex browse index, learnsets, calculator
 * vocab). These are dex facts — identical on local and online — so they never go through
 * the adapter; pages import them directly. Cached per session. */
import {
  AbilityDtoSchema, ItemDtoSchema, LearnsetDtoSchema, NatureDtoSchema,
  type AbilityDto, type ItemDto, type LearnsetDto, type NatureDto,
} from "@pokemon-champions/protocol";
import { z } from "zod";
import { AsyncOnce, fetchJson, versionParam } from "./adapter.ts";

let base = "/projection";
export function configureProjection(projectionBase: string): void {
  base = projectionBase;
}

const learnsetCache = new Map<string, Promise<LearnsetDto>>();
export function loadLearnset(slug: string): Promise<LearnsetDto> {
  let hit = learnsetCache.get(slug);
  if (!hit) {
    hit = fetchJson(`${base}/dex/learnset/${slug}.json${versionParam()}`).then((d) =>
      LearnsetDtoSchema.parse(d));
    // Drop a rejected fetch so a transient failure retries next time instead of caching the
    // rejection for the session.
    hit.catch(() => { if (learnsetCache.get(slug) === hit) learnsetCache.delete(slug); });
    learnsetCache.set(slug, hit);
  }
  return hit;
}

/** Global move vocab (the full moves table at projection build): trilingual name +
 * type/category for prose entity rendering, plus battle numbers and trilingual effect
 * texts for the dex browse tab. Lenient shape — older projections lack the extras. */
export interface MoveRef {
  name: string;
  nameZh?: string;
  nameJa?: string;
  type: string;
  category: string;
  power?: number | null;
  accuracy?: number | null;
  pp?: number | null;
  priority?: number;
  effect?: string;
  effectZh?: string;
  effectJa?: string;
}
const MovesFile = z.object({
  moves: z.array(z.object({
    name: z.string(),
    nameZh: z.string().optional(),
    nameJa: z.string().optional(),
    type: z.string(),
    category: z.string(),
    power: z.number().nullable().optional(),
    accuracy: z.number().nullable().optional(),
    pp: z.number().nullable().optional(),
    priority: z.number().optional(),
    effect: z.string().optional(),
    effectZh: z.string().optional(),
    effectJa: z.string().optional(),
  }).loose()),
});
const movesOnce = new AsyncOnce<MoveRef[]>();
export function loadMoves(): Promise<MoveRef[]> {
  return movesOnce.get(() =>
    fetchJson(`${base}/dex/moves.json${versionParam()}`).then((d) => MovesFile.parse(d).moves));
}

const NaturesFile = z.object({ natures: z.array(NatureDtoSchema) });
const naturesOnce = new AsyncOnce<NatureDto[]>();
export function loadNatures(): Promise<NatureDto[]> {
  return naturesOnce.get(() =>
    fetchJson(`${base}/dex/natures.json${versionParam()}`).then((d) => NaturesFile.parse(d).natures));
}

const ItemsFile = z.object({ items: z.array(ItemDtoSchema) });
export type ItemRef = ItemDto;
const itemsOnce = new AsyncOnce<ItemRef[]>();
export function loadItems(): Promise<ItemRef[]> {
  return itemsOnce.get(() =>
    fetchJson(`${base}/dex/items.json${versionParam()}`).then((d) => ItemsFile.parse(d).items));
}

const AbilitiesFile = z.object({ abilities: z.array(AbilityDtoSchema) });
export type AbilityRef = AbilityDto;
const abilitiesOnce = new AsyncOnce<AbilityRef[]>();
export function loadAbilities(): Promise<AbilityRef[]> {
  return abilitiesOnce.get(() =>
    fetchJson(`${base}/dex/abilities.json${versionParam()}`).then((d) =>
      AbilitiesFile.parse(d).abilities));
}
