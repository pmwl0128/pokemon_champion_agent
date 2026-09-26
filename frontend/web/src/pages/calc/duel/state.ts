/** State model for the two-team damage workspace.
 *
 * The calculator asks about ONE turn between two sides, so everything here is expressed per side
 * rather than per role: side A holds the "attacker team", side B the "defender team", and a
 * calculation names a DIRECTION over them. That is what makes the reverse card (B hitting A) and the
 * bottom all-pairs grid (either axis) reuse exactly the same field, without a second flag vocabulary
 * that could drift from the forward one.
 *
 * `SideState` (shared.tsx) stays untouched — the speed and tune tabs build on it — and `MonState`
 * only adds what a full combatant needs: its four move slots, its current HP, and an explicit
 * ability-trigger answer. */
import type {
  CombatantDto, DamageRequestDto, FieldDto, FormatId, NatureDto, Terrain, Weather,
} from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { actualStat } from "../../../lib/stats.ts";
import type { DexIndexEntry } from "../../../runtime/adapter.ts";
import type { ItemRef } from "../../../runtime/projection.ts";
import {
  BOOST_KEYS, EMPTY_SIDE, buildConfigSig, modalSig, withMega, type BuildOption, type SideState,
} from "../shared.tsx";

export const MOVE_SLOTS = 4;

export interface BuildReference {
  key: string;
  source: "aggregate" | "meta";
  coverage: number | null;
  isModal: boolean;
  labelIndex: number;
  /** Exact item/ability/nature/SP/move signature at the time this card was applied. */
  signature: string;
}

export interface MonState extends SideState {
  /** Stable identity of this roster slot's Pokémon across tools and edits. A new species is a new
   * Pokémon (`makeMon` issues a fresh uid); editing a build, or swapping sides, keeps it. Tools key
   * what they remember about a mon — the bulk tool's targets and loaded spread — on it. */
  uid: string;
  /** Four fixed slots; "" is an empty slot, so a move keeps its position while you edit around it. */
  moves: string[];
  /** null = at full health. Stored as an absolute value, like the engine's `curHP`. */
  curHP: number | null;
  /** null = let the engine apply its own default for this ability. */
  abilityOn: boolean | null;
  /** The signature this build would carry right after an environment auto-fill (null once never filled).
   * It is what tells an untouched auto-fill apart from a build the user actually chose, so a format
   * switch can re-seed the first and must leave the second alone. */
  autoSig: string | null;
  /** Environment-card identity while the live build still matches that card exactly. */
  buildRef: BuildReference | null;
  /** Handed over from another page with only the fields someone actually picked. The auto-fill
   * skips these: the empty slots ARE the answer, and filling them from usage would replace a
   * deliberate blank with a build nobody chose. */
  pinned: boolean;
}

export const EMPTY_MON: MonState = {
  ...EMPTY_SIDE, uid: "", moves: ["", "", "", ""], curHP: null, abilityOn: null, autoSig: null,
  buildRef: null, pinned: false,
};

let uidSerial = 0;
const uidSession = Math.random().toString(36).slice(2, 8);
/** Unique within the browser session and across reloads of a persisted roster. */
export const newMonUid = (): string => `m-${uidSession}-${(++uidSerial).toString(36)}`;

export function makeMon(slug = ""): MonState {
  return { ...EMPTY_MON, uid: newMonUid(), slug, moves: ["", "", "", ""], sps: {}, boosts: {} };
}

export function withMoves(mon: MonState, moves: string[]): MonState {
  const slots = [...moves.slice(0, MOVE_SLOTS)];
  while (slots.length < MOVE_SLOTS) slots.push("");
  return { ...mon, moves: slots };
}

/** Apply one environment card. Only an automatic seed carries `autoSig`: a card the user explicitly
 * chose must survive a later format switch and must never be replaced by the first card. */
export function applyBuildOption(
  mon: MonState, option: BuildOption, labelIndex = 0, automatic = false,
): MonState {
  const m = option.modal;
  const next = withMoves(
    { ...mon, ability: m.ability, item: m.item, nature: m.nature, sps: { ...m.sps } },
    m.moves.length ? m.moves : mon.moves);
  return {
    ...next,
    autoSig: automatic ? modalSig(m, next.moves) : null,
    buildRef: {
      key: option.key,
      source: option.source,
      coverage: option.coverage,
      isModal: option.isModal,
      labelIndex,
      signature: buildConfigSig(next),
    },
  };
}

