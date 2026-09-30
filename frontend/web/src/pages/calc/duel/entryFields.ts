/** Resolve simultaneous field-setting abilities once, above all four calculator tools. */
import type { SpeedInputDto, Terrain, Weather } from "@pokemon-champions/protocol";
import { withMega } from "../../../components/build/inputs.tsx";
import type { DexIndexEntry, RuntimeAdapter } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { speedInputOf } from "../speed/lens.ts";
import { TERRAIN_ABILITIES, WEATHER_ABILITIES, type FieldState, type MonState, type SideId } from "./state.ts";

export interface FieldSource<V extends string> {
  side: SideId;
  uid: string;
  ability: string;
  value: V;
}
export interface FieldResolution<V extends string> {
  source: FieldSource<V> | null;
  reason: "none" | "single" | "last" | "tie" | "unavailable";
}
export interface EntryFields {
  weather: FieldResolution<Weather>;
  terrain: FieldResolution<Terrain>;
}
export interface EntryFieldPlan {
  weather: { sources: FieldSource<Weather>[]; key: string };
  terrain: { sources: FieldSource<Terrain>[]; key: string };
  inputs: [SpeedInputDto | null, SpeedInputDto | null];
  trickRoom: boolean;
}

const needsComparison = <V extends string,>(sources: FieldSource<V>[]) => sources.length === 2;

export function entryFieldPlan(teams: Record<SideId, MonState[]>, active: Record<SideId, number>,
  field: FieldState, dex: DexIndexEntry[], items: ItemRef[], neutral: string): EntryFieldPlan {
  const sides = ["a", "b"] as const;
  const mons = sides.map((side) => teams[side][active[side]]);
  const sources = <V extends string,>(table: Record<string, V>): FieldSource<V>[] =>
    sides.flatMap((side, index) => {
      const mon = mons[index];
      if (!mon) return [];
      const { state, entry } = withMega(mon, dex, items);
      const value = entry && state.ability ? table[state.ability] : undefined;
      return value ? [{ side, uid: mon.uid, ability: state.ability, value }] : [];
    });
  const weather = sources(WEATHER_ABILITIES), terrain = sources(TERRAIN_ABILITIES);
  // Setters do not have weather/terrain speed abilities. Keep the comparison independent of the
  // field they are about to set (and of manual picker changes), but retain stages/status/items
  // including Choice Scarf, and each side's Tailwind. Trick Room reverses the resulting order.
  const compareField = { ...field, weather: "" as const, terrain: "" as const };
  const needsSpeed = needsComparison(weather) || needsComparison(terrain);
  const inputs = sides.map((side, index) => needsSpeed && mons[index]
    ? speedInputOf(mons[index]!, compareField, side, dex, items, neutral) : null) as EntryFieldPlan["inputs"];
  const channel = <V extends string,>(list: FieldSource<V>[]) => ({ sources: list,
    key: JSON.stringify([list, needsComparison(list) ? [inputs, field.trickRoom] : null]) });
  return { weather: channel(weather), terrain: channel(terrain), inputs, trickRoom: field.trickRoom };
}

export function resolveField<V extends string>(sources: FieldSource<V>[],
  speeds?: readonly [number | null, number | null], trickRoom = false): FieldResolution<V> {
  if (!sources.length) return { source: null, reason: "none" };
  if (sources.length === 1) return { source: sources[0]!, reason: "single" };
  const a = speeds?.[0], b = speeds?.[1];
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) {
    return { source: null, reason: "unavailable" };
  }
  if (a === b) return { source: null, reason: "tie" };
  const last = trickRoom ? (a > b ? "a" : "b") : (a < b ? "a" : "b");
  return { source: sources.find((source) => source.side === last)!, reason: "last" };
}

export async function resolveEntryFields(adapter: Pick<RuntimeAdapter, "speedBatch">,
  plan: EntryFieldPlan): Promise<EntryFields> {
  let speeds: [number | null, number | null] | undefined;
  if (needsComparison(plan.weather.sources) || needsComparison(plan.terrain.sources)) {
    const [a, b] = plan.inputs;
    if (a && b) {
      try {
        const out = await adapter.speedBatch([a, b]);
        speeds = [0, 1].map((index) => {
          const row = out[index];
          return row && "finalSpeed" in row ? row.finalSpeed : null;
        }) as [number | null, number | null];
      } catch { /* A failed speed comparison leaves only the conflicting channel unchanged. */ }
    }
  }
  return { weather: resolveField(plan.weather.sources, speeds, plan.trickRoom),
    terrain: resolveField(plan.terrain.sources, speeds, plan.trickRoom) };
}

/** Missing sources or an unresolved tie leave the existing field alone; a no-op keeps identity. */
export function applyEntryFields(field: FieldState, choices: Partial<EntryFields>): FieldState {
  const weather = choices.weather?.source?.value ?? field.weather;
  const terrain = choices.terrain?.source?.value ?? field.terrain;
  return weather === field.weather && terrain === field.terrain ? field : { ...field, weather, terrain };
}
