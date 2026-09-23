/** The roster every calc tool shares.
 *
 * Both teams with their builds, which mon each side has up, each side's selected move, and the
 * battle frame (format, weather, terrain, side conditions) live here, above the tabs, so a team
 * built or edited in one tool is the team the next tool opens on. Side "a" is ours (the
 * calculator's 我方队伍, the bulk tool's defender), side "b" the opponents'. Tools keep only their
 * own reading state locally — the calculator's roll and crit, the bulk tool's targets — and derive
 * whatever narrower view they need (the bulk tool reads only the conditions its solver carries).
 *
 * The environment auto-fill runs here too, once for every tool: two tools filling the same slot
 * would race each other and double the lookups.
 *
 * A future tool (the speed line) joins by reading `useRoster()` and mapping `MonState` onto its own
 * row shape; `swaps` tells any tool when the two sides changed places. */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type Dispatch, type ReactNode, type SetStateAction,
} from "react";
import { markTuneFillApplied, readTeamMembers, takeCalcTeams, takeTuneFill,
  type CalcMember } from "../../lib/team.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { autofillSig, sideIsBare, useBuildOptions } from "./shared.tsx";
import { TEAM_MAX } from "./duel/TeamBar.tsx";
import { loadRoster, saveRoster, type RosterSnapshot } from "./duel/persist.ts";
import {
  EMPTY_FIELD, applyBuildOption, makeMon, withMoves, type FieldState, type MonState, type SideId,
} from "./duel/state.ts";

type PerSide<T> = Record<SideId, T>;
const SIDES: SideId[] = ["a", "b"];

export interface RosterApi {
  teams: PerSide<MonState[]>;
  active: PerSide<number>;
  /** Each side's selected move slot (the move that side's result reads). */
  slot: PerSide<number>;
  field: FieldState;
  /** Increments on every `swapSides()`; tools reset side-bound view state when it changes. */
  swaps: number;
  setTeams: Dispatch<SetStateAction<PerSide<MonState[]>>>;
  setActive: Dispatch<SetStateAction<PerSide<number>>>;
  setSlot: Dispatch<SetStateAction<PerSide<number>>>;
  setField: Dispatch<SetStateAction<FieldState>>;
  /** Attack and defence change places: teams, who is up, selected moves and side conditions. */
  swapSides: () => void;
}

const RosterContext = createContext<RosterApi | null>(null);

export function useRoster(): RosterApi {
  const roster = useContext(RosterContext);
  if (!roster) throw new Error("useRoster outside RosterProvider");
  return roster;
}

function fromCalcMember(member: CalcMember, dex: DexIndexEntry[]): MonState {
  // A member may name its species instead of a slug (a team-json carries canonical names); the dex
  // the page already holds is the resolver, so the hand-off never has to slugify by hand.
  const slug = member.slug ?? (member.species ? dex.find((e) => e.name === member.species)?.slug ?? "" : "");
  return withMoves({
    ...makeMon(slug), pinned: member.pinned === true,
    ability: member.ability ?? "", item: member.item ?? "", nature: member.nature ?? "",
    sps: (member.sps ?? {}) as MonState["sps"],
  }, member.moves ?? []);
}

/** Where the roster starts: an explicit hand-off outranks the saved workspace, which outranks the
 * demo pair. The calculator's hand-off names both teams; a build session's hand-off names ours. */
