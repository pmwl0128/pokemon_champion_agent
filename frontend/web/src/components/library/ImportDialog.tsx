import { useLibraryFailure } from "../../lib/library/errors.ts";
/** A library file into the store (frontend/design.md §2.3): the file is planned first — how many
 * teams and Pokémon, how many of them are already stored, how many entries do not read, how much
 * room there is — and written only when the reader confirms. This file is also the only road
 * between two origins' libraries, so it must never fail as a whole on one bad entry. */
import { useRef, useState } from "react";
import { Modal } from "../Modal.tsx";
import { useToast } from "../Toast.tsx";
import { applyImport, planImport, type ImportPlan, type ParseFailure } from "../../lib/library/exchange.ts";
import { useLibraryLimits } from "../../lib/library/hooks.ts";
import { fill, useLibraryT } from "./messages.ts";

/** A library file is small; anything past this is not one, and reading it would stall the tab. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export function ImportDialog({ onClose }: { onClose: () => void }) {
  const t = useLibraryT();
  const toast = useToast();
  const errorMessage = useLibraryFailure();
  const limits = useLibraryLimits();
  const input = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState("");
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [failure, setFailure] = useState<ParseFailure | null>(null);
  const [keepDuplicates, setKeepDuplicates] = useState(false);
  const [busy, setBusy] = useState(false);

  const choose = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setPlan(null);
    setFailure(null);
    if (file.size > MAX_FILE_BYTES) { setFailure("not-a-library-file"); return; }
    setBusy(true);
    try {
      const result = await planImport(await file.text());
      if (typeof result === "string") setFailure(result);
      else setPlan(result);
    } catch (error) {
      toast({ text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    try {
      const done = await applyImport(plan, { keepDuplicates, limits });
      toast({ text: fill(t(done.noRoom ? "lib.toast.importedNoRoom" : "lib.toast.imported"),
        { teams: done.teams, box: done.box, n: done.noRoom }) });
      onClose();
    } catch (error) {
      toast({ text: errorMessage(error) });
      setBusy(false);
    }
  };

  const dupTeams = plan?.teams.filter((entry) => entry.duplicate).length ?? 0;
  const dupBox = plan?.box.filter((entry) => entry.existing).length ?? 0;
  const importable = plan
    ? plan.teams.length + plan.box.length - (keepDuplicates ? 0 : dupTeams + dupBox) : 0;

  return (
    <Modal title={t("lib.import.title")} onClose={onClose} width={520} className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className="primary-btn" disabled={busy || importable === 0}
                     onClick={() => void apply()}>{t("lib.import.apply")}</button>
           </>}>
      <p className="muted lib-dialog-hint">{t("lib.import.hint")}</p>
      <div className="lib-file-pick">
        <button type="button" className="second-btn" onClick={() => input.current?.click()}>
          {t("lib.import.choose")}
        </button>
        <span className="lib-file-name">{fileName}</span>
        <input ref={input} type="file" accept=".json,application/json" hidden
               onChange={(event) => {
                 void choose(event.target.files?.[0]);
                 event.target.value = "";
               }} />
      </div>
      {failure && (
        <p className="notice lib-warn">
          {t(failure === "not-json" ? "lib.import.notJson" : "lib.import.notLibrary")}
        </p>
      )}
      {plan && (
        <>
          <ul className="lib-plan">
            <li>
              <b className="num">{fill(t("lib.import.teams"), { n: plan.teams.length })}</b>
              {dupTeams > 0 && <span className="muted">{fill(t("lib.import.dup"), { n: dupTeams })}</span>}
            </li>
            <li>
              <b className="num">{fill(t("lib.import.box"), { n: plan.box.length })}</b>
              {dupBox > 0 && <span className="muted">{fill(t("lib.import.dupBox"), { n: dupBox })}</span>}
            </li>
            {plan.invalid > 0 && (
              <li className="lib-plan-bad">{fill(t("lib.import.invalid"), { n: plan.invalid })}</li>
            )}
          </ul>
          <p className="muted lib-dialog-hint">{fill(t("lib.import.room"), plan.room)}</p>
          {dupTeams + dupBox > 0 && (
            <label className="lib-check">
              <input type="checkbox" checked={keepDuplicates}
                     onChange={(event) => setKeepDuplicates(event.target.checked)} />
              {t("lib.import.keepDup")}
            </label>
          )}
          {plan.teams.length + plan.box.length === 0 && <p className="notice">{t("lib.import.nothing")}</p>}
        </>
      )}
    </Modal>
  );
}
