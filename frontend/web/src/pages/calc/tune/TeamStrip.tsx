/** The bar that opens the bulk tool: the calculator's roster bar, so switching tabs does not move a
 * pixel — the same two `TeamBar`s (label, import, reset, avatars) and the same centre console lines.
 * The centre carries only the conditions the solver can actually carry: format, weather and terrain
 * on the console line, our screens on the line above it where the calculator lists its active
 * conditions. A toggle the solver would silently drop does not belong here: it would make the live
 * number and the solved number disagree. */
import type { FormatId, Terrain, Weather } from "@pokemon-champions/protocol";
import { TERRAINS, WEATHERS } from "@pokemon-champions/protocol";
import { memo, type Dispatch, type SetStateAction } from "react";
import { useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { TeamBar, type ImportOutcome } from "../duel/TeamBar.tsx";
import type { FieldState, MonState } from "../duel/state.ts";
import type { TuneSide } from "./model.ts";

/** Our screens, stored on the shared field's side "a" — ours, the side being hit here. */
export const SCREEN_FLAGS: Array<{ key: string; label: MsgKey }> = [
  { key: "reflect", label: "calc.reflect" },
  { key: "light_screen", label: "calc.lightScreen" },
  { key: "aurora_veil", label: "calc.auroraVeil" },
];

const NO_FLAGS: Array<{ key: string; label: string }> = [];
const noop = () => {};

export const TeamStrip = memo(function TeamStrip({ teams, active, field, setField, dex, items, onActive,
  onAdd, onRemove, onReset, onImport }: {
  teams: Record<TuneSide, MonState[]>;
  active: Record<TuneSide, number>;
  field: FieldState;
  setField: Dispatch<SetStateAction<FieldState>>;
  dex: DexIndexEntry[];
  items: ItemRef[];
  onActive: (side: TuneSide, index: number) => void;
  onAdd: (side: TuneSide) => void;
  onRemove: (side: TuneSide, index: number) => void;
  onReset: (side: TuneSide) => void;
  onImport: (side: TuneSide, text: string) => Promise<ImportOutcome>;
}) {
  const t = useT();
  const setFormat = (format: FormatId) => setField((current) => ({ ...current, format }));
  const toggleScreen = (key: string) => setField((current) => ({
    ...current,
    sides: { ...current.sides, a: { ...current.sides.a, [key]: !current.sides.a[key] } },
  }));
  const roster = (side: TuneSide) => ({
    team: teams[side], index: active[side], dex, items,
    onIndex: (index: number) => onActive(side, index),
    onAdd: () => onAdd(side),
    onRemove: (index: number) => onRemove(side, index),
    onReset: () => onReset(side),
    onImport: (text: string) => onImport(side, text),
    // The side conditions the calculator lists here are not the solver's; ours are in the centre.
    activeFlags: NO_FLAGS, onClearFlag: noop, onShowFlags: noop,
  });
  const weather = field.weather ? ` weather-${field.weather.toLowerCase()}` : "";
  const terrain = field.terrain ? ` terrain-${field.terrain.toLowerCase()}` : "";
  return (
    <div className={`duel-teams tw-teams${weather}${terrain}`}>
      <TeamBar label={t("calc.attackerTeam")} {...roster("mine")} />
      <section className="field-panel" aria-label={t("calc.fieldOptions")}>
        <div className="field-global">
          <div className="field-active-common tw-walls" role="group" aria-label={t("tune.ws.screens")}>
            <span className="tw-walls-cap">{t("tune.ws.screens")}</span>
            {SCREEN_FLAGS.map((flag) => {
              const on = !!field.sides.a[flag.key];
              return (
                <button key={flag.key} type="button" className={`team-flag-chip tw-wall${on ? " on" : ""}`}
                  aria-pressed={on} onClick={() => toggleScreen(flag.key)}>{t(flag.label)}</button>
              );
            })}
          </div>
          <div className="field-line">
            <div className="field-weather">
              <label className="field-control-label">
                <span className="field-cap">{t("calc.weather")}</span>
                <select value={field.weather}
                  onChange={(event) => setField((current) => ({ ...current,
                    weather: event.target.value as Weather | "" }))}>
                  <option value="">{t("calc.none")}</option>
                  {WEATHERS.map((value) => <option key={value} value={value}>{t(`weather.${value}`)}</option>)}
                </select>
              </label>
            </div>
            <div className="seg field-format" role="group" aria-label={t("a11y.format")}>
              {(["single", "double"] as const).map((format) => (
                <button key={format} type="button" className={field.format === format ? "on" : ""}
                  aria-pressed={field.format === format} onClick={() => setFormat(format)}>
                  {t(`format.${format}`)}
                </button>
              ))}
            </div>
            <div className="field-terrain">
              <label className="field-control-label">
                <span className="field-cap">{t("calc.terrain")}</span>
                <select value={field.terrain}
                  onChange={(event) => setField((current) => ({ ...current,
                    terrain: event.target.value as Terrain | "" }))}>
                  <option value="">{t("calc.none")}</option>
                  {TERRAINS.map((value) => <option key={value} value={value}>{t(`terrain.${value}`)}</option>)}
                </select>
              </label>
            </div>
          </div>
        </div>
      </section>
      <TeamBar label={t("calc.defenderTeam")} {...roster("foe")} mirrored />
    </div>
  );
});
