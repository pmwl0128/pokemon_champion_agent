/** Right-side trend overlay sized to the original content-column chart. Neither this module, its data nor ECharts loads before opening the
 * right-edge handle. The app shell keeps it mounted across ranking/detail navigation. */
import type { FormatId } from "@pokemon-champions/protocol";
import { lazy, Suspense } from "react";
import { FormatTabs } from "./FormatTabs.tsx";
import { RailLayer, useRailEscape, type RailState } from "./SideRail.tsx";
import { useTrend } from "../hooks.ts";
import { useT } from "../i18n.ts";

// Start the original chart chunk alongside the trend request, but only after this drawer opens.
const trendChartModule = import("./TrendChart.tsx");
const TrendChart = lazy(() => trendChartModule);

export function TrendDrawer({ state, format, onFormatChange }: {
  state: RailState;
  format: FormatId;
  onFormatChange: (format: FormatId) => void;
}) {
  const trend = useTrend(format);
  const t = useT();
  useRailEscape(state);

  return (
    <RailLayer state={state} label={t("trend.title")} className="trend-overlay"
      headDescription={t("trend.description")}
      headActions={<FormatTabs format={format} onChange={onFormatChange} className="page-tabs" />}>
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
    </RailLayer>
  );
}
