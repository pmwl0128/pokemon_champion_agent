/** The usage card: everything on the ranking/details clock for one Pokemon in one format, sized so
 * the whole card fits a 1920×1080 first screen and can be captured as one picture.
 *
 * The page's top bar already names the snapshot, so the card itself carries only the site mark and
 * the share action (at the foot of the ability column); the share image prints the snapshot in its
 * frame. The KO axis runs on a different snapshot clock and is a separate card with its own stamp
 * (frontend/design.md §7.1.1).
 *
 * Colour: the Pokemon's own types are the only hue. The primary type fills the share bars, the
 * leader values and the SP heat cells; both types stripe the top edge. */
import type {
  FormatId, MetaDetailDto, PokemonCardDto, UsageTrendDto,
} from "@pokemon-champions/protocol";
import { useMemo, type CSSProperties } from "react";
import { BRAND_LOGO, typeColor } from "../../assets/icons.ts";
import { GameImage } from "../../components/GameImage.tsx";
import { CategoryBadge, TypeBadge } from "../../components/TypeBadge.tsx";
import { useNatures, type Async } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import type { RealSet } from "../../lib/realSets.ts";
import { usageDelta } from "../../lib/usageDelta.ts";
import { MetaHero, type MetaForm } from "./MetaHero.tsx";
import { MonTile } from "./MonTile.tsx";
import { PanelHead, partnerRanks, TrendAddon, UsageRow, usageSeries } from "./rows.tsx";
import { SetStrip } from "./SetStrip.tsx";
import { SpMatrix } from "./SpMatrix.tsx";

export function accentStyle(mon: PokemonCardDto): CSSProperties {
  const [first, second] = mon.types;
  return {
    "--acc": typeColor(first ?? "Typeless"),
    "--acc2": typeColor(second ?? first ?? "Typeless"),
  } as CSSProperties;
}

/** "2026-09-11" -> "09-11": the window never spans a year boundary worth printing. */
export const shortDate = (period: string) => period.length >= 10 ? period.slice(5) : period;

export interface UsageCardProps {
  /** The form the hero shows (the base species or one of its Megas). */
  mon: PokemonCardDto;
  forms?: MetaForm[];
  format: FormatId;
  ranks: Array<[FormatId, number | null]>;
  onFormat?: (format: FormatId) => void;
  /** Usage panels, always keyed by the base species. */
  detail: Async<MetaDetailDto>;
  trend: Async<UsageTrendDto | null>;
  /** English canonical -> this format's usage rank, for the teammate tiles. */
  usageRank: Map<string, number>;
  sets: RealSet[];
  setIndex: number;
  onSetIndex?: (index: number) => void;
  /** Printed beside the brand in the share image only, where it is the picture's way back to the
   * site. On the page the address bar already names it, and the share button needs the room. */
  host?: string;
  onShare?: () => void;
}

