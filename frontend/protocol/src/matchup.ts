/**
 * Opponent standard-set matchup cache DTOs (the team skill's M5 reference grid). Two views over
 * ONE dataset: the stored KO matrix (`OppCacheDto` — attacker i's hardest move vs defender j's
 * standard set) and the derived check-grade view (C2/C1/C0 over observed-build pairs). Every cell is `low` confidence
 * (retained observed builds, never a real team) — the UI surfaces that, never a score or ranking.
 *
 * Mapped from `.../opponent_cache/<rule>_<format>.json` by the backend mapper, which resolves each
 * canonical species name to its dex slug + trilingual names (so the grid can show sprites + localized
 * labels; conventions §4 — `name` stays the English join key). The static online projection includes
 * de-attributed processed sets; the bridge also carries their local provenance fields.
 */
import { z } from "zod";
import {
  FormatIdSchema, MoveCategorySchema, SpSpreadSchema, namedFields,
} from "./common.ts";
import { KoCaveatDtoSchema, KoChanceDtoSchema } from "./calc.ts";

export const CheckGradeSchema = z.enum(["C2", "C1", "C0"]);
export type CheckGrade = z.infer<typeof CheckGradeSchema>;

/** The attacker's single hardest move (by max roll) vs a defender's standard set. `koExact` is
 * true only for a real OHKO — every 2+HKO is a static N-hit approximation (read `koChance` for the
 * recovery-aware verdict). `disguiseAdjusted` is present only vs a Disguise (Mimikyu) defender. */
export const OppOffenseDtoSchema = z.object({
  move: z.string(),
  minPercent: z.number(),
  maxPercent: z.number(),
  koPossible: z.number().int().nullable(),
  koGuaranteed: z.number().int().nullable(),
  ko: z.string(),
  koExact: z.boolean(),
  category: MoveCategorySchema,
  koChance: KoChanceDtoSchema.nullable(),
  koCaveats: z.array(KoCaveatDtoSchema).nullable().optional(),
  disguiseAdjusted: z.object({
    effectiveKoPossible: z.number().int().nullable(),
    effectiveKoGuaranteed: z.number().int().nullable(),
    note: z.string(),
  }).optional(),
});
export type OppOffenseDto = z.infer<typeof OppOffenseDtoSchema>;

/** Exact speed line for the two named representative builds. */
export const OppSpeedDtoSchema = z.object({
  attacker: z.number().int().nullable(),
  defender: z.number().int().nullable(),
  faster: z.enum(["attacker", "defender", "tie"]).nullable(),
});
export type OppSpeedDto = z.infer<typeof OppSpeedDtoSchema>;

export const OppCellDtoSchema = z.object({
  offense: OppOffenseDtoSchema.nullable(),
  speed: OppSpeedDtoSchema,
});
export type OppCellDto = z.infer<typeof OppCellDtoSchema>;

/** A species' resolved standard set. `moves` is null for a defender-only (meta-only) species (no
 * real joint move set); `sps` is remapped to smogon stat keys for display parity with the rest of
 * the UI. `runForm` differs from `species` only when the run form ≠ the meta key (a singles Mega). */
export const OppSetDtoSchema = z.object({
  species: z.string(),
  runForm: z.string().nullable(),
  ability: z.string().nullable().optional(),
  item: z.string().nullable().optional(),
  nature: z.string().nullable().optional(),
  moves: z.array(z.string()).nullable(),
  sps: SpSpreadSchema.nullable(),
  source: z.string().nullable().optional(),
  confidence: z.string().nullable().optional(),
  /** Optional: the public projection strips ALL provenance (revised §7.1 — processed
   * sets ship without real-team attribution); the local bridge still sends it. */
  realTeamBacked: z.boolean().optional(),
  note: z.string().nullable().optional(),
  /** Variant-expanded grids only: which build this is. `isModal` marks the species' default row and
   * `coverage` is its share of that species' real teams. `baseAbility` is the PRE-Mega ability when
   * it differs from the battle one — it still fires on switch-in, so two builds sharing a stone can
   * be genuinely different opponents. */
  isModal: z.boolean().optional(),
  coverage: z.number().nullable().optional(),
  sampleCount: z.number().int().nullable().optional(),
  representativeCount: z.number().int().nullable().optional(),
  clusterBasis: z.literal("item_ability").nullable().optional(),
  representedCoverage: z.number().nullable().optional(),
  unrepresentedCoverage: z.number().nullable().optional(),
  speedProfile: z.object({
    sample: z.number().int(),
    minSpeSp: z.number().int().nullable(),
    maxSpeSp: z.number().int().nullable(),
    natures: z.array(z.string()),
    heterogeneous: z.boolean(),
  }).nullable().optional(),
  baseAbility: z.string().optional(),
});
export type OppSetDto = z.infer<typeof OppSetDtoSchema>;

