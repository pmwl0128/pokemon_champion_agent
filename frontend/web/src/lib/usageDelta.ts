/** The change column of the metagame detail card: this period's share against the FIRST period of
 * the usage-trend window (about two weeks), not against the previous period — neighbouring
 * periods are one to three days apart and almost never move by a readable amount.
 *
 * A null first value means the row was outside that period's upstream top 10, never that it had
 * zero usage. Subtracting would invent a measurement, so such a row is reported as `new` (it
 * entered the list inside the window) instead of as a signed number. */
export type UsageDelta =
  | { kind: "none" }
  | { kind: "new" }
  | { kind: "up" | "down"; value: number; minor: boolean };

/** Changes smaller than this many percentage points are still printed, but muted: at one decimal
 * of precision they are close to noise, and every row keeps its number so no panel looks empty. */
export const DELTA_THRESHOLD = 0.5;

export function usageDelta(values: ReadonlyArray<number | null> | undefined): UsageDelta {
  if (!values || values.length < 2) return { kind: "none" };
  const first = values[0];
  const last = values[values.length - 1];
  if (last == null) return { kind: "none" };
  if (first == null) return { kind: "new" };
  const change = Math.round((last - first) * 10) / 10;
  if (change === 0) return { kind: "none" };
  const value = Math.abs(change);
  return { kind: change > 0 ? "up" : "down", value, minor: value < DELTA_THRESHOLD };
}
