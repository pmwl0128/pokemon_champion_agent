/** One wing of the duel strip: a side's roster, the conditions standing on that side's field, and
 * the pokepaste import that fills the whole roster at once.
 *
 * The roster is always six slots wide — filled, the next free one, then placeholders — so adding a
 * Pokémon never moves the conditions row, the centre console or the other wing. The side's name is
 * the menu button for the two whole-team actions, which keeps the condition row free for what is
 * actually switched on.
 *
 * Conditions live with the side they belong to rather than in one shared flyout: each chip clears
 * itself, and the wing's own button opens that side's toggles right under the roster it affects. */
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { MonAvatar } from "./MonEditor.tsx";
import { roveFocus, useFocusOnOpen, usePopover } from "./popover.ts";
import { SIDE_FLAGS, type FieldState, type MonState, type SideId } from "./state.ts";

/** Gap between condition chips; mirrors `.team-conds { gap }`. */
const COND_GAP = 5;

/** How many chips of a one-line row fit beside its trailing button, measured rather than guessed:
 * label length varies threefold across languages, and a fixed cap either wastes the row or pushes
 * the "+N" button — the only way to the rest — past the clipped edge.
 *
 * Every chip stays rendered (the overflow ones out of flow and invisible) so each can be measured,
 * and both faces of the button are measured from hidden twins. The answer depends only on those
 * widths, never on the face currently shown, so it cannot oscillate: when everything does not fit
 * beside "+ 状态", at least one chip folds and the narrower "+N" face is the one reserved for. */
function useChipFit(row: { current: HTMLElement | null }, signature: string) {
  const [fit, setFit] = useState(Number.POSITIVE_INFINITY);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = row.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, [row]);
  useLayoutEffect(() => {
    const node = row.current;
    if (!node) return;
    const chips = Array.from(node.querySelectorAll<HTMLElement>("[data-chip]"))
      .map((chip) => chip.offsetWidth);
    const face = (kind: string) => node.querySelector<HTMLElement>(`[data-measure="${kind}"]`)
      ?.offsetWidth ?? 0;
    const room = node.clientWidth;
    const all = chips.reduce((sum, w) => sum + w + COND_GAP, 0);
    let next = chips.length;
    if (all + face("full") > room) {
      const count = face("count");
      next = 0;
      let used = 0;
      for (const w of chips) {
        if (used + w + COND_GAP + count > room) break;
        used += w + COND_GAP;
        next += 1;
      }
      next = Math.max(0, Math.min(next, chips.length - 1));
    }
    setFit(next);
  }, [row, signature, width]);
  return fit;
}

export interface ImportOutcome {
  added: number;
  unresolved: string[];
  rescaledEvs: boolean;
}

export const TEAM_MAX = 6;

