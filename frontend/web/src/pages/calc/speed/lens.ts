/** The speed line's view of the shared roster: which facts of a Pokémon and of the field move its
 * final Speed, how a speed preset rewrites a build, and how far a build is from a given line.
 *
 * Everything here is pure so the rules are pinned by tests rather than by the page. The numbers
 * themselves always come from the NCP speed engine; this module only decides what to ask it. */
import type { NatureDto, SpeedInputDto, Status } from "@pokemon-champions/protocol";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import { withMega } from "../shared.tsx";
import type { FieldState, MonState, SideId } from "../duel/state.ts";

export const SCARF = "Choice Scarf";
export const SP_MAX = 32;
export const SP_BUDGET = 66;

/** The only side condition that moves a Speed number. Screens, Helping Hand, Stealth Rock and the
 * rest change damage, never turn order, so the speed line does not show them at all. */
export const SPEED_SIDE_FLAGS: ReadonlySet<string> = new Set(["tailwind"]);

export type Tier = "max" | "fast" | "none" | "min";
export const TIER_KEYS: Tier[] = ["max", "fast", "none", "min"];
/** Every Champions individual value is fixed at 31, so the four investment tiers differ only by
 * nature direction and SP: 最速 (+spe, 32), 準速 (neutral, 32), 無振 (neutral, 0), 最慢 (−spe, 0). */
export type Dir = "+" | "0" | "-";
export const TIER_SPEC: Record<Tier, { dir: Dir; sp: number }> = {
  max: { dir: "+", sp: SP_MAX },
  fast: { dir: "0", sp: SP_MAX },
  none: { dir: "0", sp: 0 },
  min: { dir: "-", sp: 0 },
};

type NatureStat = "atk" | "def" | "spa" | "spd" | "spe";
export type Offense = "atk" | "spa";

/** The neutral nature the page sends when a build has none. The engine's own default is Timid,
 * which would silently compute every unset nature as +Speed. */
export function neutralNature(natures: NatureDto[]): string {
  return natures.find((n) => n.name === "Serious")?.name
    ?? natures.find((n) => !n.upStat || n.upStat === n.downStat)?.name
    ?? "Serious";
}

function natureParts(nature: NatureDto | undefined): { up: NatureStat | null; down: NatureStat | null } {
  if (!nature || !nature.upStat || !nature.downStat || nature.upStat === nature.downStat) {
    return { up: null, down: null };
  }
  return { up: nature.upStat as NatureStat, down: nature.downStat as NatureStat };
}

function natureNamed(natures: NatureDto[], up: NatureStat | null, down: NatureStat | null): string {
  if (!up || !down || up === down) return neutralNature(natures);
  return natures.find((n) => n.upStat === up && n.downStat === down)?.name ?? neutralNature(natures);
}

/** The Speed direction a nature has: +, 0 or −. */
export function natureDir(natures: NatureDto[], name: string): Dir {
  const { up, down } = natureParts(natures.find((n) => n.name === name));
  return up === "spe" ? "+" : down === "spe" ? "-" : "0";
}

/** A speed preset rewrites only the Speed half of a nature. The other half belongs to the build's
 * damage and bulk, which the calculator reads from the same roster: a 最速 preset on an Adamant
 * attacker must land on Jolly, not on whichever +Speed nature happens to be listed first.
 *
 * - "+": raise Speed; keep the current lowered stat unless it IS Speed, then lower the weaker
 *   attacking stat.
 * - "-": lower Speed; keep the current raised stat unless it IS Speed, then raise the stronger one.
 * - "0": neutral Speed; a raised Speed becomes the stronger attacking stat, a lowered Speed the
 *   weaker one, and the other half stays. */
export function speedNature(natures: NatureDto[], current: string, dir: Dir, offense: Offense): string {
  const strong: NatureStat = offense;
  const weak: NatureStat = offense === "atk" ? "spa" : "atk";
  let { up, down } = natureParts(natures.find((n) => n.name === current));
  if (dir === "+") {
    if (up === "spe") return current;
    up = "spe";
    if (!down || down === "spe") down = weak;
  } else if (dir === "-") {
    if (down === "spe") return current;
    down = "spe";
    if (!up || up === "spe") up = strong;
  } else {
    if (up === "spe") up = strong;
    else if (down === "spe") down = weak;
    else return current || neutralNature(natures);
  }
  return natureNamed(natures, up, down);
}

