import { useId } from "react";
import type { Async } from "../../../hooks.ts";
import type { SpeedProjection } from "./speed.ts";
import { useInferT } from "./messages.ts";

export function SpeedRuler({ value, natureLabel }: {
  value: Async<SpeedProjection | null>; natureLabel: (name: string) => string;
}) {
  const t = useInferT();
  const hintId = useId();
  const data = value.status === "ready" ? value.data : null;
  const ends = data ? [...data.ranges.flatMap((row) => [row.lo, row.hi]), ...(data.mine !== null ? [data.mine] : [])] : [];
  const lo = ends.length ? Math.max(0, Math.min(...ends) - 5) : 0;
  const hi = ends.length ? Math.max(...ends) + 5 : 1;
  const position = (speed: number) => 100 * (speed - lo) / (hi - lo);
  return (
    <div className="inf-speed-ruler">
      <div className="inf-vis-head"><b className="inf-tip hint-tip inf-speed-hint" tabIndex={0}
        data-tooltip={t("infer.speed.hint")} aria-describedby={hintId}>{t("infer.speed.title")}</b>
        {data?.mine !== null && data?.mine !== undefined && <span className="inf-vis-sum num">
          <i className="inf-speed-legend" />{t("infer.speed.mine").replace("{n}", String(data.mine))}</span>}
      </div>
      <span className="sr-only" id={hintId}>{t("infer.speed.hint")}</span>
      {value.status === "loading" ? <p className="inf-empty muted">{t("infer.pending")}</p>
        : value.status === "error" || data?.incomplete ? <p className="inf-empty bad">{t("infer.speed.error")}</p>
        : !data?.ranges.length ? <p className="inf-empty muted">{t("infer.ruler.none")}</p>
        : <>
          {data.ranges.map((row) => <div key={row.nature} className="inf-speed-row">
            <span className="inf-speed-name">{natureLabel(row.nature)}<small className="muted num">0–{row.spHi} SP</small></span>
            <div className="inf-speed-track" title={`${natureLabel(row.nature)} · ${row.lo}–${row.hi}`}>
              <i className="inf-speed-band" style={{ left: `${position(row.lo)}%`, width: `${Math.max(.8, position(row.hi) - position(row.lo))}%` }} />
              {data.mine !== null && <span className="inf-speed-dot" style={{ left: `${position(data.mine)}%` }}
                title={t("infer.speed.mine").replace("{n}", String(data.mine))} />}
            </div><span className="num inf-lane-span">{row.lo}–{row.hi}</span>
          </div>)}
          <div className="inf-speed-axis num muted"><span>{lo}</span><span>{hi}</span></div>
        </>}
    </div>
  );
}
