/** The party strip — six member cards laid out like the game's own team box. This is the
 * panel's signature presentation: the final team is shown as the PLAYER sees a team
 * (portrait, types, item, moves, SP), never as JSON. Reads a team-json shape leniently;
 * anything missing just doesn't render. Every name localizes: species via the dex index,
 * moves via the member's projection learnset (which also brings the type icon), items /
 * natures / abilities via the vocab maps — the English canonical is always the fallback. */
import { IconDeviceFloppy } from "@tabler/icons-react";
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { EntityHover } from "../EntityHover.tsx";
import { GameImage } from "../GameImage.tsx";
import { TypeBadge } from "../TypeBadge.tsx";
import { useAsync, useDexByName } from "../../hooks.ts";
import { displayName, optionalKey, useLang, useT } from "../../i18n.ts";
import { localName, useNameMaps, type NameMaps } from "../../lib/names.ts";
import { formatTeamPlainText, readTeamMembers, type TeamMemberish } from "../../lib/team.ts";
import { KeepMonButton } from "../KeepMonButton.tsx";
import type { LibraryOrigin } from "../../lib/library/records.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { loadLearnset } from "../../runtime/projection.ts";
import { ExportMenu, type ExtraExport } from "../ExportMenu.tsx";
import { useLibraryDragSource, useLibraryWorkspace } from "../../lib/library/workspace.tsx";
import { toTeamMember } from "../../lib/teamDoc.ts";
import { slugify } from "./MonChip.tsx";

// Re-exported for the panel's other cards (artifacts.tsx) that read team shapes.
export { readTeamMembers, type TeamMemberish };

export { useDexByName };

const REORDER_TYPE = "application/x-pc-party-index";

function MemberCard({ mon, index, dex, names, format, corner, keepOrigin, onReorder }: {
  mon: TeamMemberish; index: number; dex: Map<string, DexIndexEntry>; names: NameMaps;
  format: "single" | "double";
  /** Replaces the corner "+" (keep in a box) — the teams page puts its own action there. */
  corner?: ReactNode;
  keepOrigin: LibraryOrigin;
  /** Drag a card onto another to reorder the party. */
  onReorder?: (from: number, to: number) => void;
}) {
  const { lang } = useLang();
  const t = useT();
  const entry = dex.get(mon.species);
  const slug = entry?.slug ?? slugify(mon.species);
  const name = entry ? displayName(entry, lang) : mon.species;
  const [over, setOver] = useState(false);
  // A member card can be dragged into the library dock's boxes (design §2.4), and on the teams page
  // onto another card of the same party to reorder it.
  const libraryDrag = useLibraryDragSource(() => {
    const member = toTeamMember(mon);
    return member ? { kind: "pokemon", member, name } : null;
  }, () => formatTeamPlainText({ format, pokemon: [mon] }));
  const drag = {
    ...libraryDrag,
    onDragStart: (event: DragEvent) => {
      libraryDrag.onDragStart(event);
      if (onReorder) event.dataTransfer.setData(REORDER_TYPE, String(index));
    },
    ...(onReorder ? {
      onDragOver: (event: DragEvent) => {
        if (!event.dataTransfer.types.includes(REORDER_TYPE)) return;
        event.preventDefault();
        setOver(true);
      },
      onDragLeave: () => setOver(false),
      onDrop: (event: DragEvent) => {
        setOver(false);
        const from = Number(event.dataTransfer.getData(REORDER_TYPE));
        if (!event.dataTransfer.types.includes(REORDER_TYPE) || !Number.isInteger(from)) return;
        event.preventDefault();
        onReorder(from, index);
      },
    } : {}),
  };
  const sp = Object.entries(mon.spread ?? {}).filter(([, v]) => v > 0);
  // The member's learnset localizes its move names and brings each move's type icon.
  const learnset = useAsync(
    () => (mon.moves?.length ? loadLearnset(slug).catch(() => null) : Promise.resolve(null)),
    [slug]);
  const moveMap = new Map(
    learnset.status === "ready" && learnset.data
      ? learnset.data.moves.map((m) => [m.name, m]) : []);
  return (
    <div className={`party-card${over ? " reorder-over" : ""}`} {...drag}>
      <span className="party-corner">
        {corner ?? <KeepMonButton member={mon} origin={keepOrigin} name={name} />}
      </span>
      <div className="party-portrait">
        <GameImage assetKey={`pokemon:${slug}`} role="card" alt={name} className="party-sprite" />
      </div>
      <div className="party-name">
        <EntityHover kind="pokemon" name={mon.species}><span>{name}</span></EntityHover>
      </div>
      {entry && (
        <div className="party-types">
          {entry.types.map((tp) => <TypeBadge key={tp} type={tp} iconOnly />)}
        </div>
      )}
      {mon.item && (
        <div className="party-item">
          <EntityHover kind="item" name={mon.item}>
            <span className="p-inner">
              <GameImage assetKey={`item:${slugify(mon.item)}`} role="dense"
                alt={localName(names.item, mon.item, lang)} className="party-item-img" />
              <span>{localName(names.item, mon.item, lang)}</span>
            </span>
          </EntityHover>
        </div>
      )}
      {(mon.ability || mon.nature) && (
        <div className="party-sub">
          {mon.ability && (
            <EntityHover kind="ability" name={mon.ability}>
              <span>{localName(names.ability, mon.ability, lang)}</span>
            </EntityHover>
          )}
          {mon.ability && mon.nature ? " · " : ""}
          {mon.nature ? localName(names.nature, mon.nature, lang) : ""}
        </div>
      )}
      {mon.moves && mon.moves.length > 0 && (
        <ul className="party-moves">
          {mon.moves.map((mv) => {
            const info = moveMap.get(mv);
            return (
              <li key={mv}>
                <EntityHover kind="move" name={mv}>
                  <span className="p-inner">
                    {info && <TypeBadge type={info.type} iconOnly />}
                    <span>{info ? displayName(info, lang) : mv}</span>
                  </span>
                </EntityHover>
              </li>
            );
          })}
        </ul>
      )}
      {sp.length > 0 && (
        <div className="party-sp num">
          {sp.map(([k, v]) => {
            const key = optionalKey(`stat.${k}`);
            return `${key ? t(key) : k}${v}`;
          }).join(" / ")}
        </div>
      )}
    </div>
  );
}

