/** The hover-card sparkline for one panel row.
 *
 * Two kinds, because the detail page carries two kinds of history and they must not be drawn on the
 * same axis:
 *   - "pct": the five usage panels, whose values are percentages of a measured field.
 *   - "rank": the teammate panel and the two KO panels. Those upstreams publish an ORDERING and no
 *     share, so the series is a rank. A rank is not a small percentage — it has no zero, its axis
 *     runs the other way (1 is the top), and "moved up 3" is its unit of change.
 *
 * A single observed point is drawn as a point and labelled as one period, not hidden behind "not
 * enough history": for an axis that has only ever been captured once, one point IS the whole truth,
 * and showing nothing would read as "we have no data".
 */
import { useId } from "react";
import { useT } from "../i18n.ts";

type State = "loading" | "error" | "missing" | "ready";

const WIDTH = 292;
const HEIGHT = 76;
const LEFT = 38;
const RIGHT = 6;
const TOP = 7;
const BOTTOM = 9;

function MiniTrend({ periods, values, state, kind }: {
  periods: string[];
  values?: Array<number | null>;
  state: State;
  kind: "pct" | "rank";
}) {
  const t = useT();
  const gradientId = useId().replace(/:/g, "");
  const rank = kind === "rank";

  if (state === "loading") {
    return <span className="usage-mini usage-mini-state muted">{t("state.loading")}</span>;
  }
  if (state === "error") {
    return <span className="usage-mini usage-mini-state muted">{t("state.error")}</span>;
  }
  const points = (values ?? []).flatMap((value, index) =>
    value == null ? [] : [{ index, value }]);
  if (state === "missing" || points.length === 0 || periods.length === 0) {
    return (
      <span className="usage-mini usage-mini-state muted">
        {t("usageTrend.insufficient")}
      </span>
    );
  }

  const observedMin = Math.min(...points.map((point) => point.value));
  const observedMax = Math.max(...points.map((point) => point.value));
  const observedRange = observedMax - observedMin;
  // A one-point series has no range to scale to, so it gets a fixed window around its own value —
  // the dot then sits mid-axis instead of on an edge that would imply a direction.
  const minSpan = rank ? 2 : 1;
  const domainSpan = points.length < 2
    ? Math.max(minSpan, rank ? Math.max(4, observedMin * 0.4) : 2)
    : Math.max(minSpan, observedRange * 1.8);
  let domainMin = (observedMin + observedMax - domainSpan) / 2;
  let domainMax = domainMin + domainSpan;
  const floor = rank ? 1 : 0;
  if (domainMin < floor) {
    domainMax += floor - domainMin;
    domainMin = floor;
  }
  if (!rank && domainMax > 100) {
    domainMin = Math.max(0, domainMin - (domainMax - 100));
    domainMax = 100;
  }

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const delta = last.value - first.value;
  const single = points.length < 2;
  // For a rank, a SMALLER number is the better outcome, so the arrow and the up/down class follow
  // the meaning ("moved up"), not the sign of the subtraction.
  const deltaClass = single ? "flat"
    : (rank ? delta < 0 : delta > 0.0001) ? "up"
      : (rank ? delta > 0 : delta < -0.0001) ? "down" : "flat";
  const deltaText = single
    ? t("usageTrend.singlePeriod")
    : rank
      ? (delta === 0 ? t("usageTrend.unchanged")
        : `${delta < 0 ? "↑" : "↓"}${Math.abs(delta)} ${t("usageTrend.rankUnit")}`)
      : (Math.abs(delta) < 0.0001 ? t("usageTrend.unchanged")
        : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pt`);
  const title = t(rank ? "usageTrend.rankTitle" : "usageTrend.title");
  const fmt = (value: number) => rank ? `#${Math.round(value)}` : `${value.toFixed(1)}%`;

  const x = (index: number) => periods.length < 2
    ? (LEFT + WIDTH - RIGHT) / 2
    : LEFT + index * (WIDTH - LEFT - RIGHT) / (periods.length - 1);
  // Rank axis runs downward: #1 at the top, because that is where a reader looks for the leader.
  const y = (value: number) => {
    const span = domainMax - domainMin || 1;
    const ratio = rank ? (value - domainMin) / span : (domainMax - value) / span;
    return TOP + ratio * (HEIGHT - TOP - BOTTOM);
  };

  const runs: Array<Array<{ index: number; value: number }>> = [];
  let run: Array<{ index: number; value: number }> = [];
  (values ?? []).forEach((value, index) => {
    if (value == null) {
      if (run.length) runs.push(run);
      run = [];
    } else {
      run.push({ index, value });
    }
  });
  if (run.length) runs.push(run);

  return (
    <span className="usage-mini">
      <span className="usage-mini-head">
        <b>{title}</b>
        <span className={`usage-mini-delta ${deltaClass}`}>{deltaText}</span>
      </span>
      <svg className="usage-mini-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
        aria-label={`${title}: ${deltaText}`}>
        <defs>
          {/* userSpaceOnUse, not the default objectBoundingBox: an unchanged series draws a
              perfectly horizontal polyline whose bounding box has ZERO height, and a bbox-relative
              gradient on a zero-extent box paints nothing — which is why a flat trend showed its
              dots but no line. User-space coordinates have no such degenerate case. */}
          <linearGradient id={gradientId} gradientUnits="userSpaceOnUse"
            x1={LEFT} y1="0" x2={WIDTH - RIGHT} y2="0">
            <stop offset="0" stopColor="var(--trend-start)" />
            <stop offset="1" stopColor="var(--trend-end)" />
          </linearGradient>
        </defs>
        <text x="0" y={TOP + 4}>{fmt(rank ? domainMin : domainMax)}</text>
        <text x="0" y={HEIGHT - BOTTOM}>{fmt(rank ? domainMax : domainMin)}</text>
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={TOP} y2={TOP} className="usage-mini-grid" />
        <line x1={LEFT} x2={WIDTH - RIGHT} y1={HEIGHT - BOTTOM}
          y2={HEIGHT - BOTTOM} className="usage-mini-grid" />
        {runs.map((segment, index) => (
          <polyline key={index} className="usage-mini-line"
            stroke={`url(#${gradientId})`}
            points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")} />
        ))}
        {points.map((point) => (
          <circle key={point.index} className="usage-mini-point"
            cx={x(point.index)} cy={y(point.value)}
            r={single || point.index === last.index ? 2.8 : 1.7}>
            <title>{periods[point.index]!}: {fmt(point.value)}</title>
          </circle>
        ))}
      </svg>
      <span className="usage-mini-meta muted">
        <span>
          {periods.length}{t("usageTrend.periodUnit")} · {periods[0]!.slice(5)}
          {periods.length > 1 ? `–${periods.at(-1)?.slice(5)}` : ""}
        </span>
        <span>
          {t("usageTrend.range")} {rank ? observedRange : observedRange.toFixed(1)}
          {rank ? ` ${t("usageTrend.rankUnit")}` : " pt"} · {t("usageTrend.localScale")}{" "}
          {rank ? Math.round(domainMax - domainMin) : (domainMax - domainMin).toFixed(1)}
          {rank ? ` ${t("usageTrend.rankUnit")}` : " pt"}
        </span>
      </span>
    </span>
  );
}

export function UsageMiniTrend(props: { periods: string[]; values?: Array<number | null>; state: State }) {
  return <MiniTrend {...props} kind="pct" />;
}

/** Rank history for a species-level panel row (a teammate, a KO opponent). */
export function RankMiniTrend(props: { periods: string[]; values?: Array<number | null>; state: State }) {
  return <MiniTrend {...props} kind="rank" />;
}
