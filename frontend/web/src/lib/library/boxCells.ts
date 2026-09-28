import { BOX_SLOTS, type BoxRecord } from "./records.ts";

/** One box in fixed cell order, retaining empty positions. Shared by the picker, shelf and dock. */
export function boxCells(records: readonly BoxRecord[], boxIndex: number): Array<BoxRecord | null> {
  const cells: Array<BoxRecord | null> = Array.from({ length: BOX_SLOTS }, () => null);
  for (const record of records) if (record.box === boxIndex) cells[record.slot] = record;
  return cells;
}
