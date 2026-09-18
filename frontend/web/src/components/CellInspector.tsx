/** The inspector every matchup cell opens into — the KO grid, the check grid, and the actual-sets
 * workspace all render THIS, so a cell reads the same wherever you clicked it.
 *
 * Each grid used to hand-roll its own panel: different container classes (`notice`/`rolls` here,
 * `md-line` there), different heads, and different amounts of information — the KO grid showed the
 * engine's caveats and both sides' sets, the actual-sets grid showed neither. Callers now normalise
 * their facts into the shapes below and this component owns the layout. */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n.ts";
import { useDamageText } from "../lib/damageText.tsx";
import { BuildSetSummary, type BuildCardOption } from "./BuildPicker.tsx";


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
  fasterName?: string | null;
}

export interface InspectorBuild {
  /** Used only by the plain-text copy; the visible title already establishes both names. */
  label: string;
  option: BuildCardOption | null;
  index?: number;
}

export function CellInspector({
  panelRef, head, grade, gradeFacts, directions, speed, builds, calculate, extra,
}: {
  panelRef?: React.Ref<HTMLDivElement>;
  head: ReactNode;
  grade?: string | null;
  /** Short qualifiers shown next to the atomic grade (C0 kind, contested…). */
  gradeFacts?: ReactNode[];
  /** Both directions, in the order the caller wants them read. */
  directions: Array<{ label: ReactNode; damage: InspectorDamage | null }>;
  speed?: InspectorSpeed | null;
  /** Same complete configuration cards used by the table-head popover. */
  builds?: InspectorBuild[];
  /** Calculator hand-off button, rendered before the copy action in the title row. */
  calculate?: ReactNode;
  extra?: ReactNode;
}) {
  const t = useT();
  const damageText = useDamageText();
  const rootRef = useRef<HTMLDivElement>(null);
  const resetTimer = useRef<number | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const attachRef = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node;
    if (typeof panelRef === "function") panelRef(node);
    else if (panelRef) (panelRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
  }, [panelRef]);

  useEffect(() => () => {
    if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
  }, []);

  const speedResult = speed?.mine != null && speed.theirs != null && speed.mine === speed.theirs
    ? t("matchup.faster.tie")
    : speed?.fasterName
      ? t("matchup.faster.named").replace("{name}", speed.fasterName)
      : null;

  const copyAll = async () => {
    const root = rootRef.current;
    if (!root) return;
    const clean = (node: Element | null) => (node as HTMLElement | null)?.innerText
      .split("\n").map((line) => line.trim()).filter(Boolean).join("\n") ?? "";
    const sections = [clean(root.querySelector(".md-head-summary"))];
    root.querySelectorAll<HTMLElement>(".md-build-slot").forEach((slot) => {
      const readAll = (selector: string) => Array.from(slot.querySelectorAll(selector))
        .map((node) => clean(node)).filter(Boolean);
      const identity = readAll(".build-card-identity > span:not(.build-card-sep)");
      const tag = clean(slot.querySelector(".build-card-tag"));
      const share = clean(slot.querySelector(".build-card-share"));
      const lines = [
        [slot.dataset.copyLabel, tag, share].filter(Boolean).join(" · "),
        t("calc.item") + ": " + (clean(slot.querySelector(".build-card-primary > b")) || "—"),
        t("calc.ability") + ": " + (identity[0] ?? "—"),
        t("calc.nature") + ": " + (identity[1] ?? "—"),
        t("calc.sps") + ": " + (readAll(".build-card-sp-stat").join(" / ") || "—"),
        t("matchup.copy.moves") + ": "
          + (readAll(".build-card-move > span:last-child").join(" / ") || "—"),
        t("matchup.copy.stats") + ": " + (readAll(".build-card-stat").join(" / ") || "—"),
      ];
      sections.push(lines.join("\n"));
    });
    root.querySelectorAll<HTMLElement>(".md-directions .md-dir").forEach((dir) => {
      const body = clean(dir);
      if (body) sections.push(body);
    });
    const extraText = clean(root.querySelector(".md-extra"));
    if (extraText) sections.push(extraText);
    const text = sections.filter(Boolean).join("\n\n");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      setCopyState(copied ? "copied" : "failed");
    }
    if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1800);
  };

  return (
    <div ref={attachRef} className="panel matchup-detail result-inspector" tabIndex={-1}>
      <div className="md-head">
        <div className="md-head-summary">
          <span className="md-head-pair">{head}</span>
          {speed && (
            <span className="md-head-speed num">
              {t("matchup.speed")}: {speed.mine ?? "—"} {t("matchup.vs")} {speed.theirs ?? "—"}
              {speedResult ? ` · ${speedResult}` : ""}
            </span>
          )}
          {grade && <span className={`grade-pill grade-${grade}`}>{grade}</span>}
          {gradeFacts?.map((fact, index) => <span className="md-head-fact" key={index}>{fact}</span>)}
        </div>
        <div className="md-head-actions">
          {calculate}
          <button type="button" className="second-btn md-copy" onClick={() => void copyAll()}>
            {t(copyState === "copied" ? "matchup.copied"
              : copyState === "failed" ? "matchup.copyFailed" : "matchup.copy")}
          </button>
        </div>
      </div>
      {!!builds?.length && (
        <div className="md-build-cards">
          {builds.map((build, index) => (
            <div className="build-card md-build-slot" data-copy-label={build.label}
                 key={build.option?.key ?? build.label + "-" + index}>
              {build.option
                ? <BuildSetSummary option={build.option} index={build.index ?? index} />
                : <span className="md-build-missing">—</span>}
            </div>
          ))}
        </div>
      )}
      <div className="md-directions">
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
      </div>
      {extra && (
        <div className="md-extra">
          {extra}
        </div>
      )}
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
