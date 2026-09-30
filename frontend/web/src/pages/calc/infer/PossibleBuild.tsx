/** A feasible example, clearly separated from the calculator's shared actual input. */
import { useId } from "react";
import type { Labels } from "./InferPanel.tsx";
import { useInferT } from "./messages.ts";
import { percent } from "./ObservationLog.tsx";
import { possibleBuild } from "./presentation.ts";
import type { InferenceView } from "./useInference.ts";

const STATS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;

export function PossibleBuild({ view, observed, labels }: {
  view: InferenceView; observed: boolean; labels: Labels;
}) {
  const t = useInferT();
  const hintId = useId();
  const example = possibleBuild(view);
  const candidate = example?.candidate;
  const hint = example ? `${t(example.kind === "common" ? "infer.possible.commonHint" : "infer.possible.inferredHint")}${observed
    ? "" : ` ${t("infer.possible.unobserved")}`}` : "";
  return (
    <details className="inf-possible">
      <summary>{t("infer.possible.title")}
        {example && <span className="tw-state idle inf-tip hint-tip inf-possible-hint" tabIndex={0}
          data-tooltip={hint} aria-describedby={hintId}>{t(`infer.possible.${example.kind}`)}</span>}
      </summary>
      {example && <span id={hintId} className="sr-only">{hint}</span>}
      <div className="inf-possible-body">
        {candidate && example ? (
          <>
            <p className="inf-possible-build"><b>{labels.nature(candidate.nature)}</b>
              {" · "}{labels.item(candidate.item) || "—"}{" · "}{labels.ability(candidate.ability) || "—"}</p>
            {example.kind === "common" && example.coverage !== null && <p className="inf-empty muted num">
              {t("infer.sets.coverage").replace("{pct}", percent(example.coverage))}</p>}
            <div className="inf-possible-stats">
              {STATS.map((key) => <div key={key}><span>{labels.stat(key)}</span>
                <b className="num">{candidate.sps[key] ?? 0} SP</b></div>)}
            </div>
          </>
        ) : <p className="inf-empty muted">{t(view.loading ? "infer.pending" : view.error
          ? "infer.result.error" : "infer.ruler.none")}</p>}
      </div>
    </details>
  );
}
