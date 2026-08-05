/** Rank bump chart over the trend DTO — the interactive sibling of the shipped PNG charts, and
 * kept in RANGE-lockstep with them (design/CLAUDE sync): it renders EVERY series the trend store
 * carries (all Top-30 + big movers that reached top 60 — the membership `trend.py` already baked
 * in), never a second client-side top-N filter. It reuses the PNG's piecewise rank axis (1–30
 * uniform, 30–60 compressed, deep tail squeezed) and its up/down/swing/flat coloring so the two
 * read the same: movers are the loud colored lines, stable mons are thin grey context. */
import type { TrendDto } from "@pokemon-champions/protocol";
import { LineChart } from "echarts/charts";
import { GridComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useDexByName } from "../hooks.ts";
import { displayName, optionalKey, useLang, useT, type Lang } from "../i18n.ts";
import type { DexIndexEntry } from "../runtime/adapter.ts";

echarts.use([LineChart, GridComponent, TooltipComponent, MarkLineComponent, MarkAreaComponent,
  CanvasRenderer]);

// Piecewise-linear rank transform — the SAME zones as the PNG (dev/update/meta/trend_chart.py):
// ranks 1–30 uniform (the zone that matters), 30–60 compressed, past 60 squeezed to context.
const BREAK = 30, BREAK2 = 60, DENSE = 5, SPARSE = 10, TAIL = 25;
function fwd(rank: number): number {
  if (rank <= BREAK) return rank / DENSE;
  if (rank <= BREAK2) return BREAK / DENSE + (rank - BREAK) / SPARSE;
  return BREAK / DENSE + (BREAK2 - BREAK) / SPARSE + (rank - BREAK2) / TAIL;
}

const UP = ["#1a9850", "#41ab5d", "#006837", "#78c679", "#238443"];
const DOWN = ["#d73027", "#f46d43", "#a50026", "#fd8d3c", "#e31a1c"];
const SWING = "#b8860b", FLAT = "#9aa0a6";

type Kind = "up" | "down" | "swing" | "flat";
function classify(ranks: Array<number | null>): Kind {
  const present = ranks.filter((r): r is number => r != null);
  if (present.length < 2 || Math.max(...present) - Math.min(...present) < 2) return "flat";
  const net = present[0]! - present[present.length - 1]!;   // >0 = climbed (rank number shrank)
  return net > 0 ? "up" : net < 0 ? "down" : "swing";
}

const STAT_ROW: ReadonlyArray<[string, keyof DexIndexEntry["stats"]]> = [
  ["HP", "hp"], ["A", "atk"], ["B", "def"], ["C", "spa"], ["D", "spd"], ["S", "spe"],
];

