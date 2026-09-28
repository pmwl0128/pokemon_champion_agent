import type { OppSetCatalogDto, OppSetDto, RankingDto } from "@pokemon-champions/protocol";
import { describe, expect, it } from "vitest";
import { realSetsFor } from "./realSets.ts";
import { usageDelta } from "./usageDelta.ts";
import { usageSlug } from "./metaUsage.ts";

it("connects dex species to the ranking's own slug for both apostrophe names", () => {
  const ranking = { rows: [{ name: "Farfetch'd", slug: "farfetch-d" },
    { name: "Sirfetch'd", slug: "sirfetch-d" }] } as RankingDto;
  expect(usageSlug(ranking, "Farfetch'd")).toBe("farfetch-d");
  expect(usageSlug(ranking, "Sirfetch'd")).toBe("sirfetch-d");
  expect(usageSlug(ranking, "Missing")).toBe("");
});

describe("usageDelta", () => {
  it("compares the last period with the first one of the window", () => {
    expect(usageDelta([53.4, 52.0, 51.3, 47.5])).toEqual({ kind: "down", value: 5.9, minor: false });
    expect(usageDelta([10.8, 11.0, 13.9])).toEqual({ kind: "up", value: 3.1, minor: false });
  });

  it("reports an entry that was outside the top 10 at the start as new, not as a gain", () => {
    expect(usageDelta([null, null, 0.3, 0.4])).toEqual({ kind: "new" });
  });

  it("marks a change below the threshold as minor instead of hiding it", () => {
    expect(usageDelta([99.4, 99.1])).toEqual({ kind: "down", value: 0.3, minor: true });
  });

  it("stays silent without a change or without a current value", () => {
    expect(usageDelta([12.4, 12.4])).toEqual({ kind: "none" });
    expect(usageDelta([4.2, null])).toEqual({ kind: "none" });
    expect(usageDelta([4.2])).toEqual({ kind: "none" });
    expect(usageDelta(undefined)).toEqual({ kind: "none" });
  });
});

const set = (patch: Partial<OppSetDto>): OppSetDto => ({
  species: "Salamence", runForm: null, moves: ["Double-Edge"], sps: { atk: 32, spe: 32 }, ...patch,
});

describe("realSetsFor", () => {
  const catalog: OppSetCatalogDto = {
    format: "single",
    species: [
      { rank: 1, slug: "salamence", name: "Salamence", realTeamBacked: true, variants: [
        { key: "v:b", isModal: false }, { key: "v:a", isModal: true }, { key: "v:c", isModal: false },
      ] },
      { rank: 2, slug: "garchomp", name: "Garchomp", realTeamBacked: false, variants: [
        { key: "v:g", isModal: true },
      ] },
    ],
    sets: {
      "v:a": set({ item: "Salamencite" }),
      "v:b": set({ item: "Haban Berry" }),
      "v:c": set({ moves: null }),
      "v:g": set({ species: "Garchomp" }),
    },
  };

  it("puts the modal build first and drops rows without a joint move set", () => {
    expect(realSetsFor(catalog, "Salamence").map((r) => r.key)).toEqual(["v:a", "v:b"]);
  });

  it("offers nothing for a species that is not backed by real teams", () => {
    expect(realSetsFor(catalog, "Garchomp")).toEqual([]);
    expect(realSetsFor(catalog, "Dragonite")).toEqual([]);
  });
});
