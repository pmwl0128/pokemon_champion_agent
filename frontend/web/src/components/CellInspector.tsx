/** The inspector every matchup cell opens into — the KO grid, the check grid, and the actual-sets
 * workspace all render THIS, so a cell reads the same wherever you clicked it.
 *
 * Each grid used to hand-roll its own panel: different container classes (`notice`/`rolls` here,
 * `md-line` there), different heads, and different amounts of information — the KO grid showed the
 * engine's caveats and both sides' sets, the actual-sets grid showed neither. Callers now normalise
 * their facts into the shapes below and this component owns the layout. */
import type { ReactNode } from "react";
import { optionalKey, useT } from "../i18n.ts";
import { useDamageText } from "../lib/damageText.tsx";


/** A KO verdict in the shape `damageText.ko` renders. Callers MUST prefer the engine's
 * recovery-aware verdict over static rolls: Leftovers can turn a static 2HKO into an 87.5% chance,
 * and labelling that "guaranteed" contradicts the grade, which is computed from the real number. */
export interface KoVerdict {
  text?: string | null;
  n?: number | null;
  guaranteed?: boolean | null;
  chancePct?: number | null;
}

export interface InspectorDamage {
  move: string;
  minPercent: number;
  maxPercent: number;
  ko: KoVerdict;
  /** Engine caveats (multi-hit approximation, ability shifts…). */
  caveats?: ReactNode[];
}

export interface InspectorSpeed {
  mine: number | null;
  theirs: number | null;
  faster?: string | null;
}

export function CellInspector({
  panelRef, head, grade, gradeFacts, directions, speed, sets, extra,
}: {
  panelRef?: React.Ref<HTMLDivElement>;
  head: ReactNode;
  grade?: string | null;
  /** Short qualifiers shown next to the atomic grade (C0 kind, contested…). */
  gradeFacts?: ReactNode[];
  /** Both directions, in the order the caller wants them read. */
  directions: Array<{ label: ReactNode; damage: InspectorDamage | null }>;
  speed?: InspectorSpeed | null;
  sets?: ReactNode;
  extra?: ReactNode;
}) {
  const t = useT();
  const damageText = useDamageText();
  return (
    <div ref={panelRef} className="panel matchup-detail result-inspector" tabIndex={-1}>
      <div className="md-head">
        {head}
        {grade && <span className={`grade-pill grade-${grade}`}>{grade}</span>}
      </div>
      {!!gradeFacts?.length && (
        <div className="md-lines">
          {gradeFacts.map((f, i) => <span key={i}>{f}</span>)}
        </div>
      )}
      {directions.map(({ label, damage }, di) => (
        <div key={di} className="md-dir">
          <div className="md-line md-dir-label">{label}</div>
          {damage ? (
            <>
              <div className="md-line num">
                {damageText.name(damage.move)} · {damage.minPercent}–{damage.maxPercent}%
              </div>
              <div className="md-line">{damageText.ko(damage.ko as never)}</div>
              {damage.caveats?.map((c, i) => (
                <div key={i} className="md-line md-caveat">{c}</div>
              ))}
            </>
          ) : <div className="md-line md-caveat">—</div>}
        </div>
      ))}
      {speed && (
        <div className="md-line md-caveat num">
          {t("matchup.speed")}: {speed.mine ?? "—"} {t("matchup.vs")} {speed.theirs ?? "—"}
          {speed.faster ? ` · ${t(optionalKey(`matchup.faster.${speed.faster}`) ?? "matchup.faster.tie")}` : ""}
        </div>
      )}
      {extra}
      {sets}
    </div>
  );
}


/** The processed set one side was computed with. Lives here rather than in a page so all three
 * grids show it identically (the actual-sets grid previously showed no sets at all). */
export interface InspectorSet {
  species: string;
  runForm?: string | null;
  item?: string | null;
  ability?: string | null;
  nature?: string | null;
  moves?: string[] | null;
  sps?: Record<string, number> | null;
}

export function SetBlock({ title, set, prose }: {
  title: ReactNode;
  set: InspectorSet | undefined;
  /** Defaults to the entity-aware renderer, so callers that just want the block need not wire it. */
  prose?: (text: string) => ReactNode;
}) {
  const damageText = useDamageText();
  prose = prose ?? damageText.name;
  if (!set) return null;
  const line1 = [set.item, set.ability, set.nature].filter(Boolean).join(" · ");
  const sps = set.sps
    ? Object.entries(set.sps).filter(([, v]) => (v ?? 0) > 0)
        .map(([k, v]) => `${k.toUpperCase()} ${v}`).join(" / ")
    : "";
  return (
    <div className="md-set">
      <div className="ms-head">{title}{set.runForm && set.runForm !== set.species && (
        <span className="muted">({prose(set.runForm)})</span>
      )}</div>
      {line1 && <div className="ms-line">{prose(line1)}</div>}
      {set.moves && set.moves.length > 0 && <div className="ms-line">{prose(set.moves.join(" / "))}</div>}
      {sps && <div className="ms-line num">{sps}</div>}
    </div>
  );
}
