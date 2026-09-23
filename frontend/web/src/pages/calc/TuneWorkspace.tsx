/** Durability workbench, top to bottom: both rosters with the solver-supported field conditions
 * between them; the live verdict for the selected move; the two builds, our spread on the left and
 * the attacker with its moves on the right; and at the foot the pinned survival targets with the
 * `tune` operator's solutions for them (or, with none pinned, for the current matchup).
 *
 * The rosters, who is up, the opponent's selected move and the battle frame are the calc page's
 * shared roster (roster.tsx): side "a" is our defender's team, side "b" the attackers'. This tool
 * reads only the conditions its solver carries — format, weather, terrain and our screens — so the
 * live number and the solved number always describe the same frame. Targets and loaded spreads are
 * its own, keyed on each mon's uid so edits made on the calculator tab keep them attached.
 *
 * Every damage number comes from a request-keyed store. An idle sweep prefetches each HP / Def / SpD
 * position for the moves on screen, so dragging a slider is answered from memory rather than by a
 * debounced round trip. */
import type { DamageRequestDto, FormatId, LearnsetDto, NatureDto } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalcRailApi, CalcRailTarget } from "../../components/CalcRail.tsx";
import { useAsync, useMovesByName } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import { parsePokepaste } from "../../lib/pokepaste.ts";
import { takeTuneFill } from "../../lib/team.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { useRuntime } from "../../runtime/context.tsx";
import { loadLearnset, type ItemRef } from "../../runtime/projection.ts";
import { BOOST_KEYS, buildConfigSig, type BuildOption } from "./shared.tsx";
import { TEAM_MAX, type ImportOutcome } from "./duel/TeamBar.tsx";
import {
  EMPTY_FIELD, applyBuildOption, damageRequest, effectiveEntry, makeMon, withMoves,
  type FieldState, type MonState, type SideId,
} from "./duel/state.ts";
import { useRoster } from "./roster.tsx";
import {
  cloneSps, formatProbability, pressedStat, targetProbability, useDamageStore,
  type Baseline, type BulkStat, type Goal, type GoalTarget, type Hits, type Rolls, type TuneSide,
} from "./tune/model.ts";
import { AttackerCard, DefenderCard, type MoveReading } from "./tune/MonCards.tsx";
import { SCREEN_FLAGS, TeamStrip } from "./tune/TeamStrip.tsx";
import { TARGET_LABEL, Verdict, type VerdictState } from "./tune/Verdict.tsx";
import { TargetsPanel, type SolveEntry, type SolveRun, type TargetRow } from "./tune/Targets.tsx";

/** Our defender is the roster's side "a", the attackers side "b". */
const SIDE: Record<TuneSide, SideId> = { mine: "a", foe: "b" };
const DEFAULT_SLUG: Record<TuneSide, string> = { mine: "garchomp", foe: "mimikyu" };
const SWEEP_STATS: BulkStat[] = ["hp", "def", "spd"];
const SWEEP_CAP = 960;
const SOLVE_CAP = 12;

type MonUpdate = (update: (mon: MonState) => MonState) => void;
type Teams = Record<SideId, MonState[]>;

