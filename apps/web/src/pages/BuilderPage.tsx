/** Builder wizard (llm.builder, design §7.3): ONE static form -> a queued server-side job
 * running the full UEP gate chain -> ONE team + correctness confirmation (validate badge +
 * answer-audit pass) + disclosed profile defaults. No candidate comparison, no mid-run
 * questions, no history — the page holds only the job id and read-only progress; a reload
 * simply forgets the run (results live 15 minutes server-side). Online runtime only:
 * route/nav are capability-gated and this chunk is lazy — a deployment without the builder
 * backend never downloads it. */
import {
  BUILDER_GATES, BUILDER_TACTICS,
  type BuilderGateDto, type BuilderJobDto, type BuilderRequestDto,
  type MatchupThreatAssessmentDto, type OppSetDto,
} from "@pokemon-champions/protocol";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { FormatId } from "@pokemon-champions/protocol";
import { EntityHover } from "../components/EntityHover.tsx";
import { FormatTabs } from "../components/FormatTabs.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId }
  from "../components/SegmentedControl.tsx";
import { ThinkingToggle } from "../components/ThinkingToggle.tsx";
import { useDexByName, useDexIndex, useOppCache } from "../hooks.ts";
import { displayName, optionalKey, useLang, useT } from "../i18n.ts";
import { useProseRenderer } from "../lib/prose.tsx";
import {
  readTeamMembers, rememberMatchupSource, stashDamageFill, stashMatchupFill,
} from "../lib/team.ts";
import { HttpError, type DexIndexEntry } from "../runtime/adapter.ts";
import { useRuntime } from "../runtime/context.tsx";
import { DiagnoseTab } from "./DiagnoseTab.tsx";
import { slugify } from "./uep/MonChip.tsx";
import { TeamCard } from "./uep/TeamCard.tsx";

type StartError =
  | { kind: "limit" | "busy" | "unavailable" | "generic" }
  | { kind: "unresolved"; names: string };

/** POST /api/builder failures ride in HttpError's message (fetchJson keeps the body's
 * `detail` verbatim there) — enough to pick the right copy without a second wire shape. */
function startError(e: unknown): StartError {
  if (!(e instanceof HttpError)) return { kind: "generic" };
  if (e.status === 429) {
    return { kind: e.message.includes("rate_limited") ? "limit" : "busy" };
  }
  if (e.status === 503) return { kind: "unavailable" };
  if (e.status === 400 && e.message.includes("unresolved_names")) {
    const m = /"unresolved_names","message":"([^"]*)"/.exec(e.message);
    return { kind: "unresolved", names: m?.[1] ?? "" };
  }
  return { kind: "generic" };
}

/** Terminal job codes -> copy keys (unknown/future codes fall back to generic). */
const FAIL_COPY = {
  no_frame: "builder.error.no_frame",
  generation_failed: "builder.error.generation",
  audit_failed: "builder.error.failed",
  llm_unavailable: "builder.error.unavailable",
  expired: "builder.error.expired",
} as const;

type View =
  | { phase: "form" }
  | { phase: "watching"; jobId: string; job: BuilderJobDto | null }
  | { phase: "done"; job: BuilderJobDto }
  /** `job` kept when we have it: the gate timeline (with its fact summaries) stays
   * reviewable after a failure too — only an expired/unknown job leaves it null. */
  | { phase: "failed"; code: string; job: BuilderJobDto | null };

function splitNames(raw: string, cap: number): string[] {
  return raw.split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean).slice(0, cap);
}

/** Browser-session continuity (§7.4: wizard form state lives in sessionStorage — the
 * server keeps NO history, but a finished job stays readable for its 15-minute TTL, so
 * navigating away and back restores the form AND re-fetches the result by job id). */
const STORE_KEY = "pc-builder";

interface Stash {
  form?: { format: FormatId; posture: "offense" | "balance" | "defense";
           anchor: string; owned: string; avoid: string; wants: string[]; thinking?: boolean };
  jobId?: string;
  quota?: { used: number; limit: number };
}

