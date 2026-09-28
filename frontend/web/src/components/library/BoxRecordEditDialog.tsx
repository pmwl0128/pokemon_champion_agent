/** One box Pokémon's build in a dialog — the library dock's edit and a team card's ✎ on the teams
 * page. It includes species, forme and the environment build picker. */
import type { TeamMemberDoc } from "@pokemon-champions/protocol";
import { useState } from "react";
import { Modal } from "../Modal.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import type { BoxRecord } from "../../lib/library/records.ts";
import { updateBoxRecord } from "../../lib/library/repo.ts";
import { fill, useLibraryT } from "./messages.ts";
import { MonBuildEditor } from "./MonBuildEditor.tsx";
import { speciesLabel } from "./shared.tsx";

export function BoxRecordEditDialog({ record, onClose }: {
  record: BoxRecord;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const dex = useDexByName();
  const [draft, setDraft] = useState<TeamMemberDoc>(record.member);
  const [busy, setBusy] = useState(false);
  const name = record.nickname || speciesLabel(record.member.species, dex, lang);

  const save = async () => {
    setBusy(true);
    try {
      await updateBoxRecord(record.id, { member: draft });
      toast({ text: fill(t("lib.toast.buildSaved"), { name }) });
      onClose();
    } catch {
      toast({ text: t("lib.toast.failed") });
      setBusy(false);
    }
  };

  return (
    <Modal title={fill(t("lib.edit.build"), { name })} onClose={onClose} width={720}
           className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className="primary-btn" disabled={busy} onClick={() => void save()}>{t("lib.save")}</button>
           </>}>
      <MonBuildEditor value={draft} onChange={setDraft} />
    </Modal>
  );
}
