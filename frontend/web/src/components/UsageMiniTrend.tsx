import { useId } from "react";
import { useT } from "../i18n.ts";

type State = "loading" | "error" | "missing" | "ready";

export function UsageMiniTrend({ periods, values, state }: {
  periods: string[];
  values?: Array<number | null>;
  state: State;
}) {
  const t = useT();
  const gradientId = useId().replace(/:/g, "");

  if (state === "loading") {
    return <span className="usage-mini usage-mini-state muted">{t("state.loading")}</span>;
  }
  if (state === "error") {
    return <span className="usage-mini usage-mini-state muted">{t("state.error")}</span>;
  }
  const points = (values ?? []).flatMap((value, index) =>
    value == null ? [] : [{ index, value }]);
  if (state === "missing" || points.length < 2 || periods.length < 2) {
    return (
      <span className="usage-mini usage-mini-state muted">
        {t("usageTrend.insufficient")}
      </span>
    );
  }

  const observedMin = Math.min(...points.map((point) => point.value));
  const observedMax = Math.max(...points.map((point) => point.value));
  const observedRange = observedMax - observedMin;
  const domainSpan = Math.max(1, observedRange * 1.8);
  let domainMin = (observedMin + observedMax - domainSpan) / 2;
  let domainMax = domainMin + domainSpan;
  if (domainMin < 0) {
    domainMax -= domainMin;
    domainMin = 0;
  }
  if (domainMax > 100) {
    domainMin -= domainMax - 100;
    domainMax = 100;
  }
  domainMin = Math.max(0, domainMin);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const delta = last.value - first.value;
  const deltaClass = delta > 0.0001 ? "up" : delta < -0.0001 ? "down" : "flat";
  const deltaText = Math.abs(delta) < 0.0001
    ? t("usageTrend.unchanged")
    : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} pt`;

  const width = 292;
  const height = 76;
  const left = 38;
  const right = 6;
  const top = 7;
  const bottom = 9;
  const x = (index: number) =>
    left + index * (width - left - right) / Math.max(1, periods.length - 1);
  const y = (value: number) =>
    top + (domainMax - value) * (height - top - bottom) / (domainMax - domainMin);

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
        <b>{t("usageTrend.title")}</b>
        <span className={`usage-mini-delta ${deltaClass}`}>{deltaText}</span>
      </span>
      <svg className="usage-mini-svg" viewBox={`0 0 ${width} ${height}`} role="img"
        aria-label={`${t("usageTrend.title")}: ${deltaText}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="var(--trend-start)" />
            <stop offset="1" stopColor="var(--trend-end)" />
          </linearGradient>
        </defs>
        <text x="0" y={top + 4}>{domainMax.toFixed(1)}%</text>
        <text x="0" y={height - bottom}>{domainMin.toFixed(1)}%</text>
        <line x1={left} x2={width - right} y1={top} y2={top} className="usage-mini-grid" />
        <line x1={left} x2={width - right} y1={height - bottom}
          y2={height - bottom} className="usage-mini-grid" />
        {runs.map((segment, index) => (
          <polyline key={index} className="usage-mini-line"
            stroke={`url(#${gradientId})`}
            points={segment.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")} />
        ))}
        {points.map((point) => (
          <circle key={point.index} className="usage-mini-point"
            cx={x(point.index)} cy={y(point.value)} r={point.index === last.index ? 2.8 : 1.7}>
            <title>{periods[point.index]!}: {point.value.toFixed(1)}%</title>
          </circle>
        ))}
      </svg>
      <span className="usage-mini-meta muted">
        <span>{periods.length}{t("usageTrend.periodUnit")} · {periods[0]!.slice(5)}–{periods.at(-1)?.slice(5)}</span>
        <span>{t("usageTrend.range")} {observedRange.toFixed(1)} pt · {t("usageTrend.localScale")} {(domainMax - domainMin).toFixed(1)} pt</span>
      </span>
    </span>
  );
}