/** Which attacking stat the build leans on: by its damaging moves, then by base stats. */
export function offenseOf(mon: MonState, entry: DexIndexEntry | undefined,
                          category: (move: string) => string | undefined): Offense {
  let physical = 0;
  let special = 0;
  for (const move of mon.moves) {
    const kind = move ? category(move) : undefined;
    if (kind === "Physical") physical += 1;
    else if (kind === "Special") special += 1;
  }
  if (physical !== special) return physical > special ? "atk" : "spa";
  return entry && entry.stats.spa > entry.stats.atk ? "spa" : "atk";
}

/** The tier a build currently sits on, or null for anything in between. */
export function tierOf(natures: NatureDto[], mon: MonState): Tier | null {
  const dir = natureDir(natures, mon.nature);
  const sp = mon.sps.spe ?? 0;
  return TIER_KEYS.find((tier) => TIER_SPEC[tier].dir === dir && TIER_SPEC[tier].sp === sp) ?? null;
}

export function applyTier(mon: MonState, tier: Tier, natures: NatureDto[], offense: Offense): MonState {
  const spec = TIER_SPEC[tier];
  return {
    ...mon,
    nature: speedNature(natures, mon.nature, spec.dir, offense),
    sps: { ...mon.sps, spe: spec.sp },
  };
}

export const spTotal = (sps: MonState["sps"]): number =>
  Object.values(sps).reduce<number>((sum, value) => sum + (value ?? 0), 0);

/** The engine input for one roster Pokémon. Returns null for an empty slot.
 *
 * - A held Mega stone computes the Mega form (the engine does not auto-Mega).
 * - An empty nature is sent as a neutral one and an unset Speed SP as 0: the engine's defaults
 *   (Timid, 32) would otherwise turn every half-filled build into a max-Speed one.
 * - Unburden counts only once the user says it fired (the calculator's ability-trigger switch);
 *   then the item is sent as consumed. An unset item is not a consumed one.
 * - Weather and terrain are field-wide; Tailwind is read from this Pokémon's own side. */
export function speedInputOf(mon: MonState, field: FieldState, side: SideId | null,
                             dex: DexIndexEntry[], items: ItemRef[], neutral: string): SpeedInputDto | null {
  const { state, entry } = withMega(mon, dex, items);
  if (!entry) return null;
  let ability: string | undefined = state.ability || undefined;
  let item = state.item;
  if (ability === "Unburden") {
    if (mon.abilityOn === true) item = "";
    else if (!item) ability = undefined;
  }
  const spe = Math.max(0, Math.min(SP_MAX, Math.trunc(state.sps.spe ?? 0)));
  const tailwind = side ? !!field.sides[side].tailwind : false;
  const fieldPart = {
    ...(field.weather ? { weather: field.weather } : {}),
    ...(field.terrain ? { terrain: field.terrain } : {}),
    ...(tailwind ? { tailwind: true } : {}),
  };
  return {
    name: entry.name,
    nature: state.nature || neutral,
    sps: { spe },
    ...(state.boosts.spe ? { boosts: { spe: state.boosts.spe } } : {}),
    ...(ability ? { ability } : {}),
    ...(item ? { item } : {}),
    ...(state.status ? { status: state.status as Status } : {}),
    ...(Object.keys(fieldPart).length ? { field: fieldPart } : {}),
  };
}

/** Who moves first between my Speed and a line's: under Trick Room the slower one does. */
export const movesFirst = (mine: number, line: number, trickRoom: boolean): boolean =>
  trickRoom ? mine < line : mine > line;

/** The Speed SP that makes this build move before `line`, read off a curve of final Speeds indexed
 * by SP (0..32, non-decreasing). Without Trick Room that is the smallest SP that is faster; under it
 * the largest SP that is slower. null when no SP on this curve gets there. */
export function spToBeat(curve: Array<number | null>, line: number, trickRoom: boolean): number | null {
  if (!trickRoom) {
    for (let sp = 0; sp < curve.length; sp += 1) {
      const speed = curve[sp];
      if (speed != null && speed > line) return sp;
    }
    return null;
  }
  for (let sp = curve.length - 1; sp >= 0; sp -= 1) {
    const speed = curve[sp];
    if (speed != null && speed < line) return sp;
  }
  return null;
}
