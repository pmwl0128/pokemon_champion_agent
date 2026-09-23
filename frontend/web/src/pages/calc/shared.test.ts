import { expect, test } from "vitest";
import type { OppSetCatalogDto } from "@pokemon-champions/protocol";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import type { ItemRef } from "../../runtime/projection.ts";
import {
  buildConfigSig, modalForEntry, observedBuildOptions, sideFromBuild, sideIsBare,
  withMega, type ModalSet,
} from "./shared.tsx";
import { buildCardOptionForMon } from "./duel/MonEditor.tsx";
import { applyBuildOption, makeMon, rollModifier } from "./duel/state.ts";

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

test("observed build choices are complete and ordered by real-team share", () => {
  const catalog: OppSetCatalogDto = {
    format: "single",
    species: [{
      rank: 1, slug: "garchomp", name: "Garchomp", realTeamBacked: true,
      variants: [
        { key: "lower", item: "Leftovers", ability: "Rough Skin", isModal: true, coverage: 0.3 },
        { key: "higher", item: "Life Orb", ability: "Rough Skin", isModal: false, coverage: 0.7 },
      ],
    }],
    sets: {
      lower: { species: "Garchomp", runForm: null, item: "Leftovers", ability: "Rough Skin",
        nature: "Jolly", moves: ["Earthquake"], sps: { hp: 32 }, coverage: 0.3 },
      higher: { species: "Garchomp", runForm: null, item: "Life Orb", ability: "Rough Skin",
        nature: "Adamant", moves: ["Earthquake", "Dragon Claw"], sps: { atk: 32, spe: 32 }, coverage: 0.7 },
    },
  };
  const choices = observedBuildOptions(catalog, "garchomp", dex, items);
  expect(choices.map((choice) => choice.key)).toEqual(["higher", "lower"]);
  expect(choices[0]?.modal).toEqual({
    ability: "Rough Skin", item: "Life Orb", nature: "Adamant",
    moves: ["Earthquake", "Dragon Claw"], sps: { atk: 32, spe: 32 },
  });
});

test("roll slider indices expose the actual 85 through 100 modifiers", () => {
  expect(Array.from({ length: 16 }, (_, index) => rollModifier(index))).toEqual(
    Array.from({ length: 16 }, (_, index) => 85 + index));
});

test("build-card identity is exact but ignores battle-only state", () => {
  const modal: ModalSet = {
    ability: "Rough Skin", item: "Life Orb", nature: "Jolly",
    sps: { hp: 2, atk: 32, spe: 32 }, moves: ["Earthquake", "Dragon Claw"],
  };
  expect(buildConfigSig(modal)).toBe(buildConfigSig({
    ...modal, moves: ["Earthquake", "Dragon Claw", "", ""],
  }));
  expect(buildConfigSig(modal)).not.toBe(buildConfigSig({
    ...modal, moves: ["Earthquake", "Dragon Claw", "Protect"],
  }));
  expect(buildConfigSig(modal)).not.toBe(buildConfigSig({
    ...modal, sps: { hp: 2, atk: 31, spe: 32 },
  }));
});

test("calculator hover keeps an exact environment-card label and drops it after an edit", () => {
  const mon = {
    ...makeMon("garchomp"), ability: "Rough Skin", item: "Life Orb", nature: "Jolly",
    sps: { hp: 2, atk: 32, spe: 32 }, moves: ["Earthquake", "Dragon Claw", "", ""],
  };
  const signature = buildConfigSig(mon);
  const exact = {
    ...mon,
    buildRef: {
      key: "garchomp:life-orb", source: "aggregate" as const, coverage: 0.22,
      isModal: false, labelIndex: 1, signature,
    },
  };
  expect(buildCardOptionForMon(exact, garchomp, dex)).toMatchObject({
    source: "aggregate", coverage: 0.22, labelIndex: 1,
  });
  expect(buildCardOptionForMon(
    { ...exact, sps: { ...exact.sps, atk: 31 } }, garchomp, dex,
  ).source).toBe("custom");
});

test("an explicit environment-card pick is not marked as an automatic seed", () => {
  const option = {
    key: "garchomp:scarf", source: "aggregate" as const, coverage: 0.24, isModal: false,
    modal: {
      ability: "Rough Skin", item: "Choice Scarf", nature: "Adamant",
      sps: { hp: 2, atk: 32, spe: 32 }, moves: ["Earthquake", "Dragon Claw"],
    },
    set: {
      species: "Garchomp", runForm: null, ability: "Rough Skin", item: "Choice Scarf",
      nature: "Adamant", sps: { hp: 2, atk: 32, spe: 32 },
      moves: ["Earthquake", "Dragon Claw"], coverage: 0.24,
    },
  };
  const manual = applyBuildOption(makeMon("garchomp"), option, 1);
  const automatic = applyBuildOption(makeMon("garchomp"), option, 1, true);

  expect(manual.autoSig).toBeNull();
  expect(manual.buildRef).toMatchObject({ key: option.key, labelIndex: 1 });
  expect(automatic.autoSig).not.toBeNull();
});

test("drawer Custom and environment sides stay explicit across background auto-fill", () => {
  const custom = sideFromBuild("garchomp", null);
  expect(custom).toMatchObject({ slug: "garchomp", ability: "", item: "", pinned: true });
  expect(sideIsBare(custom)).toBe(false);

  const option = {
    key: "garchomp:orb", source: "aggregate" as const, coverage: 0.3, isModal: true,
    modal: {
      ability: "Rough Skin", item: "Life Orb", nature: "Jolly",
      sps: { atk: 32, spe: 32 }, moves: ["Earthquake"],
    },
    set: {
      species: "Garchomp", runForm: null, ability: "Rough Skin", item: "Life Orb",
      nature: "Jolly", sps: { atk: 32, spe: 32 }, moves: ["Earthquake"],
    },
  };
  expect(sideFromBuild("garchomp", option)).toMatchObject({
    slug: "garchomp", ability: "Rough Skin", item: "Life Orb",
    nature: "Jolly", sps: { atk: 32, spe: 32 }, pinned: true,
  });
});
