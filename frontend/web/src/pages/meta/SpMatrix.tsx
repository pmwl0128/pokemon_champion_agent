/** The SP spreads as a heat matrix: one spread per row, the six stats as fixed columns, each cell
 * holding its SP with a fill whose strength follows SP / 32. Reading down one column answers the
 * question the old text list made the reader assemble ("speed is maxed almost everywhere, HP gets
 * the leftover point or two"). */
import type { SpreadEntryDto, UsageTrendDto } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import type { CSSProperties } from "react";
import type { Async } from "../../hooks.ts";
import { EntityHover } from "../../components/EntityHover.tsx";
import { useT } from "../../i18n.ts";
import { spreadKey } from "../../lib/spread.ts";
import { usageDelta } from "../../lib/usageDelta.ts";
import { DeltaCell, pctText, spreadSeries, TrendAddon } from "./rows.tsx";

import { SP_MAX } from "../../lib/battle.ts";

function SpCell({ value, label }: { value: number; label: string }) {
  if (!value) {
    return <span className="mc-sp-cell zero"><span className="mc-sr">{label} 0</span><span aria-hidden="true">·</span></span>;
  }
  const strength = Math.round(12 + 76 * Math.min(value, SP_MAX) / SP_MAX);
  return (
    <span className={`mc-sp-cell${value >= 28 ? " strong" : ""}${value >= SP_MAX ? " max" : ""}`}
          style={{ "--a": `${strength}%` } as CSSProperties}>
      <span className="mc-sr">{label} </span>{value}
    </span>
  );
}

export function SpMatrix({ spreads, trend, baseline }: {
  spreads: SpreadEntryDto[];
  trend: Async<UsageTrendDto | null>;
  baseline?: string;
}) {
  const t = useT();
  return (
    <div className="mc-sp">
      <div className="mc-sp-row mc-sp-cols" aria-hidden="true">
        <span />
        {STAT_KEYS.map((key) => <span key={key}>{t(`stat.${key}`)}</span>)}
        <span className="end">{t("mc.pct")}</span>
        <span className="end">{t("mc.change")}</span>
      </div>
      {spreads.map((s, i) => {
        const values = spreadSeries(trend, s.spread);
        return (
          <EntityHover key={spreadKey(s.spread)} kind="spread" name={spreadKey(s.spread)} link={false}
                       previewAddon={<TrendAddon trend={trend} values={values} kind="pct" />}>
            <span className={`mc-sp-row${i === 0 ? " lead" : ""}`}>
              <span className="mc-rk">{s.rank}</span>
              {STAT_KEYS.map((key) => (
                <span key={key} className="mc-sp-slot"><SpCell value={s.spread[key] ?? 0} label={t(`stat.${key}`)} /></span>
              ))}
              <span className="mc-pct">{pctText(s.percentage)}</span>
              <DeltaCell delta={usageDelta(values)} baseline={baseline} />
            </span>
          </EntityHover>
        );
      })}
    </div>
  );
}
