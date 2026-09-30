import { describe, expect, it } from "vitest";
import {
  foeRollFits, hpShownAs, infer, mineRollFits, shownPercent, nearestSurviving, spreadSurvives,
  SP_KEYS, type Evidence, type FoeSpace, type Mult,
} from "./model.ts";
import { actualStat } from "../../../lib/stats.ts";

describe("the in-game HP percentage", () => {
  it("maps every displayed value back to exactly the HP values that print it", () => {
    for (let max = 60; max <= 260; max++) {
      for (let p = 0; p <= 100; p++) {
        const range = hpShownAs(p, max);
        const printing = Array.from({ length: max + 1 }, (_, hp) => hp)
          .filter((hp) => shownPercent(hp, max) === p);
        if (!printing.length) expect(range).toBeNull();
        else expect(range).toEqual([printing[0], printing[printing.length - 1]]);
      }
    }
  });

  it("floors, keeps a standing Pokémon at 1% at least, and reserves 100% for full HP", () => {
    expect(shownPercent(183, 183)).toBe(100);
    expect(shownPercent(182, 183)).toBe(99);
    expect(shownPercent(1, 183)).toBe(1);
    expect(shownPercent(0, 183)).toBe(0);
  });

  it("reads a hit on them through the display and a hit on us exactly", () => {
    // 183 HP: 100% -> 41% leaves 76 or 77 HP (41.5% / 42.0% floor to 41 and 42), so 107 fits, 105 not.
    expect(foeRollFits(107, 183, 100, 41)).toBe(true);
    expect(foeRollFits(105, 183, 100, 41)).toBe(false);
    expect(foeRollFits(200, 183, 100, 0)).toBe(true);
    expect(mineRollFits(98, 185, 87)).toBe(true);
    expect(mineRollFits(97, 185, 87)).toBe(false);
    expect(mineRollFits(190, 185, 0)).toBe(true);
  });
});

// A synthetic engine: damage falls with the defending stat and rises with the attacking one, so the
// inference can be checked against a build whose observations are generated from its own rolls.
const BASE = { hp: 108, atk: 130, def: 95, spa: 80, spd: 85 };
const rollsFrom = (center: number) => Array.from({ length: 16 }, (_, i) => Math.floor(center * (85 + i) / 100));
const statOf = (key: "atk" | "def" | "spa" | "spd", sp: number, mult: Mult) => actualStat(BASE[key], key, sp, mult);
const bulkRolls = (ability: string, mult: Mult, sp: number) =>
  rollsFrom(24000 / statOf("def", sp, mult) * (ability === "Fur Coat" ? 0.5 : 1));
const offRolls = (item: string, _ability: string, mult: Mult, sp: number) =>
  rollsFrom(statOf("atk", sp, mult) * (item === "Life Orb" ? 1.3 : 1) * 0.8);

const SPACE: FoeSpace = {
  base: BASE,
  natures: [
    { name: "Jolly", prior: 0.4, mult: { atk: 1, def: 1, spa: 0.9, spd: 1 } },
    { name: "Adamant", prior: 0.4, mult: { atk: 1.1, def: 1, spa: 0.9, spd: 1 } },
    { name: "Impish", prior: 0.2, mult: { atk: 1, def: 1.1, spa: 0.9, spd: 1 } },
  ],
  items: [{ name: "Life Orb", prior: 0.5 }, { name: "Focus Sash", prior: 0.5 }],
  abilities: [{ name: "Rough Skin", prior: 1 }],
};

