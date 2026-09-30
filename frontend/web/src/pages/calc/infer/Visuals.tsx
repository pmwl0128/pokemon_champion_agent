/** The inferred state, drawn: one ruler per defence (HP x Def, HP x SpD) on a bulk-equivalent SP
 * scale, and one lane per power item for each attacking stat. Every mark a reader might not parse at
 * a glance carries its reading as a tooltip. */
import type { BulkKey, Lane, Ruler, StatView } from "./model.ts";
import { useInferT } from "./messages.ts";

type T = ReturnType<typeof useInferT>;

/** Only inference values belong here; a reference build's SP never supplies a fallback. */
export function InferredCell({ view, loading = false, showScope = false }: {
  view: StatView | null; loading?: boolean; showScope?: boolean;
}) {
  const t = useInferT();
  const observed = !loading && !!view?.observed;
  const range = loading ? t("infer.pending")
    : !view ? "—" : !observed && !showScope ? t("infer.ruler.unobserved")
      : view.lo <= view.hi ? (view.lo === view.hi ? String(view.lo) : `${view.lo}–${view.hi}`) : "—";
  return (
    <span className="inf-foe-inferred">
      <span className={`inf-cells${observed ? "" : " hatched"}`} aria-hidden>
        {(observed ? view!.mass : new Array<number>(33).fill(0)).map((value, sp) => (
          <i key={sp} className={value > 0 ? "on" : ""}
            style={observed ? { opacity: value > 0 ? 0.22 + value * 0.78 : 1 } : undefined} />
        ))}
      </span>
      <span className={`num inf-foe-range${observed ? "" : " muted"}`}>{range}</span>
    </span>
  );
}

const pct = (value: number, [lo, hi]: [number, number]) =>
  Math.max(0, Math.min(100, ((value - lo) / Math.max(1, hi - lo)) * 100));

export interface RulerMark {
  product: number;
  label: string;
  fits: boolean;
}

function tendency(t: T, ruler: Ruler, plusNature: number): string {
  if (!ruler.equivalent || !ruler.band) return "";
  const [lo, hi] = ruler.equivalent;
  if (ruler.band[0] >= plusNature || lo >= 40) return t("infer.tend.heavy");
  if (hi <= 4) return t("infer.tend.none");
  if (hi <= 16) return t("infer.tend.light");
  if (lo >= 16) return t("infer.tend.some");
  return t("infer.tend.open");
}

