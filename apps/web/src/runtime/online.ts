/** OnlineAdapter: the static projection (design §7.1) — rank/detail/trend/usage-trend/dex DTOs are
 * pre-mapped files served with long cache; no compute backend is required for browsing.
 * Damage/speed calc run CLIENT-SIDE in a Web Worker (lib/calc-engine), so the projection advertises
 * calc.damage/calc.speedline and the calc page works with zero backend (Path A). The opponent matchup
 * cache (team.matchup) is shipped STATIC data — a retained observed-build KO grid, no user team — so it
 * exports to the projection like ranking/detail. Precise tune (team.tune) is a deployment-optional
 * API surface; a static-only site omits that capability and degrades to the client-side quick tune. */
import {
  ActualMatchupResponseDtoSchema, BuilderJobDtoSchema, BuilderStartDtoSchema,
  CapabilitiesSchema, DamageBatchResultDtoSchema,
  DamageResultDtoSchema, DiagnoseReportDtoSchema, MetaDetailDtoSchema, OppCacheDtoSchema,
  OnlineQuotaDtoSchema, OppCheckGridDtoSchema, OppKoGridDtoSchema, PokemonCardDtoSchema,
  QaAnswerDtoSchema, RankingDtoSchema,
  SpeedBatchResultDtoSchema, TrendDtoSchema, UsageTrendDtoSchema,
  TuneResultDtoSchema,
  type ActualMatchupRequestDto, type BuilderJobDto, type BuilderRequestDto,
  type BuilderStartDto, type Capabilities,
  type DamageBatchResultDto, type DamageRequestDto, type DamageResultDto,
  type DiagnoseReportDto, type DiagnoseRequestDto, type FormatId,
  type OnlineQuotaDto, type OppCacheDto, type OppCheckGridDto, type OppKoGridDto,
  type PokemonCardDto, type QaAnswerDto,
  type QaRequestDto, type ResolveEntryDto, type SpeedBatchResultDto, type SpeedInputDto,
} from "@pokemon-champions/protocol";
import { engineDamage, engineDamageBatch, engineSpeedBatch } from "../lib/calc-engine/index.ts";
import {
  AsyncOnce, HttpError, fetchJson, versionParam,
  type BuilderApi, type DexIndexEntry, type RuntimeAdapter, type RuntimeConfig,
} from "./adapter.ts";

interface CardsFile {
  cards: PokemonCardDto[];
}

const API_ONLY_CAPABILITIES = new Set([
  "llm.qa", "llm.builder", "team.validate", "team.tune",
]);

function staticCapabilities(raw: unknown): Capabilities {
  const parsed = CapabilitiesSchema.parse(raw);
  return { ...parsed,
    capabilities: parsed.capabilities.filter((id) => !API_ONLY_CAPABILITIES.has(id)) };
}

// Single fetch + Zod-validate of cards.json, shared by the browse index AND the card lookup
// (they were two independent loads with different validation — the index skipped Zod).
const cardsOnce = new AsyncOnce<PokemonCardDto[]>();
function loadCards(base: string): Promise<PokemonCardDto[]> {
  return cardsOnce.get(() =>
    fetchJson<CardsFile>(`${base}/dex/cards.json${versionParam()}`).then((f) =>
      f.cards.map((c) => PokemonCardDtoSchema.parse(c))));
}

const dexIndexOnce = new AsyncOnce<DexIndexEntry[]>();

export function loadProjectionDexIndex(base: string): Promise<DexIndexEntry[]> {
  return dexIndexOnce.get(() =>
    loadCards(base).then((cards) => cards.map((c) => ({
      key: c.key, slug: c.slug, name: c.name,
      ...(c.nameZh !== undefined ? { nameZh: c.nameZh } : {}),
      ...(c.nameJa !== undefined ? { nameJa: c.nameJa } : {}),
      nationalDex: c.nationalDex, types: c.types, stats: c.stats,
      abilities: c.abilities, isMega: c.isMega,
      ...(c.baseSpecies !== undefined ? { baseSpecies: c.baseSpecies } : {}),
    }))));
}

export class OnlineAdapter implements RuntimeAdapter {
  readonly runtime = "online" as const;
  private cards = new AsyncOnce<Map<string, PokemonCardDto>>();

  constructor(private cfg: RuntimeConfig) {}

  // Content URLs carry the deployment version (cache-bust, see versionParam). The identity files
  // (capabilities/manifest) are fetched no-store BEFORE the handshake sets the version, so they never
  // pick up the param — exactly what we want (they must stay unversioned + uncached).
  private url(path: string): string {
    return `${this.cfg.projectionBase}${path}${versionParam()}`;
  }

  /** Lookup map: slug, lowercased English, and the trilingual names all key the same card, so
   * pokemonCard() accepts zh/ja names like the bridge's dex resolver does (not slug-only). */
  private cardMap(): Promise<Map<string, PokemonCardDto>> {
    return this.cards.get(() =>
      loadCards(this.cfg.projectionBase).then((cards) => {
        const map = new Map<string, PokemonCardDto>();
        for (const card of cards) {
          map.set(card.slug, card);
          map.set(card.name.toLowerCase(), card);
          if (card.nameZh) map.set(card.nameZh, card);
          if (card.nameJa) map.set(card.nameJa, card);
        }
        return map;
      }));
  }

