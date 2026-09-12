/** The row/column heads and build switcher shared by every matchup grid — the reference KO/check
 * tables and the actual-configuration table. All three collapse a species to ONE column and let a
 * click swap which of its real builds that column is read as, so the heads live here rather than in
 * one page: three copies of "is this head clickable, where does the badge sit, does the panel close"
 * drifted apart in exactly those details. */
import type { OppVariantRef, SpeciesRowDto } from "@pokemon-champions/protocol";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { GameImage } from "./GameImage.tsx";
import { displayName, useT, type Lang } from "../i18n.ts";
import { useDexByName } from "../hooks.ts";
import { localName, useNameMaps } from "../lib/names.ts";

export const pct = (n: number | null | undefined) => (n == null ? null : `${Math.round(n * 100)}%`);

/** Builds are labelled by POSITION (A/B/C), not by item: an item name is long, changes with the
 * display language, and says nothing about how common the build is. The list is modal-first, so A
 * is always the most-played build. */
export const buildLabel = (i: number) => String.fromCharCode(65 + i);

/** The build a species is currently READ AS. Defaults to its modal build; a legacy grid with no
 * variants falls back to the species slug so the whole picker simply never appears. */
export function activeKey(s: SpeciesRowDto, picks: Record<string, string>): string {
  return picks[s.slug] ?? s.variants?.find((v) => v.isModal)?.key ?? s.slug;
}

/** The active build's index, for its A/B/C label. */
export function activeIndex(s: SpeciesRowDto, picks: Record<string, string>): number {
  const key = activeKey(s, picks);
  return s.variants?.findIndex((v) => v.key === key) ?? -1;
}

export function activeVariant(s: SpeciesRowDto, picks: Record<string, string>): OppVariantRef | undefined {
  const key = activeKey(s, picks);
  return s.variants?.find((v) => v.key === key);
}

/** A LABEL, not a control: it names the active build (or nothing when the species has only one).
 * The head itself is the click target — clicking a Pokemon opens its build list. */
export function HeadVariantBadge({ s, picks }: { s: SpeciesRowDto; picks: Record<string, string> }) {
  if ((s.variants?.length ?? 0) < 2) return null;
  const i = activeIndex(s, picks);
  return (
    <span className={`variant-chip v-${buildLabel(Math.max(0, i)).toLowerCase()}`} aria-hidden>
      {buildLabel(Math.max(0, i))}
    </span>
  );
}

export /** Build switcher. Opens from a row/column head and re-reads that whole row AND column — the grid
 * holds every variant pair already, so switching is a pure re-index, never a fetch. */
