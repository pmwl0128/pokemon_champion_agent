/** Online assistance surface: fact Q&A is the default tab, beside the generation wizard and the
 * optional deterministic diagnosis tab. The builder chunk is not requested until either team tab
 * is opened; once visited it remains mounted so in-flight jobs and hand-offs survive tab switches. */
import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader.tsx";
import {
  SegmentedControl, segmentedPanelId, segmentedTabId,
} from "../components/SegmentedControl.tsx";
import { useT } from "../i18n.ts";
import { useRuntime } from "../runtime/context.tsx";

const QaPage = lazy(() => import("./QaPage.tsx").then((m) => ({ default: m.QaPage })));
const BuilderPage = lazy(() => import("./BuilderPage.tsx")
  .then((m) => ({ default: m.BuilderPage })));

type AssistantTab = "qa" | "wizard" | "diagnose";

export function AssistantPage() {
  const { adapter, can } = useRuntime();
  const t = useT();
  const [params, setParams] = useSearchParams();
  const showQa = can("llm.qa") && !!adapter.qa;
  const showWizard = can("llm.builder") && !!adapter.builder;
  const showDiagnose = can("team.validate") && !!adapter.diagnose;
  const tabs: AssistantTab[] = [
    ...(showQa ? ["qa" as const] : []),
    ...(showWizard ? ["wizard" as const] : []),
    ...(showDiagnose ? ["diagnose" as const] : []),
  ];
  const requested = params.get("tab") as AssistantTab | null;
  const tab = requested && tabs.includes(requested) ? requested : tabs[0] ?? "qa";
  const [builderVisited, setBuilderVisited] = useState(tab !== "qa");

  useEffect(() => {
    if (tab !== "qa") setBuilderVisited(true);
  }, [tab]);

  const setTab = (next: AssistantTab) => {
    const updated = new URLSearchParams(params);
    if (next === "qa") updated.delete("tab");
    else updated.set("tab", next);
    setParams(updated, { replace: true });
  };

  return (
    <div className="assistant-page">
      <PageHeader title={t("assistant.title")} description={t("online.aiNote")}>
        {tabs.length > 1 && (
          <SegmentedControl kind="tabs" idBase="assistant-mode" value={tab} onChange={setTab}
            ariaLabel={t("a11y.assistantMode")} className="seg builder-tabs page-tabs"
            items={tabs.map((id) => ({ id, label: t(`builder.tab.${id}`) }))} />
        )}
      </PageHeader>

      {showQa && (
        <div role="tabpanel" id={segmentedPanelId("assistant-mode", "qa")}
          aria-labelledby={segmentedTabId("assistant-mode", "qa")} hidden={tab !== "qa"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <QaPage embedded />
          </Suspense>
        </div>
      )}

      {builderVisited && (showWizard || showDiagnose) && (
        <div hidden={tab === "qa"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <BuilderPage embedded activeTab={tab === "diagnose" ? "diagnose" : "wizard"}
              onTabChange={setTab} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