/** Abilities the calc ships toggled OFF because their trigger is invisible to a single damage frame,
 * so "it went off" is the caller's statement rather than a default. This copy only decides when the
 * page OFFERS the switch — `ncp-calc-api.js` ABILITY_TOGGLE_OFF owns the behaviour, and if the two
 * ever drift the cost is a switch that is not offered, never a number computed from a wrong flag. */
export const ABILITY_NEEDS_TRIGGER = new Set([
  "Flash Fire", "Plus", "Minus", "Trace", "Stakeout", "Sand Spit", "Battle Bond",
  "Electromorphosis", "Wind Power", "Seed Sower",
]);

/** Side identity. "a" holds the attacker team, "b" the defender team; a direction is (from, to). */
export type SideId = "a" | "b";
export const otherSide = (side: SideId): SideId => (side === "a" ? "b" : "a");

// -- stats --------------------------------------------------------------------------------

export function natureMult(natures: NatureDto[], nature: string,
                           key: (typeof STAT_KEYS)[number]): 0.9 | 1 | 1.1 {
  if (key === "hp") return 1;
  const n = natures.find((x) => x.name === nature);
  if (!n) return 1;
  if (n.upStat === key && n.downStat !== key) return 1.1;
  if (n.downStat === key && n.upStat !== key) return 0.9;
  return 1;
}

/** The dex entry the engine will actually calculate: a held Mega stone substitutes the Mega form,
 * whose base stats (and legal ability) are what the numbers must come from. */
export function effectiveEntry(mon: MonState, dex: DexIndexEntry[],
                               items: ItemRef[]): DexIndexEntry | undefined {
  return withMega(mon, dex, items).entry;
}

export function maxHPOf(mon: MonState, dex: DexIndexEntry[], items: ItemRef[]): number {
  const entry = effectiveEntry(mon, dex, items);
  if (!entry) return 0;
  return actualStat(entry.stats.hp, "hp", mon.sps.hp ?? 0, 1);
}

/** Current HP, resolved against this build's maximum. A spread edit that lowers max HP below a
 * pinned current value must not report more HP than the mon has. */
export function curHPOf(mon: MonState, maxHP: number): number {
  if (mon.curHP == null) return maxHP;
  return Math.max(1, Math.min(maxHP, mon.curHP));
}

export function finalStat(mon: MonState, entry: DexIndexEntry | undefined, natures: NatureDto[],
                          key: (typeof STAT_KEYS)[number]): number {
  if (!entry) return 0;
  return actualStat(entry.stats[key], key, mon.sps[key] ?? 0, natureMult(natures, mon.nature, key));
}

// -- field --------------------------------------------------------------------------------

/** Abilities that set the field on entry. The calc models weather and terrain as FIELD input, not as
 * something an ability does on its own, so a Rillaboom with Grassy Surge computes on bare ground
 * unless the terrain is set. Rather than silently setting it — the mon may not be the one that led —
 * the page offers it as a one-click suggestion beside the picker.
 *
 * Only the ones on the Champions roster are listed; an ability the shipped dex does not carry would
 * be an offer that can never appear. */
export const WEATHER_ABILITIES: Record<string, Weather> = {
  Drought: "Sun", Drizzle: "Rain", "Sand Stream": "Sand", "Snow Warning": "Snow",
};
export const TERRAIN_ABILITIES: Record<string, Terrain> = {
  "Grassy Surge": "Grassy", "Electric Surge": "Electric", "Psychic Surge": "Psychic",
};

/** Every side flag the Champions handler actually reads, and nothing else.
 *
 * Deliberately short: the vendored engine carries a much longer list of side flags inherited from
 * older generations (Protect quartering, Leech Seed, Steelsurge, the Ruin abilities, Magic/Wonder
 * Room), and for gen-10 Champions those are never consulted. Offering them would put checkboxes on
 * the page that silently change nothing — worse than not offering them at all.
 *
 * `cat` is what the flag DOES to the numbers (cuts damage taken, raises damage dealt, changes
 * turn order, chips on entry); the team strip colours its chips by it so a row of five reads at a
 * glance without spelling each one out. */