function readStash(): Stash {
  try {
    return JSON.parse(sessionStorage.getItem(STORE_KEY) ?? "{}") as Stash;
  } catch {
    return {};
  }
}

function writeStash(s: Stash): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch { /* storage blocked — continuity just won't survive navigation */ }
}

/** One gate's disclosure-trimmed fact summary: known keys localize, species arrays render
 * as localized chips (dex authority), scalars as text. */
function GateDetail({ detail }: { detail: NonNullable<BuilderGateDto["detail"]> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  return (
    <div className="gate-detail">
      {Object.entries(detail).map(([k, v]) => {
        const label = optionalKey(`builder.detail.${k}`);
        return (
          <div key={k} className="gate-detail-row">
            <span className="gate-detail-label">{label ? t(label) : k}</span>
            {Array.isArray(v) ? (
              <span className="gate-detail-chips">
                {v.map((name, i) => {
                  const entry = dex.get(name);
                  return (
                    <EntityHover key={`${name}-${i}`} kind="pokemon" name={name}>
                      <span className="gate-chip" title={name}>
                        {entry ? displayName(entry, lang) : name}
                      </span>
                    </EntityHover>
                  );
                })}
              </span>
            ) : (
              <span className="num">{String(v)}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GateTimeline({ gates, queuePosition, compact = false }: {
  gates: BuilderGateDto[]; queuePosition: number; compact?: boolean;
}) {
  const t = useT();
  return (
    <div className={`panel builder-progress${compact ? " compact" : ""}`}>
      <h2>{t("builder.progress")}</h2>
      {queuePosition > 0 && (
        <p className="notice">{t("builder.queue").replace("{n}", String(queuePosition))}</p>
      )}
      <ol className="builder-gates">
        {gates.map((g) => {
          const key = optionalKey(`gate.${g.gate}`);
          return (
            <li key={g.gate} className={`gate-${g.status}`}>
              <div className="gate-line">
                <span className="gate-dot" aria-hidden />
                {key ? t(key) : g.gate}
              </div>
              {g.detail && Object.keys(g.detail).length > 0 && (
                <GateDetail detail={g.detail} />
              )}
              {g.raw != null && (
                <details className="gate-raw">
                  <summary>{t("builder.rawData")}</summary>
                  <pre>{JSON.stringify(g.raw, null, 1)}</pre>
                </details>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

type ThreatRoute = MatchupThreatAssessmentDto["opponents"][number]["routes"][number];

function variantFacts(key: string | null | undefined): { item?: string; ability?: string } {
  if (!key?.startsWith("variant:")) return {};
  const fields = Object.fromEntries(key.split("|").slice(1).flatMap((part) => {
    const at = part.indexOf("=");
    return at > 0 ? [[part.slice(0, at), decodeURIComponent(part.slice(at + 1))]] : [];
  }));
  return { ...(fields.item ? { item: fields.item } : {}),
    ...(fields.ability ? { ability: fields.ability } : {}) };
}

function ThreatAssessmentPanel({ assessment, team, format, dexByName }: {
  assessment: MatchupThreatAssessmentDto;
  team: unknown;
  format: FormatId;
  dexByName: Map<string, DexIndexEntry>;
}) {
  const t = useT();
  const { lang } = useLang();
  const prose = useProseRenderer();
  const navigate = useNavigate();
  const members = readTeamMembers(team);
  const [setsRequested, setSetsRequested] = useState(false);
  const [pendingCalc, setPendingCalc] = useState<{ opponent: string; route: ThreatRoute } | null>(null);
  const oppCacheState = useOppCache(format, setsRequested);
  const oppSets = oppCacheState.status === "ready" ? oppCacheState.data?.sets : undefined;

  const openCalc = (opponent: string, route: ThreatRoute,
                    sets?: Record<string, OppSetDto>) => {
    const opponentEntry = dexByName.get(opponent);
    const attackerSlug = opponentEntry?.slug ?? slugify(opponent);
    const targetSet = sets?.[route.opponentVariant ?? attackerSlug];
    const member = members.find((candidate) => candidate.species === route.member);
    stashDamageFill({
      format,
      attackerSlug,
      attacker: {
        slug: attackerSlug,
        ...(targetSet?.ability ? { ability: targetSet.ability } : {}),
        ...(targetSet?.item ? { item: targetSet.item } : {}),
        ...(targetSet?.nature ? { nature: targetSet.nature } : {}),
        ...(targetSet?.sps ? { sps: targetSet.sps as Record<string, number> } : {}),
      },
      defender: {
        slug: dexByName.get(route.member)?.slug ?? slugify(route.member),
        ...(member?.ability ? { ability: member.ability } : {}),
        ...(member?.item ? { item: member.item } : {}),
        ...(member?.nature ? { nature: member.nature } : {}),
        ...(member?.spread ? { sps: member.spread } : {}),
      },
      move: route.move,
    });
    navigate("/calc?tab=damage");
  };

  const requestCalc = (opponent: string, route: ThreatRoute) => {
    if (setsRequested && oppCacheState.status === "ready") {
      openCalc(opponent, route, oppSets);
      return;
    }
    setPendingCalc({ opponent, route });
    setSetsRequested(true);
  };

  useEffect(() => {
    if (!pendingCalc || (oppCacheState.status !== "ready" && oppCacheState.status !== "error")) return;
    openCalc(pendingCalc.opponent, pendingCalc.route,
      oppCacheState.status === "ready" ? oppCacheState.data?.sets : undefined);
    setPendingCalc(null);
  }, [oppCacheState.status, pendingCalc]);

  const worst = assessment.worst;
  return (
    <div className="builder-threat-assessment">
      <p className="muted builder-threat-method">
        {t("builder.threatMethod").replace("{k}", String(assessment.scope.topK))}
      </p>
      {worst && (
        <div className="builder-worst gate-detail-row">
          <span className="gate-detail-label">{t("builder.worst")}</span>
          <span className={`threat-grade threat-${worst.grade}`}>{worst.grade}</span>
          <EntityHover kind="pokemon" name={worst.opponent}>
            <span className="gate-chip">
              {dexByName.get(worst.opponent)
                ? displayName(dexByName.get(worst.opponent)!, lang) : worst.opponent}
            </span>
          </EntityHover>
          <span className="muted num">
            {t("builder.threatBasis")
              .replace("{affected}", String(worst.basis.affectedMemberCount))
              .replace("{team}", String(worst.basis.teamSize))
              .replace("{rank}", worst.basis.usageRank == null ? "?" : String(worst.basis.usageRank))
              .replace("{routes}", String(worst.basis.routeCount))}
          </span>
        </div>
      )}
      <div className="builder-threat-list">
        <span className="gate-detail-label">{t("builder.threatFacts")}</span>
        {assessment.opponents.length === 0 ? (
          <p className="muted">{t("builder.threatNone")}</p>
        ) : assessment.opponents.map((threat, threatIndex) => (
          <details key={threat.opponent} open={threatIndex === 0} className="builder-threat-group">
            <summary>
              <span className={`threat-grade threat-${threat.grade}`}>{threat.grade}</span>
              <EntityHover kind="pokemon" name={threat.opponent}>
                <span className="gate-chip">
                  {dexByName.get(threat.opponent)
                    ? displayName(dexByName.get(threat.opponent)!, lang) : threat.opponent}
                </span>
              </EntityHover>
              <span className="muted num">
                {t("builder.threatSummary")
                  .replace("{affected}", String(threat.affectedMemberCount))
                  .replace("{team}", String(assessment.scope.teamSize))
                  .replace("{rank}", threat.usageRank == null ? "?" : String(threat.usageRank))
                  .replace("{routes}", String(threat.routeCount))
                  .replace("{variants}", String(threat.variantCount))}
              </span>
            </summary>
            <div className="builder-threat-routes">
              {threat.routes.map((route, routeIndex) => {
                const set = oppSets?.[route.opponentVariant ?? slugify(threat.opponent)];
                const summary = set ?? variantFacts(route.opponentVariant);
                const memberEntry = dexByName.get(route.member);
                return (
                  <div className="builder-threat-route"
                       key={`${route.evidenceId}:${route.opponentVariant ?? "base"}:${routeIndex}`}>
                    <span>{prose(route.move)}</span>
                    <span aria-hidden="true">→</span>
                    <EntityHover kind="pokemon" name={route.member}>
                      <span className="gate-chip">
                        {memberEntry ? displayName(memberEntry, lang) : route.member}
                      </span>
                    </EntityHover>
                    {(summary.item || summary.ability) && (
                      <span className="muted">
                        {[summary.item, summary.ability].filter(Boolean).map(String).join(" · ")}
                      </span>
                    )}
                    {route.opponentIsModal === true && (
                      <span className="muted">{t("builder.threatModal")}</span>
                    )}
                    <button type="button" className="linkish threat-calc"
                            title={t("builder.verifyCalc")}
                            aria-label={t("builder.verifyCalc")}
                            aria-busy={pendingCalc?.route.evidenceId === route.evidenceId}
                            disabled={pendingCalc !== null}
                            onClick={() => requestCalc(threat.opponent, route)}>⚔</button>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

export function BuilderPage() {
  const { adapter, can } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const dex = useDexIndex();
  const dexByName = useDexByName();
  const prose = useProseRenderer();
  const navigate = useNavigate();

  // Diagnose lives here as a sibling tab (same "teams" domain, shares TeamCard) and takes
  // a hand-off from the wizard result; it is capability-gated on its own (team.validate).
  const showDiagnose = can("team.validate") && !!adapter.diagnose;
  const [tab, setTab] = useState<"wizard" | "diagnose">("wizard");
  const [diagFill, setDiagFill] = useState<unknown | null>(null);

  // Rehydrate from sessionStorage once: the form fields always, and — when a job id was
  // stashed — jump straight back into watching (the effect below re-fetches; a finished
  // job replays its terminal snapshot, an expired one degrades to the expired notice).
  const stash = useMemo(readStash, []);
  const [format, setFormat] = useState<FormatId>(stash.form?.format ?? "single");
  const [posture, setPosture] = useState<"offense" | "balance" | "defense">(
    stash.form?.posture ?? "balance");
  const [anchor, setAnchor] = useState(stash.form?.anchor ?? "");
  const [owned, setOwned] = useState(stash.form?.owned ?? "");
  const [avoid, setAvoid] = useState(stash.form?.avoid ?? "");
  const [wants, setWants] = useState<Set<string>>(new Set(stash.form?.wants ?? []));
  const [thinking, setThinking] = useState(stash.form?.thinking ?? false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<StartError | null>(null);
  const [quota, setQuota] = useState<{ used: number; limit: number } | null>(
    stash.quota ?? null);
  const [view, setView] = useState<View>(
    stash.jobId ? { phase: "watching", jobId: stash.jobId, job: null } : { phase: "form" });

  // Current results load the large Top-60 cache only when a visitor asks for calculator hand-off.
  // Legacy results still need it here because their old threat DTO has no self-describing variant id.
  const needsLegacyOppSets = view.phase === "done" && !!view.job.result
    && !view.job.result.matchupThreats
    && (!!view.job.result.worstMatchup || (view.job.result.threats?.length ?? 0) > 1);
  const oppCacheState = useOppCache(format, needsLegacyOppSets);
  const oppSets = oppCacheState.status === "ready" ? oppCacheState.data?.sets : undefined;

  useEffect(() => {
    if (view.phase !== "done" || !view.job.result?.team) return;
    rememberMatchupSource({ source: "builder", label: t("actual.source.builder"), format,
      team: view.job.result.team });
  }, [view, format, t]);

  const stashJobId = view.phase === "watching" ? view.jobId
    : view.phase === "done" ? view.job.id : undefined;
  const completedResult = view.phase === "done" ? view.job.result : null;
  useEffect(() => {
    writeStash({
      form: { format, posture, anchor, owned, avoid, wants: [...wants], thinking },
      ...(stashJobId ? { jobId: stashJobId } : {}),
      ...(quota ? { quota } : {}),
    });
  }, [format, posture, anchor, owned, avoid, wants, thinking, stashJobId, quota]);

  useEffect(() => {
    let live = true;
    adapter.quota?.().then((all) => { if (live) setQuota(all.builder); }, () => {});
    return () => { live = false; };
  }, [adapter]);

  const thinkingUnavailable = quota === null || (quota.limit > 0 && quota.limit - quota.used < 2);
  useEffect(() => {
    if (thinkingUnavailable) setThinking(false);
  }, [thinkingUnavailable]);

  const jobId = view.phase === "watching" ? view.jobId : null;
  useEffect(() => {
    if (!jobId || !adapter.builder) return;
    const api = adapter.builder;
    let stopped = false;
    let poll: number | undefined;
    const apply = (j: BuilderJobDto) => {
      if (stopped) return;
      if (j.status === "done") setView({ phase: "done", job: j });
      else if (j.status === "failed") {
        setView({ phase: "failed", code: j.errorCode ?? "", job: j });
      } else setView((v) => (v.phase === "watching" ? { ...v, job: j } : v));
    };
    const snapshotError = (e: unknown) => {
      if (e instanceof HttpError && e.status === 404 && !stopped) {
        setView({ phase: "failed", code: "expired", job: null });
      }
    };
    // Read the snapshot immediately while opening the progress stream. An expired cached id is
    // therefore rejected by the cheap GET instead of waiting for an SSE failure/timeout first.
    void api.job(jobId).then(apply, snapshotError);
    // SSE carries live progress; any transport failure downgrades to polling the same snapshot.
    const unsub = api.subscribe(jobId, apply, () => {
      if (stopped || poll !== undefined) return;
      poll = window.setInterval(() => {
        api.job(jobId).then(apply, snapshotError);
      }, 2000);
    });
    return () => {
      stopped = true;
      unsub();
      if (poll !== undefined) clearInterval(poll);
    };
  }, [jobId, adapter]);

  const submit = async () => {
    if (!adapter.builder || submitting) return;
    setError(null);
    setSubmitting(true);
    const req: BuilderRequestDto = {
      format,
      posture,
      lang,
      ...(anchor.trim() ? { anchor: anchor.trim().slice(0, 100) } : {}),
      ...(owned.trim() ? { owned: splitNames(owned, 30) } : {}),
      ...(avoid.trim() ? { avoid: splitNames(avoid, 10) } : {}),
      ...(wants.size ? { wants: [...wants] as BuilderRequestDto["wants"] } : {}),
      ...(thinking ? { thinking: true } : {}),
    };
    try {
      const start = await adapter.builder.start(req);
      setQuota(start.quota);
      setView({ phase: "watching", jobId: start.jobId, job: null });
    } catch (e) {
      setError(startError(e));
    } finally {
      setSubmitting(false);
    }
  };

  const pendingGates: BuilderGateDto[] =
    BUILDER_GATES.map((g) => ({ gate: g, status: "pending" as const }));

  return (
    <div>
      <PageHeader title={t("builder.title")} description={t("online.aiNote")}>
        {showDiagnose && (
          <SegmentedControl kind="tabs" idBase="builder-mode" value={tab} onChange={setTab}
            ariaLabel={t("a11y.builderMode")} className="seg builder-tabs page-tabs"
            items={(["wizard", "diagnose"] as const).map((id) => ({
              id,
              label: t(`builder.tab.${id}`),
            }))} />
        )}
      </PageHeader>
      <div role={showDiagnose ? "tabpanel" : undefined}
        id={showDiagnose ? segmentedPanelId("builder-mode", "wizard") : undefined}
        aria-labelledby={showDiagnose ? segmentedTabId("builder-mode", "wizard") : undefined}
        hidden={showDiagnose && tab !== "wizard"}>
      <>
      <p className="notice page-disclosure">{t("builder.disclosure")}</p>

      {(view.phase === "form" || view.phase === "failed" || view.phase === "done") && (
        <div className="panel form-panel builder-form">
          <div className="builder-field">
            <label>{t("format.single")} / {t("format.double")}</label>
            <FormatTabs format={format} onChange={setFormat} />
          </div>
          <div className="builder-field">
            <label>{t("builder.posture")}</label>
            <SegmentedControl kind="radio" value={posture} onChange={setPosture}
              ariaLabel={t("builder.posture")} className="seg"
              items={(["offense", "balance", "defense"] as const).map((id) => ({
                id,
                label: t(`builder.posture.${id}`),
              }))} />
          </div>
          <div className="builder-field">
            <label htmlFor="builder-anchor">{t("builder.anchor")}</label>
            <input id="builder-anchor" list="builder-anchor-options" value={anchor}
                   maxLength={100} onChange={(e) => setAnchor(e.target.value)}
                   placeholder={t("builder.anchorHint")} />
            <datalist id="builder-anchor-options">
              {dex.status === "ready" && dex.data.map((entry) => (
                <option key={entry.slug} value={displayName(entry, lang)} />
              ))}
            </datalist>
          </div>
          <div className="builder-field">
            <label htmlFor="builder-owned">{t("builder.owned")}</label>
            <textarea id="builder-owned" rows={2} value={owned}
                      onChange={(e) => setOwned(e.target.value)}
                      placeholder={t("builder.ownedHint")} />
          </div>
          <div className="builder-field">
            <label htmlFor="builder-avoid">{t("builder.avoid")}</label>
            <textarea id="builder-avoid" rows={1} value={avoid}
                      onChange={(e) => setAvoid(e.target.value)} />
          </div>
          <div className="builder-field">
            <label>{t("builder.tactics")}</label>
            <div className="builder-tactics">
              {BUILDER_TACTICS.map((tac) => (
                <label key={tac} className={wants.has(tac) ? "on" : ""}>
                  <input type="checkbox" checked={wants.has(tac)}
                         onChange={(e) => {
                           const next = new Set(wants);
                           if (e.target.checked) next.add(tac);
                           else next.delete(tac);
                           setWants(next);
                         }} />
                  {t(`tactic.${tac}`)}
                </label>
              ))}
            </div>
          </div>
          <div className="diag-mode-options builder-thinking-options">
            <ThinkingToggle checked={thinking} onChange={setThinking}
              disabled={submitting || thinkingUnavailable} label={t("thinking.label")}
              tip={`${t("builder.thinkingTip")}${thinkingUnavailable && quota !== null
                ? ` ${t("thinking.insufficient")}` : ""}`} />
          </div>
          <div className="builder-actions">
            {quota && (
              <span className="muted num">
                {t("builder.quota")} {quota.limit === 0
                  ? t("quota.unlimited") : `${quota.used}/${quota.limit}`}
              </span>
            )}
            {completedResult && showDiagnose && (
              <button type="button" className="second-btn"
                      onClick={() => {
                        setDiagFill(completedResult.team);
                        setTab("diagnose");
                      }}>
                {t("builder.sendDiagnose")}
              </button>
            )}
            {completedResult && (
              <button type="button" className="second-btn" onClick={() => {
                stashMatchupFill({ source: "builder", label: t("actual.source.builder"), format,
                  team: completedResult.team });
                navigate("/matchup?mode=actual");
              }}>{t("actual.sendMatchup")}</button>
            )}
            <button type="button" className="primary-btn"
                    disabled={submitting || !!(quota && quota.limit > 0 && quota.used >= quota.limit)}
                    onClick={() => void submit()}>
              {submitting ? t("builder.starting") : t("builder.start")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="notice qa-error">
          {error.kind === "unresolved"
            ? `${t("builder.error.unresolved")}${error.names}`
            : t(`builder.error.${error.kind}`)}
        </p>
      )}

      {view.phase === "failed" && (
        <p className="notice qa-error">
          {t(FAIL_COPY[view.code as keyof typeof FAIL_COPY] ?? "builder.error.generic")}
        </p>
      )}

      {view.phase === "watching" && (
        <GateTimeline gates={view.job?.gates ?? pendingGates}
                      queuePosition={view.job?.queuePosition ?? 0} />
      )}
      {view.phase === "failed" && view.job && (
        <GateTimeline gates={view.job.gates} queuePosition={0} />
      )}

      {view.phase === "done" && view.job.result && (
        <div className="panel result-panel builder-result">
          <TeamCard team={view.job.result.team} badges={
            <div className="builder-badges">
              <span className="badge-ok">✓ {t("builder.badge.valid")}</span>
              <span className="badge-ok">✓ {t("builder.badge.audit")}</span>
              {view.job.result.repaired && (
                <span className="badge-note">{t("builder.badge.repaired")}</span>
              )}
            </div>
          } />
          {view.job.result.rationale && (
            <div className="builder-rationale">
              <span className="gate-detail-label">{t("builder.rationale")}</span>
              {view.job.result.rationale.split(/\n+/).map((paragraph, index) => (
                <p key={index}>{prose(paragraph)}</p>
              ))}
            </div>
          )}
          <p className="muted num builder-scope">
            {t("builder.scope").replace("{k}", String(view.job.result.slateTopK))}
            {view.job.result.megaCount != null
              ? ` · ${t("builder.megaCount").replace("{n}", String(view.job.result.megaCount))}`
              : ""}
          </p>
          {view.job.result.matchupThreats && (
            <ThreatAssessmentPanel assessment={view.job.result.matchupThreats}
              team={view.job.result.team} format={format} dexByName={dexByName} />
          )}
          {!view.job.result.matchupThreats && (view.job.result.threats?.length ?? 0) > 1 && (
            <div className="gate-detail-row">
              <span className="gate-detail-label">{t("builder.threats")}</span>
              <span className="gate-detail-chips">
                {view.job.result.threats!.map((th) => {
                  const team = view.job.result!.team;
                  const aSlug = dexByName.get(th.opponent)?.slug ?? slugify(th.opponent);
                  const aSet = oppSets?.[aSlug];
                  return (
                    <span key={th.opponent} className="threat-chip">
                      <EntityHover kind="pokemon" name={th.opponent}>
                        <span className="gate-chip">
                          {dexByName.get(th.opponent)
                            ? displayName(dexByName.get(th.opponent)!, lang) : th.opponent}
                        </span>
                      </EntityHover>
                      <button type="button" className="linkish threat-calc"
                              title={t("builder.verifyCalc")}
                              aria-label={t("builder.verifyCalc")}
                              onClick={() => {
                                const member = readTeamMembers(team)
                                  .find((m) => m.species === th.member);
                                stashDamageFill({
                                  format: (team as { format?: string }).format === "double"
                                    ? "double" : "single",
                                  attackerSlug: aSlug,
                                  attacker: {
                                    slug: aSlug,
                                    ...(aSet?.ability ? { ability: aSet.ability } : {}),
                                    ...(aSet?.item ? { item: aSet.item } : {}),
                                    ...(aSet?.nature ? { nature: aSet.nature } : {}),
                                    ...(aSet?.sps ? { sps: aSet.sps as Record<string, number> } : {}),
                                  },
                                  ...(th.member ? { defender: {
                                    slug: dexByName.get(th.member)?.slug ?? slugify(th.member),
                                    ...(member?.ability ? { ability: member.ability } : {}),
                                    ...(member?.item ? { item: member.item } : {}),
                                    ...(member?.nature ? { nature: member.nature } : {}),
                                    ...(member?.spread ? { sps: member.spread } : {}),
                                  } } : {}),
                                  ...(th.move ? { move: th.move } : {}),
                                });
                                navigate("/calc?tab=damage");
                              }}>⚔</button>
                    </span>
                  );
                })}
              </span>
            </div>
          )}
          {/* Worst-matchup battery fact with a calculator hand-off (design §13): the
              opponent attacks with its usage set; MY member defends with its real build. */}
          {!view.job.result.matchupThreats && view.job.result.worstMatchup && (() => {
            const wm = view.job.result.worstMatchup;
            const team = view.job.result.team;
            const oppName = dexByName.get(wm.opponent);
            const memberName = wm.member ? dexByName.get(wm.member) : undefined;
            return (
              <div className="builder-worst gate-detail-row">
                <span className="gate-detail-label">{t("builder.worst")}</span>
                <span className="gate-detail-chips">
                  <span className="gate-chip" title={oppName ? displayName(oppName, lang) : wm.opponent}>
                    {oppName ? displayName(oppName, lang) : wm.opponent}
                  </span>
                  {wm.move && <span className="muted">{prose(wm.move)}</span>}
                  {wm.member && (
                    <span className="gate-chip" title={memberName ? displayName(memberName, lang) : wm.member}>
                      → {memberName ? displayName(memberName, lang) : wm.member}
                    </span>
                  )}
                </span>
                <button type="button" className="second-btn builder-verify"
                        onClick={() => {
                          const member = readTeamMembers(team)
                            .find((m) => m.species === wm.member);
                          const aSlug = oppName?.slug ?? slugify(wm.opponent);
                          const aSet = oppSets?.[aSlug];
                          stashDamageFill({
                            format: (team as { format?: string }).format === "double"
                              ? "double" : "single",
                            attackerSlug: aSlug,
                            attacker: {
                              slug: aSlug,
                              ...(aSet?.ability ? { ability: aSet.ability } : {}),
                              ...(aSet?.item ? { item: aSet.item } : {}),
                              ...(aSet?.nature ? { nature: aSet.nature } : {}),
                              ...(aSet?.sps ? { sps: aSet.sps as Record<string, number> } : {}),
                            },
                            ...(wm.member ? { defender: {
                              slug: (memberName?.slug ?? slugify(wm.member)),
                              ...(member?.ability ? { ability: member.ability } : {}),
                              ...(member?.item ? { item: member.item } : {}),
                              ...(member?.nature ? { nature: member.nature } : {}),
                              ...(member?.spread ? { sps: member.spread } : {}),
                            } } : {}),
                            ...(wm.move ? { move: wm.move } : {}),
                          });
                          navigate("/calc?tab=damage");
                        }}>
                  {t("builder.verifyCalc")}
                </button>
              </div>
            );
          })()}
          <div className="builder-assumptions">
            <span className="muted">{t("builder.assumptions")}</span>
            <ul>
              {view.job.result.assumptions.map((k) => {
                const key = optionalKey(`assumption.${k}`);
                return <li key={k}>{key ? t(key) : k}</li>;
              })}
            </ul>
          </div>
        </div>
      )}
      {/* The run's gate timeline (with its fact summaries) stays reviewable under the
          result — the intermediate products are part of the answer, not just progress. */}
      {view.phase === "done" && (
        <GateTimeline gates={view.job.gates} queuePosition={0} compact />
      )}
      </>
      </div>
      {showDiagnose && (
        <div role="tabpanel" id={segmentedPanelId("builder-mode", "diagnose")}
          aria-labelledby={segmentedTabId("builder-mode", "diagnose")}
          hidden={tab !== "diagnose"}>
          {/* Keep the tab mounted: an in-flight reading must survive sibling-tab switches. */}
          <DiagnoseTab active={tab === "diagnose"} fill={diagFill}
            onConsumeFill={() => setDiagFill(null)} />
        </div>
      )}
    </div>
  );
}
