import { loadAbilities, loadItems, loadMoves, loadNatures, loadProjectionDexIndex } from "../../runtime/projection.ts";
import type { TeamVocabulary } from "../teamDoc.ts";

/** Resolve before opening an IndexedDB transaction: network waits would let it expire. */
export async function loadLibraryVocabulary(): Promise<TeamVocabulary> {
  const [dex, items, abilities, moves, natures] = await Promise.all([
    loadProjectionDexIndex(), loadItems(), loadAbilities(), loadMoves(), loadNatures(),
  ]);
  return { dex, items, abilities, moves, natures };
}