/** One build of a species in the variant-expanded grid. `key` indexes `sets` and `matrix`. */
export const OppVariantRefSchema = z.object({
  key: z.string().min(1),
  item: z.string().nullable().optional(),
  ability: z.string().nullable().optional(),
  isModal: z.boolean(),
  coverage: z.number().nullable().optional(),
  runForm: z.string().optional(),
  baseAbility: z.string().optional(),
});
export type OppVariantRef = z.infer<typeof OppVariantRefSchema>;

/** One roster row (fixes display order); `name` is the canonical English matrix key, resolved to a
 * dex `slug` + trilingual names by the mapper. `realTeamBacked` species get an attacker row. */
export const SpeciesRowDtoSchema = z.object({
  rank: z.number().int().nullable(),
  slug: z.string().min(1),
  ...namedFields,
  realTeamBacked: z.boolean(),
  setSource: z.string().nullable().optional(),
  setConfidence: z.string().nullable().optional(),
  runForm: z.string().optional(),
  /** The species' real builds, modal first-class via `isModal`. One entry on a legacy grid. The
   * default view picks each species' modal key; switching a build re-indexes `matrix` client-side. */
  variants: z.array(OppVariantRefSchema).optional(),
});
export type SpeciesRowDto = z.infer<typeof SpeciesRowDtoSchema>;

export const OppCacheDtoSchema = z.object({
  teamEvidenceExpiresAt: z.string().datetime({ offset: true }).optional(),
  season: z.string().min(1),
  rule: z.string().min(1),
  format: FormatIdSchema,
  builtAt: z.string(),
  topK: z.number().int().positive(),
  variantCount: z.number().int().positive(),
  confidence: z.string(),
  confidenceReason: z.string(),
  species: z.array(SpeciesRowDtoSchema),
  /** Keyed by the variant ref's lossless wire key (species slug on legacy grids). OPTIONAL for
   * backward/lean deployments. The current static projection ships processed sets for detail panels
   * and calculator hand-offs, but strips every provenance field; the local bridge also sends those
   * provenance fields (design §7.1). */
  sets: z.record(z.string(), OppSetDtoSchema).optional(),
  /** matrix[attackerKey][defenderKey] = cell, keyed by VARIANT on an expanded grid (species slug on
   * a legacy one). Attacker rows exist only for real-team-backed builds. Includes same-species pairs
   * and the mirror — both are real matchups. */
  matrix: z.record(z.string(), z.record(z.string(), OppCellDtoSchema)),
});
export type OppCacheDto = z.infer<typeof OppCacheDtoSchema>;

// --- lean KO overview -------------------------------------------------------------------------

/** The facts needed to paint one KO cell before its detail panel is opened. The full offense,
 * speed line and processed sets remain in `OppCacheDto` and are loaded on demand; keeping this
 * overview separate avoids parsing the multi-megabyte detail matrix on the default page. */
export const OppKoSummaryDtoSchema = z.tuple([
  z.number(),                    // 0 minPercent
  z.number(),                    // 1 maxPercent
  z.number().int().nullable(),   // 2 koPossible
  z.number().int().nullable(),   // 3 koGuaranteed
  z.number().int().nullable(),   // 4 recovery-aware koChance.n
  z.boolean().nullable(),        // 5 recovery-aware koChance.guaranteed
  z.number().nullable(),         // 6 recovery-aware koChance.chancePct
]);
export type OppKoSummaryDto = z.infer<typeof OppKoSummaryDtoSchema>;

