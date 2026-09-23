import { expect, test } from "vitest";
import type { TuneCardDto } from "@pokemon-champions/protocol";
import { lanesOf, rollSurvival, survival, type Rolls } from "./model.ts";

const rolls = (damage: number[], defenderHP: number): Rolls => ({
  damage, defenderHP, min: damage[0]!, max: damage.at(-1)!, minPercent: 0, maxPercent: 0,
  category: "Physical",
});

test("one-hit survival counts rolls strictly below max HP", () => {
  // A roll equal to max HP is a KO, not a survival.
  const value = survival(rolls([90, 95, 100, 105], 100), 1);
  expect(value).toEqual({ alive: 2, total: 4, probability: 0.5 });
});

test("two-hit survival enumerates independent roll pairs", () => {
  const sample = rolls([40, 50, 60], 100);
  // Pairs summing below 100: (40,40) (40,50) (50,40) — 3 of 9.
  expect(survival(sample, 2)).toEqual({ alive: 3, total: 9, probability: 3 / 9 });
  // Per first roll: 40 survives 2/3 second rolls, 50 survives 1/3, 60 none.
  expect(rollSurvival(sample, 2)).toEqual([2 / 3, 1 / 3, 0]);
});

test("allocation lanes become absolute spreads over the solved-from base", () => {
  const card = {
    aspect: "defense", kind: "survive", member: "Garchomp", vs: "Mimikyu", result: "cliff", note: "",
    allocation_lanes: [
      { lane: "def", result: "cliff", delta_sp: 14, need_total: 14 },
      { lane: "mixed", stat: "hp+def", result: "cliff", delta_sp: 12,
        allocation: { hp: { current: 2, need_total: 5, delta_sp: 3 },
                      def: { current: 0, need_total: 9, delta_sp: 9 } } },
      { lane: "hp", result: "unreachable", delta_sp: 33 },
    ],
  } as TuneCardDto;
  const base = { hp: 2, atk: 32, spe: 32 };
  const lanes = lanesOf(card, base);
  // The unreachable lane names no total, so there is nothing to apply.
  expect(lanes.map((lane) => lane.kind)).toEqual(["def", "mixed"]);
  expect(lanes[0]!.spread).toEqual({ hp: 2, atk: 32, spe: 32, def: 14 });
  expect(lanes[1]!.spread).toEqual({ hp: 5, atk: 32, spe: 32, def: 9 });
  expect(lanes[1]!.changed).toEqual([{ stat: "hp", from: 2, to: 5 }, { stat: "def", from: 0, to: 9 }]);
});
