/** Set inference (配置反推): read the opponent's build back from damage actually seen in a battle.
 *
 * The shared roster and battle frame stay above the tools. The result and observation inputs sit
 * together; environment references and writes back to the shared calculator sit below them.
 *
 * Their builds are the unknown, ours are known: every recorded hit belongs to the opponent it was
 * dealt to or by, keyed on its uid, so switching our Pokémon keeps everything learned about theirs.
 * The rosters and the frame are the calc page's shared roster; the records are this tool's own. */
import type { LearnsetDto, NatureDto } from "@pokemon-champions/protocol";
import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type { CalcRailApi, CalcRailTarget } from "../../components/CalcRail.tsx";
import { useAbilitiesByName, useAsync, useMovesByName } from "../../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../../i18n.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { loadLearnset, type ItemRef } from "../../runtime/projection.ts";
import { buildConfigSig, type BuildOption } from "../../components/build/inputs.tsx";
import { FieldPanel, useFieldOffers } from "./duel/FieldPanel.tsx";
import { monsFromPaste } from "./duel/paste.ts";
import { MonEditor } from "./duel/MonEditor.tsx";
import { DuelBar, TeamBar, TEAM_MAX, type ImportOutcome } from "./duel/TeamBar.tsx";
import {
  MOVE_SLOTS, applyBuildOption, effectiveEntry, makeMon, maxHPOf, natureMult, updateRosterMon, withoutMember, type MonState,
  type SideId,
  type SharedFlagKey,
} from "./duel/state.ts";
import { useRoster } from "./roster.tsx";
import { fixedItem, isPowerItem, type KnownFacts, type Observation } from "./infer/context.ts";
import { FoeCard } from "./infer/FoeCard.tsx";
import { ObservationLog } from "./infer/ObservationLog.tsx";
import { InferPanel, type Labels } from "./infer/InferPanel.tsx";
import { ReferencePanel } from "./infer/ReferencePanel.tsx";
import { useInferT } from "./infer/messages.ts";
import { MoveSection, useFrameText } from "./infer/MoveSection.tsx";
import { loadInferRecords, saveInferRecords, type InferRecords } from "./infer/persist.ts";
import { useInference } from "./infer/useInference.ts";
import { readSpeedProjection, speedPlan } from "./infer/speed.ts";
import "../../styles.infer.css";

/** The inference forces switch-in drops off (a recorded hit states its own stages), so the console
 * offers only the field-wide switches its numbers read. */
const INFER_SHARED: SharedFlagKey[] = ["gravity", "foresight"];
const STAT_LABEL: Record<string, MsgKey> = {
  hp: "stat.hp", atk: "stat.atk", def: "stat.def", spa: "stat.spa", spd: "stat.spd", spe: "stat.spe",
};

let observationSerial = 0;
const newObservationId = () => `o-${Date.now().toString(36)}-${(++observationSerial).toString(36)}`;