export function UsageCard(props: UsageCardProps) {
  const { mon, forms, format, ranks, onFormat, detail, trend, usageRank, sets, setIndex,
    onSetIndex, host, onShare } = props;
  const { lang } = useLang();
  const t = useT();
  const natureList = useNatures();
  const natures = useMemo(() => new Map(natureList.status === "ready"
    ? natureList.data.map((n) => [n.name, n] as const) : []), [natureList]);
  const ready = detail.status === "ready" ? detail.data : null;
  // A 404 is the factual "not ranked this period"; anything else is a real load failure and must
  // not masquerade as a metagame fact.
  const bodyState = detail.status === "loading" ? t("state.loading")
    : detail.status === "error"
      ? detail.httpStatus === 404 ? t("detail.notRanked") : t("state.errorDetail")
      : null;
  const periods = trend.status === "ready" && trend.data ? trend.data.periods : [];
  const baseline = periods.length > 1 ? shortDate(periods[0]!) : undefined;
  const pctNote = baseline ? t("mc.pctVs").replace("{date}", baseline) : t("mc.pct");
  const natureMod = (name: string) => {
    const n = natures.get(name);
    return n?.upStat && n.downStat
      ? <span className="mc-sub">+{t(`stat.${n.upStat}`)} −{t(`stat.${n.downStat}`)}</span> : null;
  };

  const abilityRows = ready && (
    <div className="mc-abilities">
      <PanelHead title={t("detail.abilities")} note={pctNote} />
      {ready.panels.abilities.map((a, i) => {
        const values = usageSeries(trend, "abilities", a.name);
        return (
          <UsageRow key={`${a.rank}-${a.name}`} rank={a.rank} lead={i === 0} pct={a.percentage}
                    delta={usageDelta(values)} baseline={baseline}
                    hover={{ kind: "ability", name: a.name,
                             addon: <TrendAddon trend={trend} values={values} kind="pct" /> }}>
            {displayName(a, lang)}
          </UsageRow>
        );
      })}
    </div>
  );

  return (
    <section className="mc-card mc-usage" style={accentStyle(mon)}
             aria-label={`${displayName(mon, lang)} · ${t(`format.${format}`)}`}>
      <div className="mc-strip" aria-hidden="true" />
      <MetaHero mon={mon} forms={forms} rank={ready?.rank ?? null} ranks={ranks} format={format}
                onFormat={onFormat} abilities={abilityRows}
                sideFoot={
                  <span className="mc-brand">
                      <img src={BRAND_LOGO} alt="" />
                      <span>Champions{host ? ` · ${host}` : ""}</span>
                      {onShare && (
                        <button type="button" className="mc-share-btn" onClick={onShare}>
                          <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.5v7.5M3.8 6 7 9.2 10.2 6M2 11.5h10" /></svg>
                          {t("mc.share")}
                        </button>
                      )}
                    </span>
                } />
      {sets.length > 0 && <SetStrip sets={sets} index={setIndex} onIndex={onSetIndex} />}
      {ready ? (
        <div className="mc-grid">
          <div className="mc-panel mc-moves">
            <PanelHead title={t("detail.moves")} note={pctNote} />
            {ready.panels.moves.map((m, i) => {
              const values = usageSeries(trend, "moves", m.name);
              return (
                <UsageRow key={`${m.rank}-${m.name}`} rank={m.rank} lead={i === 0} pct={m.percentage}
                          delta={usageDelta(values)} baseline={baseline}
                          sub={m.power != null ? <span className="mc-power">{m.power}</span> : null}
                          hover={{ kind: "move", name: m.name,
                                   addon: <TrendAddon trend={trend} values={values} kind="pct" /> }}>
                  <TypeBadge type={m.type} iconOnly />
                  <CategoryBadge category={m.category} />
                  <span className="mc-text">{displayName(m, lang)}</span>
                </UsageRow>
              );
            })}
          </div>
          <div className="mc-panel mc-items">
            <PanelHead title={t("detail.items")} note={pctNote} />
            {ready.panels.items.map((it, i) => {
              const values = usageSeries(trend, "items", it.name);
              return (
                <UsageRow key={`${it.rank}-${it.name}`} rank={it.rank} lead={i === 0}
                          pct={it.percentage} delta={usageDelta(values)} baseline={baseline}
                          hover={{ kind: "item", name: it.name,
                                   addon: <TrendAddon trend={trend} values={values} kind="pct" /> }}>
                  <GameImage assetKey={it.key} role="dense" alt="" className="mc-item-img" />
                  <span className="mc-text">{displayName(it, lang)}</span>
                </UsageRow>
              );
            })}
          </div>
          <div className="mc-panel mc-natures">
            <PanelHead title={t("detail.natures")} note={pctNote} />
            {ready.panels.natures.map((n, i) => {
              const values = usageSeries(trend, "natures", n.name);
              return (
                <UsageRow key={`${n.rank}-${n.name}`} rank={n.rank} lead={i === 0} pct={n.percentage}
                          delta={usageDelta(values)} baseline={baseline} sub={natureMod(n.name)}
                          hover={{ kind: "nature", name: n.name,
                                   addon: <TrendAddon trend={trend} values={values} kind="pct" /> }}>
                  <span className="mc-text">{displayName(n, lang)}</span>
                </UsageRow>
              );
            })}
          </div>
          <div className="mc-panel mc-spreads">
            <PanelHead title={t("detail.spreads")} note={t("mc.spNote").replace("{n}",
              String(ready.panels.spreads.length)).replace("{sum}", ready.panels.spreads
              .reduce((sum, s) => sum + (s.percentage ?? 0), 0).toFixed(1))} />
            <SpMatrix spreads={ready.panels.spreads} trend={trend} baseline={baseline} />
          </div>
          <div className="mc-panel mc-partners">
            <PanelHead title={t("detail.partners")} note={t("mc.partnersNote")} />
            <div className="mc-tiles">
              {ready.panels.partners.map((p) => (
                <MonTile key={`${p.rank}-${p.name}`} format={format}
                         entry={{ ...p, usageRank: usageRank.get(p.name) ?? null }}
                         addon={<TrendAddon trend={trend} values={partnerRanks(trend, p.nationalDex)}
                                            kind="rank" />} />
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="mc-body-state">{bodyState}</div>
      )}
    </section>
  );
}