describe("inference over the joint state", () => {
  it("never rules out the build that produced the observations", () => {
    // Truth: Adamant, Life Orb, 20 HP / 32 Atk / 6 Def.
    const hpMax = actualStat(BASE.hp, "hp", 20, 1);
    const hit = bulkRolls("Rough Skin", 1, 6)[9]!;
    const after = shownPercent(hpMax - hit, hpMax);
    const taken = offRolls("Life Orb", "Rough Skin", 1.1, 32)[4]!;
    const evidence: Evidence[] = [
      { kind: "bulk", key: "def", before: 100, after, rolls: bulkRolls },
      { kind: "offense", key: "atk", before: 185, after: 185 - taken, rolls: offRolls },
    ];
    const result = infer(SPACE, evidence)!;
    const adamant = SPACE.natures.findIndex((nature) => nature.name === "Adamant");
    expect(result.natures[adamant]).toBe(true);
    expect(result.bulkProj.def[adamant * 2]![20 * 33 + 6]).toBe(1);
    expect(result.offProj.atk[(adamant * 2 + 0) * 1 + 0]![32]).toBe(1);
    expect(result.stats.hp.lo).toBeLessThanOrEqual(20);
    expect(result.stats.hp.hi).toBeGreaterThanOrEqual(20);
    const prior = infer(SPACE, [])!;
    expect(result.count).toBeGreaterThan(0);
    expect(result.count).toBeLessThan(prior.count);
  });

  it("applies the 66-point budget across offense and bulk", () => {
    // Heavy bulk (a small hit) plus maximal offense cannot both hold within 66 SP.
    const hpMax = actualStat(BASE.hp, "hp", 32, 1);
    const smallest = bulkRolls("Rough Skin", 1.1, 32)[0]!;
    const taken = offRolls("Focus Sash", "Rough Skin", 1.1, 32)[15]!;
    const evidence: Evidence[] = [
      { kind: "bulk", key: "def", before: 100, after: shownPercent(hpMax - smallest, hpMax), rolls: bulkRolls },
      { kind: "offense", key: "atk", before: 400, after: 400 - taken, rolls: offRolls },
    ];
    const result = infer(SPACE, evidence)!;
    const budget = result.stats.hp.lo + result.stats.def.lo + result.stats.atk.lo;
    expect(result.count === 0 || budget <= 66).toBe(true);
  });

  it("stays pending while any roll it needs is missing", () => {
    const evidence: Evidence[] = [
      { kind: "bulk", key: "def", before: 100, after: 50, rolls: () => undefined },
    ];
    expect(infer(SPACE, evidence)).toBeNull();
  });
});

