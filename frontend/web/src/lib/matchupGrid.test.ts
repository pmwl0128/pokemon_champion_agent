import { expect, test } from "vitest";
import type { OppKoGridDto } from "@pokemon-champions/protocol";
import { populatedKoAxes } from "./matchupGrid.ts";

test("null KO placeholders never become entirely blank matrix axes", () => {
  const summary: NonNullable<OppKoGridDto["grid"][string][string]> = [
    54.8, 65.8, 2, 2, 2, true, 100,
  ];
  const axes = populatedKoAxes({
    attacker: { defender: summary, "failed-defender": null },
    "unavailable-attacker": { defender: null, "failed-defender": null },
  });
  expect([...axes.rows]).toEqual(["attacker"]);
  expect([...axes.cols]).toEqual(["defender"]);
});
