/** The meta page's edge rail — search + the ranking list — with the filter as a flyout beside it.
 *
 * The filter and the list it filters have to be on screen AT THE SAME TIME. Two earlier shapes both
 * failed that: facets on the opposite page edge meant picking on the right and reading the result on
 * the left, and a drill-down inside the 320px rail meant clicking back out to see what a pick did.
 * So the filter is a separate panel hinged to the rail's right edge: it may overlap the article, it
 * stays open until its own close button is pressed, and every checkbox updates the list two hundred
 * pixels to its left immediately.
 *
 * Closing is deliberately two-level and never automatic: the flyout's × closes only the flyout, the
 * rail's × closes the rail (and the flyout with it, since it is anchored to the rail). Esc closes
 * the innermost thing that is open. Clicking a result navigates and changes NOTHING about either
 * panel — browsing the ranking is a continuous act.
 *
 * The rail opens OUTWARD into the page gutter. `main.content` is `width: min(1240px, 100% - 48px)`
 * centred in the shell, so padding the shell by the rail's width spends the gutter first: on a wide
 * screen the article does not move a pixel when the rail opens, and the column only narrows once
 * the gutter runs out. Below OVERLAY_FLOOR of usable column the rail covers instead, because at
 * that point there is no gutter left to borrow.
 */
import type { FormatId, MetaFacetsDto, RankingDto } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GameImage } from "./GameImage.tsx";
import { RailLayer, useRailEscape, useSideRail, type RailState } from "./SideRail.tsx";
import {
  useAbilitiesByName, useDexByName, useItemsByName, useMetaFacets, useMovesByName,
  useNatures, type Async,
} from "../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../i18n.ts";

/** The metagame rail is a list of names; 320px is the width that reads well for one. */
export const useMetaRails = () => useSideRail(320);

type FacetKey = "items" | "moves" | "abilities" | "natures" | "partners" | "koTargets" | "koedBy";

/** Reading order: what it carries, then how it is built, then who it plays with, then who it fights. */
const FACETS: Array<[FacetKey, MsgKey]> = [
  ["items", "rail.facetItems"],
  ["moves", "rail.facetMoves"],
  ["abilities", "rail.facetAbilities"],
  ["natures", "rail.facetNatures"],
  ["partners", "rail.facetPartners"],
  ["koTargets", "rail.facetKoTargets"],
  ["koedBy", "rail.facetKoedBy"],
];

export function FunnelIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M1.5 2.5h13l-5 5.6v4.6l-3 1.8V8.1z" fill="none" stroke="currentColor"
            strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** English canonical -> localized label, through the same projection vocabularies the hover cards
 * use. The facet VALUE stays the canonical (design §2.1: the join key never changes with the
 * language, only the label does). */
function useFacetLabel(enabledFacets: ReadonlySet<FacetKey>) {
  const { lang } = useLang();
  const needs = (...facets: FacetKey[]) => facets.some((facet) => enabledFacets.has(facet));
  const dex = useDexByName(needs("partners", "koTargets", "koedBy"));
  const items = useItemsByName(needs("items"));
  const moves = useMovesByName(needs("moves"));
  const abilities = useAbilitiesByName(needs("abilities"));
  const natures = useNatures(needs("natures"));
  return (facet: FacetKey, name: string): string => {
    const hit = facet === "items" ? items.get(name)
      : facet === "moves" ? moves.get(name)
      : facet === "abilities" ? abilities.get(name)
      : facet === "natures"
        ? (natures.status === "ready" ? natures.data.find((n) => n.name === name) : undefined)
        : dex.get(name);
    return hit ? displayName(hit, lang) : name;
  };
}

type Picks = Partial<Record<FacetKey, Set<string>>>;

/** The filter panel: facet column on the left, that facet's values on the right. Both columns are
 * always visible, so switching facets never hides what is already picked, and the whole panel sits
 * beside the result list rather than on top of it. */
