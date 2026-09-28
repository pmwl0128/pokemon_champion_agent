import { describe, expect, it } from "vitest";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { makeMon, withMoves } from "./duel/state.ts";
import { sideTeamDoc } from "./LibraryTransfers.tsx";

const dex = [{ slug: "garchomp", name: "Garchomp" }] as DexIndexEntry[];

describe("sideTeamDoc", () => {
  it("keeps what was picked, as canonical names, and drops empty slots", () => {
    const garchomp = { ...withMoves(makeMon("garchomp"), ["Earthquake", ""]), item: "Choice Scarf", sps: { atk: 32 } };
    expect(sideTeamDoc([garchomp, makeMon()], "double", dex)?.pokemon).toEqual([{
      species: "Garchomp", item: "Choice Scarf", ability: null, nature: null, moves: ["Earthquake"],
      spread: { atk: 32 },
    }]);
  });

  it("has nothing to keep for a side with no Pokémon", () => {
    expect(sideTeamDoc([makeMon()], "single", dex)).toBeNull();
  });
});
