import { expect, test } from "vitest";
import type { OppCheckGridDto, OppKoGridDto } from "@pokemon-champions/protocol";
import { populatedAxes } from "./matchupGrid.ts";

test("null KO placeholders never become entirely blank matrix axes", () => {
  const summary: NonNullable<OppKoGridDto["grid"][string][string]> = [
    54.8, 65.8, 2, 2, 2, true, 100,
  ];
  const axes = populatedAxes({
    attacker: { defender: summary, "failed-defender": null },
    "unavailable-attacker": { defender: null, "failed-defender": null },
  });
  expect([...axes.rows]).toEqual(["attacker"]);
  expect([...axes.cols]).toEqual(["defender"]);
});

test("a check-grid build with no attacker row is neither a row nor a column", () => {
  // Every grade comes from an ordered attacker pair, so a meta-only build (absent from the grid
  // entirely) has no column either — rendering it painted a blank column across the table.
  const grade: OppCheckGridDto["grid"][string][string] = { grade: "C2" };
  const axes = populatedAxes({
    attacker: { attacker: grade, "meta-only": undefined as never },
  });
  expect([...axes.rows]).toEqual(["attacker"]);
  expect([...axes.cols]).toEqual(["attacker"]);
});
