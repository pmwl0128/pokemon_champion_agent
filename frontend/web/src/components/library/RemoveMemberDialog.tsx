import { useDeleteBoxRecord } from "./useDeleteBoxRecord.ts";
/** Taking a Pokémon out of a team asks one question: delete it from its box as well? Yes deletes it
 * (and so takes it out of every team that uses it), No only takes it out of this team, Cancel does
 * nothing. Either way the toast can undo it. */
import { Modal } from "../Modal.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import type { TeamRecord } from "../../lib/library/records.ts";
import {
  boxById, setTeamMembers, type LibraryState,
} from "../../lib/library/repo.ts";
import { fill, useLibraryT } from "./messages.ts";
import { speciesLabel } from "./shared.tsx";

export function RemoveMemberDialog({ state, team, id, onClose }: {
  state: LibraryState;
  team: TeamRecord;
  /** The box id of the Pokémon being taken out. */
  id: string;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const dex = useDexByName();
  const record = boxById(state).get(id);
  const name = record ? record.nickname || speciesLabel(record.member.species, dex, lang) : "";

  const remove = useDeleteBoxRecord();
  const deleteToo = async () => { onClose(); if (record) await remove(record); };

  const teamOnly = async () => {
    onClose();
    const before = team.members;
    await setTeamMembers(team.id, before.filter((member) => member !== id));
    toast({
      text: fill(t("lib.toast.leftTeam"), { name }),
      action: { label: t("lib.toast.undo"), run: () => void setTeamMembers(team.id, before) },
    });
  };

  return (
    <Modal title={fill(t("lib.remove.title"), { name })} onClose={onClose} width={420} className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" data-autofocus onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className="second-btn" onClick={() => void teamOnly()}>{t("lib.remove.no")}</button>
             <button type="button" className="primary-btn lib-danger" onClick={() => void deleteToo()}>
               {t("lib.remove.yes")}
             </button>
           </>}>
      <p className="lib-dialog-hint">{t("lib.remove.ask")}</p>
    </Modal>
  );
}
