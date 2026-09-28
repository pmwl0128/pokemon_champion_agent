import type { SpSpread } from "@pokemon-champions/protocol";

/** Stable identity for an SP spread: React key, and the join between a detail row and its history. */
export function spreadKey(spread: SpSpread): string {
  return ["hp", "atk", "def", "spa", "spd", "spe"]
    .map((key) => spread[key as keyof SpSpread] ?? 0).join("/");
}
