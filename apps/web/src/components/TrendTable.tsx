import type { TrendDto } from "@pokemon-champions/protocol";
import { Link } from "react-router-dom";
import { displayName, useLang, useT } from "../i18n.ts";

function presentRanks(ranks: Array<number | null>): number[] {
  return ranks.filter((rank): rank is number => rank != null);
}

function currentRank(ranks: Array<number | null>): number | null {
  for (let index = ranks.length - 1; index >= 0; index -= 1) {
    if (ranks[index] != null) return ranks[index]!;
  }
  return null;
}

export function TrendTable({ trend }: { trend: TrendDto }) {
  const { lang } = useLang();
  const t = useT();
  const series = [...trend.series].sort((a, b) =>
    (currentRank(a.ranks) ?? Number.MAX_SAFE_INTEGER)
    - (currentRank(b.ranks) ?? Number.MAX_SAFE_INTEGER));

  return (
    <section className="panel trend-mobile" aria-label={t("trend.title")}>
      <div className="trend-table-scroll" tabIndex={0} data-scroll-region>
        <table className="trend-table">
          <thead>
            <tr>
              <th className="trend-identity">{t("ranking.pokemon")}</th>
              {trend.periods.map((period) => <th key={period} scope="col">{period}</th>)}
            </tr>
          </thead>
          <tbody>
            {series.map((entry) => {
              const present = presentRanks(entry.ranks);
              const latest = present[present.length - 1] ?? null;
              const delta = present.length > 1 ? present[0]! - present[present.length - 1]! : 0;
              const movement = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
              return (
                <tr key={entry.slug}>
                  <th className="trend-identity" scope="row">
                    <Link to={`/meta/${entry.slug}?format=${trend.format}`}>
                      <span>{displayName(entry, lang)}</span>
                      <small className={movement}>
                        {latest == null ? "-" : `#${latest}`}
                        {delta > 0 ? ` ▲${delta}` : delta < 0 ? ` ▼${-delta}` : ""}
                      </small>
                    </Link>
                  </th>
                  {entry.ranks.map((rank, index) => (
                    <td key={`${entry.slug}-${trend.periods[index] ?? index}`}
                      className={index === entry.ranks.length - 1 ? "current" : ""}>
                      {rank == null ? "-" : `#${rank}`}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
