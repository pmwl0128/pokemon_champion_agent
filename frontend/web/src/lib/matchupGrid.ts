import type { OppKoGridDto } from "@pokemon-champions/protocol";

/** Calculated KO coordinates only. A failed/unavailable calculation can leave a structural null
 * placeholder in the compact projection; those keys are metadata, not paintable matrix axes. */
export function populatedKoAxes(grid: OppKoGridDto["grid"]): {
  rows: Set<string>; cols: Set<string>;
} {
  const rows = new Set<string>();
  const cols = new Set<string>();
  for (const [rowKey, cells] of Object.entries(grid)) {
    for (const [colKey, summary] of Object.entries(cells)) {
      if (summary === null) continue;
      rows.add(rowKey);
      cols.add(colKey);
    }
  }
  return { rows, cols };
}
