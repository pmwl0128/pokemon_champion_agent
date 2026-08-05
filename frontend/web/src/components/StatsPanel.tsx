/** Base-stats ⇄ actual-value panel, shared by both detail pages (design §2 — one component, one
 * scale, never a hand-copied second implementation). A center-aligned "tornado": the LEFT half is
 * the raw base stat (label on the far left, bar growing toward the center, the peak stat bolded);
 * the RIGHT half is the Lv.50 actual-value RANGE drawn as a min→max interval bar (label on the far
 * right). The two bars nearly touch in the middle, filling the full width. */
import { STAT_KEYS, type StatKey, type Stats } from "@pokemon-champions/protocol";
import { statRanges } from "../lib/stats.ts";
import { useT } from "../i18n.ts";

const BASE_SCALE = 200;   // Champions base-stat ceiling territory (bars cap at 100%)

function baseColor(v: number): string {
  if (v >= 130) return "#3FA129";
  if (v >= 100) return "#91A119";
  if (v >= 70) return "#FAC000";
  return "#FF8000";
}

const STAT_LABEL: Record<StatKey, string> = {
  hp: "HP", atk: "ATK", def: "DEF", spa: "SpA", spd: "SpD", spe: "SpE",
};

export function StatsPanel({ stats }: { stats: Stats }) {
  const t = useT();
  const ranges = statRanges(stats);
  const rangeBy = new Map(ranges.map((r) => [r.key, r]));
  const peak = Math.max(...STAT_KEYS.map((k) => stats[k]));       // bold the highest base stat
  // Self-scale the actual half, but leave ~8% headroom so even the tallest range bar keeps a gap
  // at the edge instead of butting flush against it.
  const actualMax = (Math.max(...ranges.map((r) => r.max)) || 1) / 0.92;

  return (
    <section className="panel stats-panel">
      <h2>{t("detail.stats")}</h2>
      <div className="stat-tornado">
        <div className="stat-tornado-caption">
          <span className="cap-l">{t("stats.base")}</span>
          <span className="cap-r">{t("stats.actual")}</span>
        </div>
        {STAT_KEYS.map((k) => {
          const base = stats[k];
          const r = rangeBy.get(k)!;
          const baseW = Math.min(100, (base / BASE_SCALE) * 100);
          const minW = Math.min(100, (r.min / actualMax) * 100);
          const extW = Math.min(100 - minW, ((r.max - r.min) / actualMax) * 100);
          const top = base === peak;
          return (
            <div className={`stat-tornado-row${top ? " top" : ""}`} key={k}>
              <div className="half left">
                <span className="k">{STAT_LABEL[k]}</span>
                <span className="v num">{base}</span>
                <span className="track base">
                  <span className="fill" style={{ width: `${baseW}%`, background: baseColor(base) }} />
                </span>
              </div>
              <div className="half right">
                <span className="track actual">
                  <span className="range-solid" style={{ width: `${minW}%` }} />
                  <span className="range-ext" style={{ width: `${extW}%` }} />
                </span>
                <span className="v num">{r.min}–{r.max}</span>
                <span className="k">{STAT_LABEL[k]}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="stat-note">{t("detail.statsNote")}</div>
    </section>
  );
}