function matchLocal<T extends { name: string; nameZh?: string; nameJa?: string }>(
  pool: T[], raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  const query = raw.trim();
  const lower = query.toLowerCase();
  const loose = (value: string) => value.toLowerCase().replace(/[\s'’.-]/g, "");
  return pool.find((candidate) => candidate.name.toLowerCase() === lower
    || candidate.nameZh === query || candidate.nameJa === query)
    ?? pool.find((candidate) => loose(candidate.name) === loose(query));
}

/** Everything a solve depends on except our members' SP and nature, which an applied lane changes. */
function contextSignature(teams: Teams, field: FieldState, plan: Array<Omit<SolveEntry, "base">>): string {
  const identity = (mon: MonState) => [mon.slug, mon.ability, mon.item, mon.status, mon.moves, mon.boosts];
  return JSON.stringify([
    teams.a.map((mon) => [mon.uid, identity(mon)]),
    teams.b.map((mon) => [mon.uid, identity(mon), mon.sps, mon.nature]),
    field, plan,
  ]);
}

const findMon = (teams: Teams, side: SideId, uid: string) =>
  teams[side].find((candidate) => candidate.uid === uid);

export function TuneWorkspace({ dex, natures, items, onRailApi }: {
  dex: DexIndexEntry[];
  natures: NatureDto[];
  items: ItemRef[];
  onRailApi?: (api: CalcRailApi) => void;
}) {
  const { adapter, can } = useRuntime();
  const t = useT();
  const { lang } = useLang();
  const moveVocab = useMovesByName();
  const store = useDamageStore(adapter);
  const roster = useRoster();
  const { teams, setTeams, active, setActive, slot, setSlot, setField, swaps, swapSides } = roster;
  // The build session a team was handed over from, if any: its team-level fields ride along with
  // every solve. (The roster itself was filled from it once, by the provider.)
  const fill = useRef(takeTuneFill()).current;

  const [hits, setHits] = useState<Hits>(1);
  const [target, setTarget] = useState<GoalTarget>("guaranteed");
  const [goals, setGoals] = useState<Goal[]>([]);
  const [run, setRun] = useState<SolveRun | null>(null);
  const [solveBusy, setSolveBusy] = useState(false);
  const [solveError, setSolveError] = useState<string | null>(null);

  // Only the conditions the `tune` operator carries: format, weather, terrain, and the screens OUR
  // side put up. Everything else on the shared field (a Helping Hand, gravity…) is the calculator's.
  // A tuning frame carries no battle history, so switch-in drops stay off here as in the operator.
  const shared = roster.field;
  const field = useMemo<FieldState>(() => ({
    ...EMPTY_FIELD, format: shared.format, weather: shared.weather, terrain: shared.terrain,
    switchInDrops: false,
    sides: {
      a: Object.fromEntries(SCREEN_FLAGS.filter(({ key }) => shared.sides.a[key]).map(({ key }) => [key, true])),
      b: {},
    },
  }), [shared.format, shared.weather, shared.terrain, shared.sides.a]);

  const mineIndex = Math.min(active.a, teams.a.length - 1);
  const foeIndex = Math.min(active.b, teams.b.length - 1);
  const mine = teams.a[mineIndex]!;
  const foe = teams.b[foeIndex]!;
  const mineEntry = effectiveEntry(mine, dex, items);
  const foeEntry = effectiveEntry(foe, dex, items);

  const isDamaging = useCallback((move: string) =>
    !!move && moveVocab.get(move)?.category !== "Status", [moveVocab]);
  const moveLabel = useCallback((move: string) => {
    const ref = moveVocab.get(move);
    return ref ? displayName(ref, lang) : move;
  }, [moveVocab, lang]);

  // A swap turns every target into a question about the other side; they no longer apply.
  const seenSwaps = useRef(swaps);
  useEffect(() => {
    if (seenSwaps.current === swaps) return;
    seenSwaps.current = swaps;
    setGoals([]);
    setRun(null);
    setSolveError(null);
  }, [swaps]);

  // Targets name mons by uid; one whose mon left the roster (removed, re-picked as another species,
  // replaced by an import — here or on the calculator tab) is dropped.
  useEffect(() => {
    setGoals((previous) => {
      const kept = previous.filter((goal) => findMon(teams, "a", goal.mineId) && findMon(teams, "b", goal.foeId));
      return kept.length === previous.length ? previous : kept;
    });
  }, [teams]);

  // -- loaded spreads ("还原" points) --------------------------------------------------------------
  // The spread a mon arrived with. A mon that is exactly an environment card right now (picked or
  // auto-filled, on either tab) takes that card as its point; hand edits after that do not move it.
  const baselines = useRef(new Map<string, Baseline>());
  const baselineOf = (mon: MonState): Baseline => {
    const exact = !!mon.buildRef && mon.buildRef.signature === buildConfigSig(mon);
    let baseline = baselines.current.get(mon.uid);
    if (!baseline || (exact && (baseline.nature !== mon.nature
      || STAT_KEYS.some((key) => (baseline!.sps[key] ?? 0) !== (mon.sps[key] ?? 0))))) {
      baseline = { sps: cloneSps(mon.sps), nature: mon.nature };
      baselines.current.set(mon.uid, baseline);
    }
    return baseline;
  };
  const mineBaseline = baselineOf(mine);

  // -- member edits ----------------------------------------------------------------------

  const updateMon = useCallback((uid: string, update: (mon: MonState) => MonState) => {
    setTeams((previous: Teams) => {
      for (const side of ["a", "b"] as const) {
        const at = previous[side].findIndex((candidate) => candidate.uid === uid);
        if (at < 0) continue;
        const next = [...previous[side]];
        next[at] = { ...update(previous[side][at]!), pinned: true, autoSig: null };
        return { ...previous, [side]: next };
      }
      return previous;
    });
  }, [setTeams]);

  const mineId = mine.uid;
  const foeId = foe.uid;
  const changeMine = useCallback<MonUpdate>((update) => updateMon(mineId, update), [updateMon, mineId]);
  const changeFoe = useCallback<MonUpdate>((update) => updateMon(foeId, update), [updateMon, foeId]);

  // A new species is a new mon (fresh uid): its targets retire with the old one.
  const setSpecies = useCallback((uid: string, slug: string) => {
    setTeams((previous: Teams) => ({
      a: previous.a.map((mon) => mon.uid === uid ? makeMon(slug) : mon),
      b: previous.b.map((mon) => mon.uid === uid ? makeMon(slug) : mon),
    }));
  }, [setTeams]);
  const mineSpecies = useCallback((slug: string) => setSpecies(mineId, slug), [setSpecies, mineId]);
  const foeSpecies = useCallback((slug: string) => setSpecies(foeId, slug), [setSpecies, foeId]);

  // An environment card replaces the build wholesale (and so becomes the new "还原" point).
  const minePick = useCallback((option: BuildOption) =>
    updateMon(mineId, (mon) => applyBuildOption(mon, option)), [updateMon, mineId]);
  const foePick = useCallback((option: BuildOption) =>
    updateMon(foeId, (mon) => applyBuildOption(mon, option)), [updateMon, foeId]);

  const restoreMine = useCallback(() => {
    const baseline = baselines.current.get(mineId);
    if (baseline) updateMon(mineId, (mon) => ({ ...mon, sps: cloneSps(baseline.sps), nature: baseline.nature }));
  }, [updateMon, mineId]);

  const foeLearnset = useAsync<LearnsetDto | null>(
    () => foe.slug ? loadLearnset(foe.slug) : Promise.resolve(null), [foe.slug]);

  // The opponent's selected move is the roster's side-"b" slot, shared with the calculator. When it
  // points at a blank or status slot the verdict reads the first attacking move instead — without
  // writing that back, so the calculator's own selection is never moved from here.
  const pickedSlot = slot.b;
  const selectedSlot = isDamaging(foe.moves[pickedSlot] ?? "") ? pickedSlot
    : (() => { const first = foe.moves.findIndex(isDamaging); return first >= 0 ? first : pickedSlot; })();
  const selectSlot = useCallback((index: number) =>
    setSlot((previous) => previous.b === index ? previous : { ...previous, b: index }), [setSlot]);

  // -- roster ------------------------------------------------------------------------------

  const importPaste = useCallback(async (side: TuneSide, text: string): Promise<ImportOutcome> => {
    const { mons: pasted, rescaledEvs } = parsePokepaste(text);
    if (!pasted.length) return { added: 0, unresolved: [], rescaledEvs };
    const resolved = new Map<string, DexIndexEntry>();
    const misses: string[] = [];
    for (const pastedMon of pasted) {
      const local = matchLocal(dex, pastedMon.species)
        ?? dex.find((entry) => entry.slug === pastedMon.species.trim().toLowerCase());
      if (local) resolved.set(pastedMon.species, local); else misses.push(pastedMon.species);
    }
    if (misses.length) {
      try {
        const entries = await adapter.resolve(misses, "pokemon");
        entries.forEach((entry, index) => {
          const hit = entry.ok && entry.canonical
            ? dex.find((candidate) => candidate.name === entry.canonical) : undefined;
          if (hit) resolved.set(misses[index]!, hit);
        });
      } catch (error) { console.error("tune import resolution failed:", error); }
    }
    const unresolved: string[] = [];
    const built: MonState[] = [];
    for (const pastedMon of pasted.slice(0, TEAM_MAX)) {
      const entry = resolved.get(pastedMon.species);
      if (!entry) { unresolved.push(pastedMon.species); continue; }
      const mon = makeMon(entry.slug);
      mon.sps = { ...pastedMon.sps };
      mon.pinned = true;
      const item = matchLocal(items, pastedMon.item);
      if (item) mon.item = item.name; else if (pastedMon.item) unresolved.push(pastedMon.item);
      const ability = matchLocal(entry.abilities, pastedMon.ability);
      if (ability) mon.ability = ability.name; else if (pastedMon.ability) unresolved.push(pastedMon.ability);
      const nature = matchLocal(natures, pastedMon.nature);
      if (nature) mon.nature = nature.name; else if (pastedMon.nature) unresolved.push(pastedMon.nature);
      if (pastedMon.moves.length) {
        let pool: LearnsetDto["moves"] = [];
        try { pool = (await loadLearnset(entry.slug)).moves; }
        catch (error) { console.error("tune learnset import failed:", error); }
        const names = pastedMon.moves.flatMap((raw) => {
          const hit = matchLocal(pool, raw);
          if (hit) return [hit.name];
          unresolved.push(raw);
          return [];
        });
        mon.moves = withMoves(mon, names).moves;
      }
      built.push(mon);
    }
    if (!built.length) return { added: 0, unresolved, rescaledEvs };
    setTeams((previous: Teams) => ({ ...previous, [SIDE[side]]: built }));
    setActive((previous) => ({ ...previous, [SIDE[side]]: 0 }));
    setRun(null);
    return { added: built.length, unresolved, rescaledEvs };
  }, [adapter, dex, items, natures, setTeams, setActive]);

  const pickActive = useCallback((side: TuneSide, index: number) =>
    setActive((previous) => previous[SIDE[side]] === index ? previous : { ...previous, [SIDE[side]]: index }),
  [setActive]);

  const addMember = useCallback((side: TuneSide) => {
    const size = teams[SIDE[side]].length;
    if (size >= TEAM_MAX) return;
    setTeams((previous: Teams) => ({ ...previous, [SIDE[side]]: [...previous[SIDE[side]], makeMon()] }));
    setActive((previous) => ({ ...previous, [SIDE[side]]: size }));
  }, [teams, setTeams, setActive]);

  const removeMember = useCallback((side: TuneSide, index: number) => {
    const team = teams[SIDE[side]];
    const removed = team[index];
    if (!removed || team.length <= 1) return;
    setTeams((previous: Teams) => ({ ...previous,
      [SIDE[side]]: previous[SIDE[side]].filter((mon) => mon.uid !== removed.uid) }));
    // Keep the same mon selected when an earlier one is dropped.
    setActive((previous) => {
      const at = previous[SIDE[side]];
      return { ...previous, [SIDE[side]]: Math.min(at > index ? at - 1 : at, team.length - 2) };
    });
  }, [teams, setTeams, setActive]);

  const resetSide = useCallback((side: TuneSide) => {
    setTeams((previous: Teams) => ({ ...previous, [SIDE[side]]: [makeMon(DEFAULT_SLUG[side])] }));
    setActive((previous) => ({ ...previous, [SIDE[side]]: 0 }));
    setRun(null);
  }, [setTeams, setActive]);

  // The side rail drops a picked mon into the first blank slot of that side, else appends.
  const pickFromRail = useCallback((targetId: CalcRailTarget, entry: DexIndexEntry,
    option: BuildOption | null) => {
    const side: SideId = targetId === "primary" ? "a" : "b";
    const team = teams[side];
    const empty = team.findIndex((candidate) => !candidate.slug);
    if (empty < 0 && team.length >= TEAM_MAX) return { ok: false as const, reason: "full" as const };
    const base = { ...makeMon(entry.slug), pinned: true };
    const mon = option ? applyBuildOption(base, option) : base;
    const index = empty >= 0 ? empty : team.length;
    setTeams((previous: Teams) => ({ ...previous, [side]: empty >= 0
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
  // `useT()` returns a render-local function; language, not that function identity, is the input.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [field.format, pickFromRail, lang]);
  useEffect(() => { onRailApi?.(railApi); }, [onRailApi, railApi]);

  // -- live damage ---------------------------------------------------------------------------
  // The attackers are side "b", so every request is issued from "b": our screens (side "a") then
  // land on the defending side.

  const livePlan = useMemo(() => foe.moves.map((move) => isDamaging(move)
    ? damageRequest(foe, mine, move, field, "b", dex, items)
    : null), [foe, mine, field, dex, items, isDamaging]);

  const goalPlan = useMemo(() => goals.map((goal) => {
    const defender = findMon(teams, "a", goal.mineId);
    const attacker = findMon(teams, "b", goal.foeId);
    return {
      goal,
      request: defender && attacker
        ? damageRequest(attacker, defender, goal.move, field, "b", dex, items) : null,
    };
  }), [goals, teams, field, dex, items]);

  const planKey = useMemo(() => JSON.stringify([livePlan, goalPlan.map((item) => item.request)]),
    [livePlan, goalPlan]);
  useEffect(() => {
    const requests = [...livePlan, ...goalPlan.map((item) => item.request)]
      .filter((request): request is DamageRequestDto => request !== null);
    if (!requests.some((request) => store.read(request) === undefined)) return;
    const timer = window.setTimeout(() => void store.fetchMissing(requests), 40);
    return () => window.clearTimeout(timer);
    // planKey is the content signature of both plans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  // While a new input is being computed, a slot keeps showing its previous numbers (marked pending)
  // instead of blanking — but only for the same move, so a stale range never labels another move.
  const lastCells = useRef<Array<{ move: string; rolls: Rolls | null } | undefined>>([]);
  const cells = useMemo<MoveReading[]>(() => livePlan.map((request, index) => {
    const move = foe.moves[index] ?? "";
    if (!request) return { rolls: null, pending: false };
    const hit = store.read(request);
    if (hit !== undefined) {
      lastCells.current[index] = { move, rolls: hit };
      return { rolls: hit, pending: false };
    }
    const previous = lastCells.current[index];
    return { rolls: previous && previous.move === move ? previous.rolls : null, pending: true };
    // store.version is the store's change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [livePlan, store.version]);

  const goalRolls = useMemo(() => new Map(goalPlan.map(({ goal, request }) =>
    [goal.id, store.read(request) ?? null])),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [goalPlan, store.version]);

  // Idle sweep: once the visible numbers are current, fetch every HP / Def / SpD position of our
  // active mon against the moves on screen and its pinned targets. A slider drag then only reads.
  const settled = cells.every((cell) => !cell.pending)
    && goalPlan.every(({ request }) => !request || store.read(request) !== undefined);
  useEffect(() => {
    if (!settled) return;
    const sources: Array<{ attacker: MonState; move: string }> = [];
    foe.moves.forEach((move) => { if (isDamaging(move)) sources.push({ attacker: foe, move }); });
    for (const goal of goals) {
      if (goal.mineId !== mine.uid) continue;
      const attacker = findMon(teams, "b", goal.foeId);
      if (attacker) sources.push({ attacker, move: goal.move });
    }
    const variants: DamageRequestDto[] = [];
    for (const { attacker, move } of sources) {
      for (const stat of SWEEP_STATS) {
        for (let value = 0; value <= 32 && variants.length < SWEEP_CAP; value++) {
          if (value === (mine.sps[stat] ?? 0)) continue;
          const request = damageRequest(attacker, { ...mine, sps: { ...mine.sps, [stat]: value } },
            move, field, "b", dex, items);
          if (request && store.read(request) === undefined) variants.push(request);
        }
      }
    }
    if (!variants.length) return;
    const timer = window.setTimeout(() => void store.fetchMissing(variants), 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey, settled]);

  // -- verdict & targets -------------------------------------------------------------------------

  const selectedMove = foe.moves[selectedSlot] ?? "";
  const currentGoal = goals.find((goal) => goal.mineId === mine.uid
    && goal.foeId === foe.uid && goal.move === selectedMove);
  // Selecting a pinned pair shows that target's own hits / probability.
  useEffect(() => {
    if (!currentGoal) return;
    setHits(currentGoal.hits);
    setTarget(currentGoal.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentGoal?.id]);

  const updateGoal = useCallback((id: string, patch: Partial<Pick<Goal, "hits" | "target">>) =>
    setGoals((previous) => previous.map((goal) => goal.id === id ? { ...goal, ...patch } : goal)), []);
  const currentGoalId = currentGoal?.id;
  const changeHits = useCallback((value: Hits) => {
    setHits(value);
    if (currentGoalId) updateGoal(currentGoalId, { hits: value });
  }, [currentGoalId, updateGoal]);
  const changeTarget = useCallback((value: GoalTarget) => {
    setTarget(value);
    if (currentGoalId) updateGoal(currentGoalId, { target: value });
  }, [currentGoalId, updateGoal]);
  const togglePin = useCallback(() => {
    if (!selectedMove) return;
    if (currentGoalId) {
      setGoals((previous) => previous.filter((goal) => goal.id !== currentGoalId));
      return;
    }
    setGoals((previous) => [...previous, {
      id: `${mineId}:${foeId}:${selectedMove}`,
      mineId, foeId, move: selectedMove, hits, target,
    }]);
  }, [selectedMove, currentGoalId, mineId, foeId, hits, target]);

  const focusGoal = useCallback((goal: Goal) => {
    const mineAt = teams.a.findIndex((mon) => mon.uid === goal.mineId);
    const foeAt = teams.b.findIndex((mon) => mon.uid === goal.foeId);
    if (mineAt < 0 || foeAt < 0) return;
    setActive({ a: mineAt, b: foeAt });
    const at = teams.b[foeAt]!.moves.indexOf(goal.move);
    if (at >= 0) selectSlot(at);
  }, [teams, setActive, selectSlot]);

  const verdictState: VerdictState = !mineEntry || !foeEntry ? "noMon"
    : !selectedMove ? "noMove" : !isDamaging(selectedMove) ? "statusMove" : "ready";
  const selectedCell = cells[selectedSlot];

  const memberEntry = useCallback((side: TuneSide, uid: string, fallback: string) => {
    const mon = findMon(teams, SIDE[side], uid);
    return mon ? effectiveEntry(mon, dex, items) : dex.find((entry) => entry.name === fallback);
  }, [teams, dex, items]);

  const targetRows = useMemo<TargetRow[]>(() => goals.map((goal) => ({
    goal,
    foe: memberEntry("foe", goal.foeId, ""),
    mine: memberEntry("mine", goal.mineId, ""),
    moveLabel: moveLabel(goal.move),
    rolls: goalRolls.get(goal.id) ?? null,
    focused: goal.mineId === mineId && goal.foeId === foeId && goal.move === selectedMove,
  })), [goals, memberEntry, moveLabel, goalRolls, mineId, foeId, selectedMove]);

  // -- solve ---------------------------------------------------------------------------------------

  // Pinned targets when there are any; otherwise the matchup on screen — every attacking move of the
  // selected opponent against our selected mon, at the verdict's hits and probability.
  const solvePlan = useMemo<Array<Omit<SolveEntry, "base">>>(() => goals.length
    ? goals.map(({ mineId: defender, foeId: attacker, move, hits: count, target: goal }) =>
      ({ mineId: defender, foeId: attacker, move, hits: count, target: goal }))
    : [...new Set(foe.moves.filter(isDamaging))].map((move) => ({
      mineId, foeId, move, hits, target,
    })), [goals, foe.moves, isDamaging, mineId, foeId, hits, target]);
  const contextSig = useMemo(() => contextSignature(teams, field, solvePlan),
    [teams, field, solvePlan]);

  const solveBlocked = !mineEntry || !foeEntry ? t("tune.ws.pickBoth")
    : !solvePlan.length ? t("tune.ws.solveNothing")
      : solvePlan.length > SOLVE_CAP ? t("tune.ws.solveTooMany").replace("{n}", String(SOLVE_CAP))
        : null;
  const solveDescription = goals.length
    ? t("tune.ws.solveGoals").replace("{n}", String(goals.length))
    : t("tune.ws.solveCurrent")
      .replace("{foe}", foeEntry ? displayName(foeEntry, lang) : "—")
      .replace("{n}", String(solvePlan.length))
      .replace("{mine}", mineEntry ? displayName(mineEntry, lang) : "—")
      .replace("{hits}", t(hits === 1 ? "tune.h1" : "tune.h2"))
      .replace("{target}", t(TARGET_LABEL[target]));

  const runSolve = async () => {
    if (solveBlocked) return;
    const nameOf = (mon: MonState) => dex.find((entry) => entry.slug === mon.slug)?.name;
    const pokemon = teams.a.flatMap((mon) => {
      const species = nameOf(mon);
      if (!species) return [];
      const spread: Record<string, number> = {};
      for (const key of STAT_KEYS) if (mon.sps[key]) spread[key] = mon.sps[key]!;
      return [{ species, moves: mon.moves.filter(Boolean), spread,
        ...(mon.item ? { item: mon.item } : {}),
        ...(mon.ability ? { ability: mon.ability } : {}),
        ...(mon.nature ? { nature: mon.nature } : {}) }];
    });
    const conditions: Record<string, unknown> = {};
    if (field.weather) conditions.weather = field.weather.toLowerCase();
    if (field.terrain) conditions.terrain = field.terrain.toLowerCase();
    const walls = field.sides.a;
    // Both walls up is Aurora Veil to the operator: it reduces either category, as the live calc does.
    const screens = walls.aurora_veil || (walls.reflect && walls.light_screen) ? "aurora_veil"
      : walls.reflect ? "reflect" : walls.light_screen ? "light_screen" : "";
    if (screens) conditions.screens = screens;

    const entries: SolveEntry[] = [];
    const benchmarks: Array<Record<string, unknown>> = [];
    for (const item of solvePlan) {
      const defender = findMon(teams, "a", item.mineId);
      const attacker = findMon(teams, "b", item.foeId);
      const member = defender && nameOf(defender);
      const vs = attacker && nameOf(attacker);
      if (!defender || !attacker || !member || !vs) continue;
      const attackerSet: Record<string, unknown> = {};
      if (attacker.ability) attackerSet.ability = attacker.ability;
      if (attacker.item) attackerSet.item = attacker.item;
      if (attacker.nature) attackerSet.nature = attacker.nature;
      if (attacker.status) attackerSet.status = attacker.status;
      const spread: Record<string, number> = {};
      for (const key of STAT_KEYS) if (attacker.sps[key]) spread[key] = attacker.sps[key]!;
      if (Object.keys(spread).length) attackerSet.spread = spread;
      const boosts: Record<string, number> = {};
      for (const key of BOOST_KEYS) if (attacker.boosts[key]) boosts[key] = attacker.boosts[key]!;
      if (Object.keys(boosts).length) attackerSet.boosts = boosts;
      // Our member's status and stat stages are conditions of the benchmark, solved as stated —
      // the same frame the live verdict above is computed in.
      const memberState: Record<string, unknown> = {};
      if (defender.status) memberState.status = defender.status;
      const stages: Record<string, number> = {};
      for (const key of BOOST_KEYS) if (defender.boosts[key]) stages[key] = defender.boosts[key]!;
      if (Object.keys(stages).length) memberState.boosts = stages;
      entries.push({ ...item, base: { sps: cloneSps(defender.sps), nature: defender.nature } });
      benchmarks.push({ member, kind: "survive", vs, move: item.move, hits: item.hits,
        probability: item.target, attacker_set: attackerSet,
        ...(Object.keys(memberState).length ? { member_state: memberState } : {}),
        ...(Object.keys(conditions).length ? { conditions } : {}) });
    }
    if (!benchmarks.length) return;
    const source = fill?.team && typeof fill.team === "object" ? fill.team as Record<string, unknown> : {};
    const team = { ...source, format: field.format as FormatId, pokemon };
    const sig = contextSig;
    setSolveBusy(true);
    setSolveError(null);
    try {
      const output = await adapter.tune(team, benchmarks);
      setRun({ entries, cards: output.cards, contextSig: sig });
    } catch (error) {
      console.error("durability solve failed:", error);
      setSolveError(t("calc.error"));
    } finally {
      setSolveBusy(false);
    }
  };

  const applySpread = useCallback((uid: string, spread: MonState["sps"], nature: string) => {
    updateMon(uid, (mon) => ({ ...mon, sps: { ...spread }, nature }));
    const at = teams.a.findIndex((mon) => mon.uid === uid);
    if (at >= 0) setActive((previous) => ({ ...previous, a: at }));
  }, [updateMon, teams.a, setActive]);

  const memberMon = useCallback((uid: string) => findMon(teams, "a", uid) ?? null, [teams]);

  const stripTeams = useMemo(() => ({ mine: teams.a, foe: teams.b }), [teams]);

  return (
    <div className="tw">
      {store.error && <div className="notice mono">{t("calc.error")}</div>}
      <TeamStrip teams={stripTeams} active={{ mine: mineIndex, foe: foeIndex }} field={shared}
        setField={setField} dex={dex} items={items} onActive={pickActive} onAdd={addMember}
        onRemove={removeMember} onReset={resetSide} onImport={importPaste} />

      <Verdict foe={foeEntry} mine={mineEntry} moveLabel={selectedMove ? moveLabel(selectedMove) : ""}
        rolls={selectedCell?.rolls ?? null} pending={!!selectedCell?.pending} state={verdictState}
        hits={hits} onHits={changeHits} target={target} onTarget={changeTarget}
        pinned={!!currentGoal} onTogglePin={togglePin} onSwap={swapSides} />

      <div className="tw-stage">
        <DefenderCard mon={mine} baseline={mineBaseline} dex={dex} natures={natures} items={items}
          format={field.format} pressed={pressedStat(selectedMove, moveVocab.get(selectedMove)?.category)}
          onSpecies={mineSpecies} onChange={changeMine} onPickBuild={minePick} onRestore={restoreMine} />
        <AttackerCard mon={foe} dex={dex} natures={natures} items={items} format={field.format}
          learnset={foeLearnset.status === "ready" ? foeLearnset.data : null}
          cells={cells} selectedSlot={selectedSlot} onSelectSlot={selectSlot}
          onSpecies={foeSpecies} onChange={changeFoe} onPickBuild={foePick} />
      </div>

      <TargetsPanel rows={targetRows}
        onRemove={(id) => setGoals((previous) => previous.filter((goal) => goal.id !== id))}
        onFocus={focusGoal} onClear={() => setGoals([])}
        solve={{
          available: can("team.tune"), busy: solveBusy, description: solveDescription,
          blocked: solveBlocked, error: solveError, onSolve: () => void runSolve(),
        }}
        run={run} stale={!!run && run.contextSig !== contextSig}
        preset={formatProbability(targetProbability(target))}
        natures={natures} memberOf={memberMon} entryOf={memberEntry} moveLabelOf={moveLabel}
        onApply={applySpread} />
    </div>
  );
}
