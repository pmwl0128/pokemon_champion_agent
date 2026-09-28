/** Keep a team some page has on screen (the calculator's, a builder result, a diagnosed team): name
 * it, pick its team slot, see which of its Pokémon the boxes already hold — then save. The same
 * checks as a paste: a taken slot is replaced only knowingly, and a team the boxes have no room
 * for is not saved. */
import type { TeamDoc } from "@pokemon-champions/protocol";
import { toTeamDoc } from "../../lib/teamDoc.ts";
import { useState } from "react";
import { GameImage } from "../GameImage.tsx";
import { Modal } from "../Modal.tsx";
import { useToast } from "../Toast.tsx";
import { useDexByName } from "../../hooks.ts";
import { useLang } from "../../i18n.ts";
import { useLibrarySnapshot } from "../../lib/library/hooks.ts";
import type { LibraryOrigin } from "../../lib/library/records.ts";
import {
  boxById, freeTeamSlots, planTeamSave, saveTeam, teamDocOf, undoSaveTeam, type LibraryState,
} from "../../lib/library/repo.ts";
import { localName, useNameMaps } from "../../lib/names.ts";
import { fill, useLibraryT } from "./messages.ts";
import { speciesLabel, speciesSlug, useTeamLabel } from "./shared.tsx";
import { TeamSlotPicker } from "./TeamSlotPicker.tsx";

export function SaveTeamDialog({ state, doc, origin, onSaved, onClose }: {
  state: LibraryState;
  doc: TeamDoc;
  origin: LibraryOrigin;
  /** The new team's id, once saved. */
  onSaved?: (id: string) => void;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const { lang } = useLang();
  const toast = useToast();
  const dex = useDexByName();
  const names = useNameMaps();
  const snapshot = useLibrarySnapshot();
  const teamLabel = useTeamLabel(dex, lang);
  const [name, setName] = useState("");
  const [slot, setSlot] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  doc = toTeamDoc(doc, doc.format, state.vocabulary) ?? doc;

  const plan = planTeamSave(state, doc);
  const target = slot ?? freeTeamSlots(state, doc.format)[0] ?? 0;
  const occupant = state.teams.find((team) => team.format === doc.format && team.slot === target) ?? null;
  const noRoom = plan.needed > plan.free;

  const save = async () => {
    setBusy(true);
    try {
      const result = await saveTeam(doc, { origin, snapshot, name }, { slot: target, allowDuplicate: true });
      if (result.status !== "saved") {
        toast({ text: result.status === "no-room"
          ? fill(t("lib.paste.noRoom"), { n: result.needed, free: result.free }) : t("lib.toast.failed") });
        setBusy(false);
        return;
      }
      toast({
        text: fill(t(result.replaced ? "lib.toast.replaced" : "lib.toast.saved"), { n: target + 1 }),
        action: { label: t("lib.toast.undo"), run: () => void undoSaveTeam(result) },
      });
      onSaved?.(result.record.id);
      onClose();
    } catch {
      toast({ text: t("lib.toast.failed") });
      setBusy(false);
    }
  };

  return (
    <Modal title={t("dock.saveTeam")} onClose={onClose} width={640} className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className={occupant ? "primary-btn lib-danger" : "primary-btn"}
                     disabled={busy || noRoom} onClick={() => void save()}>
               {fill(t(occupant ? "lib.paste.replace" : "lib.paste.saveTo"), { n: target + 1 })}
             </button>
           </>}>
      <div className="lib-reading">
        <ul className="lib-preview">
          {doc.pokemon.map((member, index) => (
            <li key={`${member.species}-${index}`}>
              <GameImage assetKey={`pokemon:${speciesSlug(member.species, dex)}`} role="dense" alt="" />
              <span className="lib-preview-name">
                <span>{speciesLabel(member.species, dex, lang)}</span>
                {plan.reuse[index] && <span className="lib-reuse">{t("lib.paste.reuse")}</span>}
              </span>
              <span className="lib-preview-sub muted">
                {member.item ? localName(names.item, member.item, lang) : "—"}
              </span>
            </li>
          ))}
        </ul>
        <div className="lib-form">
          <label>
            <span>{t("lib.field.name")} · {t(`format.${doc.format}`)}</span>
            <input value={name} maxLength={80} placeholder={t("lib.field.namePlaceholder")}
                   onChange={(event) => setName(event.target.value)} />
          </label>
        </div>
        <TeamSlotPicker state={state} format={doc.format} value={target} onChange={setSlot}
                        label={t("lib.paste.target")} />
        {occupant && (
          <p className="notice lib-warn">
            {fill(t("lib.paste.slotTaken"), {
              n: target + 1, name: teamLabel(occupant.name, teamDocOf(occupant, boxById(state))).text,
            })}
          </p>
        )}
        {plan.duplicate && (
          <p className="notice">
            {fill(t("lib.paste.duplicate"), { format: t(`format.${doc.format}`), n: plan.duplicate.slot + 1 })}
          </p>
        )}
        <p className={`notice${noRoom ? " lib-warn" : ""}`}>
          {fill(t(noRoom ? "lib.paste.noRoom" : "lib.paste.cells"), { n: plan.needed, free: plan.free })}
        </p>
      </div>
    </Modal>
  );
}
