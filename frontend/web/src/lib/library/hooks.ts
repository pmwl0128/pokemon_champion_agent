/** React bindings of the browser library: the live library that re-renders on any write (from this
 * tab or another), how much of it this browser may open, and the snapshot a new record carries. */
import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useMemo, useState } from "react";
import { useRuntime } from "../../runtime/context.tsx";
import { LIBRARY_TIERS, type LibraryAccess, type LibrarySnapshot } from "./records.ts";
import { loadLibrary, type LibraryState } from "./repo.ts";

/** A live read: undefined while the first read is in flight, "unavailable" when the browser refuses
 * IndexedDB to this site (private mode, blocked site data). The failure is a value rather than a
 * throw, because a thrown read would reach the app's error boundary and take the whole page down
 * for what is only "this browser can't keep a library". */
export type LiveRead<T> = T | "unavailable" | undefined;

export function useLibrary(): LiveRead<LibraryState> {
  return useLiveQuery(() => loadLibrary().catch(() => "unavailable" as const), []);
}

/** Who may open more of the library. The online server says whether this browser is past visitor
 * limits (an owner or tester key, a local rehearsal); a local runtime has no visitors. Until the
 * answer arrives, and whenever it can't be had, the browser is a visitor — that only hides the
 * "open more" controls, never anything already open. */
export function useLibraryAccess(): LibraryAccess {
  const { adapter } = useRuntime();
  const [access, setAccess] = useState<LibraryAccess>(adapter.quota ? "visitor" : "authorized");
  useEffect(() => {
    if (!adapter.quota) return;
    let live = true;
    adapter.quota().then((quota) => { if (live) setAccess(quota.access ?? "visitor"); }, () => {});
    return () => { live = false; };
  }, [adapter]);
  return access;
}

/** The most boxes and team slots per format this browser may open. */
export function useLibraryLimits() {
  return LIBRARY_TIERS[useLibraryAccess()];
}

/** The data this page is showing, as the snapshot a record saved from it carries. */
export function useLibrarySnapshot(): LibrarySnapshot {
  const { capabilities } = useRuntime();
  const { season, rule, asOf } = capabilities.environment;
  return useMemo(() => ({
    season: season ?? null, rule: rule ?? null, asOf: asOf ?? null,
    deploymentId: capabilities.deploymentId ?? null,
  }), [season, rule, asOf, capabilities.deploymentId]);
}
