import { useHoverPreview } from "../useHoverPreview.ts";
/** The panel's atom for "a Pokemon": portrait + localized name. When the artifact carries a
 * FULL SET (draft teams), hovering shows exactly that — item, ability, nature, moves, SP,
 * all localized. A bare name gets no hover at all: dex trivia isn't what the user is
 * deciding on here, and an empty popover reads as a bug. */
import {
  useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode,
  type RefObject,
} from "react";
import { STAT_KEYS, type StatKey } from "@pokemon-champions/protocol";
import { createPortal } from "react-dom";
import { typeColor } from "../../assets/icons.ts";
import { GameImage } from "../GameImage.tsx";
import { TypeBadge } from "../TypeBadge.tsx";
import { useAsync, useDexByName, useDexIndex, useItems, useNatures } from "../../hooks.ts";
import { displayName, optionalKey, useLang, useT, type Lang } from "../../i18n.ts";
import { dexLookup, megaFor } from "../../lib/lookup.ts";
import { localName, useNameMaps } from "../../lib/names.ts";
import { actualStat, natureMultiplier } from "../../lib/stats.ts";
import { useProseRenderer, type ProseMonRenderer } from "../../lib/prose.tsx";
import { readTeamMembers, type TeamMemberish } from "../../lib/team.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { loadLearnset, type ItemRef } from "../../runtime/projection.ts";

const NO_DEX: DexIndexEntry[] = [];
const NO_ITEMS: ItemRef[] = [];

export const slugify = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** A member's build as a floating card beside `anchorRef` (portaled, fixed-positioned): under it by
 * default, or to its left (`side="left"`) for anchors inside a panel on the right edge, so the card
 * covers the page rather than the panel.
 *
 * Everything the build says, densely: the form it battles as (a held stone makes the Mega) on its
 * type colours with its types, the item, ability and nature; the four moves with type, category and
 * power; and each stat's Lv.50 value with the SP behind it, the nature's raised and lowered stats
 * marked. */
export function HoverSet({ anchorRef, slug, label, mon, lang, side = "below" }: {
  anchorRef: RefObject<HTMLElement | null>;
  slug: string; label: string; mon: TeamMemberish; lang: Lang;
  side?: "below" | "left";
}) {
  const t = useT();
  const names = useNameMaps();
  const dex = useDexIndex();
  const items = useItems();
  const natures = useNatures();
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });
  const moves = useAsync(
    () => (mon.moves?.length ? loadLearnset(slug).catch(() => null) : Promise.resolve(null)),
    [slug]);
  const moveMap = new Map(
    moves.status === "ready" && moves.data ? moves.data.moves.map((m) => [m.name, m]) : []);
  const dexList = dex.status === "ready" ? dex.data : NO_DEX;
  const itemList = items.status === "ready" ? items.data : NO_ITEMS;
  const literal = dexLookup(dexList).bySlug.get(slug);
  // The form it battles as: a held stone makes the Mega, whose types and stats are the real ones.
  const entry = (mon.item ? megaFor(slug, mon.item, dexList, itemList) : null) ?? literal;
  const nature = natures.status === "ready" ? natures.data.find((n) => n.name === mon.nature) : undefined;
  const multOf = (key: StatKey) => natureMultiplier(nature, key);
  const spread = mon.spread ?? {};
  const spTotal = STAT_KEYS.reduce((sum, key) => sum + (spread[key] ?? 0), 0);
  const slots = Array.from({ length: 4 }, (_, index) => mon.moves?.[index] ?? "");
  const types = entry?.types ?? [];
  const tint = {
    ...pos,
    ["--t1" as string]: types[0] ? typeColor(types[0]) : "var(--brand)",
    ["--t2" as string]: types[1] ? typeColor(types[1]) : types[0] ? typeColor(types[0]) : "var(--brand)",
  } as CSSProperties;

  // Portal to <body> + fixed coords so no ancestor's overflow/stacking context can crop or occlude
  // the card (same fix EntityHover uses). Re-place when the async set changes the card height.
  useLayoutEffect(() => {
    const place = () => {
      const a = anchorRef.current?.getBoundingClientRect();
      const p = popRef.current?.getBoundingClientRect();
      if (!a || !p) return;
      const edge = 12, gap = 6;
      if (side === "left" && a.left - p.width - gap >= edge) {
        const top = Math.min(Math.max(edge, a.top), window.innerHeight - p.height - edge);
        setPos({ left: a.left - p.width - gap, top, visibility: "visible" });
        return;
      }
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
  }, [anchorRef, moves.status, side, entry?.slug]);

  const statName = (key: StatKey) => {
    const found = optionalKey(`stat.${key}`);
    return found ? t(found) : key.toUpperCase();
  };
  return createPortal(
    <div ref={popRef} className="mon-hover mon-hover-portal mh-card" role="tooltip" style={tint}>
      <div className="mh-head">
        <span className="mh-art">
          <GameImage assetKey={entry?.key ?? `pokemon:${slug}`} role="card" alt={label} />
        </span>
        <div className="mh-id">
          <div className="mh-name">
            <b>{entry ? displayName(entry, lang) : label}</b>
            {entry?.isMega && <span className="mega-badge">MEGA</span>}
          </div>
          <div className="mh-types">{types.map((tp) => <TypeBadge key={tp} type={tp} />)}</div>
          {mon.item && (
            <div className="mh-item">
              <GameImage assetKey={`item:${slugify(mon.item)}`} role="dense" alt="" />
              <span>{localName(names.item, mon.item, lang)}</span>
            </div>
          )}
        </div>
      </div>
      <div className="mh-facts">
        <span><i>{t("calc.ability")}</i><b>{mon.ability ? localName(names.ability, mon.ability, lang) : "—"}</b></span>
        <span><i>{t("calc.nature")}</i><b>{mon.nature ? localName(names.nature, mon.nature, lang) : "—"}
          {nature?.upStat && nature.downStat && nature.upStat !== nature.downStat && (
            <small className="mh-nature">
              <em className="up">{statName(nature.upStat)}↑</em><em className="down">{statName(nature.downStat)}↓</em>
            </small>
          )}
        </b></span>
      </div>
      <div className="mh-moves">
        {slots.map((name, index) => {
          const info = name ? moveMap.get(name) : undefined;
          return (
            <span key={index} className={`mh-move${name ? "" : " empty"}`}
                  style={info ? { ["--mv" as string]: typeColor(info.type) } as CSSProperties : undefined}>
              {info ? <TypeBadge type={info.type} iconOnly /> : <i className="mh-move-dot" />}
              <span className="nm">{info ? displayName(info, lang) : name || "—"}</span>
              {info && info.category !== "Status" && info.power != null && <small className="num">{info.power}</small>}
            </span>
          );
        })}
      </div>
      <div className="mh-stats">
        {STAT_KEYS.map((key) => {
          const sp = spread[key] ?? 0;
          const mult = multOf(key);
          const value = entry ? actualStat(entry.stats[key], key, sp, mult) : null;
          return (
            <span key={key} className={`mh-stat${mult > 1 ? " up" : mult < 1 ? " down" : ""}`}>
              <i>{statName(key)}</i>
              <b className="num">{value ?? "—"}</b>
              <small className={`num${sp ? "" : " zero"}`}>{sp}</small>
            </span>
          );
        })}
      </div>
      <div className="mh-foot">
        <span>{t("hover.lv50")}</span>
        <span>SP <b className={`num${spTotal > 66 ? " over" : ""}`}>{spTotal}/66</b></span>
      </div>
    </div>,
    document.body);
}

