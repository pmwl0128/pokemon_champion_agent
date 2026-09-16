/** The row/column heads and build switcher shared by every matchup grid — the reference KO/check
 * tables and the actual-configuration table. All three collapse a species to ONE column and let a
 * click swap which of its real builds that column is read as, so the heads live here rather than in
 * one page: three copies of "is this head clickable, where does the badge sit, does the panel close"
 * drifted apart in exactly those details. */
import type { OppSetDto, OppVariantRef, SpeciesRowDto } from "@pokemon-champions/protocol";
import { useRef } from "react";
import { GameImage } from "./GameImage.tsx";
import { displayName, useT, type Lang } from "../i18n.ts";
import { BuildPicker, BuildSetSummary, type BuildCardOption } from "./BuildPicker.tsx";
import { EntityHover } from "./EntityHover.tsx";

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

/** Build switcher. Opens from a row/column head and re-reads that whole row AND column — the grid
 * holds every variant pair already, so switching is a pure re-index, never a fetch. */
function VariantPicker({ s, picks, onPick, onClose, anchorRef, hintKey, sets, setsBusy }: {
  s: SpeciesRowDto; picks: Record<string, string>;
  onPick: (variantKey: string) => void; onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  sets?: Record<string, OppSetDto>;
  setsBusy?: boolean;
  /** Overrides the "what switching does" line — the reference grids re-read a row AND a column,
   * the actual-configuration table only re-reads the column (its rows are the user's own team). */
  hintKey?: "matchup.variantPick" | "matchup.variantPickCol";
}) {
  const t = useT();
  const current = activeKey(s, picks);
  const options: BuildCardOption[] = (s.variants ?? []).map((variant) => ({
    key: variant.key,
    source: "aggregate",
    coverage: variant.coverage ?? null,
    isModal: variant.isModal,
    set: sets?.[variant.key] ?? {
      species: s.name,
      runForm: variant.runForm ?? null,
      ability: variant.ability ?? null,
      item: variant.item ?? null,
      nature: null,
      moves: null,
      sps: null,
      baseAbility: variant.baseAbility,
    },
  }));
  if (!anchorRef) return null;
  return <BuildPicker options={options} currentKey={current} anchorRef={anchorRef}
    busy={setsBusy && !sets}
    hint={t(hintKey ?? "matchup.variantPick")}
    onPick={(option) => onPick(option.key)} onClose={onClose} />;
}

function CurrentBuildIcon({ s, picks, sets, showSetHover, children }: {
  s: SpeciesRowDto;
  picks: Record<string, string>;
  sets?: Record<string, OppSetDto>;
  showSetHover?: boolean;
  children: React.ReactNode;
}) {
  const key = activeKey(s, picks);
  const set = sets?.[key];
  if (!showSetHover || !set) return <>{children}</>;
  const option: BuildCardOption = {
    key,
    source: "aggregate",
    coverage: activeVariant(s, picks)?.coverage ?? set.coverage ?? null,
    isModal: activeVariant(s, picks)?.isModal ?? set.isModal ?? false,
    set,
  };
  return (
    <EntityHover kind="spread" name="" link={false} passive
      previewAddon={<BuildSetSummary option={option} index={Math.max(0, activeIndex(s, picks))} />}>
      {children}
    </EntityHover>
  );
}

/** `picks`/`open`/... are optional for read-only callers. Both KO and CHECK grids retain the same
 * observed-build axes, so interactive callers can switch either side without recalculation. */
export function ColHead({
  s, lang, picks = {}, open = false, onToggle, onPick, onClose,
  sets, setsBusy = false, showSetHover = false,
}: {
  s: SpeciesRowDto | undefined; lang: Lang; picks?: Record<string, string>;
  open?: boolean; onToggle?: () => void; onPick?: (k: string) => void; onClose?: () => void;
  sets?: Record<string, OppSetDto>; setsBusy?: boolean; showSetHover?: boolean;
}) {
  if (!s) return <th className="col-head" />;
  const v = activeVariant(s, picks);
  const multi = (s.variants?.length ?? 0) > 1 && !!onToggle;
  const headRef = useRef<HTMLTableCellElement>(null);
  // No usage rank under the sprite: with a build badge alongside it, two small numbers in one
  // narrow head read as a confusing pair. The full configuration lives in the explicit preview.
  const inner = (
    <span className="col-head-inner">
      <CurrentBuildIcon s={s} picks={picks} sets={sets} showSetHover={showSetHover && !open}>
        <GameImage assetKey={`pokemon:${s.slug}`} role="dense" alt={displayName(s, lang)} className="mini" />
      </CurrentBuildIcon>
    </span>
  );
  return (
    <th ref={headRef} className={`col-head${v && !v.isModal ? " variant-active" : ""}${open ? " picking" : ""}`}>
      {multi ? (
        <button type="button" className="head-pick" aria-expanded={open} onClick={onToggle}>
          {inner}
          <HeadVariantBadge s={s} picks={picks} />
        </button>
      ) : inner}
      {open && onPick && onClose && (
        <VariantPicker s={s} picks={picks} onPick={onPick} onClose={onClose}
          sets={sets} setsBusy={setsBusy} anchorRef={headRef} />
      )}
    </th>
  );
}

/** `build` labels a CHECK-grid row: those rows are per-build already and have no switcher. */
export function RowHead({
  s, lang, picks = {}, open = false, onToggle, onPick, onClose, build, isModal,
  sets, setsBusy = false, showSetHover = false,
}: {
  s: SpeciesRowDto; lang: Lang; picks?: Record<string, string>;
  open?: boolean; onToggle?: () => void; onPick?: (k: string) => void; onClose?: () => void;
  build?: string; isModal?: boolean;
  sets?: Record<string, OppSetDto>; setsBusy?: boolean; showSetHover?: boolean;
}) {
  const v = activeVariant(s, picks);
  const multi = (s.variants?.length ?? 0) > 1 && !!onToggle;
  const headRef = useRef<HTMLTableCellElement>(null);
  // No usage-rank digit here either: it sat right beside the A/B/C build badge and the two small
  // numbers read as one confusing pair. The full configuration lives in the explicit preview.
  const inner = (
    <span className="row-head-inner">
      <CurrentBuildIcon s={s} picks={picks} sets={sets} showSetHover={showSetHover && !open}>
        <GameImage assetKey={`pokemon:${s.slug}`} role="dense" alt={displayName(s, lang)} className="mini" />
      </CurrentBuildIcon>
      <span className="nm">{displayName(s, lang)}</span>
      {build && !isModal && <span className="row-build">{build}</span>}
    </span>
  );
  return (
    <th ref={headRef} className={`row-head${v && !v.isModal ? " variant-active" : ""}${open ? " picking" : ""}`}>
      {multi ? (
        <button type="button" className="head-pick" aria-expanded={open} onClick={onToggle}>
          {inner}
          <HeadVariantBadge s={s} picks={picks} />
        </button>
      ) : inner}
      {open && onPick && onClose && (
        <VariantPicker s={s} picks={picks} onPick={onPick} onClose={onClose}
          sets={sets} setsBusy={setsBusy} anchorRef={headRef} />
      )}
    </th>
  );
}
