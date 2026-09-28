import { useEscapeLayer } from "./EscapeLayers.tsx";
/** Site search: the search entry in the top bar and the floating search panel under it, shared by the
 * metagame pages, the dex browser and the calculators (frontend/design.md §7.1.1). Also the gutter
 * geometry the library dock uses.
 *
 * The entry is in the top bar on every page, in the same place, so nothing moves between pages. A
 * page that has its own search (the metagame list, the dex, the calculator's build picker)
 * registers it with `RailHandle`; everywhere else the entry opens the environment search. The panel floats
 * under the entry at a fixed height — it never takes the page's full height or pushes the page
 * aside — with its filter panel hinged beside it.
 *
 * The panel stays open while the reader browses in it: picking a row navigates, and the panel is
 * still there for the next one, even across the page change (the open state is remembered per
 * kind for the rest of the visit). It closes on its own × button, the entry, Esc, or a click on
 * the page outside it; not on a reload.
 */
import { IconSearch } from "@tabler/icons-react";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useT } from "../i18n.ts";

const CONTENT_MAX = 1240;
const CONTENT_GUTTER = 48;

export interface RailState {
  open: boolean;
  setOpen: (v: boolean) => void;
  width: number;
}

function usableColumn(width: number, otherWidth: number): number {
  return Math.min(CONTENT_MAX, window.innerWidth - otherWidth - width - CONTENT_GUTTER);
}

/** The shell padding that keeps the content column out from under an open side panel (the library
 * dock), and whether the panel must cover instead. It spends the page gutter first: on a wide
 * screen the article does not move when the panel opens, and below `overlayFloor` of usable column
 * the panel covers instead. */
export function useRailGeometry(open: boolean, width: number, overlayFloor: number,
  side: "left" | "right"): boolean {
  const [overlay, setOverlay] = useState(false);
  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!shell) return;
    const ownSlot = side === "left" ? "--rail-left" : "--rail-right";
    const otherSlot = side === "left" ? "--rail-right" : "--rail-left";
    const apply = () => {
      const otherWidth = Number.parseFloat(getComputedStyle(shell).getPropertyValue(otherSlot)) || 0;
      const covering = open && usableColumn(width, otherWidth) < overlayFloor;
      setOverlay(covering);
      shell.style.setProperty(ownSlot, open && !covering ? `${width}px` : "0px");
    };
    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      shell.style.removeProperty(ownSlot);
    };
  }, [open, width, overlayFloor, side]);
  return overlay;
}

/** Which kinds of search were left open, for this visit only: a row that navigates to another page
 * lands on a page whose search is open too, but a reload starts closed. */
const openThisVisit = new Map<string, boolean>();

/** The kind of search pages without their own fall back to (components/MetaSearch.tsx). */
export const FALLBACK_KIND = "meta";

/** A search panel's state. `width` is per use: the dex search carries a type grid and stat rows and
 * needs more room than the metagame list. `kind` names the search, so pages sharing one (the dex
 * page and a Pokémon's page) share its open state. */
export function useSideRail(width = 320, kind?: string): RailState {
  const [open, setOpenState] = useState(() => (kind ? openThisVisit.get(kind) : false) ?? false);
  const setOpen = (next: boolean) => {
    if (kind) openThisVisit.set(kind, next);
    setOpenState(next);
  };
  return { open, setOpen, width };
}

interface PageRailSlot {
  label: string;
  open: boolean;
  setOpen: (open: boolean) => void;
}

interface SearchContext {
  /** The current page's own search, if it has one. */
  slot: PageRailSlot | null;
  setSlot: (slot: PageRailSlot | null) => void;
  /** The site-wide fallback (the environment search) on pages without their own. */
  fallbackOpen: boolean;
  setFallbackOpen: (open: boolean) => void;
}

const SearchContextValue = createContext<SearchContext>({
  slot: null, setSlot: () => {}, fallbackOpen: false, setFallbackOpen: () => {},
});

export function PageRailProvider({ children }: { children: ReactNode }) {
  const [slot, setSlotState] = useState<PageRailSlot | null>(null);
  const [fallbackOpen, setFallbackState] = useState(false);
  // The fallback is the environment search, so a row that lands on an environment page finds that
  // page's search open too.
  const setFallbackOpen = useCallback((open: boolean) => {
    openThisVisit.set(FALLBACK_KIND, open);
    setFallbackState(open);
  }, []);
  // A page with its own search takes over from the fallback, which then starts closed next time.
  const setSlot = useCallback((next: PageRailSlot | null) => {
    setSlotState(next);
    if (next) setFallbackState(false);
  }, []);
  return (
    <SearchContextValue.Provider value={{ slot, setSlot, fallbackOpen, setFallbackOpen }}>
      {children}
    </SearchContextValue.Provider>
  );
}

export function useSiteSearch(): SearchContext {
  return useContext(SearchContextValue);
}

