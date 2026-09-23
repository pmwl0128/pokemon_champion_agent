/** One side's roster strip: the mons on that side, which one the editor below is showing, and the
 * pokepaste import that fills the whole strip at once.
 *
 * Import opens as a popover rather than an inline block: it has to stay open while you read back
 * what was and was not recognised, and a panel that pushes the page down moves everything the
 * reader was comparing. */
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { FIELD_FLAGS_TOGGLE } from "./FieldPanel.tsx";
import { MonAvatar } from "./MonEditor.tsx";
import type { MonState } from "./state.ts";

/** How many active-condition chips the head row previews inline. The row is a fixed height beside
 * the roster, so a long list can neither wrap nor scroll — it used to scroll with a hidden
 * scrollbar, which simply made the extra conditions invisible.
 *
 * The badge beside the preview carries the TOTAL, not the leftover: at an awkward width one more
 * chip can still be squeezed off the outer end, and a number that meant "hidden" would then be
 * wrong by one while a total stays true however the row lays out. It opens the flyout that owns the
 * full list. */
const MAX_FLAG_CHIPS = 3;

export interface ImportOutcome {
  added: number;
  unresolved: string[];
  rescaledEvs: boolean;
}

export const TEAM_MAX = 6;

export function TeamBar({
  label, team, index, onIndex, onAdd, onRemove, onReset, activeFlags, onClearFlag, onShowFlags,
  dex, items, onImport, mirrored = false,
}: {
  label: string;
  team: MonState[];
  index: number;
  onIndex: (i: number) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  onReset: () => void;
  activeFlags: Array<{ key: string; label: string }>;
  onClearFlag: (key: string) => void;
  /** Opens the side-condition flyout, so the chips that do not fit stay reachable. */
  onShowFlags: () => void;
  dex: DexIndexEntry[];
  items: ItemRef[];
  onImport: (text: string) => Promise<ImportOutcome>;
  /** Right-hand strip: the label, its import control and the roster all pack toward the page edge,
   * so the two sides read as facing each other rather than as one list repeated twice. */
  mirrored?: boolean;
}) {
  const t = useT();

  return (
    <div className={`team-bar${mirrored ? " mirrored" : ""}`}>
      <div className="team-bar-head">
        <strong>{label}</strong>
        <span className="team-bar-actions">
          <PasteImport onImport={onImport} />
          <button type="button" className="ghost-btn tiny" onClick={onReset}
            title={t("calc.resetSide").replace("{side}", label)}>
            {t("calc.resetTeam")}
          </button>
        </span>
        <div className="team-active-flags" aria-label={t("calc.activeSideFlags")}>
          {(() => {
            const hidden = Math.max(0, activeFlags.length - MAX_FLAG_CHIPS);
            const shown = hidden ? activeFlags.slice(activeFlags.length - MAX_FLAG_CHIPS) : activeFlags;
            const label = t("calc.moreSideFlags")
              .replace("{n}", String(activeFlags.length))
              .replace("{flags}", activeFlags.map((f) => f.label).join("、"));
            const more = hidden > 0 && (
              <button key="more" type="button" className="team-flag-chip more"
                {...{ [FIELD_FLAGS_TOGGLE]: "" }}
                title={label} aria-label={label} onClick={onShowFlags}>
                <span aria-hidden>⋯</span>{activeFlags.length}
              </button>
            );
            const chips = shown.map((flag) => (
              <button key={flag.key} type="button" className="team-flag-chip"
                title={t("calc.clearSideFlag").replace("{flag}", flag.label)}
                aria-label={t("calc.clearSideFlag").replace("{flag}", flag.label)}
                onClick={() => onClearFlag(flag.key)}>
                {flag.label}<span aria-hidden>×</span>
              </button>
            ));
            // The count stays beside Import/Reset when space is tight; conditions extend from
            // those actions toward the centre on either side of the field.
            return [more, ...chips];
          })()}
        </div>
      </div>
      <div className="team-strip">
        {team.map((mon, i) => (
          <MonAvatar key={mon.uid || i} mon={mon} dex={dex} items={items} active={i === index}
            onClick={() => onIndex(i)}
            onRemove={team.length > 1 ? () => onRemove(i) : undefined} />
        ))}
        <button type="button" className="team-add" onClick={onAdd}
          disabled={team.length >= TEAM_MAX}
          aria-label={team.length >= TEAM_MAX ? t("calc.maxSix") : t("calc.addMon")}
          title={team.length >= TEAM_MAX ? t("calc.maxSix") : t("calc.addMon")}>+</button>
      </div>
    </div>
  );
}

/** Pokepaste import: a trigger button plus the popover that reads the paste back.
 *
 * The popover positions against the caller's nearest positioned ancestor, so each surface decides
 * where it opens (the calculator's strip head, the bulk tool's roster column) without this control
 * wrapping itself in a box that would change the surrounding layout. */
export function PasteImport({ onImport, className = "ghost-btn tiny", label }: {
  onImport: (text: string) => Promise<ImportOutcome>;
  className?: string;
  label?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);

  // A popover that only closes on its own button strands itself the moment you click past it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!trigger.current?.contains(target) && !pop.current?.contains(target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const run = async () => {
    setBusy(true);
    try {
      setOutcome(await onImport(text));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button ref={trigger} type="button" className={className}
        aria-label={t("calc.importPaste")} aria-expanded={open}
        onClick={() => setOpen((v) => !v)}>
        {label ?? t("calc.importShort")}
      </button>
      {open && (
        <div ref={pop} className="paste-pop" role="dialog" aria-label={t("calc.importPaste")}>
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
              onClick={() => { setOpen(false); setOutcome(null); }}>
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
    </>
  );
}
