/** Observable conditions of their Pokémon. All edits still go to the calc page's shared roster;
 * nature and SP belong to the inference result, not to this input card. */
import { useEffect, type Dispatch, type SetStateAction } from "react";
import { displayName, useLang, useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { BOOST_KEYS, STATUSES, boostLabel, megaFor } from "../../../components/build/inputs.tsx";
import { MonNameRow, MonPortrait } from "../duel/MonEditor.tsx";
import { effectiveEntry, makeMon, type MonState } from "../duel/state.ts";
import type { KnownFacts, SpaceInfo } from "./context.ts";
import { useInferT } from "./messages.ts";

const STAT_LABEL: Record<string, MsgKey> = {
  atk: "stat.atk", def: "stat.def", spa: "stat.spa", spd: "stat.spd", spe: "stat.spe",
};

export function FoeCard({ foe, setFoe, dex, items, info, known, onKnown }: {
  foe: MonState;
  setFoe: Dispatch<SetStateAction<MonState>>;
  dex: DexIndexEntry[];
  items: ItemRef[];
  info: SpaceInfo | null;
  known: KnownFacts;
  onKnown: (known: KnownFacts) => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const ti = useInferT();
  const literal = dex.find((entry) => entry.slug === foe.slug);
  const mega = literal?.isMega ? literal : megaFor(foe.slug, foe.item, dex, items);
  const entry = effectiveEntry(foe, dex, items);
  const stone = mega ? items.find((item) => item.requiredBy?.includes(mega.name)) : undefined;
  const name = entry ? displayName(entry, lang) : "";

  // Preserve the same Mega stone invariant as the other shared-roster editors.
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
  const caption = (label: string, confirmed: boolean) => (
    <span className="inf-cap">{label}<em>{ti(mega ? "infer.fact.fixed"
      : confirmed ? "infer.fact.confirmed" : "infer.fact.unknown")}</em></span>
  );
  const itemChoices = [...new Set([...(info?.itemChoices ?? []), ...(known.item ? [known.item] : [])])];
  const abilityChoices = (mega ?? literal)?.abilities.map((ability) => ability.name) ?? [];
  const stages = BOOST_KEYS.filter((key) => foe.boosts[key]).map((key) =>
    `${t(STAT_LABEL[key]!)} ${boostLabel(foe.boosts[key]!)}`);

  return (
    <section className="panel inf-conditions" aria-label={ti("infer.conditions")}>
      <header className="inf-input-head"><h3>{ti("infer.conditions")}</h3></header>
      <p className="muted inf-input-note">{ti("infer.conditions.hint")}</p>
      <div className="mon-editor inf-foe-editor">
        <div className="mon-id">
          <MonPortrait entry={entry} name={name} />
          <MonNameRow slug={foe.slug} item={foe.item} dex={dex} items={items} pickerKey="infer-foe"
            onSpecies={(slug) => setFoe((current) => (current.slug === slug ? current : makeMon(slug)))}
            onForme={(slug, dropStone) => setFoe((current) => ({ ...current, slug, ...(dropStone ? { item: "" } : {}) }))} />
        </div>
        <div className="mon-build-row inf-known-fields">
          <label>{caption(t("calc.ability"), !!known.ability)}
            {mega ? <span className="inf-fixed">{abilityName(mega.abilities[0]?.name ?? "")}</span> : (
              <select value={known.ability ?? ""}
                onChange={(event) => onKnown({ ...known, ability: event.target.value || undefined })}>
                <option value="">{ti("infer.unknown")}</option>
                {abilityChoices.map((ability) => <option key={ability} value={ability}>{abilityName(ability)}</option>)}
              </select>
            )}
          </label>
          <label>{caption(t("calc.item"), !!known.item)}
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
        <details className="inf-boosts">
          <summary>{t("calc.boosts")}<span className="muted">{stages.join(" · ") || ti("infer.boosts.zero")}</span></summary>
          <div className="inf-boost-grid">
            {BOOST_KEYS.map((key) => {
              const stage = foe.boosts[key] ?? 0;
              const half = (Math.abs(stage) / 6) * 50;
              return (
                <label key={key} className="inf-boost-row"><span>{t(STAT_LABEL[key]!)}</span>
                  <span className={`boost-slider ${stage > 0 ? "up" : stage < 0 ? "down" : "flat"}`}>
                    <span className="boost-lane">
                      <span className="boost-track" aria-hidden
                        style={{ ["--fill-left" as string]: stage < 0 ? `${50 - half}%` : "50%",
                          ["--fill-width" as string]: `${half}%` }} />
                      <input type="range" min={-6} max={6} step={1} value={stage}
                        aria-label={`${t(STAT_LABEL[key]!)} ${t("calc.boosts")}`}
                        onChange={(event) => setFoe((current) => ({ ...current,
                          boosts: { ...current.boosts, [key]: Number(event.target.value) } }))} />
                    </span>
                    <span className="boost-read num">{boostLabel(stage)}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </details>
      </div>
    </section>
  );
}