function VariantPicker({ s, picks, onPick, onClose, lang, anchorRef, hintKey }: {
  s: SpeciesRowDto; picks: Record<string, string>;
  onPick: (variantKey: string) => void; onClose: () => void; lang: Lang;
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** Overrides the "what switching does" line — the reference grids re-read a row AND a column,
   * the actual-configuration table only re-reads the column (its rows are the user's own team). */
  hintKey?: "matchup.variantPick" | "matchup.variantPickCol";
}) {
  const t = useT();
  const maps = useNameMaps();
  const dex = useDexByName();
  const current = activeKey(s, picks);
  const ref = useRef<HTMLDivElement>(null);
  // The panel is position:fixed (it must escape the grid's overflow clip), so it is placed from the
  // head's measured rect and flipped when it would leave the viewport.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useEffect(() => {
    const place = () => {
      // The panel is portalled, so measure the HEAD it belongs to rather than a DOM parent.
      const anchor = anchorRef?.current?.getBoundingClientRect();
      if (!anchor) return;
      const w = 272, gap = 4;
      const h = ref.current?.offsetHeight ?? 240;
      const left = Math.min(Math.max(8, anchor.left), window.innerWidth - w - 8);
      const below = anchor.bottom + gap;
      const top = below + h > window.innerHeight - 8
        ? Math.max(8, anchor.top - h - gap)          // flip above when it would overflow
        : below;
      setPos({ top, left });
    };
    place();
    const away = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    // A fixed panel cannot follow its anchor, so close rather than let it drift.
    window.addEventListener("resize", onClose);
    document.querySelector(".matchup-scroll")?.addEventListener("scroll", onClose);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", onClose);
      document.querySelector(".matchup-scroll")?.removeEventListener("scroll", onClose);
    };
  }, [onClose]);
  // Rendered through a PORTAL. `position: fixed` is not enough here: the row header is
  // `position: sticky`, which creates a stacking context, so the panel's z-index only competed
  // inside that header — the sticky thead (a higher z-index) painted over it and the panel showed
  // up clipped. At the document root it stacks against the page instead.
  return createPortal(
    <div className="variant-pop" ref={ref} role="dialog" aria-label={t("matchup.variants")}
         style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}>
      <div className="variant-pop-head">
        <GameImage assetKey={`pokemon:${s.slug}`} role="dense" alt="" className="mini" />
        <span className="variant-pop-name">{displayName(s, lang)}</span>
        <span className="variant-pop-hint">{t(hintKey ?? "matchup.variantPick")}</span>
      </div>
      <ul className="variant-list">
        {(s.variants ?? []).map((v, i) => {
          const on = v.key === current;
          const share = pct(v.coverage);
          return (
            <li key={v.key}>
              <button type="button" className={`variant-opt${on ? " on" : ""}`}
                      aria-pressed={on} onClick={() => { onPick(v.key); onClose(); }}>
                <span className="variant-bar" aria-hidden
                      style={{ "--w": share ?? "0%" } as React.CSSProperties} />
                <span className={`variant-tag v-${buildLabel(i).toLowerCase()}`}>{buildLabel(i)}</span>
                <span className="variant-main">
                  <span className="variant-item">
                    {v.item ? localName(maps.item, v.item, lang) : "—"}
                    {v.runForm && <span className="mega-badge"
                      title={dex.get(v.runForm) ? displayName(dex.get(v.runForm)!, lang) : v.runForm}>
                      MEGA
                    </span>}
                  </span>
                  <span className="variant-ability">
                    {v.ability ? localName(maps.ability, v.ability, lang) : "—"}
                    {v.baseAbility && v.baseAbility !== v.ability && (
                      <span className="variant-base-ability"
                            title={t("matchup.variantBaseAbility").replace("{n}", localName(maps.ability, v.baseAbility, lang))}>
                        ← {localName(maps.ability, v.baseAbility, lang)}
                      </span>
                    )}
                    {v.runForm && (
                      <span className="variant-mega" title={t("matchup.variantMegaTip")}>
                        {t("matchup.variantMega")}
                      </span>
                    )}
                  </span>
                </span>
                <span className="variant-share num"
                      title={share ? t("matchup.variantShare").replace("{n}", share) : undefined}>
                  {share ?? "—"}
                  {v.isModal && <em className="variant-modal">{t("matchup.variantModal")}</em>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>,
    document.body,
  );
}

/** `picks`/`open`/... are optional for read-only callers. Both KO and CHECK grids retain the same
 * observed-build axes, so interactive callers can switch either side without recalculation. */
export function ColHead({ s, lang, picks = {}, open = false, onToggle, onPick, onClose }: {
  s: SpeciesRowDto | undefined; lang: Lang; picks?: Record<string, string>;
  open?: boolean; onToggle?: () => void; onPick?: (k: string) => void; onClose?: () => void;
}) {
  if (!s) return <th className="col-head" />;
  const v = activeVariant(s, picks);
  const multi = (s.variants?.length ?? 0) > 1 && !!onToggle;
  const headRef = useRef<HTMLTableCellElement>(null);
  const maps = useNameMaps();
  // No usage rank under the sprite: with a build badge alongside it, two small numbers in one
  // narrow head read as a confusing pair. Rank stays in the tooltip and on the row head.
  const inner = (
    <span className="col-head-inner">
      <GameImage assetKey={`pokemon:${s.slug}`} role="dense" alt={displayName(s, lang)} className="mini" />
    </span>
  );
  return (
    <th ref={headRef} className={`col-head${v && !v.isModal ? " variant-active" : ""}${open ? " picking" : ""}`}
        title={`#${s.rank ?? "—"} ${displayName(s, lang)}${v?.item ? ` · ${localName(maps.item, v.item, lang)}` : ""}`}>
      {multi ? (
        <button type="button" className="head-pick" aria-expanded={open} onClick={onToggle}>
          {inner}
          <HeadVariantBadge s={s} picks={picks} />
        </button>
      ) : inner}
      {open && onPick && onClose && (
        <VariantPicker s={s} picks={picks} onPick={onPick} onClose={onClose} lang={lang}
                       anchorRef={headRef} />
      )}
    </th>
  );
}

/** `build` labels a CHECK-grid row: those rows are per-build already and have no switcher. */
export function RowHead({ s, lang, picks = {}, open = false, onToggle, onPick, onClose, build, isModal }: {
  s: SpeciesRowDto; lang: Lang; picks?: Record<string, string>;
  open?: boolean; onToggle?: () => void; onPick?: (k: string) => void; onClose?: () => void;
  build?: string; isModal?: boolean;
}) {
  const v = activeVariant(s, picks);
  const multi = (s.variants?.length ?? 0) > 1 && !!onToggle;
  const headRef = useRef<HTMLTableCellElement>(null);
  const maps = useNameMaps();
  // No usage-rank digit here either: it sat right beside the A/B/C build badge and the two small
  // numbers read as one confusing pair. Rank stays in the row's tooltip.
  const inner = (
    <span className="row-head-inner">
      <GameImage assetKey={`pokemon:${s.slug}`} role="dense" alt={displayName(s, lang)} className="mini" />
      <span className="nm">{displayName(s, lang)}</span>
      {build && !isModal && <span className="row-build">{build}</span>}
    </span>
  );
  return (
    <th ref={headRef} className={`row-head${v && !v.isModal ? " variant-active" : ""}${open ? " picking" : ""}`}
        title={`#${s.rank ?? "—"} ${displayName(s, lang)}${build ? ` · ${build}` : v?.item ? ` · ${localName(maps.item, v.item, lang)}` : ""}`}>
      {multi ? (
        <button type="button" className="head-pick" aria-expanded={open} onClick={onToggle}>
          {inner}
          <HeadVariantBadge s={s} picks={picks} />
        </button>
      ) : inner}
      {open && onPick && onClose && (
        <VariantPicker s={s} picks={picks} onPick={onPick} onClose={onClose} lang={lang}
                       anchorRef={headRef} />
      )}
    </th>
  );
}
