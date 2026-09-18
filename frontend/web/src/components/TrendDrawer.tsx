/** Right-side trend overlay sized to the original content-column chart. Neither this module, its data nor ECharts loads before opening the
 * right-edge handle. The app shell keeps it mounted across ranking/detail navigation. */
import type { FormatId } from "@pokemon-champions/protocol";
import { lazy, Suspense } from "react";
import { useTrend } from "../hooks.ts";
import { useT } from "../i18n.ts";

// Start the original chart chunk alongside the trend request, but only after this drawer opens.
const trendChartModule = import("./TrendChart.tsx");
const TrendChart = lazy(() => trendChartModule);

export function TrendDrawer({ format }: {
  format: FormatId;
}) {
  const trend = useTrend(format);
  const t = useT();

  return (
    <div className="trend-rail-body">
      {trend.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
      {trend.status === "error" && <div className="notice">{t("state.errorDetail")}</div>}
      {trend.status === "ready" && (
        <>
          {trend.data.periods.length < 2 && (
            <p className="notice trend-snapshot-note">{t("trend.singleSnapshot")}</p>
          )}
          <p className="trend-scroll-hint">{t("trend.scrollHint")}</p>
          <div className="trend-overlay-chart-scroll" data-scroll-region>
            <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
              <TrendChart trend={trend.data} preserveDrawer />
            </Suspense>
          </div>
        </>
      )}
    </div>
  );
}
