import { expect, test } from "vitest";
import type { NatureDto, SpeedInputDto, SpeedlineDto } from "@pokemon-champions/protocol";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import { EMPTY_FIELD, makeMon } from "../duel/state.ts";
import { infer, type FoeSpace } from "./model.ts";
import { readSpeedProjection, speedPlan, type SpeedPlan } from "./speed.ts";

const stats = { hp: 90, atk: 130, def: 90, spa: 80, spd: 90, spe: 90 };
const dex: DexIndexEntry[] = [{ key: "pokemon:garchomp", slug: "garchomp", name: "Garchomp",
  nationalDex: 445, types: ["Dragon", "Ground"], stats, abilities: [{ name: "Rough Skin" }], isMega: false }];
const natures: NatureDto[] = [{ name: "Adamant", upStat: "atk", downStat: "spa" },
  { name: "Jolly", upStat: "spe", downStat: "spa" }];
const space: FoeSpace = { base: stats, natures: natures.map((nature) => ({ name: nature.name,
  prior: .5, mult: { atk: nature.name === "Adamant" ? 1.1 : 1, def: 1, spa: .9, spd: 1 } })),
  items: [{ name: "Life Orb", prior: 1 }], abilities: [{ name: "Rough Skin", prior: 1 }] };

test("speed probes use only surviving inference options and their joint budget, without mutating the shared roster", () => {
  const inference = infer(space, [{ kind: "offense", key: "atk", before: 100, after: 90,
    rolls: (_item, _ability, mult, sp) => mult > 1 && sp === 32 ? [10] : [50] }])!;
  const mine = { ...makeMon("garchomp"), nature: "Jolly", sps: { spe: 21 }, boosts: { spe: 1 }, status: "Paralyzed" };
  const foe = { ...makeMon("garchomp"), nature: "Quiet", item: "Choice Scarf", sps: { atk: 32, spe: 32 }, boosts: { spe: -1 } };
  const field = { ...EMPTY_FIELD, weather: "Rain" as const, sides: { a: { tailwind: true }, b: {} } };
  const before = JSON.stringify({ mine, foe, field });
  const plan = speedPlan(space, inference, mine, foe, field, dex, [], natures);
  expect(plan.probes).toEqual([{ nature: "Adamant", lo: 1, hi: 2, spHi: 32 }]);
  expect(plan.inputs[plan.mine!]).toMatchObject({ nature: "Jolly", sps: { spe: 21 }, boosts: { spe: 1 },
    status: "Paralyzed", field: { weather: "Rain", tailwind: true } });
  expect(plan.inputs.slice(1)).toEqual([0, 32].map((spe) => ({ name: "Garchomp", nature: "Adamant",
    ability: "Rough Skin", item: "Life Orb", sps: { spe }, boosts: { spe: -1 }, field: { weather: "Rain" } })));
  expect(JSON.stringify({ mine, foe, field })).toBe(before);
});

const output = (input: SpeedInputDto, speed: number): SpeedlineDto => ({ name: input.name, types: ["Dragon"],
  baseSpeed: 90, nature: input.nature ?? "Serious", speedSPs: input.sps?.spe ?? 0, speedIV: 31,
  speedBoost: 0, rawSpeed: speed, boostedSpeed: speed, finalSpeed: speed });

test("speed batches respect the protocol limit, preserve indexes and combine only same-nature bounds", async () => {
  const inputs = Array.from({ length: 481 }, (_, index) => ({ name: String(index) }));
  const plan: SpeedPlan = { inputs, mine: 480, probes: [{ nature: "Adamant", lo: 0, hi: 239, spHi: 2 },
    { nature: "Adamant", lo: 240, hi: 479, spHi: 32 }] };
  const sizes: number[] = [];
  const result = await readSpeedProjection({ speedBatch: async (batch) => {
    sizes.push(batch.length); return batch.map((input) => output(input, Number(input.name)));
  } }, plan);
  expect(sizes).toEqual([240, 240, 1]);
  expect(result).toEqual({ mine: 480, incomplete: false,
    ranges: [{ nature: "Adamant", lo: 0, hi: 479, spHi: 32 }] });
});

test("a missing foe endpoint or current-player speed marks the projection incomplete", async () => {
  const input: SpeedInputDto = { name: "Garchomp" };
  const plan: SpeedPlan = { inputs: [input, input], mine: 0,
    probes: [{ nature: "Adamant", lo: 0, hi: 1, spHi: 32 }] };
  expect((await readSpeedProjection({ speedBatch: async () => [output(input, 100)] }, plan)).incomplete).toBe(true);
  expect((await readSpeedProjection({ speedBatch: async () => [] }, { ...plan, probes: [] })).incomplete).toBe(true);
});
