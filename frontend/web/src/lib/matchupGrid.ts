import type { OppCheckGridDto, OppKoGridDto } from "@pokemon-champions/protocol";

/** Calculated coordinates only, for either reference grid.
 *
 * A failed or unavailable calculation can leave a structural null placeholder in the compact
 * projection, and a build with no attacker row is simply absent from it; both are metadata, not
 * paintable matrix axes. The check grid derives every grade from ordered ATTACKER pairs, so a
 * species with no offense row drops out of its columns as well as its rows — unlike the KO grid,
 * where a meta-only build is still a legitimate defender column. */
export function populatedAxes(
  grid: OppKoGridDto["grid"] | OppCheckGridDto["grid"],
): { rows: Set<string>; cols: Set<string> } {
  const rows = new Set<string>();
  const cols = new Set<string>();
  for (const [rowKey, cells] of Object.entries(grid)) {
    for (const [colKey, cell] of Object.entries(cells)) {
      if (cell == null) continue;
      rows.add(rowKey);
      cols.add(colKey);
    }
  }
  return { rows, cols };
}
