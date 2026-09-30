/** Environment references are secondary to inference. Applying one edits the same shared MonState
 * used by all four calc tools; browsing or expanding this panel never writes to it. */
import type { FormatId, NatureDto } from "@pokemon-champions/protocol";
import { BuildPickerButton, natureLabel, type BuildOption } from "../../../components/build/inputs.tsx";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { effectiveEntry, finalStat, maxHPOf, type MonState } from "../duel/state.ts";
import type { Observation } from "./context.ts";
import { spreadText, type Labels } from "./InferPanel.tsx";
import { mark, percent } from "./ObservationLog.tsx";
import { useLang } from "../../../i18n.ts";
import { observationSummary } from "./presentation.ts";
import { useInferT } from "./messages.ts";
import type { InferenceView, SetReading } from "./useInference.ts";

function SetRow({ reading, labels, observed, indexes, adopted, onApply }: {
  reading: SetReading; labels: Labels; observed: boolean; indexes: number[]; adopted: boolean;
  onApply: (option: BuildOption) => void;
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
        {option.coverage !== null && <span className="muted num" title={t("infer.tip.coverage")}>
          {t("infer.sets.coverage").replace("{pct}", percent(option.coverage))}</span>}
      </div>
      <div className="inf-set-sp muted num">{spreadText(candidate.sps, labels)}</div>
      <div className="inf-set-side">
        {observed && shares && shares.map((value, index) => (
          <span key={index} className={`inf-share num${value > 0 ? "" : " zero"}`}
            title={t("infer.tip.share").replace("{n}", mark(indexes[index]!))
              .replace("{k}", String(Math.round(value * 16)))}>
            {mark(indexes[index]!)}{Math.round(value * 16)}/16
          </span>
        ))}
        {state === "fit" && <span className="tw-state pass" title={t("infer.tip.fit")}>{t("infer.sets.fit")}</span>}
        {state === "out" && <span className="tw-state fail" title={t("infer.tip.out")}>{t("infer.sets.out")}</span>}
        {adopted ? <span className="tw-state idle">{t("infer.sets.adopted")}</span> : (
          <button type="button" className="ghost-btn tiny" disabled={observed && !fits}
            title={t("infer.sets.applyHint")} onClick={() => onApply(option)}>{t("infer.sets.apply")}</button>
        )}
      </div>
    </div>
  );
}

