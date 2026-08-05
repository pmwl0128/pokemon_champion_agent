/** One UEP session — a STATUS view, not a ledger view (design §6). The page answers three
 * things at a glance: where the flow is (banner + gate stepper), what came out (the final
 * team as a party strip, candidates as cards), and what the user must do (the decision
 * card, top-most while a checkpoint waits). The append-only artifact timeline stays intact
 * but folded away as the full record. Artifacts render verbatim-first: structured cards are
 * lenient readers, raw JSON is always reachable. Live updates ride the SSE feed; the one
 * panel-authored artifact (`decision`) goes through the store's optimistic lock. */
import {
  CheckpointDecisionDtoSchema, UEP_GATE_KINDS,
  type CheckpointDecisionDto, type LedgerEntryDto, type SessionWithLedgerDto,
} from "@pokemon-champions/protocol";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAsync } from "../../hooks.ts";
import { optionalKey, useLang, useT } from "../../i18n.ts";
import { useProseRenderer } from "../../lib/prose.tsx";
import { stashMatchupFill, stashTuneFill } from "../../lib/team.ts";
import { HttpError, type SessionApi } from "../../runtime/adapter.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { renderArtifactCard } from "./artifacts.tsx";
import { KindBadge, localTime, prettyPayload, shortHash } from "./kinds.tsx";
import { TeamCard } from "./TeamCard.tsx";

/** Payload view: a structured card when the kind renderer recognizes the shape (real gate
 * artifacts), with a raw-JSON toggle; raw only when it doesn't. */
function ArtifactBody({ sessions, hash, kind }: {
  sessions: SessionApi; hash: string; kind?: string;
}) {
  const t = useT();
  const [showRaw, setShowRaw] = useState(false);
  const state = useAsync(() => sessions.artifact(hash), [hash]);
  if (state.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (state.status === "error") {
    return <div className="notice">{t("state.errorDetail")}</div>;
  }
  const card = renderArtifactCard(kind ?? state.data.kind, state.data.text);
  return (
    <>
      {card}
      {card && (
        <button className="linkish" onClick={() => setShowRaw(!showRaw)}>
          {showRaw ? t("uep.card") : t("uep.raw")}
        </button>
      )}
      {(!card || showRaw) && <pre className="artifact-pre mono">{prettyPayload(state.data.text)}</pre>}
    </>
  );
}

function ArtifactRow({ sessions, entry }: { sessions: SessionApi; entry: LedgerEntryDto }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="artifact-row">
      <div className="artifact-row-head">
        <span className="mono muted num">#{entry.sequence}</span>
        <KindBadge kind={entry.kind} />
        <span className="muted num">{localTime(entry.createdAt)}</span>
        <span className="mono muted artifact-hash" title={entry.artifactHash}>
          {shortHash(entry.artifactHash)}
        </span>
        <button className="linkish" onClick={() => setOpen(!open)}>
          {open ? t("uep.hidePayload") : t("uep.viewPayload")}
        </button>
      </div>
      {open && <ArtifactBody sessions={sessions} hash={entry.artifactHash} kind={entry.kind} />}
    </div>
  );
}

/** Latest ledger sequence per kind (heads point at hashes; ordering needs sequences). */
function latestSeq(ledger: LedgerEntryDto[], kind: string): number {
  let seq = -1;
  for (const e of ledger) if (e.kind === kind && e.sequence > seq) seq = e.sequence;
  return seq;
}

const asObj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** The gate artifacts the status view itself reads (parsed leniently, null on any miss). */
interface GateReads {
  draft: Record<string, unknown> | null;
  answerAudit: Record<string, unknown> | null;
  checkpoint: Record<string, unknown> | null;
}

