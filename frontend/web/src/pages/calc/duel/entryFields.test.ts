import { expect, test, vi } from "vitest";
import type { SpeedInputDto, SpeedlineDto } from "@pokemon-champions/protocol";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { applyEntryFields, entryFieldPlan, resolveEntryFields, resolveField } from "./entryFields.ts";
import { EMPTY_FIELD, makeMon, type FieldState } from "./state.ts";

const entry = (name: string, ability: string, spe: number): DexIndexEntry => ({
  key: `pokemon:${name}`, slug: name.toLowerCase(), name, nationalDex: 1, types: ["Water"],
  stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe }, abilities: [{ name: ability }], isMega: false,
});
const dex = [entry("Pelipper", "Drizzle", 65), entry("Torkoal", "Drought", 20),
  entry("Rillaboom", "Grassy Surge", 85), entry("Indeedee", "Psychic Surge", 85)];
const mon = (slug: string, ability: string) => ({ ...makeMon(slug), ability, pinned: true });
const field = (): FieldState => ({ ...EMPTY_FIELD, sides: { a: {}, b: {} } });
const plan = (a = mon("pelipper", "Drizzle"), b = mon("torkoal", "Drought"), f = field()) =>
  entryFieldPlan({ a: [a], b: [b] }, { a: 0, b: 0 }, f, dex, [], "Serious");
const result = (finalSpeed: number) => ({ finalSpeed }) as SpeedlineDto;

test("one weather setter and one terrain setter apply independently without a speed request", async () => {
  const speedBatch = vi.fn(async () => []);
  const p = plan(mon("pelipper", "Drizzle"), mon("rillaboom", "Grassy Surge"));
  const resolved = await resolveEntryFields({ speedBatch }, p);
  expect(speedBatch).not.toHaveBeenCalled();
  const original = field();
  const next = applyEntryFields(original, resolved);
  expect([next.weather, next.terrain]).toEqual(["Rain", "Grassy"]);
  expect(next.sides).toBe(original.sides);
  expect(applyEntryFields(next, resolved)).toBe(next);
});

test("the later-acting setter wins in normal and Trick Room order for both field kinds", async () => {
  const f = { ...field(), terrain: "Electric" as const };
  const p = plan(undefined, undefined, f);
  const speedBatch = vi.fn(async (_inputs: SpeedInputDto[]) => [result(85), result(40)]);
  const resolved = await resolveEntryFields({ speedBatch }, p);
  expect(speedBatch).toHaveBeenCalledTimes(1);
  expect(speedBatch.mock.calls[0]?.[0]).toEqual(p.inputs);
  expect(resolved.weather.source?.ability).toBe("Drought");
  expect(applyEntryFields(f, resolved).weather).toBe("Sun");
  expect(applyEntryFields(f, resolved).terrain).toBe("Electric");
  const reversed = await resolveEntryFields({ speedBatch: async () => [result(30), result(40)] }, p);
  expect(reversed.weather.source?.ability).toBe("Drizzle");
  const room = await resolveEntryFields({ speedBatch }, plan(undefined, undefined, { ...f, trickRoom: true }));
  expect(room.weather.source?.ability).toBe("Drizzle");

  const terrain = plan(mon("rillaboom", "Grassy Surge"), mon("indeedee", "Psychic Surge"));
  const selected = await resolveEntryFields({ speedBatch: async () => [result(90), result(100)] }, terrain);
  expect(selected.terrain.source?.ability).toBe("Grassy Surge");
  expect(selected.weather.reason).toBe("none");
  const roomTerrain = await resolveEntryFields({ speedBatch: async () => [result(90), result(100)] },
    { ...terrain, trickRoom: true });
  expect(roomTerrain.terrain.source?.ability).toBe("Psychic Surge");
});

test("equal final speeds do not randomly select or apply, including identical setter effects", () => {
  const p = plan(), f = { ...field(), weather: "Snow" as const };
  const tied = resolveField(p.weather.sources, [80, 80]);
  expect(tied).toEqual({ source: null, reason: "tie" });
  expect(resolveField(p.weather.sources, [80, 80], true)).toEqual(tied);
  expect(applyEntryFields(f, { weather: tied })).toBe(f);
  const identical = plan(mon("pelipper", "Drizzle"), mon("pelipper", "Drizzle"));
  expect(resolveField(identical.weather.sources, [80, 80]).reason).toBe("tie");
  expect(resolveField(identical.weather.sources, [90, 80]).source?.side).toBe("b");
});