  async capabilities(): Promise<Capabilities> {
    // A live API merges its runtime-only surfaces (QA/diagnose/builder) into the immutable
    // projection identity. Static-only hosting has no such endpoint and cleanly falls back to the
    // projection document, preserving the zero-backend browsing/calculator deployment.
    try {
      return CapabilitiesSchema.parse(
        await fetchJson(`${this.cfg.apiBase}/capabilities`, { cache: "no-store" }));
    } catch (error) {
      if (error instanceof HttpError && error.status !== 404 && error.status < 500) throw error;
      if (!(error instanceof HttpError) && !(error instanceof SyntaxError)
        && !(error instanceof TypeError)) throw error;
    }
    // no-store: identity/handshake file, must not be read from a stale heuristic cache (see the
    // manifest drift check in context.tsx). Content files below stay cacheable.
    return staticCapabilities(
      await fetchJson(this.url("/capabilities.json"), { cache: "no-store" }));
  }

  async ranking(format: FormatId, limit = 300) {
    // The projection ships the full ranking; honor `limit` so this matches the local adapter
    // (which passes it to the CLI) instead of silently returning all rows.
    const doc = RankingDtoSchema.parse(await fetchJson(this.url(`/meta/ranking_${format}.json`)));
    return limit < doc.rows.length ? { ...doc, rows: doc.rows.slice(0, limit) } : doc;
  }

  async detail(format: FormatId, slug: string) {
    return MetaDetailDtoSchema.parse(
      await fetchJson(this.url(`/meta/detail_${format}/${slug}.json`)));
  }

  async trend(format: FormatId) {
    return TrendDtoSchema.parse(await fetchJson(this.url(`/meta/trend_${format}.json`)));
  }

  async usageTrend(format: FormatId, slug: string) {
    return UsageTrendDtoSchema.parse(
      await fetchJson(this.url(`/meta/usage_trend_${format}/${slug}.json`)));
  }

  dexIndex(): Promise<DexIndexEntry[]> {
    return loadProjectionDexIndex(this.cfg.projectionBase);
  }

  async pokemonCard(nameOrSlug: string): Promise<PokemonCardDto> {
    const map = await this.cardMap();
    const hit = map.get(nameOrSlug) ?? map.get(nameOrSlug.toLowerCase());
    if (!hit) throw new HttpError(404, `dex card: ${nameOrSlug}`);
    return hit;
  }

  /** Static-projection resolve: exact/substring match over the trilingual card names.
   * Deliberately simpler than the dex CLI's fuzzy resolver — misses stay misses. */
  async resolve(names: string[], kind?: string): Promise<ResolveEntryDto[]> {
    const k = (kind ?? "pokemon") as ResolveEntryDto["kind"];
    if (k !== "pokemon") {
      // The projection only carries pokemon cards — a non-pokemon kind can't be resolved here.
      // Return honest misses (tagged with the requested kind) instead of matching a pokemon.
      return names.map((query) => ({ query, ok: false as const, kind: k, matchType: null }));
    }
    const cards = await loadCards(this.cfg.projectionBase);
    return names.map((query) => {
      const q = query.trim().toLowerCase();
      const exact = cards.find((c) =>
        c.name.toLowerCase() === q || c.nameZh === query.trim() || c.nameJa === query.trim());
      const hit = exact ?? cards.find((c) =>
        c.name.toLowerCase().includes(q) ||
        (c.nameZh?.includes(query.trim()) ?? false) || (c.nameJa?.includes(query.trim()) ?? false));
      return hit
        ? {
            query, ok: true as const, kind: "pokemon" as const, canonical: hit.name,
            ...(hit.nameZh !== undefined ? { displayName: hit.nameZh } : {}),
            ...(hit.nameJa !== undefined ? { displayNameJa: hit.nameJa } : {}),
            matchType: hit === exact ? ("exact" as const) : ("fuzzy" as const),
          }
        : { query, ok: false as const, kind: "pokemon" as const, matchType: null };
    });
  }

  /** Client-side damage calc: the vendored NCP engine runs in a Web Worker (lib/calc-engine), so the
   * static runtime computes locally with no backend, returning the SAME DTOs the bridge's mapper does. */
  async damage(req: DamageRequestDto): Promise<DamageResultDto> {
    return DamageResultDtoSchema.parse(await engineDamage(req));
  }

  /** One attacker's moves × several defenders in a single fault-isolated batch, run in the worker. */
  async damageBatch(items: DamageRequestDto[]): Promise<DamageBatchResultDto> {
    return DamageBatchResultDtoSchema.parse(await engineDamageBatch(items));
  }