/** Lean KO overview keyed exactly like `OppCacheDto.matrix`. A selected cell can therefore switch
 * to the full cache without coordinate translation or recalculation. */
export const OppKoGridDtoSchema = z.object({
  teamEvidenceExpiresAt: z.string().datetime({ offset: true }).optional(),
  format: FormatIdSchema,
  confidence: z.string(),
  confidenceReason: z.string(),
  species: z.array(SpeciesRowDtoSchema),
  grid: z.record(z.string(), z.record(z.string(), OppKoSummaryDtoSchema.nullable())),
});
export type OppKoGridDto = z.infer<typeof OppKoGridDtoSchema>;

// --- derived check view ------------------------------------------------------------------------

/** The lean UI-facing slice of the skill's rich `check` object: the ordinal grade + the few
 * qualifiers the grid colors/labels by. The full engagement lines stay in the skill (facts-only). */
export const OppCheckDtoSchema = z.object({
  grade: CheckGradeSchema,
  c1Mode: z.string().nullable(),
  c0Kind: z.enum(["loss", "wall_no_ko"]).nullable(),
  resolvability: z.enum(["clean", "contested"]),
  /** Language-invariant coordinates for the legacy English `caveats` below. */
  caveatDetails: z.array(z.object({
    code: z.string().min(1),
    params: z.record(z.string(), z.union([
      z.string(), z.number(), z.boolean(), z.null(),
    ])),
  })).default([]),
  /** Backward-compatible diagnostic prose; localized clients render `caveatDetails`. */
  caveats: z.array(z.string()),
});
export type OppCheckDto = z.infer<typeof OppCheckDtoSchema>;

/** One graded ordered BUILD pair. Deliberately lean: damage/speed for the pair live in the KO
 * matrix (this grid is derived FROM it), so repeating them here would ship the same numbers twice. */
export const OppCheckGradeSchema = z.object({
  grade: CheckGradeSchema,
  c0Kind: z.string().optional(),
  contested: z.boolean().optional(),
});
export type OppCheckGrade = z.infer<typeof OppCheckGradeSchema>;

/** grid[attackerBuildKey][defenderBuildKey]. Consumers may render a species-sized representative
 * view first and switch either axis to another retained observed build without recalculation. */
export const OppCheckGridDtoSchema = z.object({
  teamEvidenceExpiresAt: z.string().datetime({ offset: true }).optional(),
  format: FormatIdSchema,
  confidence: z.string(),
  confidenceReason: z.string(),
  species: z.array(SpeciesRowDtoSchema),
  grid: z.record(z.string(), z.record(z.string(), OppCheckGradeSchema)),
});
export type OppCheckGridDto = z.infer<typeof OppCheckGridDtoSchema>;

// --- actual registered-set battery -------------------------------------------------------------

/** One UI request. Exactly one of `team` or `text` is accepted by the server; keeping the wire
 * shape small lets manual editors, text imports and cross-feature hand-offs share one endpoint. */
export const ActualMatchupRequestDtoSchema = z.object({
  format: FormatIdSchema,
  topK: z.number().int().min(1).max(60),
  team: z.unknown().optional(),
  text: z.string().max(16_000).optional(),
});
export type ActualMatchupRequestDto = z.infer<typeof ActualMatchupRequestDtoSchema>;

export const ActualDamageFactDtoSchema = z.object({
  move: z.string(),
  min_percent: z.number(),
  max_percent: z.number(),
  ko_possible: z.number().int().nullable().optional(),
  ko_guaranteed: z.number().int().nullable().optional(),
  // A damaging move can have no finite KO estimate (immunity/recovery/zero damage). The skill
  // emits the key with null in that case; rejecting it made every wider Top-K response fail at
  // the adapter boundary even though the deterministic calculation itself completed.
  ko: z.string().nullable().optional(),
  ko_exact: z.boolean().optional(),
  /** The RECOVERY-AWARE verdict the grade is computed from. Prefer it over the static rolls when
   * labelling a cell: Leftovers can turn a static 2HKO into an 87.5% chance. */
  ko_chance: z.object({
    text: z.string().optional(),
    n: z.number().int().nullable().optional(),
    guaranteed: z.boolean().nullable().optional(),
    chance_pct: z.number().nullable().optional(),
  }).passthrough().nullable().optional(),
  category: z.string().optional(),
  priority: z.number().int().optional(),
}).passthrough();
export type ActualDamageFactDto = z.infer<typeof ActualDamageFactDtoSchema>;

