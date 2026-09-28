/** Calc page shell: one place to pick a mon set, four tools over the same live engine —
 * 伤害矩阵 (damage matrix), 耐久调整 (bulk tune), 配置反推 (set inference), 速度线 (speed line).
 * The shell owns the capability gate, the shared vocab load (dex / natures / items) and the shared
 * roster (both teams and the battle frame, see calc/roster.tsx) that the tools read and edit; each tool
 * is a tab that keeps its own view state once visited (hidden, not unmounted, when you switch away). */
import { lazy, Suspense, useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDexIndex, useItems, useNatures } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { CalcRail, type CalcRailApi } from "../components/CalcRail.tsx";
import { RailHandle, useSideRail } from "../components/SideRail.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId }
  from "../components/SegmentedControl.tsx";
import { useRuntime } from "../runtime/context.tsx";
import { CalcLibraryTransfers } from "./calc/LibraryTransfers.tsx";
import { RosterProvider } from "./calc/roster.tsx";

// Each calculator owns a substantial form and result renderer. Load only the initial tool, then
// preserve the existing "mounted once visited" behaviour so switching back never loses work.
const DamageTab = lazy(() => import("./calc/DamageTab.tsx")
  .then((module) => ({ default: module.DamageTab })));
const SpeedTab = lazy(() => import("./calc/SpeedTab.tsx")
  .then((module) => ({ default: module.SpeedTab })));
const TuneWorkspace = lazy(() => import("./calc/TuneWorkspace.tsx")
  .then((module) => ({ default: module.TuneWorkspace })));
const InferTab = lazy(() => import("./calc/InferTab.tsx")
  .then((module) => ({ default: module.InferTab })));

type Tab = "damage" | "speed" | "tune" | "infer";

export function CalcPage() {
  const { can } = useRuntime();
  const t = useT();
  const dex = useDexIndex();
  const natures = useNatures();
  const items = useItems();
  const rail = useSideRail(380, "calc");
  const [railApis, setRailApis] = useState<Partial<Record<Tab, CalcRailApi>>>({});
  const registerRail = useCallback((id: Tab, api: CalcRailApi) => {
    setRailApis((previous) => previous[id] === api ? previous : { ...previous, [id]: api });
  }, []);
  const registerDamage = useCallback((api: CalcRailApi) => registerRail("damage", api), [registerRail]);
  const registerSpeed = useCallback((api: CalcRailApi) => registerRail("speed", api), [registerRail]);
  const registerTune = useCallback((api: CalcRailApi) => registerRail("tune", api), [registerRail]);
  const registerInfer = useCallback((api: CalcRailApi) => registerRail("infer", api), [registerRail]);

  const hasDamage = can("calc.damage");
  const hasSpeed = can("calc.speedline");
  const allTabs: Array<{ id: Tab; label: string; on: boolean }> = [
    { id: "damage", label: t("calc.tab.damage"), on: hasDamage },
    { id: "tune", label: t("calc.tab.tune"), on: hasDamage },
    { id: "infer", label: t("calc.tab.infer"), on: hasDamage },
    { id: "speed", label: t("calc.tab.speed"), on: hasSpeed },
  ];
  const tabs = allTabs.filter((x) => x.on);

  // ?tab=… lets other pages deep-link a tool (the UEP result panel hands teams to tune).
  const [params] = useSearchParams();
  const urlTab = params.get("tab");
  const initialTab: Tab = (urlTab === "tune" || urlTab === "speed" || urlTab === "damage" || urlTab === "infer")
    && allTabs.find((x) => x.id === urlTab)?.on
    ? urlTab : hasDamage ? "damage" : "speed";
  const [tab, setTab] = useState<Tab>(initialTab);
  // Keep a tab mounted once visited so switching away doesn't wipe a half-built matrix/ladder.
  const [visited, setVisited] = useState<Set<Tab>>(() => new Set<Tab>([initialTab]));
  const show = (id: Tab) => {
    setTab(id);
    setVisited((v) => (v.has(id) ? v : new Set(v).add(id)));
  };

  if (!hasDamage && !hasSpeed) return <div className="notice">{t("calc.unavailable")}</div>;
  const failed = [dex, natures, items].find((s) => s.status === "error");
  if (failed && failed.status === "error") {
    return <div className="notice">{t("state.errorDetail")}</div>;
  }
  if (dex.status !== "ready" || natures.status !== "ready" || items.status !== "ready") {
    return <div className="spinner">{t("state.loading")}</div>;
  }

  return (
    <>
      <RailHandle state={rail} label={t("calc.rail.title")} />
      <CalcRail state={rail} dex={dex.data} tab={tab} api={railApis[tab]} />
      <PageHeader title={t("calc.title")}
        description={t(tab === "infer" ? "calc.inferLead" : "calc.fillDisclaimer")}>
        <SegmentedControl kind="tabs" idBase="calc-tool" value={tab} onChange={show}
          ariaLabel={t("a11y.calcTool")} className="subtabs page-tabs" buttonClassName="subtab"
          items={tabs} />
      </PageHeader>

      <RosterProvider dex={dex.data}>
      <CalcLibraryTransfers dex={dex.data} />
      {visited.has("damage") && hasDamage && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "damage")}
          aria-labelledby={segmentedTabId("calc-tool", "damage")} hidden={tab !== "damage"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <DamageTab dex={dex.data} natures={natures.data} items={items.data}
              onRailApi={registerDamage} />
          </Suspense>
        </div>
      )}
      {visited.has("tune") && hasDamage && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "tune")}
          aria-labelledby={segmentedTabId("calc-tool", "tune")} hidden={tab !== "tune"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <TuneWorkspace dex={dex.data} natures={natures.data} items={items.data}
              onRailApi={registerTune} />
          </Suspense>
        </div>
      )}
      {visited.has("speed") && hasSpeed && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "speed")}
          aria-labelledby={segmentedTabId("calc-tool", "speed")} hidden={tab !== "speed"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <SpeedTab dex={dex.data} natures={natures.data} items={items.data} active={tab === "speed"}
              onRailApi={registerSpeed} />
          </Suspense>
        </div>
      )}
      {visited.has("infer") && hasDamage && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "infer")}
          aria-labelledby={segmentedTabId("calc-tool", "infer")} hidden={tab !== "infer"}>
          <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
            <InferTab visible={tab === "infer"} dex={dex.data} natures={natures.data} items={items.data} onRailApi={registerInfer} />
          </Suspense>
        </div>
      )}
      </RosterProvider>
    </>
  );
}
