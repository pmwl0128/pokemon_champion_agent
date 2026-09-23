/** Session-scoped memory for the calc page.
 *
 * Navigating to another page unmounts the tools, and rebuilding two teams by hand afterwards is not
 * a reasonable price for looking something up in the dex. Only INPUT is kept — every number on the
 * page is recomputed from it — so a stale snapshot can never show a result that no longer follows
 * from the build beside it.
 *
 * Two records: the ROSTER every tool shares (teams, who is up, the selected move, the battle frame)
 * and the damage calculator's own reading state (roll, crit, single target). The roster used to live
 * inside the calculator's record; that record is still read as a fallback so an open workspace
 * survives the split.
 *
 * sessionStorage, not localStorage: this is scratch work for the current sitting, the same choice
 * the team hand-offs in lib/team.ts make. */
import {
  EMPTY_FIELD, EMPTY_MON, ROLL_COUNT, ROLL_TOP, newMonUid, rollIndexOf,
  type FieldState, type MonState, type SideId,
} from "./state.ts";

const ROSTER_KEY = "pc-calc-roster-v1";
const VIEW_KEY = "pc-calc-duel-v1";

export interface RosterSnapshot {
  teams: Record<SideId, MonState[]>;
  active: Record<SideId, number>;
  /** Each side's selected move slot. */
  slot: Record<SideId, number>;
  field: FieldState;
}

export interface DuelViewSnapshot {
  /** Index into the engine's sorted 16 rolls. */
  roll: Record<SideId, number>;
  crit: Record<SideId, boolean>;
  single: Record<SideId, boolean>;
}

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
    uid: typeof m.uid === "string" && m.uid ? m.uid : newMonUid(),
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

const index = (raw: unknown, max: number): number =>
  (typeof raw === "number" && raw >= 0 && raw < max ? Math.floor(raw) : 0);
/** Snapshots written before the roll became a slider stored the mode name; map those onto the
 * index they meant rather than throwing the whole workspace away over one field. */
const rollIndex = (raw: unknown): number => {
  if (raw === "low" || raw === "mid" || raw === "high") return rollIndexOf(raw);
  return typeof raw === "number" && raw >= 0 && raw < ROLL_COUNT ? Math.floor(raw) : ROLL_TOP;
};

function readJson(key: string): Record<string, unknown> | null {
  try {
    const text = sessionStorage.getItem(key);
    if (!text) return null;
    const raw: unknown = JSON.parse(text);
    return raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : null;
  } catch {
    return null;   // storage blocked, or not JSON — start fresh
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked — the workspace just won't survive a page change */ }
}

const pick = <T,>(bag: unknown, read: (v: unknown) => T): Record<SideId, T> => {
  const b = (bag ?? {}) as Record<string, unknown>;
  return { a: read(b.a), b: read(b.b) };
};

/** Lenient by design: a snapshot from an older shape must degrade to "no snapshot", never to a
 * half-restored workspace whose fields disagree with each other. */
export function loadRoster(): RosterSnapshot | null {
  const s = readJson(ROSTER_KEY) ?? readJson(VIEW_KEY);
  const teamsRaw = s?.teams as Record<string, unknown> | undefined;
  if (!s || !teamsRaw) return null;
  const teams = {} as Record<SideId, MonState[]>;
  for (const id of ["a", "b"] as const) {
    const list = Array.isArray(teamsRaw[id]) ? (teamsRaw[id] as unknown[]) : [];
    const mons = list.map(readMon).filter((m): m is MonState => m !== null).slice(0, 6);
    teams[id] = mons.length ? mons : [{ ...EMPTY_MON, uid: newMonUid(), moves: ["", "", "", ""] }];
  }
  const fieldRaw = (s.field ?? {}) as Partial<FieldState>;
  return {
    teams,
    active: { a: index((s.active as never)?.["a"], teams.a.length),
              b: index((s.active as never)?.["b"], teams.b.length) },
    slot: { a: index((s.slot as never)?.["a"], 4), b: index((s.slot as never)?.["b"], 4) },
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

export function saveRoster(snapshot: RosterSnapshot): void {
  writeJson(ROSTER_KEY, snapshot);
}

export function loadDuelView(): DuelViewSnapshot | null {
  const s = readJson(VIEW_KEY);
  if (!s) return null;
  return {
    roll: pick(s.roll, rollIndex),
    crit: pick(s.crit, (v) => v === true),
    single: pick(s.single, (v) => v === true),
  };
}

export function saveDuelView(snapshot: DuelViewSnapshot): void {
  writeJson(VIEW_KEY, snapshot);
}
