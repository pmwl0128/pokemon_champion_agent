/** A yes / no question before something that cannot be undone (closing a box or a team slot that
 * still holds something). */
import { useState, type ReactNode } from "react";
import { Modal } from "../Modal.tsx";
import { useLibraryT } from "./messages.ts";

export function ConfirmDialog({ title, body, confirm, onConfirm, onClose }: {
  title: string;
  body: ReactNode;
  /** The confirming button's label; it is styled as a destructive action. */
  confirm: string;
  onConfirm: () => Promise<unknown> | void;
  onClose: () => void;
}) {
  const t = useLibraryT();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose} width={440} className="lib-dialog"
           footer={<>
             <button type="button" className="second-btn" data-autofocus onClick={onClose}>{t("lib.cancel")}</button>
             <button type="button" className="primary-btn lib-danger-btn" disabled={busy} onClick={() => void run()}>
               {confirm}
             </button>
           </>}>
      <div className="lib-dialog-hint">{body}</div>
    </Modal>
  );
}
