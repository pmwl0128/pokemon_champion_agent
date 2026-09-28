/** The real builds shown in the metagame detail card's set strip.
 *
 * Only builds aggregated from real teams qualify, modal first. A species without them yields an
 * empty list and the strip does not render: the calculator's Meta fallback is a set spliced from
 * per-field marginals, and on a screenshot it would pass for a set someone actually runs. */
import type { OppSetCatalogDto, OppSetDto } from "@pokemon-champions/protocol";

export interface RealSet {
  key: string;
  isModal: boolean;
  set: OppSetDto;
}

export function realSetsFor(catalog: OppSetCatalogDto, species: string): RealSet[] {
  const row = catalog.species.find((s) => s.name === species);
  if (!row?.realTeamBacked) return [];
  return (row.variants ?? [])
    .flatMap((variant) => {
      const set = catalog.sets[variant.key];
      // A defender-only row carries no joint move set; there is nothing to show as a build.
      return set?.moves?.length ? [{ key: variant.key, isModal: variant.isModal, set }] : [];
    })
    .sort((a, b) => Number(b.isModal) - Number(a.isModal));
}
