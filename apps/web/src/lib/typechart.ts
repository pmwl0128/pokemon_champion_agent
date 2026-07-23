/** Standard type effectiveness chart (attacker type -> defender type multiplier; only
 * non-1 entries listed). Typeless attacks and defends neutrally. */
import type { TypeName } from "@pokemon-champions/protocol";

const CHART: Partial<Record<TypeName, Partial<Record<TypeName, number>>>> = {
  Normal: { Rock: 0.5, Ghost: 0, Steel: 0.5 },
  Fire: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 2, Bug: 2, Rock: 0.5, Dragon: 0.5, Steel: 2 },
  Water: { Fire: 2, Water: 0.5, Grass: 0.5, Ground: 2, Rock: 2, Dragon: 0.5 },
  Electric: { Water: 2, Electric: 0.5, Grass: 0.5, Ground: 0, Flying: 2, Dragon: 0.5 },
  Grass: { Fire: 0.5, Water: 2, Grass: 0.5, Poison: 0.5, Ground: 2, Flying: 0.5, Bug: 0.5,
           Rock: 2, Dragon: 0.5, Steel: 0.5 },
  Ice: { Fire: 0.5, Water: 0.5, Grass: 2, Ice: 0.5, Ground: 2, Flying: 2, Dragon: 2,
         Steel: 0.5 },
  Fighting: { Normal: 2, Ice: 2, Poison: 0.5, Flying: 0.5, Psychic: 0.5, Bug: 0.5, Rock: 2,
              Ghost: 0, Dark: 2, Steel: 2, Fairy: 0.5 },
  Poison: { Grass: 2, Poison: 0.5, Ground: 0.5, Rock: 0.5, Ghost: 0.5, Steel: 0, Fairy: 2 },
  Ground: { Fire: 2, Electric: 2, Grass: 0.5, Poison: 2, Flying: 0, Bug: 0.5, Rock: 2,
            Steel: 2 },
  Flying: { Electric: 0.5, Grass: 2, Fighting: 2, Bug: 2, Rock: 0.5, Steel: 0.5 },
  Psychic: { Fighting: 2, Poison: 2, Psychic: 0.5, Dark: 0, Steel: 0.5 },
  Bug: { Fire: 0.5, Grass: 2, Fighting: 0.5, Poison: 0.5, Flying: 0.5, Psychic: 2,
         Ghost: 0.5, Dark: 2, Steel: 0.5, Fairy: 0.5 },
  Rock: { Fire: 2, Ice: 2, Fighting: 0.5, Ground: 0.5, Flying: 2, Bug: 2, Steel: 0.5 },
  Ghost: { Normal: 0, Psychic: 2, Ghost: 2, Dark: 0.5 },
  Dragon: { Dragon: 2, Steel: 0.5, Fairy: 0 },
  Dark: { Fighting: 0.5, Psychic: 2, Ghost: 2, Dark: 0.5, Fairy: 0.5 },
  Steel: { Fire: 0.5, Water: 0.5, Electric: 0.5, Ice: 2, Rock: 2, Steel: 0.5, Fairy: 2 },
  Fairy: { Fire: 0.5, Fighting: 2, Poison: 0.5, Dragon: 2, Dark: 2, Steel: 0.5 },
};

export interface DefensiveProfile {
  x4: TypeName[];
  x2: TypeName[];
  x05: TypeName[];
  x025: TypeName[];
  x0: TypeName[];
}

const ATTACKERS = Object.keys(CHART) as TypeName[];

/** Combined defensive multipliers for a (mono/dual)-typed defender. */
export function defensiveProfile(defTypes: TypeName[]): DefensiveProfile {
  const out: DefensiveProfile = { x4: [], x2: [], x05: [], x025: [], x0: [] };
  for (const atk of ATTACKERS) {
    let mult = 1;
    for (const def of defTypes) mult *= CHART[atk]?.[def] ?? 1;
    if (mult === 0) out.x0.push(atk);
    else if (mult >= 4) out.x4.push(atk);
    else if (mult >= 2) out.x2.push(atk);
    else if (mult <= 0.25 && mult > 0) out.x025.push(atk);
    else if (mult < 1) out.x05.push(atk);
  }
  return out;
}

export interface OffensiveProfile {
  x2: TypeName[];   // a STAB hits it super-effectively
  x05: TypeName[];  // best STAB is resisted
  x0: TypeName[];   // every STAB is blocked (immune)
}

/** STAB coverage: for each of the 18 defending types, the BEST multiplier the mon's own type(s)
 * reach (a dual-typed mon picks whichever STAB works), bucketed into super-effective / resisted /
 * immune. Neutral targets are omitted (they're the uninteresting majority). */
export function offensiveProfile(atkTypes: TypeName[]): OffensiveProfile {
  const out: OffensiveProfile = { x2: [], x05: [], x0: [] };
  for (const def of ATTACKERS) {
    let best = 0;
    for (const atk of atkTypes) best = Math.max(best, CHART[atk]?.[def] ?? 1);
    if (best >= 2) out.x2.push(def);
    else if (best === 0) out.x0.push(def);
    else if (best < 1) out.x05.push(def);
  }
  return out;
}
