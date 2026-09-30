/** Presentation over the completed inference, never a second copy of the shared roster. */
import type { Observation } from "./context.ts";
import type { InferenceView } from "./useInference.ts";
import { SP_BUDGET, SP_KEYS, SP_MAX, type Candidate } from "./model.ts";

export function observationSummary(observations: readonly Observation[], view: Pick<InferenceView,
  "remaining" | "impossible" | "skipped" | "loading">) {
  const acceptedIndexes: number[] = [];
  let unused = 0, disabled = 0, pending = 0;
  observations.forEach((observation, index) => {
    if (!observation.enabled) { disabled++; return; }
    if (view.impossible.has(observation.id) || view.skipped.has(observation.id)) { unused++; return; }
    if (view.remaining.has(observation.id)) acceptedIndexes.push(index);
    else if (view.loading) pending++;
  });
  return { acceptedIndexes, unused, disabled, pending };
}

export type PossibleBuild = { kind: "common"; candidate: Candidate; coverage: number | null }
  | { kind: "inferred"; candidate: Candidate };

/** Common, still-feasible environment builds outrank a model-generated maximum-weight example.
 * Neither selection writes to the shared roster. The fallback exists even without real-team data. */
export function possibleBuild(view: Pick<InferenceView, "info" | "inference" | "prior" | "sets" | "loading" | "error">): PossibleBuild | null {
  const inference = view.inference ?? view.prior, space = view.info?.space;
  if (view.loading || view.error || !inference?.count || !space) return null;
  const fitsScope = (candidate: Candidate) => {
    const n = space.natures.findIndex((nature) => nature.name === candidate.nature);
    const keys = [...SP_KEYS, "spe" as const];
    return n >= 0 && inference.natures[n] && space.items.some((item) => item.name === candidate.item)
      && space.abilities.some((ability) => ability.name === candidate.ability)
      && keys.every((key) => Number.isInteger(candidate.sps[key] ?? 0)
        && (candidate.sps[key] ?? 0) >= 0 && (candidate.sps[key] ?? 0) <= SP_MAX)
      && keys.reduce((sum, key) => sum + (candidate.sps[key] ?? 0), 0) <= SP_BUDGET;
  };
  const common = view.sets.filter((reading) => reading.fits && fitsScope(reading.candidate))
    .sort((x, y) => (y.option.coverage ?? 0) - (x.option.coverage ?? 0))[0];
  if (common) return { kind: "common", candidate: common.candidate, coverage: common.option.coverage };
  return inference.mostLikely ? { kind: "inferred", candidate: inference.mostLikely } : null;
}
