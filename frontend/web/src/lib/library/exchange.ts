/** Library import/export (frontend/design.md §2.3): a versioned JSON file for whole libraries or a
 * selection, and the origin-to-origin bridge — a library in one origin reaches another only
 * through this file.
 *
 * Import is planned before it is applied. Planning reads every entry and checks it against what is
 * already stored; applying places what the reader agreed to, in the same cells and slots as in the
 * file when those are free, else in the first free ones. A bad entry is counted and skipped, and
 * so is one that finds no room — neither blocks the rest of the file. */
import type { FormatId, TeamMemberDoc } from "@pokemon-champions/protocol";
import { memberBuildKey, toTeamDoc, toTeamMember } from "../teamDoc.ts";
import {
  LIBRARY_FILE_FORMAT, LIBRARY_ORIGINS, LibraryFileSchema, LibraryLayoutSchema, LibrarySnapshotSchema,
  preferredBox,
  type BoxRecord, type LibraryFile, type LibraryLayout, type LibraryOrigin, type LibrarySnapshot,
  type TeamRecord,
} from "./records.ts";
import {
  boxById, buildBoxRecord, buildTeamRecord, findSameTeam, freeCells, freeTeamSlots, isFree, loadLibrary, rw,
  teamDocOf, writeLayout, type BoxPosition, type LibraryState,
} from "./repo.ts";

/** Teams with their assembled `TeamDoc` beside the box references, so the file also reads as
 * team-json. */
function withDocs(teams: TeamRecord[], state: Pick<LibraryState, "box">) {
  const box = boxById(state);
  return teams.map((team) => ({ ...team, team: teamDocOf(team, box) }));
}

/** One team and the Pokémon it uses. */
export function teamFile(state: LibraryState, team: TeamRecord, now = new Date()): LibraryFile {
  const members = new Set(team.members);
  return {
    format: LIBRARY_FILE_FORMAT, version: 1, exportedAt: now.toISOString(),
    teams: withDocs([team], state), box: state.box.filter((record) => members.has(record.id)),
  };
}

/** Everything in the store, including rows that no longer read — an export is also the way to
 * rescue those. */
export async function exportAll(now = new Date()): Promise<LibraryFile> {
  const state = await loadLibrary();
  return {
    format: LIBRARY_FILE_FORMAT, version: 1, exportedAt: now.toISOString(), layout: state.layout,
    teams: [...withDocs(state.teams, state), ...state.broken.teams],
    box: [...state.box, ...state.broken.box],
  };
}

interface ImportMeta {
  name: string;
  nickname: string;
  notes: string;
  tags: string[];
  origin: LibraryOrigin;
  snapshot: LibrarySnapshot | null;
  createdAt: number | null;
  updatedAt: number | null;
}

type Raw = Record<string, unknown>;

function rawOf(entry: unknown): Raw {
  return entry !== null && typeof entry === "object" && !Array.isArray(entry) ? entry as Raw : {};
}

function metaOf(raw: Raw): ImportMeta {
  const text = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((tag): tag is string => typeof tag === "string" && tag.length > 0 && tag.length <= 40).slice(0, 20)
    : [];
  const origin = LIBRARY_ORIGINS.includes(raw.origin as LibraryOrigin) ? raw.origin as LibraryOrigin : "import";
  const snapshot = LibrarySnapshotSchema.safeParse(raw.snapshot);
  return {
    name: text(raw.name, 80), nickname: text(raw.nickname, 40), notes: text(raw.notes, 4000), tags,
    origin, snapshot: snapshot.success ? snapshot.data : null,
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt >= 0 ? Math.floor(raw.createdAt) : null,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) && raw.updatedAt >= 0 ? Math.floor(raw.updatedAt) : null,
  };
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export interface PlannedBoxRecord {
  fileId: string | null;
  member: TeamMemberDoc;
  meta: ImportMeta;
  at: BoxPosition | null;
  /** A Pokémon already in the box with the same build and nickname. */
  existing: BoxRecord | null;
}

export interface PlannedTeam {
  format: FormatId;
  slot: number | null;
  meta: ImportMeta;
  /** Members as file box ids, or — for a team that only carries team-json — as builds. */
  refs: Array<{ fileId: string } | { member: TeamMemberDoc }>;
  /** The same builds are already a team of this format. */
  duplicate: boolean;
}

