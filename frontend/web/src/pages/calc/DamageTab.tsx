/** Damage workspace: two teams, side by side, both directions live.
 *
 * Top to bottom: the two rosters with the shared field between them, then one column per side —
 * its result (health, the selected hit, its four moves, typed in place) directly above the build
 * that produced it — and finally the all-pairs grid: the same two teams, every attacker × move of
 * ours against every defender of theirs. Swapping attack and defence swaps the teams themselves.
 *
 * The rosters, who is up, the selected moves and the battle frame belong to the calc page's shared
 * roster (roster.tsx), so the bulk tool opens on the same teams; this tab owns only its reading
 * state (roll, crit, single target) and its results.
 *
 * Every number on the page comes from ONE fault-isolated batch per section, so a bad cell (an
 * unknown move on a swapped-in mon) never blanks the rest. */
import type {
  DamageRequestDto, DamageResultDto, LearnsetDto, NatureDto,
} from "@pokemon-champions/protocol";
import { isErrorShape } from "@pokemon-champions/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalcRailApi, CalcRailTarget } from "../../components/CalcRail.tsx";
import { useAsync, useMovesByName } from "../../hooks.ts";
import { useDamageText } from "../../lib/damageText.tsx";
import { localName, useNameMaps } from "../../lib/names.ts";
import { displayName, useLang, useT, type MsgKey } from "../../i18n.ts";
import { parsePokepaste, formatPokepasteMon } from "../../lib/pokepaste.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { loadLearnset, type ItemRef } from "../../runtime/projection.ts";
import type { BuildOption } from "./shared.tsx";
import { AllMatchups, type GridCol, type GridRow } from "./duel/AllMatchups.tsx";
import { loadDuelView, saveDuelView } from "./duel/persist.ts";
import { FieldPanel } from "./duel/FieldPanel.tsx";
import { MonEditor, buildCardOptionForMon } from "./duel/MonEditor.tsx";
import { ResultCard, type SlotResult } from "./duel/ResultCard.tsx";
import { TeamBar, TEAM_MAX, type ImportOutcome } from "./duel/TeamBar.tsx";
import {
  MOVE_SLOTS, SIDE_FLAGS, TERRAIN_ABILITIES, WEATHER_ABILITIES,
  ROLL_TOP, applyBuildOption, curHPOf, damageRequest, effectiveEntry, makeMon, maxHPOf, otherSide,
  rollValue, withMoves, type MonState, type SideId,
} from "./duel/state.ts";
import { useRoster } from "./roster.tsx";

const SIDES: SideId[] = ["a", "b"];
/** The calc batch bound (DamageBatchRequestDtoSchema). The duel takes at most 8 of it. */
const BATCH_MAX = 240;

type PerSide<T> = Record<SideId, T>;
const perSide = <T,>(a: T, b: T): PerSide<T> => ({ a, b });

