/** Dex browse: four tabs over the projection's static vocabularies — Pokemon cards,
 * the full move table (battle numbers + trilingual effect texts), the item list
 * (sprite + trilingual effect) and the ability list. Effects localize to the interface
 * language with the English text as the permanent fallback (design §2.1). */
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { GameImage } from "../components/GameImage.tsx";
import { PageHeader } from "../components/PageHeader.tsx";
import { SegmentedControl, segmentedPanelId, segmentedTabId }
  from "../components/SegmentedControl.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { useAbilities, useDexIndex, useItems, useMoves } from "../hooks.ts";
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

function MovesTab({ query }: { query: string }) {
  const t = useT();
  const { lang } = useLang();
  const moves = useMoves();
  const filtered = useMemo(() => {
    if (moves.status !== "ready") return [];
    return moves.data.filter((m) => matches(query, m.name, m.nameZh, m.nameJa));
  }, [moves, query]);
  if (moves.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (moves.status !== "ready") return <div className="notice">{t("state.errorDetail")}</div>;
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

function ItemsTab({ query }: { query: string }) {
  const t = useT();
  const { lang } = useLang();
  const items = useItems();
  const filtered = useMemo(() => {
    if (items.status !== "ready") return [];
    return (items.data as ItemRef[]).filter((i) =>
      matches(query, i.name, i.nameZh, i.nameJa));
  }, [items, query]);
  if (items.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (items.status !== "ready") return <div className="notice">{t("state.errorDetail")}</div>;
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

  const filtered = useMemo(() => {
    if (index.status !== "ready") return [];
    const q = query.trim().toLowerCase();
    if (!q) return index.data;
    return index.data.filter((e) =>
      e.name.toLowerCase().includes(q) ||
      (e.nameZh?.includes(query.trim()) ?? false) ||
      (e.nameJa?.includes(query.trim()) ?? false) ||
      e.slug.includes(q) ||
      String(e.nationalDex) === q);
  }, [index, query, lang]);

  return (
    <>
      <PageHeader title={t("dex.title")}>
        <SegmentedControl kind="tabs" idBase="dex-section" value={tab} onChange={setTab}
          ariaLabel={t("a11y.dexSection")} className="seg dex-tabs page-tabs"
          items={TABS.map((id) => ({ id, label: t(`dex.tab.${id}`) }))} />
      </PageHeader>
      <div role="tabpanel" id={segmentedPanelId("dex-section", tab)}
        aria-labelledby={segmentedTabId("dex-section", tab)}>
        <div className="search-row dex-search-row">
          <input type="search" value={query} placeholder={t("dex.search")}
            onChange={(e) => setQuery(e.target.value)} aria-label={t("dex.search")} />
          {tab === "pokemon" && index.status === "ready" && (
            <span className="muted num">{filtered.length} / {index.data.length}</span>
          )}
        </div>
        {tab === "moves" && <MovesTab query={query} />}
        {tab === "items" && <ItemsTab query={query} />}
        {tab === "abilities" && <AbilitiesTab query={query} />}
        {tab === "pokemon" && (
          <>
            {index.status === "loading" && <div className="spinner">{t("state.loading")}</div>}
            {index.status === "error" && (
              <div className="notice">{t("state.errorDetail")}</div>
            )}
            {index.status === "ready" && (
              filtered.length === 0
                ? <div className="notice">{t("dex.empty")}</div>
                : (
                  <div className="dex-grid">
                    {filtered.map((e) => (
                      <Link key={e.key} to={`/pokemon/${e.slug}`} className="panel dex-card">
                        <GameImage assetKey={e.key} role="card" alt={displayName(e, lang)}
                          className="sprite" />
                        <span className="nm">{displayName(e, lang)}</span>
                        <span className="no num">#{e.nationalDex}</span>
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
