/** Everything inferred about the selected opponent beyond its card: how much is left and which
 * natures survive, the drawn state (a ruler per defence, a lane per power item) on the left, and on
 * the right how the real builds and the common spreads fare. The per-stat SP ranges live on their
 * card, beside the build they qualify; the recorded hits sit at the top of the page. */
import type { BuildOption } from "../../../components/build/inputs.tsx";
import {
  bulkProduct, rulerTicks, type BulkKey, type InferKey, type Mult, type SpKey,
} from "./model.ts";
import { useInferT } from "./messages.ts";
import { mark, percent } from "./ObservationLog.tsx";
import { BulkRuler, ItemLanes, type RulerMark } from "./Visuals.tsx";
import type { InferenceView, SetReading } from "./useInference.ts";

const TOTALS = [0, 16, 32, 48, 64];

export interface Labels {
  mon: (uid: string) => string;
  move: (name: string) => string;
  item: (name: string) => string;
  ability: (name: string) => string;
  nature: (name: string) => string;
  stat: (key: SpKey | "spe") => string;
  /** The item boosts damage on its own (a lane of only other items reads "no power item"). */
  powerItem: (name: string) => boolean;
  multOf: (nature: string, key: InferKey) => Mult;
}

function spreadText(sps: Partial<Record<string, number>>, labels: Labels): string {
  const parts = (["hp", "atk", "def", "spa", "spd", "spe"] as const)
    .filter((key) => (sps[key] ?? 0) > 0).map((key) => `${labels.stat(key)} ${sps[key]}`);
  return parts.length ? parts.join(" · ") : "—";
}

function SetRow({ reading, labels, observed, adopted, onApply, onUnadopt }: {
  reading: SetReading;
  labels: Labels;
  observed: boolean;
  adopted: boolean;
  onApply: (option: BuildOption) => void;
  onUnadopt: () => void;
}) {
  const t = useInferT();
  const { candidate, option, shares, fits } = reading;
  const state = !observed ? "idle" : shares === null ? "pending" : fits ? "fit" : "out";
  return (
    <div className={`inf-set ${state}${adopted ? " adopted" : ""}`}>
      <div className="inf-set-main">
        <b>{labels.item(candidate.item) || "—"}</b>
        <span>{labels.ability(candidate.ability)}</span>
        <span>{labels.nature(candidate.nature)}</span>
        {option.coverage !== null && (
          <span className="muted num" title={t("infer.tip.coverage")}>
            {t("infer.sets.coverage").replace("{pct}", percent(option.coverage))}</span>
        )}
      </div>
      <div className="inf-set-sp muted num">{spreadText(candidate.sps, labels)}</div>
      <div className="inf-set-side">
        {observed && shares && shares.map((value, index) => (
          <span key={index} className={`inf-share num${value > 0 ? "" : " zero"}`}
            title={t("infer.tip.share").replace("{n}", mark(index)).replace("{k}", String(Math.round(value * 16)))}>
            {mark(index)}{Math.round(value * 16)}/16</span>
        ))}
        {state === "fit" && <span className="tw-state pass" title={t("infer.tip.fit")}>{t("infer.sets.fit")}</span>}
        {state === "out" && <span className="tw-state fail" title={t("infer.tip.out")}>{t("infer.sets.out")}</span>}
        {adopted ? (
          <button type="button" className="ghost-btn tiny inf-unadopt" title={t("infer.sets.unadoptHint")}
            onClick={onUnadopt}>
            <span className="rest">{t("infer.sets.adopted")}</span>
            <span className="hover">{t("infer.sets.unadopt")}</span>
          </button>
        ) : (
          <button type="button" className="ghost-btn tiny" disabled={observed && !fits}
            title={t("infer.sets.applyHint")} onClick={() => onApply(option)}>{t("infer.sets.apply")}</button>
        )}
      </div>
    </div>
  );
}