/** Registers the page's own search with the top bar's entry for as long as the page shows it. */
export function RailHandle({ state, label }: { state: RailState; label: string }) {
  const { setSlot } = useContext(SearchContextValue);
  const { open, setOpen } = state;
  useEffect(() => {
    setSlot({ label, open, setOpen });
    // `setOpen` is rebuilt every render; the slot only needs it refreshed when these change.
  }, [setSlot, label, open]);
  useEffect(() => () => setSlot(null), [setSlot]);
  return null;
}

function editable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return !!element && (element.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName));
}

/** The top bar's search entry: a search icon at the bar's left end, on every page in the same place.
 * It opens the page's search (or the environment search). `/` opens it from anywhere outside a text
 * field. */
export function SearchEntry() {
  const t = useT();
  const { slot, fallbackOpen, setFallbackOpen } = useContext(SearchContextValue);
  const open = slot ? slot.open : fallbackOpen;
  const setOpen = slot ? slot.setOpen : setFallbackOpen;
  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey || editable(event.target)) return;
      event.preventDefault();
      if (latest.current.open) {
        document.querySelector<HTMLInputElement>(".rail input")?.focus();
      } else {
        latest.current.setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const label = `${slot?.label ?? t("rail.search")} (/)`;
  return (
    <button type="button" className={`topbar-tool search-entry${open ? " on" : ""}`} aria-expanded={open}
            aria-keyshortcuts="/" title={label} aria-label={label} onClick={() => setOpen(!open)}>
      <IconSearch aria-hidden />
    </button>
  );
}

/** The search panel: its head, the page's search and results, and an optional filter panel hinged
 * to its right (`after`). */
export function RailLayer({ state, label, count, onClose, children, after, className,
  headActions, headDescription }: {
  state: RailState;
  label: string;
  /** Short status for the head — a result count, usually. */
  count?: ReactNode;
  headActions?: ReactNode;
  headDescription?: ReactNode;
  /** Runs in addition to closing, for state the panel owns (the filter panel, say). */
  onClose?: () => void;
  children: ReactNode;
  after?: ReactNode;
  className?: string;
}) {
  const t = useT();
  const layerRef = useRef<HTMLDivElement>(null);
  const close = () => { onClose?.(); state.setOpen(false); };
  const closeRef = useRef(close);
  closeRef.current = close;

  // Under the search entry, slid left as far as it must to stay on screen — and clear of the
  // library dock when that is docked on the right.
  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!state.open || !layer) return;
    const place = () => {
      const entry = document.querySelector<HTMLElement>(".search-entry")?.getBoundingClientRect();
      const shell = document.querySelector<HTMLElement>(".shell");
      const docked = shell ? Number.parseFloat(getComputedStyle(shell).getPropertyValue("--rail-right")) || 0 : 0;
      const right = window.innerWidth - docked - 8;
      const left = Math.max(8, Math.min(entry?.left ?? 8, right - layer.offsetWidth));
      layer.style.setProperty("--search-left", `${Math.round(left)}px`);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(layer);
    window.addEventListener("resize", place);
    return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [state.open]);

  // Opening puts the cursor in the search box.
  useEffect(() => {
    if (state.open) layerRef.current?.querySelector<HTMLInputElement>(".rail input")?.focus();
  }, [state.open]);

  // A click on the page outside the panel closes it. Dialogs, hover cards and pickers live outside
  // the shell (portals) and the dock is its own panel, so neither counts; the entry toggles itself.
  useEffect(() => {
    if (!state.open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (!target?.closest(".shell") || layerRef.current?.contains(target)) return;
      if (target.closest(".search-entry, .dock")) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [state.open]);

  if (!state.open) return null;
  return (
    <div ref={layerRef} className={`rail-layer${className ? ` ${className}` : ""}`}
         style={{ "--rail-width": `${state.width}px` } as Record<string, string>}>
      <aside className="rail" aria-label={label}>
        <div className="rail-head">
          <h3>{label}</h3>
          {count != null && <span className="count num">{count}</span>}
          {headDescription != null && <p className="rail-head-description">{headDescription}</p>}
          {headActions}
          <button type="button" onClick={close} aria-label={t("rail.close")}>×</button>
        </div>
        {children}
      </aside>
      {after}
    </div>
  );
}

/** Esc closes the innermost open thing. `inner` is an optional nested panel that goes first. */
export function useRailEscape(state: RailState, inner?: { open: boolean; close: () => void }) {
  useEscapeLayer(state.open, () => state.setOpen(false), 20);
  useEscapeLayer(state.open && !!inner?.open, () => inner?.close(), 25);
}

/** A labelled block inside a rail body. */
export function RailSection({ title, aside, children }: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rail-section">
      <h4>{title}{aside != null && <span className="aside">{aside}</span>}</h4>
      {children}
    </section>
  );
}
