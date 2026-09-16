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
import { MonAvatar } from "./MonEditor.tsx";
import type { MonState } from "./state.ts";

export interface ImportOutcome {
  added: number;
  unresolved: string[];
  rescaledEvs: boolean;
}

export const TEAM_MAX = 6;

export function TeamBar({
  label, team, index, onIndex, onAdd, onRemove, dex, items, onImport, mirrored = false,
}: {
  label: string;
  team: MonState[];
  index: number;
  onIndex: (i: number) => void;
  onAdd: () => void;
  onRemove: (i: number) => void;
  dex: DexIndexEntry[];
  items: ItemRef[];
  onImport: (text: string) => Promise<ImportOutcome>;
  /** Right-hand strip: the label, its import control and the roster all pack toward the page edge,
   * so the two sides read as facing each other rather than as one list repeated twice. */
  mirrored?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // A popover that only closes on its own button strands itself the moment you click past it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
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
    <div className={`team-bar${mirrored ? " mirrored" : ""}`}>
      <div className="team-bar-head" ref={wrap}>
        <strong>{label}</strong>
        <button type="button" className="ghost-btn tiny"
          aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t("calc.importPaste")}
        </button>
        {open && (
          <div className="paste-pop" role="dialog" aria-label={t("calc.importPaste")}>
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
      </div>
      <div className="team-strip">
        {team.map((mon, i) => (
          <MonAvatar key={i} mon={mon} dex={dex} items={items} active={i === index}
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
