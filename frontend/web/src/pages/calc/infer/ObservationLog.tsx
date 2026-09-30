/** The hits recorded against this opponent, beside the forms that add them. */
import type { Observation } from "./context.ts";
import { useInferT } from "./messages.ts";
import type { InferenceView } from "./useInference.ts";

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export const mark = (index: number) => CIRCLED[index] ?? `(${index + 1})`;
export const percent = (value: number) => value > 0 && value < 0.0001 ? "<0.01%"
  : value >= 0.1 ? `${(value * 100).toFixed(0)}%`
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
            const skipped = observation.enabled && view.skipped.has(observation.id);
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
            const conditions = flags.length ? flags.join(" · ") : t("infer.log.noFrame");
            const issue = impossible ? t("infer.log.impossible").replace("{values}", impossible.length
              ? impossible.map((value) => observation.kind === "bulk" ? `${value}%` : `${value} HP`).join(" / ")
              : "—") : skipped ? t("infer.log.skipped") : null;
            return (
              <li key={observation.id} className={`inf-log-row${observation.enabled ? "" : " off"}`}>
                <span className="inf-log-mark">{mark(index)}</span>
                <div className="inf-log-main">
                  <span className="inf-log-who" title={who}>{who}</span>
                  <span className="inf-log-num num">{numbers}</span>
                </div>
                <div className="inf-log-detail">
                  <span className={`inf-log-flags ${issue ? "inf-log-bad" : "muted"}`}
                    title={issue ? `${conditions}\n${issue}${impossible ? `\n${t("infer.log.impossibleHint")}` : ""}` : conditions}>
                    {issue ?? conditions}
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
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
