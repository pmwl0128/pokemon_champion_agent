/** Actual stat values at level 50 (IV 31), using the Champions formula: SP (stat points) are
 * added DIRECTLY, capped at 32 per stat — NOT the mainline EV/4 term. This matches the calc
 * engine (ncp stat_data.js CALC_*_CHAMP); the displayed range is 0 SP up to 32 SP with a
 * boosting nature. */
import type { StatKey, Stats } from "@pokemon-champions/protocol";

const LEVEL = 50;
const SP_MAX = 32;   // Champions per-stat SP cap (66 across the spread)

function hpAt(base: number, sp: number): number {
  if (base === 1) return 1;   // base-1 HP (Shedinja) is always exactly 1
  return Math.floor(((2 * base + 31) * LEVEL) / 100) + LEVEL + 10 + sp;
}

function statAt(base: number, sp: number, natureMult: 0.9 | 1 | 1.1): number {
  const raw = Math.floor(((2 * base + 31) * LEVEL) / 100) + 5 + sp;
  return Math.floor(raw * natureMult);
}

/** One stat's actual Lv.50 value from base + SP + nature multiplier (HP ignores nature). Used by
 * the bulk / attack indices (HP×Def, Atk×BP…) that need a single resolved stat, not the range. */
export function actualStat(base: number, key: StatKey, sp: number, natureMult: 0.9 | 1 | 1.1): number {
  return key === "hp" ? hpAt(base, sp) : statAt(base, sp, natureMult);
}

/** Standard in-battle boost-stage multiplier for an offensive/defensive stat (atk/def/spa/spd):
 * +n → (2+n)/2, −n → 2/(2−n), clamped to ±6. Speed uses the same curve but is handled by the
 * speed engine; here it feeds the tune page's live attack/bulk indices. */
export function boostMult(stage: number): number {
  const s = Math.max(-6, Math.min(6, Math.trunc(stage)));
  return s >= 0 ? (2 + s) / 2 : 2 / (2 - s);
}

export interface StatRangeRow {
  key: StatKey;
  base: number;
  min: number;      // 0 SP, neutral nature (HP: no nature)
  max: number;      // 32 SP, boosting nature (HP: no nature)
}

export function statRanges(stats: Stats): StatRangeRow[] {
  return (Object.keys(stats) as StatKey[]).map((key) => {
    const base = stats[key];
    if (key === "hp") {
      return { key, base, min: hpAt(base, 0), max: hpAt(base, SP_MAX) };
    }
    return { key, base, min: statAt(base, 0, 1), max: statAt(base, SP_MAX, 1.1) };
  });
}
