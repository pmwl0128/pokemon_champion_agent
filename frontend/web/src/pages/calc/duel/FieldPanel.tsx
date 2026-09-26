/** The duel strip's centre console: weather, format and terrain, plus the conditions that belong to
 * the whole field rather than to one side.
 *
 * Flags are stored per SIDE rather than per role, so the reverse card and the all-pairs grid read
 * the same two records with attacker/defender swapped. A screen the defender put up is still that
 * side's screen when the direction flips — encoding it as "defender side" would quietly protect the
 * wrong mon the moment you looked at the return hit. Those per-side flags are edited on each wing
 * (TeamBar); this console only owns what both sides share.
 *
 * Weather and terrain are pickers rather than native selects so each option can show what it is —
 * the weather's own art, the terrain's colour — the same cues the strip itself paints with. With
 * those cues the value needs no "天气 / 场地" caption; only the empty state names its field. */
import type { FormatId, Terrain, Weather } from "@pokemon-champions/protocol";
import { TERRAINS, WEATHERS } from "@pokemon-champions/protocol";
import { useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useLang, useT } from "../../../i18n.ts";
import { localName, useNameMaps } from "../../../lib/names.ts";
import { roveFocus, useFocusOnOpen, usePopover } from "./popover.ts";
import {
  TERRAIN_ABILITIES, WEATHER_ABILITIES, type FieldState, type MonState, type SharedFlagKey,
} from "./state.ts";
import { Caret, PlusGlyph } from "./TeamBar.tsx";

export interface FieldSuggestion {
  /** English canonical of the ability that would set it — shown so the offer names its source. */
  ability: string;
  label: string;
}

/** Field-setting abilities on the Pokémon currently up, offered next to the picker they would
 * fill — only while that field is still empty: an offer to set what is already set says nothing.
 * Both sides are listed: which setter actually landed is a battle fact the page cannot know. */
export function useFieldOffers(mons: MonState[], field: FieldState): {
  weather: Array<FieldSuggestion & { value: Weather }>;
  terrain: Array<FieldSuggestion & { value: Terrain }>;
} {
  const abilityNames = useNameMaps().ability;
  const { lang } = useLang();
  const offers = <V extends string,>(table: Record<string, V>, current: string) => {
    if (current) return [];
    const seen = new Set<string>();
    return mons.flatMap((mon) => {
      const value = mon.ability ? table[mon.ability] : undefined;
      if (!value || seen.has(mon.ability)) return [];
      seen.add(mon.ability);
      return [{ ability: mon.ability, label: localName(abilityNames, mon.ability, lang), value }];
    });
  };
  return {
    weather: offers(WEATHER_ABILITIES, field.weather),
    terrain: offers(TERRAIN_ABILITIES, field.terrain),
  };
}

/** The calculator's field-wide switches; a tool that reads others passes its own list. */
export const DAMAGE_SHARED_FLAGS: SharedFlagKey[] = ["gravity", "foresight", "switchInDrops"];

