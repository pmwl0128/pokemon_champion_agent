/** The small "+" beside a build that keeps that one Pokémon in the reader's current box (the next
 * free cell after it when the box is full) — on every card that shows a build and stays on screen.
 * It takes the build as it is shown; nothing is asked. */
import type { TeamMemberDoc } from "@pokemon-champions/protocol";
import { IconPlus } from "@tabler/icons-react";
import { useState, type MouseEvent } from "react";
import { useDexByName } from "../hooks.ts";
import { displayName, useLang, useT } from "../i18n.ts";
import type { LibraryOrigin } from "../lib/library/records.ts";
import { useLibraryWorkspace } from "../lib/library/workspace.tsx";
import { toTeamMember } from "../lib/teamDoc.ts";

export function KeepMonButton({ member, name, origin, className = "" }: {
  /** The build, team-json shaped; read when pressed. */
  member: unknown | (() => unknown);
  /** How the toast names it; the species in the reader's language when left out. */
  name?: string;
  origin: LibraryOrigin;
  className?: string;
}) {
  const t = useT();
  const { lang } = useLang();
  const dex = useDexByName();
  const { keepMon } = useLibraryWorkspace("keepMon");
  const [busy, setBusy] = useState(false);
  const keep = async (event: MouseEvent) => {
    // Cards are often links or toggles themselves; the "+" is its own action.
    event.preventDefault();
    event.stopPropagation();
    const doc: TeamMemberDoc | null = toTeamMember(typeof member === "function" ? (member as () => unknown)() : member);
    if (!doc || busy) return;
    setBusy(true);
    const entry = dex.get(doc.species);
    await keepMon(doc, origin, name ?? (entry ? displayName(entry, lang) : doc.species));
    setBusy(false);
  };
  const label = name ? `${t("library.keep")}: ${name}` : t("library.keep");
  return (
    <button type="button" className={`keep-mon${className ? ` ${className}` : ""}`} title={t("library.keep")}
            aria-label={label} disabled={busy} onClick={(event) => void keep(event)}>
      <IconPlus aria-hidden />
    </button>
  );
}
