/** Shared pieces of the metagame detail cards: a usage row, its change cell, a panel head, and the
 * hover sparkline every row and portrait opens.
 *
 * A row is one hover target from edge to edge. It no longer selects anything, so it has no pressed
 * state; its share is drawn as a thin bar under the label, sized to the ACTUAL percentage (a 40%
 * item fills 40% of the track) rather than normalised to the panel's leader. */
import type { SpSpread, UsageTrendDto } from "@pokemon-champions/protocol";
import type { CSSProperties, ReactNode } from "react";
import type { Async } from "../../hooks.ts";
import { EntityHover, type EntityKind } from "../../components/EntityHover.tsx";
import { RankMiniTrend, UsageMiniTrend } from "../../components/UsageMiniTrend.tsx";
import { useT } from "../../i18n.ts";
import { spreadKey } from "../../lib/spread.ts";
import type { UsageDelta } from "../../lib/usageDelta.ts";

type UsagePanel = "moves" | "items" | "abilities" | "natures";

/** One series out of the usage history document; undefined while it loads or when the row has no
 * history of its own. */
export function usageSeries(trend: Async<UsageTrendDto | null>, panel: UsagePanel,
                            name: string): Array<number | null> | undefined {
  return trend.status === "ready" && trend.data
    ? trend.data.panels[panel].find((s) => s.name === name)?.values : undefined;
}

export function spreadSeries(trend: Async<UsageTrendDto | null>,
                             spread: SpSpread): Array<number | null> | undefined {
  const key = spreadKey(spread);
  return trend.status === "ready" && trend.data
    ? trend.data.panels.spreads.find((s) => spreadKey(s.spread) === key)?.values : undefined;
}

export function partnerRanks(trend: Async<UsageTrendDto | null>,
                             nationalDex: number | undefined): Array<number | null> | undefined {
  return trend.status === "ready" && trend.data && nationalDex != null
    ? trend.data.panels.partners.find((s) => s.nationalDex === nationalDex)?.ranks : undefined;
}

/** The hover sparkline. Panels with a share draw the share; panels that publish only an order
 * (teammates, KO opponents) draw the RANK — same shape, different axis and unit. */
export function TrendAddon({ trend, values, kind }: {
  trend: Async<{ periods: string[] } | null>;
  values: Array<number | null> | undefined;
  kind: "pct" | "rank";
}) {
  const Chart = kind === "rank" ? RankMiniTrend : UsageMiniTrend;
  if (trend.status === "loading") return <Chart periods={[]} state="loading" />;
  if (trend.status === "error") return <Chart periods={[]} state="error" />;
  if (!trend.data) return <Chart periods={[]} state="missing" />;
  return <Chart periods={trend.data.periods} values={values} state={values ? "ready" : "missing"} />;
}

export function PanelHead({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="mc-head">
      <h3>{title}</h3>
      {note && <span className="mc-head-note">{note}</span>}
    </div>
  );
}

export function pctText(value: number | null) {
  return value == null ? "—" : <>{value.toFixed(1)}<small>%</small></>;
}

export function DeltaCell({ delta, baseline }: { delta: UsageDelta; baseline?: string }) {
  const t = useT();
  if (delta.kind === "none") return <span className="mc-dl" />;
  if (delta.kind === "new") {
    return <span className="mc-dl new" title={t("mc.newTitle")}>{t("mc.new")}</span>;
  }
  const sign = delta.kind === "up" ? "+" : "−";
  const title = baseline
    ? t("mc.deltaTitle").replace("{date}", baseline).replace("{v}", `${sign}${delta.value.toFixed(1)}`)
    : undefined;
  return (
    <span className={`mc-dl ${delta.kind}${delta.minor ? " minor" : ""}`} title={title}>
      <span aria-hidden="true">{delta.kind === "up" ? "▲" : "▼"}</span>
      <span className="mc-sr">{sign}</span>{delta.value.toFixed(1)}
    </span>
  );
}

export function UsageRow({ rank, lead, pct, delta, baseline, hover, sub, children, style }: {
  rank: number;
  lead: boolean;
  pct: number | null;
  /** Absent in panels that carry no change column (the KO move lists). */
  delta?: UsageDelta;
  baseline?: string;
  hover: { kind: EntityKind; name: string; addon: ReactNode; onOpen?: () => void };
  sub?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) {
  const width = Math.max(0, Math.min(100, pct ?? 0));
  return (
    <EntityHover kind={hover.kind} name={hover.name} link={false} previewAddon={hover.addon}
                 onPreviewOpen={hover.onOpen}>
      <span className={`mc-row${lead ? " lead" : ""}${delta ? "" : " no-delta"}`} style={style}>
        <span className="mc-rk">{rank}</span>
        <span className="mc-main" style={{ "--w": `${width}%` } as CSSProperties}>
          <span className="mc-label">{children}</span>
          {sub}
        </span>
        <span className="mc-pct">{pctText(pct)}</span>
        {delta && <DeltaCell delta={delta} baseline={baseline} />}
      </span>
    </EntityHover>
  );
}
