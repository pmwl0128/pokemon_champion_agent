/** The panel's atom for "a Pokemon": portrait + localized name. When the artifact carries a
 * FULL SET (draft teams), hovering shows exactly that — item, ability, nature, moves, SP,
 * all localized. A bare name gets no hover at all: dex trivia isn't what the user is
 * deciding on here, and an empty popover reads as a bug. */
import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { createPortal } from "react-dom";
import { GameImage } from "../../components/GameImage.tsx";
import { TypeBadge } from "../../components/TypeBadge.tsx";
import { useAsync } from "../../hooks.ts";
import { displayName, optionalKey, useT, type Lang } from "../../i18n.ts";
import { localName, useNameMaps } from "../../lib/names.ts";
import type { TeamMemberish } from "../../lib/team.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { loadLearnset } from "../../runtime/projection.ts";

export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function HoverSet({ anchorRef, slug, label, mon, lang }: {
  anchorRef: RefObject<HTMLSpanElement | null>;
  slug: string; label: string; mon: TeamMemberish; lang: Lang;
}) {
  const t = useT();
  const names = useNameMaps();
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const moves = useAsync(
    () => (mon.moves?.length ? loadLearnset(slug).catch(() => null) : Promise.resolve(null)),
    [slug]);
  const moveMap = new Map(
    moves.status === "ready" && moves.data ? moves.data.moves.map((m) => [m.name, m]) : []);
  // Portal to <body> + fixed coords so no ancestor's overflow/stacking context can crop or occlude
  // the card (same fix EntityHover uses). Re-place when the async set changes the card height.
  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = popRef.current?.getBoundingClientRect();
      if (!a || !p) return;
      const edge = 12, gap = 6;
      const left = Math.min(Math.max(edge, window.innerWidth - p.width - edge), Math.max(edge, a.left));
      const below = a.bottom + gap;
      const above = a.top - p.height - gap;
      const top = below + p.height + edge <= window.innerHeight ? below
        : above >= edge ? above : Math.max(edge, window.innerHeight - p.height - edge);
      setPos({ left, top, visibility: "visible" });
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchorRef, moves.status]);
  return createPortal(
    <div ref={popRef} className="mon-hover mon-hover-portal" role="tooltip" style={pos}>
      <div className="mon-hover-head">
        <GameImage assetKey={`pokemon:${slug}`} role="card" alt={label} className="mon-hover-sprite" />
        <div className="mon-hover-name">{label}</div>
      </div>
      <div className="mon-hover-set">
        <div className="mon-hover-sub">{t("hover.set")}</div>
        {mon.item && (
          <div className="mh-line">
            <GameImage assetKey={`item:${slugify(mon.item)}`} role="dense"
              alt={localName(names.item, mon.item, lang)} className="party-item-img" />
            {localName(names.item, mon.item, lang)}
          </div>
        )}
        {(mon.ability || mon.nature) && (
          <div className="mh-line muted">
            {[mon.ability && localName(names.ability, mon.ability, lang),
              mon.nature && localName(names.nature, mon.nature, lang)].filter(Boolean).join(" · ")}
          </div>
        )}
        {(mon.moves ?? []).map((mv) => {
          const info = moveMap.get(mv);
          return (
            <div key={mv} className="mh-line">
              {info && <TypeBadge type={info.type} iconOnly />}
              {info ? displayName(info, lang) : mv}
            </div>
          );
        })}
        {mon.spread && (
          <div className="mh-line muted num">
            {Object.entries(mon.spread).filter(([, v]) => v > 0)
              .map(([k, v]) => {
                const key = optionalKey(`stat.${k}`);
                return `${key ? t(key) : k.toUpperCase()}${v}`;
              }).join(" / ")}
          </div>
        )}
      </div>
    </div>,
    document.body);
}

export function MonChip({ name, dex, lang, mon }: {
  name: string;
  dex: Map<string, DexIndexEntry>;
  lang: Lang;
  mon?: TeamMemberish;
}) {
  const [hover, setHover] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const entry = dex.get(name);
  const label = entry ? displayName(entry, lang) : name;
  const slug = entry?.slug ?? slugify(name);
  return (
    <span ref={anchorRef} className="uep-species-chip" title={label}
          onMouseEnter={mon ? () => setHover(true) : undefined}
          onMouseLeave={mon ? () => setHover(false) : undefined}>
      <GameImage assetKey={`pokemon:${slug}`} role="dense" alt={label} className="mini" />
      {label}
      {hover && mon && <HoverSet anchorRef={anchorRef} slug={slug} label={label} mon={mon} lang={lang} />}
    </span>
  );
}

export function MonRow({ names, dex, lang, mons }: {
  names: string[];
  dex: Map<string, DexIndexEntry>;
  lang: Lang;
  /** Optional full sets looked up by species name — enables the hover set layer. */
  mons?: Map<string, TeamMemberish>;
}) {
  if (names.length === 0) return null;
  return (
    <span className="uep-species-row">
      {names.map((n, i) => (
        <MonChip key={`${n}-${i}`} name={n} dex={dex} lang={lang} mon={mons?.get(n)} />
      ))}
    </span>
  );
}