export function BulkRuler({ statKey, statLabel, ruler, ticks, marks }: {
  statKey: BulkKey;
  statLabel: string;
  ruler: Ruler;
  /** Products at 0 / 16 / 32 / 48 / 64 bulk-equivalent SP. */
  ticks: number[];
  marks: RulerMark[];
}) {
  const t = useInferT();
  const plusNature = ticks[ticks.length - 1] ?? ruler.axis[1];
  const summary = !ruler.observed ? t("infer.ruler.unobserved")
    : !ruler.band || !ruler.equivalent ? t("infer.ruler.none")
      : `${t("infer.ruler.eq").replace("{lo}", String(ruler.equivalent[0]))
        .replace("{hi}", ruler.band[1] > plusNature ? "64+" : String(ruler.equivalent[1]))} · ${tendency(t, ruler, plusNature)}`;
  const withStat = (text: string) => text.replaceAll("{stat}", statLabel);
  return (
    <div className={`inf-ruler${ruler.observed ? "" : " idle"}`}>
      <div className="inf-vis-head">
        <b className="inf-tip" title={withStat(t("infer.tip.ruler"))}>
          {t(statKey === "def" ? "infer.ruler.def" : "infer.ruler.spd")}</b>
        <span className={`inf-vis-sum${ruler.observed && !ruler.band ? " bad" : ""}`}
          title={withStat(t(ruler.observed ? "infer.ruler.eqHint" : "infer.tip.unobservedBulk"))}>{summary}</span>
      </div>
      <div className="inf-ruler-track" title={withStat(t("infer.tip.ruler"))}>
        {ruler.observed && (
          <div className="inf-hist" aria-hidden>
            {ruler.bins.map((value, index) => (
              <i key={index} style={{ height: value > 0 ? `${Math.max(10, value * 100)}%` : 0 }} />
            ))}
          </div>
        )}
        {ruler.observed && ruler.band && (
          <div className="inf-band" style={{
            left: `${pct(ruler.band[0], ruler.axis)}%`,
            width: `${Math.max(0.8, pct(ruler.band[1], ruler.axis) - pct(ruler.band[0], ruler.axis))}%`,
          }} />
        )}
        {marks.map((mark, index) => (
          <span key={index} className={`inf-mark${mark.fits ? " fit" : " out"}`}
            style={{ left: `${pct(mark.product, ruler.axis)}%` }}
            title={`${mark.label}\n${t(mark.fits ? "infer.tip.markFit" : "infer.tip.markOut")}`} />
        ))}
      </div>
      <div className="inf-ticks">
        {ticks.map((product, index) => (
          <span key={index} style={{ left: `${pct(product, ruler.axis)}%` }}
            title={withStat(t("infer.tip.tick")).replace("{n}", String(index * 16))}>
            {index === ticks.length - 1 ? `${index * 16} SP` : index * 16}
          </span>
        ))}
        <span className="end" style={{ left: "100%" }} title={withStat(t("infer.tip.plusNature"))}>
          {t("infer.ruler.plusNature")}</span>
      </div>
    </div>
  );
}

const MULT_LABEL: Record<string, Parameters<T>[0]> = {
  "1.1": "infer.mult.up", "1": "infer.mult.neutral", "0.9": "infer.mult.down",
};
const MULT_TIP: Record<string, Parameters<T>[0]> = {
  "1.1": "infer.tip.mult.up", "1": "infer.tip.mult.neutral", "0.9": "infer.tip.mult.down",
};

function spanOf(flags: boolean[]): string {
  const lo = flags.indexOf(true);
  if (lo < 0) return "—";
  const hi = flags.lastIndexOf(true);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

export function ItemLanes({ title, statLabel, lanes, observed, itemLabel }: {
  title: string;
  statLabel: string;
  lanes: Lane[];
  observed: boolean;
  itemLabel: (items: string[]) => string;
}) {
  const t = useInferT();
  const withStat = (text: string) => text.replaceAll("{stat}", statLabel);
  return (
    <div className={`inf-lanes${observed ? "" : " idle"}`}>
      <div className="inf-vis-head">
        <b className="inf-tip" title={withStat(t("infer.tip.lanes"))}>{title}</b>
        {!observed && <span className="inf-vis-sum" title={withStat(t("infer.tip.unobservedLanes"))}>
          {t("infer.ruler.unobserved")}</span>}
      </div>
      {observed && lanes.map((lane, index) => (
        <div key={index} className={`inf-lane${lane.feasible ? "" : " out"}`}>
          <div className="inf-lane-name" title={itemLabel(lane.items)}>
            <span>{itemLabel(lane.items)}</span>
            {!lane.feasible && <em title={withStat(t("infer.tip.laneOut"))}>{t("infer.lane.out")}</em>}
          </div>
          {lane.feasible && lane.rows.map((row) => (
            <div key={row.mult} className="inf-lane-row">
              <span className={`inf-mult m${String(row.mult).replace(".", "")}`}
                title={withStat(t(MULT_TIP[String(row.mult)]!))}>{t(MULT_LABEL[String(row.mult)]!)}</span>
              <span className="inf-cells" aria-hidden title={withStat(t("infer.tip.laneCells"))}>
                {row.flags.map((flag, sp) => <i key={sp} className={flag ? "on" : ""} />)}
              </span>
              <span className="inf-lane-span num" title={withStat(t("infer.tip.laneSpan"))}>{spanOf(row.flags)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
