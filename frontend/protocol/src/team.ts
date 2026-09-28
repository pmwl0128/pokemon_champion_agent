/**
 * `team-json`, the team skill's canonical team structure
 * (.agents/skills/pokemon-champions-team/references/schema.md §1), as a Web DTO.
 *
 * This is the one shape a team takes anywhere in the Web UI that keeps it: the browser library,
 * import/export files, and the hand-offs between builder, diagnose, calculator and matchup. It
 * encodes STRUCTURE only. Legality (learnsets, Item Clause, SP totals, rule membership) is the team
 * skill's `validate`, never this schema — a stored draft may be illegal, and must still load so the
 * reader can fix it.
 *
 * Names are dex canonical English (the cross-skill join key); display names are resolved at render
 * time, so a stored team is language-independent and can be handed to any skill unchanged.
 */
import { z } from "zod";
import { FormatIdSchema, SpSpreadSchema } from "./common.ts";

/** Evidence lane of a member (schema.md §1). Hand-built members leave it out. */
export const TeamMemberCompletenessSchema = z.enum([
  "observed_full_set", "observed_species_only", "extracted_set", "inferred_set",
]);

export const TeamMemberDocSchema = z.object({
  /** Dex canonical English, Mega forms included ("Mega Salamence"). */
  species: z.string().min(1).max(100),
  item: z.string().min(1).max(100).nullable().default(null),
  ability: z.string().min(1).max(100).nullable().default(null),
  moves: z.array(z.string().min(1).max(100)).max(4).default([]),
  nature: z.string().min(1).max(40).nullable().default(null),
  /** Champions SP (0–32 per stat); null = unknown, which is not the same as all zero. */
  spread: SpSpreadSchema.nullable().default(null),
  /** Champions has no Terastal; kept so foreign formats round-trip. */
  tera: z.string().nullable().optional(),
  completeness: TeamMemberCompletenessSchema.optional(),
});
export type TeamMemberDoc = z.infer<typeof TeamMemberDocSchema>;

export const TeamDocSchema = z.object({
  schema_version: z.literal(1),
  format: FormatIdSchema,
  /** Null for a hand-built team; collected teams carry the season/rule they were observed under. */
  season: z.string().min(1).nullable().default(null),
  rule: z.string().min(1).nullable().default(null),
  pokemon: z.array(TeamMemberDocSchema).min(1).max(6),
  /** Real-team fact tags for collected teams; null for anything a user built or imported. */
  provenance: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type TeamDoc = z.infer<typeof TeamDocSchema>;
