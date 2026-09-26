/** One roster Pokémon, edited for Speed.
 *
 * The build is the shared roster's, so the card edits the same fields the calculator does, with the
 * calculator's own identity row (searchable name, forme, environment builds) and build row (ability,
 * nature, searchable item, status). What it adds is the Speed control: the Scarf and investment
 * presets, and one Speed row laid out like the bulk tool's SP rows — SP box, slider, stage, and the
 * engine's final Speed with the multipliers that produced it. Tailwind and Trick Room are on the
 * strip above: they belong to a side and to the field, not to one Pokémon. */
import type { FormatId, NatureDto, SpeedInputDto, SpeedlineDto } from "@pokemon-champions/protocol";
import { useEffect } from "react";
import { displayName, useLang, useT } from "../../../i18n.ts";
import { localName, useNameMaps } from "../../../lib/names.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import {
  BuildPickerButton, ItemCombo, STATUSES, boostLabel, buildConfigSig, clampNum, megaFor, natureLabel,
  spSumClass,
} from "../shared.tsx";
import { MonNameRow, MonPortrait } from "../duel/MonEditor.tsx";
import { applyBuildOption, effectiveEntry, makeMon, type MonState } from "../duel/state.ts";
import { SpSlider, StageSelect } from "../tune/MonCards.tsx";
import {
  SCARF, SP_BUDGET, SP_MAX, TIER_KEYS, applyTier, natureDir, spTotal, tierOf, type Offense, type Tier,
} from "./lens.ts";

const TIER_LABEL: Record<Tier, "speed.preset.max" | "speed.preset.fast" | "speed.preset.none" | "speed.preset.min"> = {
  max: "speed.preset.max", fast: "speed.preset.fast", none: "speed.preset.none", min: "speed.preset.min",
};

const WEATHER_SPEED: Record<string, string> = {
  Chlorophyll: "Sun", "Swift Swim": "Rain", "Sand Rush": "Sand", "Slush Rush": "Snow",
};

/** The multipliers the engine applied, named for the reader, and their product past the stage.
 * Display only: the number beside them is always the engine's, so a label that ever disagreed would
 * be visibly wrong, never silently. */
function useSpeedChain(input: SpeedInputDto | null, result: SpeedlineDto | null,
                       items: ItemRef[]): { parts: string[]; factor: number } {
  const t = useT();
  const { lang } = useLang();
  const abilityNames = useNameMaps().ability;
  if (!input || !result) return { parts: [], factor: 1 };
  const parts: string[] = [t("speed.raw").replace("{n}", String(result.rawSpeed))];
  let factor = 1;
  const push = (label: string, times: number) => { parts.push(`${label} ×${times}`); factor *= times; };
  const stage = input.boosts?.spe ?? 0;
  if (stage) parts.push(`${t("speed.boost")} ${boostLabel(stage)}`);
  const itemName = (name: string) => {
    const ref = items.find((candidate) => candidate.name === name);
    return ref ? displayName(ref, lang) : name;
  };
  if (input.item === SCARF) push(itemName(SCARF), 1.5);
  if (input.item === "Iron Ball") push(itemName("Iron Ball"), 0.5);
  const ability = input.ability ?? "";
  const abilityLabel = ability ? localName(abilityNames, ability, lang) : "";
  const weather = input.field?.weather ?? "";
  const umbrella = input.item === "Utility Umbrella";
  const weatherHit = WEATHER_SPEED[ability] && WEATHER_SPEED[ability] === weather
    && !(umbrella && (weather === "Sun" || weather === "Rain"));
  if (weatherHit || (ability === "Surge Surfer" && input.field?.terrain === "Electric")
      || (ability === "Unburden" && !input.item)) {
    push(abilityLabel, 2);
  }
  const quickFeet = ability === "Quick Feet" && !!input.status;
  if (quickFeet) push(abilityLabel, 1.5);
  if (input.field?.tailwind) push(t("speed.tailwind"), 2);
  if (input.status === "Paralyzed" && !quickFeet) push(t("status.Paralyzed"), 0.5);
  return { parts, factor };
}

