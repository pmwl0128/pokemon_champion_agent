/**
 * Damage / speed-line Web DTOs, mirroring the ncp-calc-api / ncp-speedline-api contracts
 * (their `schema` commands). Requests are UI-constructed and validated before dispatch;
 * results are passed through the mapper mostly 1:1 (the calc CLI is already canonical JSON).
 */
import { z } from "zod";
import {
  ErrorShapeSchema, FormatIdSchema, MoveCategorySchema, SpSpreadSchema, TypeNameSchema,
} from "./common.ts";

export const StatusSchema = z.enum([
  "Healthy", "Burned", "Paralyzed", "Poisoned", "Badly Poisoned", "Asleep", "Frozen",
]);
export type Status = z.infer<typeof StatusSchema>;

const boostValue = z.number().int().min(-6).max(6);
export const BoostsSchema = z.object({
  atk: boostValue, def: boostValue, spa: boostValue, spd: boostValue, spe: boostValue,
}).partial();

export const CombatantDtoSchema = z.object({
  name: z.string().min(1),
  ability: z.string().optional(),
  item: z.string().optional(),
  nature: z.string().optional(),
  sps: SpSpreadSchema.optional(),
  boosts: BoostsSchema.optional(),
  status: StatusSchema.optional(),
  curHP: z.number().int().positive().optional(),
});
export type CombatantDto = z.infer<typeof CombatantDtoSchema>;

/** Field vocabularies (the single source the UI derives its option lists from, so a schema
 * change can never leave the picker offering a value the calc rejects). */
export const WEATHERS = ["Rain", "Sun", "Sand", "Snow"] as const;
export const TERRAINS = ["Electric", "Grassy", "Psychic", "Misty"] as const;
export type Weather = (typeof WEATHERS)[number];
export type Terrain = (typeof TERRAINS)[number];
export const WeatherSchema = z.enum([...WEATHERS, ""]);
export const TerrainSchema = z.enum([...TERRAINS, ""]);

/** Side flags are snake_case booleans/counts (reflect, light_screen, helping_hand, ...). */
export const FieldDtoSchema = z.object({
  format: FormatIdSchema.optional(),
  weather: WeatherSchema.optional(),
  terrain: TerrainSchema.optional(),
  attackerSide: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
  defenderSide: z.record(z.string(), z.union([z.boolean(), z.number()])).optional(),
});
export type FieldDto = z.infer<typeof FieldDtoSchema>;

export const DamageRequestDtoSchema = z.object({
  attacker: CombatantDtoSchema,
  defender: CombatantDtoSchema,
  move: z.string().min(1),
  field: FieldDtoSchema.optional(),
  /** Resolve the switch-in Attack drops the two sides put on each other (Intimidate, Supersweet
   * Syrup). The calc defaults this on, which is what a one-off damage question wants. A tuning
   * frame carries no battle history and reports Intimidate as its own lane, so it sends false —
   * the `tune` operator does the same server-side, and the two must not disagree. */
  switch_in_drops: z.boolean().optional(),
});
export type DamageRequestDto = z.infer<typeof DamageRequestDtoSchema>;

export const KoChanceDtoSchema = z.object({
  text: z.string(),
  n: z.number().int().optional(),
  guaranteed: z.boolean().optional(),
  chancePct: z.number().nullable().optional(),
});

export const KoCaveatDtoSchema = z.object({
  code: z.string(),
  direction: z.string(),
  cause: z.string().optional(),
});

export const DamageResultDtoSchema = z.object({
  description: z.string(),
  damage: z.array(z.number().int()),
  min: z.number().int(),
  max: z.number().int(),
  minPercent: z.number(),
  maxPercent: z.number(),
  defenderHP: z.number().int(),
  hits: z.number().int(),
  /** Realistic hit-count band; widen KO reasoning over the env fields, not the central band. */
  hitsRange: z.tuple([z.number().int(), z.number().int()]),
  minEnv: z.number().int().optional(),
  maxEnv: z.number().int().optional(),
  minEnvPercent: z.number().optional(),
  maxEnvPercent: z.number().optional(),
  koChance: KoChanceDtoSchema.nullable(),
  /** Effects that make the static multi-turn KO unreliable — surface, never hide. */
  koCaveats: z.array(KoCaveatDtoSchema).nullable().optional(),
  category: MoveCategorySchema,
  move: z.string(),
  attacker: z.string(),
  defender: z.string(),
});
export type DamageResultDto = z.infer<typeof DamageResultDtoSchema>;

