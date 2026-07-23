/** Shared KO-severity bucketing + color tone, used by BOTH the calc matrix and the opponent
 * matchup grid so a "2HKO" reads the same amber in either place. Purely a display bucket — the
 * underlying facts (roll band, recovery-aware ko_chance, caveats) stay on the cell. */
export type KoTone = "ohkoG" | "ohko" | "2hko" | "3hko" | "4hko" | "slow" | "immune" | "none";

/** `turns` = turns-to-KO (1 = OHKO); `guaranteed` = worst-roll certain; `maxPercent` is the cell's
 * best-roll damage, or **null when the cell has no computed result at all**.
 *
 * That null-vs-zero split is the whole point of the parameter: a computed 0% (type immunity, e.g.
 * Earthquake into a Flying/Levitate defender) is a CERTAIN fact and reads `immune`, while a missing
 * result is an absence and reads `none`. Collapsing both into one blank cell made confident
 * immunities look like the grid had skipped them. */
export function koTone(turns: number | null, guaranteed: boolean,
                       maxPercent: number | null): KoTone {
  if (maxPercent == null) return "none";
  if (maxPercent <= 0) return "immune";
  if (turns == null || turns <= 0) return "none";
  if (turns <= 1) return guaranteed ? "ohkoG" : "ohko";
  if (turns === 2) return "2hko";
  if (turns === 3) return "3hko";
  if (turns === 4) return "4hko";
  return "slow";
}

/** The short headline label for a KO bucket, now carrying the guaranteed/possible split
 * the community reads as 确N/乱N (ja 確N/乱N; en keeps NHKO with a ~ prefix for rolls).
 * The full probability text stays in ko_chance. */
export function koLabel(turns: number | null, anyDamage: boolean, guaranteed: boolean,
                        lang: "zh" | "en" | "ja"): string {
  if (!anyDamage || turns == null || turns <= 0) return "—";
  if (lang === "zh") return `${guaranteed ? "确" : "乱"}${turns}`;
  if (lang === "ja") return `${guaranteed ? "確" : "乱"}${turns}`;
  const base = turns <= 1 ? "OHKO" : `${turns}HKO`;
  return guaranteed ? base : `~${base}`;
}
