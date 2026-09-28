/** The IndexedDB database behind the browser library (Dexie). One database per origin — see the
 * origin-isolation flag in frontend/design.md §2.3.
 *
 * Versions only ever go up. A new version declares its stores and, if the record shape changed, an
 * upgrade that rewrites old records in place; the database is migrated once, when it is opened.
 * The library is small (a few hundred rows at most), so placement reads whole tables inside one
 * transaction rather than keeping position indexes that could drift from the rows. */
import Dexie, { type EntityTable } from "dexie";
import type { BoxRecord, LibraryLayout, TeamRecord } from "./records.ts";

export const LIBRARY_DB_NAME = "pokemon-champions-library";

/** Small keyed settings of the library itself; today only the layout. */
export type LibraryMetaRow = { id: "layout" } & LibraryLayout;

export class LibraryDb extends Dexie {
  teams!: EntityTable<TeamRecord, "id">;
  box!: EntityTable<BoxRecord, "id">;
  meta!: EntityTable<LibraryMetaRow, "id">;

  constructor(name = LIBRARY_DB_NAME) {
    super(name);
    this.version(1).stores({ teams: "id", box: "id", meta: "id" });
  }
}

let current: LibraryDb | null = null;

export function libraryDb(): LibraryDb {
  current ??= new LibraryDb();
  return current;
}

/** Tests point the module at a throwaway database. */
export function setLibraryDbForTests(db: LibraryDb | null): void {
  current = db;
}
