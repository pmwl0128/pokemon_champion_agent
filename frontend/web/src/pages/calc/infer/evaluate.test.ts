import { describe, expect, it } from "vitest";
import type { DamageRequestDto } from "@pokemon-champions/protocol";
import { EMPTY_FIELD, makeMon } from "../duel/state.ts";
import { requestKey, type Rolls } from "../tune/model.ts";
import { bulkRequest, frameOf, hitRequests, offenseRequest, survivesAtOne, type Observation, type RequestKit } from "./context.ts";
import { evaluateInference, type InferenceJob } from "./evaluate.ts";
import type { FoeSpace } from "./model.ts";

const kit: RequestKit = {
  dex: ["Attacker", "Defender"].map((name) => ({ name, slug: name.toLowerCase(), key: `pokemon:${name.toLowerCase()}`,
    nationalDex: 1, types: ["Normal"], isMega: false, abilities: [{ name: "Sturdy" }],
    stats: { hp: 100, atk: 100, def: 100, spa: 100, spd: 100, spe: 100 } })),
  items: [], natures: [{ name: "Hardy", upStat: null, downStat: null }],
};
const mine = { ...makeMon("attacker"), nature: "Hardy", item: "Life Orb", moves: ["Tackle"], curHP: 87 };
const foe = { ...makeMon("defender"), nature: "Hardy", ability: "Sturdy", moves: ["Tackle"] };
const space: FoeSpace = { base: kit.dex[1]!.stats,
  natures: [{ name: "Hardy", prior: 1, mult: { atk: 1, def: 1, spa: 1, spd: 1 } }],
  items: [{ name: "Occa Berry", prior: 1 }], abilities: [{ name: "Sturdy", prior: 1 }] };
const observation = (id: string, kind: "bulk" | "offense", after: number): Observation => ({
  id, kind, foeId: foe.uid, mineId: mine.uid, move: "Tackle", before: 100, after, enabled: true,
  field: structuredClone(EMPTY_FIELD), crit: false, singleTarget: false,
  mineBoosts: {}, foeBoosts: {}, mineStatus: "", foeStatus: "",
  mineSnapshot: structuredClone(mine), foeSnapshot: structuredClone(foe),
});
const result = (damage: number, multiHit = false): Rolls => ({ damage: [damage], min: damage, max: damage,
  defenderHP: 100, minPercent: damage, maxPercent: damage, category: "Physical", multiHit });

function job(observations: Observation[], value: (request: DamageRequestDto) => Rolls): InferenceJob {
  const recorded: InferenceJob["recorded"] = observations.map((o) => ({ observation: o,
    frame: frameOf(o, mine, foe), key: o.kind === "bulk" ? "def" : "atk" }));
  const rolls = new Map<string, Rolls>();
  for (const record of recorded) for (const req of hitRequests(record.frame,
    { kind: record.observation.kind, key: record.key },
    { items: ["Occa Berry"], abilities: ["Sturdy"], mults: { atk: [1], def: [1], spa: [1], spd: [1] } }, kit)) {
    rolls.set(requestKey(req), value(req));
  }
  return { kit, mine, foe, info: { space, pruned: false, itemChoices: [], abilityChoices: [] },
    field: EMPTY_FIELD, moves: new Map(), recorded, skipped: new Set(), liveMoves: { into: [], from: [] },
    realSets: [], candidates: [], current: { item: "", ability: "", nature: "", sps: {} }, detail: null, rolls };
}

describe("inference job contracts", () => {
  it("excludes an individually impossible observation but retains mutually conflicting ones", () => {
    const invalid = evaluateInference(job([observation("bad", "offense", 99)], () => result(20)));
    expect(invalid.impossible.has("bad")).toBe(true);
    expect(invalid.inference?.count).toBe(invalid.prior?.count);
    const conflict = evaluateInference(job([observation("a", "offense", 80), observation("b", "offense", 60)],
      (req) => result((req.attacker.sps?.atk ?? 0) < 16 ? 20 : 40)));
    expect(conflict.impossible.size).toBe(0);
    expect(conflict.inference?.count).toBe(0);
    expect(conflict.loading).toBe(false);
  });
  it("skips unsupported multi-hit data and engine refusals", () => {
    const input = job([observation("multi", "bulk", 50)], () => result(20, true));
    expect(evaluateInference(input).skipped.has("multi")).toBe(true);
    input.rolls = new Map([...input.rolls.keys()].map((key) => [key, null]));
    expect(evaluateInference(input).skipped.has("multi")).toBe(true);
  });
  it("freezes our item, spread, HP and field; passes every defensive and offensive item to the engine", () => {
    const saved = observation("hit", "bulk", 50);
    const frame = frameOf(saved, { ...mine, item: "", sps: { atk: 32 }, curHP: null }, foe);
    expect(frame.mine).toMatchObject({ item: "Life Orb", curHP: 87, sps: mine.sps });
    for (const item of ["Occa Berry", "Focus Sash", "Leftovers"]) {
      expect(bulkRequest(frame, "def", "Sturdy", 1, 0, kit, item)?.defender.item).toBe(item);
      expect(offenseRequest(frame, "atk", item, "Sturdy", 1, 0, kit)?.attacker.item).toBe(item);
    }
  });
  it("censors Sash/Sturdy survival and honours ability bypass", () => {
    const breaker = { ...mine, ability: "Mold Breaker" };
    expect(survivesAtOne(breaker, foe, "Tackle", "", "Sturdy", kit)).toBe(false);
    expect(survivesAtOne({ ...breaker, abilityOn: false }, foe, "Tackle", "", "Sturdy", kit)).toBe(true);
    expect(survivesAtOne(breaker, foe, "Tackle", "Focus Sash", "Sturdy", kit)).toBe(true);
    expect(survivesAtOne(mine, foe, "Tackle", "", "Sturdy", kit)).toBe(true);
  });
});