export interface ImportPlan {
  layout: LibraryLayout | null;
  teams: PlannedTeam[];
  box: PlannedBoxRecord[];
  /** Entries that did not read as a team or a box Pokémon. */
  invalid: number;
  /** Free box cells and team slots before the import. */
  room: { box: number; single: number; double: number };
}

export type ParseFailure = "not-json" | "not-a-library-file";

/** Parse a file's text into a plan, or say why it is not one. */
export async function planImport(text: string): Promise<ImportPlan | ParseFailure> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return "not-json";
  }
  const file = LibraryFileSchema.safeParse(json);
  if (!file.success) return "not-a-library-file";
  const state = await loadLibrary();
  let invalid = 0;

  const box: PlannedBoxRecord[] = [];
  const idCounts = new Map<string, number>();
  for (const entry of file.data.box) {
    const id = rawOf(entry).id;
    if (typeof id === "string" && id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const reused = new Set<string>();
  for (const entry of file.data.box) {
    const raw = rawOf(entry);
    if (typeof raw.id === "string" && (idCounts.get(raw.id) ?? 0) > 1) { invalid++; continue; }
    const member = toTeamMember(raw.member, state.vocabulary);
    if (!member) { invalid += 1; continue; }
    const meta = metaOf(raw);
    const key = memberBuildKey(member);
    const cell = wholeNumber(raw.box), slot = wholeNumber(raw.slot);
    const existing = state.box.find((record) => !reused.has(record.id)
      && memberBuildKey(record.member) === key && record.nickname === meta.nickname.trim()
      && record.notes === meta.notes && JSON.stringify(record.tags) === JSON.stringify(meta.tags)) ?? null;
    if (existing) reused.add(existing.id);
    box.push({
      fileId: typeof raw.id === "string" && raw.id ? raw.id : null, member, meta,
      at: cell !== null && slot !== null ? { box: cell, slot } : null,
      existing,
    });
  }
  const byFileId = new Map(box.flatMap((entry) => entry.fileId ? [[entry.fileId, entry] as const] : []));

  const teams: PlannedTeam[] = [];
  const availableTeams = { ...state, teams: [...state.teams] };
  for (const entry of file.data.teams) {
    const raw = rawOf(entry);
    const doc = toTeamDoc(raw.team, undefined, state.vocabulary);
    const format: FormatId | null = raw.format === "single" || raw.format === "double" ? raw.format : doc?.format ?? null;
    const listed = Array.isArray(raw.members) ? raw.members : null;
    // A broken reference never turns a team into a smaller, apparently valid one.
    if (listed && (listed.length > 6 || new Set(listed).size !== listed.length
      || listed.some((id) => typeof id !== "string" || !byFileId.has(id)))) { invalid++; continue; }
    const refs: PlannedTeam["refs"] = listed !== null
      ? listed.map((fileId) => ({ fileId }))
      : doc?.pokemon.map((member) => ({ member })) ?? [];
    if (!format || (listed === null && !doc)) { invalid += 1; continue; }
    const builds = refs.map((ref) => "fileId" in ref ? byFileId.get(ref.fileId)!.member : ref.member);
    const duplicate = builds.length ? findSameTeam(availableTeams, format, builds) : null;
    if (duplicate) availableTeams.teams = availableTeams.teams.filter((team) => team.id !== duplicate.id);
    teams.push({
      format, slot: wholeNumber(raw.slot), meta: metaOf(raw), refs,
      // Empty teams carry user names and notes; do not collapse unrelated empty slots.
      duplicate: duplicate !== null,
    });
  }

  const layout = LibraryLayoutSchema.safeParse(file.data.layout);
  return {
    layout: layout.success ? layout.data : null, teams, box, invalid,
    room: {
      box: freeCells(state).length,
      single: freeTeamSlots(state, "single").length,
      double: freeTeamSlots(state, "double").length,
    },
  };
}

export interface ImportResult {
  teams: number;
  box: number;
  /** Already stored, and not kept as second copies. */
  skipped: number;
  /** Found no free team slot or box cell. */
  noRoom: number;
}

/** Write a plan. The file's layout opens boxes and team slots up to `limits`; duplicates are skipped
 * unless the reader chose to keep them as second copies. */
export function applyImport(plan: ImportPlan,
  options: { keepDuplicates: boolean; limits: { boxes: number; teamSlots: number } }): Promise<ImportResult> {
  const { keepDuplicates, limits } = options;
  return rw(async (db, state) => {
    if (plan.layout) {
      const boxes = [...state.layout.boxes];
      plan.layout.boxes.slice(0, limits.boxes).forEach((box, index) => {
        if (index >= boxes.length) boxes.push({ name: box.name });
        else if (!boxes[index]!.name) boxes[index] = { name: box.name };
      });
      const slots = (format: FormatId) => Math.max(state.layout.teamSlots[format],
        Math.min(plan.layout!.teamSlots[format], limits.teamSlots));
      state.layout = await writeLayout(db, { boxes, teamSlots: { single: slots("single"), double: slots("double") } });
    }

    const result: ImportResult = { teams: 0, box: 0, skipped: 0, noRoom: 0 };
    const added: BoxRecord[] = [];
    const place = (member: TeamMemberDoc, meta: ImportMeta, at: BoxPosition | null, from: BoxPosition) => {
      const cell = at && isFree(state, at) ? at : freeCells(state, from)[0];
      if (!cell) { result.noRoom += 1; return null; }
      const record = buildBoxRecord(member, meta, cell, Date.now(), state.vocabulary);
      if (meta.createdAt != null) record.createdAt = meta.createdAt;
      if (meta.updatedAt != null) record.updatedAt = meta.updatedAt;
      state.box.push(record);
      added.push(record);
      return record;
    };

    const fileIds = new Map<string, string>();
    for (const entry of plan.box) {
      const existing = entry.existing && state.box.find((row) => row.id === entry.existing!.id
        && memberBuildKey(row.member) === memberBuildKey(entry.member));
      if (existing && !keepDuplicates) {
        if (entry.fileId) fileIds.set(entry.fileId, existing.id);
        result.skipped += 1;
        continue;
      }
      const record = place(entry.member, entry.meta, entry.at, { box: 0, slot: 0 });
      if (record && entry.fileId) fileIds.set(entry.fileId, record.id);
    }

    const teams: TeamRecord[] = [];
    // Reuse pre-existing teams at most once. Separate records in a backup remain separate,
    // even when they intentionally share every member's build.
    const availableTeams = { ...state, teams: [...state.teams] };
    for (const entry of plan.teams) {
      const builds = entry.refs.map((ref) => "member" in ref ? ref.member
        : plan.box.find((row) => row.fileId === ref.fileId)!.member);
      const duplicate = builds.length && !keepDuplicates ? findSameTeam(availableTeams, entry.format, builds) : null;
      if (duplicate) {
        availableTeams.teams = availableTeams.teams.filter((team) => team.id !== duplicate.id);
        result.skipped += 1; continue;
      }
      const free = freeTeamSlots(state, entry.format);
      const slot = entry.slot !== null && free.includes(entry.slot) ? entry.slot : free[0];
      if (slot === undefined) { result.noRoom += 1; continue; }
      const ids: string[] = [];
      const checkpoint = added.length;
      let complete = true;
      for (const ref of entry.refs) {
        if ("fileId" in ref) {
          const id = fileIds.get(ref.fileId);
          if (id && !ids.includes(id)) ids.push(id);
          else complete = false;
          continue;
        }
        const key = memberBuildKey(ref.member);
        const hit = state.box.find((record) => !ids.includes(record.id) && memberBuildKey(record.member) === key)
          ?? place(ref.member, { ...entry.meta, nickname: "", notes: "", tags: [] }, null,
            { box: preferredBox(entry.format), slot: 0 });
        if (hit) ids.push(hit.id);
        else complete = false;
      }
      if (!complete) {
        const rolledBack = new Set(added.splice(checkpoint).map((row) => row.id));
        state.box = state.box.filter((row) => !rolledBack.has(row.id));
        result.noRoom += 1;
        continue;
      }
      const record = buildTeamRecord(entry.format, ids, entry.meta, slot);
      if (entry.meta.createdAt != null) record.createdAt = entry.meta.createdAt;
      if (entry.meta.updatedAt != null) record.updatedAt = entry.meta.updatedAt;
      state.teams.push(record);
      teams.push(record);
    }

    await db.box.bulkAdd(added);
    await db.teams.bulkAdd(teams);
    result.box = added.length;
    result.teams = teams.length;
    return result;
  });
}

/** `pokemon-champions-library-2026-09-26.json` for the whole library; a single team's export says
 * `team` instead, so two downloads on one day are told apart by name. Both import the same way. The
 * date is the reader's own calendar day, not UTC's. */
export function exportFileName(part: "library" | "team" = "library", now = new Date()): string {
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((value) => String(value).padStart(2, "0")).join("-");
  return `pokemon-champions-${part}-${day}.json`;
}