/** Any label that stands for a team member with a known build — a chip in a report, a name in
 * prose — shows that build on hover or keyboard focus: the same set card the party strip's chips
 * show. A label for a Pokémon that merely shares the species (an opponent) keeps its dex hover. */
export function MemberHover({ mon, children }: { mon: TeamMemberish; children: ReactNode }) {
  const { open, anchorRef, handlers } = useHoverPreview<HTMLSpanElement>();
  const dex = useDexByName();
  const { lang } = useLang();
  const entry = dex.get(mon.species);
  const label = entry ? displayName(entry, lang) : mon.species;
  return (
    // `ehover`: the same box, alignment and underline rules as a dex-hover label, so a member
    // label and an opponent label sit on one line exactly alike.
    <span ref={anchorRef} className="ehover member-hover" tabIndex={0}
          {...handlers}>
      {children}
      {open && <HoverSet anchorRef={anchorRef} slug={entry?.slug ?? slugify(mon.species)}
        label={label} mon={mon} lang={lang} />}
    </span>
  );
}

/** Team members by species, for labels that must find "their" build. A Mega form's label finds
 * the member it evolves from (the same build, evolved). */
export function useMemberSets(team: unknown): (species: string) => TeamMemberish | undefined {
  const dex = useDexByName();
  return useMemo(() => {
    const bySpecies = new Map(readTeamMembers(team).map((member) => [member.species, member]));
    return (species: string) => bySpecies.get(species)
      ?? bySpecies.get(dex.get(species)?.baseSpecies ?? "");
  }, [team, dex]);
}

/** A prose renderer for text written about `team`: a name that stands for one of its members shows
 * that member's build; any other Pokémon keeps its dex hover. */
export function useMemberProse(team: unknown): (text: string) => ReactNode {
  const memberOf = useMemberSets(team);
  const renderMon = useCallback<ProseMonRenderer>((name, label, key) => {
    const mon = memberOf(name);
    return mon ? <MemberHover key={key} mon={mon}>{label}</MemberHover> : null;
  }, [memberOf]);
  return useProseRenderer(renderMon);
}

export function MonChip({ name, dex, lang, mon }: {
  name: string;
  dex: Map<string, DexIndexEntry>;
  lang: Lang;
  mon?: TeamMemberish;
}) {
  const { open: hover, anchorRef, handlers } = useHoverPreview<HTMLSpanElement>();
  const entry = dex.get(name);
  const label = entry ? displayName(entry, lang) : name;
  const slug = entry?.slug ?? slugify(name);
  return (
    <span ref={anchorRef} className="uep-species-chip" title={label}
          {...(mon ? handlers : {})}>
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
