/** Best-effort structured views over agent-authored gate artifacts — the DEFAULT view for
 * every known kind; raw JSON stays one toggle away, never the front door. The store
 * guarantees the VERBATIM payload, not a schema (design §6), so every renderer is a lenient
 * reader over `unknown`: shapes come from real M-4 sessions, any miss returns null and the
 * caller falls back to raw. Skill vocab tokens (gap fields, speed-control modes, audit
 * counters) map to trilingual labels via optionalKey — unknown tokens render verbatim
 * rather than breaking. Never Zod-validate these payloads. */
import type { ReactNode } from "react";
import type { TuneCardDto } from "@pokemon-champions/protocol";
import { TypeBadge } from "../../components/TypeBadge.tsx";
import { optionalKey, useLang, useT } from "../../i18n.ts";
import { TuneCard } from "../calc/TuneTab.tsx";
import { MonRow } from "./MonChip.tsx";
import { readTeamMembers, useDexByName, type TeamMemberish } from "./TeamCard.tsx";

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const strs = (v: unknown): string[] => arr(v).map(str).filter(Boolean);

function Chip({ tone, children }: { tone?: "ok" | "warn" | "bad"; children: ReactNode }) {
  return <span className={`uep-chip${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

// -- context (build-context: the user's intent, in their language) --------------------------
function ContextCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const styleKey = optionalKey(`style.${str(d.style_lean)}`);
  const locked = strs(d.locked);
  const prefer = strs(d.prefer);
  const avoid = strs(d.avoid);
  const benchmarks = arr(d.benchmarks);
  return (
    <div className="uep-card">
      <div className="uep-card-row">
        {(d.format === "single" || d.format === "double") && (
          <Chip>{t("ctx.format")}: {t(d.format === "single" ? "format.single" : "format.double")}</Chip>
        )}
        {styleKey && <Chip>{t("ctx.styleLean")}: {t(styleKey)}</Chip>}
        {d.direct_final === true && <Chip tone="ok">{t("ctx.directFinal")}</Chip>}
        {d.owned_only === true && <Chip>{t("ctx.ownedOnly")}</Chip>}
        {benchmarks.length > 0 && <Chip>{t("ctx.benchmarks")} ×{benchmarks.length}</Chip>}
      </div>
      {locked.length > 0 && (
        <div className="uep-card-row">
          <span className="muted">{t("ctx.locked")}:</span>
          <MonRow names={locked} dex={dex} lang={lang} />
        </div>
      )}
      {prefer.length > 0 && (
        <div className="uep-card-row">
          <span className="muted">{t("ctx.prefer")}:</span>
          <MonRow names={prefer} dex={dex} lang={lang} />
        </div>
      )}
      {avoid.length > 0 && (
        <div className="uep-card-row">
          <span className="muted">{t("ctx.avoid")}:</span>
          <MonRow names={avoid} dex={dex} lang={lang} />
        </div>
      )}
    </div>
  );
}

// -- audit (context-audit output) ----------------------------------------------------------
function AuditCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const receipt = obj(d.audit_receipt);
  const gaps = arr(d.gaps).map(obj).filter(Boolean) as Record<string, unknown>[];
  const unresolved = arr(d.unresolved_names).map(obj).filter(Boolean) as Record<string, unknown>[];
  const blocking = receipt ? num(receipt.blocking) ?? 0 : 0;
  const conflicts = receipt ? num(receipt.conflicts) ?? 0 : 0;
  return (
    <div className="uep-card">
      <div className="uep-card-row">
        {blocking === 0 && conflicts === 0
          ? <Chip tone="ok">{t("audit.clean")}</Chip>
          : (
            <>
              {blocking > 0 && <Chip tone="bad">{t("audit.blockingChip")} {blocking}</Chip>}
              {conflicts > 0 && <Chip tone="warn">{t("audit.conflictChip")} {conflicts}</Chip>}
            </>
          )}
        {receipt && <span className="mono muted">{str(receipt.fingerprint).slice(0, 12)}</span>}
      </div>
      {unresolved.length > 0 && (
        <div className="uep-card-row">
          <span className="muted">{t("uep.audit.unresolved")}:</span>
          {unresolved.map((u, i) => <Chip key={i} tone="bad">{str(u.query)}</Chip>)}
        </div>
      )}
      {gaps.length > 0 && (
        <ul className="uep-card-list">
          {gaps.map((g, i) => {
            const level = str(g.level);
            const levelKey = optionalKey(`audit.level.${level}`);
            const field = str(g.field) || str(g.trigger);
            const fieldKey = optionalKey(`gapfield.${field}`);
            return (
              <li key={i} title={lang === "en" ? str(g.note) : undefined}>
                <Chip tone={level === "blocking" ? "bad" : level === "conflict" ? "warn" : undefined}>
                  {levelKey ? t(levelKey) : level}
                </Chip>
                {" "}{fieldKey ? t(fieldKey) : field}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// -- frame (skeletons: the grounded lanes a build can take) ----------------------------------
function FrameCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const skeletons = arr(d.skeletons).map(obj).filter(Boolean) as Record<string, unknown>[];
  if (skeletons.length === 0) return null;
  return (
    <div className="uep-card">
      {skeletons.map((s, i) => {
        const prev = obj(s.prevalence);
        const share = prev ? num(prev.share) : null;
        const count = prev ? num(prev.count) : null;
        const cores = (arr(s.core_candidates).map(obj).filter(Boolean) as Record<string, unknown>[])
          .map((c) => str(c.species)).filter(Boolean);
        // hard modes only — `soft` co-occurs with everything and just adds noise
        const modes = Object.keys(obj(obj(s.structural_profile)?.speed_control_modes ?? null) ?? {})
          .filter((m) => m !== "soft");
        return (
          <div key={i} className="uep-frame-row">
            <div className="uep-card-row">
              <span className="mono muted">{str(s.frame_id).slice(0, 8)}</span>
              {modes.map((m) => {
                const k = optionalKey(`frame.mode.${m}`);
                return <Chip key={m}>{k ? t(k) : m}</Chip>;
              })}
              {count !== null && share !== null && (
                <span className="muted num">{count} {t("frame.teams")} · {(share * 100).toFixed(0)}%</span>
              )}
              <Chip tone={str(s.confidence) === "low" || s.thin === true ? "warn" : undefined}>
                {(() => { const k = optionalKey(`conf.${str(s.confidence)}`); return k ? t(k) : str(s.confidence); })()}
              </Chip>
            </div>
            {cores.length > 0 && (
              <div className="uep-card-row">
                <span className="muted">{t("frame.core")}:</span>
                <MonRow names={cores} dex={dex} lang={lang} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// -- slate (slate-evaluate output: the candidate comparison) ---------------------------------
/** Flags collapse by kind: ONE "missing coverage" line and ONE "weak stack" line — a
 * per-flag prefix repeated five times read as noise, not information. */
function FlagLines({ flags }: { flags: Record<string, unknown>[] }) {
  const t = useT();
  const gaps = flags.filter((f) => str(f.kind) === "hard_gap").flatMap((f) => strs(f.types));
  const weaks = flags.filter((f) => str(f.kind) === "weakness_concentration");
  if (gaps.length === 0 && weaks.length === 0) return null;
  return (
    <div className="uep-card-row uep-flags">
      {gaps.length > 0 && (
        <span className="uep-flag">
          {t("slate.missingCoverage")} {gaps.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}
        </span>
      )}
      {weaks.length > 0 && (
        <span className="uep-flag">
          {t("slate.weakStack")}
          {weaks.map((f, i) => (
            <span key={i} className="uep-flag-item">
              <TypeBadge type={str(f.type)} iconOnly />×{num(f.weak_count) ?? "?"}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

function SlateCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const survivors = new Set(arr(d.survivors).map((x) => num(x)).filter((x) => x !== null));
  const candidates = arr(d.candidates).map(obj).filter(Boolean) as Record<string, unknown>[];
  if (candidates.length === 0) return null;
  const megaSlate = obj(d.mega_registration_slate);
  return (
    <div className="uep-card">
      {megaSlate?.status === "missing_modal_lane" && (
        <div className="uep-card-row">
          <Chip tone="warn">{t("mega.missingModal")}</Chip>
        </div>
      )}
      {candidates.map((c, i) => {
        const idx = num(c.index) ?? i;
        const legality = obj(c.legality);
        const issues = arr(legality?.messages).map(obj).filter(Boolean) as Record<string, unknown>[];
        const valid = legality?.status === "valid";
        const eliminated = obj(c.eliminated);
        const flags = arr(c.flags).map(obj).filter(Boolean) as Record<string, unknown>[];
        const mega = obj(c.mega_plan);
        const grades = obj(obj(obj(c.matchup_risk)?.check_coverage ?? null)?.grade_distribution ?? null);
        const species = (arr(obj(c.structural_profile)?.speed_lines ?? null)
          .map(obj).filter(Boolean) as Record<string, unknown>[]).map((l) => str(l.species));
        return (
          <div key={idx} className="uep-slate-cand">
            <div className="uep-card-row">
              <b>{t("uep.slate.candidate")} {idx}</b>
              <Chip tone={valid ? "ok" : "bad"}>{valid ? t("uep.slate.valid") : t("uep.slate.invalid")}</Chip>
              {survivors.has(idx)
                ? <Chip tone="ok">{t("uep.slate.survivor")}</Chip>
                : eliminated && <Chip tone="bad">{t("uep.slate.eliminated")}</Chip>}
              {mega && (() => {
                // 399fcf2: the frame-aware registration relation rides next to the raw count —
                // modal/common read neutral, minority warns, rare flags (labels, never a score).
                const rel = str(obj(c.mega_registration_assessment)?.relation ?? null);
                const relKey = optionalKey(`mega.rel.${rel}`);
                return (
                  <>
                    <Chip>{t("uep.slate.mega")} {num(mega.registered_mega_count) ?? "?"}</Chip>
                    {relKey && (
                      <Chip tone={rel === "rare" ? "bad" : rel === "minority" ? "warn" : undefined}>
                        {t(relKey)}
                      </Chip>
                    )}
                  </>
                );
              })()}
              {grades && (
                <Chip>{t("uep.slate.checks")} C2 {num(grades.C2) ?? 0} · C1 {num(grades.C1) ?? 0} · C0 {num(grades.C0) ?? 0}</Chip>
              )}
            </div>
            {species.length > 0 && <MonRow names={species} dex={dex} lang={lang} />}
            {flags.length > 0 && <FlagLines flags={flags} />}
            {!valid && legality && (
              <ul className="uep-card-list bad">
                {issues.length > 0
                  ? issues.map((issue, j) => {
                      const key = optionalKey(`validation.${str(issue.code)}`);
                      const params = obj(issue.params) ?? {};
                      const text = key ? t(key).replace(/\{([^}]+)\}/g,
                        (_, name: string) => String(params[name] ?? `{${name}}`))
                        : t("uep.slate.invalidDetail");
                      return <li key={j}>{text}</li>;
                    })
                  : lang === "en"
                    ? arr(legality.errors).map((e, j) => <li key={j}>{str(e)}</li>)
                    : <li>{t("uep.slate.invalidDetail")}</li>}
              </ul>
            )}
            {eliminated && (
              <ul className="uep-card-list bad">
                {lang === "en"
                  ? arr(eliminated.reasons).map((r, j) => <li key={j}>{str(r)}</li>)
                  : <li>{t("uep.slate.eliminatedDetail")}</li>}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// -- checkpoint ------------------------------------------------------------------------------
function CheckpointCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  if (typeof d.pause !== "boolean") return null;
  const frames = arr(d.candidate_frames).map(obj).filter(Boolean) as Record<string, unknown>[];
  const questions = arr(d.questions_to_ask).map(obj).filter(Boolean)
    .map((q) => str(obj((q as Record<string, unknown>).text)?.[lang] ?? "")).filter(Boolean);
  return (
    <div className="uep-card">
      <div className="uep-card-row">
        <Chip tone={d.pause ? "warn" : "ok"}>{d.pause ? t("uep.cp.pause") : t("uep.cp.noPause")}</Chip>
        {d.pause && <span className="muted">{t("uep.cp.reason")}</span>}
      </div>
      {questions.length > 0 && (
        <ul className="uep-card-list">
          {questions.map((q, i) => <li key={i}>{q}</li>)}
        </ul>
      )}
      {frames.map((f, i) => (
        <div key={i} className="uep-card-row">
          <span className="muted num">#{num(f.index) ?? i}</span>
          {f.survivor === true && <Chip tone="ok">{t("uep.slate.survivor")}</Chip>}
          <Chip tone={str(f.legality) === "valid" ? "ok" : "bad"}>
            {str(f.legality) === "valid" ? t("uep.slate.valid")
              : str(f.legality) === "invalid" ? t("uep.slate.invalid") : t("uep.slate.unknown")}
          </Chip>
          <MonRow names={strs(f.team_species)} dex={dex} lang={lang} />
        </div>
      ))}
    </div>
  );
}

// -- draft (the structured answer: recommended teams at a glance) -----------------------------
function DraftCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const recommended = arr(d.recommended).map(obj).filter(Boolean) as Record<string, unknown>[];
  if (recommended.length === 0) return null;
  return (
    <div className="uep-card">
      {recommended.map((r, i) => {
        // Full sets ride along: the chip hover can show item/moves/SP, not just the name.
        const members = readTeamMembers(r.team);
        const byName = new Map<string, TeamMemberish>(members.map((m) => [m.species, m]));
        return (
          <div key={i} className="uep-card-row">
            <span className="muted num">#{num(r.slate_index) ?? i}</span>
            <MonRow names={members.map((m) => m.species)} dex={dex} lang={lang} mons={byName} />
          </div>
        );
      })}
    </div>
  );
}

// -- answer-audit ----------------------------------------------------------------------------
function AnswerAuditCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  if (typeof d.pass !== "boolean") return null;
  const checked = obj(d.checked);
  const violations = arr(d.violations);
  return (
    <div className="uep-card">
      <div className="uep-card-row">
        <Chip tone={d.pass ? "ok" : "bad"}>{d.pass ? t("uep.aa.pass") : t("uep.aa.fail")}</Chip>
        {checked && Object.entries(checked).map(([k, v]) => {
          const key = optionalKey(`aa.checked.${k}`);
          return <span key={k} className="muted num">{key ? t(key) : k} {String(v)}</span>;
        })}
      </div>
      {violations.length > 0 && (
        <ul className="uep-card-list bad">
          <li>{t("uep.aa.problemCount").replace("{n}", String(violations.length))}</li>
        </ul>
      )}
    </div>
  );
}

// -- tune-request (panel-authored: the user's plain-language tune ask) -------------------------
function TuneRequestCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const member = str(d.member);
  const benchCount = arr(d.form_benchmarks).length;
  return (
    <div className="uep-card">
      {str(d.note) && <div className="uep-tune-note">{str(d.note)}</div>}
      <div className="uep-card-row">
        {member && <MonRow names={[member]} dex={dex} lang={lang} />}
        {benchCount > 0 && <Chip>{t("ctx.benchmarks")} ×{benchCount}</Chip>}
      </div>
    </div>
  );
}

// -- tune-result (agent-authored: the tune operator's cards, rendered as cliff cards) ----------
function TuneResultCard({ d }: { d: Record<string, unknown> }) {
  const cards = arr(d.cards).filter((c) => obj(c)) as TuneCardDto[];
  if (cards.length === 0) return null;
  return (
    <div className="tune-cards">
      {cards.map((c, i) => <TuneCard key={i} card={c} />)}
    </div>
  );
}

// -- decision (panel-authored, render it nicely too) ------------------------------------------
function DecisionCard({ d }: { d: Record<string, unknown> }) {
  const t = useT();
  if (d.gate !== "checkpoint" || !str(d.action)) return null;
  const label = d.action === "chooseCandidate" ? t("uep.checkpoint.choose")
    : d.action === "requestChanges" ? t("uep.checkpoint.changes")
    : t("uep.checkpoint.proceed");
  return (
    <div className="uep-card">
      <div className="uep-card-row">
        <Chip tone="ok">{label}{num(d.candidateIndex) !== null ? ` #${num(d.candidateIndex)}` : ""}</Chip>
        {str(d.note) && <span className="muted">{str(d.note)}</span>}
        <span className="mono muted num">{str(d.decidedAt)}</span>
      </div>
    </div>
  );
}

