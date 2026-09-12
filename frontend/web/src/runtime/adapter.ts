/** RuntimeAdapter — the ONLY seam between the UI and a deployment (design §2). Components
 * never fetch or branch on runtime; they consume DTOs through domain hooks that call this
 * interface. Both implementations validate at the boundary with the protocol package. */
import type {
  ActualMatchupRequestDto, ActualMatchupResponseDto, ArtifactAppendEventDto, BuilderJobDto,
  BuilderRequestDto, BuilderStartDto, Capabilities,
  DamageBatchResultDto, DamageRequestDto, DamageResultDto, DiagnoseReportDto,
  DiagnoseRequestDto, FormatId, MetaDetailDto, OppCacheDto, OppCheckGridDto, OppKoGridDto,
  PokemonCardDto,
  OnlineQuotaDto, QaAnswerDto, QaRequestDto, RankingDto, ResolveEntryDto, SessionDto, SessionWithLedgerDto,
  SpeedBatchResultDto, SpeedInputDto, TrendDto, TuneResultDto, UsageTrendDto,
} from "@pokemon-champions/protocol";

/** Lightweight dex-browse entry (projection-only shape: full cards stay lazy). */
export interface DexIndexEntry {
  key: string;
  slug: string;
  name: string;
  nameZh?: string;
  nameJa?: string;
  nationalDex: number;
  types: string[];
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
  abilities: Array<{ name: string; nameZh?: string; nameJa?: string }>;
  isMega: boolean;
  baseSpecies?: string;   // the species this entry is a form of (Mega, regional, appearance, ...)
}

/** Local-only UEP session surface (design §4.2/§6). Artifacts are OPAQUE text here: the
 * store round-trips the exact bytes the agent submitted, so the panel renders best-effort
 * and never re-serializes. Only the LocalAdapter provides this — the interface member stays
 * optional so the OnlineAdapter never carries reject-stubs for a surface it cannot have. */
export interface SessionApi {
  list(): Promise<SessionDto[]>;
  create(meta?: Record<string, unknown>): Promise<SessionDto>;
  get(id: string): Promise<SessionWithLedgerDto>;
  /** Raw artifact payload, verbatim (kind comes from the X-Artifact-Kind header). */
  artifact(hash: string): Promise<{ kind: string; text: string }>;
  /** CAS append under the revision the caller saw; a 409 HttpError means re-read and retry. */
  putArtifact(sessionId: string, kind: string, payload: string,
              revision: number): Promise<ArtifactAppendEventDto>;
  /** SSE feed of committed appends (all sessions); returns the unsubscribe function. */
  subscribe(onEvent: (e: ArtifactAppendEventDto) => void): () => void;
}

/** Online-only builder wizard (llm.builder, design §7.3): one form -> a queued server-side
 * job -> one confirmed team. The client holds only the job id and read-only progress. */
export interface BuilderApi {
  start(req: BuilderRequestDto): Promise<BuilderStartDto>;
  job(id: string): Promise<BuilderJobDto>;
  /** SSE feed of job snapshots; returns the unsubscribe function. On transport failure the
   * caller falls back to polling `job()` — the stream is progress sugar, not the contract. */
  subscribe(id: string, onSnapshot: (j: BuilderJobDto) => void,
            onError: () => void): () => void;
}

