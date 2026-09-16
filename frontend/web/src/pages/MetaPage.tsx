/** Meta-detail page: the usage facts for one pokemon in a format — moves, abilities, items,
 * natures, partners, SP spreads — alongside its base/actual stats. Reached from the ranking grid
 * and from the dex page's rank chips; the hero's rank chips switch the panels' format here. */
import type {
  FormatId, MetaDetailDto, PanelEntryDto, SpSpread, StatKey, Stats, UsageTrendDto,
} from "@pokemon-champions/protocol";
import type { CSSProperties, Dispatch, ReactNode, SetStateAction } from "react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EntityHover } from "../components/EntityHover.tsx";
import { GameImage } from "../components/GameImage.tsx";
import { KoBlock } from "../components/KoPanels.tsx";
import { MetaRail, useMetaRails } from "../components/MetaRails.tsx";
import { RailHandle } from "../components/SideRail.tsx";
import { typeColor } from "../assets/icons.ts";
import { MonHero } from "../components/MonHero.tsx";
import { StatValues } from "../components/StatValues.tsx";
import { CategoryBadge, TypeBadge } from "../components/TypeBadge.tsx";
import { RankMiniTrend, UsageMiniTrend } from "../components/UsageMiniTrend.tsx";
import {
  useDetail, useDexByName, useKo, useKoTrend, useNatures, usePokemonCard, useRanking,
  useUsageTrend, type Async,
} from "../hooks.ts";
import { displayName, useLang, useT, type MsgKey } from "../i18n.ts";
import {
  NO_PICKS, PICK_LIMITS, spreadKey, toggleMany, toggleOne, type MetaPicks,
} from "../lib/metaPicks.ts";
import { stashCalcTeams, type CalcMember } from "../lib/team.ts";

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

/** A usage row, pressed to take it into the question the page is assembling.
 *
 * The whole row is the switch. That is why these rows no longer navigate: a row cannot be both "go
 * read about this" and "add this", and on a page whose purpose is to assemble a set, adding is the
 * act worth a click — the hover card still carries the entity's facts.
 *
 * Selection shows as a ring plus a brand edge, never as a background wash and never as an extra
 * glyph: the row background already carries the usage bar, so a second tint there would read as more
 * usage, and a trailing tick would take width the names need. */
function PickRow({ on, disabled, onToggle, className, style, children }: {
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const t = useT();
  const locked = disabled && !on;
  return (
    <div className={`p-row pickable${on ? " picked" : ""}${locked ? " locked" : ""}`
      + (className ? ` ${className}` : "")}
      style={style} role="button" tabIndex={locked ? -1 : 0} aria-pressed={on}
      aria-disabled={locked || undefined} title={t("detail.pickRow")}
      onClick={() => !locked && onToggle()}
      onKeyDown={(e) => {
        if (locked) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
      }}>
      {children}
    </div>
  );
}

function TrendPreview({ trend, panel, name, spread, nationalDex }: {
  trend: Async<UsageTrendDto | null>;
  panel: NamedUsagePanel | "spreads" | "partners";
  name?: string;
  spread?: SpSpread;
  /** Teammate rows are species-level: the national dex number is their identity, so it is also the
   * key their history is stored under. */
  nationalDex?: number;
}) {
  // The teammate panel has no percentage upstream, so its history is a RANK series and it gets the
  // rank chart — same shape, different axis, different unit of change.
  const Chart = panel === "partners" ? RankMiniTrend : UsageMiniTrend;
  if (trend.status === "loading") return <Chart periods={[]} state="loading" />;
  if (trend.status === "error") return <Chart periods={[]} state="error" />;
  if (!trend.data) return <Chart periods={[]} state="missing" />;
  const values = panel === "spreads"
    ? trend.data.panels.spreads.find((series) =>
      spreadKey(series.spread) === spreadKey(spread ?? {}))?.values
    : panel === "partners"
      ? trend.data.panels.partners.find((series) => series.nationalDex === nationalDex)?.ranks
      : trend.data.panels[panel].find((series) => series.name === name)?.values;
  return (
    <Chart periods={trend.data.periods} values={values} state={values ? "ready" : "missing"} />
  );
}

function SimplePanel({ titleKey, rows, suffix, kind, trend, onPreviewOpen, trendPanel,
                      picked, onPick, className }: {
  titleKey: MsgKey;
  // Item rows carry the mapper-derived asset `key`; nature/ability rows don't (no sprite).
  rows: Array<PanelEntryDto & { key?: string }>;
  suffix?: (name: string) => string | null;   // e.g. a nature's +up/−down modifier
  kind: "ability" | "item" | "nature";
  trend: Async<UsageTrendDto | null>;
  onPreviewOpen: () => void;
  trendPanel: "abilities" | "items" | "natures";
  picked: (name: string) => boolean;
  onPick: (name: string) => void;
  className?: string;
}) {
  const { lang } = useLang();
  const t = useT();
  return (
    <section className={`panel${className ? ` ${className}` : ""}`}>
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
            <PickRow key={`${r.rank}-${r.name}`} style={pctBg(r.percentage)}
                     on={picked(r.name)} onToggle={() => onPick(r.name)}>
              <span className="p-rank num">{r.rank}</span>
              <span className="p-name">
                <EntityHover kind={kind} name={r.name} link={false} passive
                  onPreviewOpen={onPreviewOpen}
                  previewAddon={<TrendPreview trend={trend} panel={trendPanel} name={r.name} />}>
                  {inner}
                </EntityHover>
              </span>
              <span className="p-pct num">{r.percentage != null ? `${r.percentage.toFixed(1)}%` : "—"}</span>
            </PickRow>
          );
        })}
      </div>
    </section>
  );
}