// Guard + component pairs: the guard is a PLAIN function (no hooks) so the caller knows
// up front whether a structured card exists and can fall back to raw JSON otherwise.
const RENDERERS: Record<string, {
  test: (d: Record<string, unknown>) => boolean;
  Component: (props: { d: Record<string, unknown> }) => ReactNode;
}> = {
  "context": {
    test: (d) => d.format === "single" || d.format === "double" || arr(d.locked).length > 0,
    Component: ContextCard,
  },
  "audit": { test: (d) => !!obj(d.audit_receipt) || arr(d.gaps).length > 0, Component: AuditCard },
  "frame": { test: (d) => arr(d.skeletons).some((s) => obj(s)), Component: FrameCard },
  "slate": { test: (d) => arr(d.candidates).some((c) => obj(c)), Component: SlateCard },
  "checkpoint": { test: (d) => typeof d.pause === "boolean", Component: CheckpointCard },
  "draft": { test: (d) => arr(d.recommended).some((r) => obj(r)), Component: DraftCard },
  "answer-audit": { test: (d) => typeof d.pass === "boolean", Component: AnswerAuditCard },
  "decision": { test: (d) => d.gate === "checkpoint" && !!str(d.action), Component: DecisionCard },
  "tune-request": { test: (d) => !!str(d.note), Component: TuneRequestCard },
  "tune-result": { test: (d) => arr(d.cards).some((c) => obj(c)), Component: TuneResultCard },
};

/** Structured summary for a known artifact kind, or null → caller shows raw JSON. */
export function renderArtifactCard(kind: string, payloadText: string): ReactNode | null {
  const entry = RENDERERS[kind];
  if (!entry) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadText);
  } catch {
    return null;
  }
  const d = obj(parsed);
  if (!d || !entry.test(d)) return null;
  const { Component } = entry;
  return <Component d={d} />;
}