export type SideFlagCategory = "wall" | "boost" | "speed" | "hazard";

export const SIDE_FLAGS: Array<{
  key: string; label: string; cat: SideFlagCategory; doublesOnly?: boolean; hint?: string;
}> = [
  { key: "reflect", label: "calc.reflect", cat: "wall" },
  { key: "light_screen", label: "calc.lightScreen", cat: "wall" },
  { key: "aurora_veil", label: "calc.auroraVeil", cat: "wall" },
  { key: "friend_guard", label: "calc.friendGuard", cat: "wall", doublesOnly: true },
  { key: "helping_hand", label: "calc.helpingHand", cat: "boost", doublesOnly: true },
  { key: "battery", label: "calc.battery", cat: "boost", doublesOnly: true },
  { key: "power_spot", label: "calc.powerSpot", cat: "boost", doublesOnly: true },
  { key: "steely_spirit", label: "calc.steelySpirit", cat: "boost", doublesOnly: true },
  { key: "charge", label: "calc.charge", cat: "boost", hint: "calc.chargeHint" },
  { key: "tailwind", label: "calc.tailwind", cat: "speed", hint: "calc.tailwindHint" },
  { key: "stealth_rock", label: "calc.stealthRock", cat: "hazard", hint: "calc.stealthRockHint" },
];

export type SideFlags = Record<string, boolean>;

export interface FieldState {
  format: FormatId;
  weather: Weather | "";
  terrain: Terrain | "";
  gravity: boolean;
  foresight: boolean;
  /** Resolve Intimidate / Supersweet Syrup between the two sides. On by default: a one-off damage
   * question is asked about a real switch-in. */
  switchInDrops: boolean;
  /** Field-wide, read by the speed line only: it changes no speed, it reverses who moves first. */
  trickRoom: boolean;
  sides: Record<SideId, SideFlags>;
}

export const EMPTY_FIELD: FieldState = {
  format: "single", weather: "", terrain: "", gravity: false, foresight: false,
  switchInDrops: true, trickRoom: false, sides: { a: {}, b: {} },
};

/** The field-wide switches. Each tool's console offers only the ones its numbers read. */
export type SharedFlagKey = "gravity" | "foresight" | "switchInDrops" | "trickRoom";

function liveFlags(flags: SideFlags, format: FormatId): SideFlags {
  const out: SideFlags = {};
  for (const flag of SIDE_FLAGS) {
    if (flag.doublesOnly && format === "single") continue;
    if (flags[flag.key]) out[flag.key] = true;
  }
  return out;
}

/** The FieldDto for one direction. Offensive flags ride on the attacking side's record and
 * defensive ones on the defending side's; the calc merges them the same way for every request, so a
 * reversed direction is just the two records swapped. */
export function fieldFor(field: FieldState, from: SideId): FieldDto {
  const attackerSide = liveFlags(field.sides[from], field.format);
  const defenderSide = liveFlags(field.sides[otherSide(from)], field.format);
  return {
    format: field.format,
    ...(field.weather ? { weather: field.weather } : {}),
    ...(field.terrain ? { terrain: field.terrain } : {}),
    ...(field.gravity ? { gravity: true } : {}),
    ...(field.foresight ? { foresight: true } : {}),
    ...(Object.keys(attackerSide).length ? { attackerSide } : {}),
    ...(Object.keys(defenderSide).length ? { defenderSide } : {}),
  };
}

// -- combatants ---------------------------------------------------------------------------

export interface MoveOptions {
  crit?: boolean;
  /** false = this spread move hits ONE target, so it keeps full power. */
  singleTarget?: boolean;
}

/** CombatantDto for the calc: only non-default fields are sent, so the engine keeps applying its
 * own defaults for everything the user has not actually decided. */
