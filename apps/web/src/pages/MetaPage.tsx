/** Meta-detail page: the usage facts for one pokemon in a format — moves, abilities, items,
 * natures, partners, SP spreads — alongside its base/actual stats. Reached from the ranking grid
 * and from the dex page's rank chips; the hero's rank chips switch the panels' format here. */
import type {
  FormatId, MetaDetailDto, PanelEntryDto, SpSpread, UsageTrendDto,
} from "@pokemon-champions/protocol";
import type { CSSProperties } from "react";
import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { EntityHover } from "../components/EntityHover.tsx";
import { GameImage } from "../components/GameImage.tsx";
import { MonHero } from "../components/MonHero.tsx";
import { StatsPanel } from "../components/StatsPanel.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { UsageMiniTrend } from "../components/UsageMiniTrend.tsx";
import {
  useDetail, useDexByName, useNatures, usePokemonCard, useRanking, useUsageTrend,
  type Async,
} from "../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../i18n.ts";

/** A subtle in-row usage bar: a left-anchored translucent fill behind the text, sized to the
 * ACTUAL usage percentage (a 90%-usage move fills 90%, a 40% item fills 40%) — not normalized to
 * the panel's leader. Pure background — it changes no layout (visual, not a pie or a value-bar
 * column). */
function pctBg(pct: number | null): CSSProperties | undefined {
  if (pct == null) return undefined;
  const w = Math.max(0, Math.min(100, pct));
  return { background: `linear-gradient(to right, var(--pct-fill) ${w}%, transparent ${w}%)` };
}

type NamedUsagePanel = "moves" | "items" | "abilities" | "natures";

function spreadKey(spread: SpSpread): string {
  return ["hp", "atk", "def", "spa", "spd", "spe"]
    .map((key) => spread[key as keyof SpSpread] ?? 0).join("/");
}

function TrendPreview({ trend, panel, name, spread }: {
  trend: Async<UsageTrendDto | null>;
  panel: NamedUsagePanel | "spreads";
  name?: string;
  spread?: SpSpread;
}) {
  if (trend.status === "loading") {
    return <UsageMiniTrend periods={[]} state="loading" />;
  }
  if (trend.status === "error") {
    return <UsageMiniTrend periods={[]} state="error" />;
  }
  if (!trend.data) {
    return <UsageMiniTrend periods={[]} state="missing" />;
  }
  const values = panel === "spreads"
    ? trend.data.panels.spreads.find((series) =>
      spreadKey(series.spread) === spreadKey(spread ?? {}))?.values
    : trend.data.panels[panel].find((series) => series.name === name)?.values;
  return (
    <UsageMiniTrend periods={trend.data.periods} values={values}
      state={values ? "ready" : "missing"} />
  );
}