/** Batch calc: one attacker's several moves against several defenders is dispatched as a flat
 * list of independent damage requests (the calc CLI's `batch` command — faults isolated per
 * item), so the matrix page never fires N×M round-trips. Bounded to keep a single request
 * cheap (the largest realistic grid — ~8 moves × 12 targets — sits well under this). */
export const DamageBatchRequestDtoSchema = z.object({
  items: z.array(DamageRequestDtoSchema).min(1).max(240),
});
export type DamageBatchRequestDto = z.infer<typeof DamageBatchRequestDtoSchema>;

/** Each result aligns 1:1 with the request items: a mapped DamageResultDto, or the uniform
 * error shape (an unknown mon/move for that one cell never fails the whole grid). */
export const DamageBatchItemDtoSchema = z.union([DamageResultDtoSchema, ErrorShapeSchema]);
export type DamageBatchItemDto = z.infer<typeof DamageBatchItemDtoSchema>;
export const DamageBatchResultDtoSchema = z.array(DamageBatchItemDtoSchema);
export type DamageBatchResultDto = z.infer<typeof DamageBatchResultDtoSchema>;

export const SpeedlineDtoSchema = z.object({
  name: z.string().min(1),
  types: z.array(TypeNameSchema).min(1).max(2),
  baseSpeed: z.number().int(),
  nature: z.string(),
  speedSPs: z.number().int(),
  speedIV: z.number().int(),
  speedBoost: z.number().int(),
  rawSpeed: z.number().int(),
  boostedSpeed: z.number().int(),
  finalSpeed: z.number().int(),
});
export type SpeedlineDto = z.infer<typeof SpeedlineDtoSchema>;

/** Speed-input field: the speedline CLI's flat `field` (NOT the calc FieldDto's per-side records)
 * — only the terms that move a single mon's final speed. */
export const SpeedFieldDtoSchema = z.object({
  weather: WeatherSchema.optional(),
  terrain: TerrainSchema.optional(),
  tailwind: z.boolean().optional(),
  swamp: z.boolean().optional(),
});
export type SpeedFieldDto = z.infer<typeof SpeedFieldDtoSchema>;

/** One entry on a speed ladder — the ncp-speedline-api `one`/`batch` input. Only the
 * speed-relevant fields (nature, spe SP/IV, spe boost, item, status, field) alter finalSpeed. */
export const SpeedInputDtoSchema = z.object({
  name: z.string().min(1),
  nature: z.string().optional(),
  sps: z.object({ spe: z.number().int().min(0).max(32) }).partial().optional(),
  ivs: z.object({ spe: z.number().int().min(0).max(31) }).partial().optional(),
  boosts: z.object({ spe: boostValue }).partial().optional(),
  ability: z.string().optional(),
  item: z.string().optional(),
  status: StatusSchema.optional(),
  field: SpeedFieldDtoSchema.optional(),
});
export type SpeedInputDto = z.infer<typeof SpeedInputDtoSchema>;

/** A whole ladder in one fault-isolated speedline batch — the meta speed-tier table sends the top-N
 * mons × 4 investment tiers (最速/準速/無振/最慢), so the bound covers ~50×4 plus custom rows. */
export const SpeedBatchRequestDtoSchema = z.object({
  items: z.array(SpeedInputDtoSchema).min(1).max(240),
});
export type SpeedBatchRequestDto = z.infer<typeof SpeedBatchRequestDtoSchema>;

export const SpeedBatchItemDtoSchema = z.union([SpeedlineDtoSchema, ErrorShapeSchema]);
export type SpeedBatchItemDto = z.infer<typeof SpeedBatchItemDtoSchema>;
export const SpeedBatchResultDtoSchema = z.array(SpeedBatchItemDtoSchema);
export type SpeedBatchResultDto = z.infer<typeof SpeedBatchResultDtoSchema>;