export function DamageTab({ dex, natures, items, onRailApi }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  onRailApi?: (api: CalcRailApi) => void;
}) {
  const { adapter } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const moveVocab = useMovesByName();
  const { teams, setTeams, active, setActive, slot, setSlot, field, setField, swaps, swapSides } = useRoster();

  // This tab's own reading state. It is bound to a SIDE, so a swap of the two teams carries it
  // across with them (below).
  const savedView = useRef(loadDuelView()).current;
  // An index into the engine's sorted 16 rolls; the top one is what a damage question defaults to.
  const [roll, setRoll] = useState<PerSide<number>>(savedView?.roll ?? perSide(ROLL_TOP, ROLL_TOP));
  const [crit, setCrit] = useState<PerSide<boolean>>(savedView?.crit ?? perSide(false, false));
  const [single, setSingle] = useState<PerSide<boolean>>(savedView?.single ?? perSide(false, false));
  const seenSwaps = useRef(swaps);
  useEffect(() => {
    if (seenSwaps.current === swaps) return;
    seenSwaps.current = swaps;
    const flip = <T,>(value: PerSide<T>): PerSide<T> => ({ a: value.b, b: value.a });
    setRoll(flip); setCrit(flip); setSingle(flip);
  }, [swaps]);

  const [duel, setDuel] = useState<PerSide<SlotResult[]>>(perSide([], []));
  const [duelBusy, setDuelBusy] = useState(false);
  const [duelError, setDuelError] = useState<string | null>(null);
  const [gridRun, setGridRun] = useState<{
    plan: { rows: GridRow[]; cols: GridCol[] };
    /** The inputs these results were computed FROM, as content. */
    sig: string;
    results: Array<DamageResultDto | { error?: unknown } | null>;
  } | null>(null);
  const [gridBusy, setGridBusy] = useState(false);
  const [gridRerun, setGridRerun] = useState(0);
  const [gridError, setGridError] = useState<string | null>(null);

  // Keep the reading state across a page change (the roster persists itself): only INPUT is
  // stored, so nothing on screen can be a number that no longer follows from the build beside it.
  useEffect(() => {
    saveDuelView({ roll, crit, single });
  }, [roll, crit, single]);

  const mon = useMemo(() => perSide(
    teams.a[Math.min(active.a, teams.a.length - 1)] ?? makeMon(),
    teams.b[Math.min(active.b, teams.b.length - 1)] ?? makeMon(),
  ), [teams, active]);

  // A spread move is still flagged as one in singles; the 0.75x reduction simply does not apply
  // there. Dropping the toggle on the way into singles keeps a stale "single target" from silently
  // changing the numbers again when the format comes back.
  useEffect(() => {
    if (field.format === "single") setSingle(perSide(false, false));
  }, [field.format]);

  const setMonAt = useCallback((side: SideId, index: number,
                                update: MonState | ((m: MonState) => MonState)) => {
    setTeams((prev: PerSide<MonState[]>) => {
      const current = prev[side][index];
      if (!current) return prev;
      const next = typeof update === "function" ? update(current) : update;
      // MonEditor has a few fact-reconciliation effects. A proven no-op must preserve the team
      // identity, or those effects can feed themselves and starve the debounced damage run.
      if (next === current) return prev;
      const team = [...prev[side]];
      team[index] = next;
      return { ...prev, [side]: team };
    });
  }, [setTeams]);

  // Stable per-side Dispatch functions: constructing `setActiveMon(side)` inline gave each
  // MonEditor a new setter every render. Once the environment picker had identified an exact card,
  // its reconciliation effect then ran again after every render and could keep the page spinning.
  const setActiveMon = useMemo<PerSide<(
    update: MonState | ((m: MonState) => MonState),
  ) => void>>(() => perSide(
    (update) => setMonAt("a", active.a, update),
    (update) => setMonAt("b", active.b, update),
  ), [active.a, active.b, setMonAt]);

  const pickFromRail = useCallback((target: CalcRailTarget, entry: DexIndexEntry,
                                    option: BuildOption | null, optionIndex: number) => {
    const side: SideId = target === "primary" ? "a" : "b";
    const team = teams[side];
    const activeEmpty = team[active[side]] && !team[active[side]]!.slug ? active[side] : -1;
    const emptyIndex = activeEmpty >= 0 ? activeEmpty : team.findIndex((candidate) => !candidate.slug);
    if (emptyIndex < 0 && team.length >= TEAM_MAX) return { ok: false as const, reason: "full" as const };
    const base = { ...makeMon(entry.slug), pinned: true };
    const mon = option ? { ...applyBuildOption(base, option, optionIndex), pinned: true } : base;
    const index = emptyIndex >= 0 ? emptyIndex : team.length;
    const next = emptyIndex >= 0
      ? team.map((candidate, at) => at === emptyIndex ? mon : candidate)
      : [...team, mon];
    setTeams((previous) => ({ ...previous, [side]: next }));
    setActive((previous) => ({ ...previous, [side]: index }));
    return { ok: true as const };
  }, [active, teams]);

  const railApi = useMemo<CalcRailApi>(() => ({
    format: field.format,
    targets: [
      { id: "primary", label: t("calc.rail.offense") },
      { id: "secondary", label: t("calc.rail.defense") },
    ],
    pick: pickFromRail,
  // `useT()` returns a render-local function; language, not that function identity, is the input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [field.format, pickFromRail, lang]);
  useEffect(() => { onRailApi?.(railApi); }, [onRailApi, railApi]);

  const learnsetA = useAsync<LearnsetDto | null>(
    () => (mon.a.slug ? loadLearnset(mon.a.slug) : Promise.resolve(null)), [mon.a.slug]);
  const learnsetB = useAsync<LearnsetDto | null>(
    () => (mon.b.slug ? loadLearnset(mon.b.slug) : Promise.resolve(null)), [mon.b.slug]);
  const learnset = perSide(
    learnsetA.status === "ready" ? learnsetA.data : null,
    learnsetB.status === "ready" ? learnsetB.data : null);

  /** Plain localized move name. The result rows and grid headers print this directly rather than
   * going through the prose renderer, which would add a type chip and a nested link to every one. */
  const moveLabel = useCallback((name: string): string => {
    const ref = moveVocab.get(name);
    return ref ? displayName(ref, lang) : name;
  }, [moveVocab, lang]);

  // -- import / export --------------------------------------------------------------------

  const matchLocal = <T extends { name: string; nameZh?: string; nameJa?: string },>(
    pool: T[], raw: string | undefined): T | undefined => {
    if (!raw) return undefined;
    const q = raw.trim();
    if (!q) return undefined;
    const lower = q.toLowerCase();
    return pool.find((x) => x.name.toLowerCase() === lower || x.nameZh === q || x.nameJa === q)
      ?? pool.find((x) => x.name.toLowerCase().replace(/[\s'’.-]/g, "")
        === lower.replace(/[\s'’.-]/g, ""));
  };

  const importPaste = async (side: SideId, text: string): Promise<ImportOutcome> => {
    const { mons: pasted, rescaledEvs } = parsePokepaste(text);
    if (!pasted.length) return { added: 0, unresolved: [], rescaledEvs };

    // Species: try the dex index we already hold, then ask the resolver ONCE for whatever is left
    // (a fuzzy or alias spelling is exactly what `resolve` is for; per-name round trips are not).
    const resolved = new Map<string, DexIndexEntry>();
    const misses: string[] = [];
    for (const p of pasted) {
      const local = matchLocal(dex, p.species)
        ?? dex.find((e) => e.slug === p.species.trim().toLowerCase());
      if (local) resolved.set(p.species, local);
      else misses.push(p.species);
    }
    if (misses.length) {
      try {
        const entries = await adapter.resolve(misses, "pokemon");
        entries.forEach((entry, i) => {
          const hit = entry.ok && entry.canonical
            ? dex.find((e) => e.name === entry.canonical) : undefined;
          if (hit) resolved.set(misses[i]!, hit);
        });
      } catch (e) {
        console.error("pokepaste species resolution failed:", e);
      }
    }

    const unresolved: string[] = [];
    const built: MonState[] = [];
    for (const p of pasted.slice(0, TEAM_MAX)) {
      const entry = resolved.get(p.species);
      if (!entry) { unresolved.push(p.species); continue; }
      const next = makeMon(entry.slug);
      next.sps = { ...p.sps };
      const item = matchLocal(items, p.item);
      if (item) next.item = item.name;
      else if (p.item) unresolved.push(p.item);
      const ability = matchLocal(entry.abilities, p.ability);
      if (ability) next.ability = ability.name;
      else if (p.ability) unresolved.push(p.ability);
      const nature = matchLocal(natures, p.nature);
      if (nature) next.nature = nature.name;
      else if (p.nature) unresolved.push(p.nature);
      if (p.moves.length) {
        let pool: LearnsetDto["moves"] = [];
        try {
          pool = (await loadLearnset(entry.slug)).moves;
        } catch (e) {
          console.error(`learnset load failed for ${entry.slug}:`, e);
        }
        const names: string[] = [];
        for (const raw of p.moves) {
          const hit = matchLocal(pool, raw);
          if (hit) names.push(hit.name);
          else unresolved.push(raw);
        }
        next.moves = withMoves(next, names).moves;
      }
      built.push(next);
    }
    if (!built.length) return { added: 0, unresolved, rescaledEvs };
    setTeams((prev) => ({ ...prev, [side]: built }));
    setActive((prev) => ({ ...prev, [side]: 0 }));
    return { added: built.length, unresolved, rescaledEvs };
  };

  const exportMon = (side: SideId) => {
    const target = mon[side];
    const entry = effectiveEntry(target, dex, items);
    if (!entry) return;
    // English canonicals: a Showdown block is a join key document, read by other tools (design §2.1).
    const text = formatPokepasteMon({
      species: entry.name, item: target.item, ability: target.ability, nature: target.nature,
      sps: target.sps, moves: target.moves.filter(Boolean),
    });
    void navigator.clipboard.writeText(text).catch((e) => {
      console.error("copying the set failed:", e);
    });
  };

  // -- the duel batch (both directions, all four slots each) ------------------------------

  const duelPlan = useMemo(() => {
    const requests: DamageRequestDto[] = [];
    const map: PerSide<Array<number | null>> = perSide([], []);
    for (const side of SIDES) {
      const from = mon[side];
      const to = mon[otherSide(side)];
      const slots: Array<number | null> = [];
      for (let i = 0; i < MOVE_SLOTS; i++) {
        const name = from.moves[i] ?? "";
        const req = name
          ? damageRequest(from, to, name, field, side, dex, items,
              { crit: crit[side], singleTarget: single[side] })
          : null;
        if (!req) { slots.push(null); continue; }
        slots.push(requests.length);
        requests.push(req);
      }
      map[side] = slots;
    }
    return { requests, map };
  }, [mon, field, crit, single, dex, items]);

  useEffect(() => {
    const { requests, map } = duelPlan;
    const blank = (side: SideId): SlotResult[] =>
      Array.from({ length: MOVE_SLOTS }, (_, i) => {
        const name = mon[side].moves[i] ?? "";
        const ref = moveVocab.get(name);
        return { move: name, label: moveLabel(name), category: ref?.category, type: ref?.type,
                 result: null, failed: false };
      });
    if (!requests.length) {
      setDuel(perSide(blank("a"), blank("b")));
      setDuelError(null);
      return;
    }
    let cancelled = false;
    setDuelBusy(true);
    const timer = window.setTimeout(() => {
      adapter.damageBatch(requests).then((out) => {
        if (cancelled) return;
        const read = (side: SideId): SlotResult[] => blank(side).map((s, i) => {
          const at = map[side][i];
          if (at == null) return s;
          const cell = out[at];
          if (!cell || isErrorShape(cell)) return { ...s, failed: true };
          return { ...s, result: cell as DamageResultDto, failed: false };
        });
        setDuel(perSide(read("a"), read("b")));
        setDuelError(null);
      }).catch((e) => {
        if (cancelled) return;
        console.error("Damage calculation failed:", e);
        setDuel(perSide(blank("a"), blank("b")));
        setDuelError(t("calc.error"));
      }).finally(() => { if (!cancelled) setDuelBusy(false); });
    }, 220);
    return () => { cancelled = true; window.clearTimeout(timer); setDuelBusy(false); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duelPlan, adapter, moveVocab, moveLabel]);

  // -- the all-pairs grid -----------------------------------------------------------------

  const gridPlan = useMemo(() => {
    const gridFrom: SideId = "a";
    const to = otherSide(gridFrom);
    const rows: GridRow[] = [];
    const rowMons: MonState[] = [];
    for (const m of teams[to]) {
      const entry = effectiveEntry(m, dex, items);
      if (entry) { rows.push({ entry, build: buildCardOptionForMon(m, entry, dex) }); rowMons.push(m); }
    }
    const cols: GridCol[] = [];
    const colSources: Array<{ mon: MonState; move: string }> = [];
    teams[gridFrom].forEach((m, attackerIndex) => {
      const entry = effectiveEntry(m, dex, items);
      if (!entry) return;
      for (const move of m.moves) {
        if (!move) continue;
        // Status moves have no damage row; a column of dashes is noise, not a fact.
        if (moveVocab.get(move)?.category === "Status") continue;
        cols.push({ attackerIndex, entry, build: buildCardOptionForMon(m, entry, dex),
          move, label: moveLabel(move) });
        colSources.push({ mon: m, move });
      }
    });
    const requests: DamageRequestDto[] = [];
    let complete = true;
    for (const row of rowMons) {
      for (const col of colSources) {
        const req = damageRequest(col.mon, row, col.move, field, gridFrom, dex, items);
        if (!req) { complete = false; continue; }
        requests.push(req);
      }
    }
    // Staleness is a question about the NUMBERS, so the signature is the requests and nothing else:
    // the labels beside them are display, and a language switch must not invalidate a grid whose
    // every cell is still correct.
    return { rows, cols, requests, complete, sig: JSON.stringify(requests) };
  }, [teams, field, dex, items, moveVocab, moveLabel]);

  /** The grid runs ON REQUEST, not on every edit.
   *
   * Two full teams are ~144 independent calcs, and re-running them after each keystroke burns the
   * engine on answers nobody has read yet. The last run stays on screen (results you already paid
   * for are still worth reading) and is marked stale once its inputs move. */
  const runGrid = async () => {
    const plan = gridPlan;
    if (!plan.rows.length || !plan.cols.length || !plan.complete) return;
    if (plan.requests.length > BATCH_MAX) {
      setGridRun({ plan, sig: plan.sig, results: [] }); setGridError(t("calc.tooMany"));
      return;
    }
    setGridBusy(true);
    try {
      const out = await adapter.damageBatch(plan.requests);
      setGridRun({
        plan, sig: plan.sig, results: out as Array<DamageResultDto | { error?: unknown }>,
      });
      setGridError(null);
    } catch (e) {
      console.error("Matchup grid calculation failed:", e);
      setGridRun({ plan, sig: plan.sig, results: [] });
      setGridError(t("calc.error"));
    } finally {
      setGridBusy(false);
    }
  };

  const gridRunnable = gridPlan.complete && gridPlan.rows.length > 0 && gridPlan.cols.length > 0;
  // Content, not object identity. The plan memo rebuilds whenever `teams` gets a new object — and it
  // does so for things that change no number at all: selecting another roster slot re-runs the meta
  // auto-fill, which rewrites the build with the same values it already had. Comparing the requests
  // themselves means the grid goes stale when, and only when, an answer in it would actually differ.
  const gridStale = gridRun !== null && gridRun.sig !== gridPlan.sig;

  // A swap re-runs on the NEXT render, when gridPlan has already been rebuilt from the swapped
  // teams — calling runGrid inside the click would compute the old direction again.
  useEffect(() => {
    if (gridRerun > 0) void runGrid();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridRerun]);

  // -- derived view ------------------------------------------------------------------------

  /** The slot actually shown: the picked one when it holds a move, else the first that does. */
  const shownSlot = (side: SideId): number => {
    const moves = mon[side].moves;
    if (moves[slot[side]]) return slot[side];
    const first = moves.findIndex(Boolean);
    return first === -1 ? slot[side] : first;
  };

  const outgoing = (side: SideId): DamageResultDto | null =>
    duel[side][shownSlot(side)]?.result ?? null;

  /** What this mon has left after the OTHER card's selected move at that card's roll. */
  const remainingOf = (side: SideId): number => {
    const maxHP = maxHPOf(mon[side], dex, items);
    const cur = curHPOf(mon[side], maxHP);
    const incoming = outgoing(otherSide(side));
    if (!incoming) return cur;
    return Math.max(0, cur - rollValue(incoming.damage, roll[otherSide(side)]));
  };

  /** Where the OTHER card's selected move can leave this mon across its whole roll range. */
  const bandOf = (side: SideId): { lo: number; hi: number } | null => {
    const incoming = outgoing(otherSide(side));
    if (!incoming) return null;
    const cur = curHPOf(mon[side], maxHPOf(mon[side], dex, items));
    return { lo: Math.max(0, cur - incoming.max), hi: Math.max(0, cur - incoming.min) };
  };

  const setMove = (side: SideId, index: number, name: string) => {
    setMonAt(side, active[side], (current) => {
      const moves = [...current.moves];
      while (moves.length < MOVE_SLOTS) moves.push("");
      if (moves[index] === name) return current;
      moves[index] = name;
      return { ...current, moves };
    });
  };
  // Stable per side: each move input is memoised on its change handler.
  const moveSetters = useMemo(() => perSide(
    (index: number, name: string) => setMove("a", index, name),
    (index: number, name: string) => setMove("b", index, name),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [active.a, active.b, setMonAt]);

  const nameOf = (side: SideId): string => {
    const entry = effectiveEntry(mon[side], dex, items);
    return entry ? displayName(entry, lang) : t("calc.emptySlot");
  };

  const sideLabel = perSide(t("calc.attacker"), t("calc.defender"));

  const damageText = useDamageText();
  /** Caveats for the HIT this card's sentence describes: the glyph sits right after "X uses M on Y",
   * so it carries every caveat that hit raised — about the attacker (a self-drop) and about the
   * target (Disguise) alike. A note about the defender therefore lands on the ATTACKER's card, next
   * to the attack it qualifies, not beside the struck mon's own, unrelated sentence. */
  const notesFor = (side: SideId): string[] =>
    (outgoing(side)?.koCaveats ?? []).map((cv) => damageText.caveat(cv));

  // A field-setting ability on either active mon, offered next to the picker it would fill. Only
  // when that field is still empty: an offer to set what is already set says nothing.
  const abilityNames = useNameMaps().ability;
  const fieldOffers = <V extends string,>(table: Record<string, V>, current: string) => {
    if (current) return [];
    const seen = new Set<string>();
    return SIDES.flatMap((side) => {
      const ability = mon[side].ability;
      const value = ability ? table[ability] : undefined;
      // Both sides can bring a setter, and which one actually landed is a battle fact the page
      // cannot know — so it offers both rather than silently picking the attacker's.
      if (!value || seen.has(ability)) return [];
      seen.add(ability);
      return [{ ability, label: localName(abilityNames, ability, lang), value }];
    });
  };

  const resetSide = (side: SideId) => {
    setTeams((prev) => ({ ...prev, [side]: [makeMon()] }));
    setActive((prev) => ({ ...prev, [side]: 0 }));
    setSlot((prev) => ({ ...prev, [side]: 0 }));
  };

  // The flyout lives here rather than inside FieldPanel: a team strip's overflow chip opens it too.
  const [fieldOpen, setFieldOpen] = useState(false);
  const activeFlagsFor = (side: SideId) => SIDE_FLAGS
    .filter((flag) => (field.format === "double" || !flag.doublesOnly)
      && field.sides[side][flag.key])
    .map((flag) => ({ key: flag.key, label: t(flag.label as MsgKey) }));
  const clearFlag = (side: SideId, key: string) => setField((current) => ({
    ...current,
    sides: { ...current.sides, [side]: { ...current.sides[side], [key]: false } },
  }));

  const column = (side: SideId) => (
    <ResultCard
      monName={nameOf(side)}
      entry={effectiveEntry(mon[side], dex, items)}
      slots={duel[side].length ? duel[side] : Array.from({ length: MOVE_SLOTS }, (_, i) => ({
        move: mon[side].moves[i] ?? "", label: moveLabel(mon[side].moves[i] ?? ""),
        type: moveVocab.get(mon[side].moves[i] ?? "")?.type, result: null, failed: false,
      }))}
      learnset={learnset[side]}
      selected={shownSlot(side)}
      onSelect={(i) => setSlot((prev) => prev[side] === i ? prev : { ...prev, [side]: i })}
      onMove={moveSetters[side]}
      roll={roll[side]} onRoll={(m) => setRoll((prev) => ({ ...prev, [side]: m }))}
      crit={crit[side]} onCrit={(v) => setCrit((prev) => ({ ...prev, [side]: v }))}
      singleTarget={single[side]}
      onSingleTarget={(v) => setSingle((prev) => ({ ...prev, [side]: v }))}
      singleTargetAvailable={field.format !== "single"
        && (single[side] || !!duel[side][shownSlot(side)]?.result?.isSpread)}
      maxHP={maxHPOf(mon[side], dex, items)}
      remaining={remainingOf(side)}
      band={bandOf(side)}
      notes={notesFor(side)}
      busy={duelBusy} />
  );

  return (
    <div className="calc-duel">
      {duelError && <div className="notice mono">{duelError}</div>}

      <div className={`duel-teams${field.weather ? ` weather-${field.weather.toLowerCase()}` : ""}${field.terrain ? ` terrain-${field.terrain.toLowerCase()}` : ""}`}>
        <TeamBar label={t("calc.attackerTeam")} team={teams.a} index={active.a}
          onIndex={(i) => setActive((p) => ({ ...p, a: i }))}
          onAdd={() => {
            if (teams.a.length >= TEAM_MAX) return;
            setTeams((p) => p.a.length >= TEAM_MAX ? p : { ...p, a: [...p.a, makeMon()] });
            setActive((p) => ({ ...p, a: teams.a.length }));
          }}
          onRemove={(i) => {
            setTeams((p) => ({ ...p, a: p.a.filter((_, j) => j !== i) }));
            setActive((p) => ({ ...p, a: Math.max(0, Math.min(p.a, teams.a.length - 2)) }));
          }}
          onReset={() => resetSide("a")}
          activeFlags={activeFlagsFor("a")} onClearFlag={(key) => clearFlag("a", key)}
          onShowFlags={() => setFieldOpen(true)}
          dex={dex} items={items} onImport={(text) => importPaste("a", text)} />

        <FieldPanel field={field} setField={setField} open={fieldOpen} setOpen={setFieldOpen}
          sideALabel={t("calc.sideOf").replace("{side}", sideLabel.a)}
          sideBLabel={t("calc.sideOf").replace("{side}", sideLabel.b)}
          weatherSuggestions={fieldOffers(WEATHER_ABILITIES, field.weather)}
          terrainSuggestions={fieldOffers(TERRAIN_ABILITIES, field.terrain)} />

        <TeamBar label={t("calc.defenderTeam")} team={teams.b} index={active.b}
          onIndex={(i) => setActive((p) => ({ ...p, b: i }))}
          onAdd={() => {
            if (teams.b.length >= TEAM_MAX) return;
            setTeams((p) => p.b.length >= TEAM_MAX ? p : { ...p, b: [...p.b, makeMon()] });
            setActive((p) => ({ ...p, b: teams.b.length }));
          }}
          onRemove={(i) => {
            setTeams((p) => ({ ...p, b: p.b.filter((_, j) => j !== i) }));
            setActive((p) => ({ ...p, b: Math.max(0, Math.min(p.b, teams.b.length - 2)) }));
          }}
          onReset={() => resetSide("b")}
          activeFlags={activeFlagsFor("b")} onClearFlag={(key) => clearFlag("b", key)}
          onShowFlags={() => setFieldOpen(true)}
          dex={dex} items={items} onImport={(text) => importPaste("b", text)} mirrored />
      </div>

      {/* Each side is one panel: what it does on top, the build that does it underneath. */}
      <div className="duel-sides">
        {SIDES.map((side) => (
          <section key={side} className="panel duel-side">
            {column(side)}
            <MonEditor label={sideLabel[side]} mon={mon[side]}
              setMon={setActiveMon[side]} dex={dex} natures={natures} items={items}
              format={field.format}
              onSetPick={(option, index) => setMonAt(
                side, active[side], (current) => applyBuildOption(current, option, index))}
              onExport={() => exportMon(side)} />
          </section>
        ))}
      </div>

      <AllMatchups
        rows={gridRun?.plan.rows ?? []} cols={gridRun?.plan.cols ?? []}
        results={gridRun?.results ?? []}
        onFlip={() => {
          // Attack and defence change places for real: the two teams, who is up, their moves and
          // side conditions all swap — on this tab and on every tool reading the same roster.
          swapSides();
          // The grid asks the same question the other way round; making the reader press compute
          // again for an answer they already asked for is a step with no decision in it.
          if (gridRun) setGridRerun((n) => n + 1);
        }}
        onRun={() => void runGrid()} runnable={gridRunnable} stale={gridStale}
        busy={gridBusy} error={gridError}
        fromLabel={sideLabel.a} toLabel={sideLabel.b} />
    </div>
  );
}
