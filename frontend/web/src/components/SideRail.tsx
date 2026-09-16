/** The page-edge rail shell, shared by the metagame pages and the dex browser.
 *
 * It opens OUTWARD into the page gutter rather than over the article. `main.content` is
 * `width: min(1240px, 100% - 48px)` centred in the shell, so padding the shell by the rail's width
 * spends the gutter first: on a wide screen the article does not move a pixel when the rail opens,
 * and the column only narrows once the gutter runs out. Below OVERLAY_FLOOR of usable column it
 * covers instead, because at that point there is no gutter left to borrow.
 *
 * Closing is never automatic. Only the handle, the rail's own close button, the scrim (in overlay
 * mode) and Esc close it — navigating inside the rail does not, because browsing a list is a
 * continuous act and a rail that shut on every click would cost four clicks to compare two things.
 */
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useT } from "../i18n.ts";

/** Below this much usable column the rail covers instead of pushing. It is a per-use number
 * because what "too narrow" means depends on the content: a card grid reflows all the way down,
 * a multi-column panel layout stops being readable much earlier. */
const DEFAULT_OVERLAY_FLOOR = 900;
const CONTENT_MAX = 1240;
const CONTENT_GUTTER = 48;

export interface RailState {
  open: boolean;
  setOpen: (v: boolean) => void;
  overlay: boolean;
  width: number;
  side: "left" | "right";
}

/** Owns rail state AND the shell padding that keeps the content column out from under the rail.
 * `width` is per use: the dex rail carries a type grid and stat rows and needs more room than the
 * metagame rail's list. */
export function useSideRail(
  width = 320,
  overlayFloor = DEFAULT_OVERLAY_FLOOR,
  side: "left" | "right" = "left",
): RailState {
  const [open, setOpen] = useState(false);
  const [overlay, setOverlay] = useState(false);

  useEffect(() => {
    const shell = document.querySelector<HTMLElement>(".shell");
    if (!shell) return;
    const ownSlot = side === "left" ? "--rail-left" : "--rail-right";
    const otherSlot = side === "left" ? "--rail-right" : "--rail-left";
    const apply = () => {
      const otherWidth = Number.parseFloat(
        getComputedStyle(shell).getPropertyValue(otherSlot),
      ) || 0;
      const usable = Math.min(CONTENT_MAX,
        window.innerWidth - otherWidth - (open ? width : 0) - CONTENT_GUTTER);
      const covering = open && usable < overlayFloor;
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

  return { open, setOpen, overlay, width, side };
}

export function RailHandle({ state, label }: { state: RailState; label: string }) {
  return (
    <button type="button" className={`rail-handle ${state.side}`} aria-expanded={state.open}
            onClick={() => state.setOpen(!state.open)}>
      {label}
    </button>
  );
}

/** The rail itself: scrim (overlay mode only), the panel, its head, and an optional sibling panel
 * hinged to its right edge (`after`) for filters that need their own space. */
export function RailLayer({ state, label, count, onClose, children, after, className,
  headActions, headDescription }: {
  state: RailState;
  label: string;
  /** Short status for the head — a result count, usually. */
  count?: ReactNode;
  headActions?: ReactNode;
  headDescription?: ReactNode;
  /** Runs in addition to closing, for state the rail owns (a nested flyout, say). */
  onClose?: () => void;
  children: ReactNode;
  after?: ReactNode;
  /** Optional surface variant; the trend overlay floats above the page instead of using the gutter. */
  className?: string;
}) {
  const t = useT();
  const close = () => { onClose?.(); state.setOpen(false); };
  if (!state.open) return null;
  return (
    <>
      {state.overlay && <div className="rail-scrim" onClick={close} />}
      <div className={`rail-layer ${state.side}${state.overlay ? " overlay" : ""}${className ? ` ${className}` : ""}`}
           style={{ "--rail-width": `${state.width}px` } as Record<string, string>}>
        <aside className={`rail ${state.side}`} aria-label={label}>
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
    </>
  );
}

/** Esc closes the innermost open thing. `inner` is an optional nested panel that goes first. */
export function useRailEscape(state: RailState, inner?: { open: boolean; close: () => void }) {
  useEffect(() => {
    if (!state.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      if (inner?.open) inner.close(); else state.setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, inner?.open]);
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
