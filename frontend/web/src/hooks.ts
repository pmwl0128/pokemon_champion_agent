/** Domain hooks: components consume DTOs through these; the RuntimeAdapter stays invisible
 * to page code (design §2 layering). */
import { useEffect, useMemo, useState } from "react";
import type {
  FormatId, MetaDetailDto, NatureDto, OppCacheDto, OppCheckGridDto, OppKoGridDto,
  PokemonCardDto, RankingDto,
  TrendDto, UsageTrendDto,
} from "@pokemon-champions/protocol";
import { HttpError, type DexIndexEntry } from "./runtime/adapter.ts";
import { useRuntime } from "./runtime/context.tsx";

export type Async<T> =
  | { status: "loading" }
  | { status: "error"; message: string; httpStatus?: number }
  | { status: "ready"; data: T };

const LOADING: Async<never> = { status: "loading" };

function sameDeps(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Async<T> {
  // Keep the dependency identity beside the result. React renders once with the NEW deps before
  // the effect runs; returning an OLD result during that render causes a visible stale-data flash.
  const [result, setResult] = useState<{ deps: unknown[]; state: Async<T> }>(
    () => ({ deps: [...deps], state: LOADING }));
  useEffect(() => {
    let cancelled = false;
    const requestDeps = [...deps];
    setResult({ deps: requestDeps, state: LOADING });
    fn().then(
      (data) => {
        if (!cancelled) setResult({ deps: requestDeps, state: { status: "ready", data } });
      },
      (e) => {
        if (!cancelled) {
          console.error("Data request failed:", e);
          setResult({
            deps: requestDeps,
            state: { status: "error", message: String(e),
                     httpStatus: e instanceof HttpError ? e.status : undefined },
          });
        }
      },
    );
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return sameDeps(result.deps, deps) ? result.state : LOADING;
}

interface QueryEntry<T> {
  promise: Promise<T>;
  state: Async<T>;
}

/** Session-scoped static-fact cache. Pending work is shared across consumers and allowed to finish
 * across route changes; a later page reuses it instead of aborting and fetching the same immutable
 * deployment data again. Rejections are evicted so revisiting retries a transient failure. Ready
 * entries use a bounded LRU: detail/card browsing is keyed per Pokemon and must not retain the whole
 * dex forever on low-memory clients. */
class QueryCache {
  private entries = new Map<string, QueryEntry<unknown>>();
  private readonly maxReady = 128;

  private touch(key: string, entry: QueryEntry<unknown>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evictReady(): void {
    while (this.entries.size > this.maxReady) {
      const victim = [...this.entries].find(([, entry]) => entry.state.status === "ready");
      if (!victim) return; // never evict in-flight work; it remains shared until it settles
      this.entries.delete(victim[0]);
    }
  }

  peek<T>(key: string): Async<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) this.touch(key, entry);
    return entry?.state as Async<T> | undefined;
  }

  get<T>(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key) as QueryEntry<T> | undefined;
    if (hit) {
      this.touch(key, hit as QueryEntry<unknown>);
      return hit.promise;
    }
    const entry: QueryEntry<T> = { promise: Promise.resolve(undefined as T), state: LOADING };
    const promise = make().then(
      (data) => {
        entry.state = { status: "ready", data };
        if (this.entries.get(key) === entry) {
          this.touch(key, entry as QueryEntry<unknown>);
          this.evictReady();
        }
        return data;
      },
      (error) => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      },
    );
    entry.promise = promise;
    this.entries.set(key, entry as QueryEntry<unknown>);
    return promise;
  }
}

const queries = new QueryCache();

function useQuery<T>(key: string, fn: () => Promise<T>, deps: unknown[]): Async<T> {
  const { capabilities } = useRuntime();
  const cacheKey = `${capabilities.deploymentId}:${key}`;
  const request = useAsync(() => queries.get(cacheKey, fn), [cacheKey, ...deps]);
  return queries.peek<T>(cacheKey) ?? request;
}

export function useRanking(format: FormatId): Async<RankingDto> {
  const { adapter } = useRuntime();
  return useQuery(`ranking:${format}`, () => adapter.ranking(format), [format, adapter]);
}

export function useDetail(format: FormatId, slug: string): Async<MetaDetailDto> {
  const { adapter } = useRuntime();
  return useQuery(`detail:${format}:${slug}`, () => adapter.detail(format, slug),
    [format, slug, adapter]);
}

export function useTrend(format: FormatId): Async<TrendDto> {
  const { adapter } = useRuntime();
  return useQuery(`trend:${format}`, () => adapter.trend(format), [format, adapter]);
}