function buildOption(trend: TrendDto, lang: Lang, dex: Map<string, DexIndexEntry>,
                     typeLabel: (tp: string) => string) {
  const maxRank = Math.max(30, ...trend.series.flatMap((s) =>
    s.ranks.filter((r): r is number => r != null)));
  const yMin = fwd(0.4), yMax = fwd(Math.max(maxRank + 3, 32));
  const ticks = [1, 5, 10, 15, 20, 25, 30];
  for (let r = 40; r <= maxRank; r += 10) ticks.push(r);

  let up = 0, down = 0;
  const lineSeries = trend.series.map((s) => {
    const kind = classify(s.ranks);
    const color = kind === "up" ? UP[up++ % UP.length]!
      : kind === "down" ? DOWN[down++ % DOWN.length]!
      : kind === "swing" ? SWING : FLAT;
    const loud = kind !== "flat";
    const name = displayName(s, lang);
    // Right-end label carries the current rank AND the net move over the window (▲climbed /
    // ▼fell), mirroring the PNG's "name rank ▲n".
    const present = s.ranks.filter((r): r is number => r != null);
    const last = present[present.length - 1];
    const net = present.length >= 2 ? present[0]! - last! : 0;
    const delta = net > 0 ? ` ▲${net}` : net < 0 ? ` ▼${-net}` : "";
    const endText = last != null ? `${name}  #${last}${delta}` : name;
    return {
      name, type: "line" as const, connectNulls: false, triggerLineEvent: true,
      data: s.ranks.map((r) => (r != null ? { value: fwd(r), rank: r } : null)),
      lineStyle: { width: loud ? 2.4 : 1, color, opacity: loud ? 0.95 : 0.5 },
      itemStyle: { color },
      symbol: "circle", symbolSize: loud ? 6 : 3.5,
      z: loud ? 3 : 2,
      // Every series needs an identity at the right edge. Stable lines are intentionally quieter,
      // but hiding their labels entirely made several Pokémon look like anonymous chart strokes.
      endLabel: {
        show: true, formatter: endText, color: loud ? color : "#778394", fontSize: 11,
        distance: 7, width: 178, overflow: "truncate",
        fontWeight: loud ? "bold" as const : "normal" as const,
      },
      // Shift colliding end labels vertically instead of dropping one of the names.
      labelLayout: { moveOverlap: "shiftY" as const, hideOverlap: false },
      // Hover has to read against ~60 overlapping strokes, so emphasis lifts the WHOLE series
      // identity: full opacity, a heavier line, enlarged dots, and the name promoted to a solid
      // chip (a width bump alone was invisible in the crowd, and the name — the thing users
      // actually track — had no hover state at all). `focus` stays "none": ECharts' series-blur
      // dimmed every other line, which made the chart pulse as the pointer crossed it (especially
      // in dark mode). Lifting only the hovered series gives the same read without the flicker.
      emphasis: {
        focus: "none" as const,
        scale: 1.8,
        lineStyle: { width: loud ? 5 : 4, opacity: 1 },
        itemStyle: { color, borderColor: "#fff", borderWidth: 1.5 },
        endLabel: {
          // White on the series colour; flat lines borrow a darker grey so the text stays legible
          // against their otherwise light stroke colour.
          color: "#fff", fontSize: 12.5, fontWeight: "bold" as const,
          backgroundColor: loud ? color : "#5f6672",
          padding: [3, 7, 3, 7] as [number, number, number, number], borderRadius: 4,
        },
      },
    };
  });

  // A silent carrier series draws the rank gridlines (labeled at the left) + tier bands, so the
  // value axis itself stays unlabeled (its coordinates are transformed, not raw ranks).
  const gridSeries = {
    type: "line" as const, data: [], silent: true, tooltip: { show: false },
    markArea: {
      silent: true,
      data: [
        [{ yAxis: fwd(0.5), itemStyle: { color: "rgba(255,193,7,0.10)" } }, { yAxis: fwd(10.5) }],
        [{ yAxis: fwd(10.5), itemStyle: { color: "rgba(59,130,246,0.08)" } }, { yAxis: fwd(30.5) }],
      ],
    },
    markLine: {
      silent: true, symbol: "none",
      lineStyle: { color: "#c8d0d8", type: "dashed", opacity: 0.55 },
      label: { position: "start", formatter: "{b}", color: "#8a97a5", fontSize: 10 },
      data: ticks.map((t) => ({ name: `#${t}`, yAxis: fwd(t) })),
    },
  };

  return {
    // The chart already carries every requested series. Avoid making the user wait for
    // ECharts' default entrance tween before the complete trend picture is readable.
    animation: false,
    grid: { left: 44, right: 190, top: 16, bottom: 30 },
    tooltip: {
      trigger: "item" as const,
      // The canvas can't host DOM hover cards, so the tooltip IS the quick-facts card:
      // localized name + rank, then types and the base-stat line from the dex index.
      formatter: (p: { seriesName: string; name: string; data: { rank: number } | null }) => {
        if (!p.data) return "";
        const head = `${p.seriesName}<br/>${p.name} · <b>#${p.data.rank}</b>`;
        const e = [...dex.values()].find((x) =>
          displayName(x, lang) === p.seriesName || x.name === p.seriesName);
        if (!e) return head;
        const types = e.types.map(typeLabel).join(" / ");
        const stats = STAT_ROW.map(([k, f]) => `${k} ${e.stats[f]}`).join(" · ");
        return `${head}<br/><span style="color:#8a97a5">${types}</span>`
          + `<br/><span style="font-size:11px;color:#8a97a5">${stats}</span>`;
      },
    },
    xAxis: {
      type: "category" as const, data: trend.periods, boundaryGap: false,
      axisLine: { show: false }, axisTick: { show: false },
    },
    yAxis: {
      type: "value" as const, inverse: true, min: yMin, max: yMax,
      axisLabel: { show: false }, splitLine: { show: false },
      axisLine: { show: false }, axisTick: { show: false },
    },
    series: [gridSeries, ...lineSeries],
  };
}

export default function TrendChart({ trend }: { trend: TrendDto }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ReturnType<typeof echarts.init> | null>(null);
  const { lang } = useLang();
  const t = useT();
  const navigate = useNavigate();
  const dex = useDexByName();

  // Clicking a series (line, point, or end label) opens that pokemon's META detail for
  // the chart's format. The handler resolves through the trend's own series list so
  // localized display names still map back to the slug.
  const navRef = useRef<(seriesName: string) => void>(() => {});
  navRef.current = (seriesName: string) => {
    const hit = trend.series.find((s) => displayName(s, lang) === seriesName
      || s.name === seriesName);
    if (hit) navigate(`/meta/${hit.slug}?format=${trend.format}`);
  };

  // Create/destroy the ECharts instance ONCE; data/language changes below only push a new option.
  useEffect(() => {
    if (!ref.current) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    chart.on("click", (p) => {
      const name = (p as { seriesName?: string }).seriesName;
      if (name) navRef.current(name);
    });
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const typeLabel = (tp: string) => {
      const k = optionalKey(`type.${tp}`);
      return k ? t(k) : tp;
    };
    chartRef.current?.setOption(buildOption(trend, lang, dex, typeLabel), true);   // notMerge
  }, [trend, lang, dex, t]);

  const minHeight = Math.max(620, trend.series.length * 16 + 72);
  return <div ref={ref} className="panel trend-chart"
    style={{ height: `max(calc(100vh - 188px), ${minHeight}px)`, minHeight, padding: 8 }} />;
}
