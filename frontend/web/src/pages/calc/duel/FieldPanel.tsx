/** Field conditions, shared by every direction on the page.
 *
 * Flags are stored per SIDE rather than per role, so the reverse card and the all-pairs grid read
 * the same two records with attacker/defender swapped. A screen the defender put up is still that
 * side's screen when the direction flips — encoding it as "defender side" would quietly protect the
 * wrong mon the moment you looked at the return hit.
 *
 * The centre strip keeps weather, format and terrain visible. Side and shared conditions live in a
 * compact popover above it, with active conditions visible on the strip after the popover closes. */
import type { FormatId, Terrain, Weather } from "@pokemon-champions/protocol";
import { TERRAINS, WEATHERS } from "@pokemon-champions/protocol";
import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { useT, type MsgKey } from "../../../i18n.ts";
import { FieldCheck } from "../shared.tsx";
import { SIDE_FLAGS, type FieldState, type SideId } from "./state.ts";

export interface FieldSuggestion {
  /** English canonical of the ability that would set it — shown so the offer names its source. */
  ability: string;
  label: string;
}

/** Marks every control that toggles the side-condition flyout. The outside-click handler has to
 * ignore them: the overflow chip that opens the flyout lives in a TEAM strip, not in this panel,
 * so a plain "clicked outside the panel" test would close the flyout on the same click. */
export const FIELD_FLAGS_TOGGLE = "data-field-flags-toggle";

function SideFlagColumn({ side, title, field, setField }: {
  side: SideId;
  title: string;
  field: FieldState;
  setField: Dispatch<SetStateAction<FieldState>>;
}) {
  const t = useT();
  const flags = SIDE_FLAGS.filter((f) => !(f.doublesOnly && field.format === "single"));
  const set = (key: string, on: boolean) => setField((s) => ({
    ...s,
    sides: { ...s.sides, [side]: { ...s.sides[side], [key]: on } },
  }));
  return (
    <div className="field-side" role="group" aria-label={title}>
      <div className="field-side-flags">
        {flags.map((flag) => (
          <FieldCheck key={flag.key} label={t(flag.label as MsgKey)}
            title={flag.hint ? t(flag.hint as MsgKey) : undefined}
            checked={!!field.sides[side][flag.key]}
            onChange={(v) => set(flag.key, v)} />
        ))}
      </div>
    </div>
  );
}

