/** Online assistance surface: fact Q&A is the default tab, beside the generation wizard and the
 * deterministic team diagnosis. Each tab's chunk is requested the first time it is opened; once
 * visited it stays mounted, so in-flight jobs and hand-offs survive tab switches.
 *
 * "Diagnose this team" from elsewhere (the teams page, a builder result) arrives as a hand-off with
 * the navigation to `?tab=diagnose`. */
import "../styles.assist.css";
import { lazy, Suspense, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader.tsx";
import {
  SegmentedControl, segmentedPanelId, segmentedTabId,
} from "../components/SegmentedControl.tsx";
import { useT } from "../i18n.ts";
import { takeDiagnoseFill } from "../lib/team.ts";
import { useRuntime } from "../runtime/context.tsx";

const QaPage = lazy(() => import("./QaPage.tsx").then((m) => ({ default: m.QaPage })));
const BuilderPage = lazy(() => import("./BuilderPage.tsx")
  .then((m) => ({ default: m.BuilderPage })));
const DiagnoseTab = lazy(() => import("./DiagnoseTab.tsx")
  .then((m) => ({ default: m.DiagnoseTab })));

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
  const tab: AssistantTab = requested && tabs.includes(requested) ? requested : tabs[0] ?? "qa";
  const [visited, setVisited] = useState<ReadonlySet<AssistantTab>>(() => new Set([tab]));
  const [diagnoseFill, setDiagnoseFill] = useState<unknown | null>(null);

  useEffect(() => {
    setVisited((previous) => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab]);

  // "Diagnose this team" from another page or the wizard arrives with the switch to this tab.
  useEffect(() => {
    if (tab !== "diagnose") return;
    const handed = takeDiagnoseFill();
    if (handed !== null) setDiagnoseFill(handed);
  }, [tab]);

  const setTab = (next: AssistantTab) => {
    const updated = new URLSearchParams(params);
    if (next === "qa") updated.delete("tab");
    else updated.set("tab", next);
    setParams(updated, { replace: true });
  };

  return (
    <div className="assistant-page assist-surface">
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

      {visited.has("wizard") && showWizard && (
        <div role="tabpanel" id={segmentedPanelId("assistant-mode", "wizard")}
          aria-labelledby={segmentedTabId("assistant-mode", "wizard")} hidden={tab !== "wizard"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <BuilderPage embedded active={tab === "wizard"} />
          </Suspense>
        </div>
      )}

      {visited.has("diagnose") && showDiagnose && (
        <div role="tabpanel" id={segmentedPanelId("assistant-mode", "diagnose")}
          aria-labelledby={segmentedTabId("assistant-mode", "diagnose")} hidden={tab !== "diagnose"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <DiagnoseTab active={tab === "diagnose"} fill={diagnoseFill}
              onConsumeFill={() => setDiagnoseFill(null)} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
