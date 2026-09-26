/** The two editable combatants of the durability workbench. They wear the damage calculator's
 * name row, build row and move cells on purpose — the same mon should look like the same form on
 * both tabs — and differ only in between: our side edits the bulk spread, theirs its offence. */
import type { FormatId, LearnsetDto, NatureDto } from "@pokemon-champions/protocol";
import { memo, useCallback, useEffect, useMemo } from "react";
import { displayName, useLang, useT, type MsgKey } from "../../../i18n.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import {
  BOOST_STAGES, BuildPickerButton, ItemCombo, STATUSES, boostLabel, clampNum, megaFor,
  natureLabel, spSum, spSumClass, type BuildOption,
} from "../shared.tsx";
import { MonNameRow, MonPortrait } from "../duel/MonEditor.tsx";
import { MoveCell } from "../duel/MoveCell.tsx";
import { boostedStat, effectiveEntry, finalStat, type MonState } from "../duel/state.ts";
import { attackIndex, pressedStat, type Baseline, type BulkStat, type Rolls } from "./model.ts";

type MonUpdate = (update: (mon: MonState) => MonState) => void;

const BULK_STATS: BulkStat[] = ["hp", "def", "spd"];
const OTHER_STATS = ["atk", "spa", "spe"] as const;
const STAT_LABEL: Record<string, MsgKey> = {
  hp: "stat.hp", atk: "stat.atk", def: "stat.def", spa: "stat.spa", spd: "stat.spd", spe: "stat.spe",
};

/** A Mega picked by name owns its stone, and a stone-activated Mega owns its ability list: keep the
 * visible fields equal to what the engine will calculate (the calculator's editor does the same). */
