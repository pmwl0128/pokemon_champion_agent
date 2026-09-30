/** The result first: effective evidence, possible natures, SP and the joint bulk/firepower view. */
import { bulkProduct, rulerTicks, type InferKey, type Mult, type SpKey } from "./model.ts";
import type { Observation } from "./context.ts";
import { useInferT } from "./messages.ts";
import { percent } from "./ObservationLog.tsx";
import { BulkRuler, InferredCell, ItemLanes } from "./Visuals.tsx";
import type { InferenceView } from "./useInference.ts";
import { observationSummary } from "./presentation.ts";
import { PossibleBuild } from "./PossibleBuild.tsx";
import { SpeedRuler } from "./SpeedRuler.tsx";
import type { Async } from "../../../hooks.ts";
import type { SpeedProjection } from "./speed.ts";
import { useId } from "react";

const TOTALS = [0, 16, 32, 48, 64];
const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;

export interface Labels {
  mon: (uid: string) => string;
  move: (name: string) => string;
  item: (name: string) => string;
  ability: (name: string) => string;
  nature: (name: string) => string;
  stat: (key: SpKey | "spe") => string;
  powerItem: (name: string) => boolean;
  multOf: (nature: string, key: InferKey) => Mult;
}

export function spreadText(sps: Partial<Record<string, number>>, labels: Labels): string {
  const parts = STATS.filter((key) => (sps[key] ?? 0) > 0).map((key) => `${labels.stat(key)} ${sps[key]}`);
  return parts.length ? parts.join(" · ") : "—";
}