/** A compact inspection of the existing shared calculator input, never an inference constraint. */
function ActualBuild({ foe, dex, items, natures, format, adoptedKey, observed, fit,
  onApply, onUnadopt, labels }: {
  foe: MonState; dex: DexIndexEntry[]; items: ItemRef[]; natures: NatureDto[]; format: FormatId;
  adoptedKey: string | null; observed: boolean; fit: boolean | null;
  onApply: (option: BuildOption) => void; onUnadopt: () => void; labels: Labels;
}) {
  const t = useInferT();
  const { lang } = useLang();
  const entry = effectiveEntry(foe, dex, items);
  const nature = natures.find((candidate) => candidate.name === foe.nature);
  const filled = !!foe.nature || Object.values(foe.sps).some((value) => (value ?? 0) > 0);
  return (
    <section className="inf-current-reference" aria-label={t("infer.reference.current")}>
      <header className="inf-panel-head inf-current-head">
        <div className="inf-current-title">
          <h3>{t("infer.reference.current")}</h3>
          {fit !== null && observed && <span className={`tw-state ${fit ? "pass" : "fail"}`}>
            {t(fit ? "infer.reference.fit" : "infer.reference.out")}</span>}
        </div>
        <div className="inf-reference-actions">
          {filled && <button type="button" className="ghost-btn tiny" onClick={onUnadopt}
            title={t("infer.sets.unadoptHint")}>{t("infer.sets.unadopt")}</button>}
          <BuildPickerButton slug={foe.slug} format={format} currentKey={adoptedKey ?? undefined}
            onPick={onApply} className="ghost-btn tiny" label={t("infer.reference.pick")} />
        </div>
      </header>
      <p className="inf-result-note muted">{t("infer.reference.hint")}</p>
      <p className="inf-reference-build">
        {nature ? natureLabel(nature, lang) : "—"}
        {" · "}{labels.item(foe.item) || "—"}{" · "}{labels.ability(foe.ability) || "—"}
      </p>
      <div className="inf-reference-stats">
        {(["hp", "atk", "def", "spa", "spd", "spe"] as const).map((key) => (
          <div key={key}><span>{labels.stat(key)}</span>
            <span className="num">{filled ? `${foe.sps[key] ?? 0} SP` : "—"}</span>
            <span className="num muted">{t("infer.reference.stat").replace("{n}", filled
              ? String(key === "hp" ? maxHPOf(foe, dex, items) : finalStat(foe, entry, natures, key)) : "—")}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ReferencePanel({ foe, dex, items, natures, format, view, observations,
  adoptedKey, onApply, onUnadopt, labels }: {
  foe: MonState; dex: DexIndexEntry[]; items: ItemRef[]; natures: NatureDto[]; format: FormatId;
  view: InferenceView; observations: Observation[]; adoptedKey: string | null;
  onApply: (option: BuildOption) => void; onUnadopt: () => void; labels: Labels;
}) {
  const t = useInferT();
  const indexes = observationSummary(observations, view).acceptedIndexes;
  const observed = indexes.length > 0;
  const space = view.info?.space;
  return (
    <details className="panel inf-reference-panel">
      <summary>{t("infer.reference.title")}</summary>
      <div className="inf-reference-content">
        <div className="inf-reference-grid">
          <div className="inf-reference-left">
            <div className="inf-block">
              <h3 title={t("infer.tip.sets")}>{t("infer.sets")}</h3>
              <p className="inf-result-note muted">{t("infer.sets.explanation")}</p>
              {view.loading ? <p className="muted">{t("infer.pending")}</p>
                : view.sets.length === 0 ? <p className="muted inf-empty">{t("infer.sets.empty")}</p> : (
                  <>
                    {observed && view.sets.every((reading) => reading.shares && !reading.fits) &&
                      <div className="notice inf-bad"><b>{t("infer.sets.none")}</b>
                        {view.inference?.count ? <span> · {t("infer.sets.otherPossible")}</span> : null}
                      </div>}
                    {[...view.sets].sort((x, y) => Number(y.fits) - Number(x.fits)
                      || (y.option.coverage ?? 0) - (x.option.coverage ?? 0)).map((reading) =>
                      <SetRow key={reading.option.key} reading={reading} labels={labels} observed={observed}
                        indexes={indexes} adopted={reading.option.key === adoptedKey} onApply={onApply} />)}
                  </>
                )}
            </div>
            <ActualBuild foe={foe} dex={dex} items={items} natures={natures} format={format}
              adoptedKey={adoptedKey} observed={observed} fit={view.currentFits}
              onApply={onApply} onUnadopt={onUnadopt} labels={labels} />
          </div>
          {view.spreads.length > 0 && space && (
            <div className="inf-block">
              <h3 title={t("infer.meta.hint")}>{t("infer.meta")}</h3>
              {view.spreads.map((row, index) => {
                const excluded = observed && row.natures.every((ok) => !ok);
                const spread = spreadText(row.spread, labels);
                return <div key={index} className={`inf-spread${excluded ? " out" : ""}`}>
                  <span className="num inf-spread-sp" title={spread}>{spread}</span>
                  <span className="muted num" title={t("infer.tip.spreadShare")}>
                    {row.percentage !== null ? t("infer.reference.usage").replace("{pct}", `${row.percentage.toFixed(1)}%`) : ""}</span>
                  <span className="inf-chips">
                    {excluded ? <span className="inf-chip small" title={t("infer.tip.spreadOut")}>{t("infer.meta.out")}</span>
                      : space.natures.map((nature, n) => (
                        <span key={nature.name} className={`inf-chip small${observed ? row.natures[n] ? " ok" : " out" : ""}`}
                          title={observed ? t(row.natures[n] ? "infer.tip.spreadNatureOk" : "infer.tip.spreadNatureOut") : undefined}>
                          {labels.nature(nature.name)}</span>
                      ))}
                  </span>
                </div>;
              })}
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
