import { describe, expect, it } from "vitest";
import type { Observation } from "./context.ts";
import { observationSummary, possibleBuild } from "./presentation.ts";
import type { Candidate, Inference } from "./model.ts";
import type { InferenceView, SetReading } from "./useInference.ts";
import { percent } from "./ObservationLog.tsx";

const observation = (id: string, enabled = true) => ({ id, enabled }) as Observation;
const view = () => ({ remaining: new Map<string, number | null>(), impossible: new Map<string, number[]>(),
  skipped: new Set<string>(), loading: false });

describe("inference observation presentation", () => {
  it("does not round a tiny surviving fraction to an apparent zero", () => {
    expect(percent(0.0000003)).toBe("<0.01%");
    expect(percent(0)).toBe("0.00%");
    expect(percent(.0001)).toBe("0.01%");
  });
  it("does not present excluded or disabled records as effective evidence and keeps the log numbering", () => {
    const result = view();
    result.impossible.set("bad", [50]);
    result.skipped.add("unsupported");
    result.remaining.set("used", 0); // A joint contradiction is still evidence, even at zero remaining.
    expect(observationSummary([observation("bad"), observation("off", false),
      observation("unsupported"), observation("used")], result)).toEqual({
      acceptedIndexes: [3], unused: 2, disabled: 1, pending: 0,
    });
    result.remaining.clear();
    expect(observationSummary([observation("bad")], result).acceptedIndexes).toEqual([]);
  });
  it("keeps pending observations separate from confirmed results", () => {
    const result = { ...view(), loading: true };
    result.skipped.add("unsupported");
    expect(observationSummary([observation("loading"), observation("unsupported")], result)).toEqual({
      acceptedIndexes: [], unused: 1, disabled: 0, pending: 1,
    });
  });
});

describe("the possible-build example", () => {
  const candidate: Candidate = { nature: "Hardy", item: "plain", ability: "Sturdy", sps: { hp: 2, atk: 32 } };
  const input = () => ({ loading: false, error: false, prior: null,
    inference: { count: 1, natures: [true], mostLikely: candidate } as Inference,
    info: { space: { natures: [{ name: "Hardy" }], items: [{ name: "plain" }], abilities: [{ name: "Sturdy" }] } },
    sets: [] as SetReading[],
  }) as Pick<InferenceView, "loading" | "error" | "prior" | "inference" | "info" | "sets">;
  const reading = (coverage: number, fits = true, build = candidate) => ({ candidate: build, fits,
    shares: [fits ? 1 : 0], option: { coverage } as SetReading["option"] });

  it("prioritizes the highest-usage feasible common build, not an excluded or incompatible build", () => {
    const view = input();
    view.sets = [reading(0.9, false), reading(0.2), reading(0.4),
      reading(0.95, true, { ...candidate, item: "unconfirmed-other-item" }),
      reading(0.96, true, { ...candidate, sps: { hp: 32, atk: 32, spe: 32 } })];
    expect(possibleBuild(view)).toEqual({ kind: "common", candidate, coverage: 0.4 });
  });
  it("always falls back to a feasible model example when common builds are absent or ruled out", () => {
    const view = input();
    expect(possibleBuild(view)).toEqual({ kind: "inferred", candidate });
    view.sets = [reading(0.9, false)];
    expect(possibleBuild(view)?.kind).toBe("inferred");
    view.inference!.count = 0;
    expect(possibleBuild(view)).toBeNull();
    view.inference!.count = 1;
    expect(possibleBuild({ ...view, loading: true })).toBeNull();
    expect(possibleBuild({ ...view, error: true })).toBeNull();
  });
});
