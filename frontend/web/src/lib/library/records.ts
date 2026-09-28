/** Record shapes of the browser library (frontend/design.md §2.3), laid out like the game's own
 * storage: Pokémon sit in boxes of 30 cells, and a team is up to six of those Pokémon in one of a
 * format's team slots.
 *
 * A box record is one particular Pokémon: its build (a `TeamMemberDoc`) and where it sits. A team
 * record holds no builds, only the ids of the box Pokémon it uses, in party order — change a
 * Pokémon's build and every team using it changes with it, delete it and it leaves those teams. The
 * `TeamDoc` a page hands to the skills is assembled from the box at read time (`teamDocOf`). */
import { z } from "zod";
import { FormatIdSchema, TeamMemberDocSchema, type FormatId } from "@pokemon-champions/protocol";

export const LIBRARY_SCHEMA_VERSION = 1;

/** Cells per box, and the grid they are drawn in (6 × 5, as in the games). */
export const BOX_SLOTS = 30;
export const BOX_COLUMNS = 6;
import { TEAM_SIZE } from "../battle.ts";
export { TEAM_SIZE } from "../battle.ts";
/** Team slots are opened five at a time: five full teams fill exactly one box. */
export const TEAM_SLOT_STEP = 5;

/** What every library starts with: two boxes, five team slots per format (five full teams fill
 * exactly one box). */
export const LIBRARY_START = { boxes: 2, teamSlots: TEAM_SLOT_STEP } as const;

/** How far a browser may open its library beyond the start: a visitor up to four boxes and ten team
 * slots per format; an authorized browser (owner or tester key, a local runtime) further. What is
 * already open stays open whatever the tier later becomes — capacity limits growth, never takes
 * data away. */
export type LibraryAccess = "visitor" | "authorized";
export const LIBRARY_TIERS: Record<LibraryAccess, { boxes: number; teamSlots: number }> = {
  visitor: { boxes: 4, teamSlots: 10 },
  authorized: { boxes: 8, teamSlots: 20 },
};

/** Where a record came from. Shown to the reader; never a statement about the build's strength. */
export const LIBRARY_ORIGINS = [
  "manual", "import", "builder", "diagnose", "session", "calc", "matchup", "meta",
] as const;
export type LibraryOrigin = (typeof LIBRARY_ORIGINS)[number];

/** The data a record was saved against — what "rule changed since" is judged by. */
export const LibrarySnapshotSchema = z.object({
  season: z.string().nullable(),
  rule: z.string().nullable(),
  asOf: z.string().nullable(),
  deploymentId: z.string().nullable(),
});
export type LibrarySnapshot = z.infer<typeof LibrarySnapshotSchema>;

const envelope = {
  id: z.string().min(1),
  schemaVersion: z.literal(LIBRARY_SCHEMA_VERSION),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  notes: z.string().max(4000).default(""),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
  origin: z.enum(LIBRARY_ORIGINS),
  snapshot: LibrarySnapshotSchema.nullable(),
};

export const BoxRecordSchema = z.object({
  ...envelope,
  kind: z.literal("box"),
  nickname: z.string().max(40).default(""),
  member: TeamMemberDocSchema,
  box: z.number().int().min(0).max(LIBRARY_TIERS.authorized.boxes - 1),
  slot: z.number().int().min(0).max(BOX_SLOTS - 1),
});
export type BoxRecord = z.infer<typeof BoxRecordSchema>;

export const TeamRecordSchema = z.object({
  ...envelope,
  kind: z.literal("team"),
  /** Empty means "unnamed": the list then shows the members' names in the reader's language. */
  name: z.string().max(80).default(""),
  format: FormatIdSchema,
  slot: z.number().int().min(0).max(LIBRARY_TIERS.authorized.teamSlots - 1),
  /** Box record ids in party order. May be empty: a team whose Pokémon were all deleted keeps its
   * name and notes until the reader deletes it. */
  members: z.array(z.string().min(1)).max(TEAM_SIZE),
});
export type TeamRecord = z.infer<typeof TeamRecordSchema>;

/** How much is open: box names (empty = the default name) and team slots per format. Stored only
 * once it differs from the default. */
export const LibraryLayoutSchema = z.object({
  boxes: z.array(z.object({ name: z.string().max(24).default("") }))
    .min(LIBRARY_START.boxes).max(LIBRARY_TIERS.authorized.boxes),
  teamSlots: z.object({
    single: z.number().int().min(LIBRARY_START.teamSlots).max(LIBRARY_TIERS.authorized.teamSlots),
    double: z.number().int().min(LIBRARY_START.teamSlots).max(LIBRARY_TIERS.authorized.teamSlots),
  }),
});
export type LibraryLayout = z.infer<typeof LibraryLayoutSchema>;

export function defaultLayout(): LibraryLayout {
  return {
    boxes: Array.from({ length: LIBRARY_START.boxes }, () => ({ name: "" })),
    teamSlots: { single: LIBRARY_START.teamSlots, double: LIBRARY_START.teamSlots },
  };
}

/** The box a format's new Pokémon go to first: box 1 is meant for singles, box 2 for doubles. It is
 * only a starting point — the boxes themselves have no format. */
export function preferredBox(format: FormatId): number {
  return format === "double" ? 1 : 0;
}

export type LibraryRecord = TeamRecord | BoxRecord;

/** The export file. Records inside are re-read one by one on import, so a single bad entry never
 * blocks the rest of a file. A team entry carries both its box references and the assembled
 * `TeamDoc`, so the file also reads as plain team-json. */
export const LIBRARY_FILE_FORMAT = "pokemon-champions-library";
export const LibraryFileSchema = z.object({
  format: z.literal(LIBRARY_FILE_FORMAT),
  version: z.literal(1),
  exportedAt: z.string(),
  layout: z.unknown().optional(),
  teams: z.array(z.unknown()).default([]),
  box: z.array(z.unknown()).default([]),
});
export type LibraryFile = z.infer<typeof LibraryFileSchema>;
