/** Field conditions, shared by every direction on the page.
 *
 * Flags are stored per SIDE rather than per role, so the reverse card and the all-pairs grid read
 * the same two records with attacker/defender swapped. A screen the defender put up is still that
 * side's screen when the direction flips — encoding it as "defender side" would quietly protect the
 * wrong mon the moment you looked at the return hit. */
import type { FormatId, Terrain, Weather } from "@pokemon-champions/protocol";
import { TERRAINS, WEATHERS } from "@pokemon-champions/protocol";
import type { Dispatch, SetStateAction } from "react";
import { FormatTabs } from "../../../components/FormatTabs.tsx";
import { useT, type MsgKey } from "../../../i18n.ts";
import { FieldCheck } from "../shared.tsx";
import { SIDE_FLAGS, type FieldState, type SideId } from "./state.ts";

export interface FieldSuggestion {
  /** English canonical of the ability that would set it — shown so the offer names its source. */
  ability: string;
  label: string;
}

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
    <div className="field-side">
      <h4>{title}</h4>
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
  field, setField, sideALabel, sideBLabel, weatherSuggestions, terrainSuggestions,
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
}) {
  const t = useT();
  const setFormat = (format: FormatId) => setField((s) => ({ ...s, format }));
  return (
    <section className="panel field-panel">
      {/* No section heading: the row IS the field, and a title line here only buys vertical space
          between the results and the teams they were computed from. Format leads the row because it
          re-prices everything to its right. */}
      <div className="field-global">
        <FormatTabs format={field.format} onChange={setFormat} />
        <label>{t("calc.weather")}
          <span className="field-pick">
            <select value={field.weather}
              onChange={(e) => setField((s) => ({ ...s, weather: e.target.value as Weather | "" }))}>
              <option value="">{t("calc.none")}</option>
              {WEATHERS.map((w) => <option key={w} value={w}>{t(`weather.${w}`)}</option>)}
            </select>
            {weatherSuggestions.map((sug) => (
              <button key={sug.ability} type="button" className="field-suggest"
                title={t("calc.fieldSuggestHint").replace("{ability}", sug.label)}
                onClick={() => setField((s) => ({ ...s, weather: sug.value }))}>
                {sug.label}
              </button>
            ))}
          </span>
        </label>
        <label>{t("calc.terrain")}
          <span className="field-pick">
            <select value={field.terrain}
              onChange={(e) => setField((s) => ({ ...s, terrain: e.target.value as Terrain | "" }))}>
              <option value="">{t("calc.none")}</option>
              {TERRAINS.map((x) => <option key={x} value={x}>{t(`terrain.${x}`)}</option>)}
            </select>
            {terrainSuggestions.map((sug) => (
              <button key={sug.ability} type="button" className="field-suggest"
                title={t("calc.fieldSuggestHint").replace("{ability}", sug.label)}
                onClick={() => setField((s) => ({ ...s, terrain: sug.value }))}>
                {sug.label}
              </button>
            ))}
          </span>
        </label>
        <span className="fld-group">
          <FieldCheck label={t("calc.gravity")} title={t("calc.gravityHint")}
            checked={field.gravity} onChange={(v) => setField((s) => ({ ...s, gravity: v }))} />
          <FieldCheck label={t("calc.foresight")} title={t("calc.foresightHint")}
            checked={field.foresight} onChange={(v) => setField((s) => ({ ...s, foresight: v }))} />
          <FieldCheck label={t("calc.switchInDrops")} title={t("calc.switchInDropsHint")}
            checked={field.switchInDrops}
            onChange={(v) => setField((s) => ({ ...s, switchInDrops: v }))} />
        </span>
      </div>
      <div className="field-sides">
        <SideFlagColumn side="a" title={sideALabel} field={field} setField={setField} />
        <SideFlagColumn side="b" title={sideBLabel} field={field} setField={setField} />
      </div>
    </section>
  );
}
