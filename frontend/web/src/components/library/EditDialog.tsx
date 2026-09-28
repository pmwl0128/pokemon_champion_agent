/** Rename a record and edit its notes and tags. The build itself is not edited here: a team is
 * changed where it is worked on (calculator, builder) and saved back from there. */
import { useState } from "react";
import { Modal } from "../Modal.tsx";
import { useLibraryT } from "./messages.ts";
import { parseTags } from "./shared.tsx";

export interface EditValues {
  label: string;
  notes: string;
  tags: string[];
}

export function EditDialog({ kind, initial, placeholder, onSave, onClose }: {
  kind: "team" | "box";
  initial: EditValues;
  /** Shown in the empty name field: what the list will call the record without a name. */
  placeholder: string;
  onSave: (values: EditValues) => Promise<void>;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const [label, setLabel] = useState(initial.label);
  const [notes, setNotes] = useState(initial.notes);
  const [tags, setTags] = useState(initial.tags.join(", "));
  const [busy, setBusy] = useState(false);
  const labelField = kind === "team" ? "lib.field.name" : "lib.field.nickname";

  const save = async () => {
    setBusy(true);
    try {
      await onSave({ label: label.trim(), notes: notes.trim(), tags: parseTags(tags) });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={t(kind === "team" ? "lib.edit.team" : "lib.edit.box")} onClose={onClose} width={480}
           className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className="primary-btn" disabled={busy} onClick={() => void save()}>
               {t("lib.save")}
             </button>
           </>}>
      <form className="lib-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>
          <span>{t(labelField)}</span>
          <input value={label} maxLength={kind === "team" ? 80 : 40} placeholder={placeholder}
                 onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label>
          <span>{t("lib.field.notes")}</span>
          <textarea rows={4} value={notes} maxLength={4000} onChange={(event) => setNotes(event.target.value)} />
        </label>
        <label>
          <span>{t("lib.field.tags")} <small className="muted">{t("lib.field.tagsHint")}</small></span>
          <input value={tags} onChange={(event) => setTags(event.target.value)} />
        </label>
        {/* Enter in a single-line field submits; the hidden button makes that work in every browser. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
