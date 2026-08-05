/** The detail-page hero, shared by the dex-detail and meta-detail pages. Sprite + trilingual
 * names + types + abilities, plus the single/double rank chips. The chips are polymorphic: on the
 * dex page they LINK to the meta page (no active state); on the meta page they SWITCH the panels'
 * format (the active one highlighted). `cross` is the link to the sibling detail view. */
import type { FormatId, PokemonCardDto } from "@pokemon-champions/protocol";
import { Link } from "react-router-dom";
import { typeColor } from "../assets/icons.ts";
import { GameImage } from "./GameImage.tsx";
import { TypeBadge } from "./TypeBadge.tsx";
import { EntityHover } from "./EntityHover.tsx";
import { displayName, secondaryName, useLang, useT } from "../i18n.ts";

export interface HeroForm {
  key: string;
  label: string;
  active: boolean;
  onSelect: () => void;
}

export function MonHero({ mon, ranks, activeFormat, onRank, cross, forms }: {
  mon: PokemonCardDto;
  ranks: Array<[FormatId, number | null]>;
  activeFormat?: FormatId;                 // highlight the active chip (meta page); omit on dex page
  onRank: (f: FormatId) => void;
  cross?: { to: string; label: string };   // link to the sibling detail view
  /** Base/Mega display toggle (meta page): the NAME LINE lists every form, the active one
   * highlighted; clicking switches which form's identity the hero + stats show. */
  forms?: HeroForm[];
}) {
  const { lang } = useLang();
  const t = useT();
  const primary = typeColor(mon.types[0] ?? "Typeless");
  return (
    <header className="mon-hero" style={{
      background: `linear-gradient(120deg, ${primary} 0%, color-mix(in srgb, ${primary} 62%, #10161d) 100%)`,
    }}>
      <GameImage assetKey={mon.key} role="card" alt={displayName(mon, lang)} className="sprite" />
      <div className="names">
        <h1>
          {forms && forms.length > 1
            ? forms.map((f, i) => (
                <span key={f.key}>
                  {i > 0 && <span className="form-sep"> / </span>}
                  <button type="button" className={`form-name${f.active ? " on" : ""}`}
                          onClick={f.onSelect}>{f.label}</button>
                </span>
              ))
            : displayName(mon, lang)}
        </h1>
        <span className="alt">
          {secondaryName(mon, lang) ?? ""} · <span className="num">#{mon.nationalDex}</span>
        </span>
        <div className="types">
          {mon.types.map((tp) => <TypeBadge key={tp} type={tp} />)}
        </div>
        <div className="abilities">
          {mon.abilities.map((a) => (
            <EntityHover kind="ability" name={a.name} key={a.name}>
              <span className="ability-chip" title={a.name}>{displayName(a, lang)}</span>
            </EntityHover>
          ))}
        </div>
        {cross && <Link className="cross-link" to={cross.to}>{cross.label} →</Link>}
      </div>
      <div className="rank-chip">
        {ranks.map(([f, rank]) => (
          <button key={f} className={activeFormat === f ? "on" : ""} onClick={() => onRank(f)}>
            <b className="num">{rank != null ? `#${rank}` : "—"}</b>
            {t(`format.${f}`)}
          </button>
        ))}
      </div>
    </header>
  );
}
