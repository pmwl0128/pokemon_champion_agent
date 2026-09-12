import { expect, test } from "vitest";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import type { ItemRef } from "../../runtime/projection.ts";
import { modalForEntry, withMega, type ModalSet } from "./shared.tsx";

const stats = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
const entry = (name: string, slug: string, ability: string,
               mega = false, baseSpecies?: string): DexIndexEntry => ({
  key: `pokemon:${slug}`, slug, name, nationalDex: 1, types: ["Dragon"], stats,
  abilities: [{ name: ability }], isMega: mega, ...(baseSpecies ? { baseSpecies } : {}),
});
const item = (name: string, slug: string, requiredBy: string[]): ItemRef => ({
  key: `item:${slug}`, name, requiredBy, category: "mega_stone",
});

const garchomp = entry("Garchomp", "garchomp", "Rough Skin");
const megaGarchompZ = entry(
  "Mega Garchomp Z", "mega-garchomp-z", "Sand Force", true, "Garchomp");
const megaSalamence = entry(
  "Mega Salamence", "mega-salamence", "Aerilate", true, "Salamence");
const items = [item("Garchompite Z", "garchompite-z", ["Mega Garchomp Z"]),
  item("Salamencite", "salamencite", ["Mega Salamence"])];
const dex = [garchomp, megaGarchompZ, megaSalamence];

test("engine-facing Mega state always uses the active form and its legal ability", () => {
  const heldStone = withMega(
    { slug: "garchomp", item: "Garchompite Z", ability: "Rough Skin" }, dex, items);
  expect(heldStone.entry?.name).toBe("Mega Garchomp Z");
  expect(heldStone.state.ability).toBe("Sand Force");
  expect(heldStone.mega).toBe(true);

  const explicit = withMega(
    { slug: "mega-salamence", item: "Salamencite", ability: "Intimidate" }, dex, items);
  expect(explicit.entry?.name).toBe("Mega Salamence");
  expect(explicit.state.ability).toBe("Aerilate");
  expect(explicit.mega).toBe(true);
});

test("base-species modal fallback cannot overwrite an explicit Mega form ability", () => {
  const inherited: ModalSet = {
    ability: "Intimidate", item: "Leftovers", nature: "Modest", sps: { spa: 32 },
    moves: ["Hyper Voice"],
  };
  expect(modalForEntry(inherited, megaSalamence, items[1])).toEqual({
    ...inherited, ability: "Aerilate", item: "Salamencite",
  });
});
