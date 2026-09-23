/** A move slot as the result grids show it: the move is typed in a short box, the rest of the cell is
 * what you press to select it, and the reading it produced sits on the right. The damage calculator
 * and the bulk tool use the same cell, so a move reads — and is edited — the same way on both tabs. */
import type { LearnsetDto } from "@pokemon-champions/protocol";
import { memo, useEffect, useMemo, useState, type ReactNode } from "react";
import { AdaptiveCombobox } from "../../../components/AdaptiveCombobox.tsx";
import { TypeBadge } from "../../../components/TypeBadge.tsx";
import { typeColor } from "../../../assets/icons.ts";
import { displayName, useLang, useT } from "../../../i18n.ts";

/** A learnset-restricted move input: typing resolves against this mon's own legal moves in any of
 * the three languages, so a slot can never hold a move the calc would reject. */
export function MoveSlot({ value, onChange, learnset, index }: {
  value: string;
  onChange: (name: string) => void;
  learnset: LearnsetDto | null;
  index: number;
}) {
  const { lang } = useLang();
  const t = useT();
  const [text, setText] = useState("");
  const moves = learnset?.moves ?? [];

  useEffect(() => {
    const hit = moves.find((m) => m.name === value);
    setText(hit ? displayName(hit, lang) : value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, lang, moves.length]);

  const options = useMemo(() => moves.map((m) => ({
    key: m.name,
    value: displayName(m, lang),
    secondary: `${m.type}${m.power != null ? ` · ${m.power}` : ""}`,
  })), [moves, lang]);

  const resolve = (raw: string): string | null => {
    const q = raw.trim();
    if (!q) return "";
    const lower = q.toLowerCase();
    const exact = moves.find((m) => m.name.toLowerCase() === lower
      || m.nameZh === q || m.nameJa === q || displayName(m, lang).toLowerCase() === lower);
    if (exact) return exact.name;
    const part = moves.find((m) => m.name.toLowerCase().includes(lower)
      || (m.nameZh ?? "").includes(q) || (m.nameJa ?? "").includes(q));
    return part ? part.name : null;
  };

  const current = moves.find((m) => m.name === value);
  return (
    <div className="move-slot">
      <span className="move-slot-mark">
        {current ? <TypeBadge type={current.type} iconOnly /> : <span className="move-slot-dot" />}
      </span>
      <AdaptiveCombobox value={text} options={options} title={text || undefined}
        placeholder={`${t("calc.move")} ${index + 1}`}
        onValueChange={(next) => {
          setText(next);
          const hit = resolve(next);
          if (hit !== null && (hit === "" || moves.some((m) => m.name === hit
            && displayName(m, lang) === next.trim()))) onChange(hit);
        }}
        onCommit={(raw) => {
          const hit = resolve(raw);
          if (hit !== null) onChange(hit);
          else setText(current ? displayName(current, lang) : "");
        }} />
    </div>
  );
}

/** The input half of a cell, memoised: its option list is the whole learnset, and the reading beside
 * it changes on every edit elsewhere on the page. */
const MoveInput = memo(function MoveInput({ index, value, learnset, onChange }: {
  index: number;
  value: string;
  learnset: LearnsetDto | null;
  onChange: (index: number, name: string) => void;
}) {
  return <MoveSlot index={index} value={value} learnset={learnset}
    onChange={(name) => onChange(index, name)} />;
});

export function MoveCell({ index, value, learnset, selected, pending = false, onSelect, onChange,
  children }: {
  index: number;
  value: string;
  learnset: LearnsetDto | null;
  selected: boolean;
  /** The reading belongs to an earlier input while the current one is being computed. */
  pending?: boolean;
  onSelect: (index: number) => void;
  onChange: (index: number, name: string) => void;
  /** The reading: damage band, KO label, "Status" … */
  children: ReactNode;
}) {
  const type = learnset?.moves.find((move) => move.name === value)?.type;
  return (
    // Selecting happens on press and on focus, so clicking into the name to retype it also makes it
    // the live move; the input stays the only interactive element inside.
    <div className={`move-cell${selected ? " on" : ""}${pending ? " pending" : ""}`}
      aria-current={selected ? "true" : undefined}
      // The type arrives as a colour VARIABLE, not a fill: several types are dark enough that text on
      // the flat colour is unreadable, so the cell spends it on an edge, a ring and a wash.
      style={type ? { ["--mv" as string]: typeColor(type) } : undefined}
      onMouseDown={() => onSelect(index)} onFocus={() => onSelect(index)}>
      <MoveInput index={index} value={value} learnset={learnset} onChange={onChange} />
      <span className="move-cell-read num">{children}</span>
    </div>
  );
}