describe("budgeted weighted marginals", () => {
  const space: FoeSpace = { ...SPACE, natures: [SPACE.natures[0]!],
    items: [{ name: "plain", prior: 0.7 }, { name: "berry", prior: 0.3 }] };
  it("marginalizes the complete unconstrained joint space", () => {
    const result = infer({ ...space, items: [space.items[0]!] }, [])!;
    expect(result.count).toBe(10510209);
    expect(result.stats.hp.mass[32]).toBeCloseTo(0.11305749, 7);
    expect(result.natureShares).toEqual([1]);
  });
  it("matches independently enumerated nature weights across all budget-compatible joint builds", () => {
    const joint: FoeSpace = { ...space, natures: SPACE.natures,
      abilities: [{ name: "Rough Skin", prior: 0.6 }, { name: "Fur Coat", prior: 0.4 }] };
    const bulk = (ability: string, mult: Mult, sp: number, item: string) => {
      if (sp !== 0 && sp !== 32) return [];
      const damage = 30 + sp / 32 + (mult > 1 ? 1 : 0);
      return item === "berry" || ability === "Fur Coat"
        ? [damage, damage, damage + 1, 200] : [damage, 200, 201, 202];
    };
    const attack = (_item: string, _ability: string, mult: Mult, sp: number) =>
      sp !== 0 && sp !== 32 ? [] : mult > 1 ? [10, 10, 10, 50] : [10, 50, 50, 50];
    const evidence: Evidence[] = [
      { kind: "bulk", key: "def", before: 100, after: 84, rolls: bulk },
      { kind: "bulk", key: "spd", before: 100, after: 84, rolls: bulk },
      { kind: "offense", key: "atk", before: 100, after: 90, rolls: attack },
      { kind: "offense", key: "spa", before: 100, after: 90, rolls: attack },
    ];
    const natureMass = joint.natures.map(() => 0);
    const speedMass = Array<number>(33).fill(0);
    const speedCaps = Array<number>(joint.natures.length * joint.items.length * joint.abilities.length).fill(-1);
    let count = 0, maximumWeight = 0;
    joint.natures.forEach((nature, n) => {
      for (const [i, item] of joint.items.entries()) for (const [a, ability] of joint.abilities.entries())
        for (let hp = 0; hp <= 32; hp++) for (const def of [0, 32]) for (const spd of [0, 32])
          for (const atk of [0, 32]) for (const spa of [0, 32]) {
            if (hp + def + spd + atk + spa > 66) continue;
            const sps = { hp, def, spd, atk, spa };
            let weight = nature.prior * item.prior * ability.prior;
            for (const e of evidence) {
              const rolls = e.kind === "bulk"
                ? bulk(ability.name, nature.mult[e.key], sps[e.key], item.name)
                : attack(item.name, ability.name, nature.mult[e.key], sps[e.key]);
              weight *= rolls.filter((damage) => e.kind === "bulk"
                ? foeRollFits(damage, actualStat(BASE.hp, "hp", hp, 1), e.before, e.after)
                : mineRollFits(damage, e.before, e.after)).length / rolls.length;
            }
            if (!(weight > 0)) continue;
            count++;
            natureMass[n]! += weight;
            maximumWeight = Math.max(maximumWeight, weight);
            const cap = Math.min(32, 66 - hp - def - spd - atk - spa);
            const index = (n * joint.items.length + i) * joint.abilities.length + a;
            speedCaps[index] = Math.max(speedCaps[index]!, cap);
            for (let spe = 0; spe <= cap; spe++) speedMass[spe]! += weight;
          }
    });
    const result = infer(joint, evidence)!;
    const total = natureMass.reduce((sum, weight) => sum + weight, 0);
    expect(count).toBeGreaterThan(0);
    expect(result.count).toBe(count);
    expect(result.speedCaps).toEqual(speedCaps);
    const topSpeed = Math.max(...speedMass);
    result.stats.spe.mass.forEach((value, spe) => expect(value).toBeCloseTo(speedMass[spe]! / topSpeed, 10));
    result.natureShares!.forEach((value, n) => expect(value).toBeCloseTo(natureMass[n]! / total, 10));
    expect(result.natureShares!.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
    const example = result.mostLikely!;
    const nature = joint.natures.find((row) => row.name === example.nature)!;
    let exampleWeight = nature.prior * joint.items.find((row) => row.name === example.item)!.prior
      * joint.abilities.find((row) => row.name === example.ability)!.prior;
    for (const e of evidence) {
      const rolls = e.kind === "bulk"
        ? bulk(example.ability, nature.mult[e.key], example.sps[e.key]!, example.item)
        : attack(example.item, example.ability, nature.mult[e.key], example.sps[e.key]!);
      exampleWeight *= rolls.filter((damage) => e.kind === "bulk"
        ? foeRollFits(damage, actualStat(BASE.hp, "hp", example.sps.hp!, 1), e.before, e.after)
        : mineRollFits(damage, e.before, e.after)).length / rolls.length;
    }
    expect(exampleWeight).toBeCloseTo(maximumWeight, 12);
    expect(Object.values(example.sps).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(66);
    expect(example.sps.spe).toBe(0);
    expect(infer(joint, [])!.natureShares).toEqual(expect.arrayContaining([
      expect.closeTo(0.4, 10), expect.closeTo(0.2, 10),
    ]));
  });
  it("returns no nature percentages for count-only, zero-weight or empty results and updates exclusions", () => {
    const evidence: Evidence[] = [{ kind: "offense", key: "atk", before: 100, after: 90,
      rolls: (_item, _ability, mult, sp) => mult > 1 && sp === 32 ? [10] : [50] }];
    expect(infer(SPACE, evidence)!.natureShares).toEqual([0, 1, 0]);
    expect(infer(SPACE, evidence)!.speedCaps).toEqual([-1, -1, 32, 32, -1, -1]);
    expect(infer(SPACE, evidence, true)!.natureShares).toBeNull();
    expect(infer(SPACE, evidence, true)!.mostLikely).toBeNull();
    const zeroWeight = infer({ ...SPACE, natures: SPACE.natures.map((nature) => ({ ...nature, prior: 0 })) }, evidence)!;
    expect(zeroWeight.natureShares).toBeNull();
    expect(zeroWeight.mostLikely).not.toBeNull();
    const impossible: Evidence = { ...evidence[0]!, rolls: () => [50] };
    const conflict = infer(SPACE, [...evidence, impossible])!;
    expect(conflict.count).toBe(0);
    expect(conflict.natureShares).toBeNull();
    expect(conflict.mostLikely).toBeNull();
    const template = { nature: "Jolly", item: "plain", ability: "Rough Skin", sps: { hp: 29, atk: 31, def: 6, spe: 0 } };
    const example = infer({ ...space, items: [space.items[0]!] }, [], false, template)!.mostLikely!;
    expect(example.sps).toEqual({ hp: 29, atk: 31, def: 6, spd: 0, spa: 0, spe: 0 });
  });
  it("matches independent joint enumeration with item-dependent likelihoods", () => {
    const bulk = (_ability: string, _mult: Mult, sp: number, item: string) =>
      sp > 2 ? [] : item === "berry" ? [30 + sp, 30 + sp, 31 + sp, 200] : [29 + sp, 200, 201, 202];
    const attack = (_item: string, _ability: string, _mult: Mult, sp: number) =>
      sp > 2 ? [] : [10, 10, 11 + sp, 12 + sp];
    const evidence: Evidence[] = [
      { kind: "bulk", key: "def", before: 100, after: 84, rolls: bulk },
      { kind: "bulk", key: "spd", before: 100, after: 84, rolls: bulk },
      { kind: "offense", key: "atk", before: 100, after: 90, rolls: attack },
      { kind: "offense", key: "spa", before: 100, after: 90, rolls: attack },
    ];
    let count = 0;
    const mass = Object.fromEntries(SP_KEYS.map((key) => [key, Array(33).fill(0)])) as Record<typeof SP_KEYS[number], number[]>;
    for (const item of space.items) for (let hp = 0; hp <= 32; hp++) for (let def = 0; def <= 2; def++)
      for (let spd = 0; spd <= 2; spd++) for (let atk = 0; atk <= 2; atk++) for (let spa = 0; spa <= 2; spa++) {
        const sps = { hp, def, spd, atk, spa };
        if (Object.values(sps).reduce((a, b) => a + b) > 66) continue;
        let likelihood = item.prior * space.natures[0]!.prior;
        for (const e of evidence) {
          const rolls = e.kind === "bulk" ? bulk("", 1, sps[e.key], item.name) : attack(item.name, "", 1, sps[e.key]);
          likelihood *= rolls.filter((damage) => e.kind === "bulk"
            ? foeRollFits(damage, actualStat(BASE.hp, "hp", hp, 1), e.before, e.after)
            : mineRollFits(damage, e.before, e.after)).length / rolls.length;
        }
        if (!(likelihood > 0)) continue;
        count++;
        for (const key of SP_KEYS) mass[key][sps[key]]! += likelihood;
      }
    const result = infer(space, evidence)!;
    expect(result.count).toBe(count);
    expect(count).toBeGreaterThan(0);
    for (const key of SP_KEYS) {
      const top = Math.max(...mass[key]);
      result.stats[key].mass.forEach((value, sp) => expect(value).toBeCloseTo(mass[key][sp]! / top, 10));
    }
  });
  it("treats full-HP survival as censored damage, and includes speed donors in nearest builds", () => {
    expect(foeRollFits(999, 183, 100, 1, true)).toBe(true);
    expect(foeRollFits(999, 183, 99, 1, true)).toBe(false);
    expect(mineRollFits(999, 183, 1, true)).toBe(true);
    const constrained: Evidence[] = [
      { kind: "bulk", key: "def", before: 100, after: 1,
        rolls: (_ability, _mult, sp) => sp === 32 ? [999] : [0], stopAtOne: () => true },
      { kind: "offense", key: "atk", before: 100, after: 50,
        rolls: (_item, _ability, _mult, sp) => sp === 32 ? [50] : [0] },
    ];
    const result = infer(space, constrained)!;
    expect(result.stats.spe).toMatchObject({ observed: true, lo: 0, hi: 2 });
    expect(result.speedCaps).toEqual([2, 2]);
    const initial = infer(space, [])!;
    expect(initial.stats.spe).toMatchObject({ observed: false, lo: 0, hi: 32 });
    expect(initial.speedCaps).toEqual([32, 32]);
    const nearest = nearestSurviving(space, result, { nature: "Jolly", item: "plain", ability: "Rough Skin",
      sps: { hp: 2, atk: 32, spe: 32 } })!;
    expect(Object.values(nearest.sps).reduce((a, b) => a + b)).toBeLessThanOrEqual(66);
    expect(nearest.sps.spe).toBeLessThanOrEqual(2);
    expect(spreadSurvives(space, result, 0, nearest.sps)).toBe(true);
    expect(spreadSurvives(space, result, 0, { hp: 2, atk: 32, def: 32, spe: 32 })).toBe(false);
  });
});