export function SpeedCard({
  label, mon, setMon, pickerKey, dex, natures, items, format, offense, input, result, scarf,
}: {
  /** The side's name, for screen readers: the strip above already shows which card is whose. */
  label: string;
  mon: MonState;
  setMon: (update: (mon: MonState) => MonState) => void;
  pickerKey: string;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  offense: Offense;
  input: SpeedInputDto | null;
  result: SpeedlineDto | null;
  scarf: { on: boolean; blocked: string | null; toggle: () => void };
}) {
  const t = useT();
  const { lang } = useLang();
  const literal = dex.find((e) => e.slug === mon.slug);
  const mega = literal?.isMega ? literal : megaFor(mon.slug, mon.item, dex, items);
  const entry = effectiveEntry(mon, dex, items);
  const requiredStone = mega ? items.find((i) => i.requiredBy?.includes(mega.name)) : undefined;
  const chain = useSpeedChain(input, result, items);
  const total = spTotal(mon.sps);
  const over = total - SP_BUDGET;
  const tier = tierOf(natures, mon);
  const sp = mon.sps.spe ?? 0;
  const stage = mon.boosts.spe ?? 0;
  const statLabel = t("stat.spe");
  const setSp = (value: number | string) =>
    setMon((s) => ({ ...s, sps: { ...s.sps, spe: clampNum(String(value), 0, SP_MAX) } }));
  // As on the bulk tool's rows: a stage paints the value as a chip in its direction; without one,
  // the nature's direction colours the text.
  const dir = natureDir(natures, mon.nature);
  const tone = stage > 0 ? "boost-up" : stage < 0 ? "boost-down" : dir === "+" ? "up" : dir === "-" ? "down" : "";
  const factor = Math.round(chain.factor * 100) / 100;

  // The same reconciliation the calculator's editor runs: a Mega form picked by name holds its
  // stone, and the ability select describes the form the engine will calculate.
  useEffect(() => {
    if (requiredStone && mon.item !== requiredStone.name) setMon((s) => ({ ...s, item: requiredStone.name }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, mon.slug]);
  useEffect(() => {
    if (mega && !mega.abilities.some((a) => a.name === mon.ability)) {
      setMon((s) => ({ ...s, ability: mega.abilities[0]?.name ?? "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mega?.slug, mon.item]);

  /** Give an over-budget build back its excess from bulk (HP, Defense, Sp. Def) — only on request:
   * a spread the user typed is theirs to rebalance. */
  const giveBack = () => setMon((s) => {
    let excess = spTotal(s.sps) - SP_BUDGET;
    if (excess <= 0) return s;
    const sps = { ...s.sps };
    for (const key of ["hp", "def", "spd"] as const) {
      const take = Math.min(sps[key] ?? 0, excess);
      sps[key] = (sps[key] ?? 0) - take;
      excess -= take;
    }
    return { ...s, sps };
  });

  return (
    <section className="panel mon-editor spd-card" aria-label={label}>
      <div className="mon-id">
        <MonPortrait entry={entry} name={entry ? displayName(entry, lang) : ""} />
        <MonNameRow slug={mon.slug} item={mon.item} dex={dex} items={items} pickerKey={pickerKey}
          actions={(
            <BuildPickerButton slug={mon.slug} format={format}
              currentKey={mon.buildRef?.signature === buildConfigSig(mon) ? mon.buildRef.key : undefined}
              onPick={(option, index) => setMon((s) => applyBuildOption(s, option, index))} />
          )}
          onSpecies={(slug) => setMon((s) => (s.slug === slug ? s : makeMon(slug)))}
          onForme={(slug, dropStone) => setMon((s) => ({ ...s, slug, ...(dropStone ? { item: "" } : {}) }))} />
      </div>

      <div className="mon-build-row">
        <label>{t("calc.ability")}
          <select value={mon.ability}
            onChange={(e) => setMon((s) => ({ ...s, ability: e.target.value, abilityOn: null }))}>
            <option value="">—</option>
            {(mega ?? literal)?.abilities.map((a) => (
              <option key={a.name} value={a.name}>{displayName(a, lang)}</option>
            ))}
          </select>
        </label>
        <label>{t("calc.nature")}
          <select value={mon.nature} onChange={(e) => setMon((s) => ({ ...s, nature: e.target.value }))}>
            <option value="">—</option>
            {natures.map((n) => <option key={n.name} value={n.name}>{natureLabel(n, lang)}</option>)}
          </select>
        </label>
        <label>{t("calc.item")}
          <ItemCombo idKey={pickerKey} value={mon.item} items={items} disabled={!!requiredStone}
            onChange={(item) => setMon((s) => ({ ...s, item }))} />
        </label>
        <label>{t("calc.status")}
          <select value={mon.status} onChange={(e) => setMon((s) => ({ ...s, status: e.target.value }))}>
            {STATUSES.map((st) => (
              <option key={st} value={st === "Healthy" ? "" : st}>{t(`status.${st}`)}</option>
            ))}
          </select>
        </label>
      </div>
      {mon.ability === "Unburden" && (
        <label className="inline-check" title={t("speed.unburdenHint")}>
          <input type="checkbox" checked={mon.abilityOn === true}
            onChange={(e) => setMon((s) => ({ ...s, abilityOn: e.target.checked ? true : null }))} />
          <span>{t("calc.abilityOn")}</span>
        </label>
      )}

      <div className="spd-tune">
        <div className="speed-presets" role="group" aria-label={t("speed.presets")}>
          <button type="button" className={scarf.on ? "on" : ""} aria-pressed={scarf.on}
            disabled={!!scarf.blocked && !scarf.on} title={scarf.blocked ?? t("speed.scarfHint")}
            onClick={scarf.toggle}>
            {t("speed.scarf")}
          </button>
          <span className="spd-preset-sep" aria-hidden />
          {TIER_KEYS.map((key) => (
            <button key={key} type="button" className={tier === key ? "on" : ""} aria-pressed={tier === key}
              title={t("speed.presetHint")}
              onClick={() => setMon((s) => applyTier(s, key, natures, offense))}>
              {t(TIER_LABEL[key])}
            </button>
          ))}
          <span className="spd-budget">
            {over > 0 && (
              <button type="button" className="spd-give-back" onClick={giveBack} title={t("speed.giveBackHint")}>
                {t("speed.overBudget").replace("{n}", String(over))} · {t("speed.giveBack")}
              </button>
            )}
            <span className="tw-sp-total">{t("tune.ws.spTotal")}
              <b className={`sp-sum num ${spSumClass(total)}`}>{total}/{SP_BUDGET}</b>
            </span>
          </span>
        </div>
        <div className="tw-sp-row spd-sp-row">
          <span className="tw-sp-name">{statLabel}</span>
          <input type="number" min={0} max={SP_MAX} className="num tw-sp-input" value={sp}
            aria-label={`${statLabel} SP`} onChange={(e) => setSp(e.target.value)} />
          <SpSlider label={statLabel} value={sp} onChange={setSp} />
          <StageSelect value={stage} label={`${statLabel} ${t("calc.boosts")}`}
            onChange={(next) => setMon((s) => ({ ...s, boosts: { ...s.boosts, spe: next } }))} />
          <span className="num tw-sp-final" title={chain.parts.length ? chain.parts.join(" · ") : undefined}
            aria-label={`${t("speed.final")} ${result?.finalSpeed ?? "—"}`}>
            <b className={tone}>{result?.finalSpeed ?? "—"}</b>
            <small className={factor > 1 ? "up" : factor < 1 ? "down" : ""}>{factor !== 1 ? `×${factor}` : ""}</small>
          </span>
        </div>
      </div>
    </section>
  );
}