export function InferTab({ dex, natures, items, onRailApi, visible }: {
  visible: boolean;
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  onRailApi?: (api: CalcRailApi) => void;
}) {
  const { adapter } = useRuntime();
  const t = useT();
  const ti = useInferT();
  const { lang } = useLang();
  const moveVocab = useMovesByName();
  const abilityVocab = useAbilitiesByName();
  const { teams, setTeams, active, setActive, field, setField } = useRoster();
  const kit = useMemo(() => ({ dex, items, natures }), [dex, items, natures]);

  const mine = teams.a[Math.min(active.a, teams.a.length - 1)] ?? makeMon();
  const foe = teams.b[Math.min(active.b, teams.b.length - 1)] ?? makeMon();
  const mineEntry = effectiveEntry(mine, dex, items);
  const foeEntry = effectiveEntry(foe, dex, items);

  // -- records (this tool's own) -------------------------------------------------------------
  const [records, setRecords] = useState<InferRecords>(() => loadInferRecords());
  useEffect(() => { saveInferRecords(records); }, [records]);
  // A record names its opponent by uid; one whose Pokémon left both rosters retires with it.
  useEffect(() => {
    const live = new Set([...teams.a, ...teams.b].map((mon) => mon.uid));
    setRecords((previous) => {
      const kept = Object.fromEntries(Object.entries(previous).filter(([uid]) => live.has(uid)));
      return Object.keys(kept).length === Object.keys(previous).length ? previous : kept;
    });
  }, [teams]);
  const record = records[foe.uid];
  const observations = useMemo(() => record?.observations ?? [], [record]);

  const updateRecord = useCallback((uid: string, update: (current: NonNullable<InferRecords[string]>) =>
    NonNullable<InferRecords[string]>) => {
    setRecords((previous) => ({ ...previous,
      [uid]: update(previous[uid] ?? { observations: [], known: {} }) }));
  }, []);
  const addObservation = useCallback((observation: Omit<Observation, "id">) =>
    updateRecord(observation.foeId, (current) => ({
      ...current, observations: [...current.observations, { ...observation, id: newObservationId() }],
    })), [updateRecord]);
  const toggleObservation = useCallback((id: string) => updateRecord(foe.uid, (current) => ({
    ...current, observations: current.observations.map((observation) =>
      observation.id === id ? { ...observation, enabled: !observation.enabled } : observation),
  })), [updateRecord, foe.uid]);
  const removeObservation = useCallback((id: string) => updateRecord(foe.uid, (current) => ({
    ...current, observations: current.observations.filter((observation) => observation.id !== id),
  })), [updateRecord, foe.uid]);

  // -- roster edits --------------------------------------------------------------------------
  const updateMon = useCallback((uid: string, update: (mon: MonState) => MonState) => {
    setTeams((previous) => updateRosterMon(previous, uid, update));
  }, [setTeams]);
  /** A stable setter per roster uid, for the card editors (their reconciliation effects depend on
   * it); a proven no-op keeps the roster's identity. */
  const setMonOf = useMemo(() => {
    const cache = new Map<string, Dispatch<SetStateAction<MonState>>>();
    return (uid: string) => {
      let setter = cache.get(uid);
      if (!setter) {
        setter = (update) => setTeams((previous) => updateRosterMon(previous, uid, update));
        cache.set(uid, setter);
      }
      return setter;
    };
  }, [setTeams]);
  // A confirmed item or ability is a fact about their Pokémon, so it also goes onto the shared roster.
  const setKnown = useCallback((known: KnownFacts) => {
    updateRecord(foe.uid, (current) => ({
      ...current, known: {
        ...(known.item ? { item: known.item } : {}), ...(known.ability ? { ability: known.ability } : {}),
      },
    }));
    if (known.item || known.ability) {
      updateMon(foe.uid, (mon) => ({ ...mon, ...(known.item ? { item: known.item } : {}),
        ...(known.ability ? { ability: known.ability } : {}) }));
    }
  }, [updateRecord, updateMon, foe.uid]);

  const setMoveOf = useCallback((uid: string) => (slot: number, name: string) => updateMon(uid, (mon) => {
    const moves = [...mon.moves];
    while (moves.length < MOVE_SLOTS) moves.push("");
    if (moves[slot] === name) return mon;
    moves[slot] = name;
    return { ...mon, moves };
  }), [updateMon]);
  /** Back to custom: every field the adopted build filled goes blank again — nature, SP, moves, and
   * the item and ability unless confirmed (a Mega keeps its stone). Pinned, so the environment
   * auto-fill does not simply adopt the first card again. */
  const unadopt = useCallback(() => updateMon(foe.uid, (mon) => {
    const known = records[mon.uid]?.known ?? {};
    return {
      ...mon, nature: "", sps: {}, moves: ["", "", "", ""],
      item: fixedItem(mon, kit) ?? known.item ?? "", ability: known.ability ?? "",
      buildRef: null, autoSig: null, pinned: true,
    };
  }), [updateMon, foe.uid, records, kit]);

  const applySet = useCallback((option: BuildOption) =>
    updateMon(foe.uid, (mon) => ({ ...applyBuildOption(mon, option), pinned: true, autoSig: null })),
  [updateMon, foe.uid]);

  const importPaste = async (side: SideId, text: string): Promise<ImportOutcome> => {
    const { mons, outcome } = await monsFromPaste(text, { dex, items, natures, adapter });
    if (!mons.length) return outcome;
    setTeams((previous) => ({ ...previous, [side]: mons }));
    setActive((previous) => ({ ...previous, [side]: 0 }));
    return outcome;
  };
  const addMember = (side: SideId) => {
    if (teams[side].length >= TEAM_MAX) return;
    setTeams((previous) => previous[side].length >= TEAM_MAX ? previous
      : { ...previous, [side]: [...previous[side], makeMon()] });
    setActive((previous) => ({ ...previous, [side]: teams[side].length }));
  };
  const removeMember = (side: SideId, index: number) => {
    setTeams((previous) => ({ ...previous, [side]: withoutMember(previous[side], index) }));
    setActive((previous) => ({ ...previous, [side]: Math.max(0, Math.min(previous[side], teams[side].length - 2)) }));
  };
  const resetSide = (side: SideId) => {
    setTeams((previous) => ({ ...previous, [side]: [makeMon()] }));
    setActive((previous) => ({ ...previous, [side]: 0 }));
  };

  const pickFromRail = useCallback((target: CalcRailTarget, entry: DexIndexEntry,
                                    option: BuildOption | null) => {
    const side: SideId = target === "primary" ? "a" : "b";
    const team = teams[side];
    const empty = team.findIndex((candidate) => !candidate.slug);
    if (empty < 0 && team.length >= TEAM_MAX) return { ok: false as const, reason: "full" as const };
    const base = { ...makeMon(entry.slug), pinned: true };
    const mon = option ? applyBuildOption(base, option) : base;
    const index = empty >= 0 ? empty : team.length;
    setTeams((previous) => ({ ...previous, [side]: empty >= 0
      ? previous[side].map((candidate, at) => at === empty ? mon : candidate)
      : [...previous[side], mon] }));
    setActive((previous) => ({ ...previous, [side]: index }));
    return { ok: true as const };
  }, [teams, setTeams, setActive]);
  const railApi = useMemo<CalcRailApi>(() => ({
    format: field.format,
    targets: [
      { id: "primary", label: t("speed.ours") },
      { id: "secondary", label: t("speed.theirs") },
    ],
    pick: pickFromRail,
  }), [field.format, pickFromRail, lang]);
  useEffect(() => { onRailApi?.(railApi); }, [onRailApi, railApi]);

  // -- inference -------------------------------------------------------------------------------
  const view = useInference({
    active: visible, adapter, kit, moves: moveVocab, foe, mine, mineTeam: teams.a, observations,
    known: record?.known, field,
  });
  const speedInference = view.inference ?? view.prior;
  const speedRequests = useMemo(() => visible && !view.loading && !view.error && view.info && speedInference
    ? speedPlan(view.info.space, speedInference, mine, foe, field, dex, items, natures) : null,
  [visible, view.loading, view.error, view.info, speedInference, mine, foe, field, dex, items, natures]);
  const speedSignature = JSON.stringify(speedRequests);
  const speedView = useAsync(() => speedRequests ? readSpeedProjection(adapter, speedRequests) : Promise.resolve(null),
    [adapter, speedSignature]);

  const learnsetMine = useAsync<LearnsetDto | null>(
    () => (mine.slug ? loadLearnset(mine.slug) : Promise.resolve(null)), [mine.slug]);
  const learnsetFoe = useAsync<LearnsetDto | null>(
    () => (foe.slug ? loadLearnset(foe.slug) : Promise.resolve(null)), [foe.slug]);

  // The selected move on each card: tool-local, falling back to the first readable one.
  const [pick, setPick] = useState<{ into: number; from: number }>({ into: 0, from: 0 });
  const firstReadable = (readings: typeof view.into, at: number) => {
    if (readings[at]?.key && !readings[at]?.reason) return at;
    const first = readings.findIndex((reading) => reading.key && !reading.reason);
    return first >= 0 ? first : at;
  };
  const intoSlot = firstReadable(view.into, pick.into);
  const fromSlot = firstReadable(view.from, pick.from);

  const ourMax = maxHPOf(mine, dex, items);
  const nameOfUid = useCallback((uid: string) => {
    const mon = [...teams.a, ...teams.b].find((candidate) => candidate.uid === uid);
    const entry = mon ? effectiveEntry(mon, dex, items) : undefined;
    return entry ? displayName(entry, lang) : "—";
  }, [teams, dex, items, lang]);
  const labels = useMemo<Labels>(() => ({
    mon: nameOfUid,
    move: (name) => { const ref = moveVocab.get(name); return ref ? displayName(ref, lang) : name; },
    item: (name) => { const ref = items.find((item) => item.name === name); return ref ? displayName(ref, lang) : name; },
    ability: (name) => { const ref = abilityVocab.get(name); return ref ? displayName(ref, lang) : name; },
    nature: (name) => { const ref = natures.find((nature) => nature.name === name); return ref ? displayName(ref, lang) : name; },
    stat: (key) => t(STAT_LABEL[key]!),
    multOf: (nature, key) => natureMult(natures, nature, key),
    powerItem: (name) => isPowerItem(name, kit),
  }), [nameOfUid, moveVocab, items, abilityVocab, natures, lang, kit]);

  const offers = useFieldOffers();
  const ready = !!mineEntry && !!foeEntry;
  const frameOf = useFrameText(labels.stat);
  // The environment card their build still is exactly, if any (an edit since makes it custom).
  const adoptedKey = foe.buildRef && foe.buildRef.signature === buildConfigSig(foe) ? foe.buildRef.key : null;

  return (
    <div className="inf">
      {view.error && <div className="notice mono">{t("calc.error")}</div>}
      <DuelBar field={field}>
        <TeamBar label={t("calc.attacker")} teamLabel={t("calc.attackerTeam")} team={teams.a} librarySide="a"
          index={active.a} onIndex={(index) => setActive((previous) => ({ ...previous, a: index }))}
          onAdd={() => addMember("a")} onRemove={(index) => removeMember("a", index)}
          onReset={() => resetSide("a")} field={field} setField={setField} side="a"
          dex={dex} items={items} onImport={(text) => importPaste("a", text)} />
        <FieldPanel field={field} setField={setField} sharedFlags={INFER_SHARED}
          weatherSuggestions={offers.weather} terrainSuggestions={offers.terrain} />
        <TeamBar label={t("calc.defender")} teamLabel={t("calc.defenderTeam")} team={teams.b} librarySide="b"
          index={active.b} onIndex={(index) => setActive((previous) => ({ ...previous, b: index }))}
          onAdd={() => addMember("b")} onRemove={(index) => removeMember("b", index)}
          onReset={() => resetSide("b")} field={field} setField={setField} side="b"
          dex={dex} items={items} onImport={(text) => importPaste("b", text)} mirrored />
      </DuelBar>

      <div className="inf-workspace">
        {ready ? <InferPanel foeName={displayName(foeEntry!, lang)} view={view} speedView={speedView}
          observations={observations} labels={labels} /> : (
          <section className="panel inf-panel" aria-label={ti("infer.result.title")}>
            <header className="inf-panel-head"><h2>{ti("infer.result.title")}</h2></header>
            <p className="inf-empty muted">{ti("infer.result.choose")}</p>
          </section>
        )}
        <div className="inf-inputs">
          <FoeCard foe={foe} setFoe={setMonOf(foe.uid)} dex={dex} items={items}
            info={view.info} known={record?.known ?? {}} onKnown={setKnown} />
          <details className="panel inf-mine-config">
            <summary>{ti("infer.mine.config")}
              <span className="muted">{mineEntry ? displayName(mineEntry, lang) : "—"}
                {mine.ability ? ` · ${labels.ability(mine.ability)}` : ""}
                {mine.nature ? ` · ${labels.nature(mine.nature)}` : ""}
                {mine.item ? ` · ${labels.item(mine.item)}` : ""}</span>
            </summary>
            <MonEditor label="infer-mine" mon={mine} setMon={setMonOf(mine.uid)} dex={dex} natures={natures}
              items={items} format={field.format} keep={false}
              onSetPick={(option, index) => setMonOf(mine.uid)((current) => applyBuildOption(current, option, index))} />
          </details>
          <ObservationLog foeName={foeEntry ? displayName(foeEntry, lang) : "—"} observations={observations}
            view={view} monName={labels.mon} moveName={labels.move} frameOf={frameOf}
            onToggle={toggleObservation} onRemove={removeObservation} />
          <section className="panel inf-direction mine" aria-label={t("speed.ours")}>
            <MoveSection kind="bulk" attacker={mine}
              entries={{ attacker: mineEntry, defender: foeEntry }} readings={view.into}
              learnset={learnsetMine.status === "ready" ? learnsetMine.data : null}
              selected={intoSlot} onSelect={(slot) => setPick((previous) =>
                previous.into === slot ? previous : { ...previous, into: slot })}
              onMove={setMoveOf(mine.uid)} mine={mine} foe={foe} field={field} ourMax={ourMax}
              onAdd={addObservation} />
          </section>
          <section className="panel inf-direction foe" aria-label={t("speed.theirs")}>
            <MoveSection kind="offense" attacker={foe}
              entries={{ attacker: foeEntry, defender: mineEntry }} readings={view.from}
              learnset={learnsetFoe.status === "ready" ? learnsetFoe.data : null}
              selected={fromSlot} onSelect={(slot) => setPick((previous) =>
                previous.from === slot ? previous : { ...previous, from: slot })}
              onMove={setMoveOf(foe.uid)} mine={mine} foe={foe} field={field} ourMax={ourMax}
              onAdd={addObservation} />
          </section>
        </div>
      </div>

      {ready && (
        <ReferencePanel foe={foe} dex={dex} items={items} natures={natures} format={field.format}
          view={view} observations={observations}
          adoptedKey={adoptedKey} onApply={applySet} onUnadopt={unadopt} labels={labels} />
      )}
    </div>
  );
}
