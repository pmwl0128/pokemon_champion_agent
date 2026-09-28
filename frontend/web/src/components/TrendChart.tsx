/** Rank bump chart over the trend DTO — the interactive sibling of the shipped PNG charts, and
 * kept in RANGE-lockstep with them (design/CLAUDE sync): it renders EVERY series the trend store
 * carries (all Top-30 + big movers that reached top 60 — the membership `trend.py` already baked
 * in), never a second client-side top-N filter. It reuses the PNG's piecewise rank axis (1–30
 * uniform, 30–60 compressed, deep tail squeezed) and its up/down/swing/flat coloring so the two
 * read the same: movers are the loud colored lines, stable mons are thin grey context.
 *
 * Drawn as plain SVG. A trend document does not change between data refreshes, so everything the
 * chart derives from it — each line's kind, colour, end label and transformed ranks — is computed
 * once per document and language and cached; only the pixel geometry follows the container's size.
 * (A charting library re-initialised and re-laid out every series on each visit to the view.) */
import type { TrendDto } from "@pokemon-champions/protocol";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDexIndex } from "../hooks.ts";
import { displayName, optionalKey, useLang, useT, type Lang } from "../i18n.ts";
import { dexLookup } from "../lib/lookup.ts";
import type { DexIndexEntry } from "../runtime/adapter.ts";

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
const SWING = "#b8860b", FLAT = "#9aa0a6", FLAT_CHIP = "#5f6672";
const PAD = { left: 44, right: 190, top: 16, bottom: 30 };
const LABEL_GAP = 13;      // px between stacked end labels
const LABEL_WIDTH = 178;   // an end label longer than this is cut with an ellipsis

type Kind = "up" | "down" | "swing" | "flat";
function classify(ranks: Array<number | null>): Kind {
  const present = ranks.filter((r): r is number => r != null);
  if (present.length < 2 || Math.max(...present) - Math.min(...present) < 2) return "flat";
  const net = present[0]! - present[present.length - 1]!;   // >0 = climbed (rank number shrank)
  return net > 0 ? "up" : net < 0 ? "down" : "swing";
}

/** Rough rendered width of a label: CJK glyphs about a full em, Latin about half. */
function textWidth(text: string, size: number): number {
  return [...text].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? size : size * 0.58), 0);
}
function clip(text: string, size: number, width: number): string {
  if (textWidth(text, size) <= width) return text;
  let out = "";
  for (const ch of text) {
    if (textWidth(`${out}${ch}…`, size) > width) break;
    out += ch;
  }
  return `${out}…`;
}

interface LineModel {
  slug: string;
  name: string;
  kind: Kind;
  color: string;
  loud: boolean;
  ranks: Array<number | null>;
  /** Transformed rank per period, null where the Pokémon was outside the window. */
  values: Array<number | null>;
  /** The last period with a rank: where the line ends and its label sits. */
  last: number;
  endText: string;
}
interface ChartModel {
  /** Quiet lines first, so the movers draw over them. */
  lines: LineModel[];
  yMin: number;
  yMax: number;
  ticks: number[];
}

const models = new WeakMap<TrendDto, Map<Lang, ChartModel>>();

function modelOf(trend: TrendDto, lang: Lang): ChartModel {
  let byLang = models.get(trend);
  if (!byLang) { byLang = new Map(); models.set(trend, byLang); }
  const hit = byLang.get(lang);
  if (hit) return hit;
  const maxRank = Math.max(30, ...trend.series.flatMap((s) => s.ranks.filter((r): r is number => r != null)));
  const ticks = [1, 5, 10, 15, 20, 25, 30];
  for (let r = 40; r <= maxRank; r += 10) ticks.push(r);
  let up = 0, down = 0;
  const lines = trend.series.map((s): LineModel => {
    const kind = classify(s.ranks);
    const color = kind === "up" ? UP[up++ % UP.length]!
      : kind === "down" ? DOWN[down++ % DOWN.length]!
      : kind === "swing" ? SWING : FLAT;
    const name = displayName(s, lang);
    // The end label carries the current rank AND the net move over the window (▲climbed /
    // ▼fell), mirroring the PNG's "name rank ▲n".
    const present = s.ranks.filter((r): r is number => r != null);
    const lastRank = present[present.length - 1];
    const net = present.length >= 2 ? present[0]! - lastRank! : 0;
    const delta = net > 0 ? ` ▲${net}` : net < 0 ? ` ▼${-net}` : "";
    let last = -1;
    s.ranks.forEach((r, index) => { if (r != null) last = index; });
    return {
      slug: s.slug, name, kind, color, loud: kind !== "flat", ranks: s.ranks,
      values: s.ranks.map((r) => (r != null ? fwd(r) : null)), last,
      endText: lastRank != null ? `${name}  #${lastRank}${delta}` : name,
    };
  });
  const model: ChartModel = {
    lines: [...lines.filter((line) => !line.loud), ...lines.filter((line) => line.loud)],
    yMin: fwd(0.4), yMax: fwd(Math.max(maxRank + 3, 32)), ticks,
  };
  byLang.set(lang, model);
  return model;
}