export interface RuntimeAdapter {
  readonly runtime: "local" | "online";
  capabilities(): Promise<Capabilities>;
  ranking(format: FormatId, limit?: number): Promise<RankingDto>;
  detail(format: FormatId, slug: string): Promise<MetaDetailDto>;
  trend(format: FormatId): Promise<TrendDto>;
  usageTrend(format: FormatId, slug: string): Promise<UsageTrendDto>;
  dexIndex(): Promise<DexIndexEntry[]>;
  pokemonCard(nameOrSlug: string): Promise<PokemonCardDto>;
  resolve(names: string[], kind?: string): Promise<ResolveEntryDto[]>;
  damage(req: DamageRequestDto): Promise<DamageResultDto>;
  /** One attacker's moves × several defenders in a single fault-isolated batch (calc runtime only). */
  damageBatch(items: DamageRequestDto[]): Promise<DamageBatchResultDto>;
  /** A speed ladder (my mon + opponents) in one fault-isolated batch (calc runtime only). */
  speedBatch(items: SpeedInputDto[]): Promise<SpeedBatchResultDto>;
  /** Opponent standard-set KO matrix (team.matchup). Shipped STATIC cache — served by the bridge live
   * and exported to the online projection too (the online cut omits `sets`; see matchup.ts). */
  oppCache(format: FormatId): Promise<OppCacheDto>;
  /** Lean default-page KO verdicts; full cell facts stay lazy in `oppCache`. */
  oppKo(format: FormatId): Promise<OppKoGridDto>;
  /** Derived C2/C1/C0 check grid over the same matrix (both runtimes, same static cache). */
  oppChecks(format: FormatId): Promise<OppCheckGridDto>;
  /** User-registered sets vs a freely selected 1..60 usage target field. The request accepts
   * structured team-json or free-form text and returns the server-normalized source team. */
  actualMatchup(req: ActualMatchupRequestDto): Promise<ActualMatchupResponseDto>;
  /** Authoritative SP cliff cards from the team skill's `tune` operator. Online availability is
   * capability-gated and workload-limited; `team` is team-json and `benchmarks` are cliff targets. */
  tune(team: unknown, benchmarks: unknown[]): Promise<TuneResultDto>;
  /** UEP session store — LocalAdapter only (team.uep); absent on the online runtime. */
  readonly sessions?: SessionApi;
  /** Online-only fact QA (llm.qa, design §7.2): one question, one tool-grounded answer, no
   * history. Absent on the local runtime — a local user has a real agent instead. */
  qa?(req: QaRequestDto): Promise<QaAnswerDto>;
  /** Read-only daily usage for all public model surfaces. */
  quota?(): Promise<OnlineQuotaDto>;
  /** Online-only builder wizard (llm.builder, design §7.3). Absent on the local runtime —
   * a local user has the full UEP session panel and a real agent instead. */
  readonly builder?: BuilderApi;
  /** Online-only team diagnose (team.validate, §7.5 deterministic surface): free-form
   * team text -> parse -> validate + diagnose report. Zero LLM, rate-limited. */
  diagnose?(req: DiagnoseRequestDto,
            onReport?: (report: DiagnoseReportDto) => void): Promise<DiagnoseReportDto>;
}

export interface RuntimeConfig {
  runtime: "local" | "online";
  apiBase: string;
  projectionBase: string;
}

/** HTTP failure carrying the status code, so callers can tell a 404 (e.g. "not ranked this
 * period" — a fact) from a 401 (auth) or a 5xx (real failure) instead of parsing a string. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

let projectionVersion = "";
/** Set once, post-handshake, to the resolved deploymentId (both runtimes). */
export function setProjectionVersion(v: string): void { projectionVersion = v; }
/** Cache-bust suffix for stable-URL projection CONTENT
 * (ranking/detail/trend/usage-trend/cards/learnset/matchup),
 * which design §7.1 serves under a long cache. Without it a browser can pair a fresh capabilities +
 * manifest (both no-store) with a STALE long-cached content file and still pass the identity check
 * (external audit 2026-07-14). Empty until the handshake sets it — and the identity files are no-store
 * and fetched BEFORE it, so they never carry the param. */
export function versionParam(): string {
  return projectionVersion ? `?v=${encodeURIComponent(projectionVersion)}` : "";
}

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    let detail = "";
    try {
      detail = JSON.stringify((await resp.json()).detail ?? "");
    } catch { /* non-JSON error body */ }
    throw new HttpError(resp.status, `${resp.status} ${url}${detail ? ` — ${detail}` : ""}`);
  }
  return (await resp.json()) as T;
}

/** Single-flight promise cache that DROPS a rejected result so a transient failure can be
 * retried instead of poisoning the cache for the whole session (a page reload was otherwise
 * the only recovery). Success is cached for the session as before. */
export class AsyncOnce<T> {
  private pending: Promise<T> | null = null;
  get(make: () => Promise<T>): Promise<T> {
    if (!this.pending) {
      const p = make();
      this.pending = p;
      p.catch(() => { if (this.pending === p) this.pending = null; });
    }
    return this.pending;
  }
}
