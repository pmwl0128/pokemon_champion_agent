/** One Pokemon in a portrait grid — a teammate, or a KO opponent. Both panels publish an ORDER and
 * no share, so the tile carries the order in its corner and, under the name, where that Pokemon
 * sits in this format's usage ranking: a #1 teammate and a #26 one mean different things at the
 * same co-occurrence position.
 *
 * The whole tile is one link to that Pokemon's metagame page in the same format: the reader is
 * comparing metagame facts, so the next page they want is the same kind of page. */
import type { FormatId } from "@pokemon-champions/protocol";
import type { ReactNode } from "react";
import { EntityHover } from "../../components/EntityHover.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { displayName, useLang, useT } from "../../i18n.ts";

/** Past this usage rank a Pokemon is a rare pick, so its position here is a signal rather than
 * exposure — worth marking, because that distinction is why the usage rank is shown at all. */
export const RARE_USAGE_RANK = 60;

export interface TileEntry {
  rank: number;
  name: string;
  nameZh?: string;
  nameJa?: string;
  slug?: string;
  /** Asset-pack key when the DTO carries one; otherwise derived from the slug. */
  key?: string;
  usageRank: number | null;
  /** Same species twice in one list: the source drops the form (KO lists only). */
  formCollapsed?: boolean;
}

export function MonTile({ entry, format, addon, onPreviewOpen }: {
  entry: TileEntry;
  format: FormatId;
  addon: ReactNode;
  onPreviewOpen?: () => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const label = displayName(entry, lang);
  const rare = entry.usageRank != null && entry.usageRank > RARE_USAGE_RANK;
  const assetKey = entry.key ?? (entry.slug ? `pokemon:${entry.slug}` : "pokemon:");
  return (
    <EntityHover kind="pokemon" name={entry.name} link={Boolean(entry.slug)}
                 href={entry.slug ? `/meta/${entry.slug}?format=${format}` : undefined}
                 previewAddon={addon} onPreviewOpen={onPreviewOpen}>
      <span className="mc-tile">
        <span className="mc-tile-rank">{entry.rank}</span>
        {entry.formCollapsed && (
          <span className="mc-tile-fc" title={t("ko.formCollapsed")} aria-label={t("ko.formCollapsed")}>形</span>
        )}
        <GameImage assetKey={assetKey} role="dense" alt="" className="mc-tile-img" />
        <span className="mc-tile-name">{label}</span>
        <span className={`mc-tile-use${rare ? " rare" : ""}`} title={t("ko.usageRank")}>
          {entry.usageRank != null ? `#${entry.usageRank}` : "—"}
        </span>
      </span>
    </EntityHover>
  );
}
