import type { DamageResultDto } from "@pokemon-champions/protocol";
import type { ReactNode } from "react";
import { optionalKey, useLang, useT } from "../i18n.ts";
import { useProseRenderer } from "./prose.tsx";

type KoChance = DamageResultDto["koChance"];
type Caveat = NonNullable<DamageResultDto["koCaveats"]>[number];

/** Render structured calculation facts at the locale boundary. The engine's English prose
 * remains diagnostic data; Chinese and Japanese never have to parse or translate it. */
export function useDamageText() {
  const t = useT();
  const { lang } = useLang();
  const prose = useProseRenderer();
  const fill = (template: string, values: Record<string, string | number>) =>
    template.replace(/\{([^}]+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));

  const summary = (result: DamageResultDto): ReactNode => {
    if (lang === "en") return prose(result.description);
    return prose(fill(t("calc.damageLine"), {
      attacker: result.attacker, move: result.move, defender: result.defender,
    }));
  };

  const ko = (chance: KoChance): string => {
    if (!chance) return "";
    if (lang === "en" && chance.text) return chance.text;
    if (chance.n == null && chance.chancePct == null && !chance.guaranteed) return t("calc.koUnclear");
    const n = chance.n ?? "?";
    if (chance.guaranteed) return fill(t("calc.koGuaranteed"), { n });
    if (chance.chancePct != null) return fill(t("calc.koChance"), { n, p: chance.chancePct });
    return fill(t("calc.koPossible"), { n });
  };

  const caveat = (value: Caveat): string => {
    const codeKey = optionalKey(`calc.caveat.${value.code}`);
    const dirKey = optionalKey(`calc.caveat.direction.${value.direction}`);
    if (lang === "en" && value.cause) return `${value.cause} — ${value.direction}`;
    const detail = codeKey ? t(codeKey) : t("calc.caveat.generic");
    return dirKey ? `${detail}；${t(dirKey)}` : detail;
  };

  return { summary, ko, caveat, name: prose };
}