export function combatantOf(mon: MonState, dex: DexIndexEntry[], items: ItemRef[],
                            move?: { name: string; options?: MoveOptions }): CombatantDto | null {
  const { state, entry } = withMega(mon, dex, items);
  if (!entry) return null;
  const sps: Record<string, number> = {};
  for (const k of STAT_KEYS) if (state.sps[k]) sps[k] = state.sps[k]!;
  const boosts: Record<string, number> = {};
  for (const k of BOOST_KEYS) if (state.boosts[k]) boosts[k] = state.boosts[k]!;
  const maxHP = actualStat(entry.stats.hp, "hp", mon.sps.hp ?? 0, 1);
  const cur = curHPOf(mon, maxHP);
  return {
    name: entry.name,
    ...(state.ability ? { ability: state.ability } : {}),
    ...(state.item ? { item: state.item } : {}),
    ...(state.nature ? { nature: state.nature } : {}),
    ...(Object.keys(sps).length ? { sps } : {}),
    ...(state.status ? { status: state.status as CombatantDto["status"] } : {}),
    ...(Object.keys(boosts).length ? { boosts } : {}),
    ...(cur < maxHP ? { curHP: cur } : {}),
    ...(mon.abilityOn === null ? {} : { abilityOn: mon.abilityOn }),
    // The move slot carries the per-turn overrides. Only the slot named by `move` is read, so one
    // entry is enough — and sending it unconditionally would change nothing but the payload size.
    ...(move && (move.options?.crit || move.options?.singleTarget)
      ? { moves: [{
          name: move.name,
          ...(move.options.crit ? { isCrit: true } : {}),
          ...(move.options.singleTarget ? { isSpread: false } : {}),
        }] }
      : {}),
  };
}

export function damageRequest(
  attacker: MonState, defender: MonState, moveName: string, field: FieldState, from: SideId,
  dex: DexIndexEntry[], items: ItemRef[], options?: MoveOptions,
): DamageRequestDto | null {
  const a = combatantOf(attacker, dex, items, { name: moveName, options });
  const d = combatantOf(defender, dex, items);
  if (!a || !d || !moveName) return null;
  return {
    attacker: a, defender: d, move: moveName, field: fieldFor(field, from),
    ...(field.switchInDrops ? {} : { switch_in_drops: false }),
  };
}

// -- rolls --------------------------------------------------------------------------------

/** A roll pick is an INDEX into the engine's sorted 16, not one of three names.
 *
 * Every one of the sixteen is a number the game can actually deal, so the reader is entitled to any
 * of them; the three buttons are simply the three indices worth a name. That is also why a pick in
 * between leaves all three unpressed — there is no mode to highlight, and pretending otherwise would
 * claim the slider sits somewhere it does not. */
export const ROLL_COUNT = 16;
export const ROLL_TOP = ROLL_COUNT - 1;

export type RollMode = "low" | "mid" | "high";
export const ROLL_MODES: RollMode[] = ["low", "mid", "high"];

/** The index a named mode picks. `mid` is the middle ROLL, not a mean. */
export function rollIndexOf(mode: RollMode, count = ROLL_COUNT): number {
  if (count <= 1) return 0;
  if (mode === "low") return 0;
  if (mode === "high") return count - 1;
  return Math.floor(count / 2);
}

/** The mode this index is, or null when it is one of the rolls in between. */
export function rollModeAt(index: number, count = ROLL_COUNT): RollMode | null {
  return ROLL_MODES.find((mode) => rollIndexOf(mode, count) === index) ?? null;
}

/** The game's integer random modifier represented by one sorted roll: the normal sixteen slots are
 * exactly 85..100. Keeping the mapping separate from damage means the slider tooltip reports the
 * random factor the user selected, even when adjacent factors happen to round to equal damage. */
export function rollModifier(index: number, count = ROLL_COUNT): number {
  if (count <= 1) return 100;
  const clamped = Math.max(0, Math.min(count - 1, Math.trunc(index)));
  return 85 + Math.round((clamped * 15) / (count - 1));
}

/** One roll out of the sorted list, by index — clamped, because a result with fewer rolls (a status
 * move, an immunity) must not be read past the end of its own array. */
export function rollValue(damage: number[], index: number): number {
  if (!damage.length) return 0;
  return damage[Math.max(0, Math.min(damage.length - 1, Math.trunc(index)))]!;
}

/** A stat after its boost stage, applied the way the game applies it: a rational multiplier, floored
 * — +1 is x3/2 and -1 is x2/3, never a rounded percentage. HP has no stage, so it comes back
 * unchanged and the caller does not have to special-case it. */
export function boostedStat(value: number, stage: number): number {
  const s = Math.max(-6, Math.min(6, Math.trunc(stage)));
  if (!s) return value;
  return s > 0 ? Math.floor((value * (2 + s)) / 2) : Math.floor((value * 2) / (2 - s));
}
