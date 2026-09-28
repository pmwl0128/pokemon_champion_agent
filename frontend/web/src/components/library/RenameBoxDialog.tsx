/** Name a box. Left blank, the box goes back to its default name ("Singles", "Doubles", "Box n"). */
import { useState } from "react";
import { Modal } from "../Modal.tsx";
import { useLibraryT } from "./messages.ts";

export function RenameBoxDialog({ initial, placeholder, onSave, onClose }: {
  initial: string;
  placeholder: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const [value, setValue] = useState(initial);
  const save = async () => { await onSave(value); onClose(); };
  return (
    <Modal title={t("lib.box.rename")} onClose={onClose} width={400} className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className="primary-btn" onClick={() => void save()}>{t("lib.save")}</button>
           </>}>
      <form className="lib-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>
          <span>{t("lib.box.nameField")}</span>
          <input value={value} maxLength={24} placeholder={placeholder} autoFocus
                 onChange={(event) => setValue(event.target.value)} />
        </label>
      </form>
    </Modal>
  );
}