function FilterFlyout({ facets, picks, matching, onToggle, onClear, onClose }: {
  facets: MetaFacetsDto["facets"] | null;
  picks: Picks;
  matching: number;
  onToggle: (f: FacetKey, v: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [facet, setFacet] = useState<FacetKey>("items");
  // Load only the active vocabulary. Opening the item facet must not also parse every move,
  // ability, nature and Pokemon card; those arrive if and when their tabs are selected.
  const facetLabel = useFacetLabel(new Set([facet]));
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setQ(""); searchRef.current?.focus(); }, [facet]);

  const values = facets?.[facet] ?? {};
  const needle = q.trim().toLowerCase();
  // Most-carried first: a facet's long tail is mostly one-off values, so alphabetical order would
  // bury the handful anyone actually reaches for.
  const names = useMemo(
    () => Object.keys(values).sort((a, b) =>
      (values[b]?.length ?? 0) - (values[a]?.length ?? 0) || a.localeCompare(b)),
    [values]);
  const shown = names.filter((n) => !needle
    || n.toLowerCase().includes(needle) || facetLabel(facet, n).toLowerCase().includes(needle));
  const picked = picks[facet] ?? new Set<string>();
  const activeCount = FACETS.reduce((n, [key]) => n + (picks[key]?.size ?? 0), 0);

  return (
    <aside className="filter-flyout" aria-label={t("rail.filter")}>
      <div className="flyout-head">
        <h3>{t("rail.filter")}</h3>
        <span className="count num">{t("rail.matching").replace("{n}", String(matching))}</span>
        {activeCount > 0 && (
          <button type="button" className="rail-clear" onClick={onClear}>{t("rail.clear")}</button>
        )}
        <button type="button" onClick={onClose} aria-label={t("rail.closeFilter")}>×</button>
      </div>
      <div className="flyout-body">
        <div className="flyout-facets" role="tablist" aria-orientation="vertical">
          {FACETS.map(([key, label]) => {
            const n = picks[key]?.size ?? 0;
            return (
              <button type="button" key={key} role="tab" aria-selected={facet === key}
                      className={`facet-tab${facet === key ? " on" : ""}`}
                      onClick={() => setFacet(key)}>
                <span className="lbl">{t(label)}</span>
                {n > 0 && <span className="badge num">{n}</span>}
              </button>
            );
          })}
        </div>
        <div className="flyout-values">
          <div className="flyout-search">
            <input ref={searchRef} type="search" value={q} aria-label={t("rail.facetSearch")}
                   placeholder={t("rail.facetSearch")} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="value-list">
            {facets === null && <p className="rail-empty">{t("rail.loading")}</p>}
            {facets !== null && shown.length === 0 && (
              <p className="rail-empty">{t("rail.noMatch")}</p>
            )}
            {shown.slice(0, 400).map((v) => (
              <button type="button" key={v} className={`value-row${picked.has(v) ? " on" : ""}`}
                      aria-pressed={picked.has(v)} onClick={() => onToggle(facet, v)}>
                <span className="box" aria-hidden="true">{picked.has(v) ? "✓" : ""}</span>
                <span className="nm">{facetLabel(facet, v)}</span>
                <span className="c num">{values[v]?.length ?? 0}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  );
}

function ActiveChips({ picks, label, onToggle, onClear }: {
  picks: Picks;
  label: (f: FacetKey, v: string) => string;
  onToggle: (f: FacetKey, v: string) => void;
  onClear: () => void;
}) {
  const t = useT();
  const entries = FACETS.flatMap(([key]) => [...(picks[key] ?? [])].map((v) => [key, v] as const));
  if (entries.length === 0) return null;
  return (
    <div className="rail-chips">
      {entries.map(([facet, value]) => (
        <button type="button" className="chip on" key={`${facet}:${value}`}
                onClick={() => onToggle(facet, value)}>
          {label(facet, value)}<span className="x" aria-hidden="true">×</span>
        </button>
      ))}
      <button type="button" className="rail-clear" onClick={onClear}>{t("rail.clear")}</button>
    </div>
  );
}

/** Search + ranking list in the rail, filter in the flyout beside it. */
export function MetaRail({ state, format, ranking, activeSlug = "", onAllowed }: {
  state: RailState;
  format: FormatId;
  ranking: Async<RankingDto>;
  /** Highlighted row, when the page is about one Pokemon. The ranking page passes none. */
  activeSlug?: string;
  /** The filter scopes THIS LIST only — the page behind the rail keeps showing its own rows.
   * Pages that do not consume the result pass a no-op. */
  onAllowed: (slugs: Set<string> | null) => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [picks, setPicks] = useState<Picks>({});
  const [filterOpen, setFilterOpen] = useState(false);
  // A closed rail has no labels to paint. After the flyout closes, load only vocabularies for the
  // active chips that remain visible in the open rail.
  const labelFacets = new Set<FacetKey>();
  if (state.open) for (const facet of Object.keys(picks) as FacetKey[]) labelFacets.add(facet);
  const facetLabel = useFacetLabel(labelFacets);
  // The index is fetched once the filter is opened OR a filter is already active — never on page load.
  const facets = useMetaFacets(format, filterOpen || Object.keys(picks).length > 0);

  useEffect(() => { setPicks({}); setFilterOpen(false); }, [format]);

  useRailEscape(state, { open: filterOpen, close: () => setFilterOpen(false) });

  // AND across facets, OR within one: "Fire types that run Choice Scarf" is what a reader means.
  const allowed = useMemo(() => {
    const entries = FACETS
      .map(([key]) => [key, picks[key]] as const)
      .filter((e): e is readonly [FacetKey, Set<string>] => !!e[1] && e[1].size > 0);
    if (entries.length === 0 || facets.status !== "ready" || facets.data === null) return null;
    const tables = facets.data.facets;
    let acc: Set<string> | null = null;
    for (const [facet, values] of entries) {
      const table = tables[facet] ?? {};
      const union = new Set<string>();
      for (const v of values) for (const slug of table[v] ?? []) union.add(slug);
      if (acc === null) {
        acc = union;
      } else {
        const prev: Set<string> = acc;
        acc = new Set<string>([...prev].filter((slug) => union.has(slug)));
      }
    }
    return acc;
  }, [picks, facets]);

  useEffect(() => { onAllowed(allowed); }, [allowed, onAllowed]);

  const rows = ranking.status === "ready" ? ranking.data.rows : [];
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (allowed && !allowed.has(r.slug)) return false;
    if (!needle) return true;
    return [r.name, r.nameZh, r.nameJa, r.slug].some((v) => (v ?? "").toLowerCase().includes(needle));
  });

  const toggle = (facet: FacetKey, value: string) => {
    setPicks((prev) => {
      const next: Picks = { ...prev };
      const set = new Set(next[facet] ?? []);
      if (set.has(value)) set.delete(value); else set.add(value);
      if (set.size === 0) delete next[facet]; else next[facet] = set;
      return next;
    });
  };

  const activeCount = FACETS.reduce((n, [key]) => n + (picks[key]?.size ?? 0), 0);
  const table = facets.status === "ready" && facets.data ? facets.data.facets : null;

  return (
    <RailLayer state={state} label={t("rail.search")} onClose={() => setFilterOpen(false)}
      count={t("rail.total").replace("{n}", String(shown.length))}
      after={filterOpen ? (
        <FilterFlyout facets={table} picks={picks} matching={shown.length} onToggle={toggle}
                      onClear={() => setPicks({})} onClose={() => setFilterOpen(false)} />
      ) : undefined}>
      <div className="rail-search">
        <input type="search" value={q} aria-label={t("rail.searchPlaceholder")}
               placeholder={t("rail.searchPlaceholder")}
               onChange={(e) => setQ(e.target.value)} />
        <button type="button" className={`filter-btn${filterOpen ? " on" : ""}`}
                aria-expanded={filterOpen} aria-label={t("rail.openFilter")}
                title={t("rail.filter")}
                onClick={() => setFilterOpen((v) => !v)}>
          <FunnelIcon />
          {activeCount > 0 && <span className="badge num">{activeCount}</span>}
        </button>
      </div>
      <ActiveChips picks={picks} label={facetLabel} onToggle={toggle}
                   onClear={() => setPicks({})} />
      <div className="rail-body rank-list">
        {shown.length === 0 && <p className="rail-empty">{t("rail.noMatch")}</p>}
        {shown.map((r) => (
          <button type="button" key={r.slug}
                  className={`rank-row${r.slug === activeSlug ? " on" : ""}`}
                  // Navigating changes nothing about either panel: browsing the ranking is a
                  // continuous act, and closing would make comparing two Pokemon a round trip.
                  onClick={() => navigate(`/meta/${r.slug}?format=${format}`)}>
            <span className="n num">{r.rank}</span>
            <GameImage assetKey={r.key ?? `pokemon:${r.slug}`} role="dense"
                       alt={displayName(r, lang)} className="mini" />
            <span className="nm">{displayName(r, lang)}</span>
          </button>
        ))}
      </div>
    </RailLayer>
  );
}
