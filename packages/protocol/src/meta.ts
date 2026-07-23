/**
 * Meta-facing Web DTOs (rankings, detail panels, rank trend). Mapped from `meta_query.py`
 * JSON and the shipped trend store by the backend mapper. Panel names arrive from the raw
 * source in zh/ja; the mapper resolves the canonical English `name` through the dex — the
 * DTO always carries the English join key (conventions §4).
 */
import { z } from "zod";
import {
  FormatIdSchema, MoveCategorySchema, SpSpreadSchema, TypeNameSchema, namedFields,
} from "./common.ts";

export const RankRowDtoSchema = z.object({
  rank: z.number().int().positive(),
  slug: z.string().min(1),
  ...namedFields,
});
export type RankRowDto = z.infer<typeof RankRowDtoSchema>;

export const RankingDtoSchema = z.object({
  season: z.string().min(1),
  rule: z.string().min(1),
  format: FormatIdSchema,
  updatedAt: z.string().optional(),
  rows: z.array(RankRowDtoSchema),
});
export type RankingDto = z.infer<typeof RankingDtoSchema>;

/** Percentages are 0-100 floats (conventions §2); partners carry NO percentage upstream. */
const panelEntryFields = {
  rank: z.number().int().positive(),
  ...namedFields,
  percentage: z.number().min(0).max(100).nullable(),
} as const;

export const PanelEntryDtoSchema = z.object(panelEntryFields);
export type PanelEntryDto = z.infer<typeof PanelEntryDtoSchema>;

/** Item panel entries additionally carry the asset-pack key derived by the mapper, so the UI
 * never re-slugifies the name to find the sprite. */
export const ItemPanelEntryDtoSchema = z.object({
  ...panelEntryFields,
  key: z.string().regex(/^item:[a-z0-9-]+$/),
});
export type ItemPanelEntryDto = z.infer<typeof ItemPanelEntryDtoSchema>;

export const MovePanelEntryDtoSchema = z.object({
  ...panelEntryFields,
  type: TypeNameSchema,
  category: MoveCategorySchema,
  power: z.number().int().nullable(),
});
export type MovePanelEntryDto = z.infer<typeof MovePanelEntryDtoSchema>;

export const PartnerEntryDtoSchema = z.object({
  rank: z.number().int().positive(),
  ...namedFields,
  slug: z.string().optional(),
  nationalDex: z.number().int().positive().optional(),
});
export type PartnerEntryDto = z.infer<typeof PartnerEntryDtoSchema>;

export const SpreadEntryDtoSchema = z.object({
  rank: z.number().int().positive(),
  spread: SpSpreadSchema,
  percentage: z.number().min(0).max(100).nullable(),
});
export type SpreadEntryDto = z.infer<typeof SpreadEntryDtoSchema>;

export const MetaDetailDtoSchema = z.object({
  rank: z.number().int().positive().nullable(),
  slug: z.string().min(1),
  ...namedFields,
  format: FormatIdSchema,
  season: z.string().min(1),
  rule: z.string().min(1),
  panels: z.object({
    moves: z.array(MovePanelEntryDtoSchema),
    items: z.array(ItemPanelEntryDtoSchema),
    abilities: z.array(PanelEntryDtoSchema),
    natures: z.array(PanelEntryDtoSchema),
    partners: z.array(PartnerEntryDtoSchema),
    spreads: z.array(SpreadEntryDtoSchema),
  }),
});
export type MetaDetailDto = z.infer<typeof MetaDetailDtoSchema>;

/** Rank-trend store projection: one series per tracked pokemon, `ranks[i]` aligned with
 * `periods[i]` (null = outside the tracked window that period). */
export const TrendDtoSchema = z.object({
  season: z.string().min(1),
  rule: z.string().min(1),
  format: FormatIdSchema,
  periods: z.array(z.string().min(1)),
  series: z.array(z.object({
    slug: z.string().min(1),
    ...namedFields,
    ranks: z.array(z.number().int().positive().nullable()),
  })),
}).refine(
  (t) => t.series.every((s) => s.ranks.length === t.periods.length),
  { message: "every series.ranks must align 1:1 with periods" },
);
export type TrendDto = z.infer<typeof TrendDtoSchema>;

const UsageValuesSchema = z.array(z.number().min(0).max(100).nullable());
const UsageNamedSeriesSchema = z.object({
  /** Canonical English join key; the visible label comes from the current detail row. */
  name: z.string().min(1),
  values: UsageValuesSchema,
});
const UsageSpreadSeriesSchema = z.object({
  spread: SpSpreadSchema,
  values: UsageValuesSchema,
});

/** Lazy per-Pokemon history for the five usage panels. Every values array aligns 1:1 with
 * periods; null means that entry was outside the upstream Top 10, never zero usage. */
export const UsageTrendDtoSchema = z.object({
  season: z.string().min(1),
  rule: z.string().min(1),
  format: FormatIdSchema,
  slug: z.string().min(1),
  periods: z.array(z.string().min(1)).max(10),
  panels: z.object({
    moves: z.array(UsageNamedSeriesSchema),
    items: z.array(UsageNamedSeriesSchema),
    abilities: z.array(UsageNamedSeriesSchema),
    natures: z.array(UsageNamedSeriesSchema),
    spreads: z.array(UsageSpreadSeriesSchema),
  }),
}).refine((t) => {
  const expected = t.periods.length;
  return [
    ...t.panels.moves, ...t.panels.items, ...t.panels.abilities,
    ...t.panels.natures, ...t.panels.spreads,
  ].every((series) => series.values.length === expected);
}, { message: "every usage series must align 1:1 with periods" });
export type UsageTrendDto = z.infer<typeof UsageTrendDtoSchema>;
