/** A species' metagame usage as name -> share (0-100), for putting the builds people actually run at
 * the top of the move, item and nature inputs.
 *
 * The meta detail of a species carries its ten most used moves, items and natures per format. Each
 * loaded detail is turned into lookup maps once (keyed by the detail object the query cache holds,
 * so every editor showing that species shares them), and so is the singles/doubles merge a box
 * Pokémon uses. Only ranked species are asked for: the ranking says which details exist, so an
 * unranked species never costs a request that can only 404. A Mega reads its base species' usage,
 * as the metagame pages do. */
import type { FormatId, MetaDetailDto, RankingDto } from "@pokemon-champions/protocol";
import { useMemo } from "react";
import { useDetail, useDexIndex, useRanking } from "../hooks.ts";
import { dexLookup } from "./lookup.ts";

/** Name -> share (0-100). An entry the source ranks without a share holds minus its rank, so it
 * still leads the list, after every entry with a share, in the source's order. */
export interface MetaUsage {
  moves: ReadonlyMap<string, number>;
  items: ReadonlyMap<string, number>;
  natures: ReadonlyMap<string, number>;
}

const fromDetail = new WeakMap<MetaDetailDto, MetaUsage>();
const merged = new WeakMap<MetaUsage, WeakMap<MetaUsage, MetaUsage>>();
const rankedNames = new WeakMap<RankingDto, ReadonlyMap<string, string>>();

function usageOf(detail: MetaDetailDto): MetaUsage {
  let hit = fromDetail.get(detail);
  if (!hit) {
    const shares = (rows: ReadonlyArray<{ name: string; rank: number; percentage: number | null }>) =>
      new Map(rows.map((row) => [row.name, row.percentage ?? -row.rank] as const));
    hit = { moves: shares(detail.panels.moves), items: shares(detail.panels.items), natures: shares(detail.panels.natures) };
    fromDetail.set(detail, hit);
  }
  return hit;
}

/** Both formats at once (a box Pokémon belongs to neither): each name at its higher share. */
function mergeUsage(a: MetaUsage, b: MetaUsage): MetaUsage {
  let inner = merged.get(a);
  if (!inner) { inner = new WeakMap(); merged.set(a, inner); }
  let hit = inner.get(b);
  if (!hit) {
    const higher = (x: ReadonlyMap<string, number>, y: ReadonlyMap<string, number>) => {
      const out = new Map(x);
      for (const [name, share] of y) out.set(name, out.has(name) ? Math.max(share, out.get(name)!) : share);
      return out;
    };
    hit = { moves: higher(a.moves, b.moves), items: higher(a.items, b.items), natures: higher(a.natures, b.natures) };
    inner.set(b, hit);
  }
  return hit;
}

export function usageSlug(ranking: RankingDto, species: string): string {
  let hit = rankedNames.get(ranking);
  if (!hit) { hit = new Map(ranking.rows.map((row) => [row.name, row.slug])); rankedNames.set(ranking, hit); }
  return hit.get(species) ?? "";
}

export function useMetaUsage(slug: string, formats: readonly FormatId[]): MetaUsage | null {
  const dex = useDexIndex();
  const base = useMemo(() => {
    if (!slug || dex.status !== "ready") return "";
    const { bySlug } = dexLookup(dex.data);
    const entry = bySlug.get(slug);
    return entry?.isMega && entry.baseSpecies ? entry.baseSpecies : entry?.name ?? "";
  }, [slug, dex]);
  const singles = useRanking("single");
  const doubles = useRanking("double");
  const ranked = (format: FormatId) => {
    const ranking = format === "single" ? singles : doubles;
    return base && formats.includes(format) && ranking.status === "ready" ? usageSlug(ranking.data, base) : "";
  };
  const single = useDetail("single", ranked("single"));
  const double = useDetail("double", ranked("double"));
  const a = single.status === "ready" && single.data ? usageOf(single.data) : null;
  const b = double.status === "ready" && double.data ? usageOf(double.data) : null;
  return a && b ? mergeUsage(a, b) : a ?? b;
}

/** A list split for an input: the options with a share, most used first, then the rest in the
 * list's own order. */
export function splitByUsage<T>(list: readonly T[], nameOf: (item: T) => string,
                                usage: ReadonlyMap<string, number> | null | undefined) {
  if (!usage?.size) return { meta: [] as Array<{ item: T; share: number }>, rest: [...list] };
  const meta: Array<{ item: T; share: number; at: number }> = [];
  const rest: T[] = [];
  list.forEach((item, at) => {
    const share = usage.get(nameOf(item));
    if (share != null) meta.push({ item, share, at });
    else rest.push(item);
  });
  meta.sort((x, y) => y.share - x.share || x.at - y.at);
  return { meta: meta.map(({ item, share }) => ({ item, share })), rest };
}

/** "25%", "3.4%": a share as the metagame pages print it, short enough for an option row; empty for
 * an entry ranked without one. */
export function shareLabel(share: number): string {
  if (share <= 0) return "";
  return `${share >= 10 ? share.toFixed(0) : share.toFixed(1)}%`;
}
