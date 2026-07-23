/** The party strip — six member cards laid out like the game's own team box. This is the
 * panel's signature presentation: the final team is shown as the PLAYER sees a team
 * (portrait, types, item, moves, SP), never as JSON. Reads a team-json shape leniently;
 * anything missing just doesn't render. Every name localizes: species via the dex index,
 * moves via the member's projection learnset (which also brings the type icon), items /
 * natures / abilities via the vocab maps — the English canonical is always the fallback. */
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { EntityHover } from "../../components/EntityHover.tsx";
import { GameImage } from "../../components/GameImage.tsx";
import { TypeBadge } from "../../components/TypeBadge.tsx";
import { useAsync, useDexByName } from "../../hooks.ts";
import { displayName, optionalKey, useLang, useT } from "../../i18n.ts";
import { localName, useNameMaps, type NameMaps } from "../../lib/names.ts";
import {
  formatTeamPlainText, readTeamMembers, stashDamageFill, type TeamMemberish,
} from "../../lib/team.ts";
import type { DexIndexEntry } from "../../runtime/adapter.ts";
import { loadLearnset } from "../../runtime/projection.ts";
import { slugify } from "./MonChip.tsx";

// Re-exported for the panel's other cards (artifacts.tsx) that read team shapes.
export { readTeamMembers, type TeamMemberish };

export { useDexByName };

function MemberCard({ mon, dex, names, format }: {
  mon: TeamMemberish; dex: Map<string, DexIndexEntry>; names: NameMaps;
  format: "single" | "double";
}) {
  const { lang } = useLang();
  const t = useT();
  const navigate = useNavigate();
  const entry = dex.get(mon.species);
  const slug = entry?.slug ?? slugify(mon.species);
  // Corner hand-off: this member's REAL build becomes the calculator's attacker, with its
  // own moveset pre-selected (design §13 calc hand-offs).
  const toCalc = () => {
    stashDamageFill({
      format, attackerSlug: slug,
      attacker: { slug,
                  ...(mon.ability ? { ability: mon.ability } : {}),
                  ...(mon.item ? { item: mon.item } : {}),
                  ...(mon.nature ? { nature: mon.nature } : {}),
                  ...(mon.spread ? { sps: mon.spread } : {}) },
      ...(mon.moves?.length ? { moves: mon.moves } : {}),
    });
    navigate("/calc?tab=damage");
  };
  const name = entry ? displayName(entry, lang) : mon.species;
  const sp = Object.entries(mon.spread ?? {}).filter(([, v]) => v > 0);
  // The member's learnset localizes its move names and brings each move's type icon.
  const learnset = useAsync(
    () => (mon.moves?.length ? loadLearnset(slug).catch(() => null) : Promise.resolve(null)),
    [slug]);
  const moveMap = new Map(
    learnset.status === "ready" && learnset.data
      ? learnset.data.moves.map((m) => [m.name, m]) : []);
  return (
    <div className="party-card">
      <button type="button" className="party-calc num" title={t("team.toCalc")}
              aria-label={t("team.toCalc")}
              onClick={toCalc}>+</button>
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

/** `badges` renders inline at the LEFT of the copy row. The wizard and the diagnose tab both sit a
 * legality badge directly above the party, and keeping it in its own block cost a whole row of
 * vertical space for two short chips; sharing this row puts "rule check passed" and "copy plain
 * text" on one line. */
export function TeamCard({ team, badges }: { team: unknown; badges?: ReactNode }) {
  const dex = useDexByName();
  const names = useNameMaps();
  const t = useT();
  const members = readTeamMembers(team);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const format = (team as { format?: string })?.format === "double" ? "double" : "single";
  if (members.length === 0) return null;
  const plainText = formatTeamPlainText(team);
  const copyPlain = async () => {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopyState("copied");
    } catch {
      // Clipboard API can be blocked by browser policy. The temporary textarea fallback
      // still writes only text/plain and never serializes hover-card links or HTML.
      const area = document.createElement("textarea");
      area.value = plainText;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      setCopyState(copied ? "copied" : "failed");
    }
  };
  // A full team gets factor-aligned columns (6/3/2 via container query) so six cards never
  // break 5+1; partial teams keep the auto-fill flow. The wrapper is the query container.
  return (
    <div className="party-box" onCopy={(event) => {
      // Ctrl/Cmd+C over a multi-card selection should not carry EntityHover anchors or
      // rich-card markup into chat/docs. Supply one deterministic text/plain payload.
      event.preventDefault();
      event.clipboardData.setData("text/plain", plainText);
    }}>
      <div className={`party-copy-row${badges ? " with-badges" : ""}`}>
        {badges}
        <button type="button" className="second-btn" onClick={() => void copyPlain()}>
          {t(copyState === "copied" ? "team.copied" : "team.copyPlain")}
        </button>
        {copyState === "failed" && <span className="muted">{t("team.copyFailed")}</span>}
      </div>
      <div className={`party-strip${members.length === 6 ? " six" : ""}`}>
        {members.map((m, i) => (
          <MemberCard key={`${m.species}-${i}`} mon={m} dex={dex} names={names}
                      format={format} />
        ))}
      </div>
    </div>
  );
}