function SimplePanel({ titleKey, rows, suffix, kind, trend, onPreviewOpen, trendPanel }: {
  titleKey: MsgKey;
  // Item rows carry the mapper-derived asset `key`; nature/ability rows don't (no sprite).
  rows: Array<PanelEntryDto & { key?: string }>;
  suffix?: (name: string) => string | null;   // e.g. a nature's +up/−down modifier
  kind: "ability" | "item" | "nature";
  trend: Async<UsageTrendDto | null>;
  onPreviewOpen: () => void;
  trendPanel: "abilities" | "items" | "natures";
}) {
  const { lang } = useLang();
  const t = useT();
  return (
    <section className="panel">
      <h2>{t(titleKey)}</h2>
      <div className="rows">
        {rows.map((r) => {
          const mod = suffix?.(r.name);
          const inner = (
            <span className="p-inner">
              {r.key && (
                <GameImage assetKey={r.key} role="dense"
                  alt={displayName(r, lang)} className="mini" />
              )}
              {displayName(r, lang)}
              {mod && <span className="p-sub">{mod}</span>}
            </span>
          );
          return (
            <div className="p-row" key={`${r.rank}-${r.name}`} style={pctBg(r.percentage)}>
              <span className="p-rank num">{r.rank}</span>
              <span className="p-name">
                <EntityHover kind={kind} name={r.name} link={kind !== "nature"}
                  onPreviewOpen={onPreviewOpen}
                  previewAddon={<TrendPreview trend={trend} panel={trendPanel} name={r.name} />}>
                  {inner}
                </EntityHover>
              </span>
              <span className="p-pct num">{r.percentage != null ? `${r.percentage.toFixed(1)}%` : "—"}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function MetaPanels({ detail, natureMod }: {
  detail: MetaDetailDto;
  natureMod: (name: string) => string | null;
}) {
  const { lang } = useLang();
  const t = useT();
  const [trendRequested, setTrendRequested] = useState(false);
  const trend = useUsageTrend(detail.format, detail.slug, trendRequested);
  const openTrend = () => setTrendRequested(true);
  return (
    <>
      <section className="panel">
        <h2>{t("detail.moves")}</h2>
        <div className="rows">
          {detail.panels.moves.map((m) => (
            <div className="p-row" key={`${m.rank}-${m.name}`} style={pctBg(m.percentage)}>
              <span className="p-rank num">{m.rank}</span>
              <span className="p-name">
                <EntityHover kind="move" name={m.name} onPreviewOpen={openTrend}
                  previewAddon={<TrendPreview trend={trend} panel="moves" name={m.name} />}>
                  <span className="p-inner">
                    <TypeBadge type={m.type} iconOnly />
                    <CategoryBadge category={m.category} />
                    {displayName(m, lang)}
                    {m.power != null && <span className="p-sub num">{m.power}</span>}
                  </span>
                </EntityHover>
              </span>
              <span className="p-pct num">{m.percentage != null ? `${m.percentage.toFixed(1)}%` : "—"}</span>
            </div>
          ))}
        </div>
      </section>
      <SimplePanel titleKey="detail.abilities" rows={detail.panels.abilities} kind="ability"
        trend={trend} onPreviewOpen={openTrend} trendPanel="abilities" />
      <SimplePanel titleKey="detail.items" rows={detail.panels.items} kind="item"
        trend={trend} onPreviewOpen={openTrend} trendPanel="items" />
      <SimplePanel titleKey="detail.natures" rows={detail.panels.natures} suffix={natureMod}
        kind="nature" trend={trend} onPreviewOpen={openTrend} trendPanel="natures" />
      {/* SP 分布 before 常见队友 (positions swapped per review) */}
      <section className="panel">
        <h2>{t("detail.spreads")}</h2>
        <div className="rows">
          {detail.panels.spreads.map((s) => (
            <div className="p-row" key={s.rank} style={pctBg(s.percentage)}>
              <span className="p-rank num">{s.rank}</span>
              <span className="p-name mono" style={{ fontSize: 12.5 }}>
                <EntityHover kind="spread" name={spreadKey(s.spread)} link={false}
                  onPreviewOpen={openTrend}
                  previewAddon={<TrendPreview trend={trend} panel="spreads" spread={s.spread} />}>
                  <span className="p-inner">
                    {Object.entries(s.spread).map(([k, v]) =>
                      `${k.toUpperCase()} ${v}`).join(" / ") || "—"}
                  </span>
                </EntityHover>
              </span>
              <span className="p-pct num">{s.percentage != null ? `${s.percentage.toFixed(1)}%` : "—"}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>{t("detail.partners")}</h2>
        <div className="rows">
          {detail.panels.partners.map((p) => (
            <div className="p-row" key={`${p.rank}-${p.name}`}>
              <span className="p-rank num">{p.rank}</span>
              <span className="p-name">
                <EntityHover kind="pokemon" name={p.name}>
                  <span className="p-inner">
                    {p.slug && <GameImage assetKey={`pokemon:${p.slug}`} role="dense"
                      alt={displayName(p, lang)} className="mini" />}
                    {displayName(p, lang)}
                  </span>
                </EntityHover>
              </span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

export function MetaPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const format = (params.get("format") === "double" ? "double" : "single") as FormatId;
  const card = usePokemonCard(slug);
  const detail = useDetail(format, slug);
  const singleRanking = useRanking("single");
  const doubleRanking = useRanking("double");
  const natures = useNatures();
  const dexByName = useDexByName();
  const { lang } = useLang();
  const t = useT();

  // Base/Mega identity toggle: meta usage is keyed by the BASE species, but a mega team
  // plays the mega's types/abilities/stats — the name line offers both and the hero +
  // stats panel follow the selection. Usage panels and rank chips stay on the base.
  const [formIdx, setFormIdx] = useState(0);
  useEffect(() => { setFormIdx(0); }, [slug]);
  const megaList = card.status === "ready" ? card.data.megaForms ?? [] : [];
  const megaTarget = formIdx > 0 ? megaList[formIdx - 1]?.name ?? slug : slug;
  const megaCard = usePokemonCard(megaTarget);

  // Nature name -> "+Up/−Down" modifier (the meta natures panel ships names only).
  const natureMod = (name: string): string | null => {
    if (natures.status !== "ready") return null;
    const n = natures.data.find((x) => x.name === name);
    return n?.upStat && n?.downStat
      ? `+${n.upStat.toUpperCase()}/−${n.downStat.toUpperCase()}` : null;
  };

  if (card.status === "loading") return <div className="spinner">{t("state.loading")}</div>;
  if (card.status === "error") {
    return <div className="notice">{t("state.errorDetail")}</div>;
  }
  const base = card.data;
  // The hero/stats follow the selected form; usage panels + rank chips stay on the base.
  const mon = formIdx > 0 && megaCard.status === "ready" && megaCard.data.slug !== base.slug
    ? megaCard.data : base;
  const rankOf = (r: typeof singleRanking) =>
    r.status === "ready" ? r.data.rows.find((row) => row.slug === base.slug)?.rank ?? null : null;
  const ranks: Array<[FormatId, number | null]> = [
    ["single", rankOf(singleRanking)], ["double", rankOf(doubleRanking)],
  ];
  const formLabel = (name: string) => {
    const e = dexByName.get(name);
    return e ? displayName(e, lang) : name;
  };
  const forms = megaList.length > 0 ? [
    { key: "base", label: displayName(base, lang), active: formIdx === 0,
      onSelect: () => setFormIdx(0) },
    ...megaList.map((mf, i) => ({
      key: mf.name, label: formLabel(mf.name), active: formIdx === i + 1,
      onSelect: () => setFormIdx(i + 1) })),
  ] : undefined;

  return (
    <>
      <MonHero mon={mon} ranks={ranks} activeFormat={format} forms={forms}
        onRank={(f) => setParams({ format: f })} />
      <div className="detail-grid">
        <StatsPanel stats={mon.stats} />
        {detail.status === "ready" && (
          <MetaPanels key={`${format}:${slug}`} detail={detail.data} natureMod={natureMod} />
        )}
      </div>
      {detail.status === "error" && (
        // A 404 is the factual "not ranked this period"; anything else (bridge down, 5xx,
        // malformed projection) is a real load failure and must not masquerade as a meta fact.
        detail.httpStatus === 404
          ? <div className="notice" style={{ marginTop: 14 }}>{t("detail.notRanked")}</div>
          : <div className="notice" style={{ marginTop: 14 }}>{t("state.errorDetail")}</div>
      )}
    </>
  );
}