export function FieldPanel({
  field, setField, sideALabel, sideBLabel, weatherSuggestions, terrainSuggestions, open, setOpen,
}: {
  field: FieldState;
  setField: Dispatch<SetStateAction<FieldState>>;
  sideALabel: string;
  sideBLabel: string;
  /** On-field abilities that would set this, when it is not set already. Offered, never applied:
   * the mon holding one may not be the one that led, and a silently changed field is a silently
   * changed answer. BOTH sides are listed — which setter actually landed is a battle fact. */
  weatherSuggestions: Array<FieldSuggestion & { value: Weather }>;
  terrainSuggestions: Array<FieldSuggestion & { value: Terrain }>;
  /** Owned by the page: the team strips' overflow chips open this same flyout. */
  open: boolean;
  setOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const t = useT();
  const setFormat = (format: FormatId) => setField((s) => ({ ...s, format }));
  const wrap = useRef<HTMLElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 160);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const node = e.target as Element | null;
      if (node?.closest?.(`[${FIELD_FLAGS_TOGGLE}]`)) return;
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);
  useEffect(() => () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
  }, []);
  const commonFlags = [
    { key: "gravity", label: t("calc.gravity"), active: field.gravity },
    { key: "foresight", label: t("calc.foresight"), active: field.foresight },
    { key: "switchInDrops", label: t("calc.switchInDrops"), active: field.switchInDrops },
  ] as const;
  return (
    <section className="field-panel" ref={wrap} aria-label={t("calc.fieldOptions")}
      onMouseEnter={cancelClose} onMouseLeave={scheduleClose}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}>
      {open && (
        <div id="calc-field-flags" className="field-flyout" role="group"
          aria-label={t("calc.fieldOptions")}>
          <div className="field-flyout-row">
            <SideFlagColumn side="a" title={sideALabel} field={field} setField={setField} />
            <div className="field-shared-flags" role="group" aria-label={t("calc.fieldOptions")}>
              <FieldCheck label={t("calc.gravity")} title={t("calc.gravityHint")}
                checked={field.gravity} onChange={(v) => setField((s) => ({ ...s, gravity: v }))} />
              <FieldCheck label={t("calc.foresight")} title={t("calc.foresightHint")}
                checked={field.foresight} onChange={(v) => setField((s) => ({ ...s, foresight: v }))} />
              <FieldCheck label={t("calc.switchInDrops")} title={t("calc.switchInDropsHint")}
                checked={field.switchInDrops}
                onChange={(v) => setField((s) => ({ ...s, switchInDrops: v }))} />
            </div>
            <SideFlagColumn side="b" title={sideBLabel} field={field} setField={setField} />
          </div>
        </div>
      )}
      <div className="field-global">
        <div className="field-active-common" aria-label={t("calc.activeSideFlags")}>
          {commonFlags.filter((flag) => flag.active).map((flag) => (
            <button key={flag.key} type="button" className="team-flag-chip"
              title={t("calc.clearSideFlag").replace("{flag}", flag.label)}
              onClick={() => setField((s) => ({ ...s, [flag.key]: false }))}>
              {flag.label}<span aria-hidden>×</span>
            </button>
          ))}
        </div>
        <div className="field-line">
          <div className="field-weather">
            {weatherSuggestions.map((sug) => (
              <button key={sug.ability} type="button" className="field-suggest"
                title={t("calc.fieldSuggestHint").replace("{ability}", sug.label)}
                onClick={() => setField((s) => ({ ...s, weather: sug.value }))}>
                {sug.label}
              </button>
            ))}
            <label className="field-control-label">
              <span className="field-cap">{t("calc.weather")}</span>
              <select value={field.weather}
                onChange={(e) => setField((s) => ({ ...s, weather: e.target.value as Weather | "" }))}>
                <option value="">{t("calc.none")}</option>
                {WEATHERS.map((w) => <option key={w} value={w}>{t(`weather.${w}`)}</option>)}
              </select>
            </label>
          </div>
          <div className="seg field-format" role="group" aria-label={t("a11y.format")}>
            <button type="button" className={field.format === "single" ? "on" : ""}
              aria-pressed={field.format === "single"} onClick={() => setFormat("single")}>
              {t("format.single")}
            </button>
            <button type="button" className="field-expand"
              aria-expanded={open} aria-controls="calc-field-flags"
              {...{ [FIELD_FLAGS_TOGGLE]: "" }}
              onMouseEnter={() => { cancelClose(); setOpen(true); }}
              onFocus={() => setOpen(true)} onClick={() => setOpen(true)}>
              {t("calc.fieldOptions")}
            </button>
            <button type="button" className={field.format === "double" ? "on" : ""}
              aria-pressed={field.format === "double"} onClick={() => setFormat("double")}>
              {t("format.double")}
            </button>
          </div>
          <div className="field-terrain">
            <label className="field-control-label">
              <span className="field-cap">{t("calc.terrain")}</span>
              <select value={field.terrain}
                onChange={(e) => setField((s) => ({ ...s, terrain: e.target.value as Terrain | "" }))}>
                <option value="">{t("calc.none")}</option>
                {TERRAINS.map((x) => <option key={x} value={x}>{t(`terrain.${x}`)}</option>)}
              </select>
            </label>
            {terrainSuggestions.map((sug) => (
              <button key={sug.ability} type="button" className="field-suggest"
                title={t("calc.fieldSuggestHint").replace("{ability}", sug.label)}
                onClick={() => setField((s) => ({ ...s, terrain: sug.value }))}>
                {sug.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
