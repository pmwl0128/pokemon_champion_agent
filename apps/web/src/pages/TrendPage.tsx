import type { FormatId } from "@pokemon-champions/protocol";
import { lazy, Suspense, useState } from "react";
import { FormatTabs } from "../components/FormatTabs.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { useTrend } from "../hooks.ts";
import { useT } from "../i18n.ts";

/** Start the independent chart chunk as soon as the lazy TrendPage module is requested, in parallel
 * with trend data. The ranking/dex entry screen still never pays for ECharts; navigation hover/focus
 * preloads TrendPage and this chunk together instead of creating a data-then-chart waterfall. */
const trendChartModule = import("../components/TrendChart.tsx");
const TrendChart = lazy(() => trendChartModule);

export function TrendPage() {
  const [format, setFormat] = useState<FormatId>("single");
  const trend = useTrend(format);
  const t = useT();

  return (
    <>
      <PageHeader title={t("trend.title")} description={t("trend.description")}>
        <FormatTabs format={format} onChange={setFormat} className="page-tabs" />
      </PageHeader>
      {trend.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
      {trend.status === "error" && (
        <div className="notice">{t("state.errorDetail")}</div>
      )}
      {trend.status === "ready" && (
        <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
          <TrendChart trend={trend.data} />
        </Suspense>
      )}
    </>
  );
}
