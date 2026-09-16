/** The meta detail page's stat card: the six actual values this Pokemon plays at.
 *
 * It replaces the base/actual tornado on that page because the question there is different. The dex
 * asks "what is this species", and a base stat answers it; the metagame page asks "what does the
 * thing people are actually running hit for", and that is an ACTUAL value — which only exists once a
 * spread and a nature are named. So the card starts as the honest range (0 SP neutral → 32 SP
 * boosting) and collapses to a single number the moment the reader picks a spread beside it.
 *
 * The base stat stays on the row as the identity of the line, not as the headline. */
import type { SpSpread, StatKey, Stats } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { actualStat } from "../lib/stats.ts";
import { useT } from "../i18n.ts";

const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP", atk: "ATK", def: "DEF", spa: "SpA", spd: "SpD", spe: "SpE",
};
const SP_MAX = 32;

export function StatValues({ stats, spread, natureUp, natureDown }: {
  stats: Stats;
  /** The picked SP spread, or null while none is picked — then the row shows its range. */
  spread: SpSpread | null;
  natureUp: StatKey | null;
  natureDown: StatKey | null;
}) {
  const t = useT();
  const mult = (key: StatKey): 0.9 | 1 | 1.1 => {
    if (key === "hp") return 1;
    if (natureUp === key && natureDown !== key) return 1.1;
    if (natureDown === key && natureUp !== key) return 0.9;
    return 1;
  };
  const rows = STAT_KEYS.map((key) => {
    const base = stats[key];
    if (spread) {
      const value = actualStat(base, key, spread[key] ?? 0, mult(key));
      return { key, base, min: value, max: value, exact: true, tone: mult(key) };
    }
    return {
      key, base, exact: false, tone: 1 as const,
      min: actualStat(base, key, 0, 1),
      max: actualStat(base, key, SP_MAX, key === "hp" ? 1 : 1.1),
    };
  });
  // Self-scale to the tallest bar with a little headroom, so the longest row never butts flush
  // against the edge (the same treatment the dex page's actual-value half uses).
  const scale = (Math.max(...rows.map((r) => r.max)) || 1) / 0.94;

  return (
    <section className="panel stat-values">
      <h2>{t("detail.statValues")}
        <span className="panel-note">
          {spread ? t("detail.statValuesPicked") : t("detail.statValuesRange")}
        </span>
      </h2>
      <div className="sv-rows">
        {rows.map((r) => (
          <div className="sv-row" key={r.key}>
            <span className="k">{STAT_LABEL[r.key]}</span>
            <span className="base num">{r.base}</span>
            <span className="track">
              <span className="solid" style={{ width: `${(r.min / scale) * 100}%` }} />
              <span className="ext" style={{ width: `${((r.max - r.min) / scale) * 100}%` }} />
            </span>
            <span className={`v num${r.tone === 1.1 ? " up" : r.tone === 0.9 ? " down" : ""}`}>
              {r.exact ? r.min : `${r.min}–${r.max}`}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
