/** Put one box Pokémon into a team: a format's team slots, each saying whether it can take it — a
 * team with room, a team that is full or already has it, or an empty slot where a new team starts
 * with this Pokémon. */
import type { FormatId } from "@pokemon-champions/protocol";
import { useState } from "react";
import { Modal } from "../Modal.tsx";
import { SegmentedControl } from "../SegmentedControl.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { useLibrarySnapshot } from "../../lib/library/hooks.ts";
import { TEAM_SIZE, type BoxRecord } from "../../lib/library/records.ts";
import { addToTeam, boxById, startTeam, teamDocOf, type LibraryState } from "../../lib/library/repo.ts";
import { fill, useLibraryT } from "./messages.ts";
import { SpriteRow, speciesLabel, useTeamLabel } from "./shared.tsx";

export function JoinTeamDialog({ state, record, onClose }: {
  state: LibraryState;
  record: BoxRecord;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const dex = useDexByName();
  const snapshot = useLibrarySnapshot();
  const teamLabel = useTeamLabel(dex, lang);
  // The second box is the doubles one by default, so a Pokémon there most likely joins doubles.
  const [format, setFormat] = useState<FormatId>(record.box === 1 ? "double" : "single");
  const box = boxById(state);
  const name = record.nickname || speciesLabel(record.member.species, dex, lang);
  const formatName = t(`format.${format}`);

  const choose = async (slot: number) => {
    const team = state.teams.find((item) => item.format === format && item.slot === slot);
    if (team) {
      const result = await addToTeam(team.id, record.id);
      toast({ text: result.ok ? fill(t("lib.toast.joined"), { format: formatName, n: slot + 1 })
        : t(result.reason === "full" ? "lib.toast.teamFull" : "lib.toast.alreadyIn") });
    } else {
      const started = await startTeam(format, slot, record.id, { origin: "manual", snapshot });
      if (started) toast({ text: fill(t("lib.toast.started"), { format: formatName, n: slot + 1 }) });
    }
    onClose();
  };

  return (
    <Modal title={fill(t("lib.join.title"), { name })} onClose={onClose} width={520} className="lib-dialog">
      <SegmentedControl kind="radio" value={format} onChange={setFormat} className="seg lib-join-format"
        ariaLabel={t("lib.formatPick")}
        items={(["single", "double"] as const).map((id) => ({ id, label: t(`format.${id}`) }))} />
      <ol className="lib-join-list">
        {Array.from({ length: state.layout.teamSlots[format] }, (_, slot) => {
          const team = state.teams.find((item) => item.format === format && item.slot === slot) ?? null;
          const doc = team ? teamDocOf(team, box) : null;
          const present = team?.members.includes(record.id) ?? false;
          const full = (team?.members.length ?? 0) >= TEAM_SIZE;
          const reason = present ? t("lib.join.present") : full ? t("lib.join.full") : null;
          return (
            <li key={slot}>
              <button type="button" className={`lib-join-row${team ? "" : " free"}`} disabled={reason !== null}
                      onClick={() => void choose(slot)}>
                <span className="lib-slot-no num">{slot + 1}</span>
                {team ? (
                  <>
                    <SpriteRow species={doc?.pokemon.map((member) => member.species) ?? []} dex={dex} lang={lang}
                               className="lib-sprites mini" />
                    <span className="lib-join-name">{teamLabel(team.name, doc).text}</span>
                  </>
                ) : (
                  <span className="lib-join-name muted">{t("lib.join.new")}</span>
                )}
                {reason && <span className="lib-join-reason muted">{reason}</span>}
              </button>
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}