  /** A speed ladder resolved in one fault-isolated speedline batch, run in the worker. */
  async speedBatch(items: SpeedInputDto[]): Promise<SpeedBatchResultDto> {
    return SpeedBatchResultDtoSchema.parse(await engineSpeedBatch(items));
  }

  /** Opponent matchup cache: the M5 KO grid is shipped static data (retained observed builds, no team,
   * no compute), exported to the projection like ranking/detail — a format with no built cache 404s to
   * the UI's "not built" notice, matching the bridge. */
  async oppCache(format: FormatId): Promise<OppCacheDto> {
    return OppCacheDtoSchema.parse(await fetchJson(this.url(`/matchup/oppcache_${format}.json`)));
  }

  /** Lean KO overview: full damage/speed/set facts are fetched only after opening a cell. */
  async oppKo(format: FormatId): Promise<OppKoGridDto> {
    return OppKoGridDtoSchema.parse(
      await fetchJson(this.url(`/matchup/oppko_${format}.json`)));
  }

  /** Derived C2/C1/C0 check grid over that same static cache. */
  async oppChecks(format: FormatId): Promise<OppCheckGridDto> {
    return OppCheckGridDtoSchema.parse(
      await fetchJson(this.url(`/matchup/oppchecks_${format}.json`)));
  }

  async tune(team: unknown, benchmarks: unknown[]) {
    return TuneResultDtoSchema.parse(await fetchJson(`${this.cfg.apiBase}/team/tune`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ team, benchmarks }),
    }));
  }

  /** Fact QA (llm.qa): needs the API backend — only reachable when the deployment
   * advertised llm.qa in its projection capabilities (the page is hidden otherwise); the
   * backend enforces its own limits regardless. */
  async qa(req: QaRequestDto): Promise<QaAnswerDto> {
    return QaAnswerDtoSchema.parse(await fetchJson(`${this.cfg.apiBase}/qa`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }));
  }

  async actualMatchup(req: ActualMatchupRequestDto) {
    return ActualMatchupResponseDtoSchema.parse(await fetchJson(
      `${this.cfg.apiBase}/team/matchup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      }));
  }

  async quota(): Promise<OnlineQuotaDto> {
    return OnlineQuotaDtoSchema.parse(
      await fetchJson(`${this.cfg.apiBase}/quota`, { cache: "no-store" }));
  }

  /** Team diagnose (team.validate, §7.5): deterministic backend surface — free-form team
   * text in, disclosure-safe per-aspect report out. */
  async diagnose(req: DiagnoseRequestDto,
                 onReport?: (report: DiagnoseReportDto) => void): Promise<DiagnoseReportDto> {
    const url = `${this.cfg.apiBase}/team/diagnose`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/x-ndjson" },
      body: JSON.stringify(req),
    });
    if (!response.ok) throw new HttpError(response.status, `${response.status} ${url}`);
    if (!response.body) {
      return DiagnoseReportDtoSchema.parse(await response.json());
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let final: DiagnoseReportDto | null = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = done ? "" : (lines.pop() ?? "");
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as {
            type?: string; report?: unknown; status?: number; detail?: unknown;
          };
          if (event.type === "error") {
            throw new HttpError(event.status ?? 500,
              `${event.status ?? 500} ${url} — ${JSON.stringify(event.detail ?? "")}`);
          }
          if ((event.type === "report" || event.type === "done") && event.report) {
            const report = DiagnoseReportDtoSchema.parse(event.report);
            if (event.type === "report") onReport?.(report);
            else final = report;
          }
        }
        if (done) break;
      }
      if (!final) throw new HttpError(502, `502 ${url} — incomplete diagnose stream`);
      return final;
    } catch (error) {
      try { await reader.cancel(); } catch { /* transport may already be closed */ }
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, `502 ${url} — malformed diagnose stream`);
    } finally {
      reader.releaseLock();
    }
  }

  /** Builder wizard (llm.builder, design §7.3): same capability-gated backend surface as
   * qa. The job stream is EventSource sugar over the snapshot endpoint — on any transport
   * error the page falls back to polling `job()`. */
  readonly builder: BuilderApi = {
    start: async (req: BuilderRequestDto): Promise<BuilderStartDto> =>
      BuilderStartDtoSchema.parse(await fetchJson(`${this.cfg.apiBase}/builder`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      })),
    job: async (id: string): Promise<BuilderJobDto> =>
      BuilderJobDtoSchema.parse(
        await fetchJson(`${this.cfg.apiBase}/builder/jobs/${encodeURIComponent(id)}`,
                        { cache: "no-store" })),
    subscribe: (id: string, onSnapshot: (j: BuilderJobDto) => void,
                onError: () => void): (() => void) => {
      const source = new EventSource(
        `${this.cfg.apiBase}/builder/jobs/${encodeURIComponent(id)}/events`);
      source.onmessage = (e) => {
        try {
          onSnapshot(BuilderJobDtoSchema.parse(JSON.parse(e.data)));
        } catch {
          /* one malformed frame is not a dead stream */
        }
      };
      source.onerror = () => {
        source.close();
        onError();
      };
      return () => source.close();
    },
  };
}
