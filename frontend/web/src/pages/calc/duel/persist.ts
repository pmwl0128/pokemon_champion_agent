/** Session-scoped memory for the damage workspace.
 *
 * Navigating to another page unmounts the tab, and rebuilding two teams by hand afterwards is not a
 * reasonable price for looking something up in the dex. Only INPUT is kept — every number on the
 * page is recomputed from it — so a stale snapshot can never show a result that no longer follows
 * from the build beside it.
 *
 * sessionStorage, not localStorage: this is scratch work for the current sitting, the same choice
 * the team hand-offs in lib/team.ts make. */
import {
  EMPTY_FIELD, EMPTY_MON, ROLL_COUNT, ROLL_TOP, rollIndexOf,
  type FieldState, type MonState, type SideId,
} from "./state.ts";

const KEY = "pc-calc-duel-v1";

export interface DuelSnapshot {
  teams: Record<SideId, MonState[]>;
  active: Record<SideId, number>;
  slot: Record<SideId, number>;
  /** Index into the engine's sorted 16 rolls. */
  roll: Record<SideId, number>;
  crit: Record<SideId, boolean>;
  single: Record<SideId, boolean>;
  gridFrom: SideId;
  field: FieldState;
}

const SIDES: SideId[] = ["a", "b"];

function readMon(raw: unknown): MonState | null {
  if (raw === null || typeof raw !== "object") return null;
  const m = raw as Partial<MonState>;
  if (typeof m.slug !== "string") return null;
  const moves = Array.isArray(m.moves)
    ? m.moves.filter((x): x is string => typeof x === "string").slice(0, 4) : [];
  while (moves.length < 4) moves.push("");
  const buildRefRaw = m.buildRef && typeof m.buildRef === "object"
    ? m.buildRef as Partial<NonNullable<MonState["buildRef"]>> : null;
  const buildRef = buildRefRaw
    && typeof buildRefRaw.key === "string"
    && (buildRefRaw.source === "aggregate" || buildRefRaw.source === "meta")
    && typeof buildRefRaw.signature === "string"
    ? {
        key: buildRefRaw.key,
        source: buildRefRaw.source,
        coverage: typeof buildRefRaw.coverage === "number" ? buildRefRaw.coverage : null,
        isModal: buildRefRaw.isModal === true,
        labelIndex: typeof buildRefRaw.labelIndex === "number"
          ? Math.max(0, Math.floor(buildRefRaw.labelIndex)) : 0,
        signature: buildRefRaw.signature,
      }
    : null;
  return {
    ...EMPTY_MON,
    slug: m.slug,
    ability: typeof m.ability === "string" ? m.ability : "",
    item: typeof m.item === "string" ? m.item : "",
    nature: typeof m.nature === "string" ? m.nature : "",
    status: typeof m.status === "string" ? m.status : "",
    sps: m.sps && typeof m.sps === "object" ? { ...m.sps } : {},
    boosts: m.boosts && typeof m.boosts === "object" ? { ...m.boosts } : {},
    curHP: typeof m.curHP === "number" ? m.curHP : null,
    abilityOn: typeof m.abilityOn === "boolean" ? m.abilityOn : null,
    autoSig: typeof m.autoSig === "string" ? m.autoSig : null,
    buildRef,
    pinned: m.pinned === true,
    moves,
  };
}

const side = (raw: unknown): SideId => (raw === "b" ? "b" : "a");
const index = (raw: unknown, max: number): number =>
  (typeof raw === "number" && raw >= 0 && raw < max ? Math.floor(raw) : 0);
/** Snapshots written before the roll became a slider stored the mode name; map those onto the
 * index they meant rather than throwing the whole workspace away over one field. */
const rollIndex = (raw: unknown): number => {
  if (raw === "low" || raw === "mid" || raw === "high") return rollIndexOf(raw);
  return typeof raw === "number" && raw >= 0 && raw < ROLL_COUNT ? Math.floor(raw) : ROLL_TOP;
};

/** Lenient by design: a snapshot from an older shape must degrade to "no snapshot", never to a
 * half-restored workspace whose fields disagree with each other. */
export function loadDuel(): DuelSnapshot | null {
  let raw: unknown;
  try {
    const text = sessionStorage.getItem(KEY);
    if (!text) return null;
    raw = JSON.parse(text);
  } catch {
    return null;   // storage blocked, or not JSON — start fresh
  }
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const teamsRaw = s.teams as Record<string, unknown> | undefined;
  if (!teamsRaw) return null;
  const teams = {} as Record<SideId, MonState[]>;
  for (const id of SIDES) {
    const list = Array.isArray(teamsRaw[id]) ? (teamsRaw[id] as unknown[]) : [];
    const mons = list.map(readMon).filter((m): m is MonState => m !== null).slice(0, 6);
    teams[id] = mons.length ? mons : [{ ...EMPTY_MON, moves: ["", "", "", ""] }];
  }
  const pick = <T,>(bag: unknown, read: (v: unknown) => T): Record<SideId, T> => {
    const b = (bag ?? {}) as Record<string, unknown>;
    return { a: read(b.a), b: read(b.b) };
  };
  const fieldRaw = (s.field ?? {}) as Partial<FieldState>;
  return {
    teams,
    active: { a: index((s.active as never)?.["a"], teams.a.length),
              b: index((s.active as never)?.["b"], teams.b.length) },
    slot: { a: index((s.slot as never)?.["a"], 4), b: index((s.slot as never)?.["b"], 4) },
    roll: pick(s.roll, rollIndex),
    crit: pick(s.crit, (v) => v === true),
    single: pick(s.single, (v) => v === true),
    gridFrom: side(s.gridFrom),
    field: {
      ...EMPTY_FIELD,
      ...fieldRaw,
      sides: {
        a: (fieldRaw.sides?.a ?? {}) as Record<string, boolean>,
        b: (fieldRaw.sides?.b ?? {}) as Record<string, boolean>,
      },
    },
  };
}

export function saveDuel(snapshot: DuelSnapshot): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch { /* storage blocked — the workspace just won't survive a page change */ }
}
