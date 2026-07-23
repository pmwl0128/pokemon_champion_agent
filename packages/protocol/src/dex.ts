/**
 * Dex-facing Web DTOs. Mapped from `champdex.py` JSON output by the backend mapper;
 * components consume ONLY these shapes, never the raw CLI JSON (apps/design.md §3).
 */
import { z } from "zod";
import {
  MoveCategorySchema, STAT_KEYS, StatsSchema, TypeNameSchema, namedFields,
} from "./common.ts";

/** Trilingual entity reference (name = canonical English join key). */
export const NamedRefSchema = z.object({ ...namedFields });
export type NamedRef = z.infer<typeof NamedRefSchema>;

export const PokemonCardDtoSchema = z.object({
  /** Asset-pack key (`pokemon:<slug>`) — feed straight into the image resolver. */
  key: z.string().regex(/^pokemon:[a-z0-9-]+$/),
  ...namedFields,
  slug: z.string().min(1),
  nationalDex: z.number().int().positive(),
  types: z.array(TypeNameSchema).min(1).max(2),
  stats: StatsSchema,
  /** Trilingual — surfaced in the hero bar, so localized names are part of the card. */
  abilities: z.array(NamedRefSchema),
  isMega: z.boolean(),
  baseSpecies: z.string().optional(),
  requiredItem: z.string().nullable().optional(),
  megaForms: z.array(z.object({
    name: z.string(),
    requiredItem: z.string().nullable(),
  })).optional(),
});
export type PokemonCardDto = z.infer<typeof PokemonCardDtoSchema>;

/** A pokemon's learnable-move table (static dex data; served from the projection on both
 * runtimes, one lazy file per pokemon). */
export const LearnsetDtoSchema = z.object({
  slug: z.string().min(1),
  moves: z.array(z.object({
    ...namedFields,
    type: TypeNameSchema,
    category: MoveCategorySchema,
    power: z.number().int().nullable(),
    accuracy: z.number().nullable(),
  })),
});
export type LearnsetDto = z.infer<typeof LearnsetDtoSchema>;

/** Trilingual effect/description texts (effects_seed.py sources: 52poke zh, Serebii en,
 * yakkun ja). `effect` (en) is the canonical fallback; a MOVE with no `effectZh` is
 * 52poke's "no secondary effect" convention, not missing data. */
const effectFields = {
  effect: z.string().optional(),
  effectZh: z.string().optional(),
  effectJa: z.string().optional(),
};

export const MoveDtoSchema = z.object({
  ...namedFields,
  type: TypeNameSchema,
  category: MoveCategorySchema,
  power: z.number().int().nullable(),
  accuracy: z.number().nullable(),
  priority: z.number().int(),
  pp: z.number().int().nullable(),
  ...effectFields,
});
export type MoveDto = z.infer<typeof MoveDtoSchema>;

export const ItemDtoSchema = z.object({
  /** Asset-pack key (`item:<slug>`). */
  key: z.string().regex(/^item:[a-z0-9-]+$/),
  ...namedFields,
  /** Mega stone holders etc. — empty for generic items. */
  requiredBy: z.array(z.string()).optional(),
  /** 52poke section taxonomy: battle | type_boost | berry | mega_stone. */
  category: z.enum(["battle", "type_boost", "berry", "mega_stone"]).optional(),
  ...effectFields,
});
export type ItemDto = z.infer<typeof ItemDtoSchema>;

export const AbilityDtoSchema = z.object({ ...namedFields, ...effectFields });
export type AbilityDto = z.infer<typeof AbilityDtoSchema>;

export const NatureDtoSchema = z.object({
  ...namedFields,
  upStat: z.enum(STAT_KEYS).nullable(),
  downStat: z.enum(STAT_KEYS).nullable(),
});
export type NatureDto = z.infer<typeof NatureDtoSchema>;

/** One entry of the dex `resolve` command (conventions §7): 1:1 with the queried names,
 * misses included — the AI/UI-facing name normalizer. */
export const ResolveEntryDtoSchema = z.object({
  query: z.string(),
  ok: z.boolean(),
  kind: z.enum(["pokemon", "move", "ability", "item", "nature"]),
  canonical: z.string().optional(),
  displayName: z.string().optional(),
  displayNameJa: z.string().optional(),
  matchType: z.enum(["exact", "mega_compose", "fuzzy", "ambiguous"]).nullable(),
  score: z.number().optional(),
  isMega: z.boolean().optional(),
  baseSpecies: z.string().optional(),
  requiredItem: z.string().nullable().optional(),
  suggestions: z.array(z.string()).optional(),
});
export type ResolveEntryDto = z.infer<typeof ResolveEntryDtoSchema>;
