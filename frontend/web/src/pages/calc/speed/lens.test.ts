import { expect, test } from "vitest";
import type { NatureDto } from "@pokemon-champions/protocol";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { EMPTY_FIELD, makeMon, type FieldState } from "../duel/state.ts";
import {
  applyTier, offenseOf, speedInputOf, speedNature, spToBeat, tierOf,
} from "./lens.ts";

type Stat = NonNullable<NatureDto["upStat"]>;
const nature = (name: string, up: Stat | null, down: Stat | null): NatureDto =>
  ({ name, upStat: up, downStat: down });
const NATURES: NatureDto[] = [
  nature("Hardy", "atk", "atk"), nature("Serious", "spe", "spe"),
  nature("Lonely", "atk", "def"), nature("Brave", "atk", "spe"), nature("Adamant", "atk", "spa"),
  nature("Bold", "def", "atk"), nature("Relaxed", "def", "spe"), nature("Impish", "def", "spa"),
  nature("Timid", "spe", "atk"), nature("Hasty", "spe", "def"), nature("Jolly", "spe", "spa"),
  nature("Modest", "spa", "atk"), nature("Quiet", "spa", "spe"),
  nature("Calm", "spd", "atk"), nature("Sassy", "spd", "spe"), nature("Careful", "spd", "spa"),
];

const stats = (atk: number, spa: number) => ({ hp: 90, atk, def: 90, spa, spd: 90, spe: 90 });
const entry = (name: string, slug: string, extra: Partial<DexIndexEntry> = {}): DexIndexEntry => ({
  key: `pokemon:${slug}`, slug, name, nationalDex: 1, types: ["Dragon"], stats: stats(130, 80),
  abilities: [{ name: "Rough Skin" }], isMega: false, ...extra,
});
const garchomp = entry("Garchomp", "garchomp");
const megaSalamence = entry("Mega Salamence", "mega-salamence",
  { isMega: true, baseSpecies: "Salamence", abilities: [{ name: "Aerilate" }] });
const salamence = entry("Salamence", "salamence", { abilities: [{ name: "Intimidate" }] });
const sneasler = entry("Sneasler", "sneasler", { abilities: [{ name: "Unburden" }] });
const dex = [garchomp, salamence, megaSalamence, sneasler];
const items: ItemRef[] = [{ key: "item:salamencite", name: "Salamencite",
  requiredBy: ["Mega Salamence"], category: "mega_stone" }];
const field = (over: Partial<FieldState> = {}): FieldState => ({ ...EMPTY_FIELD, sides: { a: {}, b: {} }, ...over });

test("a speed preset rewrites only the Speed half of the nature", () => {
  const cases: Array<[string, string, string, string]> = [
    // current      +          0            -
    ["Adamant", "Jolly", "Adamant", "Brave"],
    ["Jolly", "Jolly", "Adamant", "Brave"],
    ["Careful", "Jolly", "Careful", "Sassy"],
    ["Hasty", "Hasty", "Lonely", "Brave"],
    ["Brave", "Jolly", "Adamant", "Brave"],
    ["", "Jolly", "Serious", "Brave"],
  ];
  for (const [current, plus, zero, minus] of cases) {
    expect(speedNature(NATURES, current, "+", "atk"), `${current} +`).toBe(plus);
    expect(speedNature(NATURES, current, "0", "atk"), `${current} 0`).toBe(zero);
    expect(speedNature(NATURES, current, "-", "atk"), `${current} -`).toBe(minus);
  }
  expect(speedNature(NATURES, "Modest", "+", "spa")).toBe("Timid");
  expect(speedNature(NATURES, "Bold", "-", "spa")).toBe("Relaxed");
});

test("the attacking side is read from the moves, then from base stats", () => {
  const category = (move: string) => ({ Earthquake: "Physical", "Draco Meteor": "Special",
    Flamethrower: "Special" } as Record<string, string>)[move];
  const mon = { ...makeMon("garchomp"), moves: ["Draco Meteor", "Flamethrower", "Earthquake", ""] };
  expect(offenseOf(mon, garchomp, category)).toBe("spa");
  expect(offenseOf(makeMon("garchomp"), garchomp, category)).toBe("atk");
});

test("tiers are nature direction plus Speed SP", () => {
  const mon = applyTier({ ...makeMon("garchomp"), nature: "Adamant", sps: { atk: 32, spe: 2 } },
    "max", NATURES, "atk");
  expect(mon.nature).toBe("Jolly");
  expect(mon.sps).toEqual({ atk: 32, spe: 32 });
  expect(tierOf(NATURES, mon)).toBe("max");
  expect(tierOf(NATURES, { ...mon, sps: { spe: 31 } })).toBeNull();
});

test("the speed input never falls back to the engine's Timid / 32 SP defaults", () => {
  const input = speedInputOf(makeMon("garchomp"), field(), "a", dex, items, "Serious");
  expect(input).toMatchObject({ name: "Garchomp", nature: "Serious", sps: { spe: 0 } });
  expect(input).not.toHaveProperty("field");
});

test("weather and terrain are field-wide, Tailwind belongs to the Pokémon's side", () => {
  const f = field({ weather: "Rain", terrain: "Electric", sides: { a: { tailwind: true }, b: {} } });
  const mon = { ...makeMon("garchomp"), nature: "Jolly", sps: { spe: 32 } };
  expect(speedInputOf(mon, f, "a", dex, items, "Serious")?.field)
    .toEqual({ weather: "Rain", terrain: "Electric", tailwind: true });
  expect(speedInputOf(mon, f, "b", dex, items, "Serious")?.field)
    .toEqual({ weather: "Rain", terrain: "Electric" });
  expect(speedInputOf(mon, f, null, dex, items, "Serious")?.field)
    .toEqual({ weather: "Rain", terrain: "Electric" });
});

test("a held stone computes the Mega form", () => {
  const mon = { ...makeMon("salamence"), item: "Salamencite", nature: "Timid", sps: { spe: 32 } };
  expect(speedInputOf(mon, field(), "a", dex, items, "Serious"))
    .toMatchObject({ name: "Mega Salamence", ability: "Aerilate", item: "Salamencite" });
});

test("Unburden counts only once it has fired", () => {
  const base = { ...makeMon("sneasler"), ability: "Unburden", nature: "Jolly", sps: { spe: 32 } };
  const holding = speedInputOf({ ...base, item: "Grassy Seed" }, field(), "a", dex, items, "Serious");
  expect(holding).toMatchObject({ ability: "Unburden", item: "Grassy Seed" });
  // No item typed yet is not a consumed item: the engine would double it.
  const blank = speedInputOf(base, field(), "a", dex, items, "Serious");
  expect(blank).not.toHaveProperty("ability");
  const fired = speedInputOf({ ...base, item: "Grassy Seed", abilityOn: true }, field(), "a", dex,
    items, "Serious");
  expect(fired).toMatchObject({ ability: "Unburden" });
  expect(fired).not.toHaveProperty("item");
});

test("the SP to move first is read off the curve, both ways round", () => {
  const curve = [100, 101, 102, 103, 104];
  expect(spToBeat(curve, 101, false)).toBe(2);
  expect(spToBeat(curve, 104, false)).toBeNull();
  expect(spToBeat(curve, 103, true)).toBe(2);
  expect(spToBeat(curve, 100, true)).toBeNull();
});
