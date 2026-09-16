/** The dex browser's edge rail: search and the matching list, with the filters in a flyout beside
 * it — the same shape the metagame rail uses, so the two browsers are one interaction.
 *
 * The rail's contents follow the active tab, because a filter only means something for the list it
 * filters — a power range is nonsense on the ability list, and leaving it on screen would suggest
 * otherwise. Each tab keeps its own state while the others are open, so switching away and back
 * does not throw away what you set up.
 *
 * On the POKEMON axis the rail carries its own result list and the page's card grid is left alone:
 * that grid IS the dex, and silently dropping rows from it would read as a different dex. Clicking a
 * row opens that Pokemon, which is also what makes this rail worth mounting on the detail page. The
 * other three tabs have no detail page to open, so their list is the page's own table and their
 * filters still scope it.
 *
 * Type picking keeps the meaning it had on the page: Pokemon intersect their picks (two types means
 * the dual type, three therefore match nothing — a true answer about the roster), moves union them.
 */
import type { DexIndexEntry } from "../runtime/adapter.ts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { typeColor } from "../assets/icons.ts";
import { GameImage } from "./GameImage.tsx";
import { FunnelIcon } from "./MetaRails.tsx";
import { RailLayer, RailSection, useRailEscape, type RailState } from "./SideRail.tsx";
import { TypeBadge } from "./TypeBadge.tsx";
import { useAbilities, useMoves } from "../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../i18n.ts";
import type { ItemRef, MoveRef } from "../runtime/projection.ts";

export const TYPE_NAMES = [
  "Normal", "Fire", "Water", "Electric", "Grass", "Ice", "Fighting", "Poison", "Ground",
  "Flying", "Psychic", "Bug", "Rock", "Ghost", "Dragon", "Dark", "Steel", "Fairy",
] as const;

export const MOVE_CATEGORIES = ["Physical", "Special", "Status"] as const;
/** The item vocabulary's own categories, in the order the calc page already orders them by. */
export const ITEM_CATEGORIES = ["battle", "type_boost", "berry", "mega_stone"] as const;
export const STAT_KEYS = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
type StatKey = (typeof STAT_KEYS)[number];

export interface Range { min?: number; max?: number }
const inRange = (v: number | null | undefined, r: Range): boolean => {
  if (r.min == null && r.max == null) return true;
  if (v == null) return false;                 // a filtered field cannot match a move that has none
  return (r.min == null || v >= r.min) && (r.max == null || v <= r.max);
};
export const rangeActive = (r: Range) => r.min != null || r.max != null;

export interface PokemonFilter {
  types: Set<string>;
  ability: string | null;
  moves: string[];
  stats: Partial<Record<StatKey | "bst", Range>>;
}
export interface MoveFilter {
  types: Set<string>;
  categories: Set<string>;
  power: Range;
  accuracy: Range;
  pp: Range;
  priorities: Set<number>;
}
export interface ItemFilter { categories: Set<string> }

export interface DexFilters {
  pokemon: PokemonFilter;
  moves: MoveFilter;
  items: ItemFilter;
}

export const EMPTY_FILTERS: DexFilters = {
  pokemon: { types: new Set(), ability: null, moves: [], stats: {} },
  moves: {
    types: new Set(), categories: new Set(), power: {}, accuracy: {}, pp: {},
    priorities: new Set(),
  },
  items: { categories: new Set() },
};

/* ── predicates, exported so the page filters with the same rules the rail describes ───── */

export function pokemonMatches(e: DexIndexEntry, f: PokemonFilter,
                               learnerSets: Array<Set<string>>): boolean {
  // Types INTERSECT: two picks mean the dual type. Three therefore match nothing, which is a true
  // statement about the roster rather than a bug to reinterpret as OR.
  for (const type of f.types) if (!e.types.includes(type)) return false;
  if (f.ability && !e.abilities.some((a) => a.name === f.ability)) return false;
  for (const set of learnerSets) if (!set.has(e.slug)) return false;
  const bst = STAT_KEYS.reduce((n, k) => n + e.stats[k], 0);
  for (const [key, range] of Object.entries(f.stats)) {
    if (!inRange(key === "bst" ? bst : e.stats[key as StatKey], range)) return false;
  }
  return true;
}

