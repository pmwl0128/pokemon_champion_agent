/** The reader's saved teams of one format as a pick list: a page that works on one whole team (the
 * actual-sets matchup) takes one straight from the library without opening the dock. Loaded only when
 * the list opens, so the page itself never pays for the library store. */
import type { FormatId, TeamDoc } from "@pokemon-champions/protocol";
import { Link } from "react-router-dom";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { useLibrary } from "../../lib/library/hooks.ts";
import { boxById, teamDocOf } from "../../lib/library/repo.ts";
import { fill, useLibraryT } from "./messages.ts";
import { SpriteRow, useTeamLabel } from "./shared.tsx";

export default function TeamImportList({ format, onPick }: {
  format: FormatId;
  onPick: (doc: TeamDoc) => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const dex = useDexByName();
  const teamLabel = useTeamLabel(dex, lang);
  const state = useLibrary();
  if (state === undefined) return <p className="team-import-note muted">{t("lib.loading")}</p>;
  if (state === "unavailable") return <p className="team-import-note muted">{t("lib.unavailable")}</p>;
  const byId = boxById(state);
  const teams = state.teams
    .filter((team) => team.format === format)
    .sort((a, b) => a.slot - b.slot)
    .flatMap((team) => {
      const doc = teamDocOf(team, byId);
      return doc ? [{ team, doc }] : [];
    });
  if (!teams.length) {
    return (
      <p className="team-import-note muted">
        {fill(t("lib.import.none"), { format: t(`format.${format}`) })}
        {" "}<Link to="/teams">{t("dock.openPage")} →</Link>
      </p>
    );
  }
  return (
    <>
      {teams.map(({ team, doc }) => {
        const label = teamLabel(team.name, doc);
        return (
          <button key={team.id} type="button" role="menuitem" className="team-import-row" onClick={() => onPick(doc)}>
            <span className="team-import-no num">{team.slot + 1}</span>
            <span className="team-import-main">
              <span className={`team-import-name${label.auto ? " auto" : ""}`}>{label.text}</span>
              <SpriteRow species={doc.pokemon.map((mon) => mon.species)} dex={dex} lang={lang}
                         className="team-import-sprites" />
            </span>
          </button>
        );
      })}
    </>
  );
}