export type { ExtraExport } from "../ExportMenu.tsx";

/** The row above the party: `badges` (rule check, audit) and the export menu on the left, the
 * page's own next steps (diagnose, calculator, simulation) on the right. The wizard and the
 * diagnose tab both sit a legality badge directly above the party, and one shared row keeps that,
 * the export and the hand-offs from costing a row each. */
export function TeamCard({ team, badges, actions, extraExport, keepOrigin = "manual", saveSource, memberCorner,
  onReorder, addSlot }: {
  team: unknown;
  badges?: ReactNode;
  actions?: ReactNode;
  extraExport?: ExtraExport;
  /** What a member kept from this card (its corner "+") is recorded as coming from. */
  keepOrigin?: LibraryOrigin;
  /** The page's registered team source: a 保存队伍 button before the export opens the dock's save
   * dialog on it. */
  saveSource?: string;
  /** Replaces each member's corner "+" — the teams page's "remove from team". */
  memberCorner?: (index: number) => ReactNode;
  /** Makes the party reorderable by dragging one card onto another. */
  onReorder?: (from: number, to: number) => void;
  /** Empty places after the members, up to six, that add one (the teams page: from the boxes). */
  addSlot?: { label: string; onAdd: () => void };
}) {
  const t = useT();
  const dex = useDexByName();
  const names = useNameMaps();
  const { requestSave } = useLibraryWorkspace("requestSave");
  const members = readTeamMembers(team);
  const shot = useRef<HTMLDivElement>(null);
  const format = (team as { format?: string })?.format === "double" ? "double" : "single";
  if (members.length === 0 && !addSlot) return null;
  const plainText = formatTeamPlainText(team);
  // A full team gets factor-aligned columns (6/3/2 via container query) so six cards never
  // break 5+1; partial teams keep the auto-fill flow. The wrapper is the query container.
  return (
    <div className="party-box" onCopy={(event) => {
      // Ctrl/Cmd+C over a multi-card selection should not carry EntityHover anchors or
      // rich-card markup into chat/docs. Supply one deterministic text/plain payload.
      event.preventDefault();
      event.clipboardData.setData("text/plain", plainText);
    }}>
      <div className="party-copy-row">
        <div className="party-row-lead">
          {badges}
          {saveSource && (
            <button type="button" className="second-btn team-save-btn" onClick={() => requestSave(saveSource)}>
              <IconDeviceFloppy size={16} aria-hidden />{t("team.save")}
            </button>
          )}
          <ExportMenu text={plainText} textHint={t("team.export.textHint")} shot={shot} extra={extraExport}
            fileName={(scale) => `team_${format}_${new Date().toISOString().slice(0, 10)}_${scale}x.png`} />
        </div>
        {actions && <div className="party-row-actions">{actions}</div>}
      </div>
      <div ref={shot} className={`party-strip${members.length === 6 ? " six" : ""}`}>
        {members.map((m, i) => (
          <MemberCard key={`${m.species}-${i}`} mon={m} index={i} dex={dex} names={names}
                      format={format} keepOrigin={keepOrigin} corner={<>
                        {onReorder && <span className="party-corner-actions">
                          <button type="button" className="party-edit" disabled={i === 0}
                            aria-label={t("team.moveEarlier")} title={t("team.moveEarlier")}
                            onClick={() => onReorder(i, i - 1)}>↑</button>
                          <button type="button" className="party-edit" disabled={i === members.length - 1}
                            aria-label={t("team.moveLater")} title={t("team.moveLater")}
                            onClick={() => onReorder(i, i + 1)}>↓</button>
                        </span>}
                        {memberCorner?.(i)}
                      </>} onReorder={onReorder} />
        ))}
        {addSlot && Array.from({ length: Math.max(0, 6 - members.length) }, (_, i) => (
          <button key={`add-${i}`} type="button" className="party-card party-add" onClick={addSlot.onAdd}
                  aria-label={addSlot.label} title={addSlot.label}>
            <span aria-hidden>+</span>
          </button>
        ))}
      </div>
    </div>
  );
}
