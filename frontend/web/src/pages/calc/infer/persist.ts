/** The inference tool's own memory: per opponent (by roster uid), the hits recorded against it and
 * what has been confirmed about it. Session-scoped like the rest of the calc page's scratch work;
 * only input is kept, every number is recomputed from it. */
import { EMPTY_FIELD, type FieldState } from "../duel/state.ts";
import { readMon } from "../duel/persist.ts";
import type { KnownFacts, Observation } from "./context.ts";

const KEY = "pc-calc-infer-v1";

export interface FoeRecord {
  observations: Observation[];
  known: KnownFacts;
}

export type InferRecords = Record<string, FoeRecord>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const stages = (value: unknown): Observation["mineBoosts"] => {
  if (!isObject(value)) return {};
  const out: Observation["mineBoosts"] = {};
  for (const key of ["atk", "def", "spa", "spd", "spe"] as const) {
    const stage = value[key];
    if (typeof stage === "number" && Number.isInteger(stage) && stage >= -6 && stage <= 6 && stage) out[key] = stage;
  }
  return out;
};

function readObservation(raw: unknown): Observation | null {
  if (!isObject(raw)) return null;
  const { id, kind, foeId, mineId, move, before, after } = raw;
  if (typeof id !== "string" || (kind !== "bulk" && kind !== "offense") || typeof foeId !== "string"
    || typeof mineId !== "string" || typeof move !== "string" || typeof before !== "number"
    || typeof after !== "number") return null;
  const field = isObject(raw.field) ? { ...EMPTY_FIELD, ...(raw.field as Partial<FieldState>) } : EMPTY_FIELD;
  return {
    id, kind, foeId, mineId, move, before, after,
    crit: raw.crit === true,
    singleTarget: raw.singleTarget === true,
    field: { ...field, sides: isObject(field.sides) ? field.sides : { a: {}, b: {} } },
    mineBoosts: stages(raw.mineBoosts),
    foeBoosts: stages(raw.foeBoosts),
    mineStatus: typeof raw.mineStatus === "string" ? raw.mineStatus : "",
    foeStatus: typeof raw.foeStatus === "string" ? raw.foeStatus : "",
    enabled: raw.enabled !== false,
    mineSnapshot: readMon(raw.mineSnapshot) ?? undefined,
    foeSnapshot: readMon(raw.foeSnapshot) ?? undefined,
  };
}

export function loadInferRecords(): InferRecords {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as unknown;
    if (!isObject(raw)) return {};
    const out: InferRecords = {};
    for (const [uid, value] of Object.entries(raw)) {
      if (!isObject(value)) continue;
      const observations = Array.isArray(value.observations)
        ? value.observations.map(readObservation).filter((row): row is Observation => row !== null) : [];
      const known = isObject(value.known) ? value.known : {};
      out[uid] = {
        observations,
        known: {
          ...(typeof known.item === "string" && known.item ? { item: known.item } : {}),
          ...(typeof known.ability === "string" && known.ability ? { ability: known.ability } : {}),
        },
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function saveInferRecords(records: InferRecords): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(records));
  } catch { /* storage blocked: the records just do not survive a reload */ }
}