export function useUsageTrend(format: FormatId, slug: string,
                              enabled: boolean): Async<UsageTrendDto | null> {
  const { adapter } = useRuntime();
  const key = enabled ? `usage-trend:${format}:${slug}` : `usage-trend:disabled:${format}:${slug}`;
  return useQuery(key, () => enabled ? adapter.usageTrend(format, slug) : Promise.resolve(null),
    [enabled, format, slug, adapter]);
}

export function useDexIndex(enabled = true): Async<DexIndexEntry[]> {
  const { adapter } = useRuntime();
  return useQuery(enabled ? "dex:index" : "dex:index:disabled",
    () => enabled ? adapter.dexIndex() : Promise.resolve([]), [enabled, adapter]);
}

/** English canonical name -> dex entry (types + trilingual names), memoized per index load. */
export function useDexByName(enabled = true): Map<string, DexIndexEntry> {
  const dex = useDexIndex(enabled);
  return useMemo(() => {
    const map = new Map<string, DexIndexEntry>();
    if (dex.status === "ready") for (const e of dex.data) map.set(e.name, e);
    return map;
  }, [dex]);
}

export function usePokemonCard(slug: string): Async<PokemonCardDto> {
  const { adapter } = useRuntime();
  return useQuery(`pokemon:${slug}`, () => adapter.pokemonCard(slug), [slug, adapter]);
}

export function useOppCache(format: FormatId): Async<OppCacheDto>;
export function useOppCache(format: FormatId, enabled: boolean): Async<OppCacheDto | null>;
export function useOppCache(format: FormatId, enabled = true): Async<OppCacheDto | null> {
  const { adapter } = useRuntime();
  return useQuery(enabled ? `matchup:ko:${format}` : `matchup:ko:${format}:disabled`,
    () => enabled ? adapter.oppCache(format) : Promise.resolve(null), [format, enabled, adapter]);
}

export function useOppKo(format: FormatId): Async<OppKoGridDto> {
  const { adapter } = useRuntime();
  return useQuery(`matchup:ko-overview:${format}`, () => adapter.oppKo(format), [format, adapter]);
}

export function useOppChecks(format: FormatId): Async<OppCheckGridDto> {
  const { adapter } = useRuntime();
  return useQuery(`matchup:checks:${format}`, () => adapter.oppChecks(format), [format, adapter]);
}

// -- global vocab lookup maps (entity hover cards, dex browse) ------------------------------

import {
  loadAbilities, loadItems, loadMoves, loadNatures,
  type AbilityRef, type ItemRef, type MoveRef,
}
  from "./runtime/projection.ts";

export function useMoves(enabled = true): Async<MoveRef[]> {
  return useQuery(enabled ? "vocab:moves" : "vocab:moves:disabled",
    () => enabled ? loadMoves() : Promise.resolve([]), [enabled]);
}

export function useAbilities(enabled = true): Async<AbilityRef[]> {
  return useQuery(enabled ? "vocab:abilities" : "vocab:abilities:disabled",
    () => enabled ? loadAbilities() : Promise.resolve([]), [enabled]);
}

export function useItems(enabled = true): Async<ItemRef[]> {
  return useQuery(enabled ? "vocab:items" : "vocab:items:disabled",
    () => enabled ? loadItems() : Promise.resolve([]), [enabled]);
}

export function useNatures(enabled = true): Async<NatureDto[]> {
  return useQuery(enabled ? "vocab:natures" : "vocab:natures:disabled",
    () => enabled ? loadNatures() : Promise.resolve([]), [enabled]);
}

/** English-canonical -> MoveRef over the projection's full move vocabulary. */
export function useMovesByName(enabled = true): Map<string, MoveRef> {
  const moves = useMoves(enabled);
  return useMemo(() => {
    const map = new Map<string, MoveRef>();
    if (moves.status === "ready") for (const m of moves.data) map.set(m.name, m);
    return map;
  }, [moves]);
}

/** English-canonical -> AbilityRef over the projection's ability vocabulary. */
export function useAbilitiesByName(enabled = true): Map<string, AbilityRef> {
  const abilities = useAbilities(enabled);
  return useMemo(() => {
    const map = new Map<string, AbilityRef>();
    if (abilities.status === "ready") for (const a of abilities.data) map.set(a.name, a);
    return map;
  }, [abilities]);
}

/** English-canonical -> ItemRef over the projection's item vocabulary. */
export function useItemsByName(enabled = true): Map<string, ItemRef> {
  const items = useItems(enabled);
  return useMemo(() => {
    const map = new Map<string, ItemRef>();
    if (items.status === "ready") for (const i of items.data) map.set(i.name, i);
    return map;
  }, [items]);
}
