/** Calc page shell: one place to pick a mon set, three tools over the same live engine —
 * 伤害矩阵 (damage matrix), 速度线 (speed line), 耐久调整 (bulk tune). The shell owns the
 * capability gate and the shared vocab load (dex / natures / items); each tool is a tab that keeps
 * its own state once visited (hidden, not unmounted, when you switch away). */
import { useCallback, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useDexIndex, useItems, useNatures } from "../hooks.ts";
import { useT } from "../i18n.ts";
import { PageHeader } from "../components/PageHeader.tsx";
import { CalcRail, type CalcRailApi } from "../components/CalcRail.tsx";
import { RailHandle, useSideRail } from "../components/SideRail.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId }
  from "../components/SegmentedControl.tsx";
import { useRuntime } from "../runtime/context.tsx";
import { DamageTab } from "./calc/DamageTab.tsx";
import { SpeedTab } from "./calc/SpeedTab.tsx";
import { TuneTab } from "./calc/TuneTab.tsx";

type Tab = "damage" | "speed" | "tune";

export function CalcPage() {
  const { can } = useRuntime();
  const t = useT();
  const dex = useDexIndex();
  const natures = useNatures();
  const items = useItems();
  const rail = useSideRail(380, 760);
  const [railApis, setRailApis] = useState<Partial<Record<Tab, CalcRailApi>>>({});
  const registerRail = useCallback((id: Tab, api: CalcRailApi) => {
    setRailApis((previous) => previous[id] === api ? previous : { ...previous, [id]: api });
  }, []);
  const registerDamage = useCallback((api: CalcRailApi) => registerRail("damage", api), [registerRail]);
  const registerSpeed = useCallback((api: CalcRailApi) => registerRail("speed", api), [registerRail]);
  const registerTune = useCallback((api: CalcRailApi) => registerRail("tune", api), [registerRail]);

  const hasDamage = can("calc.damage");
  const hasSpeed = can("calc.speedline");
  const allTabs: Array<{ id: Tab; label: string; on: boolean }> = [
    { id: "damage", label: t("calc.tab.damage"), on: hasDamage },
    { id: "speed", label: t("calc.tab.speed"), on: hasSpeed },
    { id: "tune", label: t("calc.tab.tune"), on: hasDamage },
  ];
  const tabs = allTabs.filter((x) => x.on);

  // ?tab=… lets other pages deep-link a tool (the UEP result panel hands teams to tune).
  const [params] = useSearchParams();
  const urlTab = params.get("tab");
  const initialTab: Tab = (urlTab === "tune" || urlTab === "speed" || urlTab === "damage")
    && allTabs.find((x) => x.id === urlTab)?.on
    ? urlTab : hasDamage ? "damage" : "speed";
  const teamMode = params.get("mode") === "team";
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
      <PageHeader title={t("calc.title")} description={t("calc.fillDisclaimer")}>
        <SegmentedControl kind="tabs" idBase="calc-tool" value={tab} onChange={show}
          ariaLabel={t("a11y.calcTool")} className="subtabs page-tabs" buttonClassName="subtab"
          items={tabs} />
      </PageHeader>

      {visited.has("damage") && hasDamage && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "damage")}
          aria-labelledby={segmentedTabId("calc-tool", "damage")} hidden={tab !== "damage"}>
          <DamageTab dex={dex.data} natures={natures.data} items={items.data}
            onRailApi={registerDamage} />
        </div>
      )}
      {visited.has("speed") && hasSpeed && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "speed")}
          aria-labelledby={segmentedTabId("calc-tool", "speed")} hidden={tab !== "speed"}>
          <SpeedTab dex={dex.data} natures={natures.data} items={items.data}
            onRailApi={registerSpeed} />
        </div>
      )}
      {visited.has("tune") && hasDamage && (
        <div role="tabpanel" id={segmentedPanelId("calc-tool", "tune")}
          aria-labelledby={segmentedTabId("calc-tool", "tune")} hidden={tab !== "tune"}>
          <TuneTab dex={dex.data} natures={natures.data} items={items.data}
                   initialTeamMode={teamMode} onRailApi={registerTune} />
        </div>
      )}
    </>
  );
}
