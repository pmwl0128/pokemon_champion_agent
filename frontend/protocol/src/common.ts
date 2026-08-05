/**
 * Shared canonical vocabulary for every Web DTO — anchored to dev/conventions.md §2
 * (the four skills' CLI canonical contract). DTOs are camelCase; the backend mapper
 * translates raw skill output (snake_case) at the API boundary.
 */
import { z } from "zod";

/** Canonical type names (capitalized English, conventions §2). 18 standard + `Typeless`:
 * the dex move table really contains typeless moves, so an 18-entry enum would reject
 * legitimate move rows. */
export const TYPE_NAMES = [
  "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground",
  "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy", "Typeless",
] as const;
export const TypeNameSchema = z.enum(TYPE_NAMES);
export type TypeName = z.infer<typeof TypeNameSchema>;

export const MOVE_CATEGORIES = ["Physical", "Special", "Status"] as const;
export const MoveCategorySchema = z.enum(MOVE_CATEGORIES);
export type MoveCategory = z.infer<typeof MoveCategorySchema>;

/** frontend/assets/type-icons keys are lowercase canonical (frontend/design.md §12). */
export const typeIconKey = (t: TypeName): string => t.toLowerCase();
export const categoryIconKey = (c: MoveCategory): string => c.toLowerCase();

/** Smogon stat keys (conventions §2). */
export const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
export type StatKey = (typeof STAT_KEYS)[number];
export const StatsSchema = z.object({
  hp: z.number().int(), atk: z.number().int(), def: z.number().int(),
  spa: z.number().int(), spd: z.number().int(), spe: z.number().int(),
});
export type Stats = z.infer<typeof StatsSchema>;

/** SP spread (Champions stat points): partial, non-negative. */
export const SpSpreadSchema = z.object({
  hp: z.number().int().nonnegative(), atk: z.number().int().nonnegative(),
  def: z.number().int().nonnegative(), spa: z.number().int().nonnegative(),
  spd: z.number().int().nonnegative(), spe: z.number().int().nonnegative(),
}).partial();
export type SpSpread = z.infer<typeof SpSpreadSchema>;

export const FormatIdSchema = z.enum(["single", "double"]);
export type FormatId = z.infer<typeof FormatIdSchema>;

/** Trilingual naming: `name` is the canonical English join key (always present, conventions §4);
 * localized names are optional and never used as join keys. */
export const namedFields = {
  name: z.string().min(1),
  nameZh: z.string().optional(),
  nameJa: z.string().optional(),
} as const;

/** Unified error shape every CLI/API emits (conventions §3). `index` aligns batch items. */
export const ERROR_CODES = [
  "not_found", "unknown_move", "unknown_pokemon", "unknown_ability", "unknown_item",
  "bad_input", "unknown_format",
] as const;
export const ErrorShapeSchema = z.object({
  ok: z.literal(false),
  query: z.string().optional(),
  index: z.number().int().optional(),
  error: z.object({ code: z.enum(ERROR_CODES), message: z.string() }),
});
export type ErrorShape = z.infer<typeof ErrorShapeSchema>;
export const isErrorShape = (v: unknown): v is ErrorShape =>
  typeof v === "object" && v !== null && "error" in v;

/** Asset-pack keys (frontend/design.md §12): lowercase canonical slug of the dex name. */
export const pokemonAssetKey = (slug: string): string => `pokemon:${slug}`;
export const itemAssetKey = (slug: string): string => `item:${slug}`;
