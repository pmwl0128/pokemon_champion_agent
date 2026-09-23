/** The bar that opens the bulk tool: our roster on the left, theirs on the right, and between them
 * the few field conditions the solver can actually carry (format, weather, terrain, our screens).
 * They are laid out in the open rather than folded into the calculator's condition flyout — there
 * are only four of them, and a toggle the solver would silently drop does not belong here at all:
 * it would make the live number and the solved number disagree. */
import type { FormatId, Terrain, Weather } from "@pokemon-champions/protocol";
import { TERRAINS, WEATHERS } from "@pokemon-champions/protocol";
import { memo, type Dispatch, type SetStateAction } from "react";
import { useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { MonAvatar } from "../duel/MonEditor.tsx";
import { PasteImport, TEAM_MAX, type ImportOutcome } from "../duel/TeamBar.tsx";
import type { FieldState, MonState } from "../duel/state.ts";
import type { TuneSide } from "./model.ts";

/** Our screens, stored on the shared field's side "a" — ours, the side being hit here. */
export const SCREEN_FLAGS: Array<{ key: string; label: MsgKey }> = [
  { key: "reflect", label: "calc.reflect" },
  { key: "light_screen", label: "calc.lightScreen" },
  { key: "aurora_veil", label: "calc.auroraVeil" },
];

function Roster({ side, team, active, dex, items, onActive, onAdd, onRemove, onReset, onImport }: {
  side: TuneSide;
  team: MonState[];
  active: number;
  dex: DexIndexEntry[];
  items: ItemRef[];
  onActive: (side: TuneSide, index: number) => void;
  onAdd: (side: TuneSide) => void;
  onRemove: (side: TuneSide, index: number) => void;
  onReset: (side: TuneSide) => void;
  onImport: (side: TuneSide, text: string) => Promise<ImportOutcome>;
}) {
  const t = useT();
  const label = side === "mine" ? t("speed.ours") : t("speed.theirs");
  const full = team.length >= TEAM_MAX;
  return (
    <div className={`tw-roster ${side}`} role="group" aria-label={label}>
      <div className="tw-roster-head">
        <strong>{label}</strong>
        <span className="num">{team.length}/{TEAM_MAX}</span>
        <PasteImport className="tw-text-btn" onImport={(text) => onImport(side, text)} />
        <button type="button" className="tw-text-btn" onClick={() => onReset(side)}
          title={t("calc.resetSide").replace("{side}", label)}>{t("calc.resetTeam")}</button>
      </div>
      <div className="tw-roster-list">
        {team.map((mon, index) => (
          <MonAvatar key={mon.uid} mon={mon} dex={dex} items={items} active={index === active}
            onClick={() => onActive(side, index)}
            onRemove={team.length > 1 ? () => onRemove(side, index) : undefined} />
        ))}
        <button type="button" className="team-add" onClick={() => onAdd(side)} disabled={full}
          aria-label={full ? t("calc.maxSix") : t("calc.addMon")}
          title={full ? t("calc.maxSix") : t("calc.addMon")}>+</button>
      </div>
    </div>
  );
}

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
  const roster = { dex, items, onActive, onAdd, onRemove, onReset, onImport };
  return (
    <div className="tw-strip">
      <Roster side="mine" team={teams.mine} active={active.mine} {...roster} />
      <div className="tw-field">
        <div className="tw-field-line">
          <label>
            <span>{t("calc.weather")}</span>
            <select value={field.weather}
              onChange={(event) => setField((current) => ({ ...current,
                weather: event.target.value as Weather | "" }))}>
              <option value="">{t("calc.none")}</option>
              {WEATHERS.map((weather) => <option key={weather} value={weather}>{t(`weather.${weather}`)}</option>)}
            </select>
          </label>
          <div className="seg tw-format" role="group" aria-label={t("a11y.format")}>
            {(["single", "double"] as const).map((format) => (
              <button key={format} type="button" className={field.format === format ? "on" : ""}
                aria-pressed={field.format === format} onClick={() => setFormat(format)}>
                {t(`format.${format}`)}
              </button>
            ))}
          </div>
          <label>
            <span>{t("calc.terrain")}</span>
            <select value={field.terrain}
              onChange={(event) => setField((current) => ({ ...current,
                terrain: event.target.value as Terrain | "" }))}>
              <option value="">{t("calc.none")}</option>
              {TERRAINS.map((terrain) => <option key={terrain} value={terrain}>{t(`terrain.${terrain}`)}</option>)}
            </select>
          </label>
        </div>
        <div className="tw-field-line tw-screens" role="group" aria-label={t("tune.ws.screens")}>
          <span>{t("tune.ws.screens")}</span>
          {SCREEN_FLAGS.map((flag) => {
            const on = !!field.sides.a[flag.key];
            return (
              <button key={flag.key} type="button" className={on ? "on" : ""} aria-pressed={on}
                onClick={() => toggleScreen(flag.key)}>{t(flag.label)}</button>
            );
          })}
        </div>
      </div>
      <Roster side="foe" team={teams.foe} active={active.foe} {...roster} />
    </div>
  );
});
