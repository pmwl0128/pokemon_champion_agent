/** Image resolution over the shipped asset pack (design §12): components ask by canonical
 * key + role; the three-tier semantics (exact / base_fallback / placeholder) surface to the
 * UI and are never disguised. */
import {
  AssetManifestSchema, buildAssetIndex, resolveAsset,
  type AssetIndex, type AssetRole,
} from "@pokemon-champions/protocol";

let indexPromise: Promise<AssetIndex> | null = null;
let projectionBase = "/projection";

export function configureAssets(base: string): void {
  projectionBase = base;
}

function assetIndex(): Promise<AssetIndex> {
  if (!indexPromise) {
    const p = fetch(`${projectionBase}/assets/manifest.json`)
      .then((r) => {
        // A 404 is a definitive "no pack shipped" — cache the empty index (placeholders). Any
        // OTHER failure (network blip, 5xx, parse) must NOT be cached as empty, or a single
        // transient error downgrades every image to a placeholder for the whole session.
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`asset manifest: ${r.status}`);
        return r.json();
      })
      .then((doc): AssetIndex =>
        doc === null ? new Map() : buildAssetIndex(AssetManifestSchema.parse(doc)));
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
  const resolved = resolveAsset(await assetIndex(), key, role);
  if (resolved.tier === "placeholder") return { tier: "placeholder", url: null };
  return { tier: resolved.tier, url: `${projectionBase}/assets/${resolved.file.path}` };
}