test("manual field edits, move edits and irrelevant SP never invalidate entry automation", () => {
  const a = mon("pelipper", "Drizzle"), b = mon("torkoal", "Drought");
  const original = plan(a, b);
  const changed = plan({ ...a, moves: ["Surf", "", "", ""], sps: { hp: 32 } }, b,
    { ...field(), weather: "Sand", terrain: "Psychic", gravity: true });
  expect(changed.weather.key).toBe(original.weather.key);
  expect(changed.terrain.key).toBe(original.terrain.key);
  const other = mon("rillaboom", "Grassy Surge");
  const single = plan(a, other);
  const speedOnly = plan({ ...a, sps: { spe: 32 } }, other, { ...field(), trickRoom: true });
  expect(speedOnly.weather.key).toBe(single.weather.key);
  expect(speedOnly.terrain.key).toBe(single.terrain.key);
});

test("a pair is re-evaluated for speed SP, nature, item, stage, status, Tailwind and Trick Room", () => {
  const a = mon("pelipper", "Drizzle"), b = mon("torkoal", "Drought");
  const original = plan(a, b);
  for (const change of [{ sps: { spe: 1 } }, { nature: "Timid" }, { item: "Choice Scarf" },
    { boosts: { spe: 1 } }, { status: "par" }]) {
    expect(plan({ ...a, ...change }, b).weather.key).not.toBe(original.weather.key);
  }
  const windy = plan(a, b, { ...field(), sides: { a: { tailwind: true }, b: {} } });
  expect(windy.weather.key).not.toBe(original.weather.key);
  expect(windy.inputs[0]?.field?.tailwind).toBe(true);
  expect(windy.inputs[0]?.nature).toBe("Serious");
  expect(windy.inputs[0]?.sps?.spe).toBe(0);
  const scarf = plan({ ...a, item: "Choice Scarf" }, b);
  expect(scarf.inputs[0]?.item).toBe("Choice Scarf");
  const room = plan(a, b, { ...field(), trickRoom: true });
  expect(room.weather.key).not.toBe(original.weather.key);
  expect(room.trickRoom).toBe(true);
});

test("only active effective forms provide setters; benched and replaced base abilities do not", () => {
  const base = entry("Charizard", "Blaze", 100);
  const mega = { ...entry("Mega Charizard Y", "Drought", 100), slug: "mega-charizard-y", isMega: true,
    baseSpecies: "Charizard" };
  const stone: ItemRef = { key: "item:charizardite-y", name: "Charizardite Y", category: "mega_stone",
    requiredBy: ["Mega Charizard Y"] };
  const held = { ...mon("charizard", "Blaze"), item: "Charizardite Y" };
  const teams = { a: [held, mon("pelipper", "Drizzle")], b: [mon("rillaboom", "Grassy Surge")] };
  const p = entryFieldPlan(teams, { a: 0, b: 0 }, field(), [...dex, base, mega], [stone], "Serious");
  expect(p.weather.sources.map((s) => s.ability)).toEqual(["Drought"]);
  expect(p.terrain.sources.map((s) => s.ability)).toEqual(["Grassy Surge"]);
  const benched = entryFieldPlan(teams, { a: 1, b: 0 }, field(), [...dex, base, mega], [stone], "Serious");
  expect(benched.weather.sources.map((s) => s.ability)).toEqual(["Drizzle"]);
});

test("missing or failed speed results leave a conflicting field unchanged; no setters never clear it", async () => {
  const f = { ...field(), weather: "Snow" as const };
  for (const speedBatch of [async () => [], async () => [result(80)],
    async () => { throw new Error("speed unavailable"); }]) {
    const unresolved = await resolveEntryFields({ speedBatch }, plan());
    expect(unresolved.weather.reason).toBe("unavailable");
    expect(applyEntryFields(f, unresolved)).toBe(f);
  }
  expect(applyEntryFields(f, { weather: resolveField([]) })).toBe(f);
});
