/** Original vector assets bundled with the UI (design §12): type/category icons and
 * placeholders import straight from frontend/assets — the SPA build inlines/hashes them. */
const typeIconModules = import.meta.glob("../../../assets/type-icons/types/*.svg", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;
const categoryIconModules = import.meta.glob("../../../assets/type-icons/categories/*.svg", {
  eager: true, query: "?url", import: "default",
}) as Record<string, string>;

function byStem(mods: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(mods)) {
    const stem = path.split("/").pop()!.replace(".svg", "");
    out[stem] = url;
  }
  return out;
}

const TYPE_ICONS = byStem(typeIconModules);
const CATEGORY_ICONS = byStem(categoryIconModules);

// Canonical type colors come from the icon pack's index (the same file that defines the SVGs),
// so the pack's color and the UI's type ink can never drift apart.
import typeIconIndex from "../../../assets/type-icons/index.json";
const TYPE_COLORS: Record<string, string> = Object.fromEntries(
  Object.entries((typeIconIndex as { types: Record<string, { color: string }> }).types)
    .map(([key, meta]) => [key, meta.color]));

/** Canonical type color (lowercase key); falls back to the neutral typeless ink. */
export function typeColor(type: string): string {
  return TYPE_COLORS[type.toLowerCase()] ?? "#68A090";
}

/** Lowercase canonical key (design §12: resolvers lowercase first). */
export function typeIconUrl(type: string): string | undefined {
  return TYPE_ICONS[type.toLowerCase()];
}

export function categoryIconUrl(category: string): string | undefined {
  return CATEGORY_ICONS[category.toLowerCase()];
}

import pokemonPlaceholder from "../../../assets/placeholders/pokemon.svg?url";
import itemPlaceholder from "../../../assets/placeholders/item.svg?url";
import genericPlaceholder from "../../../assets/placeholders/generic.svg?url";
import brandLogo from "../../../assets/brand/logo.svg?url";

export const PLACEHOLDERS = {
  pokemon: pokemonPlaceholder,
  item: itemPlaceholder,
  generic: genericPlaceholder,
} as const;
export const BRAND_LOGO = brandLogo;
