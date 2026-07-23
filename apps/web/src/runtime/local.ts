/** LocalAdapter: the bridge API (pcui serve). Handles the #bootstrap=<token> fragment once
 * (token -> HttpOnly cookie, then scrubbed from the URL); dev mode injects the CLI secret
 * via the vite proxy instead. Zod-validates every response at the boundary (design §3). */
import {
  ActualMatchupResponseDtoSchema, ArtifactAppendEventDtoSchema, CapabilitiesSchema,
  DamageBatchResultDtoSchema,
  DamageResultDtoSchema, MetaDetailDtoSchema,
  OppCacheDtoSchema, OppCheckGridDtoSchema, OppKoGridDtoSchema, PokemonCardDtoSchema,
  RankingDtoSchema, ResolveEntryDtoSchema, SessionDtoSchema, SessionWithLedgerDtoSchema,
  SpeedBatchResultDtoSchema, TrendDtoSchema, TuneResultDtoSchema, UsageTrendDtoSchema,
  type ActualMatchupRequestDto, type Capabilities, type DamageRequestDto, type FormatId,
  type SpeedInputDto,
} from "@pokemon-champions/protocol";
import { z } from "zod";
import {
  HttpError, fetchJson,
  type DexIndexEntry, type RuntimeAdapter, type RuntimeConfig, type SessionApi,
} from "./adapter.ts";
import { loadProjectionDexIndex } from "./online.ts";

export class LocalAdapter implements RuntimeAdapter {
  readonly runtime = "local" as const;

  constructor(private cfg: RuntimeConfig) {}

  async init(): Promise<void> {
    const match = /[#&]bootstrap=([^&]+)/.exec(location.hash);
    if (match) {
      const resp = await fetch(`${this.cfg.apiBase}/bootstrap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: match[1] }),
      });
      // Scrub the one-time token regardless — it is spent now, and leaving it in
      // history/bookmarks is worse. If the exchange failed (already-used/expired token, or a
      // StrictMode double-mount racing two POSTs of the same token), the capabilities() call
      // that follows will fail auth and RuntimeProvider surfaces an actionable message.
      history.replaceState(null, "", location.pathname + location.search);
      if (!resp.ok) console.warn(`pcui bootstrap exchange failed: ${resp.status}`);
    }
  }

  private get<T>(path: string): Promise<T> {
    return fetchJson<T>(`${this.cfg.apiBase}${path}`);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return fetchJson<T>(`${this.cfg.apiBase}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async capabilities(): Promise<Capabilities> {
    return CapabilitiesSchema.parse(await this.get("/capabilities"));
  }

  async ranking(format: FormatId, limit = 300) {
    return RankingDtoSchema.parse(
      await this.get(`/meta/ranking?format=${format}&limit=${limit}`));
  }

  async detail(format: FormatId, slug: string) {
    return MetaDetailDtoSchema.parse(
      await this.get(`/meta/detail?format=${format}&pokemon=${encodeURIComponent(slug)}`));
  }

  async trend(format: FormatId) {
    return TrendDtoSchema.parse(await this.get(`/meta/trend?format=${format}`));
  }

  async usageTrend(format: FormatId, slug: string) {
    return UsageTrendDtoSchema.parse(
      await this.get(`/meta/usage-trend?format=${format}&pokemon=${encodeURIComponent(slug)}`));
  }

  /** The browse index is projection data on BOTH runtimes (same static layer). */
  dexIndex(): Promise<DexIndexEntry[]> {
    return loadProjectionDexIndex(this.cfg.projectionBase);
  }

  async pokemonCard(nameOrSlug: string) {
    return PokemonCardDtoSchema.parse(
      await this.post("/dex/pokemon", { name: nameOrSlug }));
  }

  async resolve(names: string[], kind?: string) {
    return z.array(ResolveEntryDtoSchema).parse(
      await this.post("/dex/resolve/batch", { names, kind }));
  }

  async damage(req: DamageRequestDto) {
    return DamageResultDtoSchema.parse(await this.post("/calc/damage", req));
  }

  async damageBatch(items: DamageRequestDto[]) {
    return DamageBatchResultDtoSchema.parse(await this.post("/calc/batch", { items }));
  }

  async speedBatch(items: SpeedInputDto[]) {
    return SpeedBatchResultDtoSchema.parse(await this.post("/calc/speedbatch", { items }));
  }

  async oppCache(format: FormatId) {
    return OppCacheDtoSchema.parse(await this.get(`/team/oppcache?format=${format}&view=matrix`));
  }

  async oppKo(format: FormatId) {
    return OppKoGridDtoSchema.parse(await this.get(`/team/oppcache?format=${format}&view=ko`));
  }

  async oppChecks(format: FormatId) {
    return OppCheckGridDtoSchema.parse(await this.get(`/team/oppcache?format=${format}&view=checks`));
  }

  async actualMatchup(req: ActualMatchupRequestDto) {
    return ActualMatchupResponseDtoSchema.parse(await this.post("/team/matchup", req));
  }

  /** UEP session surface (team.uep). Artifact payloads travel as verbatim text — the store's
   * round-trip guarantee ends the moment anyone re-serializes, so no JSON.parse here. */
  readonly sessions: SessionApi = {
    list: async () => z.array(SessionDtoSchema).parse(await this.get("/sessions")),
    create: async (meta) =>
      SessionDtoSchema.parse(await this.post("/sessions", { meta: meta ?? {} })),
    get: async (id) =>
      SessionWithLedgerDtoSchema.parse(await this.get(`/sessions/${encodeURIComponent(id)}`)),
    artifact: async (hash) => {
      const resp = await fetch(`${this.cfg.apiBase}/artifacts/${encodeURIComponent(hash)}`);
      if (!resp.ok) throw new HttpError(resp.status, `${resp.status} artifact ${hash}`);
      return { kind: resp.headers.get("X-Artifact-Kind") ?? "", text: await resp.text() };
    },
    putArtifact: async (sessionId, kind, payload, revision) =>
      ArtifactAppendEventDtoSchema.parse(await this.post(
        `/sessions/${encodeURIComponent(sessionId)}/artifacts`, { kind, payload, revision })),
    subscribe: (onEvent) => {
      const es = new EventSource(`${this.cfg.apiBase}/events`);
      // Default (unnamed) messages only — the server's `event: hello` greeting has a name and
      // never reaches onmessage. EventSource auto-reconnects on drop.
      es.onmessage = (ev) => {
        const parsed = ArtifactAppendEventDtoSchema.safeParse(JSON.parse(ev.data));
        if (parsed.success) onEvent(parsed.data);
      };
      return () => es.close();
    },
  };

  async tune(team: unknown, benchmarks: unknown[]) {
    return TuneResultDtoSchema.parse(
      await this.post("/team/tune", { team, benchmarks }));
  }
}
