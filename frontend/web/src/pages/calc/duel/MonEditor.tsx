/** One combatant's editable build: species + forme, ability, nature, item, status and the SP /
 * boost / final-stat table with current HP. The four moves are edited in the result grid above it,
 * where their damage is read, and the portrait lives there too.
 *
 * The stat table shows base, investment and RESULT side by side because that is the number the calc
 * actually used — a spread that reads "32 Spe" tells you nothing about whether it clears a
 * benchmark, and re-deriving it in your head is exactly the arithmetic this page exists to remove. */
import type { FormatId, NatureDto } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { BuildSetSummary, type BuildCardOption } from "../../../components/BuildPicker.tsx";
import { EntityHover } from "../../../components/EntityHover.tsx";
import { GameImage } from "../../../components/GameImage.tsx";
import { PLACEHOLDERS, typeColor } from "../../../assets/icons.ts";
import { TypeBadge } from "../../../components/TypeBadge.tsx";
import { displayName, useLang, useT } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import {
  BuildPickerButton, ItemCombo, MonPicker, STATUSES, boostLabel, clampNum, megaFor, natureLabel,
  buildConfigSig, spSum, spSumClass, type BuildOption,
} from "../shared.tsx";
import {
  ABILITY_NEEDS_TRIGGER, boostedStat, curHPOf, effectiveEntry, finalStat, makeMon,
  maxHPOf, type MonState,
} from "./state.ts";

/** Species (and, for a species with Mega forms, the forme) as one identity row: a single field, or
 * two side by side when a forme exists. Shared by the calculator and the bulk tool so the same mon
 * is named the same way on both. `actions` rides on the row's label line. */
/** The mon's portrait on a soft wash of its primary type, beside the name row of a build. */
export function MonPortrait({ entry, name }: { entry: DexIndexEntry | undefined; name: string }) {
  const primary = entry?.types[0];
  return (
    <span className="duel-portrait"
      style={primary ? { ["--mt" as string]: typeColor(primary) } : undefined}>
      {entry
        ? <GameImage assetKey={entry.key} role="dense" alt={name} className="hp-bar-sprite" />
        : <img className="hp-bar-sprite" src={PLACEHOLDERS.pokemon} alt="" aria-hidden />}
    </span>
  );
}

