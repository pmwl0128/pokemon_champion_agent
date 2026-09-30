/** Speed projection of the same inferred joint options. Uses the speed-line engine and input
 * mapping, including stages, status, items, abilities and the current field on each side. */
import type { NatureDto, SpeedInputDto } from "@pokemon-champions/protocol";
import type { DexIndexEntry, RuntimeAdapter } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import type { FieldState, MonState } from "../duel/state.ts";
import { neutralNature, speedInputOf } from "../speed/lens.ts";
import type { FoeSpace, Inference } from "./model.ts";

export interface SpeedRange { nature: string; lo: number; hi: number; spHi: number }
export interface SpeedProjection { mine: number | null; ranges: SpeedRange[]; incomplete: boolean }
export interface SpeedPlan {
  inputs: SpeedInputDto[];
  mine: number | null;
  probes: Array<{ nature: string; lo: number; hi: number; spHi: number }>;
}

export function speedPlan(space: FoeSpace, inference: Inference, mine: MonState, foe: MonState,
  field: FieldState, dex: DexIndexEntry[], items: ItemRef[], natures: NatureDto[]): SpeedPlan {
  const inputs: SpeedInputDto[] = [], probes: SpeedPlan["probes"] = [];
  const positions = new Map<string, number>();
  const add = (input: SpeedInputDto | null) => {
    if (!input) return null;
    const key = JSON.stringify(input), previous = positions.get(key);
    if (previous !== undefined) return previous;
    positions.set(key, inputs.length); inputs.push(input);
    return inputs.length - 1;
  };
  const neutral = neutralNature(natures);
  const mineAt = add(speedInputOf(mine, field, "a", dex, items, neutral));
  const I = space.items.length, A = space.abilities.length;
  space.natures.forEach((nature, n) => space.items.forEach((item, i) => space.abilities.forEach((ability, a) => {
    const spHi = inference.speedCaps[(n * I + i) * A + a] ?? -1;
    if (spHi < 0) return;
    const input = (spe: number) => speedInputOf({ ...foe, nature: nature.name, item: item.name,
      ability: ability.name, sps: { spe } }, field, "b", dex, items, neutral);
    const lo = add(input(0)), hi = add(input(spHi));
    if (lo !== null && hi !== null) probes.push({ nature: nature.name, lo, hi, spHi });
  })));
  return { inputs, mine: mineAt, probes };
}

export async function readSpeedProjection(adapter: Pick<RuntimeAdapter, "speedBatch">, plan: SpeedPlan): Promise<SpeedProjection> {
  const chunks: SpeedInputDto[][] = [];
  for (let at = 0; at < plan.inputs.length; at += 240) chunks.push(plan.inputs.slice(at, at + 240));
  const results = (await Promise.all(chunks.map((inputs) => adapter.speedBatch(inputs)))).flat();
  const speed = (index: number | null) => index === null ? null
    : results[index] && "finalSpeed" in results[index] ? results[index].finalSpeed : null;
  const ranges = new Map<string, SpeedRange>();
  let incomplete = plan.mine !== null && speed(plan.mine) === null;
  for (const probe of plan.probes) {
    const lo = speed(probe.lo), hi = speed(probe.hi);
    if (lo === null || hi === null) { incomplete = true; continue; }
    const previous = ranges.get(probe.nature);
    ranges.set(probe.nature, { nature: probe.nature, lo: Math.min(lo, previous?.lo ?? lo),
      hi: Math.max(hi, previous?.hi ?? hi), spHi: Math.max(probe.spHi, previous?.spHi ?? 0) });
  }
  return { mine: speed(plan.mine), ranges: [...ranges.values()], incomplete };
}