function useMegaConsistency(slug: string, item: string, ability: string, dex: DexIndexEntry[],
  items: ItemRef[], onChange: MonUpdate) {
  const literal = dex.find((entry) => entry.slug === slug);
  const mega = literal?.isMega ? literal : megaFor(slug, item, dex, items);
  const requiredStone = mega ? items.find((candidate) => candidate.requiredBy?.includes(mega.name)) : undefined;
  useEffect(() => {
    if (requiredStone && item !== requiredStone.name) {
      onChange((current) => ({ ...current, item: requiredStone.name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requiredStone?.name, slug]);
  useEffect(() => {
    if (mega && !mega.abilities.some((candidate) => candidate.name === ability)) {
      onChange((current) => ({ ...current, ability: mega.abilities[0]?.name ?? "" }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mega?.slug, item]);
  return { literal, mega, requiredStone };
}

/** Species, build card and the ability / nature / item / status row. Takes primitives rather than
 * the member so a slider tick - which only moves SP - never re-renders the pickers, whose desktop
 * datalists carry every species and item in the game. */
const Identity = memo(function Identity({ slug, ability, nature, item, status, dex, natures, items, format,
  idKey, restore, onSpecies, onChange, onPickBuild }: {
  slug: string;
  ability: string;
  nature: string;
  item: string;
  /** Both sides carry one: Burn and Paralysis change what an attacker hits for, and a defender's
   * status is what Marvel Scale, Hex, Venoshock or Wake-Up Slap read. */
  status: string;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  idKey: string;
  /** Our card's revert control; `enabled` is false while the spread still equals its baseline. */
  restore?: { enabled: boolean; onRestore: () => void };
  onSpecies: (slug: string) => void;
  onChange: MonUpdate;
  onPickBuild: (option: BuildOption) => void;
}) {
  const t = useT();
  const { lang } = useLang();
  const { literal, mega, requiredStone } = useMegaConsistency(slug, item, ability, dex, items, onChange);
  const entry = mega ?? literal;
  const actions = (
    <>
      <BuildPickerButton slug={slug} format={format} onPick={onPickBuild} />
      {restore && (
        <button type="button" className="ghost-btn tiny" disabled={!restore.enabled}
          onClick={restore.onRestore} title={t("tune.ws.restoreHint")}>
          {t("tune.ws.restore")}
        </button>
      )}
    </>
  );
  return (
    <>
      <div className="mon-id">
        <MonPortrait entry={entry} name={entry ? displayName(entry, lang) : ""} />
        <MonNameRow slug={slug} item={item} dex={dex} items={items} pickerKey={idKey} actions={actions}
          onSpecies={onSpecies}
          onForme={(next, dropStone) => onChange((current) => ({
            ...current, slug: next, ...(dropStone ? { item: "" } : {}) }))} />
      </div>
      <div className="mon-build-row">
        <label>{t("calc.ability")}
          <select value={ability}
            onChange={(event) => onChange((current) => ({ ...current, ability: event.target.value }))}>
            <option value="">—</option>
            {entry?.abilities.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>{displayName(candidate, lang)}</option>
            ))}
          </select>
        </label>
        <label>{t("calc.nature")}
          <select value={nature}
            onChange={(event) => onChange((current) => ({ ...current, nature: event.target.value }))}>
            <option value="">—</option>
            {natures.map((candidate) => (
              <option key={candidate.name} value={candidate.name}>{natureLabel(candidate, lang)}</option>
            ))}
          </select>
        </label>
        <label>{t("calc.item")}
          <ItemCombo idKey={idKey} value={item} items={items} disabled={!!requiredStone}
            onChange={(next) => onChange((current) => ({ ...current, item: next }))} />
        </label>
        <label>{t("calc.status")}
          <select value={status}
            onChange={(event) => onChange((current) => ({ ...current, status: event.target.value }))}>
            {STATUSES.map((candidate) => (
              <option key={candidate} value={candidate === "Healthy" ? "" : candidate}>
                {t(`status.${candidate}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </>
  );
});

type StageKey = "atk" | "def" | "spa" | "spd" | "spe";

/** A stat stage, as narrow as -6..+6 allows. Coloured by direction so a raised or lowered stat is
 * visible without reading the number. */
export function StageSelect({ value, label, onChange }: {
  value: number;
  label: string;
  onChange: (stage: number) => void;
}) {
  return (
    <select className={`tw-stage-sel num${value > 0 ? " up" : value < 0 ? " down" : ""}`} value={value}
      aria-label={label} title={label} onChange={(event) => onChange(Number(event.target.value))}>
      {BOOST_STAGES.map((stage) => <option key={stage} value={stage}>{boostLabel(stage)}</option>)}
    </select>
  );
}

export function SpSlider({ label, value, baseline, mini = false, onChange }: {
  label: string;
  value: number;
  /** Where the loaded spread sat; drawn as a tick once the slider has left it. */
  baseline?: number;
  mini?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <span className={`tw-sp-slider${mini ? " mini" : ""}`}
      style={{ ["--fill" as string]: value / 32, ["--base" as string]: (baseline ?? 0) / 32 }}>
      <span className="tw-sp-track" aria-hidden />
      {baseline !== undefined && baseline !== value && <span className="tw-sp-base" aria-hidden />}
      <input type="range" min={0} max={32} step={1} value={value} aria-label={`${label} SP`}
        onChange={(event) => onChange(clampNum(event.target.value, 0, 32))} />
    </span>
  );
}

/** One compact stat: name, SP box, short slider and an unlabelled stage select. Used for the stats
 * that are not the bulk axis — our Atk/SpA/Spe (Foul Play reads our Attack, Gyro Ball our Speed) and
 * the attacker's Atk/SpA. */
function StatStrip({ label, value, stage, onValue, onStage, stageLabel }: {
  label: string;
  value: number;
  stage: number;
  onValue: (value: number) => void;
  onStage: (stage: number) => void;
  stageLabel: string;
}) {
  return (
    <div className="tw-stat-strip">
      <span>{label}</span>
      <input type="number" min={0} max={32} className="num tw-sp-input" value={value}
        aria-label={`${label} SP`} onChange={(event) => onValue(clampNum(event.target.value, 0, 32))} />
      <SpSlider label={label} value={value} mini onChange={onValue} />
      <StageSelect value={stage} label={stageLabel} onChange={onStage} />
    </div>
  );
}

/** Our side: the spread being tuned. HP / Def / SpD get full-width sliders because they are the axis
 * this tool exists for; the other three get short ones, since they only matter as the 66-point budget
 * that bulk has to come out of. */
export const DefenderCard = memo(function DefenderCard({ mon, baseline, dex, natures, items, format,
  pressed, onSpecies, onChange, onPickBuild, onRestore }: {
  mon: MonState;
  /** The spread this mon arrived with: the slider marks and the final-value deltas read against it. */
  baseline: Baseline;
  /** The defence the selected incoming move presses on; its bulk index is the one to read against
   * the attacker's index (a Psyshock pairs SpA with our PHYSICAL bulk). */
  pressed: "def" | "spd" | null;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  onSpecies: (slug: string) => void;
  onChange: MonUpdate;
  onPickBuild: (option: BuildOption) => void;
  onRestore: () => void;
}) {
  const t = useT();
  const entry = effectiveEntry(mon, dex, items);
  const total = spSum(mon.sps);
  const nature = natures.find((candidate) => candidate.name === mon.nature);
  const natureTone = (key: string) =>
    nature?.upStat === key && nature.downStat !== key ? "up"
      : nature?.downStat === key && nature.upStat !== key ? "down" : "";
  const baselineMon: MonState = { ...mon, sps: baseline.sps, nature: baseline.nature };
  const changed = baseline.nature !== mon.nature
    || (["hp", "atk", "def", "spa", "spd", "spe"] as const).some((key) =>
      (baseline.sps[key] ?? 0) !== (mon.sps[key] ?? 0));
  const restoreOn = useMemo(() => ({ enabled: true, onRestore }), [onRestore]);
  const restoreOff = useMemo(() => ({ enabled: false, onRestore }), [onRestore]);
  const setSp = (key: string, value: number) =>
    onChange((current) => ({ ...current, sps: { ...current.sps, [key]: value } }));
  const setStage = (key: StageKey, stage: number) =>
    onChange((current) => ({ ...current, boosts: { ...current.boosts, [key]: stage } }));
  const stat = (key: BulkStat) => finalStat(mon, entry, natures, key);
  // Same scale as the attacker's index, so it uses the stat the calc uses: stage applied.
  const staged = (key: "def" | "spd") => boostedStat(stat(key), mon.boosts[key] ?? 0);
  const physBulk = entry ? stat("hp") * staged("def") : 0;
  const specBulk = entry ? stat("hp") * staged("spd") : 0;

  return (
    <section className="panel mon-editor tw-mon tw-mine" aria-label={t("speed.ours")}>
      <Identity slug={mon.slug} ability={mon.ability} nature={mon.nature} item={mon.item}
        status={mon.status} dex={dex} natures={natures} items={items} format={format}
        idKey="tune-mine" onSpecies={onSpecies} onChange={onChange} onPickBuild={onPickBuild}
        restore={changed ? restoreOn : restoreOff} />

      <div className="tw-sp">
        <div className="tw-sp-head">
          <span className="tw-sp-title">{t("tune.ws.bulkSp")}</span>
          <span className="tw-sp-total">{t("tune.ws.spTotal")}
            <b className={`sp-sum num ${spSumClass(total)}`}>{total}/66</b>
          </span>
          {entry && (
            <span className="tw-bulk" title={t("tune.ws.bulkHint")}>
              <span className={pressed === "def" ? "on" : ""}>
                {t("tune.ws.physBulk")} <b className="num">{physBulk.toLocaleString()}</b>
              </span>
              <span className={pressed === "spd" ? "on" : ""}>
                {t("tune.ws.specBulk")} <b className="num">{specBulk.toLocaleString()}</b>
              </span>
            </span>
          )}
        </div>
        {BULK_STATS.map((key) => {
          const current = mon.sps[key] ?? 0;
          const mark = baseline.sps[key] ?? 0;
          const value = stat(key);
          const stage = key === "hp" ? 0 : mon.boosts[key] ?? 0;
          const shown = key === "hp" || !value ? value : boostedStat(value, stage);
          const delta = entry ? value - finalStat(baselineMon, entry, natures, key) : 0;
          const label = t(STAT_LABEL[key]!);
          // The value is what the calc uses: the build's stat put through its stage. A stage paints it
          // as a chip in the direction it moved; without one, the nature's direction colours the text.
          const tone = stage > 0 ? "boost-up" : stage < 0 ? "boost-down" : key === "hp" ? "" : natureTone(key);
          return (
            <div className="tw-sp-row" key={key}>
              <span className="tw-sp-name">{label}</span>
              <input type="number" min={0} max={32} className="num tw-sp-input" value={current}
                aria-label={`${label} SP`} onChange={(event) => setSp(key, clampNum(event.target.value, 0, 32))} />
              <SpSlider label={label} value={current} baseline={mark} onChange={(next) => setSp(key, next)} />
              {key === "hp" ? <span aria-hidden /> : (
                <StageSelect value={stage} label={`${label} ${t("calc.boosts")}`}
                  onChange={(next) => setStage(key, next)} />
              )}
              <span className="num tw-sp-final">
                <b className={tone}>{shown || "—"}</b>
                <small className={delta > 0 ? "up" : delta < 0 ? "down" : ""}>
                  {delta > 0 ? `+${delta}` : delta < 0 ? delta : ""}
                </small>
              </span>
            </div>
          );
        })}
        {/* Our other three stats: they only matter as the budget bulk comes out of — and to the few
            moves that read them off the target (Foul Play, Gyro Ball). */}
        <div className="tw-sp-rest">
          {OTHER_STATS.map((key) => {
            const label = t(STAT_LABEL[key]!);
            return (
              <StatStrip key={key} label={label} value={mon.sps[key] ?? 0} stage={mon.boosts[key] ?? 0}
                stageLabel={`${label} ${t("calc.boosts")}`}
                onValue={(next) => setSp(key, next)} onStage={(next) => setStage(key, next)} />
            );
          })}
        </div>
      </div>
    </section>
  );
});

export interface MoveReading {
  rolls: Rolls | null;
  /** The shown numbers belong to an earlier input while the current one is being computed. */
  pending: boolean;
}

/** Their side: the attacker's set and the four moves. Picking a move is what the verdict below reads,
 * so each move carries its own damage range and the whole cell is the selection target. */
export const AttackerCard = memo(function AttackerCard({ mon, dex, natures, items, format, learnset,
  cells, selectedSlot, onSelectSlot, onSpecies, onChange, onPickBuild }: {
  mon: MonState;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  format: FormatId;
  learnset: LearnsetDto | null;
  cells: MoveReading[];
  selectedSlot: number;
  onSelectSlot: (slot: number) => void;
  onSpecies: (slug: string) => void;
  onChange: MonUpdate;
  onPickBuild: (option: BuildOption) => void;
}) {
  const t = useT();
  const setMove = useCallback((slot: number, name: string) => onChange((current) => {
    const moves = [...current.moves];
    while (moves.length < 4) moves.push("");
    moves[slot] = name;
    return { ...current, moves };
  }), [onChange]);
  const categoryOf = (name: string) => learnset?.moves.find((move) => move.name === name)?.category;
  const { lang } = useLang();
  const entry = effectiveEntry(mon, dex, items);
  // The attacker's counterpart of our bulk indices, for the move the verdict is reading: it follows
  // the selection, and fills the slot of that move's category.
  const selected = learnset?.moves.find((move) => move.name === (mon.moves[selectedSlot] ?? ""));
  const selectedIndex = (() => {
    if (!entry || !selected || (selected.category !== "Physical" && selected.category !== "Special")) return null;
    const key = selected.category === "Physical" ? "atk" : "spa";
    const stat = boostedStat(finalStat(mon, entry, natures, key), mon.boosts[key] ?? 0);
    return attackIndex(stat, selected, entry.types, mon.item, mon.status === "Burned");
  })();
  const indices = (["Physical", "Special"] as const).map((category) => ({
    category,
    label: t(category === "Physical" ? "tune.ws.atkIndex" : "tune.ws.spaIndex"),
    value: selected?.category === category ? selectedIndex : null,
  }));

  return (
    <section className="panel mon-editor tw-mon tw-foe" aria-label={t("speed.theirs")}>
      <Identity slug={mon.slug} ability={mon.ability} nature={mon.nature} item={mon.item}
        status={mon.status} dex={dex} natures={natures} items={items} format={format}
        idKey="tune-foe" onSpecies={onSpecies} onChange={onChange}
        onPickBuild={onPickBuild} />

      <div className="tw-offense">
        {(["atk", "spa"] as const).map((key) => {
          const label = t(STAT_LABEL[key]!);
          return (
            <StatStrip key={key} label={label} value={mon.sps[key] ?? 0} stage={mon.boosts[key] ?? 0}
              stageLabel={`${label} ${t("calc.boosts")}`}
              onValue={(next) => onChange((current) => ({ ...current, sps: { ...current.sps, [key]: next } }))}
              onStage={(next) => onChange((current) => ({ ...current,
                boosts: { ...current.boosts, [key]: next } }))} />
          );
        })}
      </div>

      <div className="tw-moves">
        <div className="tw-moves-head">
          <span className="mon-editor-cap">{t("calc.moveSlots")}
            <span className="tw-moves-hint">{t("tune.ws.movesHint")}</span>
          </span>
          {entry && (
            <span className="tw-bulk">
              {indices.map(({ category, label, value }) => (
                <span key={category} className={value !== null ? "on" : ""}
                  title={value !== null && selected
                    ? `${t("tune.ws.atkIndexHint")}\n${t("tune.ws.indexMove").replace("{move}", displayName(selected, lang))}`
                    : t("tune.ws.atkIndexHint")}>
                  {label} <b className="num">{value !== null ? value.toLocaleString() : "—"}</b>
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="tw-move-grid">
          {Array.from({ length: 4 }, (_, slot) => {
            const name = mon.moves[slot] ?? "";
            const cell = cells[slot];
            const category = categoryOf(name);
            const status = !!name && category !== undefined && pressedStat(name, category) === null;
            return (
              <MoveCell key={slot} index={slot} value={name} learnset={learnset}
                selected={slot === selectedSlot} pending={cell?.pending} onSelect={onSelectSlot}
                onChange={setMove}>
                {status ? <span className="muted">{t("tune.ws.statusMove")}</span>
                  : cell?.rolls ? `${cell.rolls.minPercent.toFixed(1)} – ${cell.rolls.maxPercent.toFixed(1)}%`
                    : name ? "…" : null}
              </MoveCell>
            );
          })}
        </div>
      </div>
    </section>
  );
});
