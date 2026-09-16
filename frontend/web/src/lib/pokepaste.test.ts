import { describe, expect, it } from "vitest";
import { formatPokepasteMon, parsePokepaste } from "./pokepaste.ts";

describe("parsePokepaste", () => {
  it("reads a Champions export verbatim, SP scale untouched", () => {
    const result = parsePokepaste([
      "Garchomp @ Life Orb",
      "Ability: Rough Skin",
      "Jolly Nature",
      "SPs: 32 Atk / 2 Def / 32 Spe",
      "- Earthquake",
      "- Dragon Claw",
    ].join("\n"));
    expect(result.rescaledEvs).toBe(false);
    expect(result.mons).toHaveLength(1);
    expect(result.mons[0]).toMatchObject({
      species: "Garchomp",
      item: "Life Orb",
      ability: "Rough Skin",
      nature: "Jolly",
      sps: { atk: 32, def: 2, spe: 32 },
      moves: ["Earthquake", "Dragon Claw"],
    });
  });

  it("rescales a mainline EV spread onto the 66-point budget and says so", () => {
    const result = parsePokepaste([
      "Rillaboom @ Miracle Seed",
      "EVs: 252 Atk / 4 Def / 252 HP",
      "- Wood Hammer",
    ].join("\n"));
    // 252 -> the 32 cap, 4 -> 1: the same "all-in / leftover" shape, inside the 66 budget.
    expect(result.mons[0]!.sps).toEqual({ atk: 32, def: 1, hp: 32 });
    expect(result.rescaledEvs).toBe(true);
  });

  it("keeps each member of a multi-mon paste separate", () => {
    const result = parsePokepaste([
      "Incineroar @ Sitrus Berry", "Ability: Intimidate", "- Fake Out", "",
      "Amoonguss @ Rocky Helmet", "Ability: Regenerator", "- Spore",
    ].join("\n"));
    expect(result.mons.map((m) => m.species)).toEqual(["Incineroar", "Amoonguss"]);
    expect(result.mons[1]!.moves).toEqual(["Spore"]);
  });

  it("separates a nickname, a gender tag and the species", () => {
    const result = parsePokepaste("Chompy (Garchomp) (M) @ Focus Sash\n- Earthquake");
    expect(result.mons[0]).toMatchObject({
      nickname: "Chompy", species: "Garchomp", item: "Focus Sash",
    });
  });

  it("treats a bare gender tag as gender, not as a species", () => {
    const result = parsePokepaste("Garchomp (F) @ Life Orb");
    expect(result.mons[0]!.species).toBe("Garchomp");
  });

  it("drops the mainline-only lines Champions has no equivalent for", () => {
    const result = parsePokepaste([
      "Garchomp", "Level: 50", "Shiny: Yes", "Tera Type: Fire",
      "IVs: 0 Atk", "- Earthquake",
    ].join("\n"));
    expect(result.mons[0]!.sps).toEqual({});
    expect(result.mons[0]!.moves).toEqual(["Earthquake"]);
  });

  it("keeps non-English names verbatim for the dex to resolve", () => {
    const result = parsePokepaste("烈咬陆鲨 @ 讲究围巾\n- 地震");
    expect(result.mons[0]).toMatchObject({ species: "烈咬陆鲨", item: "讲究围巾" });
    expect(result.mons[0]!.moves).toEqual(["地震"]);
  });

  it("caps a member at four moves", () => {
    const result = parsePokepaste(
      "Garchomp\n- A\n- B\n- C\n- D\n- E");
    expect(result.mons[0]!.moves).toEqual(["A", "B", "C", "D"]);
  });

  it("returns no members for text that holds no team", () => {
    expect(parsePokepaste("   \n\n  ").mons).toEqual([]);
  });

  it("round-trips its own export", () => {
    const mon = {
      species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly",
      sps: { atk: 32, spe: 32, hp: 2 }, moves: ["Earthquake", "Dragon Claw"],
    };
    const back = parsePokepaste(formatPokepasteMon(mon)).mons[0]!;
    expect(back).toMatchObject({
      species: "Garchomp", item: "Life Orb", ability: "Rough Skin", nature: "Jolly",
      moves: ["Earthquake", "Dragon Claw"],
    });
    expect(back.sps).toEqual({ hp: 2, atk: 32, spe: 32 });
  });
});
