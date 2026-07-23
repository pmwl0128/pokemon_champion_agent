/**
 * Image asset-pack contract (apps/design.md §12): TypeScript mirror of
 * apps/assets/asset-manifest.schema.json — field names stay snake_case because this schema
 * validates the manifest FILE as shipped, not a mapped DTO. Includes the resolver's
 * three-tier match semantics: `exact` / `base_fallback` / `placeholder`, never disguised.
 */
import { z } from "zod";

export const MatchTierSchema = z.enum(["exact", "base_fallback", "placeholder"]);
export type MatchTier = z.infer<typeof MatchTierSchema>;

export const ASSET_ROLES = ["dense", "card", "artwork"] as const;
export type AssetRole = (typeof ASSET_ROLES)[number];

export const AssetFileSchema = z.object({
  path: z.string().regex(/^[^/].*/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  media_type: z.enum(["image/png", "image/webp", "image/avif", "image/svg+xml"]),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  bytes: z.number().int().positive(),
});
export type AssetFile = z.infer<typeof AssetFileSchema>;

export const ManifestAssetSchema = z.object({
  key: z.string().regex(/^(pokemon|item):[a-z0-9][a-z0-9-]*$/),
  kind: z.enum(["pokemon", "item"]),
  national_dex: z.number().int().positive().optional(),
  form_key: z.string().min(1).optional(),
  match: MatchTierSchema,
  fallback_for: z.string().regex(/^(pokemon|item):[a-z0-9][a-z0-9-]*$/).optional(),
  files: z.object({
    dense: AssetFileSchema.optional(),
    card: AssetFileSchema.optional(),
    artwork: AssetFileSchema.optional(),
  }).refine((f) => f.dense || f.card || f.artwork, { message: "at least one file role" }),
  provenance: z.object({
    provider: z.string().min(1),
    source_url: z.string(),
    revision: z.string().optional(),
    retrieved_at: z.string(),
    license: z.string().optional(),
    attribution: z.string().optional(),
    rights_note: z.string().min(1),
  }),
});
export type ManifestAsset = z.infer<typeof ManifestAssetSchema>;

export const AssetManifestSchema = z.object({
  schema_version: z.literal("1"),
  asset_pack_version: z.string().min(1),
  deployment_id: z.string().min(1),
  generated_at: z.string(),
  assets: z.array(ManifestAssetSchema),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export type AssetIndex = ReadonlyMap<string, ManifestAsset>;

export const buildAssetIndex = (manifest: AssetManifest): AssetIndex =>
  new Map(manifest.assets.map((a) => [a.key, a]));

export type ResolvedAsset =
  | { tier: "exact" | "base_fallback"; asset: ManifestAsset; file: AssetFile }
  | { tier: "placeholder" };

/** Resolve an asset key to a file for the requested role (falls back down the role ladder:
 * dense -> card -> artwork). A key absent from the manifest IS the placeholder tier — the
 * caller renders the original placeholder art and never guesses a file. */
export function resolveAsset(index: AssetIndex, key: string, role: AssetRole): ResolvedAsset {
  const asset = index.get(key);
  if (!asset || asset.match === "placeholder") return { tier: "placeholder" };
  const file = asset.files[role] ?? asset.files.dense ?? asset.files.card ?? asset.files.artwork;
  if (!file) return { tier: "placeholder" };
  return { tier: asset.match, asset, file };
}
