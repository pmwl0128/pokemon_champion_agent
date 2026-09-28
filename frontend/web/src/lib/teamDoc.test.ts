import { describe, expect, it } from "vitest";
import { memberBuildKey, toTeamDoc, toTeamMember, type TeamVocabulary } from "./teamDoc.ts";
import { membersFromPaste } from "./pasteMembers.ts";
import type { RuntimeAdapter } from "../runtime/adapter.ts";

const salamence = {
  species: " Mega Salamence ", item: "Salamencite", ability: "Aerilate", nature: "Adamant",
  moves: ["Double-Edge", "", "Dragon Dance", "Earthquake", "Roost"],
  spread: { hp: 1, atk: 32, def: 1, spe: 32, bogus: 9 },
};

describe("toTeamDoc", () => {
  it("normalises a loosely shaped team into the checked document", () => {
    const doc = toTeamDoc({ format: "single", pokemon: [salamence], extra: true });
    expect(doc).toEqual({
      schema_version: 1, format: "single", season: null, rule: null, provenance: null,
      pokemon: [{
        species: "Mega Salamence", item: "Salamencite", ability: "Aerilate", nature: "Adamant",
        moves: ["Double-Edge", "Dragon Dance", "Earthquake", "Roost"],
        spread: { hp: 1, atk: 32, def: 1, spe: 32 },
      }],
    });
  });

  it("keeps an unknown spread distinct from an all-zero one", () => {
    const doc = toTeamDoc({ format: "double", pokemon: [{ species: "Incineroar" }] });
    expect(doc?.pokemon[0]?.spread).toBeNull();
    expect(toTeamDoc({ format: "double", pokemon: [{ species: "Incineroar", sps: {} }] })
      ?.pokemon[0]?.spread).toEqual({});
  });

  it("takes the page's format only when the document has none", () => {
    expect(toTeamDoc({ pokemon: [salamence] }, "double")?.format).toBe("double");
    expect(toTeamDoc({ format: "single", pokemon: [salamence] }, "double")?.format).toBe("single");
    expect(toTeamDoc({ pokemon: [salamence] })).toBeNull();
  });

  it("rejects a document with nothing usable instead of storing half of it", () => {
    expect(toTeamDoc({ format: "single", pokemon: [{ item: "Leftovers" }] })).toBeNull();
    expect(toTeamDoc({ format: "single", pokemon: [] })).toBeNull();
    expect(toTeamDoc("Salamence @ Salamencite")).toBeNull();
  });

  it("rejects oversized teams instead of silently truncating them", () => {
    const doc = toTeamDoc({ format: "single", pokemon: Array.from({ length: 8 }, () => salamence) });
    expect(doc).toBeNull();
    expect(toTeamMember({ species: "Garchomp", spread: { atk: -1 } })).toBeNull();
    expect(toTeamMember({ species: "Garchomp", moves: ["A", "B", "C", "D", "E"] })).toBeNull();
  });
});

describe("memberBuildKey", () => {
  it("preserves unknown, partial and explicit-zero SP and supported foreign fields", () => {
    const raw = { species: "Garchomp", tera: "Fire", completeness: "observed_full_set" };
    const unknown = toTeamMember(raw)!;
    const partial = toTeamMember({ ...raw, spread: { hp: 0 } })!;
    const zero = toTeamMember({ ...raw, spread: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 } })!;
    expect(new Set([unknown, partial, zero].map(memberBuildKey)).size).toBe(3);
    expect(toTeamMember(JSON.parse(JSON.stringify(unknown)))).toEqual(unknown);
    expect(unknown).toMatchObject({ tera: "Fire", completeness: "observed_full_set" });
  });
  it("identifies the same build regardless of move order", () => {
    const a = toTeamMember({ species: "Garchomp", moves: ["Earthquake", "Protect"] })!;
    const b = toTeamMember({ species: "Garchomp", moves: ["Protect", "Earthquake"] })!;
    expect(memberBuildKey(a)).toBe(memberBuildKey(b));
  });

  it("separates different builds", () => {
    const base = toTeamMember(salamence)!;
    expect(memberBuildKey(base)).not.toBe(memberBuildKey(toTeamMember({ ...salamence, nature: "Jolly" })!));
    expect(memberBuildKey(base)).not.toBe(memberBuildKey(toTeamMember({ ...salamence, spread: { ...salamence.spread, spe: 20 } })!));
  });
});

describe("dex normalization at the shared entry", () => {
  const stats = { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 };
  const vocabulary: TeamVocabulary = {
    dex: [
      { key: "pokemon:charizard", slug: "charizard", name: "Charizard", nameZh: "喷火龙", nameJa: "リザードン",
        nationalDex: 6, stats, types: ["Fire", "Flying"], isMega: false, abilities: [{ name: "Blaze" }] },
      { key: "pokemon:mega-charizard-x", slug: "mega-charizard-x", name: "Mega Charizard X", nameZh: "超级喷火龙X",
        nationalDex: 6, stats, types: ["Fire", "Dragon"], isMega: true, baseSpecies: "Charizard", abilities: [{ name: "Tough Claws" }] },
    ],
    items: [{ key: "item:charizardite-x", name: "Charizardite X", nameZh: "喷火龙进化石Ｘ", requiredBy: ["Mega Charizard X"] }],
    abilities: [{ name: "Blaze", nameZh: "猛火" }, { name: "Tough Claws", nameZh: "硬爪" }],
    moves: [{ name: "Flamethrower", nameZh: "喷射火焰" }], natures: [{ name: "Jolly", nameJa: "ようき" }],
  };
  it("makes base plus stone, explicit Mega and calculator exports the same build", () => {
    const a = toTeamMember({ species: "喷火龙", item: "喷火龙进化石X", ability: "猛火", nature: "ようき", moves: ["喷射火焰"] }, vocabulary)!;
    const b = toTeamMember({ species: "Mega Charizard X", item: "Charizardite X", ability: "Tough Claws", nature: "Jolly", moves: ["Flamethrower"] }, vocabulary)!;
    const c = toTeamMember({ ...b, species: "Charizard" }, vocabulary)!;
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a).toMatchObject({ species: "Mega Charizard X", item: "Charizardite X", ability: "Tough Claws" });
    expect(toTeamDoc({ format: "single", pokemon: [a] }, undefined, vocabulary)?.pokemon).toEqual([a]);
  });
  it("rejects an unreadable member without silently accepting a partial team", () => {
    expect(toTeamDoc({ format: "single", pokemon: [{ species: "Charizard" }, { species: "unknown" }] }, undefined, vocabulary)).toBeNull();
    expect(toTeamMember({ species: "x".repeat(101) })).toBeNull();
  });
  it("accepts a base species with its Mega stone and Mega ability in pasted text", async () => {
    const result = await membersFromPaste("Charizard @ Charizardite X\nAbility: Tough Claws", {
      dex: vocabulary.dex, items: vocabulary.items, natures: [], adapter: {} as RuntimeAdapter,
    });
    expect(result.unresolved).toEqual([]);
    expect(result.members[0]?.member).toMatchObject({
      species: "Mega Charizard X", item: "Charizardite X", ability: "Tough Claws",
    });
    expect(result.members[0]?.entry.name).toBe("Mega Charizard X");
  });
});