function initialRoster(dex: DexIndexEntry[]): RosterSnapshot {
  const saved = loadRoster();
  const base: RosterSnapshot = saved ?? {
    teams: { a: [makeMon("garchomp")], b: [makeMon("mimikyu")] },
    active: { a: 0, b: 0 }, slot: { a: 0, b: 0 },
    field: { ...EMPTY_FIELD, sides: { a: {}, b: {} } },
  };
  const calcFill = takeCalcTeams();
  if (calcFill) {
    const side = (list: CalcMember[]): MonState[] =>
      list.length ? list.slice(0, TEAM_MAX).map((member) => fromCalcMember(member, dex)) : [makeMon()];
    return {
      teams: { a: side(calcFill.attackers), b: side(calcFill.defenders) },
      active: { a: 0, b: 0 }, slot: { a: 0, b: 0 },
      field: { ...EMPTY_FIELD, format: calcFill.format, sides: { a: {}, b: {} } },
    };
  }
  const tuneFill = takeTuneFill();
  if (tuneFill && !tuneFill.applied) {
    const ours = readTeamMembers(tuneFill.team).flatMap((member) => {
      if (!dex.some((entry) => entry.name === member.species)) return [];
      return [fromCalcMember({
        species: member.species, pinned: true,
        ability: member.ability ?? undefined, item: member.item ?? undefined,
        nature: member.nature ?? undefined, sps: member.spread ?? undefined, moves: member.moves,
      }, dex)];
    }).slice(0, TEAM_MAX);
    markTuneFillApplied();
    if (ours.length) {
      const format = (tuneFill.team as { format?: unknown } | null)?.format === "double" ? "double" : "single";
      return { ...base, teams: { ...base.teams, a: ours }, active: { ...base.active, a: 0 },
        field: { ...base.field, format } };
    }
  }
  return base;
}

export function RosterProvider({ dex, children }: { dex: DexIndexEntry[]; children: ReactNode }) {
  const [initial] = useState(() => initialRoster(dex));
  const [teams, setTeams] = useState(initial.teams);
  const [active, setActive] = useState(initial.active);
  const [slot, setSlot] = useState(initial.slot);
  const [field, setField] = useState(initial.field);
  const [swaps, setSwaps] = useState(0);
  const loadBuildOptions = useBuildOptions();

  useEffect(() => {
    saveRoster({ teams, active, slot, field });
  }, [teams, active, slot, field]);

  // Observed-build-first environment auto-fill. A fresh pick is seeded from the first card (the
  // highest-share joint configuration, Meta only without an aggregate). A FORMAT switch re-seeds
  // only mons still carrying an untouched auto-fill; hand-edited and handed-over (pinned) builds
  // are never overwritten.
  const fillTokens = useRef(new Set<string>());
  const seedable = (mon: MonState) =>
    sideIsBare(mon) || (mon.autoSig != null && autofillSig(mon, mon.moves) === mon.autoSig);
  useEffect(() => {
    for (const side of SIDES) {
      for (const mon of teams[side]) {
        if (!mon.slug || mon.pinned || !seedable(mon)) continue;
        // One attempt per (format, mon, species): once seeded, a re-run must not fire a second fill
        // just because the build now matches its own signature.
        const token = `${field.format}:${mon.uid}:${mon.slug}`;
        if (fillTokens.current.has(token)) continue;
        fillTokens.current.add(token);
        void loadBuildOptions(mon.slug, field.format).then((options) => {
          const option = options[0];
          if (!option) return;
          // Re-check at APPLY time: the mon may have moved sides (a swap), changed species or been
          // edited while the lookup was in flight.
          setTeams((previous) => {
            for (const at of SIDES) {
              const index = previous[at].findIndex((candidate) => candidate.uid === mon.uid);
              const current = previous[at][index];
              if (!current) continue;
              if (current.slug !== mon.slug || current.pinned || !seedable(current)) return previous;
              const next = [...previous[at]];
              next[index] = applyBuildOption(current, option, 0, true);
              return { ...previous, [at]: next };
            }
            return previous;
          });
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.format, teams]);

  const swapSides = useCallback(() => {
    setTeams((current) => ({ a: current.b, b: current.a }));
    setActive((current) => ({ a: current.b, b: current.a }));
    setSlot((current) => ({ a: current.b, b: current.a }));
    // A screen belongs to the side that set it, so it travels with that team.
    setField((current) => ({ ...current, sides: { a: current.sides.b, b: current.sides.a } }));
    setSwaps((count) => count + 1);
  }, []);

  const value = useMemo<RosterApi>(() => ({
    teams, active, slot, field, swaps, setTeams, setActive, setSlot, setField, swapSides,
  }), [teams, active, slot, field, swaps, swapSides]);
  return <RosterContext.Provider value={value}>{children}</RosterContext.Provider>;
}
