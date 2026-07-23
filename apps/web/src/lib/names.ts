/** Trilingual lookup maps for the names that ride inside agent artifacts as English
 * canonical join keys (design §3): items and natures come from the projection vocab files,
 * abilities come from the complete projection vocabulary. Session-cached by the underlying loaders;
 * a miss falls back to the English canonical rather than hiding the value. */
import { useMemo } from "react";
import { useAbilities, useItems, useNatures } from "../hooks.ts";
import { displayName, type Lang } from "../i18n.ts";

interface Named { name: string; nameZh?: string; nameJa?: string }

export interface NameMaps {
  item: Map<string, Named>;
  nature: Map<string, Named>;
  ability: Map<string, Named>;
}

export function useNameMaps(): NameMaps {
  const items = useItems();
  const natures = useNatures();
  const abilities = useAbilities();
  return useMemo(() => {
    const item = new Map<string, Named>();
    const nature = new Map<string, Named>();
    const ability = new Map<string, Named>();
    if (items.status === "ready") for (const it of items.data) item.set(it.name, it);
    if (natures.status === "ready") for (const n of natures.data) nature.set(n.name, n);
    if (abilities.status === "ready") for (const a of abilities.data) ability.set(a.name, a);
    return { item, nature, ability };
  }, [items, natures, abilities]);
}

/** English canonical -> the current language's display name (canonical when unmapped). */
export function localName(map: Map<string, Named>, name: string, lang: Lang): string {
  const hit = map.get(name);
  return hit ? displayName(hit, lang) : name;
}