export function moveMatches(m: MoveRef, f: MoveFilter): boolean {
  // Types UNION here: picking Fire + Water on a move table means "show both families".
  if (f.types.size > 0 && !f.types.has(m.type)) return false;
  if (f.categories.size > 0 && !f.categories.has(m.category)) return false;
  if (f.priorities.size > 0 && !f.priorities.has(m.priority ?? 0)) return false;
  return inRange(m.power, f.power) && inRange(m.accuracy, f.accuracy) && inRange(m.pp, f.pp);
}

export function itemMatches(i: ItemRef, f: ItemFilter): boolean {
  return f.categories.size === 0 || f.categories.has((i as { category?: string }).category ?? "");
}

export function activeCount(tab: string, f: DexFilters): number {
  if (tab === "pokemon") {
    const p = f.pokemon;
    return p.types.size + (p.ability ? 1 : 0) + p.moves.length
      + Object.values(p.stats).filter(rangeActive).length;
  }
  if (tab === "moves") {
    const m = f.moves;
    return m.types.size + m.categories.size + m.priorities.size
      + [m.power, m.accuracy, m.pp].filter(rangeActive).length;
  }
  if (tab === "items") return f.items.categories.size;
  return 0;
}

/* ── controls ──────────────────────────────────────────────────────────────────────────── */

/** Every type as an icon+name chip. Clicking again clears it, so the grid carries no extra control
 * and no mode label — how picks combine is a property of the tab, stated in this module's header. */
function TypeGrid({ picked, onToggle }: { picked: Set<string>; onToggle: (t: string) => void }) {
  const t = useT();
  return (
    <div className="type-grid">
      {TYPE_NAMES.map((type) => {
        const on = picked.has(type);
        return (
          <button type="button" key={type} aria-pressed={on}
                  className={`type-pick${on ? " on" : ""}`}
                  style={on ? { background: typeColor(type), borderColor: typeColor(type) } : undefined}
                  onClick={() => onToggle(type)}>
            <TypeBadge type={type} iconOnly />
            <span className="nm">{t(`type.${type}` as never)}</span>
          </button>
        );
      })}
    </div>
  );
}

function ChipToggles<T extends string | number>({ values, picked, label, onToggle }: {
  values: readonly T[];
  picked: Set<T>;
  label: (v: T) => string;
  onToggle: (v: T) => void;
}) {
  return (
    <div className="chip-row">
      {values.map((v) => (
        <button type="button" key={String(v)} aria-pressed={picked.has(v)}
                className={`pill${picked.has(v) ? " on" : ""}`} onClick={() => onToggle(v)}>
          {label(v)}
        </button>
      ))}
    </div>
  );
}

/** Two number boxes. A blank end is "no bound", which is why they are text-typed number inputs and
 * not a slider: a slider cannot express "at least 100, no upper limit" without a special case. */
function RangeRow({ label, value, onChange, placeholder }: {
  label: string;
  value: Range;
  onChange: (r: Range) => void;
  placeholder?: [string, string];
}) {
  const num = (s: string): number | undefined => {
    const v = Number(s);
    return s.trim() === "" || Number.isNaN(v) ? undefined : v;
  };
  return (
    <div className={`range-row${rangeActive(value) ? " on" : ""}`}>
      <span className="lbl">{label}</span>
      <input type="number" inputMode="numeric" value={value.min ?? ""} aria-label={`${label} min`}
             placeholder={placeholder?.[0] ?? ""}
             onChange={(e) => onChange({ ...value, min: num(e.target.value) })} />
      <span className="dash">–</span>
      <input type="number" inputMode="numeric" value={value.max ?? ""} aria-label={`${label} max`}
             placeholder={placeholder?.[1] ?? ""}
             onChange={(e) => onChange({ ...value, max: num(e.target.value) })} />
    </div>
  );
}

