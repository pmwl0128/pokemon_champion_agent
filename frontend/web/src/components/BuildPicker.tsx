/** Compact, complete configuration cards shared by the calculator's environment picker and the
 * simulation table headers. The surrounding Pokemon card/header already establishes the species,
 * so this popover deliberately starts with the configurations instead of repeating its portrait. */
import { STAT_KEYS, type OppSetDto, type StatKey } from "@pokemon-champions/protocol";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { displayName, useLang, useT } from "../i18n.ts";
import { useDexByName, useMovesByName, useNatures } from "../hooks.ts";
import { localName, useNameMaps } from "../lib/names.ts";
import { actualStat } from "../lib/stats.ts";
import { TypeBadge } from "./TypeBadge.tsx";

export interface BuildCardOption {
  key: string;
  source: "aggregate" | "meta" | "custom";
  coverage: number | null;
  isModal: boolean;
  set: OppSetDto;
  /** Original A/B/C position when this option is rendered outside its picker list. */
  labelIndex?: number;
}

const pct = (n: number | null | undefined) => n == null ? null : `${Math.round(n * 100)}%`;
const buildLabel = (i: number) => String.fromCharCode(65 + i);
const STAT_SHORT: Record<StatKey, string> = {
  hp: "H", atk: "A", def: "B", spa: "C", spd: "D", spe: "S",
};

/** The direct-on-card configuration summary. It is intentionally dense, but no field is hidden
 * behind another hover: item, ability, nature, every SP value and all retained moves are visible. */
export function BuildSetSummary({ option, index, selected = false, title }: {
  option: BuildCardOption;
  index: number;
  selected?: boolean;
  title?: ReactNode;
}) {
  const { lang } = useLang();
  const t = useT();
  const maps = useNameMaps();
  const moves = useMovesByName();
  const dex = useDexByName();
  const natures = useNatures();
  const set = option.set;
  const entry = dex.get(set.runForm ?? set.species) ?? dex.get(set.species);
  const nature = natures.status === "ready"
    ? natures.data.find((candidate) => candidate.name === set.nature) : undefined;
  const share = pct(option.coverage);
  const moveLabel = (name: string) => {
    const hit = moves.get(name);
    return hit ? displayName(hit, lang) : name;
  };
  const tag = option.source === "meta" ? "META"
    : option.source === "custom" ? t("calc.customSetShort") : buildLabel(option.labelIndex ?? index);
  const sideLabel = option.source === "meta" ? t("calc.metaFallback")
    : option.source === "custom" ? t("calc.customSet") : share ?? "—";
  const abilityLabel = set.ability ? localName(maps.ability, set.ability, lang) : "—";
  const natureLabel = set.nature ? localName(maps.nature, set.nature, lang) : "—";
  const actuals = STAT_KEYS.map((key) => {
    if (!entry || !set.sps || (key !== "hp" && !nature)) return { key, value: null };
    const mult: 0.9 | 1 | 1.1 = key === "hp" ? 1
      : nature?.upStat === key && nature.downStat !== key ? 1.1
        : nature?.downStat === key && nature.upStat !== key ? 0.9 : 1;
    return { key, value: actualStat(entry.stats[key], key, set.sps[key] ?? 0, mult) };
  });
  const actualMax = Math.max(1, ...actuals.map(({ value }) => value ?? 0));
  const moveSlots = Array.from({ length: 4 }, (_, index) => set.moves?.[index] ?? "");

  return (
    <span className={`build-card-body${selected ? " selected" : ""}`}>
      <span className="build-card-top">
        <span className={`build-card-tag${option.source !== "aggregate" ? ` ${option.source}` : ""}`}>{tag}</span>
        <span className="build-card-primary">
          <b>{set.item ? localName(maps.item, set.item, lang) : "—"}</b>
          {entry?.isMega && <span className="build-mega-badge">MEGA</span>}
          <span className="build-card-identity"
            title={set.baseAbility && set.baseAbility !== set.ability
              ? `${t("matchup.variantBaseAbilityLabel")} ${localName(maps.ability, set.baseAbility, lang)}`
              : undefined}>
            <span>{abilityLabel}</span>
            <span className="build-card-sep"> · </span>
            <span>{natureLabel}</span>
          </span>
        </span>
        <span className="build-card-share num">
          {sideLabel}
          {option.isModal && option.source === "aggregate" && <em>{t("matchup.variantModal")}</em>}
        </span>
      </span>
      {title && <span className="build-card-title">{title}</span>}
      <span className="build-card-sp-row num">
        <span className="build-card-sp-label">SP</span>
        <span className="build-card-sp-bars">
          {STAT_KEYS.map((key) => {
            const value = set.sps?.[key] ?? 0;
            const width = Math.round((value / 32) * 100);
            return (
              <span key={key} className="build-card-sp-stat"
                style={{
                  background: `linear-gradient(to right, color-mix(in srgb, var(--brand) 30%, transparent) ${width}%, transparent ${width}%)`,
                }}>
                <span>{STAT_SHORT[key]}</span>{value}
              </span>
            );
          })}
        </span>
      </span>
      <span className="build-card-detail-grid">
        <span className="build-card-moves">
          {moveSlots.map((move, index) => {
            const hit = move ? moves.get(move) : undefined;
            return (
              <span className={`build-card-move${move ? "" : " empty"}`} key={`${move}-${index}`}>
                {hit ? <TypeBadge type={hit.type} iconOnly /> : <span className="build-card-move-dot" />}
                <span>{move ? moveLabel(move) : "—"}</span>
              </span>
            );
          })}
        </span>
        <span className="build-card-stats num">
          {actuals.map(({ key, value }) => {
            const width = value == null ? 0 : Math.max(8, Math.round((value / actualMax) * 100));
            return (
              <span key={key} className="build-card-stat"
                style={value == null ? undefined : {
                  background: `linear-gradient(to right, color-mix(in srgb, var(--success) 28%, transparent) ${width}%, transparent ${width}%)`,
                }}>
                <span className="muted">{STAT_SHORT[key]}</span> {value ?? "—"}
              </span>
            );
          })}
        </span>
      </span>
    </span>
  );
}

