/** The hits recorded against the opponent on screen, right under the rosters so that dropping or
 * muting one is a click away from the cards that add them. Each row carries the frame it froze. */
import { Fragment } from "react";
import type { Observation } from "./context.ts";
import { useInferT } from "./messages.ts";
import type { InferenceView } from "./useInference.ts";

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export const mark = (index: number) => CIRCLED[index] ?? `(${index + 1})`;
export const percent = (value: number) => value >= 0.1 ? `${(value * 100).toFixed(0)}%`
  : value >= 0.001 ? `${(value * 100).toFixed(1)}%` : `${(value * 100).toFixed(2)}%`;

export function ObservationLog({ foeName, observations, view, monName, moveName, frameOf, onToggle, onRemove }: {
  foeName: string;
  observations: Observation[];
  view: InferenceView;
  monName: (uid: string) => string;
  moveName: (move: string) => string;
  /** The frame a record froze, in words. */
  frameOf: (observation: Observation) => string[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const t = useInferT();
  return (
    <section className="panel inf-log-panel">
      <header className="inf-log-head">
        <h3>{t("infer.log.title").replace("{foe}", foeName)}</h3>
        {observations.length > 0 && <span className="muted inf-h-note">{t("infer.log.hint")}</span>}
      </header>
      {observations.length === 0 ? <p className="muted inf-empty">{t("infer.log.empty")}</p> : (
        <ol className="inf-log">
          {observations.map((observation, index) => {
            const impossible = observation.enabled ? view.impossible.get(observation.id) : undefined;
            const left = view.remaining.get(observation.id);
            const who = observation.kind === "bulk"
              ? `${monName(observation.mineId)} · ${moveName(observation.move)} → ${foeName}`
              : `${foeName} · ${moveName(observation.move)} → ${monName(observation.mineId)}`;
            const numbers = observation.kind === "bulk"
              ? `${observation.before}% → ${observation.after}%`
              : `${observation.before} → ${observation.after} HP`;
            const flags = [
              ...(observation.crit ? [t("infer.log.crit")] : []),
              ...(observation.singleTarget ? [t("infer.log.single")] : []),
              ...frameOf(observation),
            ];
            return (
              <li key={observation.id} className={`inf-log-row${observation.enabled ? "" : " off"}`}>
                <span className="inf-log-mark">{mark(index)}</span>
                <span className="inf-log-who" title={who}>{who}</span>
                <span className="inf-log-num num">{numbers}</span>
                <span className="inf-log-flags muted" title={flags.join(" · ")}>
                  {flags.length ? flags.map((flag, at) => <Fragment key={at}>{at ? " · " : ""}{flag}</Fragment>)
                    : t("infer.log.noFrame")}
                </span>
                <span className="inf-log-left num" title={t("infer.log.remainingHint")}>
                  {observation.enabled && left != null ? t("infer.log.remaining").replace("{pct}", percent(left)) : ""}
                </span>
                <span className="inf-log-actions">
                  <button type="button" className="ghost-btn tiny" onClick={() => onToggle(observation.id)}>
                    {t(observation.enabled ? "infer.log.disable" : "infer.log.enable")}</button>
                  <button type="button" className="ghost-btn tiny" onClick={() => onRemove(observation.id)}>
                    {t("infer.log.remove")}</button>
                </span>
                {impossible && (
                  <p className="inf-log-bad" title={t("infer.log.impossibleHint")}>
                    {t("infer.log.impossible").replace("{values}", impossible.length
                      ? impossible.map((value) => observation.kind === "bulk" ? `${value}%` : `${value} HP`).join(" / ")
                      : "—")}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
