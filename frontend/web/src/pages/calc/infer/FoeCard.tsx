/** Their build, laid out like ours but split by what a battle can show.
 *
 * Observable — and therefore editable here: the species and forme, a revealed item or ability
 * (unknown until confirmed; confirming writes it to the shared roster), the status and the stat
 * stages. Not observable: nature and SP. Those are the inference's subject, so the card shows the
 * build currently adopted (the environment auto-fill, or a real build picked from the 采用 button or
 * the list below) read-only, beside the SP range each stat is inferred to — the adopted build is an
 * assumption, the inferred range is what the recorded hits allow. With nothing adopted the build is
 * custom and its unobservable fields read "—". */
import type { FormatId, NatureDto } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { displayName, useLang, useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { BuildPickerButton, STATUSES, boostLabel, megaFor, natureLabel, type BuildOption } from "../../../components/build/inputs.tsx";
import { MonNameRow, MonPortrait, buildCardOptionForMon } from "../duel/MonEditor.tsx";
import { effectiveEntry, finalStat, makeMon, maxHPOf, type MonState } from "../duel/state.ts";
import type { KnownFacts, SpaceInfo } from "./context.ts";
import type { SpKey, StatView } from "./model.ts";
import { useInferT } from "./messages.ts";

const STAT_LABEL: Record<string, MsgKey> = {
  hp: "stat.hp", atk: "stat.atk", def: "stat.def", spa: "stat.spa", spd: "stat.spd", spe: "stat.spe",
};

function InferredCell({ view }: { view: StatView | null }) {
  const t = useInferT();
  const observed = !!view?.observed;
  const range = !view ? t("infer.foe.speedNot") : !observed ? t("infer.ruler.unobserved")
    : view.lo <= view.hi ? (view.lo === view.hi ? String(view.lo) : `${view.lo}–${view.hi}`) : "—";
  return (
    <span className="inf-foe-inferred" title={t("infer.foe.note")}>
      <span className={`inf-cells${observed ? "" : " hatched"}`} aria-hidden>
        {(view && observed ? view.mass : new Array<number>(33).fill(0)).map((value, sp) => (
          <i key={sp} className={value > 0 ? "on" : ""}
            style={observed ? { opacity: value > 0 ? 0.22 + value * 0.78 : 1 } : undefined} />
        ))}
      </span>
      <span className={`num inf-foe-range${observed ? "" : " muted"}`}>{range}</span>
    </span>
  );
}

export function FoeCard({ foe, setFoe, dex, natures, items, format, adoptedKey, onAdopt, info, known, onKnown,
  stats, fit }: {
  foe: MonState;
  setFoe: Dispatch<SetStateAction<MonState>>;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  /** The environment card their build still is exactly, if any. */
  adoptedKey: string | null;
  onAdopt: (option: BuildOption, index: number) => void;
  info: SpaceInfo | null;
  known: KnownFacts;
  onKnown: (known: KnownFacts) => void;
  /** Inferred SP per stat; null before the inference exists. */
  stats: Record<SpKey, StatView> | null;
  /** Whether the adopted build still explains every observation; null with nothing observed. */
  fit: boolean | null;
}) {
  const { lang } = useLang();
  const t = useT();
  const ti = useInferT();
  const literal = dex.find((entry) => entry.slug === foe.slug);
  const mega = literal?.isMega ? literal : megaFor(foe.slug, foe.item, dex, items);
  const entry = effectiveEntry(foe, dex, items);
  const stone = mega ? items.find((item) => item.requiredBy?.includes(mega.name)) : undefined;
  const name = entry ? displayName(entry, lang) : "";

  // A Mega picked by forme holds its stone, as on the calculator's card.
  useEffect(() => {
    if (stone && foe.item !== stone.name) setFoe((current) => ({ ...current, item: stone.name }));
  }, [stone?.name, foe.slug]);

  const itemName = (value: string) => {
    const ref = items.find((item) => item.name === value);
    return ref ? displayName(ref, lang) : value;
  };
  const abilityName = (value: string) => {
    const ref = (mega ?? literal)?.abilities.find((ability) => ability.name === value);
    return ref ? displayName(ref, lang) : value;
  };
  /** The field's caption, with the adopted value beside it while the fact itself is unknown. */
  const caption = (label: string, adopted: string, confirmed: boolean) => (
    <span className="inf-cap">{label}
      {!confirmed && adopted && <em title={ti("infer.foe.adoptedHint")}>
        {ti("infer.foe.adoptedValue").replace("{value}", adopted)}</em>}
    </span>
  );
  const itemChoices = [...new Set([...(info?.itemChoices ?? []), ...(known.item ? [known.item] : [])])];
  const abilityChoices = (mega ?? literal)?.abilities.map((ability) => ability.name) ?? [];

  const nature = natures.find((candidate) => candidate.name === foe.nature);
  const natureTone = (key: string) =>
    (nature?.upStat === key && nature.downStat !== key ? "up"
      : nature?.downStat === key && nature.upStat !== key ? "down" : "");
  // Nothing adopted and nothing assumed: the unobservable half of the card reads blank.
  const blank = !foe.nature && !Object.values(foe.sps).some((value) => (value ?? 0) > 0);
  const card = entry ? buildCardOptionForMon(foe, entry, dex) : null;
  const source = !card || !adoptedKey ? ti("infer.foe.source.custom")
    : card.source === "aggregate"
      ? ti("infer.foe.source.aggregate").replace("{pct}", card.coverage !== null ? `${(card.coverage * 100).toFixed(0)}%` : "")
      : ti("infer.foe.source.meta");

  const adopt = entry && (
    <span className="inf-adopted" title={ti("infer.foe.pickHint")}>
      <span className="muted">{ti("infer.foe.adopted")}</span>
      <BuildPickerButton slug={foe.slug} format={format} currentKey={adoptedKey ?? undefined}
        onPick={onAdopt} className={`ghost-btn tiny inf-adopt-btn${adoptedKey ? " on" : ""}`} label={source} />
    </span>
  );
  const fitTag = fit !== null && entry && (
    <span className={`tw-state inf-fit ${fit ? "pass" : "fail"}`} title={ti(fit ? "infer.tip.fitCard" : "infer.tip.outCard")}>
      {ti(fit ? "infer.foe.fit" : "infer.foe.out")}</span>
  );

  return (
    <div className="mon-editor inf-foe-editor">
      <div className="mon-id">
        <MonPortrait entry={entry} name={name} />
        <MonNameRow slug={foe.slug} item={foe.item} dex={dex} items={items} pickerKey="infer-foe"
          actions={adopt} nameExtra={fitTag}
          onSpecies={(slug) => setFoe((current) => (current.slug === slug ? current : makeMon(slug)))}
          onForme={(slug, dropStone) => setFoe((current) => ({ ...current, slug, ...(dropStone ? { item: "" } : {}) }))} />
      </div>

      <div className="mon-build-row">
        <label>{caption(t("calc.ability"), mega ? "" : abilityName(foe.ability), !!known.ability)}
          {mega ? <span className="inf-fixed">{abilityName(mega.abilities[0]?.name ?? "")}</span> : (
            <select value={known.ability ?? ""}
              onChange={(event) => onKnown({ ...known, ability: event.target.value || undefined })}>
              <option value="">{ti("infer.unknown")}</option>
              {abilityChoices.map((ability) => <option key={ability} value={ability}>{abilityName(ability)}</option>)}
            </select>
          )}
        </label>
        <label><span className="inf-cap" title={ti("infer.foe.adoptedHint")}>{ti("infer.foe.natureCap")}</span>
          <span className="inf-fixed" title={ti("infer.foe.adoptedHint")}>
            {nature ? natureLabel(nature, lang) : "—"}</span>
        </label>
        <label>{caption(t("calc.item"), mega ? "" : itemName(foe.item), !!known.item)}
          {mega ? <span className="inf-fixed">{itemName(stone?.name ?? foe.item)}</span> : (
            <select value={known.item ?? ""}
              onChange={(event) => onKnown({ ...known, item: event.target.value || undefined })}>
              <option value="">{ti("infer.unknown")}</option>
              {itemChoices.map((item) => <option key={item} value={item}>{itemName(item)}</option>)}
            </select>
          )}
        </label>
        <label>{t("calc.status")}
          <select value={foe.status} onChange={(event) => setFoe((current) => ({ ...current, status: event.target.value }))}>
            {STATUSES.map((status) => (
              <option key={status} value={status === "Healthy" ? "" : status}>{t(`status.${status}` as MsgKey)}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="stat-table inf-foe-table">
        <div className="stat-table-head">
          <span>{t("calc.stat")}</span>
          <span>{t("calc.base")}</span>
          <span className="inf-tip" title={ti("infer.foe.note")}>{ti("infer.foe.inferred")}</span>
          <span className="num inf-tip" title={ti("infer.foe.adoptedHint")}>{ti("infer.foe.adopted")}</span>
          <span>{t("calc.boosts")}</span>
          <span className="num">{t("calc.final")}</span>
        </div>
        {STAT_KEYS.map((key) => {
          const stage = key === "hp" ? 0 : foe.boosts[key as "atk"] ?? 0;
          const half = (Math.abs(stage) / 6) * 50;
          return (
            <div className="stat-table-row" key={key}>
              <span className="stat-name" title={t(STAT_LABEL[key]!)}>{key.toUpperCase()}</span>
              <span className="num muted">{entry?.stats[key] ?? "—"}</span>
              <InferredCell view={key === "spe" ? null : stats?.[key as SpKey] ?? null} />
              <span className="num inf-foe-adopted">{blank ? "—" : foe.sps[key] ?? 0}</span>
              {key === "hp" ? <span className="stat-noboost">—</span> : (
                <span className={`boost-slider ${stage > 0 ? "up" : stage < 0 ? "down" : "flat"}`}>
                  <span className="boost-lane">
                    <span className="boost-track" aria-hidden
                      style={{ ["--fill-left" as string]: stage < 0 ? `${50 - half}%` : "50%",
                               ["--fill-width" as string]: `${half}%` }} />
                    <input type="range" min={-6} max={6} step={1} value={stage} aria-label={`${key} boost`}
                      onChange={(event) => setFoe((current) => ({
                        ...current, boosts: { ...current.boosts, [key]: Number(event.target.value) },
                      }))} />
                  </span>
                  <span className="boost-read num">{boostLabel(stage)}</span>
                </span>
              )}
              <span className={`num stat-final ${key === "hp" ? "" : natureTone(key)}`}>
                {blank ? "—" : (key === "hp" ? maxHPOf(foe, dex, items) : finalStat(foe, entry, natures, key)) || "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