export function MonNameRow({ slug, item, dex, items, pickerKey, actions, identityShown = false,
  onSpecies, onForme }: {
  slug: string;
  item: string;
  dex: DexIndexEntry[];
  items: ItemRef[];
  pickerKey: string;
  actions?: ReactNode;
  /** The surface already prints this mon's types and Mega state beside its portrait (the damage
   * calculator's result headline), so the row leaves them out instead of saying them twice. */
  identityShown?: boolean;
  /** A different species: the caller decides what of the old build survives. */
  onSpecies: (slug: string) => void;
  /** A forme switch keeps the build; `dropStone` asks the caller to clear a held Mega stone. */
  onForme: (slug: string, dropStone: boolean) => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const literal = dex.find((e) => e.slug === slug);
  const mega = literal?.isMega ? literal : megaFor(slug, item, dex, items);
  const entry = mega ?? literal;
  // Forme picker: the base species plus every Mega form the dex lists for it. Derived from the
  // browse index that is already loaded — a forme switch must not cost a round trip.
  const baseName = entry?.isMega ? entry.baseSpecies : entry?.name;
  const formes = useMemo(() => {
    if (!baseName) return [];
    const base = dex.find((e) => e.name === baseName && !e.isMega);
    const megas = dex.filter((e) => e.isMega && e.baseSpecies === baseName);
    return megas.length && base ? [base, ...megas] : [];
  }, [dex, baseName]);
  const actionBox = actions ? <span className="mon-editor-actions">{actions}</span> : null;

  return (
    // Species and forme are one identity, so they sit on one row when both exist — a forme select
    // stacked underneath would push the card taller than its partner across the page.
    <div className={`mon-editor-namerow${formes.length ? " split" : ""}`}>
      <div className="mon-editor-namefield">
        <span className="mon-editor-label-line">
          <span>{t("calc.name")}</span>
          {!identityShown && (
            <span className="mon-editor-types">
              {(entry?.types ?? []).map((ty) => <TypeBadge key={ty} type={ty} />)}
            </span>
          )}
          {!formes.length && actionBox}
        </span>
        <MonPicker idKey={pickerKey} slug={slug} dex={dex} ariaLabel={t("calc.name")}
          onSlug={(next) => { if (next !== slug) onSpecies(next); }} />
      </div>
      {formes.length > 0 && (
        <div className="mon-editor-namefield">
          <span className="mon-editor-form-heading">
            {t("calc.forme")}
            {mega && !identityShown && <span className="mega-badge" title={displayName(mega, lang)}>MEGA</span>}
            {actionBox}
          </span>
          <select value={entry?.slug ?? ""} aria-label={t("calc.forme")}
            onChange={(e) => {
              const next = dex.find((x) => x.slug === e.target.value);
              // Dropping back to the base must also drop the stone, or the held item would silently
              // re-Mega it and the picker would disagree with the numbers.
              const dropStone = !!next && !next.isMega
                && items.some((i) => i.name === item && i.requiredBy?.length);
              onForme(e.target.value, dropStone);
            }}>
            {formes.map((f) => (
              <option key={f.slug} value={f.slug}>{displayName(f, lang)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

export function MonEditor({
  label, mon, setMon, dex, natures, items, format, onSetPick, onExport,
}: {
  label: string;
  mon: MonState;
  setMon: Dispatch<SetStateAction<MonState>>;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  onSetPick: (set: BuildOption, index: number) => void;
  onExport: () => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const literal = dex.find((e) => e.slug === mon.slug);
  const mega = literal?.isMega ? literal : megaFor(mon.slug, mon.item, dex, items);
  const entry = effectiveEntry(mon, dex, items);
  // The stone is what activates a Mega, so a base species holding one IS that Mega for every number
  // on the page. The forme control and the item lock therefore key off the EFFECTIVE form, not the
  // literal pick — otherwise the card computes Mega Garchomp Z while its own fields still read
  // "Garchomp / no forme / editable item", which is three claims the result contradicts.
  const requiredStone = mega
    ? items.find((i) => i.requiredBy?.includes(mega.name)) : undefined;

  // A Mega form picked BY NAME requires its stone — pin the item and lock the input.
  useEffect(() => {
    if (requiredStone && mon.item !== requiredStone.name) {
      setMon((s) => ({ ...s, item: requiredStone.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, mon.slug]);

  // The ability selector must describe the form the engine will calculate, so a stone swap or an
  // explicit Mega pick replaces an incompatible base ability immediately rather than relying on an
  // invisible request-time correction.
  useEffect(() => {
    if (mega && !mega.abilities.some((a) => a.name === mon.ability)) {
      setMon((s) => ({ ...s, ability: mega.abilities[0]?.name ?? "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mega?.slug, mon.item]);

  /** Which way this mon's nature bends a stat — "" when it does not touch it. */
  const nature = natures.find((n) => n.name === mon.nature);
  const natureTone = (key: string) =>
    (nature?.upStat === key && nature.downStat !== key ? "up"
      : nature?.downStat === key && nature.upStat !== key ? "down" : "");

  const [exported, setExported] = useState(false);
  const maxHP = maxHPOf(mon, dex, items);
  const curHP = curHPOf(mon, maxHP);
  const spTotal = spSum(mon.sps);
  const needsTrigger = !!mon.ability && ABILITY_NEEDS_TRIGGER.has(mon.ability);
  // The cards the button last loaded, mirrored here only so the build below can be recognised as
  // one of them; the popover itself owns its own loading.
  const [setOptions, setSetOptions] = useState<BuildOption[]>([]);
  const currentBuildSig = buildConfigSig(mon);
  const matchedSet = setOptions.find((option) => buildConfigSig(option.modal) === currentBuildSig);
  const matchedSetIndex = matchedSet ? setOptions.indexOf(matchedSet) : -1;
  const currentSetKey = matchedSet?.key;

  // A manually entered build can still be an exact environment card. Once the picker has loaded
  // enough facts to prove that identity, retain it for the compact hover cards; any later field edit
  // changes the signature and the display automatically falls back to "custom".
  useEffect(() => {
    if (!matchedSet) return;
    const buildRef = {
      key: matchedSet.key,
      source: matchedSet.source,
      coverage: matchedSet.coverage,
      isModal: matchedSet.isModal,
      labelIndex: Math.max(0, matchedSetIndex),
      signature: currentBuildSig,
    };
    setMon((current) => buildConfigSig(current) === currentBuildSig
      && (current.buildRef?.key !== buildRef.key
        || current.buildRef.source !== buildRef.source
        || current.buildRef.coverage !== buildRef.coverage
        || current.buildRef.isModal !== buildRef.isModal
        || current.buildRef.labelIndex !== buildRef.labelIndex
        || current.buildRef.signature !== buildRef.signature)
      ? { ...current, buildRef } : current);
  }, [currentBuildSig, matchedSet?.key, matchedSetIndex, setMon]);

  const editorActions = (
    <>
      <BuildPickerButton slug={mon.slug} format={format} currentKey={currentSetKey}
        onOptions={setSetOptions} onPick={onSetPick} />
      <button className="ghost-btn tiny" disabled={!mon.slug}
        onClick={() => {
          onExport();
          setExported(true);
          window.setTimeout(() => setExported(false), 1600);
        }}>
        {exported ? t("calc.copied") : t("calc.exportMon")}
      </button>
    </>
  );

  return (
    <div className="mon-editor">
      <div className="mon-id">
        <MonPortrait entry={entry} name={entry ? displayName(entry, lang) : ""} />
        <MonNameRow slug={mon.slug} item={mon.item} dex={dex} items={items} pickerKey={label}
          actions={editorActions} identityShown
          onSpecies={(slug) => setMon((s) => (s.slug === slug ? s : makeMon(slug)))}
          // A Mega picked here is stored as the Mega species; its stone is pinned by the effect
          // above, so the two controls can never disagree again.
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
          <select value={mon.nature}
            onChange={(e) => setMon((s) => ({ ...s, nature: e.target.value }))}>
            <option value="">—</option>
            {natures.map((n) => <option key={n.name} value={n.name}>{natureLabel(n, lang)}</option>)}
          </select>
        </label>
        <label>{t("calc.item")}
          <ItemCombo idKey={label} value={mon.item} items={items} disabled={!!requiredStone}
            onChange={(item) => setMon((s) => ({ ...s, item }))} />
        </label>
        <label>{t("calc.status")}
          <select value={mon.status}
            onChange={(e) => setMon((s) => ({ ...s, status: e.target.value }))}>
            {STATUSES.map((st) => (
              <option key={st} value={st === "Healthy" ? "" : st}>{t(`status.${st}`)}</option>
            ))}
          </select>
        </label>
      </div>

      {needsTrigger && (
        <label className="inline-check" title={t("calc.abilityOnHint")}>
          <input type="checkbox" checked={mon.abilityOn === true}
            onChange={(e) => setMon((s) => ({ ...s, abilityOn: e.target.checked ? true : null }))} />
          <span>{t("calc.abilityOn")}</span>
        </label>
      )}

      <div className="stat-table">
        <div className="stat-table-head">
          <span>{t("calc.stat")}</span>
          <span>{t("calc.base")}</span>
          <span className="stat-head-sp">SP
            <span className={`sp-sum num ${spSumClass(spTotal)}`}>{spTotal}/66</span>
          </span>
          <span>{t("calc.boosts")}</span>
          <span>{t("calc.final")}</span>
          <span>{t("calc.current")}</span>
        </div>
        {STAT_KEYS.map((key) => (
          <div className="stat-table-row" key={key}>
            <span className="stat-name">{key.toUpperCase()}</span>
            <span className="num muted">{entry?.stats[key] ?? "—"}</span>
            <input type="number" min={0} max={32} step={1} className="num"
              value={mon.sps[key] ?? 0} aria-label={`${key} SP`}
              onChange={(e) => setMon((s) => ({
                ...s, sps: { ...s.sps, [key]: clampNum(e.target.value, 0, 32) },
              }))} />
            {key === "hp"
              ? (() => {
                  // HP's "boost" cell holds the damage taken so far instead: current HP is a
                  // quantity of exactly this stat, so it belongs on this row rather than in a
                  // separate block that repeats the same maximum underneath.
                  const pct = maxHP > 0 ? Math.round((curHP / maxHP) * 100) : 0;
                  const tone = pct > 50 ? "ok" : pct > 20 ? "warn" : "low";
                  return (
                    <span className={`boost-slider hp ${tone}`}>
                      <span className="boost-lane">
                        <span className="boost-track" aria-hidden
                          style={{ ["--fill-left" as string]: "0%",
                                   ["--fill-width" as string]: `${pct}%` }} />
                        <input type="range" min={1} max={Math.max(1, maxHP)} step={1}
                          value={curHP} disabled={!maxHP} aria-label={t("calc.curHP")}
                          onChange={(e) => setMon((s) => ({ ...s, curHP: Number(e.target.value) }))} />
                      </span>
                      <span className="boost-read num">{pct}%</span>
                    </span>
                  );
                })()
              : (() => {
                  const stage = mon.boosts[key as "atk"] ?? 0;
                  const half = (Math.abs(stage) / 6) * 50;
                  return (
                    <span className={`boost-slider ${stage > 0 ? "up" : stage < 0 ? "down" : "flat"}`}>
                      <span className="boost-lane">
                        {/* Own track, filled from the CENTRE: the native one fills from the left,
                            so a neutral 0 looked like a drop. */}
                        <span className="boost-track" aria-hidden
                          style={{ ["--fill-left" as string]: stage < 0 ? `${50 - half}%` : "50%",
                                   ["--fill-width" as string]: `${half}%` }} />
                        <input type="range" min={-6} max={6} step={1} value={stage}
                          aria-label={`${key} boost`}
                          onChange={(e) => setMon((s) => ({
                            ...s, boosts: { ...s.boosts, [key]: Number(e.target.value) },
                          }))} />
                      </span>
                      <span className="boost-read num">{boostLabel(stage)}</span>
                    </span>
                  );
                })()}
            {/* The stat value is what the BUILD computes to, and it says why it is that number:
                which way the nature bent it, and whether the investment is already at the 32-point
                ceiling. HP's is the maximum — a plain fact about the build, like every other row. */}
            <span className={`num stat-final ${key === "hp" ? "" : natureTone(key)}`
              + ((mon.sps[key] ?? 0) >= 32 ? " maxed" : "")}>
              {(key === "hp" ? maxHP : finalStat(mon, entry, natures, key)) || "—"}
            </span>
            {/* The current value is what the mon is playing at RIGHT NOW: for HP a quantity that
                only the reader knows (so it is the one editable cell), for everything else the
                build's value put through its boost stage. Coloured by the STAGE, not the nature —
                this column answers "what did the battle do to it", which is a different question
                from the one the column beside it answers. */}
            {key === "hp"
              ? <input type="number" className="num stat-cur hp-cur"
                  min={1} max={Math.max(1, maxHP)} value={curHP} disabled={!maxHP}
                  aria-label={t("calc.curHP")} title={`${t("calc.curHP")} / ${maxHP}`}
                  onChange={(e) => setMon((s) => ({
                    ...s, curHP: clampNum(e.target.value, 1, Math.max(1, maxHP)),
                  }))} />
              : (() => {
                  const stage = mon.boosts[key as "atk"] ?? 0;
                  const value = finalStat(mon, entry, natures, key);
                  return (
                    <span className={`num stat-cur${stage > 0 ? " up" : stage < 0 ? " down" : ""}`}>
                      {value ? boostedStat(value, stage) : "—"}
                    </span>
                  );
                })()}
          </div>
        ))}
      </div>

    </div>
  );
}

/** Compact-card identity for a live calculator mon. Environment provenance is shown only while the
 * current item/ability/nature/SP/moves still match the applied card exactly. */
export function buildCardOptionForMon(
  mon: MonState, entry: DexIndexEntry, dex: DexIndexEntry[],
): BuildCardOption {
  const literal = dex.find((candidate) => candidate.slug === mon.slug);
  const signature = buildConfigSig(mon);
  const source = mon.buildRef?.signature === signature ? mon.buildRef : null;
  return {
    key: source?.key ?? `custom:${entry.slug}`,
    source: source?.source ?? "custom",
    coverage: source?.coverage ?? null,
    isModal: source?.isModal ?? false,
    labelIndex: source?.labelIndex,
    set: {
      species: literal?.isMega ? literal.baseSpecies ?? entry.name : literal?.name ?? entry.name,
      runForm: entry.name,
      ability: mon.ability || null,
      item: mon.item || null,
      nature: mon.nature || null,
      moves: [...mon.moves.filter(Boolean)],
      sps: { ...mon.sps },
    },
  };
}

/** Small read-only echo of a mon, used by the team strips. */
export function MonAvatar({ mon, dex, items, active, onClick, onRemove, title }: {
  mon: MonState;
  dex: DexIndexEntry[];
  items: ItemRef[];
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
  title?: string;
}) {
  const { lang } = useLang();
  const t = useT();
  const entry = effectiveEntry(mon, dex, items);
  const name = entry ? displayName(entry, lang) : t("calc.emptySlot");
  const hasBuild = !!entry && !!(mon.ability || mon.item || mon.nature
    || Object.values(mon.sps).some((value) => (value ?? 0) > 0) || mon.moves.some(Boolean));
  const preview = hasBuild && entry ? buildCardOptionForMon(mon, entry, dex) : null;
  const image = entry
    ? <GameImage assetKey={entry.key} role="dense" alt={name} className="mini" />
    : <img className="mini team-chip-empty" src={PLACEHOLDERS.pokemon} alt="" aria-hidden />;
  return (
    <span className={`team-chip${active ? " on" : ""}`}>
      <button type="button" className="team-chip-btn" onClick={onClick}
        aria-pressed={active} title={title ?? name}>
        {preview
          ? <EntityHover kind="spread" name="" link={false} passive
              previewAddon={<BuildSetSummary option={preview} index={0} />}>{image}</EntityHover>
          : image}
      </button>
      {onRemove && (
        <button type="button" className="team-chip-x" onClick={onRemove}
          aria-label={`${t("a11y.remove")} ${name}`}>✕</button>
      )}
    </span>
  );
}
