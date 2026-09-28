/** One real build on a single line under the hero: item, ability, nature, four moves, SP.
 *
 * The first build shown is the modal one. When the species has several real builds the reader
 * steps through them by hand — never on a timer: an auto-advancing strip is continuous motion on a
 * data page (design §2.2), and it would decide on its own which build a screenshot catches.
 *
 * No share is printed. The catalog's coverage belongs to the item + ability cluster, not to this
 * exact set, and on a screenshot "95%" would read as "95% of players run these four moves". */
import { STAT_KEYS } from "@pokemon-champions/protocol";
import { setMember } from "../../components/BuildPicker.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { KeepMonButton } from "../../components/KeepMonButton.tsx";
import { TypeBadge } from "../../components/TypeBadge.tsx";
import { useDexByName, useItemsByName, useMovesByName, useNatures } from "../../hooks.ts";
import { displayName, useLang, useT } from "../../i18n.ts";
import { localName, useNameMaps } from "../../lib/names.ts";
import type { RealSet } from "../../lib/realSets.ts";

export function SetStrip({ sets, index, onIndex }: {
  sets: RealSet[];
  index: number;
  /** Absent in the share image: the capture shows whichever build is on screen, without controls. */
  onIndex?: (index: number) => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const maps = useNameMaps();
  const moves = useMovesByName();
  const items = useItemsByName();
  const dex = useDexByName();
  const natures = useNatures();
  const current = sets[index] ?? sets[0];
  if (!current) return null;
  const { set } = current;
  const position = sets.indexOf(current);
  const nature = natures.status === "ready" && set.nature
    ? natures.data.find((n) => n.name === set.nature) : undefined;
  const item = set.item ? items.get(set.item) : undefined;
  const runForm = set.runForm && set.runForm !== set.species ? dex.get(set.runForm) : undefined;
  const step = (delta: number) => onIndex?.((position + delta + sets.length) % sets.length);

  return (
    <div className="mc-set">
      <span className="mc-set-tag">
        {current.isModal ? t("mc.set.modal") : t("mc.set.nth").replace("{n}", String(position + 1))}
      </span>
      <span className="mc-set-body">
        {set.item && (
          <span className="mc-set-item">
            {item && <GameImage assetKey={item.key} role="dense" alt="" />}
            <b>{localName(maps.item, set.item, lang)}</b>
          </span>
        )}
        {set.ability && (
          <span title={set.baseAbility && set.baseAbility !== set.ability
            ? `${t("matchup.variantBaseAbilityLabel")} ${localName(maps.ability, set.baseAbility, lang)}`
            : undefined}>
            {localName(maps.ability, set.ability, lang)}
          </span>
        )}
        {set.nature && (
          <span>
            {localName(maps.nature, set.nature, lang)}
            {nature?.upStat && nature.downStat && (
              <small> +{t(`stat.${nature.upStat}`)} −{t(`stat.${nature.downStat}`)}</small>
            )}
            {/* Keep this build in a box — on the live page only, not in the share image. */}
            {onIndex && <KeepMonButton member={() => setMember(set)} origin="meta" />}
          </span>
        )}
        {!set.nature && onIndex && <KeepMonButton member={() => setMember(set)} origin="meta" />}
        <span className="mc-set-moves">
          {(set.moves ?? []).map((name) => {
            const move = moves.get(name);
            return (
              <span className="mc-set-move" key={name}>
                {move && <TypeBadge type={move.type} iconOnly />}
                {move ? displayName(move, lang) : name}
              </span>
            );
          })}
        </span>
        {set.sps && (
          <span className="mc-set-sp">
            {STAT_KEYS.filter((key) => set.sps?.[key]).map((key) => (
              <span key={key}>{t(`stat.${key}`)}<b>{set.sps?.[key]}</b></span>
            ))}
          </span>
        )}
      </span>
      {runForm && (
        <span className="mc-set-note">
          {t("mc.set.runForm").replace("{form}", displayName(runForm, lang))}
        </span>
      )}
      {onIndex && sets.length > 1 && (
        <span className="mc-set-pager">
          <button type="button" aria-label={t("mc.set.prev")} onClick={() => step(-1)}>‹</button>
          <span className="mc-set-count">{position + 1} / {sets.length}</span>
          <button type="button" aria-label={t("mc.set.next")} onClick={() => step(1)}>›</button>
        </span>
      )}
    </div>
  );
}