function useGateReads(sessions: SessionApi, session: SessionWithLedgerDto | null): GateReads {
  const heads = session?.heads ?? {};
  const keys = [heads["draft"], heads["answer-audit"], heads["checkpoint"]];
  const state = useAsync(async () => {
    const fetch1 = (h: string | undefined) =>
      h ? sessions.artifact(h).then((a) => asObj(JSON.parse(a.text))).catch(() => null)
        : Promise.resolve(null);
    const [draft, answerAudit, checkpoint] = await Promise.all(
      [fetch1(keys[0]), fetch1(keys[1]), fetch1(keys[2])]);
    return { draft, answerAudit, checkpoint };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys);
  return state.status === "ready" ? state.data
    : { draft: null, answerAudit: null, checkpoint: null };
}

type Stage = "done" | "awaiting" | "working";

// Gates whose write, if it lands AFTER the answer-audit, means the audit no longer covers the
// current state (a re-slate / new draft reopens the flow).
const BUILD_GATES = ["context", "audit", "frame", "slate", "draft"];

/** The answer-audit is CURRENT only if nothing it should have covered was written after it —
 * a stale pass over a since-superseded draft must not read as "done". */
function auditIsCurrent(ledger: LedgerEntryDto[]): boolean {
  const auditSeq = latestSeq(ledger, "answer-audit");
  return auditSeq >= 0 && BUILD_GATES.every((k) => latestSeq(ledger, k) < auditSeq);
}

function stageOf(session: SessionWithLedgerDto, reads: GateReads): Stage {
  if (reads.answerAudit?.pass === true && auditIsCurrent(session.ledger)) return "done";
  const cpSeq = latestSeq(session.ledger, "checkpoint");
  const decided = latestSeq(session.ledger, "decision") > cpSeq;
  if (cpSeq >= 0 && !decided && reads.checkpoint?.pause !== false) return "awaiting";
  return "working";
}

// -- decision card (panel-authored write-back) ----------------------------------------------

function DecisionForm({ sessions, session, checkpoint, onCommitted }: {
  sessions: SessionApi;
  session: SessionWithLedgerDto;
  checkpoint: Record<string, unknown> | null;
  onCommitted: () => void;
}) {
  const t = useT();
  const { lang } = useLang();
  // The agent's ACTUAL questions from the checkpoint artifact (trilingual) — the decision
  // buttons answer these, so they must be visible, live, in the viewer's language.
  const questions = (Array.isArray(checkpoint?.questions_to_ask) ? checkpoint.questions_to_ask : [])
    .flatMap((q) => {
      const o = asObj(q);
      const texts = o ? asObj(o.text) : null;
      const s = texts ? String(texts[lang] ?? texts.en ?? "") : "";
      return s ? [s] : [];
    });
  const [action, setAction] =
    useState<CheckpointDecisionDto["action"]>("chooseCandidate");
  // The slate's SURVIVING candidate indices, from the checkpoint's candidate_frames — the pick
  // must be one of these. Free-typing 0 when survivors are [1,2] would steer the agent onto an
  // eliminated candidate. Fall back to a free input only when the checkpoint carries no frames.
  const survivorOpts = (Array.isArray(checkpoint?.candidate_frames) ? checkpoint.candidate_frames : [])
    .map(asObj)
    .filter((f): f is Record<string, unknown> => !!f && f.survivor === true && typeof f.index === "number")
    .map((f) => f.index as number);
  const [candidateIndex, setCandidateIndex] = useState(() => survivorOpts[0] ?? 0);
  // The checkpoint loads async: while it is null the form still mounts (stage stays "awaiting"),
  // so candidateIndex seeds to 0. When the real survivor set arrives (or later changes), snap an
  // out-of-range pick onto the first survivor — otherwise an untouched <select value={0}> whose
  // options are #1/#2 submits 0, an ELIMINATED candidate.
  useEffect(() => {
    if (survivorOpts.length > 0 && !survivorOpts.includes(candidateIndex)) {
      setCandidateIndex(survivorOpts[0]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [survivorOpts.join(","), candidateIndex]);
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    setSubmitting(true);
    setError("");
    const decision: CheckpointDecisionDto = CheckpointDecisionDtoSchema.parse({
      gate: "checkpoint",
      action,
      ...(action === "chooseCandidate" ? { candidateIndex } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
      decidedAt: new Date().toISOString(),
    });
    try {
      await sessions.putArtifact(
        session.id, "decision", JSON.stringify(decision), session.revision);
      onCommitted();
    } catch (e) {
      // 409: another writer moved the session; reload so the user decides on fresh state.
      console.error("Decision submission failed:", e);
      setError(e instanceof HttpError && e.status === 409 ? t("uep.conflict") : t("uep.submitError"));
      if (e instanceof HttpError && e.status === 409) onCommitted();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="panel uep-checkpoint">
      <h2>{t("uep.checkpoint.title")}</h2>
      <p className="muted">{t("uep.checkpoint.hint")}</p>
      {questions.length > 0 && (
        <ul className="uep-questions">
          {questions.map((q, i) => <li key={i}>{q}</li>)}
        </ul>
      )}
      <div className="decision-actions seg">
        <button className={action === "chooseCandidate" ? "on" : ""}
                onClick={() => setAction("chooseCandidate")}>
          {t("uep.checkpoint.choose")}
        </button>
        <button className={action === "requestChanges" ? "on" : ""}
                onClick={() => setAction("requestChanges")}>
          {t("uep.checkpoint.changes")}
        </button>
        <button className={action === "proceed" ? "on" : ""}
                onClick={() => setAction("proceed")}>
          {t("uep.checkpoint.proceed")}
        </button>
      </div>
      {action === "chooseCandidate" && (
        <label className="decision-field">
          {t("uep.checkpoint.candidate")}
          {survivorOpts.length > 0 ? (
            <select value={candidateIndex} onChange={(e) => setCandidateIndex(Number(e.target.value))}>
              {survivorOpts.map((idx) => <option key={idx} value={idx}>#{idx}</option>)}
            </select>
          ) : (
            <input type="number" min={0} value={candidateIndex}
                   onChange={(e) => setCandidateIndex(Math.max(0, Number(e.target.value) || 0))} />
          )}
        </label>
      )}
      <textarea rows={2} value={note} placeholder={t("uep.checkpoint.notePh")}
                onChange={(e) => setNote(e.target.value)} />
      <div className="decision-submit-row">
        {/* requestChanges without a note tells the agent nothing — force the note. */}
        <button className="primary-btn" onClick={submit}
                disabled={submitting || (action === "requestChanges" && !note.trim())}>
          {t("uep.checkpoint.submit")}
        </button>
        {action === "requestChanges" && !note.trim() && (
          <span className="muted decision-hint">{t("uep.checkpoint.noteRequired")}</span>
        )}
      </div>
      {error && <div className="notice">{error}</div>}
    </div>
  );
}

// -- final result (draft.recommended → party strips + honest disclosures) --------------------

function ResultSection({ draft, intent, sessionId, provisional }: {
  draft: Record<string, unknown>; intent?: string; sessionId?: string;
  /** true when this draft is NOT covered by a current passing answer-audit — show it as a
   * work-in-progress draft, never as the certified final team. */
  provisional?: boolean;
}) {
  const t = useT();
  const { can } = useRuntime();
  const navigate = useNavigate();
  const loc = useProseRenderer();
  const recommended = Array.isArray(draft.recommended) ? draft.recommended : [];
  // Hand the team to the calc tune page (one page, every tune shape). sessionId enables the
  // write-back loop there: benchmarks + note come back as a `tune-request` artifact.
  const sendToTune = (team: unknown) => {
    stashTuneFill({ team, label: intent, sessionId });
    navigate("/calc?tab=tune&mode=team");
  };
  const sendToMatchup = (team: unknown) => {
    const format = (team as { format?: string })?.format === "double" ? "double" : "single";
    stashMatchupFill({ source: "session", label: intent || t("actual.source.session"), format, team });
    navigate("/matchup?mode=actual");
  };
  const tradeoffs = recommended.flatMap((r) => {
    const o = asObj(r);
    return o && Array.isArray(o.tradeoffs) ? o.tradeoffs.filter((x): x is string => typeof x === "string") : [];
  });
  const assumptions = Array.isArray(draft.assumptions) ? draft.assumptions : [];
  const confidenceNotes = Array.isArray(draft.confidence_notes)
    ? draft.confidence_notes.filter((x): x is string => typeof x === "string") : [];
  const tuning = asObj(draft.tuning_summary);
  if (recommended.length === 0) return null;
  return (
    <div className={`panel uep-result${provisional ? " provisional" : ""}`}>
      <h2>{provisional ? t("uep.result.draftTitle") : t("uep.result.title")}</h2>
      {provisional && <p className="notice uep-provisional-note">{t("uep.result.provisionalHint")}</p>}
      {recommended.map((r, i) => {
        const o = asObj(r);
        if (!o) return null;
        const megaDev = asObj(o.mega_registration_deviation);
        const megaRat = asObj(o.mega_registration_rationale);
        return (
          <div key={i} className="uep-team-block">
            <TeamCard team={o.team} />
            {(megaDev || megaRat) && (
              <div className="uep-result-block muted">
                {megaDev && (
                  <p className="uep-disclosure">
                    <b>{t("uep.result.megaDeviation")}:</b> {loc(String(megaDev.reason ?? ""))}
                    {megaDev.opportunity_cost ? <> — {loc(String(megaDev.opportunity_cost))}</> : null}
                  </p>
                )}
                {megaRat && (
                  <p className="uep-disclosure">
                    <b>{t("uep.result.megaRationale")}:</b> {loc(String(megaRat.primary ?? ""))}
                    {megaRat.opportunity_cost ? <> — {loc(String(megaRat.opportunity_cost))}</> : null}
                  </p>
                )}
              </div>
            )}
            {(can("team.tune") || can("team.matchup")) && (
              <div className="uep-team-actions">
                {can("team.tune") && <button className="second-btn" onClick={() => sendToTune(o.team)}>
                  {t("uep.tune.open")} →
                </button>}
                {can("team.matchup") && <button className="second-btn" onClick={() => sendToMatchup(o.team)}>
                  {t("actual.sendMatchup")} →
                </button>}
              </div>
            )}
          </div>
        );
      })}
      {tradeoffs.length > 0 && (
        <div className="uep-result-block">
          <h3>{t("uep.result.tradeoffs")}</h3>
          <ul>{tradeoffs.map((x, i) => <li key={i}>{loc(x)}</li>)}</ul>
        </div>
      )}
      {confidenceNotes.length > 0 && (
        <div className="uep-result-block muted">
          <h3>{t("uep.result.confidence")}</h3>
          <ul>{confidenceNotes.map((x, i) => <li key={i}>{loc(x)}</li>)}</ul>
        </div>
      )}
      {(assumptions.length > 0 || tuning) && (
        <div className="uep-result-block muted">
          <h3>{t("uep.result.assumptions")}</h3>
          <ul>
            {assumptions.map((a, i) => {
              const o = asObj(a);
              if (!o) return <li key={i}>{String(a)}</li>;
              const gap = String(o.gap ?? "");
              const gapKey = optionalKey(`gapfield.${gap}`);
              return <li key={i}>{gapKey ? t(gapKey) : gap}{o.note ? <> — {loc(String(o.note))}</> : null}</li>;
            })}
            {tuning && typeof tuning.status === "string" && (() => {
              const sKey = optionalKey(`tune.status.${tuning.status}`);
              return (
                <li>{t("uep.result.tuning")}: {sKey ? t(sKey) : tuning.status}
                  {typeof tuning.reason === "string" && tuning.reason ? ` — ${tuning.reason}` : ""}</li>
              );
            })()}
          </ul>
        </div>
      )}
    </div>
  );
}

// -- page -----------------------------------------------------------------------------------

export function SessionPage() {
  const { id = "" } = useParams();
  const { adapter } = useRuntime();
  const t = useT();
  const sessions = adapter.sessions;
  const [refresh, setRefresh] = useState(0);
  const bump = () => setRefresh((n) => n + 1);

  const state = useAsync(
    () => (sessions ? sessions.get(id) : Promise.reject(new Error("no session api"))),
    [sessions, id, refresh]);
  // Keep the last good session rendered through SSE-triggered refreshes — every agent
  // artifact fires one, and flashing the whole page to a spinner per event reads as broken.
  // Router reuses this component across /sessions/A -> /sessions/B (same :id route, no key),
  // so `last` must be scoped to the CURRENT id: never show — or write a decision to — the
  // previous session while the new one loads.
  const [last, setLast] = useState<SessionWithLedgerDto | null>(null);
  useEffect(() => {
    if (state.status === "ready") setLast(state.data);
  }, [state]);
  const session = state.status === "ready" ? state.data
    : last && last.id === id ? last : null;
  const reads = useGateReads(sessions!, session);

  useEffect(() => {
    if (!sessions) return;
    return sessions.subscribe((e) => {
      if (e.sessionId === id) bump();
    });
  }, [sessions, id]);

  if (!sessions) return <div className="notice">{t("uep.unavailable")}</div>;
  if (state.status === "error") {
    return <div className="notice">{state.httpStatus === 404
      ? t("uep.notFound")
      : t("state.errorDetail")}</div>;
  }
  if (!session) return <div className="spinner">{t("state.loading")}</div>;

  const stage = stageOf(session, reads);
  const doneStep = new Set(Object.keys(session.heads));
  const extraKinds = Object.keys(session.heads)
    .filter((k) => !(UEP_GATE_KINDS as readonly string[]).includes(k));
  const slateHash = session.heads["slate"];

  return (
    <main className="session-page">
      <section className="session-hero">
        <h1 className="page-title">
          {typeof session.meta.intent === "string" && session.meta.intent !== ""
            ? session.meta.intent : session.id}
        </h1>
        <div className="session-card-head session-meta">
          <span className="mono muted">{session.id}</span>
          <span className="muted num">{localTime(session.createdAt)}</span>
          <span className="muted num">{t("uep.revision")} {session.revision}</span>
        </div>

        <div className={`uep-banner ${stage}`}>
          {t(stage === "done" ? "uep.stage.done"
            : stage === "awaiting" ? "uep.stage.awaiting" : "uep.stage.working")}
        </div>

        <div className="gate-stepper">
          {[...UEP_GATE_KINDS, ...extraKinds].map((k) => (
            <span key={k} className={`gate-step${doneStep.has(k) ? " on" : ""}`}>
              <KindBadge kind={k} />
            </span>
          ))}
        </div>
      </section>

      {stage === "awaiting" && (
        <DecisionForm sessions={sessions} session={session} checkpoint={reads.checkpoint} onCommitted={bump} />
      )}

      {reads.draft && (
        <ResultSection draft={reads.draft} sessionId={session.id} provisional={stage !== "done"}
          intent={typeof session.meta.intent === "string" ? session.meta.intent : undefined} />
      )}

      {slateHash && (
        <div className="panel">
          <h2>{t("uep.slate.title")}</h2>
          <div className="uep-slate-wrap">
            <ArtifactBody sessions={sessions} hash={slateHash} kind="slate" />
          </div>
        </div>
      )}

      <details className="uep-details">
        <summary>{t("uep.detail.toggle")}</summary>
        <div className="panel">
          {session.ledger.length === 0
            ? <p className="muted uep-timeline-empty">{t("uep.timelineEmpty")}</p>
            : session.ledger.map((e) => (
                <ArtifactRow key={e.sequence} sessions={sessions} entry={e} />
              ))}
        </div>
      </details>
    </main>
  );
}
