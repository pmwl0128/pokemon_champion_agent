/** Dex browse: four tabs over the projection's static vocabularies — Pokemon cards,
 * the full move table (battle numbers + trilingual effect texts), the item list
 * (sprite + trilingual effect) and the ability list. Effects localize to the interface
 * language with the English text as the permanent fallback (design §2.1).
 *
 * Search and filters live in the page-edge rail, and the rail's contents follow the active tab — a
 * power range means nothing on the ability list, so it is not on screen there. Each tab keeps its
 * own query and its own filters, so switching away and back does not discard what you set up. */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { GameImage } from "../components/GameImage.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId }
  from "../components/SegmentedControl.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { RailHandle, useSideRail } from "../components/SideRail.tsx";
import {
  DexRail, EMPTY_FILTERS, itemMatches, moveMatches, pokemonMatches,
  type DexFilters,
} from "../components/DexRail.tsx";
import { useAbilities, useDexIndex, useItems, useLearners, useMoves } from "../hooks.ts";
import { displayName, effectText, optionalKey, useLang, useT } from "../i18n.ts";
import type { ItemRef, MoveRef } from "../runtime/projection.ts";
import { ITEM_CATEGORY_ORDER, itemOrder } from "./calc/shared.tsx";

type DexTab = "pokemon" | "moves" | "items" | "abilities";
const TABS: readonly DexTab[] = ["pokemon", "moves", "items", "abilities"];
const asTab = (v: string | null): DexTab =>
  v === "moves" || v === "items" || v === "abilities" ? v : "pokemon";

function matches(query: string, ...names: Array<string | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return names.some((n) => n !== undefined && n.toLowerCase().includes(q));
}