export function InferPanel({ foeName: name, view, observed, adoptedKey, onApply, onUnadopt, labels }: {
  foeName: string;
  view: InferenceView;
  /** Some enabled observation is being read. */
  observed: boolean;
  /** The environment card their build still is exactly, if any. */
  adoptedKey: string | null;
  onApply: (option: BuildOption) => void;
  onUnadopt: () => void;
  labels: Labels;
}) {
  const t = useInferT();
  const { info, inference, prior } = view;
  const space = info?.space;
  const shown = inference ?? prior;
  const remaining = inference && prior && prior.count ? inference.count / prior.count : null;

  const rulerMarks = (key: BulkKey): RulerMark[] => !space ? [] : view.sets.map((reading) => ({
    product: bulkProduct(space, key, reading.candidate.sps, labels.multOf(reading.candidate.nature, key)),
    fits: !observed || reading.fits,
    label: `${labels.item(reading.candidate.item)} · ${labels.nature(reading.candidate.nature)} · ${spreadText(reading.candidate.sps, labels)}`,
  }));
  const itemGroup = (names: string[]) => {
    const real = names.filter(Boolean);
    const list = real.length > 3 ? `${real.slice(0, 3).map(labels.item).join("、")} +${real.length - 3}`
      : real.map(labels.item).join("、");
    // A lane holding any plain item reads as "no power item": a power item that landed in it (an
    // Expert Belt on a neutral hit) behaved exactly like one here.
    if (names.every((item) => item && labels.powerItem(item))) return list;
    return list ? `${t("infer.lane.noBoost")}（${list}）` : t("infer.lane.noBoost");
  };

  const nearest = observed && view.sets.length && view.sets.every((reading) => reading.shares && !reading.fits)
    ? view.sets.filter((reading) => reading.nearest)
      .sort((x, y) => x.nearest!.cost - y.nearest!.cost)[0] ?? null
    : null;
  const nearestText = (() => {
    if (!nearest?.nearest) return null;
    const target = nearest.nearest;
    const from = nearest.candidate;
    const diff = (["hp", "atk", "def", "spa", "spd", "spe"] as const)
      .filter((key) => (from.sps[key] ?? 0) !== target.sps[key])
      .map((key) => `${labels.stat(key)} ${from.sps[key] ?? 0}→${target.sps[key]}`);
    if (target.nature !== from.nature) {
      diff.push(t("infer.sets.natureChange").replace("{nature}", labels.nature(target.nature)));
    }
    const set = `${labels.item(from.item)} · ${labels.nature(from.nature)}`;
    // Only the nature is off: the SP already fit, so there is no SP count to quote.
    if (target.cost === 0 && target.nature !== from.nature) {
      return t("infer.sets.nearestNature").replace("{set}", set).replace("{nature}", labels.nature(target.nature));
    }
    return t("infer.sets.nearest").replace("{set}", set)
      .replace("{n}", String(target.cost)).replace("{diff}", diff.join("，") || "—");
  })();

  return (
    <section className="panel inf-panel">
      <header className="inf-panel-head">
        <h3>{t("infer.panel.title").replace("{foe}", name)}</h3>
        {remaining !== null && observed && (
          <span className={`tw-state ${inference!.count ? "idle" : "fail"}`} title={t("infer.tip.states")}>
            {t("infer.states").replace("{pct}", percent(remaining))}</span>
        )}
        {info && (
          <span className="inf-chips inf-natures">
            {info.space.natures.map((nature, n) => {
              const out = !!shown && !shown.natures[n];
              return (
                <span key={nature.name} className={`inf-chip${out ? " out" : ""}`}
                  title={t(out ? "infer.tip.natureOut" : "infer.tip.nature")
                    .replace("{pct}", `${Math.round(nature.prior * 100)}%`)}>
                  {labels.nature(nature.name)}<em className="num">{Math.round(nature.prior * 100)}%</em>
                </span>
              );
            })}
          </span>
        )}
      </header>
      {info && (
        <p className="inf-space-note muted">
          {info.pruned ? t("infer.space").replace("{n}", String(info.space.natures.length))
            .replace("{i}", String(info.space.items.length)).replace("{a}", String(info.space.abilities.length))
            : t("infer.space.unpruned")}
        </p>
      )}

      {observed && inference && inference.count === 0 && <div className="notice inf-bad">{t("infer.contradiction")}</div>}
      {!observed && <p className="inf-empty muted">{t("infer.panel.empty")}</p>}

      <div className="inf-panel-grid">
        <div className="inf-vis-col">
          {space && shown && (["def", "spd"] as const).map((key) => (
            <BulkRuler key={key} statKey={key} ruler={shown.rulers[key]} ticks={rulerTicks(space, key, TOTALS)}
              marks={rulerMarks(key)} statLabel={labels.stat(key)} />
          ))}
          {space && shown && (["atk", "spa"] as const).map((key) => (
            <ItemLanes key={key} statLabel={labels.stat(key)} title={t(key === "atk" ? "infer.lane.atk" : "infer.lane.spa")}
              lanes={shown.lanes[key]} observed={shown.stats[key].observed} itemLabel={itemGroup} />
          ))}
          {!shown && view.loading && <div className="spinner">{t("infer.pending")}</div>}
        </div>

        <div className="inf-vis-col">
          <div className="inf-block">
            <h4 title={t("infer.tip.sets")}>{t("infer.sets")}</h4>
            {view.sets.length === 0 ? <p className="muted inf-empty">{t("infer.sets.empty")}</p> : (
              <>
                {nearest && (
                  <div className="notice inf-bad">
                    <b>{t("infer.sets.none")}</b>{nearestText && <span> · {nearestText}</span>}
                  </div>
                )}
                {[...view.sets].sort((x, y) => Number(y.fits) - Number(x.fits)
                  || (y.option.coverage ?? 0) - (x.option.coverage ?? 0)).map((reading) => (
                  <SetRow key={reading.option.key} reading={reading} labels={labels} observed={observed}
                    adopted={reading.option.key === adoptedKey} onApply={onApply} onUnadopt={onUnadopt} />
                ))}
              </>
            )}
          </div>

          {view.spreads.length > 0 && space && (
            <div className="inf-block">
              <h4 title={t("infer.meta.hint")}>{t("infer.meta")}</h4>
              {view.spreads.map((row, index) => (
                <div key={index} className="inf-spread">
                  <span className="num inf-spread-sp">{spreadText(row.spread, labels)}</span>
                  <span className="muted num" title={t("infer.tip.spreadShare")}>
                    {row.percentage !== null ? `${row.percentage.toFixed(1)}%` : ""}</span>
                  <span className="inf-chips">
                    {row.natures.every((ok) => !ok) && observed
                      ? <span className="inf-chip small out" title={t("infer.tip.spreadOut")}>{t("infer.meta.out")}</span>
                      : space.natures.map((nature, n) => (
                        <span key={nature.name} className={`inf-chip small${row.natures[n] ? " ok" : " out"}`}
                          title={t(row.natures[n] ? "infer.tip.spreadNatureOk" : "infer.tip.spreadNatureOut")}>
                          {labels.nature(nature.name)}</span>
                      ))}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