/** A searchable checkbox list — the drawer has room for the options themselves, so picking one no
 * longer means typing into a box and hoping the right suggestion appears. */
function PickList({ options, picked, onToggle, placeholder, single, count }: {
  options: Array<{ name: string; nameZh?: string; nameJa?: string }>;
  picked: string[];
  onToggle: (name: string) => void;
  placeholder: string;
  single?: boolean;
  /** Optional trailing figure per option, e.g. how many Pokemon learn a move. */
  count?: (name: string) => number | undefined;
}) {
  const { lang } = useLang();
  const t = useT();
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  const pickedSet = new Set(picked);
  const shown = useMemo(() => {
    const hits = needle
      ? options.filter((o) => [o.name, o.nameZh, o.nameJa]
        .some((n) => (n ?? "").toLowerCase().includes(needle)))
      : options;
    // Picked options stay at the top: what you chose must not scroll out of the list you chose it in.
    return [...hits].sort((a, b) =>
      Number(pickedSet.has(b.name)) - Number(pickedSet.has(a.name))).slice(0, 300);
  }, [options, needle, picked.join("\0")]);
  return (
    <div className="pick-list">
      <input type="search" value={q} placeholder={placeholder} aria-label={placeholder}
             onChange={(e) => setQ(e.target.value)} />
      <div className="pick-options">
        {shown.length === 0 && <p className="rail-empty">{t("rail.noMatch")}</p>}
        {shown.map((o) => {
          const on = pickedSet.has(o.name);
          const n = count?.(o.name);
          return (
            <button type="button" key={o.name} aria-pressed={on}
                    className={`pick-row${on ? " on" : ""}`} onClick={() => onToggle(o.name)}>
              <span className={`box${single ? " radio" : ""}`} aria-hidden="true">{on ? "✓" : ""}</span>
              <span className="nm">{displayName(o, lang)}</span>
              {n != null && <span className="c num">{n}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ── per-tab bodies ────────────────────────────────────────────────────────────────────── */

function PokemonBody({ value, onChange, learners }: {
  value: PokemonFilter;
  onChange: (f: PokemonFilter) => void;
  learners: Record<string, string[]> | null;
}) {
  const t = useT();
  const abilities = useAbilities();
  const moves = useMoves();
  const STATS: Array<[StatKey | "bst", MsgKey]> = [
    ["hp", "stat.hp"], ["atk", "stat.atk"], ["def", "stat.def"],
    ["spa", "stat.spa"], ["spd", "stat.spd"], ["spe", "stat.spe"], ["bst", "dex.bst"],
  ];
  return (
    <>
      <RailSection title={t("rail.facetTypes")}>
        <TypeGrid picked={value.types} onToggle={(type) => {
          const types = new Set(value.types);
          if (types.has(type)) types.delete(type); else types.add(type);
          onChange({ ...value, types });
        }} />
      </RailSection>
      <RailSection title={t("dex.filterAbility")}>
        <PickList single placeholder={t("rail.facetSearch")}
          options={abilities.status === "ready" ? abilities.data : []}
          picked={value.ability ? [value.ability] : []}
          onToggle={(name) => onChange({ ...value, ability: value.ability === name ? null : name })} />
      </RailSection>
      <RailSection title={t("dex.filterMoves")}>
        <PickList placeholder={t("rail.facetSearch")}
          options={moves.status === "ready" ? (moves.data as MoveRef[]) : []}
          picked={value.moves}
          count={(name) => learners?.[name]?.length}
          onToggle={(name) => onChange({
            ...value,
            moves: value.moves.includes(name)
              ? value.moves.filter((m) => m !== name)
              : [...value.moves, name],
          })} />
      </RailSection>
      <RailSection title={t("dex.filterStats")}>
        <div className="range-rows">
          {STATS.map(([key, label]) => (
            <RangeRow key={key} label={t(label)} value={value.stats[key] ?? {}}
              placeholder={key === "bst" ? ["0", "780"] : ["0", "255"]}
              onChange={(r) => {
                const stats = { ...value.stats };
                if (rangeActive(r)) stats[key] = r; else delete stats[key];
                onChange({ ...value, stats });
              }} />
          ))}
        </div>
      </RailSection>
    </>
  );
}

function MovesBody({ value, onChange, priorities }: {
  value: MoveFilter;
  onChange: (f: MoveFilter) => void;
  priorities: number[];
}) {
  const t = useT();
  const toggleIn = <T,>(set: Set<T>, v: T): Set<T> => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    return next;
  };
  return (
    <>
      <RailSection title={t("rail.facetTypes")}>
        <TypeGrid picked={value.types}
          onToggle={(type) => onChange({ ...value, types: toggleIn(value.types, type) })} />
      </RailSection>
      <RailSection title={t("dex.category")}>
        <ChipToggles values={MOVE_CATEGORIES} picked={value.categories}
          label={(c) => t(`category.${c}` as never)}
          onToggle={(c) => onChange({ ...value, categories: toggleIn(value.categories, c) })} />
      </RailSection>
      <RailSection title={t("dex.numbers")}>
        <div className="range-rows">
          <RangeRow label={t("dex.power")} value={value.power} placeholder={["0", "250"]}
            onChange={(power) => onChange({ ...value, power })} />
          <RangeRow label={t("dex.accuracy")} value={value.accuracy} placeholder={["0", "100"]}
            onChange={(accuracy) => onChange({ ...value, accuracy })} />
          <RangeRow label="PP" value={value.pp} placeholder={["0", "20"]}
            onChange={(pp) => onChange({ ...value, pp })} />
        </div>
      </RailSection>
      <RailSection title={t("dex.priority")}>
        <ChipToggles values={priorities} picked={value.priorities}
          label={(p) => (p > 0 ? `+${p}` : String(p))}
          onToggle={(p) => onChange({ ...value, priorities: toggleIn(value.priorities, p) })} />
      </RailSection>
    </>
  );
}

function ItemsBody({ value, onChange }: { value: ItemFilter; onChange: (f: ItemFilter) => void }) {
  const t = useT();
  return (
    <RailSection title={t("dex.category")}>
      <ChipToggles values={ITEM_CATEGORIES} picked={value.categories}
        label={(c) => t(`item.cat.${c}` as never)}
        onToggle={(c) => {
          const categories = new Set(value.categories);
          if (categories.has(c)) categories.delete(c); else categories.add(c);
          onChange({ ...value, categories });
        }} />
    </RailSection>
  );
}

export type DexTab = "pokemon" | "moves" | "items" | "abilities";

/** The active tab's filters, hinged to the rail's right edge so every pick updates the list beside
 * it without hiding it. Abilities have none — search is the whole of what that list supports, and an
 * empty filter block would imply otherwise. */
function DexFilterFlyout({ tab, filters, setFilters, learners, priorities, matching, onClose }: {
  tab: DexTab;
  filters: DexFilters;
  setFilters: (f: DexFilters) => void;
  learners: Record<string, string[]> | null;
  priorities: number[];
  matching: number;
  onClose: () => void;
}) {
  const t = useT();
  const picks = activeCount(tab, filters);
  return (
    <aside className="filter-flyout" aria-label={t("rail.filter")}>
      <div className="flyout-head">
        <h3>{t("rail.filter")}</h3>
        <span className="count num">{t("rail.matching").replace("{n}", String(matching))}</span>
        {picks > 0 && (
          <button type="button" className="rail-clear"
            onClick={() => setFilters(EMPTY_FILTERS)}>{t("rail.clear")}</button>
        )}
        <button type="button" onClick={onClose} aria-label={t("rail.closeFilter")}>×</button>
      </div>
      <div className="flyout-body dex-flyout-body">
        {tab === "pokemon" && (
          <PokemonBody value={filters.pokemon} learners={learners}
            onChange={(pokemon) => setFilters({ ...filters, pokemon })} />
        )}
        {tab === "moves" && (
          <MovesBody value={filters.moves} priorities={priorities}
            onChange={(moves) => setFilters({ ...filters, moves })} />
        )}
        {tab === "items" && (
          <ItemsBody value={filters.items}
            onChange={(items) => setFilters({ ...filters, items })} />
        )}
      </div>
    </aside>
  );
}

/** Search + (on the Pokemon axis) the matching list, with the filters in the flyout beside it. */
export function DexRail({
  state, tab, query, setQuery, filters, setFilters, learners, priorities, rows, activeSlug = "",
  label, count, headActions, status, expandedSlug = "", onPokemonClick, renderPokemonExpansion,
}: {
  state: RailState;
  tab: DexTab;
  query: string;
  setQuery: (q: string) => void;
  filters: DexFilters;
  setFilters: (f: DexFilters) => void;
  learners: Record<string, string[]> | null;
  priorities: number[];
  /** Matching Pokemon for the rail's OWN list, or null on the tabs whose list is the page's table. */
  rows: DexIndexEntry[] | null;
  activeSlug?: string;
  label: string;
  count: number;
  /** Optional controls in the rail header. The calculator uses this for its destination switch. */
  headActions?: ReactNode;
  /** Inline action feedback placed between search and results. */
  status?: ReactNode;
  /** Accordion state for consumers that expand a result instead of navigating away. */
  expandedSlug?: string;
  onPokemonClick?: (entry: DexIndexEntry) => void;
  renderPokemonExpansion?: (entry: DexIndexEntry) => ReactNode;
}) {
  const t = useT();
  const { lang } = useLang();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  useEffect(() => { searchRef.current?.focus(); }, [tab]);
  useRailEscape(state, { open: filterOpen, close: () => setFilterOpen(false) });

  const picks = activeCount(tab, filters);
  const filterable = tab !== "abilities";

  return (
    <RailLayer state={state} label={label} onClose={() => setFilterOpen(false)}
      count={t("rail.total").replace("{n}", String(count))}
      headActions={headActions}
      after={filterOpen && filterable ? (
        <DexFilterFlyout tab={tab} filters={filters} setFilters={setFilters} learners={learners}
          priorities={priorities} matching={count} onClose={() => setFilterOpen(false)} />
      ) : undefined}>
      <div className="rail-search">
        <input ref={searchRef} type="search" value={query} placeholder={t("dex.search")}
          aria-label={t("dex.search")} onChange={(e) => setQuery(e.target.value)} />
        {filterable && (
          <button type="button" className={`filter-btn${filterOpen ? " on" : ""}`}
            aria-expanded={filterOpen} aria-label={t("rail.openFilter")} title={t("rail.filter")}
            onClick={() => setFilterOpen((v) => !v)}>
            <FunnelIcon />
            {picks > 0 && <span className="badge num">{picks}</span>}
          </button>
        )}
      </div>
      {status}
      {rows && (
        <div className="rail-body rank-list">
          {rows.length === 0 && <p className="rail-empty">{t("rail.noMatch")}</p>}
          {rows.map((e) => {
            const expanded = e.slug === expandedSlug;
            return (
              <div className={`rail-result${expanded ? " expanded" : ""}`} key={e.key}>
                <button type="button"
                  className={`rank-row${e.slug === activeSlug || expanded ? " on" : ""}`}
                  aria-expanded={renderPokemonExpansion ? expanded : undefined}
                  // The dex navigates; calculator consumers instead toggle a one-open accordion.
                  onClick={() => onPokemonClick
                    ? onPokemonClick(e) : navigate(`/pokemon/${e.slug}`)}>
                  <span className="n num">{e.nationalDex}</span>
                  <GameImage assetKey={e.key} role="dense" alt={displayName(e, lang)} className="mini" />
                  <span className="nm">{displayName(e, lang)}</span>
                  {renderPokemonExpansion && <span className="rail-row-chevron" aria-hidden="true">⌄</span>}
                </button>
                {expanded && renderPokemonExpansion?.(e)}
              </div>
            );
          })}
        </div>
      )}
    </RailLayer>
  );
}
