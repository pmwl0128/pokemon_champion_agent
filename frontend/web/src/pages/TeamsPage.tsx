/** Teams page: the reader's own team slots and Pokémon boxes, kept in this browser
 * (frontend/design.md §2.3). Team diagnosis lives on the assist page; "diagnose this team" hands the
 * team over there, and an old `?tab=diagnose` link lands there too.
 *
 * The tab is in the URL. A tab mounts on first visit and stays mounted. */
import "../styles.library.css";
import { useCallback, useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader.tsx";
import {
  SegmentedControl, segmentedPanelId, segmentedTabId,
} from "../components/SegmentedControl.tsx";
import { useLibrary, useLibraryLimits } from "../lib/library/hooks.ts";
import { stashDiagnoseFill } from "../lib/team.ts";
import { useRuntime } from "../runtime/context.tsx";
import { BoxShelf } from "../components/library/BoxShelf.tsx";
import { useLibraryT } from "../components/library/messages.ts";
import { StorageNote } from "../components/library/StorageNote.tsx";
import { TeamShelf } from "../components/library/TeamShelf.tsx";
import { TeamsRail } from "../components/library/TeamsRail.tsx";

type TeamsTab = "teams" | "box";
const TABS: TeamsTab[] = ["teams", "box"];
const ID_BASE = "teams-mode";

export function TeamsPage() {
  const { adapter, can } = useRuntime();
  const t = useLibraryT();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const canDiagnose = can("team.validate") && !!adapter.diagnose;
  const requested = params.get("tab");
  const tab: TeamsTab = requested === "box" ? "box" : "teams";
  const [visited, setVisited] = useState<ReadonlySet<TeamsTab>>(() => new Set([tab]));
  const library = useLibrary();
  const limits = useLibraryLimits();
  const state = library && library !== "unavailable" ? library : null;

  useEffect(() => {
    setVisited((previous) => previous.has(tab) ? previous : new Set([...previous, tab]));
  }, [tab]);

  const setTab = useCallback((next: TeamsTab) => {
    setParams((previous) => {
      const updated = new URLSearchParams(previous);
      if (next === "teams") updated.delete("tab");
      else updated.set("tab", next);
      return updated;
    }, { replace: true });
  }, [setParams]);

  const diagnose = useCallback((team: unknown) => {
    stashDiagnoseFill(team);
    navigate("/assist?tab=diagnose");
  }, [navigate]);

  if (requested === "diagnose") return <Navigate to="/assist?tab=diagnose" replace />;

  const panel = (id: TeamsTab) => ({
    role: "tabpanel" as const,
    id: segmentedPanelId(ID_BASE, id),
    "aria-labelledby": segmentedTabId(ID_BASE, id),
    hidden: tab !== id,
  });

  return (
    <div className="lib-page">
      {state && <TeamsRail state={state} />}
      <PageHeader title={t("lib.title")} description={t("lib.lead")}>
        <SegmentedControl kind="tabs" idBase={ID_BASE} value={tab} onChange={setTab}
          ariaLabel={t("lib.sections")} className="seg page-tabs"
          items={TABS.map((id) => ({ id, label: t(`lib.tab.${id}`) }))} />
      </PageHeader>

      {library === "unavailable" && <p className="notice lib-warn">{t("lib.unavailable")}</p>}
      {library === undefined && <p className="lib-loading muted">{t("lib.loading")}</p>}
      {state && visited.has("teams") && (
        <div {...panel("teams")}>
          <TeamShelf state={state} maxSlots={limits.teamSlots} onDiagnose={canDiagnose ? diagnose : undefined} />
        </div>
      )}
      {state && visited.has("box") && (
        <div {...panel("box")}>
          <BoxShelf state={state} maxBoxes={limits.boxes} />
        </div>
      )}
      {library !== "unavailable" && <StorageNote state={state} />}
    </div>
  );
}
