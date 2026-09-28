import type { FormatId } from "@pokemon-champions/protocol";
import { lazy, Suspense, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { FormatTabs } from "../components/FormatTabs.tsx";
import { GameImage } from "../components/GameImage.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId } from "../components/SegmentedControl.tsx";
import { MetaRail, useMetaRails } from "../components/MetaRails.tsx";
import { RailHandle, useRailEscape } from "../components/SideRail.tsx";
import { useRanking } from "../hooks.ts";
import { displayName, useLang, useT } from "../i18n.ts";
import { TypeBadge } from "../components/TypeBadge.tsx";

// Usage tiers matching the report / trend-chart bands (S 1-10, A 11-30, B 31-60, C 61-100, D 101+)
// so the rank badge is graduated by tier instead of only flagging the top 10.
function rankTier(rank: number): "S" | "A" | "B" | "C" | "D" {
  if (rank <= 10) return "S";
  if (rank <= 30) return "A";
  if (rank <= 60) return "B";
  if (rank <= 100) return "C";
  return "D";
}

// The trend view (its data and its chart) loads only when the reader switches to it.
const TrendView = lazy(() => import("../components/TrendView.tsx").then((m) => ({ default: m.TrendView })));

type RankingView = "list" | "trend";

/** Grid cards (same density as the dex browser): rank badge + sprite + trilingual name +
 * type icons — a full top-50 fits on one screen. The same page's other view is the rank trend
 * over time; which one is on screen is in the URL (`?view=trend`; the old `?trend=1` still
 * opens it). */
export function RankingPage() {
  const [params, setParams] = useSearchParams();
  const format = (params.get("format") === "double" ? "double" : "single") as FormatId;
  const view: RankingView = params.get("view") === "trend" || params.get("trend") === "1" ? "trend" : "list";
  const setFormat = (next: FormatId) => {
    const updated = new URLSearchParams(params);
    updated.set("format", next);
    setParams(updated, { replace: true });
  };
  const setView = (next: RankingView) => {
    const updated = new URLSearchParams(params);
    updated.delete("trend");
    if (next === "trend") updated.set("view", "trend");
    else updated.delete("view");
    setParams(updated, { replace: true });
  };
  const ranking = useRanking(format);
  const rails = useMetaRails();
  useRailEscape(rails);
  // The rail's filter scopes the RAIL'S LIST, deliberately not this page's cards: the grid is the
  // ranking itself, and silently dropping rows out of a ranking would misrepresent it.
  const ignoreAllowed = useCallback(() => {}, []);
  const { lang } = useLang();
  const t = useT();

  return (
    <>
      <RailHandle state={rails} label={t("rail.search")} />
      <MetaRail state={rails} format={format} ranking={ranking} onAllowed={ignoreAllowed} />
      <PageHeader title={t(view === "trend" ? "trend.title" : "ranking.title")}>
        <SegmentedControl kind="tabs" idBase="ranking-view" value={view} onChange={setView}
          ariaLabel={t("ranking.views")} className="seg page-tabs"
          items={[{ id: "list", label: t("ranking.view.list") }, { id: "trend", label: t("nav.trend") }]} />
        <FormatTabs format={format} onChange={setFormat} className="page-tabs" />
      </PageHeader>
      <div role="tabpanel" id={segmentedPanelId("ranking-view", view)}
           aria-labelledby={segmentedTabId("ranking-view", view)}>
      {view === "trend" && (
        <Suspense fallback={<div className="spinner">{t("state.loading")}</div>}>
          <TrendView format={format} />
        </Suspense>
      )}
      {view === "list" && ranking.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
      {view === "list" && ranking.status === "error" && (
        <div className="notice">{t("state.errorDetail")}</div>
      )}
      {view === "list" && ranking.status === "ready" && (
        <div className="dex-grid dense">
          {ranking.data.rows.map((row) => {
            const assetKey = row.key ?? `pokemon:${row.slug}`;
            return (
            <Link key={row.slug} to={`/meta/${row.slug}?format=${format}`}
              className="panel dex-card ranked">
              <span className={`rank-badge num tier-${rankTier(row.rank)}`}>{row.rank}</span>
              <GameImage assetKey={assetKey} role="card"
                alt={displayName(row, lang)} className="sprite" />
              <span className="nm">{displayName(row, lang)}</span>
              <span className="types">
                {(row.types ?? []).map((tp) => (
                  <TypeBadge key={tp} type={tp} iconOnly />
                ))}
              </span>
            </Link>
            );
          })}
        </div>
      )}
      </div>
    </>
  );
}