export function InferPanel({ foeName, view, speedView, observations, labels }: {
  foeName: string; view: InferenceView; observations: Observation[]; labels: Labels;
  speedView: Async<SpeedProjection | null>;
}) {
  const t = useInferT();
  const scopeHintId = useId();
  const { info, inference, prior } = view;
  const space = info?.space;
  const shown = inference ?? prior;
  const summary = observationSummary(observations, view);
  const observed = summary.acceptedIndexes.length > 0;
  const pending = view.loading;
  const remaining = observed && inference && prior?.count ? inference.count / prior.count : null;
  const state = view.error ? "error" : pending ? "pending" : !observed ? "empty"
    : inference?.count === 0 ? "conflict" : "ready";
  const possibleNatures = space?.natures.filter((_, n) => !observed || pending || shown?.natures[n]) ?? [];
  const natures = [...(space?.natures ?? [])].sort((x, y) =>
    Number(possibleNatures.includes(y)) - Number(possibleNatures.includes(x)));
  const natureShares = observed ? inference?.natureShares : null;
  const shareMode = pending || view.error ? null : observed
    ? natureShares ? "posterior" : null : info?.pruned ? "usage" : null;
  const scopeHint = info ? info.pruned
    ? t("infer.space").replace("{n}", String(info.space.natures.length))
      .replace("{i}", String(info.space.items.length)).replace("{a}", String(info.space.abilities.length))
    : t("infer.space.unpruned") : null;
  const itemGroup = (names: string[]) => {
    const real = names.filter(Boolean);
    const list = real.length > 3 ? `${real.slice(0, 3).map(labels.item).join("、")} +${real.length - 3}`
      : real.map(labels.item).join("、");
    if (names.every((item) => item && labels.powerItem(item))) return list;
    return list ? `${t("infer.lane.noBoost")}（${list}）` : t("infer.lane.noBoost");
  };

  return (
    <section className="panel inf-panel" aria-label={t("infer.result.title")}>
      <header className="inf-panel-head inf-result-head">
        <div><span className="inf-eyebrow">{foeName}</span>
          <h2 className={scopeHint ? "inf-tip hint-tip inf-result-hint" : undefined}
            tabIndex={scopeHint ? 0 : undefined} data-tooltip={scopeHint ?? undefined}
            aria-describedby={scopeHint ? scopeHintId : undefined}>{t("infer.result.title")}</h2>
        </div>
        <div className="inf-result-status">
          <span role="status" className={`tw-state ${state === "conflict" || state === "error" ? "fail"
            : state === "ready" ? "pass" : "idle"}`}>{t(`infer.result.${state}`)}</span>
          <div className="inf-evidence-counts num">
            <span>{t("infer.result.used").replace("{n}", String(summary.acceptedIndexes.length))}</span>
            {summary.pending > 0 && <span>{t("infer.result.pendingCount").replace("{n}", String(summary.pending))}</span>}
            {summary.unused > 0 && <span className="bad">{t("infer.result.unused").replace("{n}", String(summary.unused))}</span>}
            {summary.disabled > 0 && <span className="muted">{t("infer.result.disabled").replace("{n}", String(summary.disabled))}</span>}
            {remaining !== null && <span title={t("infer.tip.states")}>{t("infer.states").replace("{pct}", percent(remaining))}</span>}
          </div>
        </div>
      </header>
      {scopeHint && <span className="sr-only" id={scopeHintId}>{scopeHint}</span>}
      {state === "empty" && <p className="inf-empty muted">{t("infer.panel.empty")}</p>}
      {state === "conflict" && <div className="notice inf-bad">{t("infer.contradiction")}</div>}
      {summary.unused > 0 && <p className="inf-empty muted">{t("infer.result.unusedHint")}</p>}

      <div className="inf-nature-result">
        <div className="inf-nature-head">
          <h3>{t(observed ? "infer.nature.possible" : "infer.nature.candidates")}</h3>
          {!pending && observed && possibleNatures.length > 0 && <span className="inf-nature-note muted">
            {t(possibleNatures.length === 1 ? "infer.nature.single" : "infer.nature.multiple")}</span>}
        </div>
        {pending ? <p className="muted inf-empty">{t("infer.pending")}</p> : (
          <>
            <div className="inf-chips">
              {natures.map((nature) => {
                const share = shareMode === "usage" ? nature.prior : shareMode === "posterior"
                  ? natureShares![space!.natures.indexOf(nature)]! : null;
                const excluded = !possibleNatures.includes(nature);
                return <span key={nature.name} className={`inf-chip${excluded ? " out" : ""}`}
                  title={excluded ? t("infer.nature.ruledOut") : undefined}>{labels.nature(nature.name)}
                  {share !== null && <em className="num">{percent(share)}</em>}
                </span>;
              })}
              {observed && possibleNatures.length === 0 && <span className="muted">{t("infer.ruler.none")}</span>}
              {shareMode && <span className="inf-nature-note muted" title={t(`infer.nature.${shareMode}Hint`)}>
                {t(`infer.nature.${shareMode}Label`)}</span>}
            </div>
          </>
        )}
        <PossibleBuild view={view} observed={observed} labels={labels} />
      </div>

      <div className="inf-sp-result">
        <h3>{t("infer.foe.inferred")}</h3>
        <div className="inf-stat-grid">
          {STATS.map((key) => <div key={key} className="inf-stat-result">
            <span>{labels.stat(key)}</span>
            <InferredCell view={shown?.stats[key] ?? null} showScope={key === "spe"} loading={pending} />
          </div>)}
        </div>
        <p className="inf-legend muted">{t("infer.sp.legend")}</p>
      </div>

      <details className="inf-analysis">
        <summary>{t("infer.analysis")}</summary>
        <div className="inf-vis-col">
          {space && shown && !pending && (["def", "spd"] as const).map((key) =>
            <BulkRuler key={key} statKey={key} ruler={shown.rulers[key]}
              ticks={rulerTicks(space, key, TOTALS)} statLabel={labels.stat(key)}
              marks={observed ? view.sets.map((reading) => ({
                product: bulkProduct(space, key, reading.candidate.sps, labels.multOf(reading.candidate.nature, key)),
                fits: reading.fits,
                label: `${labels.item(reading.candidate.item)} · ${labels.nature(reading.candidate.nature)} · ${spreadText(reading.candidate.sps, labels)}`,
              })) : []} />)}
          {space && shown && !pending && <SpeedRuler value={speedView} natureLabel={labels.nature} />}
          {space && shown && !pending && (["atk", "spa"] as const).map((key) =>
            <ItemLanes key={key} statLabel={labels.stat(key)} title={t(key === "atk" ? "infer.lane.atk" : "infer.lane.spa")}
              lanes={shown.lanes[key]} observed={shown.stats[key].observed} itemLabel={itemGroup} />)}
          {pending && <div className="spinner">{t("infer.pending")}</div>}
        </div>
      </details>
    </section>
  );
}