function MetaPanels({ detail, natureMod, natureStat, usageRank, stats, picks, setPicks }: {
  detail: MetaDetailDto;
  natureMod: (name: string) => string | null;
  /** The stat a nature raises or lowers, for the value card. */
  natureStat: (name: string | null, dir: "up" | "down") => StatKey | null;
  /** English canonical -> this format's usage rank, for the partner column. */
  usageRank: Map<string, number>;
  /** Base stats for the value card that leads the grid. */
  stats: Stats;
  picks: MetaPicks;
  /** React's own setter, passed through: two quick clicks must both land, and an object built from
   * the render's `picks` would have the second one overwrite the first. */
  setPicks: Dispatch<SetStateAction<MetaPicks>>;
}) {
  const { lang } = useLang();
  const t = useT();
  const [trendRequested, setTrendRequested] = useState(false);
  const trend = useUsageTrend(detail.format, detail.slug, trendRequested);
  const openTrend = () => setTrendRequested(true);
  // Nature and SP are one answer: a spread without a nature computes nothing, and a nature without
  // a spread names no number. Picking either therefore brings the other's leader with it, and the
  // reader adjusts from there.
  const pickNature = (name: string) => setPicks((prev) => {
    const nature = toggleOne(prev.nature, name);
    return {
      ...prev, nature,
      spread: nature && !prev.spread ? detail.panels.spreads[0]?.spread ?? null : prev.spread,
    };
  });
  const pickSpread = (spread: SpSpread) => setPicks((prev) => {
    const next = toggleOne(prev.spread, spread, (a, b) => spreadKey(a) === spreadKey(b));
    return {
      ...prev, spread: next,
      nature: next && !prev.nature ? detail.panels.natures[0]?.name ?? null : prev.nature,
    };
  });

  return (
    <>
      <div className="detail-pair">
        <StatValues stats={stats} spread={picks.spread}
          natureUp={natureStat(picks.nature, "up")} natureDown={natureStat(picks.nature, "down")} />
        <SimplePanel titleKey="detail.abilities" rows={detail.panels.abilities} kind="ability"
          trend={trend} onPreviewOpen={openTrend} trendPanel="abilities" className="ability-panel"
          picked={(n) => picks.ability === n}
          onPick={(n) => setPicks((prev) => ({ ...prev, ability: toggleOne(prev.ability, n) }))} />
      </div>
      <section className="panel">
        <h2>{t("detail.moves")}</h2>
        <div className="rows">
          {detail.panels.moves.map((m) => (
            <PickRow key={`${m.rank}-${m.name}`} style={pctBg(m.percentage)}
                     on={picks.moves.includes(m.name)}
                     disabled={picks.moves.length >= PICK_LIMITS.moves}
                     onToggle={() => setPicks((prev) => ({
                       ...prev, moves: toggleMany(prev.moves, m.name, PICK_LIMITS.moves) }))}>
              <span className="p-rank num">{m.rank}</span>
              <span className="p-name">
                <EntityHover kind="move" name={m.name} link={false} passive onPreviewOpen={openTrend}
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
            </PickRow>
          ))}
        </div>
      </section>
      <SimplePanel titleKey="detail.items" rows={detail.panels.items} kind="item"
        trend={trend} onPreviewOpen={openTrend} trendPanel="items"
        picked={(n) => picks.item === n}
        onPick={(n) => setPicks((prev) => ({ ...prev, item: toggleOne(prev.item, n) }))} />
      <SimplePanel titleKey="detail.natures" rows={detail.panels.natures} suffix={natureMod}
        kind="nature" trend={trend} onPreviewOpen={openTrend} trendPanel="natures"
        picked={(n) => picks.nature === n} onPick={pickNature} />
      {/* SP 分布 before 常见队友 (positions swapped per review) */}
      <section className="panel">
        <h2>{t("detail.spreads")}</h2>
        <div className="rows">
          {detail.panels.spreads.map((s) => (
            <PickRow key={s.rank} style={pctBg(s.percentage)}
                     on={!!picks.spread && spreadKey(picks.spread) === spreadKey(s.spread)}
                     onToggle={() => pickSpread(s.spread)}>
              <span className="p-rank num">{s.rank}</span>
              <span className="p-name mono" style={{ fontSize: 12.5 }}>
                <EntityHover kind="spread" name={spreadKey(s.spread)} link={false} passive
                  onPreviewOpen={openTrend}
                  previewAddon={<TrendPreview trend={trend} panel="spreads" spread={s.spread} />}>
                  <span className="p-inner">
                    {Object.entries(s.spread).map(([k, v]) =>
                      `${k.toUpperCase()} ${v}`).join(" / ") || "—"}
                  </span>
                </EntityHover>
              </span>
              <span className="p-pct num">{s.percentage != null ? `${s.percentage.toFixed(1)}%` : "—"}</span>
            </PickRow>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>
          {t("detail.partners")}
          <span className="panel-note">{t("detail.partnerUsage")}</span>
        </h2>
        <div className="rows">
          {detail.panels.partners.map((p) => {
            // Partners carry no usage percentage upstream — the column was empty. Its own ranking
            // position is the fact that belongs there: a #1 teammate and a #26 one mean different
            // things at the same co-occurrence rank.
            const rank = usageRank.get(p.name);
            const pslug = p.slug ?? "";
            const on = !!pslug && picks.partners.includes(pslug);
            return (
              <PickRow key={`${p.rank}-${p.name}`} on={on}
                       disabled={!pslug || picks.partners.length >= PICK_LIMITS.partners}
                       onToggle={() => pslug && setPicks((prev) => ({
                         ...prev,
                         partners: toggleMany(prev.partners, pslug, PICK_LIMITS.partners) }))}>
                <span className="p-rank num">{p.rank}</span>
                <span className="p-name">
                  <EntityHover kind="pokemon" name={p.name} link={false} passive onPreviewOpen={openTrend}
                    previewAddon={<TrendPreview trend={trend} panel="partners"
                                                nationalDex={p.nationalDex} />}>
                    <span className="p-inner">
                      {p.slug && <GameImage assetKey={`pokemon:${p.slug}`} role="dense"
                        alt={displayName(p, lang)} className="mini" />}
                      {displayName(p, lang)}
                    </span>
                  </EntityHover>
                </span>
                <span className={`p-pct num usage-rank${rank != null && rank > 60 ? " rare" : ""}`}
                      title={t("ko.usageRank")}>
                  {rank != null ? `#${rank}` : "—"}
                </span>
              </PickRow>
            );
          })}
        </div>
      </section>
    </>
  );
}

export function MetaPage() {
  const { slug = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const format = (params.get("format") === "double" ? "double" : "single") as FormatId;
  const setFormat = (next: FormatId) => {
    const updated = new URLSearchParams(params);
    updated.set("format", next);
    setParams(updated, { replace: true });
  };
  const card = usePokemonCard(slug);
  const detail = useDetail(format, slug);
  const ko = useKo(format, slug);
  // The KO axis keeps its own history document (its own capture clock), and like the usage trend it
  // is fetched only once a reader actually opens one of those previews.
  const [koTrendWanted, setKoTrendWanted] = useState(false);
  const koTrend = useKoTrend(format, slug, koTrendWanted);
  const singleRanking = useRanking("single");
  const doubleRanking = useRanking("double");
  const rails = useMetaRails();
  const [allowed, setAllowed] = useState<Set<string> | null>(null);
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

  // English canonical -> usage rank for the ACTIVE format, so the partner column can show where
  // each teammate sits in the same ranking this page is about.
  const activeRanking = format === "single" ? singleRanking : doubleRanking;
  const usageRank = new Map(
    activeRanking.status === "ready"
      ? activeRanking.data.rows.map((r) => [r.name, r.rank] as const)
      : []);

  const navigate = useNavigate();
  const [picks, setPicks] = useState<MetaPicks>(NO_PICKS);
  // A different Pokemon or format is a different question; keeping ticks across it would carry an
  // ability that the new panels may not even list.
  useEffect(() => { setPicks(NO_PICKS); }, [slug, format]);

  const natureStat = (name: string | null, dir: "up" | "down"): StatKey | null => {
    if (!name || natures.status !== "ready") return null;
    const n = natures.data.find((x) => x.name === name);
    return (dir === "up" ? n?.upStat : n?.downStat) ?? null;
  };

  // Nature name -> "+Up/−Down" modifier (the meta natures panel ships names only).
  const natureMod = (name: string): string | null => {
    if (natures.status !== "ready") return null;
    const n = natures.data.find((x) => x.name === name);
    return n?.upStat && n?.downStat
      ? `+${n.upStat.toUpperCase()}/−${n.downStat.toUpperCase()}` : null;
  };

  /** Everything ticked on this page, as the calculator's two rosters.
   *
   * This Pokemon leads the attacking side carrying only what was actually picked — `pinned`, so the
   * calculator leaves the untouched fields blank instead of filling them from usage. An unpicked
   * category is therefore a visible gap, which is the honest reading of "nothing was chosen here". */
  const sendToCalc = () => {
    const self: CalcMember = {
      slug,
      ...(picks.ability ? { ability: picks.ability } : {}),
      ...(picks.item ? { item: picks.item } : {}),
      ...(picks.nature ? { nature: picks.nature } : {}),
      ...(picks.spread ? { sps: picks.spread as Record<string, number> } : {}),
      ...(picks.moves.length ? { moves: picks.moves } : {}),
      pinned: true,
    };
    stashCalcTeams({
      format,
      attackers: [self, ...picks.partners.map((s2) => ({ slug: s2 }))],
      defenders: picks.ko.map((s2) => ({ slug: s2 })),
    });
    navigate("/calc?tab=damage");
  };

  // The rail renders on EVERY branch, including the loading flash between two Pokemon. Putting it
  // only in the ready branch unmounted it on each navigation, which silently threw away the active
  // filter and the search text — the one piece of state a browsing rail must survive with.
  const rail = (
    <>
      <RailHandle state={rails} label={t("rail.search")} />
      <MetaRail state={rails} format={format} ranking={activeRanking} activeSlug={slug}
        onAllowed={setAllowed} />
    </>
  );
  if (card.status === "loading") {
    return <>{rail}<div className="spinner">{t("state.loading")}</div></>;
  }
  if (card.status === "error") {
    return <>{rail}<div className="notice">{t("state.errorDetail")}</div></>;
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
      {rail}
      {/* One Pokemon, one colour. The hero already paints itself in the primary type, and the page
          below it is about that same Pokemon — so the type drives the accent everywhere (usage
          bars, picks, stat bars) instead of the site's neutral brand blue. `display: contents`
          means the wrapper carries the variable without adding a box to the layout; the rail stays
          outside it, because a browsing rail belongs to the site, not to this Pokemon. */}
      <div className="mon-theme" style={{ ["--accent" as string]: typeColor(mon.types[0] ?? "") }}>
        <MonHero mon={mon} ranks={ranks} activeFormat={format} forms={forms}
          onRank={setFormat}
          action={
            <button type="button" className="hero-action" title={t("detail.sendCalcHint")}
              onClick={sendToCalc}>{t("detail.sendCalc")}</button>
          } />
        {/* The usage grid gets the same kind of head the KO block below it has: it is a section of the
            page, and the line that says how to work it belongs with that title rather than floating. */}
        <div className="meta-head">
          <h2>{t("detail.usageSection")}</h2>
          <span className="meta-head-hint">{t("detail.pickHint")}</span>
        </div>
        <div className="detail-grid">
          {detail.status === "ready" && (
            <MetaPanels key={`${format}:${slug}`} detail={detail.data} natureMod={natureMod}
              natureStat={natureStat} usageRank={usageRank} stats={mon.stats}
              picks={picks} setPicks={setPicks} />
          )}
        </div>
        {/* The KO axis is its own upstream on its own snapshot clock, so it sits BELOW the usage
            grid with its own stamp rather than joining it as another panel. */}
        <KoBlock key={`ko:${format}:${slug}`} ko={ko} trend={koTrend} format={format}
                 onPreviewOpen={() => setKoTrendWanted(true)}
                 picked={(s2) => picks.ko.includes(s2)}
                 pickFull={picks.ko.length >= PICK_LIMITS.ko}
                 onPick={(s2) => setPicks((prev) => ({
                   ...prev, ko: toggleMany(prev.ko, s2, PICK_LIMITS.ko) }))} />
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