/** The line's path, broken where the Pokémon left the window (no bridging across gaps). */
function pathOf(values: Array<number | null>, x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let pen = false;
  values.forEach((value, index) => {
    if (value == null) { pen = false; return; }
    d += `${pen ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** End labels stacked apart where they would overlap (lines ending on the same period only). */
function placeLabels(lines: LineModel[], y: (v: number) => number, bottom: number): Map<string, number> {
  const out = new Map<string, number>();
  const byEnd = new Map<number, Array<{ slug: string; y: number }>>();
  for (const line of lines) {
    if (line.last < 0) continue;
    const list = byEnd.get(line.last) ?? [];
    list.push({ slug: line.slug, y: y(line.values[line.last]!) });
    byEnd.set(line.last, list);
  }
  for (const list of byEnd.values()) {
    list.sort((a, b) => a.y - b.y);
    for (let i = 1; i < list.length; i++) list[i]!.y = Math.max(list[i]!.y, list[i - 1]!.y + LABEL_GAP);
    const overflow = list.length ? list[list.length - 1]!.y - bottom : 0;
    if (overflow > 0) {
      list[list.length - 1]!.y -= overflow;
      for (let i = list.length - 2; i >= 0; i--) list[i]!.y = Math.min(list[i]!.y, list[i + 1]!.y - LABEL_GAP);
    }
    for (const label of list) out.set(label.slug, label.y);
  }
  return out;
}

const STAT_ROW: ReadonlyArray<[string, keyof DexIndexEntry["stats"]]> = [
  ["HP", "hp"], ["A", "atk"], ["B", "def"], ["C", "spa"], ["D", "spd"], ["S", "spe"],
];

export default function TrendChart({ trend }: { trend: TrendDto }) {
  const ref = useRef<HTMLDivElement>(null);
  const { lang } = useLang();
  const t = useT();
  const navigate = useNavigate();
  const dex = useDexIndex();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hot, setHot] = useState<string | null>(null);
  const [tip, setTip] = useState<{ slug: string; index: number } | null>(null);
  const model = useMemo(() => modelOf(trend, lang), [trend, lang]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setSize({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const plotW = Math.max(1, width - PAD.left - PAD.right);
  const plotH = Math.max(1, height - PAD.top - PAD.bottom);
  const count = trend.periods.length;
  const x = (index: number) => count > 1 ? PAD.left + (index * plotW) / (count - 1) : PAD.left + plotW / 2;
  const y = (value: number) => PAD.top + ((value - model.yMin) / (model.yMax - model.yMin)) * plotH;
  const labelY = useMemo(() => width ? placeLabels(model.lines, y, height - 6) : new Map<string, number>(),
    [model, width, height]);

  const open = (slug: string) => navigate(`/meta/${slug}?format=${trend.format}`);
  const minHeight = Math.max(620, trend.series.length * 16 + 72);

  const drawLine = (line: LineModel, emphasis: boolean) => {
    const path = pathOf(line.values, x, y);
    const endY = labelY.get(line.slug);
    const lineWidth = emphasis ? (line.loud ? 5 : 4) : line.loud ? 2.4 : 1;
    const dot = (line.loud ? 3 : 1.75) * (emphasis ? 1.8 : 1);
    const label = clip(line.endText, emphasis ? 12.5 : 11, LABEL_WIDTH);
    const chipW = textWidth(label, 12.5) + 14;
    return (
      <g key={`${line.slug}${emphasis ? ":hot" : ""}`} className={`trend-line${emphasis ? " hot" : ""}`}
         onPointerEnter={() => setHot(line.slug)}
         onPointerLeave={() => { setHot((current) => current === line.slug ? null : current); setTip(null); }}
         onClick={() => open(line.slug)}>
        <path d={path} className="trend-hit" />
        <path d={path} fill="none" stroke={line.color} strokeWidth={lineWidth}
              strokeOpacity={emphasis ? 1 : line.loud ? 0.95 : 0.5} strokeLinejoin="round" strokeLinecap="round" />
        {line.values.map((value, index) => value == null ? null : (
          <circle key={index} cx={x(index)} cy={y(value)} r={dot} fill={line.color}
                  stroke={emphasis ? "#fff" : "none"} strokeWidth={emphasis ? 1.5 : 0}
                  onPointerEnter={() => setTip({ slug: line.slug, index })} />
        ))}
        {endY != null && line.last >= 0 && (emphasis ? (
          <g transform={`translate(${x(line.last) + 7} ${endY})`}>
            <rect x={0} y={-10} width={chipW} height={20} rx={4} fill={line.loud ? line.color : FLAT_CHIP} />
            <text x={7} y={0} dominantBaseline="central" className="trend-label hot">{label}</text>
          </g>
        ) : (
          <text x={x(line.last) + 7} y={endY} dominantBaseline="central"
                className={`trend-label${line.loud ? " loud" : ""}`} fill={line.loud ? line.color : undefined}>
            {label}
          </text>
        ))}
      </g>
    );
  };

  const hotLine = hot ? model.lines.find((line) => line.slug === hot) : undefined;
  const tipLine = tip ? model.lines.find((line) => line.slug === tip.slug) : undefined;
  const tipRank = tipLine?.ranks[tip!.index];
  const tipEntry = tipLine && dex.status === "ready" ? dexLookup(dex.data).bySlug.get(tipLine.slug) : undefined;
  const typeLabel = (tp: string) => {
    const key = optionalKey(`type.${tp}`);
    return key ? t(key) : tp;
  };

  return (
    <div ref={ref} className="panel trend-chart"
      style={{ height: `max(calc(100vh - 188px), ${minHeight}px)`, minHeight, padding: 0 }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={t("trend.title")}>
          <rect x={PAD.left} width={plotW} y={y(fwd(0.5))} height={y(fwd(10.5)) - y(fwd(0.5))} className="trend-band top" />
          <rect x={PAD.left} width={plotW} y={y(fwd(10.5))} height={y(fwd(30.5)) - y(fwd(10.5))} className="trend-band mid" />
          {model.ticks.map((tick) => (
            <g key={tick} className="trend-tick">
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(fwd(tick))} y2={y(fwd(tick))} />
              <text x={PAD.left - 6} y={y(fwd(tick))} dominantBaseline="central" textAnchor="end">#{tick}</text>
            </g>
          ))}
          {trend.periods.map((period, index) => (
            <text key={period} x={x(index)} y={height - 10} textAnchor="middle" className="trend-period">{period}</text>
          ))}
          {model.lines.map((line) => drawLine(line, false))}
          {hotLine && drawLine(hotLine, true)}
        </svg>
      )}
      {tipLine && tipRank != null && (
        <div className="trend-tip" style={{
          // Beside the point, flipped to its left near the right edge and above it near the bottom.
          left: x(tip!.index) + 12 + 220 > width ? Math.max(8, x(tip!.index) - 232) : x(tip!.index) + 12,
          top: y(tipLine.values[tip!.index]!) > height - 120
            ? y(tipLine.values[tip!.index]!) - 104 : Math.max(8, y(tipLine.values[tip!.index]!) - 12),
        }}>
          <b>{tipLine.name}</b>
          <span>{trend.periods[tip!.index]} · <b>#{tipRank}</b></span>
          {tipEntry && <span className="muted">{tipEntry.types.map(typeLabel).join(" / ")}</span>}
          {tipEntry && <small className="muted">{STAT_ROW.map(([k, f]) => `${k} ${tipEntry.stats[f]}`).join(" · ")}</small>}
        </div>
      )}
    </div>
  );
}
