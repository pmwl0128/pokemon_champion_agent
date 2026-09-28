/** The environment page's trend view: the global rank-trend chart at the content column's width.
 * Neither this module, its data nor the chart loads before the reader switches to it. */
import type { FormatId } from "@pokemon-champions/protocol";
import { lazy, Suspense } from "react";
import { useTrend } from "../hooks.ts";
import { useT } from "../i18n.ts";

// Start the chart chunk alongside the trend request, but only once this view is shown.
const trendChartModule = import("./TrendChart.tsx");
const TrendChart = lazy(() => trendChartModule);

export function TrendView({ format }: { format: FormatId }) {
  const trend = useTrend(format);
  const t = useT();

  return (
    <section className="trend-view">
      <p className="trend-view-lead muted">{t("trend.description")}</p>
      {trend.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
      {trend.status === "error" && <div className="notice">{t("state.errorDetail")}</div>}
      {trend.status === "ready" && (
        <>
          {trend.data.periods.length < 2 && (
            <p className="notice trend-snapshot-note">{t("trend.singleSnapshot")}</p>
          )}
          <p className="trend-scroll-hint">{t("trend.scrollHint")}</p>
          <div className="trend-view-scroll" data-scroll-region>
            <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
              <TrendChart trend={trend.data} />
            </Suspense>
          </div>
        </>
      )}
    </section>
  );
}