export const ActualCheckFactDtoSchema = z.object({
  grade: CheckGradeSchema.nullable().optional(),
  c1_mode: z.string().nullable().optional(),
  c0_kind: z.string().nullable().optional(),
  resolvability: z.string().nullable().optional(),
  contested: z.boolean().optional(),
  caveat_codes: z.array(z.string()).optional(),
}).passthrough();
export type ActualCheckFactDto = z.infer<typeof ActualCheckFactDtoSchema>;

export const ActualMatchupCellDtoSchema = z.object({
  cell_id: z.string().min(1),
  target_id: z.string().min(1),
  opponent: z.string().min(1),
  usage_rank: z.number().int().nullable(),
  /** Several cells share one `opponent`: a ranked species expands into one cell per real build, and
   * this names which build the numbers belong to. */
  opponent_variant: z.string().optional(),
  opponent_is_modal: z.boolean().optional(),
  opponent_coverage: z.number().nullable().optional(),
  opponent_cluster: z.object({ item: z.string().nullable().optional(),
                               ability: z.string().nullable().optional() }).nullable().optional(),
  opponent_run_form: z.string().nullable().optional(),
  set_confidence: z.string().nullable().optional(),
  speed: z.object({
    member: z.number().int().nullable(),
    opponent: z.number().int().nullable(),
    faster: z.enum(["member", "opponent", "tie"]).nullable(),
  }).passthrough(),
  defense_type: z.object({
    opponent_stab_types: z.array(z.string()).nullable().optional(),
    max_effectiveness_vs_member: z.number().nullable().optional(),
  }).passthrough(),
  offense: ActualDamageFactDtoSchema.nullable(),
  incoming: ActualDamageFactDtoSchema.nullable(),
  check: ActualCheckFactDtoSchema.nullable(),
  /** The same pair graded the other way round — "can the OPPONENT answer us". A separate reading
   * from `check`, not its complement, so the grid can swap sides without a second request. */
  reverse_check: ActualCheckFactDtoSchema.nullable().optional(),
}).passthrough();
export type ActualMatchupCellDto = z.infer<typeof ActualMatchupCellDtoSchema>;

export const ActualMatchupMemberDtoSchema = z.object({
  source_id: z.string().min(1),
  source_index: z.number().int().nonnegative(),
  member: z.string().min(1),
  /** Effective calculation form when a registered base species holds its matching Mega stone. */
  member_run_form: z.string().nullable().optional(),
  base_speed: z.number().int().nullable(),
  speed: z.number().int().nullable(),
  types: z.array(z.string()),
  speed_coverage: z.unknown().nullable().optional(),
  cells: z.array(ActualMatchupCellDtoSchema),
});
export type ActualMatchupMemberDto = z.infer<typeof ActualMatchupMemberDtoSchema>;

export const ActualMatchupResultDtoSchema = z.object({
  kind: z.literal("matchup"),
  format: FormatIdSchema,
  top_k: z.number().int().min(1).max(60),
  source_count: z.number().int().positive(),
  target_count: z.number().int().positive(),
  view: z.literal("summary"),
  members: z.array(ActualMatchupMemberDtoSchema),
  calculation: z.object({
    requested: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  coverage: z.object({
    cells_total: z.number().int().nonnegative(),
    cells_with_offense: z.number().int().nonnegative(),
    cells_with_check: z.number().int().nonnegative(),
    complete: z.boolean(),
  }),
  confidence: z.string(),
  confidence_reason: z.string(),
}).passthrough();
export type ActualMatchupResultDto = z.infer<typeof ActualMatchupResultDtoSchema>;

export const ActualMatchupResponseDtoSchema = z.object({
  /** Server-normalized editable team-json, especially useful after a free-form text import. */
  team: z.unknown(),
  result: ActualMatchupResultDtoSchema,
});
export type ActualMatchupResponseDto = z.infer<typeof ActualMatchupResponseDtoSchema>;
