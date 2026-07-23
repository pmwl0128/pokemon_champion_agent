/** Entity hover card: wrap any pokemon/move/item/ability chip to get a hover/focus popover
 * with the entity's quick facts (types+stats+abilities / battle numbers+effect /
 * sprite+effect / effect prose, localized to the interface language) and a click-through
 * into the dex (pokemon page or the dex browse tab pre-filtered to the entity). The preview
 * is portalled to the viewport so table and picker scroll containers cannot crop it; data
 * comes from the projection vocabularies already cached for prose. */
import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode,
} from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useAbilitiesByName, useDexByName, useItemsByName, useMovesByName } from "../hooks.ts";
import { displayName, effectText, useLang, useT } from "../i18n.ts";
import { GameImage } from "./GameImage.tsx";
import { CategoryBadge, TypeBadge } from "./TypeBadge.tsx";

export type EntityKind = "pokemon" | "move" | "item" | "ability" | "nature" | "spread";

const STAT_ORDER = ["hp", "atk", "def", "spa", "spd", "spe"] as const;
const STAT_SHORT: Record<(typeof STAT_ORDER)[number], string> = {
  hp: "HP", atk: "A", def: "B", spa: "C", spd: "D", spe: "S",
};

export function EntityHover({
  kind, name, children, link = true, previewAddon, onPreviewOpen,
}: {
  kind: EntityKind;
  /** English canonical (the site-wide join key). */
  name: string;
  children: ReactNode;
  /** false = hover card only, no dex navigation — for chips whose click already means
   * something else (calc move toggles, speed-table row loads). */
  link?: boolean;
  /** Optional detail-page content appended below the entity quick facts. It also enables a
   * preview-only card for kinds such as nature and SP spread. */
  previewAddon?: ReactNode;
  /** Starts lazy data work only when a user actually asks to see the preview. */
  onPreviewOpen?: () => void;
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden" });
  const suppressTouchClick = useRef(false);
  const open = hovered || focused || pinned;
  const navigate = useNavigate();
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName(kind === "pokemon");
  const moves = useMovesByName(kind === "move");
  const items = useItemsByName(kind === "item");
  const abilities = useAbilitiesByName(kind === "ability");

  const mon = kind === "pokemon" ? dex.get(name) : undefined;
  const move = kind === "move" ? moves.get(name) : undefined;
  const item = kind === "item" ? items.get(name) : undefined;
  const ability = kind === "ability" ? abilities.get(name) : undefined;
  const hasPreview = Boolean(mon || move || item || ability || previewAddon);

  useEffect(() => {
    if (!pinned) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!anchorRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setPinned(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [pinned]);

  useLayoutEffect(() => {
    if (!open || !hasPreview) return;
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      const pop = popRef.current?.getBoundingClientRect();
      if (!anchor || !pop) return;
      const edge = 12;
      const gap = 8;
      const maxLeft = Math.max(edge, window.innerWidth - pop.width - edge);
      const left = Math.min(maxLeft, Math.max(edge, anchor.left + anchor.width / 2 - pop.width / 2));
      const above = anchor.top - pop.height - gap;
      const below = anchor.bottom + gap;
      const preferredTop = above >= edge ? above : below;
      const maxTop = Math.max(edge, window.innerHeight - pop.height - edge);
      const top = Math.min(maxTop, Math.max(edge, preferredTop));
      setPosition((current) => current.left === left && current.top === top
        && current.visibility === "visible"
        ? current : { left, top, visibility: "visible" });
    };
    let frame: number | null = null;
    const schedulePlace = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        place();
      });
    };
    place();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedulePlace);
    if (popRef.current) observer?.observe(popRef.current);
    window.addEventListener("resize", schedulePlace);
    window.addEventListener("scroll", schedulePlace, { capture: true, passive: true });
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedulePlace);
      window.removeEventListener("scroll", schedulePlace, true);
      observer?.disconnect();
    };
  }, [open, hasPreview, mon, move, item, ability, previewAddon]);

  if (!hasPreview) return <>{children}</>;   // unknown: plain render

  const go = () => {
    if (mon) navigate(`/pokemon/${mon.slug}`);
    else if (kind === "move" || kind === "item" || kind === "ability") {
      const tab = kind === "move" ? "moves" : kind === "item" ? "items" : "abilities";
      navigate(`/dex?tab=${tab}&q=${encodeURIComponent(name)}`);
    }
  };

  const reveal = () => {
    onPreviewOpen?.();
  };
  const onClick = (event: ReactMouseEvent) => {
    if (suppressTouchClick.current) {
      suppressTouchClick.current = false;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (link) go();
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (link) {
      event.preventDefault();
      go();
    } else if (previewAddon) {
      // Preview-only chip is a disclosure button (see role/tabIndex below): toggle the pinned
      // popover so it responds to the keyboard, not a focusable-but-inert stop.
      event.preventDefault();
      setPinned((current) => !current);
    }
  };

  const preview = (
    <span ref={popRef}
      className={`ehover-pop ehover-pop-portal${previewAddon ? " has-addon" : ""}`}
      style={position} aria-hidden>
      {mon && (
        <>
          <span className="ehover-head">
            <GameImage assetKey={mon.key} role="dense" alt="" className="ehover-img" />
            <b>{displayName(mon, lang)}</b>
            <span className="num muted">#{mon.nationalDex}</span>
            <span className="ehover-types">
              {mon.types.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}
            </span>
          </span>
          <span className="ehover-line muted ehover-abilities">
            {mon.abilities.map((a) => displayName(a, lang)).join(" · ")}
          </span>
          {mon.stats && (
            <span className="ehover-stats num">
              {STAT_ORDER.map((k) => {
                const v = mon.stats[k];
                const w = Math.min(100, Math.round(v / 1.8));
                const hue = Math.min(150, Math.round(v * 0.85));
                return (
                  <span key={k} className="ehover-stat"
                        style={{ background: `linear-gradient(to right, hsl(${hue} 60% 50% / 0.3) ${w}%, transparent ${w}%)` }}>
                    <span className="muted">{STAT_SHORT[k]}</span> {v}
                  </span>
                );
              })}
            </span>
          )}
        </>
      )}
      {move && (
        <>
          <span className="ehover-head">
            <TypeBadge type={move.type} iconOnly />
            <CategoryBadge category={move.category} />
            <b>{displayName(move, lang)}</b>
          </span>
          <span className="ehover-line num muted">
            {t("dex.power")} {move.power ?? "—"} · {t("dex.accuracy")}{" "}
            {move.accuracy != null ? `${move.accuracy}%` : "—"} · PP {move.pp ?? "—"}
            {move.priority ? ` · ${t("dex.priority")} ${move.priority > 0 ? "+" : ""}${move.priority}` : ""}
          </span>
          {effectText(move, lang) && <span className="ehover-line">{effectText(move, lang)}</span>}
        </>
      )}
      {item && (
        <>
          <span className="ehover-head">
            <GameImage assetKey={item.key} role="dense" alt="" className="ehover-img" />
            <b>{displayName(item, lang)}</b>
          </span>
          {effectText(item, lang) && <span className="ehover-line">{effectText(item, lang)}</span>}
        </>
      )}
      {ability && (
        <>
          <span className="ehover-head"><b>{displayName(ability, lang)}</b></span>
          {effectText(ability, lang) && <span className="ehover-line">{effectText(ability, lang)}</span>}
        </>
      )}
      {previewAddon}
    </span>
  );

  return (
    <span ref={anchorRef} className={link ? "ehover" : "ehover no-link"}
          role={link ? "link" : previewAddon ? "button" : undefined}
          aria-expanded={!link && previewAddon ? open : undefined}
          tabIndex={link || previewAddon ? 0 : undefined}
          onClick={onClick} onKeyDown={onKeyDown}
          onMouseEnter={() => { setHovered(true); reveal(); }}
          onMouseLeave={() => setHovered(false)}
          onFocus={() => { setFocused(true); reveal(); }} onBlur={() => setFocused(false)}
          onTouchStart={() => {
            reveal();
            if (!pinned) {
              suppressTouchClick.current = true;
              setPinned(true);
            }
          }}>
      {children}
      {open && createPortal(preview, document.body)}
    </span>
  );
}