function FieldPicker<V extends string>({ kind, cap, value, options, label, mark, onPick }: {
  kind: "weather" | "terrain";
  cap: string;
  value: V | "";
  options: ReadonlyArray<V | "">;
  label: (value: V | "") => string;
  mark: (value: V | "") => ReactNode;
  onPick: (value: V | "") => void;
}) {
  const pop = usePopover();
  const list = useRef<HTMLDivElement>(null);
  useFocusOnOpen(pop.open, list, '[aria-selected="true"]');
  const current = label(value);
  // The empty label already names its field ("无天气"); a set value gets the caption back for
  // screen readers and the tooltip, since the pill itself only shows the value.
  const spoken = value ? `${cap} · ${current}` : current;
  return (
    <div className={`field-pick ${kind}`} ref={pop.wrap} onBlur={pop.onBlur}>
      <button ref={pop.trigger} type="button"
        className={`field-pill${pop.open ? " open" : ""}${value ? " set" : ""}`}
        aria-haspopup="listbox" aria-expanded={pop.open} aria-label={spoken}
        title={spoken} onClick={pop.toggle}>
        {mark(value)}
        <span className="field-pill-value">{current}</span>
        <Caret />
      </button>
      {pop.open && (
        <div ref={list} className="duel-pop field-pick-pop" role="listbox" aria-label={cap}
          onKeyDown={(event) => roveFocus(event, "[role=option]")}>
          {options.map((option) => (
            <button key={option || "none"} type="button" role="option"
              aria-selected={option === value}
              className={`duel-menu-row${option === value ? " on" : ""}`}
              onClick={() => { onPick(option); pop.setOpen(false); pop.trigger.current?.focus(); }}>
              {mark(option)}<span>{label(option)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function FieldPanel({
  field, setField, weatherSuggestions, terrainSuggestions, sharedFlags = DAMAGE_SHARED_FLAGS,
  inlineShared = false,
}: {
  field: FieldState;
  setField: Dispatch<SetStateAction<FieldState>>;
  /** On-field abilities that would set this, when it is not set already. Offered, never applied:
   * the mon holding one may not be the one that led, and a silently changed field is a silently
   * changed answer. BOTH sides are listed — which setter actually landed is a battle fact. */
  weatherSuggestions: Array<FieldSuggestion & { value: Weather }>;
  terrainSuggestions: Array<FieldSuggestion & { value: Terrain }>;
  /** The field-wide switches this tool's numbers read. A switch no number reads is not shown —
   * its state stays on the shared field for the tools that do read it. */
  sharedFlags?: SharedFlagKey[];
  /** Show the field-wide switches as toggles on the console line instead of chips plus a popover. */
  inlineShared?: boolean;
}) {
  const t = useT();
  const sharedPop = usePopover();
  const sharedList = useRef<HTMLDivElement>(null);
  useFocusOnOpen(sharedPop.open, sharedList, ".duel-opt");
  const setFormat = (format: FormatId) => setField((s) => ({ ...s, format }));
  const setShared = (key: SharedFlagKey, on: boolean) => setField((s) => ({ ...s, [key]: on }));
  const sharedVocab: Record<SharedFlagKey, { label: string; hint: string }> = {
    gravity: { label: t("calc.gravity"), hint: t("calc.gravityHint") },
    foresight: { label: t("calc.foresight"), hint: t("calc.foresightHint") },
    switchInDrops: { label: t("calc.switchInDrops"), hint: t("calc.switchInDropsHint") },
    trickRoom: { label: t("speed.trickRoom"), hint: t("calc.trickRoomHint") },
  };
  const shared = sharedFlags.map((key) => ({ key, ...sharedVocab[key] }));
  const showShared = shared.length > 0;
  const sharedTitle = t("calc.sharedConds");
  const offer = (sug: FieldSuggestion, target: string, apply: () => void) => (
    <button key={`${sug.ability}:${target}`} type="button" className="field-offer"
      title={t("calc.fieldSuggestHint").replace("{ability}", sug.label)} onClick={apply}>
      <span>{sug.label}</span><span className="field-offer-arrow" aria-hidden>→</span><b>{target}</b>
    </button>
  );

  return (
    <section className="field-console" aria-label={t("calc.fieldConsole")}>
      <div className="field-console-main">
        <FieldPicker<Weather> kind="weather" cap={t("calc.weather")} value={field.weather}
          options={["", ...WEATHERS]}
          label={(value) => value ? t(`weather.${value}`) : t("calc.noWeather")}
          mark={(value) => <span className="wx-swatch" data-weather={value || undefined} aria-hidden />}
          onPick={(weather) => setField((s) => ({ ...s, weather }))} />
        <div className="seg field-format" role="group" aria-label={t("a11y.format")}>
          {(["single", "double"] as const).map((format) => (
            <button key={format} type="button" className={field.format === format ? "on" : ""}
              aria-pressed={field.format === format} onClick={() => setFormat(format)}>
              {t(`format.${format}`)}
            </button>
          ))}
        </div>
        <FieldPicker<Terrain> kind="terrain" cap={t("calc.terrain")} value={field.terrain}
          options={["", ...TERRAINS]}
          label={(value) => value ? t(`terrain.${value}`) : t("calc.noTerrain")}
          mark={(value) => <span className="terrain-dot" data-terrain={value || undefined} aria-hidden />}
          onPick={(terrain) => setField((s) => ({ ...s, terrain }))} />
      </div>

      <div className="field-console-conds" ref={sharedPop.wrap} onBlur={sharedPop.onBlur}>
        {weatherSuggestions.map((sug) => offer(sug, t(`weather.${sug.value}`),
          () => setField((s) => ({ ...s, weather: sug.value }))))}
        {terrainSuggestions.map((sug) => offer(sug, t(`terrain.${sug.value}`),
          () => setField((s) => ({ ...s, terrain: sug.value }))))}
        {inlineShared && shared.map((flag) => (
          <button key={flag.key} type="button" data-cat="shared"
            className={`duel-toggle${field[flag.key] ? " on" : ""}`}
            aria-pressed={field[flag.key]} title={flag.hint}
            onClick={() => setShared(flag.key, !field[flag.key])}>
            <i aria-hidden />{flag.label}
          </button>
        ))}
        {!inlineShared && shared.filter((flag) => field[flag.key]).map((flag) => {
          const title = t("calc.clearSideFlag").replace("{flag}", flag.label);
          return (
            <button key={flag.key} type="button" className="duel-cond" data-cat="shared"
              title={title} aria-label={title} onClick={() => setShared(flag.key, false)}>
              <i aria-hidden /><span className="duel-cond-label">{flag.label}</span>
              <span className="duel-cond-x" aria-hidden>×</span>
            </button>
          );
        })}
        {showShared && !inlineShared && (
          <button ref={sharedPop.trigger} type="button"
            className={`duel-cond-add${sharedPop.open ? " open" : ""}`}
            aria-expanded={sharedPop.open} title={sharedTitle} aria-label={sharedTitle}
            onClick={sharedPop.toggle}>
            <PlusGlyph />{t("calc.sharedAdd")}
          </button>
        )}
        {sharedPop.open && (
          <div ref={sharedList} className="duel-pop field-shared-pop" role="group"
            aria-label={sharedTitle} onKeyDown={(event) => roveFocus(event, ".duel-opt")}>
            <div className="duel-pop-title">{sharedTitle}</div>
            <div className="duel-opt-grid">
              {shared.map((flag) => (
                <button key={flag.key} type="button" data-cat="shared"
                  className={`duel-opt${field[flag.key] ? " on" : ""}`}
                  aria-pressed={field[flag.key]} title={flag.hint}
                  onClick={() => setShared(flag.key, !field[flag.key])}>
                  <i aria-hidden /><span>{flag.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