export function BuildPicker({
  options, currentKey, onPick, onClose, anchorRef, hint, busy = false,
}: {
  options: BuildCardOption[];
  currentKey?: string;
  onPick: (option: BuildCardOption) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  hint: ReactNode;
  busy?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: "hidden" });

  useEffect(() => {
    const place = () => {
      const anchor = anchorRef.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = Math.min(352, window.innerWidth - 16);
      const height = Math.min(ref.current?.offsetHeight ?? 300, window.innerHeight - 16);
      const gap = 8;
      const left = Math.min(Math.max(8, anchor.right - width), window.innerWidth - width - 8);
      const below = anchor.bottom + gap;
      const top = below + height > window.innerHeight - 8
        ? Math.max(8, anchor.top - height - gap)
        : below;
      setPos({ top, left, width, visibility: "visible" });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    const away = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchorRef.current?.contains(target)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const scrollAway = (event: Event) => {
      // The list itself may need to scroll to reach a Meta fallback. Only movement of the page or
      // an enclosing grid invalidates the fixed anchor position.
      const target = event.target;
      if (!(target instanceof Node) || !ref.current?.contains(target)) onClose();
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", scrollAway, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", scrollAway, true);
    };
  }, [anchorRef, onClose]);

  return createPortal(
    <div className="build-picker" ref={ref} role="dialog" aria-label={t("calc.setPick")}
         style={pos}>
      <div className="build-picker-note">{hint}</div>
      {busy ? <div className="build-picker-state">{t("state.loading")}</div>
        : options.length ? (
          <ul className="build-picker-list">
            {options.map((option, index) => (
              <li key={option.key}>
                <button type="button" className={`build-card${option.key === currentKey ? " on" : ""}`}
                  aria-pressed={option.key === currentKey}
                  onClick={() => { onPick(option); onClose(); }}>
                  <BuildSetSummary option={option} index={index}
                    selected={option.key === currentKey} />
                </button>
              </li>
            ))}
          </ul>
        ) : <div className="build-picker-state">{t("calc.noSetOptions")}</div>}
    </div>,
    document.body,
  );
}
