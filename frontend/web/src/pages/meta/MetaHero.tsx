/** The head of the metagame usage card: who this is, what it is made of, and where it ranks.
 *
 * Left, the identity — the current format's rank set huge behind the sprite, the names, the types,
 * and at its right edge the format switch (each button carries its own rank). Middle, the base
 * stats: the number a viewer of a shared screenshot wants, with the Lv.50 actual range one hover
 * away. Right, the ability shares, which is the one usage panel short enough to live up here, and
 * under them the snapshot line and the site mark. */
import type { FormatId, PokemonCardDto } from "@pokemon-champions/protocol";
import { STAT_KEYS } from "@pokemon-champions/protocol";
import type { CSSProperties, ReactNode } from "react";
import { Link } from "react-router-dom";
import { typeColor } from "../../assets/icons.ts";
import { EntityHover } from "../../components/EntityHover.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { TypeBadge } from "../../components/TypeBadge.tsx";
import { displayName, secondaryName, useLang, useT } from "../../i18n.ts";
import { actualStat } from "../../lib/stats.ts";

export interface MetaForm {
  key: string;
  label: string;
  assetKey: string;
  active: boolean;
  onSelect: () => void;
}

/** Bars read against this ceiling; the few stats above it simply fill the track. */
const STAT_SCALE = 180;
import { SP_MAX } from "../../lib/battle.ts";

/** Long names step the heading down before they wrap: the name column shares its row with the
 * sprite and the format switch. Width is estimated in em — a CJK glyph is about one, a Latin letter
 * about half — against the column's room at 32 / 25 / 20 px. */
function nameSize(label: string): string {
  const width = [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e7f ? 1 : 0.56), 0);
  return width > 9 ? " small" : width > 7 ? " mid" : "";
}

function BaseStats({ mon }: { mon: PokemonCardDto }) {
  const t = useT();
  const top = Math.max(...STAT_KEYS.map((key) => mon.stats[key]));
  const total = STAT_KEYS.reduce((sum, key) => sum + mon.stats[key], 0);
  return (
    <div className="mc-stats">
      {STAT_KEYS.map((key) => {
        const base = mon.stats[key];
        const min = actualStat(base, key, 0, 1);
        const max = actualStat(base, key, SP_MAX, key === "hp" ? 1 : 1.1);
        return (
          <EntityHover key={key} kind="stat" name={key} link={false}
            previewAddon={
              <span className="mc-stat-pop">
                <b>{t("mc.statRange").replace("{min}", String(min)).replace("{max}", String(max))}</b>
                <span className="muted">{t("detail.statValuesRange")}</span>
              </span>
            }>
            <span className={`mc-stat${base === top ? " top" : ""}`}>
              <span className="mc-stat-k">{t(`stat.${key}`)}</span>
              <span className="mc-stat-v">{base}</span>
              <span className="mc-stat-bar">
                <i style={{ "--w": `${Math.min(100, (base / STAT_SCALE) * 100)}%` } as CSSProperties} />
              </span>
            </span>
          </EntityHover>
        );
      })}
      <span className="mc-stat total">
        <span className="mc-stat-k">{t("mc.baseTotal")}</span>
        <span className="mc-stat-v">{total}</span>
        <span className="mc-stat-note">{t("mc.baseNote")}</span>
      </span>
    </div>
  );
}

export function MetaHero({ mon, forms, rank, ranks, format, onFormat, rankTitle, abilities, sideFoot }: {
  mon: PokemonCardDto;
  forms?: MetaForm[];
  /** This format's rank, painted behind the sprite; null when the Pokemon is not ranked. */
  rank: number | null;
  ranks: Array<[FormatId, number | null]>;
  /** The format on screen; null where the page shows no format (the dex page, whose rank pills go
   * to the metagame page instead). */
  format: FormatId | null;
  /** Absent in the share image, where the switch is a static label. */
  onFormat?: (format: FormatId) => void;
  /** A tooltip per pill, when a pill does more than switch (the dex page's go to the metagame page). */
  rankTitle?: (format: FormatId) => string;
  abilities: ReactNode;
  /** Snapshot line, site mark and the share action, parked under the abilities. */
  sideFoot?: ReactNode;
}) {
  const { lang } = useLang();
  const t = useT();
  const alt = secondaryName(mon, lang);
  return (
    <header className="mc-hero">
      <div className="mc-id">
        {rank != null && <span className="mc-ghost" aria-hidden="true">{rank}</span>}
        <GameImage assetKey={mon.key} role="card" alt={displayName(mon, lang)} className="mc-sprite" />
        <div className="mc-names">
          {forms && forms.length > 1 && (
            <div className="mc-forms">
              {forms.map((f) => (
                <button key={f.key} type="button" className="mc-form" aria-pressed={f.active}
                        title={f.label} onClick={f.onSelect}>
                  <GameImage assetKey={f.assetKey} role="dense" alt="" />
                  <span className="mc-form-label">{f.label}</span>
                </button>
              ))}
            </div>
          )}
          <h1 className={`mc-name${nameSize(displayName(mon, lang))}`}>{displayName(mon, lang)}</h1>
          <div className="mc-alt">
            {alt && <>{alt} · </>}
            <Link to={`/pokemon/${mon.slug}`} className="mc-dexno">No.{mon.nationalDex}</Link>
          </div>
          <div className="mc-types">
            {mon.types.map((tp) => (
              <span key={tp} className="mc-type" style={{ "--tc": typeColor(tp) } as CSSProperties}>
                <TypeBadge type={tp} />
              </span>
            ))}
          </div>
          <div className="mc-seg" role="group" aria-label={t("mc.formatSwitch")}>
            {ranks.map(([f, r]) => {
              const body = (
                <>
                  <i className="mc-seg-dot" aria-hidden="true" />
                  <span className="mc-seg-label">{t(`format.${f}`)}</span>
                  <b>{r != null ? `#${r}` : "—"}</b>
                </>
              );
              return onFormat
                ? <button key={f} type="button" aria-pressed={format ? f === format : undefined}
                          title={rankTitle?.(f)} onClick={() => onFormat(f)}>{body}</button>
                : <span key={f} aria-current={f === format || undefined}>{body}</span>;
            })}
          </div>
        </div>
      </div>
      <BaseStats mon={mon} />
      <div className="mc-side">
        {abilities}
        {sideFoot && <div className="mc-side-foot">{sideFoot}</div>}
      </div>
    </header>
  );
}