export function Caret() {
  return (
    <svg className="duel-caret" viewBox="0 0 10 10" aria-hidden>
      <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function PlusGlyph() {
  return (
    <svg className="duel-plus" viewBox="0 0 12 12" aria-hidden>
      <path d="M6 2v8M2 6h8" fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" />
    </svg>
  );
}

/** The strip's frame: weather art behind the console, terrain colour along the bottom edge. The
 * outer box is the size container the layout tiers query, because the calc rail can take several
 * hundred pixels from the page without the viewport changing at all. */
export function DuelBar({ field, children }: { field: FieldState; children: ReactNode }) {
  const weather = field.weather ? ` weather-${field.weather.toLowerCase()}` : "";
  const terrain = field.terrain ? ` terrain-${field.terrain.toLowerCase()}` : "";
  return (
    <div className="duel-bar">
      <div className={`duel-teams${weather}${terrain}`}>{children}</div>
    </div>
  );
}

export function TeamBar({
  label, teamLabel, team, index, onIndex, onAdd, onRemove, onReset,
  field, setField, side, allowedFlags, flagNote, lockedNote, inlineFlags = false,
  dex, items, onImport, mirrored = false,
}: {
  /** Short side name shown on the strip (我方 / 对方). */
  label: string;
  /** Full name for menus and screen readers (我方队伍). */
  teamLabel: string;
  team: MonState[];
  index: number;
  onIndex: (i: number) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onReset: () => void;
  field: FieldState;
  setField: Dispatch<SetStateAction<FieldState>>;
  /** The FIELD side this roster's conditions are stored on. The damage tab keeps the left roster on
   * side a; the durability workspace defends on the left, which is field side b. */
  side: SideId;
  /** Conditions this tool can actually use; omitted means the calculator's full list. An empty set
   * leaves the side without a toggle and shows `lockedNote` instead. */
  allowedFlags?: ReadonlySet<string>;
  flagNote?: string;
  lockedNote?: string;
  /** Show the offered conditions as toggles right on the strip instead of chips plus a popover —
   * for a tool that offers only one or two (the speed line's Tailwind). */
  inlineFlags?: boolean;
  dex: DexIndexEntry[];
  items: ItemRef[];
  onImport: (text: string) => Promise<ImportOutcome>;
  /** Right-hand wing: the name, the roster and the conditions all pack toward the page edge, so the
   * two sides read as facing each other rather than as one list repeated twice. */
  mirrored?: boolean;
}) {
  const t = useT();
  const menu = usePopover();
  const paste = usePopover(menu.trigger);
  const conds = usePopover();
  const menuList = useRef<HTMLDivElement>(null);
  const condList = useRef<HTMLDivElement>(null);
  useFocusOnOpen(menu.open, menuList, "[role=menuitem]");
  useFocusOnOpen(conds.open, condList, ".duel-opt");

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      setOutcome(await onImport(text));
    } finally {
      setBusy(false);
    }
  };

  const singles = field.format === "single";
  const flags = field.sides[side];
  const setFlag = (key: string, on: boolean) => setField((current) => ({
    ...current,
    sides: { ...current.sides, [side]: { ...current.sides[side], [key]: on } },
  }));
  const offered = SIDE_FLAGS.filter((flag) => !allowedFlags || allowedFlags.has(flag.key));
  const flagName = (flag: (typeof SIDE_FLAGS)[number]) => t(flag.label as MsgKey);
  // Live conditions take the visible places first; a muted one only says "set, but ignored here".
  const active = offered.filter((flag) => flags[flag.key])
    .map((flag) => ({ flag, muted: !!flag.doublesOnly && singles }))
    .sort((a, b) => Number(a.muted) - Number(b.muted));
  const condRow = useRef<HTMLDivElement>(null);
  const fit = useChipFit(condRow,
    `${active.map(({ flag, muted }) => `${flagName(flag)}${muted ? "~" : ""}`).join("|")}:${t("calc.condAdd")}`);
  const hidden = Math.max(0, active.length - fit);
  const condsTitle = t("calc.sideOf").replace("{side}", label);
  const moreLabel = t("calc.moreSideFlags")
    .replace("{n}", String(active.length))
    .replace("{flags}", active.map(({ flag }) => flagName(flag)).join("、"));

  const slots = Array.from({ length: TEAM_MAX }, (_, i) => {
    const mon = team[i];
    if (mon) {
      return <MonAvatar key={mon.uid || i} mon={mon} dex={dex} items={items} active={i === index}
        onClick={() => onIndex(i)} onRemove={team.length > 1 ? () => onRemove(i) : undefined} />;
    }
    if (i === team.length) {
      return (
        <button key={i} type="button" className="team-slot-add" onClick={onAdd}
          aria-label={t("calc.addMon")} title={t("calc.addMon")}>
          <PlusGlyph />
        </button>
      );
    }
    return <span key={i} className="team-slot-rest" aria-hidden />;
  });

  return (
    <div className={`team-bar${mirrored ? " mirrored" : ""}`}>
      <div className="team-who" ref={menu.wrap} onBlur={menu.onBlur}>
        <button ref={menu.trigger} type="button"
          className={`team-who-btn${menu.open ? " open" : ""}`}
          aria-haspopup="menu" aria-expanded={menu.open}
          aria-label={`${teamLabel} ${team.length}/${TEAM_MAX}`}
          title={t("calc.teamMenuHint")} onClick={menu.toggle}>
          <b>{label}<Caret /></b>
          <span className="num">{team.length}/{TEAM_MAX}</span>
        </button>
        {menu.open && (
          <div ref={menuList} className="duel-pop duel-menu" role="menu" aria-label={teamLabel}
            onKeyDown={(event) => roveFocus(event, "[role=menuitem]")}>
            <button type="button" role="menuitem" className="duel-menu-row"
              onClick={() => { menu.setOpen(false); setOutcome(null); paste.setOpen(true); }}>
              {t("calc.importPaste")}…
            </button>
            <div className="duel-menu-sep" role="separator" />
            <button type="button" role="menuitem" className="duel-menu-row danger"
              onClick={() => { menu.setOpen(false); onReset(); menu.trigger.current?.focus(); }}>
              {t("calc.resetTeamFull")}
            </button>
          </div>
        )}
      </div>
      <div className="team-strip" role="group" aria-label={teamLabel}>{slots}</div>

      {inlineFlags ? (
        <div className="team-conds inline" role="group" aria-label={condsTitle}>
          {offered.map((flag) => {
            const on = !!flags[flag.key];
            const ignored = !!flag.doublesOnly && singles;
            return (
              <button key={flag.key} type="button" className={`duel-toggle${on ? " on" : ""}`}
                data-cat={flag.cat} aria-pressed={on} disabled={ignored && !on}
                title={ignored ? t("calc.doublesOnlyHint") : flag.hint ? t(flag.hint as MsgKey) : undefined}
                onClick={() => setFlag(flag.key, !on)}>
                <i aria-hidden />{flagName(flag)}
              </button>
            );
          })}
        </div>
      ) : (
        <div className="team-conds-zone" ref={conds.wrap} onBlur={conds.onBlur}>
          <div ref={condRow} className="team-conds" aria-label={condsTitle}>
            {active.map(({ flag, muted }, at) => {
              const name = flagName(flag);
              const title = (muted ? t("calc.condSinglesOff") : t("calc.clearSideFlag"))
                .replace("{flag}", name);
              return (
                <button key={flag.key} type="button" data-chip
                  className={`duel-cond${muted ? " muted" : ""}${at >= fit ? " spill" : ""}`}
                  data-cat={flag.cat} title={title} aria-label={title} aria-hidden={at >= fit || undefined}
                  tabIndex={at >= fit ? -1 : undefined}
                  onClick={() => setFlag(flag.key, false)}>
                  <i aria-hidden /><span className="duel-cond-label">{name}</span>
                  <span className="duel-cond-x" aria-hidden>×</span>
                </button>
              );
            })}
            {offered.length > 0 ? (
              <button ref={conds.trigger} type="button"
                className={`duel-cond-add${conds.open ? " open" : ""}${hidden ? " more" : ""}`}
                aria-expanded={conds.open} title={hidden ? moreLabel : condsTitle}
                aria-label={hidden ? moreLabel : condsTitle} onClick={conds.toggle}>
                {hidden ? <span className="num">+{hidden}</span>
                  : <><PlusGlyph />{t("calc.condAdd")}</>}
              </button>
            ) : lockedNote ? (
              <span className="duel-cond-lock" title={lockedNote}>{lockedNote}</span>
            ) : null}
            {offered.length > 0 && (
              // Both faces of the button, measured by useChipFit; never seen, never focused.
              <>
                <span className="duel-cond-add spill" data-measure="full" aria-hidden>
                  <PlusGlyph />{t("calc.condAdd")}
                </span>
                <span className="duel-cond-add more spill" data-measure="count" aria-hidden>
                  <span className="num">+{Math.max(9, active.length)}</span>
                </span>
              </>
            )}
          </div>
          {conds.open && (
            <div ref={condList} className="duel-pop team-cond-pop" role="group" aria-label={condsTitle}
              onKeyDown={(event) => roveFocus(event, ".duel-opt")}>
              <div className="duel-pop-title">{condsTitle}{flagNote && <small>{flagNote}</small>}</div>
              <div className="duel-opt-grid">
                {offered.map((flag) => {
                  const on = !!flags[flag.key];
                  const ignored = !!flag.doublesOnly && singles;
                  return (
                    <button key={flag.key} type="button" className={`duel-opt${on ? " on" : ""}`}
                      data-cat={flag.cat} aria-pressed={on}
                      // A doubles-only flag that is already on stays clickable in singles, so it can
                      // still be switched off from here.
                      disabled={ignored && !on}
                      title={ignored ? t("calc.doublesOnlyHint")
                        : flag.hint ? t(flag.hint as MsgKey) : undefined}
                      onClick={() => setFlag(flag.key, !on)}>
                      <i aria-hidden /><span>{flagName(flag)}</span>
                      {flag.doublesOnly && <small>{t("format.double")}</small>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {paste.open && (
        <div className="duel-pop paste-pop" ref={paste.wrap} onBlur={paste.onBlur}
          role="dialog" aria-label={`${teamLabel} · ${t("calc.importPaste")}`}>
          <label className="paste-label">{t("calc.pasteHint")}
            <textarea rows={8} value={text} spellCheck={false} autoFocus
              placeholder={"Garchomp @ Life Orb\nAbility: Rough Skin\nJolly Nature\nSPs: 32 Atk / 32 Spe\n- Earthquake"}
              onChange={(e) => setText(e.target.value)} />
          </label>
          <div className="paste-actions">
            <button type="button" className="primary-btn" disabled={busy || !text.trim()}
              onClick={() => void run()}>
              {busy ? t("state.loading") : t("calc.pasteApply")}
            </button>
            <button type="button" className="ghost-btn"
              onClick={() => { paste.setOpen(false); setOutcome(null); menu.trigger.current?.focus(); }}>
              {t("calc.pasteClose")}
            </button>
          </div>
          {outcome && (
            <div className="paste-outcome">
              <div>{t("calc.pasteResult").replace("{n}", String(outcome.added))}</div>
              {outcome.rescaledEvs && <div className="paste-note">{t("calc.pasteEvNote")}</div>}
              {outcome.unresolved.length > 0 && (
                <div className="paste-note warn">
                  {t("calc.pasteUnresolved").replace("{names}", outcome.unresolved.join("、"))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
