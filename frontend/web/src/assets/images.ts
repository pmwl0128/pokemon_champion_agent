/** Image resolution over the shipped asset pack (design §12): components ask by canonical
 * key + role; the three-tier semantics (exact / base_fallback / placeholder) surface to the
 * UI and are never disguised. */
import type { AssetRole } from "@pokemon-champions/protocol";
import { z } from "zod";

const RuntimeAssetSchema = z.object({
  key: z.string().regex(/^(pokemon|item):[a-z0-9][a-z0-9-]*$/),
  match: z.enum(["exact", "base_fallback", "placeholder"]),
  files: z.object({
    dense: z.string().regex(/^[^/].*/).optional(),
    card: z.string().regex(/^[^/].*/).optional(),
    artwork: z.string().regex(/^[^/].*/).optional(),
  }),
});
const RuntimeAssetIndexSchema = z.object({
  schema_version: z.literal("1"),
  assets: z.array(RuntimeAssetSchema),
});
type RuntimeAsset = z.infer<typeof RuntimeAssetSchema>;
type RuntimeAssetIndex = ReadonlyMap<string, RuntimeAsset>;

let indexPromise: Promise<RuntimeAssetIndex> | null = null;
let projectionBase = "/projection";

export function configureAssets(base: string): void {
  if (base !== projectionBase) indexPromise = null;
  projectionBase = base;
}

function assetIndex(): Promise<RuntimeAssetIndex> {
  if (!indexPromise) {
    const p = fetch(`${projectionBase}/assets/runtime.json`)
      .then((r) => {
        // A 404 is a definitive "no pack shipped" — cache the empty index (placeholders). Any
        // OTHER failure (network blip, 5xx, parse) must NOT be cached as empty, or a single
        // transient error downgrades every image to a placeholder for the whole session.
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`asset runtime index: ${r.status}`);
        return r.json();
      })
      .then((doc): RuntimeAssetIndex => {
        if (doc === null) return new Map();
        const parsed = RuntimeAssetIndexSchema.parse(doc);
        return new Map(parsed.assets.map((asset) => [asset.key, asset]));
      });
    p.catch(() => { if (indexPromise === p) indexPromise = null; });   // transient -> retry
    indexPromise = p;
  }
  return indexPromise;
}

export interface ResolvedImage {
  tier: "exact" | "base_fallback" | "placeholder";
  url: string | null;                 // null => render the bundled placeholder art
}

export async function resolveImage(key: string, role: AssetRole): Promise<ResolvedImage> {
  const asset = (await assetIndex()).get(key);
  if (!asset || asset.match === "placeholder") return { tier: "placeholder", url: null };
  const path = asset.files[role]
    ?? asset.files.dense ?? asset.files.card ?? asset.files.artwork;
  if (!path) return { tier: "placeholder", url: null };
  return { tier: asset.match, url: `${projectionBase}/assets/${path}` };
}