function MovesTab({ rows, state }: { rows: MoveRef[]; state: string }) {
  const t = useT();
  const { lang } = useLang();
  const filtered = rows;
  if (state === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (state !== "ready") return <div className="notice">{t("state.errorDetail")}</div>;
  return (
    <div className="table-scroll">
      <table className="data-table dex-moves-table">
        <thead>
          <tr>
            <th>{t("calc.move")}</th>
            <th />
            <th className="num">{t("dex.power")}</th>
            <th className="num">{t("dex.accuracy")}</th>
            <th className="num">PP</th>
            <th className="num">{t("dex.priority")}</th>
            <th>{t("dex.effect")}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((m) => (
            <tr key={m.name}>
              <td className="dex-move-name">{displayName(m, lang)}</td>
              <td className="dex-move-badges">
                <TypeBadge type={m.type} iconOnly />
                <CategoryBadge category={m.category} />
              </td>
              <td className="num">{m.power ?? "—"}</td>
              <td className="num">{m.accuracy != null ? `${m.accuracy}%` : "—"}</td>
              <td className="num">{m.pp ?? "—"}</td>
              <td className="num">{m.priority
                ? <b className={m.priority > 0 ? "prio-plus" : "prio-minus"}>
                    {m.priority > 0 ? `+${m.priority}` : m.priority}</b>
                : <span className="muted">—</span>}</td>
              <td className="dex-effect">{effectText(m, lang) || <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <div className="notice">{t("dex.empty.moves")}</div>}
    </div>
  );
}

function ItemsTab({ rows, state }: { rows: ItemRef[]; state: string }) {
  const t = useT();
  const { lang } = useLang();
  const filtered = rows;
  if (state === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (state !== "ready") return <div className="notice">{t("state.errorDetail")}</div>;
  // 52poke's taxonomy groups the browse (battle staples first, Mega stones last).
  const groups = new Map<string, ItemRef[]>();
  for (const i of [...filtered].sort(itemOrder)) {
    const cat = i.category && i.category in ITEM_CATEGORY_ORDER ? i.category : "other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(i);
  }
  return (
    <>
      {[...groups.entries()].map(([cat, rows]) => (
        <section key={cat} className="dex-item-group">
          <h2 className="dex-group-title">{t(optionalKey(`item.cat.${cat}`) ?? "dex.tab.items")}</h2>
          <div className="dex-items">
            {rows.map((i) => (
              <div key={i.key} className="panel dex-item-card">
                <GameImage assetKey={i.key} role="dense" alt={displayName(i, lang)}
                           className="dex-item-img" />
                <div>
                  <div className="dex-item-name">{displayName(i, lang)}</div>
                  <div className="dex-effect muted">
                    {effectText(i, lang) || "—"}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {filtered.length === 0 && <div className="notice">{t("dex.empty.items")}</div>}
    </>
  );
}

function AbilitiesTab({ query }: { query: string }) {
  const t = useT();
  const { lang } = useLang();
  const abilities = useAbilities();
  const filtered = useMemo(() => {
    if (abilities.status !== "ready") return [];
    return abilities.data.filter((a) => matches(query, a.name, a.nameZh, a.nameJa));
  }, [abilities, query]);
  if (abilities.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (abilities.status !== "ready") return <div className="notice">{t("state.errorDetail")}</div>;
  return (
    <div className="table-scroll">
      <table className="data-table dex-abilities-table">
        <thead>
          <tr>
            <th>{t("dex.ability")}</th>
            <th>{t("dex.effect")}</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((a) => (
            <tr key={a.name}>
              <td className="dex-move-name">{displayName(a, lang)}</td>
              <td className="dex-effect">{effectText(a, lang) || <span className="muted">—</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {filtered.length === 0 && <div className="notice">{t("dex.empty.abilities")}</div>}
    </div>
  );
}

export function DexPage() {
  const index = useDexIndex();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<DexTab>(asTab(params.get("tab")));
  // Each tab keeps ITS OWN filter: switching tabs must not clear what the user typed
  // in another one (user report 2026-07-16).
  const [queries, setQueries] = useState<Record<DexTab, string>>(() => ({
    pokemon: "", moves: "", items: "", abilities: "",
    [asTab(params.get("tab"))]: params.get("q") ?? "",
  }));
  const query = queries[tab];
  const setQuery = (q: string) => setQueries((prev) => ({ ...prev, [tab]: q }));
  const [filters, setFilters] = useState<DexFilters>(EMPTY_FILTERS);
  const moves = useMoves();
  const items = useItems();
  // Wider than the metagame rail (it holds a type grid and stat rows), and it pushes further down
  // before covering: a card grid keeps reflowing where a panel layout would stop being readable.
  const rail = useSideRail(360, 620);
  // The learnset index is one lazy document: fetched when a move filter is in play, and eagerly
  // once the rail is open so its per-move learner counts are there to read.
  const learners = useLearners(filters.pokemon.moves.length > 0 || rail.open);
  const { lang } = useLang();
  const t = useT();

  // Entity hover cards deep-link here with a tab and canonical query. Keep the route useful
  // even when navigation reuses an already-mounted DexPage instance.
  useEffect(() => {
    const nextTab = asTab(params.get("tab"));
    setTab(nextTab);
    const q = params.get("q");
    if (q !== null) setQueries((prev) => ({ ...prev, [nextTab]: q }));
  }, [params]);

  const learnerTable = learners.status === "ready" && learners.data ? learners.data.moves : null;
  const filtered = useMemo(() => {
    if (index.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    // A move filter cannot be answered until its index has arrived. Returning the UNFILTERED list
    // in the meantime would flash a wrong answer, so hold an empty one instead.
    const sets = filters.pokemon.moves.length > 0
      ? (learnerTable ? filters.pokemon.moves.map((m) => new Set(learnerTable[m] ?? [])) : null)
      : [];
    if (sets === null) return [];
    return index.data.filter((e) => pokemonMatches(e, filters.pokemon, sets) && (
      !q || e.name.toLowerCase().includes(q)
        || (e.nameZh?.includes(query.trim()) ?? false)
        || (e.nameJa?.includes(query.trim()) ?? false)
        || e.slug.includes(q)
        || String(e.nationalDex) === q));
  }, [index, query, lang, filters.pokemon, learnerTable]);

  const filteredMoves = useMemo(() => {
    if (moves.status !== "ready") return [];
    return moves.data.filter((m) =>
      moveMatches(m, filters.moves) && matches(query, m.name, m.nameZh, m.nameJa));
  }, [moves, query, filters.moves]);

  const filteredItems = useMemo(() => {
    if (items.status !== "ready") return [];
    return (items.data as ItemRef[]).filter((i) =>
      itemMatches(i, filters.items) && matches(query, i.name, i.nameZh, i.nameJa));
  }, [items, query, filters.items]);

  // The priority values the vocabulary actually uses — a fixed -7..+5 row would offer buckets that
  // match nothing.
  const priorities = useMemo(() => {
    if (moves.status !== "ready") return [];
    return [...new Set(moves.data.map((m) => m.priority ?? 0))].sort((a, b) => b - a);
  }, [moves]);

  const railCount = tab === "pokemon" ? filtered.length
    : tab === "moves" ? filteredMoves.length
      : tab === "items" ? filteredItems.length : 0;

  return (
    <>
      <RailHandle state={rail} label={t("rail.dex")} />
      <DexRail state={rail} tab={tab} query={query} setQuery={setQuery} filters={filters}
        setFilters={setFilters} learners={learnerTable} priorities={priorities}
        label={`${t("rail.dex")} · ${t(`dex.tab.${tab}`)}`} count={railCount}
        rows={tab === "pokemon" ? filtered : null} />
      <PageHeader title={t("dex.title")}>
        <SegmentedControl kind="tabs" idBase="dex-section" value={tab} onChange={setTab}
          ariaLabel={t("a11y.dexSection")} className="seg dex-tabs page-tabs"
          items={TABS.map((id) => ({ id, label: t(`dex.tab.${id}`) }))} />
      </PageHeader>
      <div role="tabpanel" id={segmentedPanelId("dex-section", tab)}
        aria-labelledby={segmentedTabId("dex-section", tab)}>
        {tab === "moves" && <MovesTab rows={filteredMoves} state={moves.status} />}
        {tab === "items" && <ItemsTab rows={filteredItems} state={items.status} />}
        {tab === "abilities" && <AbilitiesTab query={query} />}
        {tab === "pokemon" && (
          <>
            {index.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
            {index.status === "error" && (
              <div className="notice">{t("state.errorDetail")}</div>
            )}
            {index.status === "ready" && (
              index.data.length === 0
                ? <div className="notice">{t("dex.empty")}</div>
                : (
                  // The SAME grid and card the ranking page uses, with the dex number in the
                  // corner where the ranking puts its rank: switching between the two leaves every
                  // card the same size in the same place instead of reflowing under the pointer.
                  //
                  // The rail's search and filters scope the RAIL's list, not this grid: the grid is
                  // the dex itself, and quietly removing rows from it would read as a different dex
                  // rather than as a filtered view (the same rule the ranking page follows).
                  <div className="dex-grid dense">
                    {index.data.map((e) => (
                      <Link key={e.key} to={`/pokemon/${e.slug}`} className="panel dex-card ranked">
                        <span className="rank-badge num dex-no">#{e.nationalDex}</span>
                        <GameImage assetKey={e.key} role="card" alt={displayName(e, lang)}
                          className="sprite" />
                        <span className="nm">{displayName(e, lang)}</span>
                        <span className="types">
                          {e.types.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}
                        </span>
                      </Link>
                    ))}
                  </div>
                )
            )}
          </>
        )}
      </div>
    </>
  );
}
