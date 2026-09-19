import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stashCalcTeams, takeCalcTeams, teamToCalcMembers } from "./team.ts";

const TEAM = {
  schema_version: 1,
  format: "double",
  pokemon: [
    { species: "Sneasler", item: "Grassy Seed", ability: "Unburden", nature: "Adamant",
      spread: { hp: 16, atk: 20, spe: 30 },
      moves: ["Close Combat", "Dire Claw", "Fake Out", "Protect"] },
    { species: "Mega Salamence", item: "Salamencite", ability: "Aerilate", nature: "Timid",
      spread: { hp: 2, spa: 32, spe: 32 },
      moves: ["Draco Meteor", "Hyper Voice", "Protect", "Tailwind"] },
    { species: "Rillaboom", item: "Miracle Seed", ability: "Grassy Surge", nature: "Adamant",
      spread: { hp: 17, atk: 25, def: 4, spd: 7, spe: 13 },
      moves: ["Fake Out", "Grassy Glide", "U-turn", "Wood Hammer"] },
    { species: "Kingambit", item: "Chople Berry", ability: "Defiant", nature: "Adamant",
      spread: { hp: 32, atk: 25, def: 2, spd: 5, spe: 2 },
      moves: ["Iron Head", "Kowtow Cleave", "Low Kick", "Sucker Punch"] },
    { species: "Floette-Eternal", item: "Floettite", ability: "Flower Veil", nature: "Modest",
      spread: { hp: 32, def: 13, spa: 5, spe: 16 },
      moves: ["Calm Mind", "Dazzling Gleam", "Moonblast", "Protect"] },
    { species: "Farigiraf", item: "Sitrus Berry", ability: "Armor Tail", nature: "Relaxed",
      spread: { hp: 27, def: 20, spd: 19 },
      moves: ["Trick Room", "Helping Hand", "Psychic", "Protect"] },
  ],
};

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
});

afterEach(() => vi.unstubAllGlobals());

test("builder team hand-off keeps canonical species members for the calculator", () => {
  stashCalcTeams({ format: "double", attackers: teamToCalcMembers(TEAM), defenders: [] });

  const fill = takeCalcTeams();

  expect(fill?.format).toBe("double");
  expect(fill?.attackers).toHaveLength(6);
  expect(fill?.attackers.map((member) => member.species)).toEqual(
    TEAM.pokemon.map((member) => member.species));
  expect(fill?.attackers[0]).toMatchObject({
    species: "Sneasler", item: "Grassy Seed", ability: "Unburden",
    nature: "Adamant", sps: { hp: 16, atk: 20, spe: 30 },
    moves: ["Close Combat", "Dire Claw", "Fake Out", "Protect"], pinned: true,
  });
});
